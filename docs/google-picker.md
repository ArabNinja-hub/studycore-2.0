# Google Drive Picker — "Select from Google Drive"

Google Drive is StudyCore's document **source library**. An admin organises
their notes/tutorials/past papers/lab reports in their own Drive, picks one
here, and StudyCore imports a copy and publishes it as a normal StudyCore
resource. See `docs/google-drive-vault.md` for the full workflow and
`docs/google-drive-documents.md` for the import path.

The Picker lives in the **existing** dashboards — the Content Admin Dashboard
(`views/content-admin.html`, "Upload Resource" card) and the Main Admin
Dashboard (`views/admin.html`, "Upload a new resource" card). No new dashboard
was created and neither admin UI was replaced.

The ordinary **Upload** control on either dashboard is a plain StudyCore
upload and is **never** saved into Google Drive.

## Files

| File | Role |
| --- | --- |
| `public/js/google-picker.js` | Loads both Google libraries, verifies readiness, owns status/error states, builds the Picker. |
| `public/js/content-admin.js` | Content Admin: receives the picked file via `window.onGoogleDriveFilePicked(doc, auth)` and fills the hidden Drive form fields. |
| `public/js/admin.js` | Main Admin: same `window.onGoogleDriveFilePicked(doc, auth)` hook, holding the pick in `selectedDriveFile` until publish. |
| `views/content-admin.html` / `views/admin.html` | Button `#caSelectDriveBtn` (starts disabled) + status line `#caDriveStatus`. |
| `lib/google-drive.js` | Server-side import: copies the picked file into StudyCore storage at publish time. |
| `middleware/security.js` | CSP allowances for the Google origins. |
| `server.js` → `GET /api/config` | Publishes `googlePicker.{apiKey, clientId, appId}` from env. |

## What was broken

1. **CSP blocked both Google scripts.** `script-src 'self' 'unsafe-inline'`
   meant the browser refused to evaluate `apis.google.com/js/api.js` and
   `accounts.google.com/gsi/client`. This was the primary failure: `gapi`
   was never defined, so the Picker could never load.
2. **`gapi.load('picker', …)` was never called.** `api.js` was loaded with
   `?onload=onPickerApiLoaded`, and the callback body was empty — the Picker
   module itself was never requested, so `google.picker` stayed undefined.
3. **No readiness gate.** The button was always clickable and only alerted
   after the fact. There was no "Loading / ready / failed" state and no
   console diagnostics.
4. **Race on config.** `PICKER_CONFIG` was read at script-parse time while
   `/api/config` was still in flight, so the API key/client ID were usually
   empty strings.
5. **Config validity was never verified.** The readiness gate only checked
   that client ID and API key were *non-empty*. A missing
   `GOOGLE_CLOUD_PROJECT_NUMBER` passed bootstrap, the button was enabled,
   the admin went through Google authorization, and only then did the Picker
   window open **empty** ("App ID missing") — with no error state at all.
   A project number that did not match the Client ID's project (e.g. the
   project ID string instead of the numeric number) failed the same way:
   silent empty Picker.

## Diagnosing "Google Drive failed to load — …"

Every failure is printed to the browser console under
`[StudyCore][GooglePicker]` as the **exact error + full stack trace** plus a
10-point diagnostic audit (also available on demand via
`window.__STUDYCORE_PICKER_DIAGNOSTICS__()`). The status-line stage maps to
the console evidence like this:

| Status-line stage | Exact console error | Meaning / fix |
| --- | --- | --- |
| `Google API library loading` | `Failed to load https://apis.google.com/js/api.js (network failure, CSP block, or the origin is unreachable)` | The gapi loader never executed — CSP `script-src` must allow `https://apis.google.com`; ad blockers and corporate proxies also cause this. |
| `Google API library loading` | `gapi.load('picker') reported onerror / ontimeout` or `timed out after 20s` | The picker module never arrived from Google. |
| `Google Identity Services loading` | `Failed to load https://accounts.google.com/gsi/client (…)` | CSP `script-src` must allow `https://accounts.google.com`. |
| `Google Picker initialization` | `Readiness check failed — not ready: GOOGLE_CLIENT_ID: EMPTY — the server environment variable GOOGLE_CLIENT_ID is not set…` | The server environment (not the Google Cloud console) is missing/renamed. The message names the exact variable. The server prints the same list in its boot log and in `/api/config.googlePicker.issues`. |
| `Google Picker initialization` | `NOT the numeric project number (got "…")` | `GOOGLE_CLOUD_PROJECT_NUMBER` must be the numeric project number (e.g. `1076280995038`), not the project ID. |
| `Google Picker initialization` | `MISMATCH — the Client ID belongs to project X but GOOGLE_CLOUD_PROJECT_NUMBER is Y` | Client ID and App ID must come from the same Google Cloud project. |
| `OAuth authorization` | `Error: invalid_client (…)` / `access_denied (…)` | Google rejected the Client ID or the origin. Authorized JavaScript origins must include the site origin; the consent app must allow the signed-in account. |

A **Retry** button appears next to the status line after any failure — a
transient network problem or a corrected server env var can be retried
without reloading the page.

## How it works now

1. `/api/config` is awaited (`window.STUDYCORE_CONFIG_READY`). The server
   also validates the three env vars **at boot** (warning in the server log
   when anything is missing/malformed) and advertises the result in
   `/api/config.googlePicker.{valid, issues}`.
2. Both libraries are injected and awaited in parallel:
   - `https://apis.google.com/js/api.js` → then `gapi.load('picker', onPickerApiLoad)`
     (switch to `'client:picker'` if the Drive REST client is ever needed).
   - `https://accounts.google.com/gsi/client`.
3. The config is **audited** in the browser: `GOOGLE_CLIENT_ID` must be an
   OAuth *Web application* Client ID (`<projectNumber>-….apps.googleusercontent.com`),
   `GOOGLE_API_KEY` an `AIza…` key, and `GOOGLE_CLOUD_PROJECT_NUMBER` the
   **numeric** project number — which must equal the numeric prefix of the
   Client ID. Every check is printed to the console as PASS/FAIL with the
   exact value.
4. A readiness check verifies the **real objects** (`gapi`,
   `google.picker.PickerBuilder`, `google.accounts.oauth2`) **and** the
   audited config. Only then is "Select from Google Drive" enabled and the
   status set to **"Google Drive ready"**.
5. On click: GIS `initTokenClient({ scope: 'https://www.googleapis.com/auth/drive.file' })`
   → access token → Picker built with
   `.setDeveloperKey(GOOGLE_API_KEY)`, `.setAppId(GOOGLE_CLOUD_PROJECT_NUMBER)`,
   `.setOAuthToken(accessToken)`, `.setOrigin(...)` → `picker.setVisible(true)`.
6. `PICKED` → the Drive file ID/URL/name/mimeType/size and the short-lived
   Picker access token are kept in the Content Admin form state and posted on
   submit. The backend uses that token once to import the selected bytes into
   StudyCore document storage, then drops it. Students never receive a Drive
   URL or token.

## Status states

| Status line | Meaning |
| --- | --- |
| `Loading Google Drive…` | Libraries in flight; button disabled. |
| `Google Drive ready` | Both libraries verified; button enabled. |
| `Google Drive failed to load — <stage>` | Failure; exact error in `console.error` under `[StudyCore][GooglePicker]`. |

Stages map to the diagnostic categories: *Google API library loading*,
*Google Identity Services loading*, *OAuth authorization*,
*Google Picker initialization*, *Project/App ID*.

## Google Cloud checklist (project number `1076280995038`)

These are console-side settings and cannot be changed from this repo. If the
status line reads "ready" but the Picker window is blank or 403s, verify:

- [ ] **Google Picker API** enabled.
- [ ] **Google Drive API** enabled.
- [ ] OAuth Client ID (`GOOGLE_CLIENT_ID`) belongs to the **same project** as
      `GOOGLE_CLOUD_PROJECT_NUMBER` — a mismatch is the classic cause of an
      empty Picker, because `.setAppId()` must match the token's project.
- [ ] Authorized JavaScript origin includes `https://studycore.academy`.
- [ ] API key website restrictions include `https://studycore.academy/*`
      **and** `https://docs.google.com/*` (the Picker iframe calls with the
      `docs.google.com` referrer).
- [ ] API key API restrictions include **Google Picker API** and
      **Google Drive API**.
- [ ] OAuth consent screen: the admin account is a test user, or the app is
      published.

## Deployment

Set in the host environment (the server boot log and
`/api/config.googlePicker.issues` tell you exactly which one is missing):

```
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_API_KEY=AIza…
GOOGLE_CLOUD_PROJECT_NUMBER=1076280995038
```

**These values live only in the host environment** (Render → *Environment* →
*Environment Variables*, then *Save* which triggers a redeploy; or a local,
git-ignored `.env`). They are never committed to this repository —
`.env.example` intentionally ships them blank.

**No OAuth client secret is used or required for THIS flow.** This is the
browser-side Picker flow (GIS `initTokenClient`), and Google does not use
client secrets for Web application clients in this flow.

> **Note:** `GOOGLE_CLIENT_SECRET` *does* exist elsewhere in this codebase,
> but it belongs to a completely separate feature — the Google Drive
> **storage vault** (Admin Dashboard → Integrations → "Connect Google
> Drive"), which is a server-side OAuth flow with offline access and does
> need a secret. See `docs/google-drive-vault.md`. The Picker above still
> needs no secret and `GOOGLE_CLIENT_SECRET` is never read by it.

After the redeploy, confirm the server sees them:

```
curl -s https://<your-host>/api/config | jq .googlePicker
# → { "apiKey": "AIza…", "clientId": "…apps.googleusercontent.com",
#     "appId": "1076280995038", "valid": true, "issues": [] }
```

`"valid": true` with an empty `issues` array means the server-side
configuration is present and consistent; the Content Admin dashboard status
line then reads **“Google Drive ready”** and the *Select from Google Drive*
button is enabled.

The numeric prefix of `GOOGLE_CLIENT_ID` (before the first `-`) must equal
`GOOGLE_CLOUD_PROJECT_NUMBER` — for this project both are `1076280995038`.
`GOOGLE_CLIENT_ID` must be the **OAuth Web application** Client ID from
Google Cloud → APIs & Services → Credentials (the one ending in
`.apps.googleusercontent.com`), and its authorized JavaScript origins must
include the site origin.
