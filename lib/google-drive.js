// =============================================================================
// StudyCore — Google Drive ingest
// -----------------------------------------------------------------------------
// WHY THIS EXISTS
//
// Picking a file from Google Drive used to store nothing but the Drive file id.
// Students were then handed an embed of
//
//     https://drive.google.com/file/d/<id>/preview
//
// which Google authorizes against DRIVE's own sharing list - not against the
// StudyCore session. The uploader's Drive files are private, so every student
// who was not individually shared on the file landed on Google's
// "You need access / Request access" page. The document was published in
// StudyCore but readable only by the admin who owned it.
//
// The fix is to stop linking and start INGESTING: at publish time the bytes are
// pulled out of Drive once, using the access token the Picker already granted,
// and written into StudyCore's normal object storage (R2, or the local
// DATA_DIR fallback). From that moment the resource is an ordinary StudyCore
// document - served by the protected, session-gated /stream endpoint like any
// other upload, with no Google account, no Drive sharing and no access request
// anywhere in the student's path.
//
// SCOPE / PERMISSIONS
//
// The Picker grants the app per-file access under the non-restricted
// `drive.file` scope: a file the user explicitly selects becomes readable by
// this client. That is exactly (and only) what is used here - StudyCore never
// asks for `drive.readonly` and never enumerates the uploader's Drive.
//
// SECURITY
//
//   * The OAuth access token is used for the single fetch and then dropped. It
//     is never persisted, never logged, and never returned in any response.
//   * Ingested bytes go through the SAME validation as a normal upload: the
//     extension allowlist and the magic-byte signature check from
//     middleware/upload.js, plus the MAX_UPLOAD_MB ceiling.
//   * Native Google Workspace files (Docs/Sheets/Slides) have no binary
//     content at all, so they are exported to PDF on the way in - which also
//     retires the old "this file type cannot be previewed, open it in Drive"
//     dead end.
// =============================================================================

'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');
const { v4: uuidv4 } = require('uuid');
const storage = require('./storage');
const { ALLOWED_EXTENSIONS, VIDEO_EXTENSIONS, resolveMaxUploadMb, matchesSignature } = require('../middleware/upload');

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';

// Native Workspace types carry no downloadable bytes; `alt=media` returns a
// 403 "Only files with binary content can be downloaded". They are exported
// instead. Everything becomes a PDF because the StudyCore reader renders PDFs
// natively - a spreadsheet exported as .xlsx would only reach the
// "can't be previewed in-browser" fallback, which is the dead end we are
// removing.
const WORKSPACE_EXPORTS = {
  'application/vnd.google-apps.document': { mimeType: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.presentation': { mimeType: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.drawing': { mimeType: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.script': { mimeType: 'application/pdf', ext: '.pdf' }
};

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
  'application/zip': '.zip'
};

function isWorkspaceMime(mimeType) {
  return String(mimeType || '').startsWith('application/vnd.google-apps.');
}

function exportFor(mimeType) {
  return WORKSPACE_EXPORTS[String(mimeType || '').trim()] || null;
}

// A Drive file id is an opaque URL-safe token. Validate it before it is
// interpolated into an API URL so a malformed value fails here rather than
// producing a strange request.
function isValidFileId(fileId) {
  return /^[A-Za-z0-9_-]{5,256}$/.test(String(fileId || '').trim());
}

function extensionFor(fileName, mimeType) {
  const name = String(fileName || '').trim().toLowerCase();
  const match = name.match(/(\.[a-z0-9]{1,8})$/);
  if (match && ALLOWED_EXTENSIONS.has(match[1])) return match[1];
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  return EXT_BY_MIME[mime] || '';
}

// Errors surfaced to the Content Admin. `userSafe` follows the convention used
// by middleware/upload.js so the existing error handler passes the message
// through instead of replacing it with a generic 500.
function driveError(message, statusCode = 502) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.userSafe = true;
  return err;
}

async function driveRequest(url, accessToken, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw driveError(err.name === 'AbortError'
      ? 'Google Drive did not respond in time. Please try again.'
      : 'Could not reach Google Drive. Check your connection and try again.');
  }
  clearTimeout(timer);

  if (!response.ok) {
    // Deliberately does not echo Google's response body: it can contain the
    // request URL and other request detail, and must not reach logs or the
    // dashboard.
    if (response.status === 401) {
      throw driveError('Google Drive authorization expired. Click "Select from Google Drive" again to reconnect.', 401);
    }
    if (response.status === 403) {
      throw driveError('Google Drive refused to release this file. Re-select it with "Select from Google Drive" so StudyCore is granted access to it.', 403);
    }
    if (response.status === 404) {
      throw driveError('That Google Drive file could not be found. It may have been moved, deleted, or never granted to StudyCore - re-select it from the Picker.', 404);
    }
    throw driveError(`Google Drive returned an error (HTTP ${response.status}). Please try again.`);
  }
  return response;
}

/**
 * Read a Drive file's metadata (name, mime type, size) with the Picker token.
 */
async function getMetadata({ fileId, accessToken }) {
  if (!isValidFileId(fileId)) throw driveError('That Google Drive file id is not valid.', 400);
  if (!accessToken) throw driveError('A Google Drive authorization is required to import this file.', 400);

  const url = `${DRIVE_API}/${encodeURIComponent(String(fileId).trim())}` +
    '?fields=id,name,mimeType,size&supportsAllDrives=true';
  const response = await driveRequest(url, accessToken, { timeoutMs: 20000 });
  const meta = await response.json();
  return {
    id: meta.id,
    name: meta.name || 'Google Drive Document',
    mimeType: meta.mimeType || 'application/octet-stream',
    size: Number(meta.size) || 0
  };
}

/**
 * Copy one Google Drive file into StudyCore's object storage.
 *
 * Returns the same shape middleware/upload.js produces for a multipart upload,
 * so the publish routes can treat an imported Drive file and an uploaded file
 * identically:
 *
 *     { key, size, contentHash, bucket, originalname, mimetype }
 *
 * @param {object}  opts
 * @param {string}  opts.fileId       Drive file id (from the Picker)
 * @param {string}  opts.accessToken  short-lived OAuth token (from the Picker)
 * @param {string} [opts.fileName]    name supplied by the Picker
 * @param {string} [opts.mimeType]    mime type supplied by the Picker
 */
async function importToStorage({ fileId, accessToken, fileName, mimeType } = {}) {
  const meta = await getMetadata({ fileId, accessToken });

  // Prefer Drive's own metadata over whatever the browser reported.
  const sourceMime = meta.mimeType || mimeType || 'application/octet-stream';
  let name = meta.name || fileName || 'Google Drive Document';
  let downloadUrl;
  let expectedMime;

  const workspace = exportFor(sourceMime);
  if (workspace) {
    expectedMime = workspace.mimeType;
    downloadUrl = `${DRIVE_API}/${encodeURIComponent(meta.id)}/export` +
      `?mimeType=${encodeURIComponent(workspace.mimeType)}`;
    // "Lecture 3" (a Google Doc) becomes "Lecture 3.pdf" so the stored object,
    // the reader's type sniffing and the Content-Disposition name all agree.
    if (!name.toLowerCase().endsWith(workspace.ext)) name += workspace.ext;
  } else if (isWorkspaceMime(sourceMime)) {
    throw driveError('This Google Workspace file type cannot be imported. Save it as a PDF in Google Drive, then select that PDF instead.', 400);
  } else {
    expectedMime = sourceMime;
    downloadUrl = `${DRIVE_API}/${encodeURIComponent(meta.id)}?alt=media&supportsAllDrives=true`;
  }

  const ext = extensionFor(name, expectedMime);
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw driveError(`Google Drive file type "${ext || sourceMime}" is not supported.`, 400);
  }
  // Videos are published to Bunny Stream, never copied into object storage.
  // The publish routes already reject Drive videos; this is the storage-level
  // backstop so no code path can smuggle one in.
  if (VIDEO_EXTENSIONS.has(ext)) {
    throw driveError('Video lessons must be uploaded to Bunny Stream, not imported from Google Drive.', 400);
  }

  const maxBytes = resolveMaxUploadMb() * 1024 * 1024;
  if (meta.size && meta.size > maxBytes) {
    throw driveError(`That Google Drive file is larger than the ${resolveMaxUploadMb()}MB limit.`, 400);
  }

  const response = await driveRequest(downloadUrl, accessToken, {
    // Large PDFs over a slow Render egress path need more than the metadata
    // timeout. Matches the generosity of the ordinary upload path.
    timeoutMs: Number(process.env.DRIVE_IMPORT_TIMEOUT_MS) || 10 * 60 * 1000
  });
  if (!response.body) throw driveError('Google Drive returned an empty response for this file.');

  // Stream Drive -> hash/measure -> storage. The file is never buffered whole
  // in this process, exactly like the multipart upload path.
  const hash = crypto.createHash('sha256');
  const head = Buffer.alloc(16);
  let headLen = 0;
  let size = 0;
  let tooLarge = false;

  const source = Readable.fromWeb(response.body);
  async function* measured() {
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        tooLarge = true;
        throw driveError(`That Google Drive file is larger than the ${resolveMaxUploadMb()}MB limit.`, 400);
      }
      hash.update(buf);
      if (headLen < 16) {
        const take = Math.min(16 - headLen, buf.length);
        buf.copy(head, headLen, 0, take);
        headLen += take;
      }
      yield buf;
    }
  }

  const key = `${uuidv4()}${ext}`;
  try {
    await storage.putObject({
      key,
      body: Readable.from(measured()),
      contentType: expectedMime
    });
  } catch (err) {
    await storage.deleteObject(key).catch(() => {});
    if (tooLarge || err.userSafe) throw err;
    throw driveError('Could not save the Google Drive file to StudyCore storage. Please try again.');
  }

  if (size === 0) {
    await storage.deleteObject(key).catch(() => {});
    throw driveError('That Google Drive file is empty.', 400);
  }

  // Same magic-byte check the upload path applies: a file whose real contents
  // contradict its extension is deleted rather than published.
  if (!matchesSignature(head.subarray(0, headLen), ext)) {
    await storage.deleteObject(key).catch(() => {});
    throw driveError('The Google Drive file does not match its file type. Please check the file and try again.', 400);
  }

  return {
    key,
    size,
    contentHash: hash.digest('hex'),
    bucket: storage.backendName(),
    originalname: name,
    mimetype: expectedMime
  };
}

module.exports = {
  importToStorage,
  getMetadata,
  isWorkspaceMime,
  exportFor,
  isValidFileId,
  extensionFor,
  WORKSPACE_EXPORTS
};
