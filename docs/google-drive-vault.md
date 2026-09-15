# Google Drive as StudyCore's document **source library**

> **This document supersedes the earlier "Drive vault" design.**
> Google Drive is **not** StudyCore's storage backend and never receives a
> StudyCore upload. It is the **library you pick documents from**.

## The workflow

```
1. You upload/organise documents in YOUR Google Drive
2. StudyCore Admin  →  "Select from Google Drive"
3. Google Drive Picker opens (your existing OAuth config)
4. You select an existing file
5. StudyCore imports a COPY into StudyCore storage + records the metadata
6. Students open it in StudyCore's login/subscription-gated viewer
```

Students are **never** sent to Google Drive, never see your Drive account, and
never receive a Drive URL, file id or OAuth token.

## The two rules

| Action | What happens | Google Drive involved? |
| --- | --- | --- |
| **Upload Document** (drag & drop / file picker) | Plain StudyCore upload → R2 (or local disk in dev) | **No.** Nothing is ever saved into anyone's Drive. |
| **Select from Google Drive** | Picker → server copies the bytes once → R2/local → published as a normal StudyCore resource | Yes, as the **source** only. Your original file is not moved, edited or deleted. |
| Video lessons | Always Bunny Stream | No. Completely separate. |

`lib/document-storage.js` enforces rule one: `putObject()` only ever calls
`lib/storage.js`. There is no code path — connected Google account or not —
that writes an upload into Drive.

## Why the bytes are copied rather than linked

If StudyCore stored only a Drive file id and pointed students at it, Google
would check **each student** against your file's sharing list, and students who
were not personally shared would get **"Request access"** instead of their
material. Copying the file in at publish time removes Google from the student's
path entirely: the resource becomes an ordinary StudyCore document behind the
usual `/api/resources/:id/stream` gate (session + program visibility +
Premium/trial + content ticket).

This is also why the old **"This document is being moved into StudyCore"**
placeholder is gone: there is no in-between state. A Picker selection either
imports successfully at publish time (and is immediately readable), or the
publish fails with a specific error and nothing is created.

## The optional server-side connection (Admin → Integrations)

"Connect Google Drive" is **not** storage configuration. It stores an encrypted
refresh token so the StudyCore **server** can read Drive on its own behalf,
which is used for:

* legacy rows (`storage_provider = 'google_drive'`) whose bytes were never
  imported, proxied server-side by `lib/drive-documents.js`; and
* rows written by an older build that used the connected account as a vault
  (`storage_provider = 'google_drive_vault'`), still read by
  `lib/google-drive-vault.js` so nothing published then is lost.

Connecting or disconnecting an account **does not change where a single new
byte is written**. Everything works without it: the Picker authorises per file
in the admin's own browser.

### Credentials

There is exactly **one** Google integration. The Picker and this server-side
connection share the same Google Cloud project and the same
`GOOGLE_CLIENT_ID`, with the same non-restricted `drive.file` scope.

| Variable | Used by | Notes |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Picker + server connection | OAuth **Web application** client id |
| `GOOGLE_API_KEY` | Picker (`setDeveloperKey`) + legacy read fallback | `AIza…` |
| `GOOGLE_CLOUD_PROJECT_NUMBER` | Picker (`setAppId`) | numeric project number |
| `GOOGLE_CLIENT_SECRET` | server connection only | needed for "Connect Google Drive" |
| `GOOGLE_DRIVE_REDIRECT_URI` | server connection only | optional; derived from the request otherwise |

The refresh token is encrypted at rest (AES-256-GCM, key derived from
`JWT_SECRET`) in `google_drive_accounts`. It never reaches a browser, is never
logged, and is never returned by any API route.

## Storage providers you may see on a row

| `storage_provider` | Meaning | Written today? |
| --- | --- | --- |
| `r2` / `local` | StudyCore's own storage. Direct uploads **and** Drive Picker imports. | **Yes — always** |
| `google_drive_vault` | Historical: uploaded into a connected account by an older build. Still readable. | No |
| `google_drive` | Legacy: a bare reference to the uploader's own Drive file, never imported. Proxied server-side, best effort. | No |

`google_drive_file_id` / `google_drive_url` on a modern row are **provenance
only** ("this came from that file in my Drive"). They are never used to serve a
student, and are never exposed to one.

## Tests

* `scripts/test-google-drive-vault.js` — a connected account must not capture
  uploads; historical vault rows must still read.
* `scripts/test-drive-student-access.js` — end-to-end: a Picker selection is
  imported and opens in the StudyCore viewer for a student with no relationship
  to the uploader's Google account, on desktop and mobile, with no Google
  redirect and no "being moved" state.
* `scripts/test-google-drive-link.js` — the import path itself.
* `scripts/test-google-picker.js` — Picker bootstrap and config auditing.
