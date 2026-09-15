// =============================================================================
// StudyCore — Google Drive reference reader (student stream path)
// -----------------------------------------------------------------------------
// A file selected with "Select from Google Drive" is registered as a
// Google Drive-backed StudyCore resource (see lib/google-drive.js): the row's
// `storage_provider` is 'google_drive' and its `google_drive_file_id` is the
// original Drive file id. The bytes STAY in the admin's Drive — Google Drive
// is the document source library, not a StudyCore storage destination.
//
// This module serves those rows. It exposes the same tiny object-storage
// interface as lib/storage.js (R2 / local disk) and lib/google-drive-vault.js —
//
//     headObject(key) / getObject(key, range) / readBytes(key, s, e) / deleteObject(key)
//
// — except the "key" is a GOOGLE DRIVE FILE ID and the bytes are fetched from
// Drive on demand, with StudyCore's own credentials. Because the interface
// matches, lib/document-storage.js dispatches `storage_provider =
// 'google_drive'` rows here and the student stream route
// (routes/resources.routes.js) serves them through exactly the same access
// control as any other document:
//
//     Google Drive -> StudyCore backend -> StudyCore document viewer
//
// There is no "being moved" state and no publish-time copy: a row either
// proxies successfully through StudyCore, or reports that the original Drive
// file cannot be read (deleted, or StudyCore's connection lost access).
//
// WHO STUDYCORE AUTHENTICATES AS
//
//   1. The connected Google Drive account (lib/google-drive-vault.js) — the
//      same server-side admin OAuth connection the upload/Picker system
//      already uses. Its refresh token is encrypted at rest; a short-lived
//      access token is minted server-side and cached in-process.
//   2. GOOGLE_API_KEY, as a fallback, which can only read a file whose owner
//      has already link-shared it. StudyCore never changes a file's public
//      sharing to make this legacy fallback work.
//
// The student's browser is never given a Drive URL, a Drive file id or an
// OAuth token, and is never redirected to drive.google.com. Every byte still
// leaves through the session-gated, program-gated, Premium-gated /stream
// endpoint.
//
// GOOGLE WORKSPACE FILES
//
// Native Docs/Sheets/Slides have no binary content (`alt=media` refuses
// them), so they are exported to PDF on read. Drive does not support Range
// on exports, so an exported PDF is held in a small, short-lived IN-MEMORY
// cache purely so one student's read does not re-export once per 128 KB
// pdf.js chunk. Nothing is written to disk, object storage or the database.
// =============================================================================

'use strict';

const { Readable } = require('stream');
const vault = require('./google-drive-vault');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

// Native Workspace types carry no downloadable bytes. Everything is exported
// as PDF because the StudyCore reader renders PDFs natively.
const WORKSPACE_EXPORTS = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/pdf',
  'application/vnd.google-apps.drawing': 'application/pdf',
  'application/vnd.google-apps.script': 'application/pdf'
};

const METADATA_TTL_MS = 60 * 1000;
const EXPORT_TTL_MS = 10 * 60 * 1000;
// Drive caps an export at 10MB; this ceiling bounds the whole cache, not one
// entry, so a busy term cannot grow it without limit.
const EXPORT_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const metadataCache = new Map(); // fileId -> { value, expiresAt }
const exportCache = new Map();   // fileId -> { buffer, contentType, expiresAt }
// Credential-safe context for a Google response. Kept out-of-band so no
// Authorization header, API key URL, or token can accidentally be serialized
// into a Main-Admin response or production log.
const responseAuthContext = new WeakMap();

function isWorkspaceMime(mimeType) {
  return String(mimeType || '').startsWith('application/vnd.google-apps.');
}

function exportMimeFor(mimeType) {
  return WORKSPACE_EXPORTS[String(mimeType || '').trim()] || null;
}

// A Drive file id is an opaque URL-safe token. Validating it here means a
// malformed value fails locally instead of producing a strange Drive request.
function isValidFileId(fileId) {
  return /^[A-Za-z0-9_-]{5,256}$/.test(String(fileId || '').trim());
}

// Resolve the exact Drive id the viewer will pass to Drive. Kept here so the
// stream endpoint and Main-Admin production diagnostic report cannot drift and
// accidentally test a different id from the one students actually request.
function sourceFileIdForResource(row) {
  if (!row) return null;
  for (const candidate of [row.google_drive_file_id, row.stored_name]) {
    const value = String(candidate || '').trim();
    if (value && isValidFileId(value)) return value;
  }
  return null;
}

function fileIdForResource(row) {
  if (!row) return null;
  const isDriveProvider = (row.storage_provider || 'local') === 'google_drive';
  const hasDriveId = Boolean(row.google_drive_file_id && isValidFileId(row.google_drive_file_id));
  const isLegacyDriveRow = !row.storage_provider ||
    (hasDriveId && (!row.stored_name || row.stored_name === row.google_drive_file_id));
  if (!isDriveProvider && !isLegacyDriveRow) return null;
  return sourceFileIdForResource(row);
}

function notFound(message) {
  const err = new Error(message || 'Not found');
  err.code = 'NoSuchKey';
  err.name = 'NoSuchKey';
  err.statusCode = 404;
  return err;
}

// Drive answered, but refused StudyCore's credentials. Reporting this as
// "moved or deleted" (the old behaviour) sent admins hunting through their
// Drive for a file that was perfectly fine — the real problem was access.
function accessError(message) {
  const err = new Error(message || 'Access denied');
  err.code = 'DriveAccessDenied';
  err.name = 'DriveAccessDenied';
  err.statusCode = 403;
  err.userSafe = true;
  return err;
}

function driveError(message, statusCode = 502) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.userSafe = true;
  return err;
}

function attachGoogleDriveError(err, detail) {
  if (err && detail) err.googleDriveError = detail;
  return err;
}

// Read only Google's documented error envelope. The raw Response is never
// attached because it may retain request/authorization internals, and the raw
// body can contain fields we did not intend to expose.
async function googleResponseDetail(res, fileId, operation) {
  let payload = null;
  try { payload = await res.clone().json(); } catch { /* media/success/non-JSON */ }
  const googleError = payload && payload.error;
  const first = googleError && Array.isArray(googleError.errors) ? googleError.errors[0] : null;
  const context = responseAuthContext.get(res) || {};
  return {
    operation,
    fileId: String(fileId || '').trim() || null,
    httpStatus: res && res.status || null,
    errorCode: googleError && googleError.code != null ? googleError.code : null,
    errorStatus: googleError && googleError.status ? String(googleError.status) : null,
    errorReason: first && first.reason
      ? String(first.reason)
      : (typeof googleError === 'string' ? String(googleError) : null),
    errorMessage: googleError && googleError.message
      ? String(googleError.message)
      : (typeof googleError === 'string' ? String(googleError) : null),
    authMethod: context.authMethod || null,
    authAccount: context.authAccount || null,
    tokenRefresh: context.tokenRefresh || null
  };
}

// ---------------------------------------------------------------------------
// Credentials. The vault's admin OAuth connection first; the browser API key
// only as a fallback for files their owner already link-shared.
// ---------------------------------------------------------------------------
function apiKey() {
  return String(process.env.GOOGLE_API_KEY || '').trim();
}

function hasServerCredentials() {
  return vault.isConfigured() || Boolean(apiKey());
}

// Display address of the Google account StudyCore reads Drive as. Used by the
// publish path to grant StudyCore per-file read access, and by the operator
// report. Never shown to students.
function serviceAccountEmail() {
  try {
    const state = vault.status();
    return state && state.connected ? (state.email || null) : null;
  } catch {
    return null;
  }
}

function withKey(url) {
  const key = apiKey();
  if (!key) return url;
  return `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
}

/**
 * One Drive request, authenticated as StudyCore.
 *
 * Tries the connected Drive account's OAuth token first and falls back to the
 * API key. `allowKeyFallback` is false for calls where an anonymous read would
 * be misleading rather than useful.
 */
// Which failure to keep when neither credential could read the file. An
// explicit 401/403 proves the file exists and access was refused; a 404 from
// the other credential only proves THAT credential cannot see it. Reporting
// the refusal is what tells the operator to fix the connection instead of
// hunting for a file that was never deleted.
function keepFailedResponse(previous, next) {
  if (!previous) return next;
  const previousDenied = previous.status === 401 || previous.status === 403;
  const previousAuth = responseAuthContext.get(previous);
  const nextAuth = responseAuthContext.get(next);
  // If OAuth and the API-key fallback are both denied, keep OAuth: it is the
  // viewer's primary server credential and carries the connected-account /
  // refresh context the operator is diagnosing. A later anonymous-key 403
  // must not overwrite that evidence. OAuth retry responses still supersede
  // the initially refused OAuth token.
  if (previousDenied && previousAuth && previousAuth.authMethod === 'server_oauth' &&
      nextAuth && nextAuth.authMethod === 'api_key_fallback') return previous;
  return next;
}

// Google rejects a token it has revoked with 401 + reason authError /
// "Invalid Credentials". That is NOT a statement about file permissions: the
// refresh token is usually still good, and re-minting recovers immediately.
// Distinguishing it from a genuine permission failure is what stops a
// password change or session revoke from turning every Drive document into
// "Document unavailable" until the process restarts.
function isExpiredCredential(response) {
  if (!response) return false;
  if (response.status === 401) return true;
  const authHeader = response.headers && typeof response.headers.get === 'function' && response.headers.get('www-authenticate');
  if (authHeader && (authHeader.toLowerCase().includes('invalid_token') || authHeader.toLowerCase().includes('invalid_credentials') || authHeader.toLowerCase().includes('autherror'))) {
    return true;
  }
  return false;
}

async function driveFetch(url, { headers = {}, method = 'GET', timeoutMs = 60000 } = {}) {
  const attempts = [];
  // 'oauth-retry' re-mints the access token first. It only runs after the
  // cached token was explicitly refused, so the common path still makes
  // exactly one request with the cached credential.
  if (vault.isConfigured()) attempts.push('oauth', 'oauth-retry');
  if (apiKey()) attempts.push('key');
  if (!attempts.length) {
    throw driveError(
      'StudyCore is not connected to Google Drive, so it cannot open documents stored there. ' +
      'Ask a Main Admin to connect it in Admin → Integrations.',
      503
    );
  }

  let lastResponse = null;
  let refusedToken = null;
  for (const attempt of attempts) {
    // Only re-mint when the cached token was actually refused; otherwise this
    // attempt is a no-op and would just repeat a request that already failed
    // for a different reason (missing permission, deleted file…).
    if (attempt === 'oauth-retry' && !refusedToken) continue;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let usedToken = null;
    try {
      const requestHeaders = { ...headers };
      let target = url;
      let authContext;
      if (attempt === 'oauth' || attempt === 'oauth-retry') {
        if (attempt === 'oauth-retry') {
          // Drop the dead token so this call — and every concurrent reader —
          // stops presenting it.
          vault.invalidateAccessToken(refusedToken);
        }
        usedToken = await vault.getAccessToken({ forceRefresh: attempt === 'oauth-retry' });
        // Nothing to gain from replaying the identical credential.
        if (attempt === 'oauth-retry' && usedToken === refusedToken) {
          clearTimeout(timer);
          continue;
        }
        requestHeaders.Authorization = `Bearer ${usedToken}`;
        const state = vault.status();
        authContext = {
          authMethod: 'server_oauth',
          authAccount: state && state.connected ? (state.email || null) : null,
          // A usable access token was obtained. The dedicated Main-Admin probe
          // separately forces and reports an actual refresh-token exchange.
          tokenRefresh: 'SUCCESS'
        };
      } else {
        target = withKey(url);
        authContext = { authMethod: 'api_key_fallback', authAccount: null, tokenRefresh: 'NOT_APPLICABLE' };
      }
      response = await fetch(target, { method, headers: requestHeaders, signal: controller.signal });
      if (response && typeof response === 'object') responseAuthContext.set(response, authContext);
    } catch (err) {
      clearTimeout(timer);
      if (err && err.userSafe) throw err; // token minting already explained itself
      throw driveError(err && err.name === 'AbortError'
        ? 'Google Drive did not respond in time. Please try again.'
        : 'Could not reach Google Drive. Please try again shortly.');
    }
    clearTimeout(timer);

    if (response.ok || response.status === 206) return response;

    // A revoked/expired access token: remember it so the retry attempt mints
    // a replacement instead of presenting the same dead credential.
    if (isExpiredCredential(response) && (attempt === 'oauth' || attempt === 'oauth-retry')) {
      refusedToken = usedToken;
    }

    lastResponse = keepFailedResponse(lastResponse, response);
    // 401/403/404 with one credential may still succeed with the other
    // (e.g. a link-shared file the connected account was never added to).
    if (![401, 403, 404].includes(response.status)) break;
  }
  return lastResponse;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
function cachedMetadata(fileId) {
  const hit = metadataCache.get(fileId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (hit) metadataCache.delete(fileId);
  return null;
}

/**
 * Drive metadata for one file, read with StudyCore's own credentials.
 * Cached briefly so paging a PDF does not re-ask Drive on every chunk.
 */
async function getMetadata(fileId, { fresh = false } = {}) {
  const id = String(fileId || '').trim();
  if (!isValidFileId(id)) throw notFound('That Google Drive reference is not valid.');
  if (!fresh) {
    const hit = cachedMetadata(id);
    if (hit) return hit;
  }

  const url = `${DRIVE_API}/files/${encodeURIComponent(id)}` +
    '?fields=id,name,mimeType,size,modifiedTime,trashed&supportsAllDrives=true';
  const res = await driveFetch(url, { timeoutMs: 20000 });

  if (!res.ok) {
    const detail = await googleResponseDetail(res, id, 'drive.files.get metadata');
    if (res.status === 404) {
      throw attachGoogleDriveError(
        notFound('This document could not be found in Google Drive. It may have been deleted or moved out of the library.'),
        detail
      );
    }
    if (res.status === 403 || res.status === 401) {
      // Drive returns 404 for files that do not exist AND files the caller
      // cannot see — but an explicit 403/401 means the file is there and
      // StudyCore's connection just cannot read it. Say so.
      throw attachGoogleDriveError(
        accessError('StudyCore\'s Google Drive connection can no longer read this document.'),
        detail
      );
    }
    throw attachGoogleDriveError(
      driveError(`Google Drive returned an error (HTTP ${res.status}).`),
      detail
    );
  }

  const meta = await res.json();
  if (meta.trashed) {
    throw notFound('This document has been moved to the trash in Google Drive.');
  }

  const workspaceExport = exportMimeFor(meta.mimeType);
  const value = {
    id: meta.id || id,
    name: meta.name || 'Google Drive Document',
    // What StudyCore SERVES. A Google Doc is served as the PDF it exports to.
    contentType: workspaceExport || meta.mimeType || 'application/octet-stream',
    driveMimeType: meta.mimeType || 'application/octet-stream',
    isWorkspace: isWorkspaceMime(meta.mimeType),
    exportMimeType: workspaceExport,
    size: Number(meta.size) || 0,
    modifiedTime: meta.modifiedTime || null
  };
  metadataCache.set(id, { value, expiresAt: Date.now() + METADATA_TTL_MS });
  return value;
}

/** True when StudyCore's OWN credentials can read this file right now. */
async function canRead(fileId) {
  try {
    await getMetadata(fileId, { fresh: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Workspace export (Docs/Sheets/Slides -> PDF), cached in memory only
// ---------------------------------------------------------------------------
function pruneExportCache() {
  const now = Date.now();
  let total = 0;
  for (const [id, entry] of [...exportCache.entries()]) {
    if (entry.expiresAt <= now) exportCache.delete(id);
    else total += entry.buffer.length;
  }
  // Oldest-first eviction while over the ceiling.
  while (total > EXPORT_CACHE_MAX_BYTES && exportCache.size) {
    const [oldestId, oldest] = [...exportCache.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    total -= oldest.buffer.length;
    exportCache.delete(oldestId);
  }
}

function cachedExport(fileId) {
  const hit = exportCache.get(fileId);
  if (hit && hit.expiresAt > Date.now()) return hit;
  if (hit) exportCache.delete(fileId);
  return null;
}

async function exportWorkspaceFile(fileId, meta) {
  const hit = cachedExport(fileId);
  if (hit) return hit;

  const exportMime = meta.exportMimeType;
  if (!exportMime) {
    throw driveError(
      'This Google Workspace file type cannot be displayed. Ask the uploader to save it as a PDF in Google Drive and re-select it.',
      415
    );
  }
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export` +
    `?mimeType=${encodeURIComponent(exportMime)}`;
  const res = await driveFetch(url, { timeoutMs: 120000 });
  if (!res.ok) {
    const detail = await googleResponseDetail(res, fileId, 'drive.files.export');
    // 403/401 here means the file exists but StudyCore's connection was
    // refused — reporting that as "not found" sent admins hunting through
    // Drive for a document that was never deleted.
    if (res.status === 403 || res.status === 401) {
      throw attachGoogleDriveError(
        accessError('StudyCore\'s Google Drive connection can no longer read this document.'),
        detail
      );
    }
    if (res.status === 404) {
      throw attachGoogleDriveError(
        notFound('This document could not be read from Google Drive.'),
        detail
      );
    }
    throw attachGoogleDriveError(
      driveError(`Google Drive could not export this document (HTTP ${res.status}).`),
      detail
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const entry = { buffer, contentType: exportMime, expiresAt: Date.now() + EXPORT_TTL_MS };
  exportCache.set(fileId, entry);
  pruneExportCache();
  return entry;
}

function sliceFromBuffer(entry, range) {
  const size = entry.buffer.length;
  if (!range) {
    return {
      body: Readable.from([entry.buffer]),
      contentLength: size,
      contentType: entry.contentType,
      contentRange: null
    };
  }
  const start = Math.max(0, Number(range.start) || 0);
  const end = Math.min(Number.isFinite(range.end) ? Number(range.end) : size - 1, size - 1);
  const slice = entry.buffer.subarray(start, end + 1);
  return {
    body: Readable.from([slice]),
    contentLength: slice.length,
    contentType: entry.contentType,
    contentRange: `bytes ${start}-${end}/${size}`
  };
}

// ---------------------------------------------------------------------------
// Object-storage interface (key === Drive file id)
// ---------------------------------------------------------------------------

async function headObject(key) {
  const meta = await getMetadata(key);
  if (meta.isWorkspace) {
    // An export has no size until it exists, and the reader needs a real
    // Content-Length for its range maths. Export once (cached) and measure.
    const entry = await exportWorkspaceFile(String(key).trim(), meta);
    return {
      contentLength: entry.buffer.length,
      contentType: entry.contentType,
      lastModified: meta.modifiedTime ? new Date(meta.modifiedTime) : null,
      fileName: meta.name
    };
  }
  return {
    contentLength: meta.size,
    contentType: meta.contentType,
    lastModified: meta.modifiedTime ? new Date(meta.modifiedTime) : null,
    fileName: meta.name
  };
}

// Drive explains WHY it refused in the error body's `reason`. The same 403
// covers "this is a Workspace file", "Google flagged this file" and "you have
// no access" — three problems with three different fixes — so the reason is
// what makes the retrieval path react correctly instead of guessing.
async function refusalReason(res) {
  try {
    const body = await res.clone().json();
    const error = body && body.error;
    if (!error) return null;
    if (Array.isArray(error.errors) && error.errors.length && error.errors[0].reason) {
      return String(error.errors[0].reason);
    }
    return error.message ? String(error.message) : null;
  } catch {
    return null;
  }
}

function downloadUrl(id, { acknowledgeAbuse = false } = {}) {
  return `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true` +
    (acknowledgeAbuse ? '&acknowledgeAbuse=true' : '');
}

async function getObject(key, range) {
  const id = String(key || '').trim();
  if (!isValidFileId(id)) throw notFound('That Google Drive reference is not valid.');

  // Already-exported Workspace file: serve the cached PDF (incl. ranges).
  const cachedPdf = cachedExport(id);
  if (cachedPdf) return sliceFromBuffer(cachedPdf, range);

  const headers = {};
  if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    headers.Range = `bytes=${range.start}-${range.end}`;
  }

  let res = await driveFetch(downloadUrl(id), { headers });

  const deliver = (response) => {
    const contentLengthHeader = Number(response.headers.get('Content-Length'));
    return {
      body: Readable.fromWeb(response.body),
      contentLength: Number.isFinite(contentLengthHeader) && contentLengthHeader >= 0
        ? contentLengthHeader
        : undefined,
      contentType: response.headers.get('Content-Type') || null,
      contentRange: response.headers.get('Content-Range') || null
    };
  };

  if (res.ok || res.status === 206) return deliver(res);

  // `alt=media` refuses native Workspace files ("Only files with binary
  // content can be downloaded"). Confirm with metadata and export instead.
  if (res.status === 403 || res.status === 400) {
    const reason = await refusalReason(res);

    // Google's malware scanner flags a file: the download is refused until
    // the caller explicitly acknowledges it. This is extremely common for
    // legitimate shared course material (scanned past papers, large PDFs),
    // and the admin — who owns the file and picked it deliberately — has
    // already vouched for it. Without this retry the document is publishable
    // but permanently unopenable in the viewer.
    if (String(reason) === 'cannotDownloadAbusiveFile') {
      const retry = await driveFetch(downloadUrl(id, { acknowledgeAbuse: true }), { headers });
      if (retry && (retry.ok || retry.status === 206)) return deliver(retry);
      if (retry) res = retry;
    }

    const meta = await getMetadata(id);
    if (meta.isWorkspace) {
      const entry = await exportWorkspaceFile(id, meta);
      return sliceFromBuffer(entry, range);
    }
  }
  const detail = await googleResponseDetail(res, id, 'drive.files.get media');
  if (res.status === 404) {
    throw attachGoogleDriveError(
      notFound('This document could not be found in Google Drive. It may have been deleted or moved out of the library.'),
      detail
    );
  }
  if (res.status === 403 || res.status === 401) {
    throw attachGoogleDriveError(
      accessError('StudyCore\'s Google Drive connection can no longer read this document.'),
      detail
    );
  }
  if (res.status === 416) {
    throw attachGoogleDriveError(
      driveError('Google Drive rejected that byte range.', 416),
      detail
    );
  }
  throw attachGoogleDriveError(
    driveError(`Google Drive returned an error (HTTP ${res.status}).`),
    detail
  );
}

async function readBytes(key, start, end) {
  const obj = await getObject(key, { start, end });
  const chunks = [];
  for await (const chunk of obj.body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Deleting a StudyCore resource must NEVER delete the file from Google Drive.
 *
 * Drive is the source of truth and the file belongs to the uploader, not to
 * StudyCore. Removing the resource removes StudyCore's reference to it; the
 * document stays exactly where its owner put it. (Files StudyCore itself
 * uploaded into the connected vault folder are a different provider,
 * 'google_drive_vault', and are still cleaned up by that module.)
 */
async function deleteObject(key) {
  if (!key) return;
  metadataCache.delete(String(key).trim());
  exportCache.delete(String(key).trim());
}

function forgetCaches(key) {
  if (!key) {
    metadataCache.clear();
    exportCache.clear();
    return;
  }
  const id = String(key).trim();
  metadataCache.delete(id);
  exportCache.delete(id);
}

module.exports = {
  backendName: () => 'google_drive',
  headObject,
  getObject,
  readBytes,
  deleteObject,
  // Drive-specific helpers used by the publish path and operator tooling.
  getMetadata,
  canRead,
  isValidFileId,
  sourceFileIdForResource,
  fileIdForResource,
  isWorkspaceMime,
  exportMimeFor,
  hasServerCredentials,
  serviceAccountEmail,
  forgetCaches,
  DRIVE_API
};
