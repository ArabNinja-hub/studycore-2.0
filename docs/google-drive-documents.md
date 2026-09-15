# Google Drive documents: import them so every student can read

StudyCore's student viewer must never depend on the original Google Drive
file's sharing list. If a student browser is sent to `drive.google.com` or to a
Google-hosted preview, Google checks whether that particular student is shared
on the uploader's file; private files then show **"Request access"** for some
students even though the resource is published in StudyCore.

The reliable flow is:

```
Google Drive Picker  →  StudyCore backend import  →  StudyCore document storage  →  StudyCore viewer
```

Not:

```
Google Drive Picker  →  store only a Drive link/id  →  student opens Google preview
```

## Publish path

`lib/google-drive.js` imports a selected Drive file at publish time:

1. The Picker returns the file id plus the uploader's short-lived OAuth token.
2. The server reads Drive metadata with that token.
3. Native Google Docs/Sheets/Slides are exported as PDF, because the StudyCore
   reader renders PDFs reliably in-app.
4. The bytes are streamed through the same checks as an ordinary upload:
   extension allowlist, maximum size, SHA-256 hash, and magic-byte validation.
5. The validated bytes are written into StudyCore's own document storage
   (`r2`, or `local` disk in development). Google Drive is the SOURCE, never a
   destination: StudyCore never writes anything back into a Google account,
   and this is true whether or not an account is connected in
   Admin → Integrations.
6. The resource row records the real storage key/backend. The original
   `google_drive_file_id` and `google_drive_url` are kept only as provenance.
7. The admin's original Drive file is untouched — not moved, edited or
   deleted. Deleting the StudyCore resource does not delete it either.

The Picker token is used only for that one import. It is never stored, logged,
or returned to a student.

## Database meaning

| Column | Meaning after this fix |
| --- | --- |
| `storage_provider` | The backend that actually holds the bytes students read. New Drive Picker publishes are always `r2` or `local` — never `google_drive` (a bare reference) and never `google_drive_vault` (an older build's storage experiment). |
| `stored_name` | The StudyCore storage key for the imported copy. |
| `google_drive_file_id` | Provenance: the original Drive file id selected by the uploader. Not used for normal student reads of newly imported files. |
| `google_drive_url` | Provenance only. Never used by the student viewer. |
| `mime_type` | The type StudyCore serves. Workspace files are imported/exported as `application/pdf`. |
| `file_size` | Size of the stored StudyCore copy. |

## Legacy `storage_provider = 'google_drive'` rows

Older experiments and older data may still contain rows where `storage_provider`
is `google_drive` and `stored_name`/`google_drive_file_id` is the original Drive
file id. Those rows are legacy Drive references.

For compatibility, `routes/resources.routes.js` still proxies those rows through
`lib/drive-documents.js` when StudyCore's server-side Drive credentials can read
the original file. This keeps as many old rows readable as possible without ever
redirecting a student to Google.

However, the durable repair is to import them into StudyCore storage:

- Admins (Main Admin or Content Admin) can edit the resource, click
  **Select from Google Drive**, pick the same file, and save. Both edit paths
  re-import even when the Drive file id is unchanged, if the old row is still
  marked `google_drive`.
- Operators can run `node scripts/list-drive-linked-resources.js --verify` to
  find remaining legacy rows and see which original Drive files StudyCore can
  still read.

If a legacy original file has been deleted or is no longer shared with the
connected StudyCore account, no code can retrieve its bytes; the uploader must
restore/share/re-select it.

## Student read path

Students always open `/viewer/:id`, and the reader always loads bytes from
`/api/resources/:id/stream` (usually with a short-lived ticket). That endpoint
re-checks login, program visibility, and subscription policy before serving any
bytes.

The student viewer must not contain a Google Drive iframe, a Google Viewer URL,
an "Open in Google Drive" fallback, or any direct Drive URL. Those paths are the
ones that caused the Google **Request access** screen.
