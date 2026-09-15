# Google Drive Vault — optional StudyCore document storage

This is a **different feature** from the Google Drive **Picker**
(`docs/google-picker.md`). Do not confuse the two:

| | Google Drive Picker | Google Drive Vault |
| --- | --- | --- |
| What it does | Lets a Content Admin pick ONE file from **their own** Drive to import into StudyCore | Makes ONE connected Drive account StudyCore's storage backend for document bytes |
| Runs in | The browser (Google Identity Services) for file choice/token, then the server for import | The server (OAuth authorization-code flow) |
| Needs a client secret? | No | Yes — `GOOGLE_CLIENT_SECRET` |
| Where it's configured | `.env` only (`GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT_NUMBER`) | `.env` (`GOOGLE_CLIENT_SECRET`, optional `GOOGLE_DRIVE_REDIRECT_URI`) **plus** a one-time "Connect Google Drive" click in Admin → Integrations |
| Who a student ever talks to | StudyCore only | StudyCore only |

They share the same `GOOGLE_CLIENT_ID` / Google Cloud project, but are
otherwise independent — the Picker keeps working exactly as documented in
`docs/google-picker.md` whether or not the vault is connected.

## What problem this solves

The original Drive Picker bug was caused by leaving the document in the
uploader's Drive and sending students to a Google-hosted preview. Google then
checked the uploader's file sharing list, so some students saw **"Request
access"**.

StudyCore fixes that by importing Picker-selected source files into StudyCore
storage at publish time. The vault is one possible StudyCore storage backend:
every document upload (direct, resumable, or Picker-imported) can be written
into a single, admin-connected Google Drive account instead of R2/local disk.
Every student read still goes through StudyCore's own gated
`/api/resources/:id/stream` endpoint. Drive's sharing/ACL system is never
exposed to, or relied on by, a student.

## Architecture

1. **One connected account.** A Main Admin visits Admin Dashboard →
   Integrations → "Connect Google Drive" once. This starts a normal OAuth
   authorization-code flow (`access_type=offline`, `prompt=consent`) against
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, scoped to `drive.file` only —
   StudyCore never asks for `drive.readonly` and never enumerates the account's
   existing Drive contents.
2. **Refresh token vault.** Google returns a refresh token, which is encrypted
   (AES-256-GCM, key derived from `JWT_SECRET`) and stored in the
   `google_drive_accounts` table (`db/index.js`). The refresh token never
   reaches the browser, is never logged, and is never returned by any API
   response. Only one row has `status = 'active'` at a time.
3. **Writes.** `lib/document-storage.js` is the dispatcher every document write
   path goes through (`middleware/upload.js`, `lib/resumable-uploads.js`, and
   `lib/google-drive.js` after the Picker downloads a selected source file).
   When the vault is connected (`lib/google-drive-vault.js`'s
   `isConfigured()`), the document is uploaded into a private "StudyCore
   Documents" folder inside the connected account using Drive's resumable
   upload protocol. Otherwise writes fall back to the pre-existing R2/local
   backend (`lib/storage.js`).
4. **Reads and deletes dispatch by the object's recorded `storage_provider`**
   (`resources.storage_provider` / `upload_sessions.storage_provider`), never
   by whichever backend is active today. A document already stored in R2/local
   keeps reading from R2/local after the vault is connected, and a document
   already stored in the vault keeps reading from the vault after R2 settings
   change.
5. **Student reads never touch Drive directly.** `/api/resources/:id/stream`
   re-checks `requireAuth`, program visibility, subscription policy, and the
   short-lived content ticket before it asks the recorded backend for bytes.
   For vault-stored objects it fetches from Drive server-side using an access
   token minted from the vault refresh token, then streams same-origin bytes to
   the browser. The student never receives a Drive URL, Drive file id, or OAuth
   token. Range requests are preserved.
6. **Out of scope, unaffected:**
   - Video lessons — always uploaded to Bunny Stream, never to Drive or R2.
   - Avatars and quiz question images — small app-managed assets kept on
     R2/local always (`middleware/upload.js`'s `assetUpload`/`avatarUpload`).
   - Already-published R2/local documents — left exactly where they are; no
     migration into Drive happens automatically.

## Naming: `google_drive_vault` vs. `google_drive`

`resources.storage_provider` distinguishes two different Drive-related states:

| Value | Meaning |
| --- | --- |
| `google_drive_vault` | The document is a file **StudyCore itself uploaded** into the connected vault account's "StudyCore Documents" folder. This includes new Picker imports when the vault is active. StudyCore may delete this object when the resource is deleted. |
| `google_drive` | A **legacy source-file reference**: the row still points at the original uploader's Drive file. New Picker publishes should not create this state. It is kept only as a compatibility fallback for old rows, and StudyCore must not delete the original file. |

See `lib/document-storage.js`'s `backendFor()` for the exact dispatch logic.

## Environment variables

```
GOOGLE_CLIENT_ID=…apps.googleusercontent.com      # same value as the Picker
GOOGLE_CLIENT_SECRET=…                             # server-only, never sent to the browser
GOOGLE_DRIVE_REDIRECT_URI=                         # optional; defaults to
                                                    # https://<host>/api/admin/google-drive/callback
```

`GOOGLE_DRIVE_REDIRECT_URI` (or its derived default) must be added to the
OAuth client's "Authorized redirect URIs" in Google Cloud Console.

## Admin routes (`routes/admin.routes.js`)

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/admin/google-drive/status` | Main Admin | `{ connected, email }` |
| `GET /api/admin/google-drive/connect` | Main Admin | Redirects the browser to Google's consent screen |
| `GET /api/admin/google-drive/callback` | None (Google redirects here directly; a short-lived, server-held CSRF state token is validated instead) | Exchanges the code, stores the encrypted refresh token, redirects back to `/admin.html#integrations` |
| `POST /api/admin/google-drive/disconnect` | Main Admin | Marks the account `disconnected`; new writes fall back to R2/local. Already-stored vault documents are untouched and keep reading from the vault while the token remains usable. |

## Production R2 guard

`lib/r2.js` still fails startup loudly in production if R2 is unconfigured —
**unless** a Google Drive vault is already connected, in which case Drive is an
equally durable, non-ephemeral place for document bytes to live. This does not
relax the requirement for avatars/quiz images/video, which still need R2 (or
Bunny, for video) regardless of the vault.

## Tests

`scripts/test-google-drive-vault.js` covers the vault staying off until a real
account is connected, the refresh token being encrypted at rest, a full write →
head → get → ranged-get → delete round trip against a faked Drive API, and the
critical "reads dispatch by the object's own provider" guarantee.

`scripts/test-google-drive-link.js` and `scripts/test-drive-student-access.js`
cover the separate Picker-import path and the promise that students never see
Google's "Request access" screen.
