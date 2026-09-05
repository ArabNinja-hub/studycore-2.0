# Google Drive Picker — Content Admin Dashboard

The Picker lives in the **existing** Content Admin Dashboard
(`views/content-admin.html`, "Upload Resource" card). No new dashboard was
created and the admin UI was not replaced.

## Files

| File | Role |
| --- | --- |
| `public/js/google-picker.js` | Loads both Google libraries, verifies readiness, owns status/error states, builds the Picker. |
| `public/js/content-admin.js` | Receives the picked file via `window.onGoogleDriveFilePicked(doc)` and fills the hidden Drive form fields. |
| `views/content-admin.html` | Button `#caSelectDriveBtn` (starts disabled) + status line `#caDriveStatus`. |
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

## How it works now

1. `/api/config` is awaited (`window.STUDYCORE_CONFIG_READY`).
2. Both libraries are injected and awaited in parallel:
   - `https://apis.google.com/js/api.js` → then `gapi.load('picker', onPickerApiLoad)`
     (switch to `'client:picker'` if the Drive REST client is ever needed).
   - `https://accounts.google.com/gsi/client`.
3. A readiness check verifies the **real objects**, not the button:
   `gapi`, `google.picker.PickerBuilder`, `google.accounts.oauth2`, plus
   client ID and API key.
4. Only then is "Select from Google Drive" enabled and the status set to
   **"Google Drive ready"**.
5. On click: GIS `initTokenClient({ scope: 'https://www.googleapis.com/auth/drive.file' })`
   → access token → Picker built with
   `.setDeveloperKey(GOOGLE_API_KEY)`, `.setAppId(GOOGLE_CLOUD_PROJECT_NUMBER)`,
   `.setOAuthToken(accessToken)`, `.setOrigin(...)` → `picker.setVisible(true)`.
6. `PICKED` → the Drive file ID/URL/name/mimeType/size are written into the
   hidden inputs and posted to `/api/content-admin` on submit.

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

Set in the host environment:

```
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_API_KEY=AIza…
GOOGLE_CLOUD_PROJECT_NUMBER=1076280995038
```
