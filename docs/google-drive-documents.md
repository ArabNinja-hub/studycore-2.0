# Google Drive-backed documents

Google Drive is StudyCore's document **source library**. A file selected with
"Select from Google Drive" is **registered** as a Google Drive-backed StudyCore
resource — its Drive file id and Drive's own metadata are stored, and no
copy is written to StudyCore storage at publish time. StudyCore performs a
one-byte media probe (or validates the PDF export for a native Workspace file)
with its server credential so a metadata-readable but unopenable file cannot
be published. When a student opens the resource, the StudyCore **backend**
reads the original file from Drive with its own connected Google credentials
and streams it through the protected viewer.

```
Google Drive Picker  →  register file id + metadata  →  resource row (google_drive)
                                                           │
student opens resource  →  /api/resources/:id/stream  ←────┘
                             login + program + subscription gates
                             backend reads Drive with the connected account
                             → bytes piped into the StudyCore PDF viewer
```

Not:

```
Google Drive Picker  →  copy the bytes into StudyCore storage at publish time
```

The copy-at-publish behaviour ("your document is being moved into StudyCore")
was removed. It depended on the uploader's short-lived browser Picker token,
and it hid the real question — can StudyCore's **server** read this file? —
until a student tried to open the document and got
*"Document unavailable: this document may have been moved, renamed or
deleted"* for a file that was perfectly fine in Drive.

## Publish path

`lib/google-drive.js` registers a selected Drive file:

1. The Picker returns the file id (plus the browser's short-lived OAuth token,
   which marks the submission as a fresh pick).
2. The server reads the file's metadata **with its own credentials** — the
   connected Google account from Admin → Integrations (`lib/google-drive-vault.js`),
   with the browser API key as a fallback for files their owner already
   link-shared. It then probes the actual media path with one byte (or validates
   the export path for a native Workspace file). This uses exactly the
   credential chain students' reads depend on, not the Picker token.
3. If either metadata or media/export access fails, the publish is **refused**
   with an actionable message (connect the account / pick from the connected
   library / the file no longer exists). Nothing is published half-broken.
4. Native Google Docs/Sheets/Slides are registered as their PDF exports — the
   export is validated at publish and cached briefly in memory, then repeated
   on demand after the cache expires when a student opens the document.
5. Videos are refused: video lessons are published to Bunny Stream only.
6. The resource row records `storage_provider = 'google_drive'`,
   `google_drive_file_id`, `google_drive_url`, and Drive's name/type/size.
   `stored_name` is NULL — there is no StudyCore storage object.
7. The admin's original Drive file is untouched — not moved, edited or
   deleted. Deleting the StudyCore resource does not delete it either.

Normal StudyCore uploads are **never** written into Google Drive. Google Drive
is never a storage destination; it is only the source library documents are
picked from. Bunny Stream remains the video pipeline.

## Student read path

Students always open `/viewer/:id`, and the reader always loads bytes from
`/api/resources/:id/stream` (usually with a short-lived ticket). That endpoint
re-checks login, program visibility, and subscription policy before serving
any bytes, then:

* `routes/resources.routes.js` resolves the row's Drive file id
  (`driveDocumentKey`);
* `lib/drive-documents.js` fetches it from Drive as the connected account,
  with HTTP Range support so pdf.js pages the document in 128 KB chunks;
* the bytes are piped straight through — Drive's name/type/size are re-read
  (briefly cached) so the served length always matches the live file.

### Credential recovery on the read path

The admin's publish and the student's read use the same connection, so the
things that can break *only* the read are the things that change between them.
Two are handled automatically, because both are invisible to the admin and
would otherwise surface as "Document unavailable" for a healthy file:

* **A revoked access token.** The vault caches a minted token in-process for
  ~55 minutes, but Google can kill it sooner (password change, "sign out of
  all devices", re-consent). Drive then answers `401 Invalid Credentials`.
  The *refresh* token is unaffected, so `lib/drive-documents.js` drops the
  dead token, mints a replacement and retries the request once. The recovered
  token is cached, so a revocation costs one extra refresh, not one per chunk.
  A `403` is **not** retried — that is a real permission problem, and the
  token was never the issue.
* **Google's abuse flag.** `files.get?alt=media` is refused with `403
  cannotDownloadAbusiveFile` for files Google's scanner flagged — routine for
  scanned past papers and large shared PDFs. Metadata reads are *not* refused,
  which is why publish-time verification passes and only the student's byte
  read fails. The reader retries once with `acknowledgeAbuse=true`; the admin
  owns the file and selected it deliberately, so the flag is theirs to accept.

The connection is also validated where the admin can still act on it: a
consent that did not grant `drive.file` is refused at connect time rather than
stored as a connection that can mint tokens but never read a file, and a
refresh token that can no longer be decrypted (rotated `JWT_SECRET`) reports
"reconnect Google Drive", not a Drive permission error.

The student viewer must not contain a Google Drive iframe, a Google Viewer
URL, an "Open in Google Drive" fallback, or any direct Drive URL. Students
never receive a Drive URL, a Drive file id or an OAuth token, and are never
redirected to drive.google.com. They also never need a Google account: the
backend authenticates to Drive, not the student.

## When a document cannot be opened

| Cause | What the student sees |
| --- | --- |
| File deleted/trashed/moved out of the library in Drive | "could not be opened from Google Drive. It may have been moved or deleted there" |
| StudyCore's connection lost access to the file | "StudyCore can no longer read it with its Google Drive connection" |
| Connection revoked / needs reconnect | the server's reconnect message (Admin → Integrations) |

Because the server verifies readability at publish time, these states mean
something **changed after publishing** — and the operator log names the
resource, the uploader and the exact reason. `scripts/list-drive-linked-resources.js
--verify` re-checks every Drive-backed row against Drive.

## Database meaning

| Column | Meaning |
| --- | --- |
| `storage_provider` | `google_drive` — the original Drive file IS the storage; reads are proxied server-side. Ordinary uploads stay `r2`/`local`. |
| `stored_name` | NULL for Drive-backed rows (older builds stored the Drive id here; those rows are served the same way). |
| `google_drive_file_id` | The Drive file the resource is backed by. Resolved by the stream route; exposed only to Main Admin APIs, never to students. |
| `google_drive_url` | Provenance for admin tooling. Never used by the student viewer. |
| `mime_type` | The type StudyCore serves (Workspace files are served as `application/pdf`). |
| `file_size` | Drive's size at publish — display data only; the stream re-reads the live size. |

## Tests

* `scripts/test-drive-student-access.js` — end-to-end: Picker publish
  (Content Admin + Main Admin) registers the reference; the student stream
  authenticates to Drive with the **server's** token; desktop/mobile reads,
  range requests, Workspace exports, access gating, refusal of unreadable
  files, and no-Google-leak assertions.
* `scripts/test-drive-viewer-retrieval.js` — the viewer-side retrieval path:
  recovery from a revoked access token (including range reads and Workspace
  exports), Google's abuse-flag refusal, connect-time scope validation, and
  proof that genuine 403/404 failures are still reported honestly.
* `scripts/test-google-drive-link.js` — the registration path and the
  server-side reference reader.
* `scripts/test-google-drive-vault.js` — the connected account: encrypted
  refresh token, upload isolation, historical rows.
* `scripts/test-google-picker.js` — Picker bootstrap and config auditing.
