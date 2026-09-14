# Google Drive is the document storage

StudyCore does **not** keep its own copy of a Drive document. Google Drive is
the source of truth and the storage unit; StudyCore's backend reads the file
out of Drive on demand and streams it into StudyCore's own document viewer:

```
Google Drive  →  StudyCore backend (/api/resources/:id/stream)  →  StudyCore viewer
```

Never:

```
Google Drive  →  StudyCore storage  →  StudyCore viewer      ← removed
```

## What was wrong before

A previous change made "Select from Google Drive" **copy** the bytes into
StudyCore's own object storage at publish time. Documents published *before*
that change kept only their Drive reference, so they no longer matched any
code path and the viewer showed:

> This document is being moved into StudyCore. It was published from Google
> Drive before StudyCore started storing documents itself…

Nothing was actually being moved — the message described a migration that the
architecture does not perform. That state (`routes/resources.routes.js`'s
`driveLinkedLegacy` 404 and `viewer.js`'s `driveNotMigrated()` screen) has been
removed. A Drive document is now read **from Drive** whether it was published
years ago or thirty seconds ago.

## How a document record identifies its Drive file

`resources` columns (see `db/index.js`) — unchanged, no migration required:

| Column | Meaning for a Drive-hosted document |
| --- | --- |
| `storage_provider` | `'google_drive'` — the bytes live in Google Drive and are read through on demand. (`'google_drive_vault'` = a file StudyCore itself uploaded into the connected vault account; `'r2'` / `'local'` = an ordinary direct upload.) |
| `google_drive_file_id` | The Drive file id — the authoritative reference used to fetch the file. |
| `stored_name` | Legacy rows put the Drive file id here too. Still read as a fallback so pre-existing rows keep working untouched. |
| `google_drive_url` | The `https://drive.google.com/file/d/…` link from the Picker. Provenance only — never sent to a student, never used to serve bytes. |
| `mime_type` | The type StudyCore **serves**. Native Google Docs/Sheets/Slides are exported to `application/pdf` on read, so this records `application/pdf` for them. |
| `file_size` | Drive's reported size, or `NULL` when Drive cannot report one (Workspace exports). The stream route then asks Drive for it. |

Old rows and new rows therefore have the same shape, which is why one code
path serves both (requirement: support older *and* newer Drive resources).

## Read path (`lib/drive-documents.js`)

`lib/document-storage.js` dispatches `storage_provider = 'google_drive'` to
`lib/drive-documents.js`, which implements the same interface as the R2/local
and vault backends (`headObject` / `getObject` / `readBytes` / `deleteObject`),
with the Drive **file id** as the key. So
`/api/resources/:id/stream` did not have to learn anything about Google: it
streams a Drive document exactly like any other document, including HTTP
`Range` support for pdf.js's 128 KB chunk reads on desktop and mobile.

Credentials, tried in order, all server-side:

1. **The connected Google Drive account** (`lib/google-drive-vault.js`) — the
   same admin OAuth connection the upload/Picker system already uses. Its
   refresh token is stored encrypted; a short-lived access token is minted
   server-side and cached in-process.
2. **`GOOGLE_API_KEY`** — used only as a fallback, and only works for files
   whose owner has *already* link-shared them. StudyCore never changes a
   file's sharing to make this work.

The student's browser never receives a Drive URL, a Drive file id or an OAuth
token, and is never redirected to `drive.google.com`. Every request still goes
through `requireAuth` → program visibility → Premium/trial gating → content
ticket, exactly as before.

Native Google Workspace files (Docs/Sheets/Slides/Drawings) have no binary
content, so they are exported to PDF through Drive's `export` endpoint when
read. Drive does not support `Range` on exports, so the exported PDF is held
in a small, short-lived **in-memory** cache (10 minutes, capped) purely so one
document read does not re-export once per PDF chunk. Nothing is written to
StudyCore's disk, object storage or database.

## Publish path (`lib/google-drive.js`)

"Select from Google Drive" **links**; it does not copy.

1. The Picker returns the file id plus the uploader's short-lived OAuth token.
2. The server reads the file's Drive metadata with that token (name, mime,
   size) and rejects anything that is not an allowed document type (videos
   still go to Bunny Stream).
3. `ensureServerAccess()` checks whether StudyCore's *own* Drive credentials
   can already read the file.
   - If yes, **nothing about the file's sharing is touched**.
   - If not, StudyCore asks Drive to add the connected StudyCore account as a
     private `reader` on that one file (no notification email, no "anyone with
     the link", no public exposure), then re-checks.
4. The first 16 bytes are read back with StudyCore's own credentials and run
   through the same magic-byte signature check as a direct upload, so a file
   whose contents contradict its extension is refused at publish time — and
   this doubles as proof that students will be able to read it.
5. The row records the Drive reference. No bytes are copied anywhere.

If step 3/4 cannot be satisfied, the publish fails with an actionable message
for the admin instead of creating a resource students cannot open.

## Errors students can see

Only one, and only when Drive genuinely cannot serve the file (deleted, moved
out of reach, or StudyCore's access revoked):

> This document could not be opened from Google Drive…

There is no "being moved into StudyCore" state any more, because no document
is ever moved into StudyCore.

## Operational check

```
node scripts/list-drive-linked-resources.js          # report only
node scripts/list-drive-linked-resources.js --verify # also asks Drive if each file is readable
```

It never modifies anything; `--verify` performs one metadata read per Drive
document using StudyCore's own credentials and prints the ones that would fail
for a student, with the reason.

## Tests

- `scripts/test-google-drive-link.js` — linking (not copying), Workspace
  export-on-read, signature validation, access-grant behaviour, the read
  backend's Range support, and the guarantee that deleting a StudyCore
  resource never deletes the file from Drive.
- `scripts/test-drive-student-access.js` — end-to-end: a legacy Drive row and
  a freshly published Drive row are both streamed from Drive to a student who
  has no Google relationship with the uploader, on desktop and mobile request
  patterns, with no redirect to Google and no "being moved" message.
