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
5. StudyCore stores the Drive file id + the file's metadata (nothing is copied)
6. A student opens the resource → the StudyCore BACKEND fetches the file from
   Drive with the connected account's credentials and streams it through the
   login/subscription-gated in-app viewer
```

Students are **never** sent to Google Drive, never see your Drive account, and
never receive a Drive URL, file id or OAuth token. Nothing about the file has
to be shared publicly in Google Drive.

## The two rules

| Action | What happens | Google Drive involved? |
| --- | --- | --- |
| **Upload Document** (drag & drop / file picker) | Plain StudyCore upload → R2 (or local disk in dev) | **No.** Nothing is ever saved into anyone's Drive. |
| **Select from Google Drive** | Picker → the file id + Drive's metadata are registered; the bytes stay in your Drive and are fetched server-side whenever a student opens the resource | Yes, as the **source** only. Your original file is not moved, edited or deleted. |
| Video lessons | Always Bunny Stream | No. Completely separate. |

`lib/document-storage.js` enforces rule one: `putObject()` only ever calls
`lib/storage.js`. There is no code path — connected Google account or not —
that writes an upload into Drive.

## Why a registered reference is safe

Google never checks a **student** against your file's sharing list, because no
student ever contacts Google. The only client that talks to Drive is the
StudyCore **server**, using the connected account's OAuth token. Every read
still passes through the usual `/api/resources/:id/stream` gates (session +
program visibility + Premium/trial + content ticket).

There is also no in-between state: at publish time the server proves — with
its own credentials — that it can read the picked file. Either the
registration succeeds (and the resource is immediately openable), or the
publish fails with a specific error and nothing is created.

## The server-side connection (Admin → Integrations)

"Connect Google Drive" is **not** storage configuration. It stores an encrypted
refresh token so the StudyCore **server** can read Drive on its own behalf.
That connection is what serves every Google Drive-backed resource:

* publish-time verification that a picked file is readable
  (`lib/google-drive.js`), and
* every student read of a Drive-backed row (`lib/drive-documents.js`), plus
* rows written by an older build that used the connected account as a vault
  (`storage_provider = 'google_drive_vault'`), still readable so nothing
  published then is lost.

**Connect the Google account that owns your document library.** The
non-restricted `drive.file` scope is shared with the Picker (same client id),
so every file picked with "Select from Google Drive" is readable by the
connection. Ordinary uploads are unaffected either way: connecting or
disconnecting an account does not change where a single new byte is written.

### Credentials

There is exactly **one** Google integration. The Picker and this server-side
connection share the same Google Cloud project and the same
`GOOGLE_CLIENT_ID`, with the same non-restricted `drive.file` scope.

| Variable | Used by | Notes |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Picker + server connection | OAuth **Web application** client id |
| `GOOGLE_API_KEY` | Picker (`setDeveloperKey`) + link-shared read fallback | `AIza…` |
| `GOOGLE_CLOUD_PROJECT_NUMBER` | Picker (`setAppId`) | numeric project number |
| `GOOGLE_CLIENT_SECRET` | server connection only | needed for "Connect Google Drive" |
| `GOOGLE_DRIVE_REDIRECT_URI` | server connection only | optional; derived from the request otherwise |

The refresh token is encrypted at rest (AES-256-GCM, key derived from
`JWT_SECRET`) in `google_drive_accounts`. It never reaches a browser, is never
logged, and is never returned by any API route. Access tokens are minted
server-side and cached in-process for their lifetime.

## Storage providers you may see on a row

| `storage_provider` | Meaning | Written today? |
| --- | --- | --- |
| `r2` / `local` | StudyCore's own storage. Direct uploads. | **Yes — always for uploads** |
| `google_drive` | A Google Drive-backed resource: the row points at the original Drive file and the backend proxies reads with the connected account. | **Yes — this is what "Select from Google Drive" produces** |
| `google_drive_vault` | Historical: uploaded into a connected account by an older build. Still readable. | No |

`google_drive_file_id` / `google_drive_url` on an `r2`/`local` row are
**provenance only** (a recovery source if the stored object was ever lost).
On a `google_drive` row they are the live reference. They are never exposed
to students.

## Tests

* `scripts/test-google-drive-vault.js` — a connected account must not capture
  uploads; the refresh token is encrypted; historical vault rows must still read.
* `scripts/test-drive-student-access.js` — end-to-end: a Picker selection is
  registered and opens in the StudyCore viewer for a student with no
  relationship to the uploader's Google account, on desktop and mobile, with
  no Google redirect and no "being moved" state.
* `scripts/test-google-drive-link.js` — the registration path itself.
* `scripts/test-google-picker.js` — Picker bootstrap and config auditing.
