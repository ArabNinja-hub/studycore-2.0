# Google Drive Vault — Google Drive as document storage

This is a **different feature** from the Google Drive **Picker**
(`docs/google-picker.md`). Do not confuse the two:

| | Google Drive Picker | Google Drive Vault |
| --- | --- | --- |
| What it does | Lets a Content Admin pick ONE file from **their own** Drive to publish | Makes ONE connected Drive account StudyCore's **storage backend** for every document |
| Runs in | The browser (Google Identity Services) | The server (OAuth authorization-code flow) |
| Needs a client secret? | No | Yes — `GOOGLE_CLIENT_SECRET` |
| Where it's configured | `.env` only (`GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT_NUMBER`) | `.env` (`GOOGLE_CLIENT_SECRET`, optional `GOOGLE_DRIVE_REDIRECT_URI`) **plus** a one-time "Connect Google Drive" click in Admin → Integrations |
| Who a student ever talks to | StudyCore only | StudyCore only |

They share the same `GOOGLE_CLIENT_ID` / Google Cloud project, but are
otherwise independent — the Picker keeps working exactly as documented in
`docs/google-picker.md` whether or not the vault is connected.

## What problem this solves

> **Note:** this page covers the *vault* — the account StudyCore **uploads
> into** when a file is uploaded directly to StudyCore. Documents picked from
> an admin's own Drive with the Picker are a separate (and also Drive-hosted)
> path, documented in `docs/google-drive-documents.md`; those are referenced
> in place and never copied anywhere.

For a brief period, picking a file from Google Drive **copied** its bytes into
StudyCore's own object storage at publish time. That is no longer done: Google
Drive is the storage, and documents are read back out of it on demand.

This feature makes Google Drive the actual storage backend: every new
document (past papers, notes, tutorial sheets, lab reports — **not video**,
which always stays on Bunny Stream) is written into a single, admin-connected
Google Drive account instead of R2/local disk, while every student read still
goes through StudyCore's own gated `/api/resources/:id/stream` endpoint
exactly as before. Drive's own sharing/ACL system is never exposed to, or
relied on by, a student.

## Architecture

1. **One connected account.** A Main Admin visits Admin Dashboard →
   Integrations → "Connect Google Drive" once. This starts a normal OAuth
   authorization-code flow (`access_type=offline`, `prompt=consent`) against
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, scoped to `drive.file` only —
   StudyCore never asks for `drive.readonly` and never enumerates the
   account's existing Drive contents.
2. **Refresh token vault.** Google returns a refresh token, which is
   encrypted (AES-256-GCM, key derived from `JWT_SECRET` the same way
   `lib/content-tickets.js` derives its signing key) and stored in the
   `google_drive_accounts` table (`db/index.js`). The refresh token never
   reaches the browser, is never logged, and is never returned by any API
   response. Only one row has `status = 'active'` at a time.
3. **Writes.** `lib/document-storage.js` is the single dispatcher every
   upload path goes through (`middleware/upload.js`, `lib/resumable-
   uploads.js`). Picker-selected documents are *not* a write path at all —
   they already live in Drive and are only referenced. When the vault
   is connected (`lib/google-drive-vault.js`'s `isConfigured()`), a new
   document is uploaded straight into a private "StudyCore Documents" folder
   inside the connected account, using Drive's resumable-upload protocol
   (never buffering the whole file in memory). Otherwise, writes fall back to
   the pre-existing R2/local backend (`lib/storage.js`) exactly as before —
   a fresh checkout with no vault connected keeps working unmodified.
4. **Reads and deletes always dispatch by the object's own recorded
   `storage_provider`** (the `resources.storage_provider` / `upload_sessions
   .storage_provider` column), never by whichever backend is active *today*.
   This is what makes connecting or disconnecting the vault safe at any
   time: a document already stored in R2/local keeps reading from R2/local
   even after the vault is connected, and a document already stored in Drive
   keeps reading from Drive even after the vault is disconnected. Nothing is
   migrated in place.
5. **Student reads never touch Drive directly.** `/api/resources/:id/stream`
   (`routes/resources.routes.js`) is completely unchanged in its access logic
   (`requireAuth`, program visibility, Premium/trial gating, the short-lived
   HMAC content ticket). It fetches bytes from Drive server-side, using an
   access token minted from the vault's refresh token (cached in-process for
   ~55 minutes), and streams them to the student. The student's browser makes
   a same-origin request to StudyCore and never receives a Drive URL, a Drive
   file id, or an OAuth token. Range requests (seeking/paging a PDF) are
   preserved: Drive's `alt=media` endpoint honors `Range` headers.
6. **Out of scope, unaffected:**
   - Video lessons — always uploaded to Bunny Stream, never to Drive or R2.
   - Avatars and quiz question images — small, app-managed assets kept on
     R2/local always (`middleware/upload.js`'s `assetUpload`/`avatarUpload`),
     independent of whether the vault is connected, so they never depend on
     an admin's personal Google account.
   - Already-published R2/local documents — left exactly where they are; no
     migration into Drive ever happens automatically.

## Naming: `google_drive_vault` vs. `google_drive`

`resources.storage_provider` distinguishes two **different, both fully
working** Google Drive arrangements:

| Value | Meaning |
| --- | --- |
| `google_drive` | The document lives in a Drive file StudyCore did **not** upload — an admin picked it with the Drive Picker. The Drive file id is the storage key; `lib/drive-documents.js` reads it through on demand. See `docs/google-drive-documents.md`. |
| `google_drive_vault` | The document is a file **StudyCore itself uploaded** into the connected vault account's "StudyCore Documents" folder. |

Both read from Google Drive; they differ only in who put the file there and
therefore in whether StudyCore may delete it (it may delete its own vault
objects, never a Picker-referenced file). See `lib/document-storage.js`'s
`backendFor()` for the exact dispatch logic.

## Environment variables

```
GOOGLE_CLIENT_ID=…apps.googleusercontent.com      # same value as the Picker
GOOGLE_CLIENT_SECRET=…                             # NEW — server-only, never sent to the browser
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
| `POST /api/admin/google-drive/disconnect` | Main Admin | Marks the account `disconnected`; new writes fall back to R2/local. Already-stored Drive documents are untouched and keep reading from Drive. |

## Production R2 guard

`lib/r2.js` still fails startup loudly in production if R2 is unconfigured
— **unless** a Google Drive vault is already connected, in which case Drive
is an equally durable, non-ephemeral place for document bytes to live. This
does not relax the requirement for avatars/quiz images/video, which still
need R2 (or Bunny, for video) regardless of the vault.

## Tests

`scripts/test-google-drive-vault.js` covers: the vault staying off until a
real account is connected, the refresh token being encrypted at rest, a full
write → head → get → ranged-get → delete round trip against a faked Drive
API, and the critical "reads dispatch by the object's own provider, not by
what's active now" guarantee. `scripts/test-google-drive-link.js` and
`scripts/test-drive-student-access.js` cover the separate Picker path — where
Google Drive is the storage and documents are referenced rather than copied —
and the student access guarantees.
