// =============================================================================
// StudyCore — publishing a document that LIVES in Google Drive
// -----------------------------------------------------------------------------
// GOOGLE DRIVE IS THE DOCUMENT STORAGE.
//
// When a Content Admin picks a file with the Google Drive Picker, StudyCore
// records a REFERENCE to that Drive file. It does not copy, duplicate, move or
// migrate the bytes into StudyCore storage. The document stays in Google Drive
// and is read through on demand at view time:
//
//     Google Drive -> StudyCore backend -> StudyCore document viewer
//
// (An earlier revision copied the bytes into StudyCore's own object storage at
// publish time. That is exactly what this module no longer does.)
//
// HOW STUDENTS STILL GET THE FILE WITHOUT A GOOGLE ACCOUNT
//
// Students never talk to Google. lib/drive-documents.js fetches the file
// SERVER-SIDE using StudyCore's own Drive credentials (the connected admin
// account from lib/google-drive-vault.js — the same OAuth connection the
// upload/Picker system already uses) and streams it out through the
// session-gated /api/resources/:id/stream endpoint. No Drive URL, Drive file
// id or OAuth token ever reaches a student's browser, and nothing is
// redirected to drive.google.com.
//
// For that to work, StudyCore's own account must be able to read the picked
// file. The Picker's `drive.file` grant is scoped to the BROWSER session that
// did the picking, so this module verifies StudyCore's server-side access at
// publish time and, when it is missing, adds StudyCore's connected account as
// a private READER on that one file (using the uploader's Picker token, which
// is authorized for exactly that file). That is the minimum possible grant:
//
//   * one specific file, never a folder or the whole Drive;
//   * role "reader" for one named account — NOT "anyone with the link", so
//     the document is never made public;
//   * no notification email;
//   * the file's owner keeps ownership and can revoke at any time.
//
// If access still cannot be established, publishing FAILS with an actionable
// message instead of creating a resource students cannot open.
//
// SCOPE / PERMISSIONS
//
// The Picker grants per-file access under the non-restricted `drive.file`
// scope. StudyCore never asks for `drive.readonly` and never enumerates the
// uploader's Drive.
//
// VALIDATION
//
// A referenced file is validated exactly like an ordinary upload before it is
// published: extension allowlist, the magic-byte signature check from
// middleware/upload.js, and the size ceiling. The signature check reads the
// first bytes back through StudyCore's OWN credentials, which doubles as proof
// that students will actually be able to read the document.
// =============================================================================

'use strict';

const driveDocuments = require('./drive-documents');
const vault = require('./google-drive-vault');
const { ALLOWED_EXTENSIONS, VIDEO_EXTENSIONS, resolveMaxUploadMb, matchesSignature } = require('../middleware/upload');

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';

// Native Workspace types carry no downloadable bytes; `alt=media` returns a
// 403 "Only files with binary content can be downloaded". They are exported to
// PDF when they are READ (lib/drive-documents.js) — the StudyCore reader
// renders PDFs natively, which retires the old "this file type cannot be
// previewed, open it in Drive" dead end.
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

async function driveRequest(url, accessToken, { timeoutMs = 60000, method = 'GET', body = null, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...headers },
      ...(body ? { body } : {}),
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
  if (!accessToken) throw driveError('A Google Drive authorization is required to publish this file.', 400);

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
 * Make sure StudyCore's OWN Drive credentials can read this file, so students
 * can be served it later without any Google account of their own.
 *
 * Nothing is made public: at most, the single connected StudyCore account is
 * added as a private `reader` on this one file, using the uploader's Picker
 * token (which is authorized for exactly this file). The file's owner keeps
 * ownership and can revoke the share at any time.
 *
 * Returns { granted: boolean } — `granted` is true when a new permission had
 * to be created, false when StudyCore could already read the file.
 */
async function ensureServerAccess({ fileId, accessToken }) {
  if (!driveDocuments.hasServerCredentials()) {
    throw driveError(
      'StudyCore is not connected to Google Drive yet, so students would not be able to open this document. ' +
      'Ask a Main Admin to connect it in Admin → Integrations, then publish again.',
      503
    );
  }

  if (await driveDocuments.canRead(fileId)) return { granted: false };

  // StudyCore cannot read it yet. Ask Drive to share this ONE file with the
  // connected StudyCore account, privately.
  const studycoreAccount = driveDocuments.serviceAccountEmail();
  if (!studycoreAccount) {
    // No connected account to grant to — an API key alone can only read files
    // the owner has already link-shared, and StudyCore will not change that.
    throw driveError(
      'StudyCore cannot read this Google Drive file. Ask a Main Admin to connect the StudyCore Google Drive account ' +
      '(Admin → Integrations), or share the file with that account in Google Drive, then publish again.',
      403
    );
  }

  const permissionUrl = `${DRIVE_API}/${encodeURIComponent(String(fileId).trim())}/permissions` +
    '?sendNotificationEmail=false&supportsAllDrives=true&fields=id';
  try {
    await driveRequest(permissionUrl, accessToken, {
      method: 'POST',
      timeoutMs: 20000,
      headers: { 'Content-Type': 'application/json' },
      // type:'user' + role:'reader' — a named private reader. Never
      // type:'anyone', which is what would make the document public.
      body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: studycoreAccount })
    });
  } catch (err) {
    throw driveError(
      `StudyCore could not be granted access to this Google Drive file, so students would not be able to open it. ` +
      `Share it with ${studycoreAccount} in Google Drive (Viewer is enough) and publish again.`,
      err.statusCode === 401 ? 401 : 403
    );
  }

  // Drive permission changes are not always instantly visible to the grantee.
  driveDocuments.forgetCaches(fileId);
  for (const waitMs of [0, 400, 1200]) {
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (await driveDocuments.canRead(fileId)) return { granted: true };
  }

  throw driveError(
    `StudyCore was granted access to this file but Google has not applied it yet. ` +
    `Wait a moment and publish again, or share the file with ${studycoreAccount} directly in Google Drive.`,
    503
  );
}

/**
 * Publish one Google Drive file as a StudyCore document — BY REFERENCE.
 *
 * The bytes stay in Google Drive. Nothing is copied into StudyCore storage.
 *
 * Returns the same shape middleware/upload.js produces for a multipart upload,
 * so the publish routes can treat a Drive-hosted document and an uploaded file
 * identically:
 *
 *     { key, size, contentHash, bucket, originalname, mimetype }
 *
 * where `key` is the GOOGLE DRIVE FILE ID and `bucket` is 'google_drive'
 * (the row's storage_provider), which is what routes the later read back to
 * Drive through lib/document-storage.js.
 *
 * @param {object}  opts
 * @param {string}  opts.fileId       Drive file id (from the Picker)
 * @param {string}  opts.accessToken  short-lived OAuth token (from the Picker)
 * @param {string} [opts.fileName]    name supplied by the Picker
 * @param {string} [opts.mimeType]    mime type supplied by the Picker
 */
async function linkDriveFile({ fileId, accessToken, fileName, mimeType } = {}) {
  const meta = await getMetadata({ fileId, accessToken });

  // Prefer Drive's own metadata over whatever the browser reported.
  const sourceMime = meta.mimeType || mimeType || 'application/octet-stream';
  let name = meta.name || fileName || 'Google Drive Document';
  let servedMime;

  const workspace = exportFor(sourceMime);
  if (workspace) {
    // A native Google Doc has no bytes; it is exported to PDF when READ.
    // Record what StudyCore will serve so the reader opens the right engine.
    servedMime = workspace.mimeType;
    // "Lecture 3" (a Google Doc) becomes "Lecture 3.pdf" so the served name,
    // the reader's type detection and the Content-Disposition agree.
    if (!name.toLowerCase().endsWith(workspace.ext)) name += workspace.ext;
  } else if (isWorkspaceMime(sourceMime)) {
    throw driveError('This Google Workspace file type cannot be displayed. Save it as a PDF in Google Drive, then select that PDF instead.', 400);
  } else {
    servedMime = sourceMime;
  }

  const ext = extensionFor(name, servedMime);
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw driveError(`Google Drive file type "${ext || sourceMime}" is not supported.`, 400);
  }
  // Videos are published to Bunny Stream, never referenced from Drive. The
  // publish routes already reject Drive videos; this is the backstop so no
  // code path can smuggle one in.
  if (VIDEO_EXTENSIONS.has(ext)) {
    throw driveError('Video lessons must be uploaded to Bunny Stream, not selected from Google Drive.', 400);
  }

  const maxBytes = resolveMaxUploadMb() * 1024 * 1024;
  if (meta.size && meta.size > maxBytes) {
    throw driveError(`That Google Drive file is larger than the ${resolveMaxUploadMb()}MB limit.`, 400);
  }

  // Students are served by StudyCore's own credentials, so those credentials —
  // not the uploader's browser session — must be able to read the file.
  await ensureServerAccess({ fileId: meta.id, accessToken });

  // Validate through StudyCore's OWN read path. This applies the same
  // magic-byte check as an ordinary upload AND proves the document really is
  // readable for students before it is published.
  let head;
  try {
    head = await driveDocuments.readBytes(meta.id, 0, 15);
  } catch (err) {
    throw driveError(
      'StudyCore could not read this Google Drive file, so students would not be able to open it. ' +
      'Check the file in Google Drive and try again.',
      err && err.statusCode === 404 ? 404 : 502
    );
  }

  if (!head || head.length === 0) {
    throw driveError('That Google Drive file is empty.', 400);
  }
  if (!matchesSignature(head, ext)) {
    throw driveError('The Google Drive file does not match its file type. Please check the file and try again.', 400);
  }

  // Drive reports no size for native Workspace files; the exported size is
  // resolved on read instead. A `null` size simply means "ask Drive".
  let size = meta.size || 0;
  if (!size) {
    try {
      const served = await driveDocuments.headObject(meta.id);
      size = Number(served.contentLength) || 0;
    } catch {
      size = 0;
    }
  }

  return {
    // The Drive FILE ID is the storage key for a Drive-hosted document.
    key: meta.id,
    size,
    // Drive-hosted documents are not byte-copied, so there is no local hash to
    // compute. Duplicate detection simply does not apply to them.
    contentHash: null,
    // Recorded as the row's storage_provider, which routes every later read
    // back to Google Drive.
    bucket: 'google_drive',
    originalname: name,
    mimetype: servedMime,
    driveFileId: meta.id,
    driveHosted: true
  };
}

module.exports = {
  // Google Drive stays the storage: the document is REFERENCED, never copied.
  linkDriveFile,
  ensureServerAccess,
  getMetadata,
  isWorkspaceMime,
  exportFor,
  isValidFileId,
  extensionFor,
  WORKSPACE_EXPORTS
};
