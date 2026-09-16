// =============================================================================
// StudyCore — Google Drive reference registration ("Select from Google Drive")
// -----------------------------------------------------------------------------
// Google Drive is the admin's DOCUMENT SOURCE LIBRARY, never a StudyCore
// storage destination. A file selected with the existing Google Picker is
// REGISTERED as a Google Drive-backed StudyCore resource:
//
//   * the resource row stores the Drive file id plus the metadata Drive
//     reports (name, served mime type, size). No bytes are copied out of
//     Drive at publish time — there is no "your document is being moved
//     into StudyCore" step, and nothing is written into (or deleted from)
//     the admin's Drive;
//   * when a student opens the resource, the StudyCore BACKEND reads the
//     original file from Drive with its OWN connected Google OAuth
//     credentials (lib/google-drive-vault.js — the same client id/secret as
//     the Picker, with a persisted encrypted refresh token) and streams it
//     through the normal session-, program- and subscription-gated
//     /api/resources/:id/stream endpoint (lib/drive-documents.js);
//   * students are never redirected to Google, never receive a Drive URL,
//     file id or token, and never depend on the file's Drive sharing list.
//     Nothing has to be made public in Google Drive for this to work.
//
// WHY THE SERVER'S OWN CREDENTIALS ARE VERIFIED AT PUBLISH TIME
//
// Students are served exclusively with the SERVER's credentials — the admin's
// browser token is irrelevant once the publish form is submitted, and students
// certainly do not log in with the admin's Google account. So the only
// credential that matters is the one the stream route will use.
// registerFile() therefore reads the picked file's metadata AND probes the
// media/export path AS THE SERVER, using the same credential chain the student
// stream performs. If either check fails, the publish is refused with an
// actionable message instead of publishing a resource that would later show
// every student "Document unavailable" — the exact symptom of publishing a
// Drive reference the backend cannot actually read.
//
// SCOPE / PERMISSIONS
//
// The connected account is authorized with the non-restricted `drive.file`
// scope — the SAME client id and scope the Picker uses. Selecting a file in
// the Picker grants that app per-file read access, so the server-side
// connection can read every file that was picked with "Select from Google
// Drive" from the connected account's library. StudyCore never asks for broad
// Drive access, never enumerates the library beyond the picked file, and
// never changes a file's sharing settings.
//
// GOOGLE WORKSPACE FILES
//
// Native Docs/Sheets/Slides carry no downloadable binary content, so they are
// served as the PDF Drive exports them to (lib/drive-documents.js). The export
// path is validated during registration and cached briefly in memory; no copy
// is written to StudyCore storage.
// =============================================================================

'use strict';

const driveDocuments = require('./drive-documents');
const vault = require('./google-drive-vault');
const { ALLOWED_EXTENSIONS, VIDEO_EXTENSIONS } = require('../middleware/upload');

// A Drive file id is an opaque URL-safe token. Validate it before it is
// interpolated into an API URL or written to a resource row.
function isValidFileId(fileId) {
  return /^[A-Za-z0-9_-]{5,256}$/.test(String(fileId || '').trim());
}

const EXT_BY_MIME = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/zip': '.zip',
  'application/x-rar-compressed': '.rar',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav'
};

function isWorkspaceMime(mimeType) {
  return String(mimeType || '').startsWith('application/vnd.google-apps.');
}

function extensionFor(fileName, mimeType) {
  const name = String(fileName || '').trim().toLowerCase();
  const match = name.match(/(\.[a-z0-9]{1,8})$/);
  if (match && ALLOWED_EXTENSIONS.has(match[1])) return match[1];
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  return EXT_BY_MIME[mime] || '';
}

// Errors surfaced to the admin publishing the resource. `userSafe` follows the
// convention used by middleware/upload.js so the existing error handler passes
// the message through instead of replacing it with a generic 500.
function driveError(message, statusCode = 502) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.userSafe = true;
  return err;
}

function isVideoMime(mimeType) {
  return String(mimeType || '').toLowerCase().startsWith('video/');
}

/**
 * Register one picked Google Drive file as a Google Drive-backed StudyCore
 * resource, verifying — with StudyCore's OWN server credentials — that the
 * file will be readable when a student opens it.
 *
 * Returns the same shape middleware/upload.js produces for a multipart
 * upload, so the publish routes can treat a Drive reference and an uploaded
 * file identically:
 *
 *     { key: null, bucket: 'google_drive', size, contentHash: null,
 *       originalname, mimetype, driveFileId, driveRegistered: true }
 *
 * `key` is null and `bucket` is the 'google_drive' provider marker: a Drive
 * reference stores no StudyCore object; lib/document-storage.js dispatches
 * student reads of 'google_drive' rows to lib/drive-documents.js.
 *
 * @param {object}  opts
 * @param {string}  opts.fileId       Drive file id (from the Picker)
 * @param {string} [opts.accessToken] Picker's short-lived token. Accepted for
 *                                    call compatibility but deliberately NOT
 *                                    relied upon: students are served with the
 *                                    server's credentials, so those are the
 *                                    ones verified here.
 * @param {string} [opts.fileName]    name supplied by the Picker (fallback)
 * @param {string} [opts.mimeType]    mime type supplied by the Picker (fallback)
 */
async function registerFile({ fileId, accessToken, fileName, mimeType } = {}) {
  const id = String(fileId || '').trim();
  if (!isValidFileId(id)) throw driveError('That Google Drive file id is not valid.', 400);

  // Authoritative metadata, read with the server's own credential chain
  // (connected Drive account first; the browser API key only rescues files
  // their owner has already link-shared). `fresh` bypasses the short metadata
  // cache so a publish never succeeds off a stale readability proof.
  let meta;
  try {
    meta = await driveDocuments.getMetadata(id, { fresh: true });
  } catch (err) {
    throw publishErrorFor(err, id);
  }

  const sourceMime = meta.driveMimeType || mimeType || 'application/octet-stream';
  const name = meta.name || fileName || 'Google Drive Document';

  // Videos are published to Bunny Stream only — never proxied from Drive and
  // never copied into document storage.
  if (isVideoMime(sourceMime) || VIDEO_EXTENSIONS.has(extensionFor(name, sourceMime))) {
    throw driveError('Video lessons must be uploaded to Bunny Stream, not selected from Google Drive.', 400);
  }

  // A native Workspace file is served as its PDF export; everything else must
  // resolve to an allowlisted document/image/archive/audio extension.
  if (meta.isWorkspace && !meta.exportMimeType) {
    throw driveError(
      'This Google Workspace file type cannot be displayed. Save it as a PDF in Google Drive, then select that PDF instead.',
      400
    );
  }
  const servedMime = meta.contentType || mimeType || 'application/octet-stream';
  const ext = extensionFor(name, servedMime);
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw driveError(`Google Drive file type "${ext || sourceMime}" is not supported.`, 400);
  }

  // files.get(metadata) can succeed even when Drive refuses files.get(media)
  // for the connected account. Verify the exact byte/export path used later
  // by students before committing the resource row; otherwise a document can
  // be published successfully and immediately show "Document unavailable".
  try {
    await driveDocuments.verifyReadable(id, meta);
  } catch (err) {
    throw publishErrorFor(err, id);
  }

  return {
    // No StudyCore storage object: the Drive file id IS the storage key, kept
    // on the row's google_drive_file_id and resolved by lib/drive-documents.js.
    key: null,
    bucket: 'google_drive',
    originalname: name,
    mimetype: servedMime,
    size: Number(meta.size) || null,
    contentHash: null,
    driveFileId: meta.id || id,
    driveRegistered: true
  };
}

// Translate the stream path's read errors into publish-time guidance. The
// admin can still act on every one of these; a student cannot.
function publishErrorFor(err, fileId) {
  // Without a connected Google account, StudyCore can only read files their
  // owner has already link-shared (via the browser API key) — private library
  // files answer 404 to that key, which would read as "file deleted" and send
  // the admin hunting for a file that is perfectly fine. The connection is
  // the actual requirement, so say so.
  if (!vault.isConfigured()) {
    return driveError(
      'StudyCore is not connected to Google Drive yet, so it cannot serve Drive documents to students. ' +
      'A Main Admin must connect the Google Drive account that holds your document library in Admin → Integrations, then select the file again.',
      503
    );
  }
  if (err && err.userSafe && err.statusCode === 503) {
    // No server credentials at all (neither a connected account nor an API key).
    return driveError(
      'StudyCore is not connected to Google Drive yet, so it cannot serve Drive documents to students. ' +
      'A Main Admin must connect the Google Drive account that holds your document library in Admin → Integrations, then select the file again.',
      503
    );
  }
  if (err && err.statusCode === 403) {
    // The server is connected, but that connection cannot read this file.
    return driveError(
      `StudyCore could not read this file from Google Drive with its own connection (file id ${fileId}). ` +
      'Check that the connected Google Drive account (Admin → Integrations) is the one that owns your document library, ' +
      'and that the file was selected with "Select from Google Drive" — not typed in or shared from another library.',
      403
    );
  }
  if (err && (err.code === 'NoSuchKey' || err.name === 'NoSuchKey' || err.statusCode === 404)) {
    return driveError(
      'That Google Drive file could not be found. It may have been deleted or the id is wrong — open Google Drive, check the file, and select it again with "Select from Google Drive".',
      404
    );
  }
  if (err && err.userSafe) return err; // timeouts, revoked access, reconnect prompts…
  return driveError('Could not reach Google Drive. Check your connection and try again.');
}

module.exports = {
  registerFile,
  isWorkspaceMime,
  isValidFileId,
  extensionFor
};
