// =============================================================================
// StudyCore — legacy Google Drive reference reader
// -----------------------------------------------------------------------------
// New Drive Picker publishes are imported into StudyCore storage. This module
// remains for older rows whose `storage_provider` is still 'google_drive' and
// whose storage key is the original uploader's Drive file id. It exposes the
// same tiny object-storage interface as lib/storage.js (R2 / local disk) and
// lib/google-drive-vault.js —
//
//     headObject(key) / getObject(key, range) / readBytes(key, s, e) / deleteObject(key)
//
// — except the "key" is a GOOGLE DRIVE FILE ID and the bytes are fetched from
// Drive on demand. Because the interface matches, lib/document-storage.js can
// dispatch legacy `storage_provider = 'google_drive'` rows here and the student
// stream route (routes/resources.routes.js) serves them through exactly the
// same access control as any other document:
//
//     Google Drive -> StudyCore backend -> StudyCore document viewer
//
// This is a compatibility fallback, not the publish path. New Drive Picker
// selections are copied into StudyCore storage first so source-file sharing
// cannot affect students. There is still no "being moved" state for students:
// an old row either proxies successfully through StudyCore, or reports that
// the original Drive file is unavailable.
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

function notFound(message) {
  const err = new Error(message || 'Not found');
  err.code = 'NoSuchKey';
  err.name = 'NoSuchKey';
  err.statusCode = 404;
  return err;
}

function driveError(message, statusCode = 502) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.userSafe = true;
  return err;
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
async function driveFetch(url, { headers = {}, method = 'GET', timeoutMs = 60000 } = {}) {
  const attempts = [];
  if (vault.isConfigured()) attempts.push('oauth');
  if (apiKey()) attempts.push('key');
  if (!attempts.length) {
    throw driveError(
      'StudyCore is not connected to Google Drive, so it cannot open documents stored there. ' +
      'Ask a Main Admin to connect it in Admin → Integrations.',
      503
    );
  }

  let lastResponse = null;
  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      const requestHeaders = { ...headers };
      let target = url;
      if (attempt === 'oauth') {
        requestHeaders.Authorization = `Bearer ${await vault.getAccessToken()}`;
      } else {
        target = withKey(url);
      }
      response = await fetch(target, { method, headers: requestHeaders, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.userSafe) throw err; // token minting already explained itself
      throw driveError(err && err.name === 'AbortError'
        ? 'Google Drive did not respond in time. Please try again.'
        : 'Could not reach Google Drive. Please try again shortly.');
    }
    clearTimeout(timer);

    if (response.ok || response.status === 206) return response;
    lastResponse = response;
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
    if (res.status === 404 || res.status === 403 || res.status === 401) {
      throw notFound('This document could not be found in Google Drive, or StudyCore no longer has access to it.');
    }
    throw driveError(`Google Drive returned an error (HTTP ${res.status}).`);
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
    if (res.status === 404 || res.status === 403 || res.status === 401) {
      throw notFound('This document could not be read from Google Drive.');
    }
    throw driveError(`Google Drive could not export this document (HTTP ${res.status}).`);
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

  const res = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
    { headers }
  );

  if (res.ok || res.status === 206) {
    const contentLengthHeader = Number(res.headers.get('Content-Length'));
    return {
      body: Readable.fromWeb(res.body),
      contentLength: Number.isFinite(contentLengthHeader) && contentLengthHeader >= 0
        ? contentLengthHeader
        : undefined,
      contentType: res.headers.get('Content-Type') || null,
      contentRange: res.headers.get('Content-Range') || null
    };
  }

  // `alt=media` refuses native Workspace files ("Only files with binary
  // content can be downloaded"). Confirm with metadata and export instead.
  if (res.status === 403 || res.status === 400) {
    const meta = await getMetadata(id);
    if (meta.isWorkspace) {
      const entry = await exportWorkspaceFile(id, meta);
      return sliceFromBuffer(entry, range);
    }
  }
  if (res.status === 404 || res.status === 403 || res.status === 401) {
    throw notFound('This document could not be found in Google Drive, or StudyCore no longer has access to it.');
  }
  if (res.status === 416) {
    throw driveError('Google Drive rejected that byte range.', 416);
  }
  throw driveError(`Google Drive returned an error (HTTP ${res.status}).`);
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
  isWorkspaceMime,
  exportMimeFor,
  hasServerCredentials,
  serviceAccountEmail,
  forgetCaches,
  DRIVE_API
};
