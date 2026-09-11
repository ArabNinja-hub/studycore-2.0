// =============================================================================
// StudyCore — Cloudflare Stream integration
// -----------------------------------------------------------------------------
// Cloudflare Stream stores and delivers video with true adaptive-bitrate
// streaming (HLS + DASH). Its built-in web player automatically offers a
// quality selector — Auto / 1080p / 720p / 480p / … — and picks the best
// rendition for the viewer's screen and connection, without StudyCore having
// to transcode anything itself (there is no ffmpeg on the host).
//
// This module is the ONLY place that talks to the Stream API. It mirrors the
// design of lib/r2.js / lib/storage.js:
//
//   * `streamConfigured` is a single source of truth for "is Stream usable".
//   * When it is NOT configured, every uploaded video keeps flowing through
//     the existing R2 progressive player exactly as before — nothing breaks,
//     the platform simply doesn't get the quality selector until an operator
//     sets the env vars. This matches the R2→local and SMTP→console fallbacks
//     already used across the codebase.
//
// Required environment variables (set in .env locally, and in the host's
// Environment tab in production — never commit real values):
//   CF_STREAM_ACCOUNT_ID   Cloudflare account ID that owns Stream
//   CF_STREAM_API_TOKEN    API token with the "Stream:Edit" permission
// Optional:
//   CF_STREAM_CUSTOMER_SUBDOMAIN  e.g. "customer-abc123def456" — the
//                          customer-<code>.cloudflarestream.com host used for
//                          iframe/HLS URLs. When unset it is discovered from
//                          the first upload response and cached in memory.
//   CF_STREAM_SIGNED       "true" to require signed playback tokens. Left off
//                          by default; StudyCore already gates the video page
//                          itself behind Premium auth, and enabling signed
//                          URLs needs extra key setup on the Cloudflare side.
// =============================================================================

'use strict';

const ACCOUNT_ID = String(process.env.CF_STREAM_ACCOUNT_ID || '').trim();
const API_TOKEN = String(process.env.CF_STREAM_API_TOKEN || '').trim();
let CUSTOMER_SUBDOMAIN = String(process.env.CF_STREAM_CUSTOMER_SUBDOMAIN || '').trim();

function looksConfigured(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  return !/^your-|^changeme|^replace-this|^xxx+$/i.test(v);
}

const streamConfigured = looksConfigured(ACCOUNT_ID) && looksConfigured(API_TOKEN);

function isConfigured() {
  return streamConfigured;
}

function missingVars() {
  const missing = [];
  if (!looksConfigured(ACCOUNT_ID)) missing.push('CF_STREAM_ACCOUNT_ID');
  if (!looksConfigured(API_TOKEN)) missing.push('CF_STREAM_API_TOKEN');
  return missing;
}

const API_BASE = ACCOUNT_ID
  ? `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream`
  : null;

function authHeaders(extra) {
  return Object.assign({ Authorization: `Bearer ${API_TOKEN}` }, extra || {});
}

// Cloudflare returns { success, errors:[{code,message}], result }. Normalise
// that into either the result object or a thrown Error carrying a readable
// message, so callers never have to parse the envelope themselves.
async function callStream(pathname, options) {
  if (!streamConfigured) {
    throw new Error('Cloudflare Stream is not configured.');
  }
  const url = `${API_BASE}${pathname}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), (options && options.timeoutMs) || 30000);
  let res;
  try {
    res = await fetch(url, {
      method: (options && options.method) || 'GET',
      headers: authHeaders(options && options.headers),
      body: options && options.body,
      signal: controller.signal
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError'
      ? 'Cloudflare Stream did not respond in time.'
      : `Could not reach Cloudflare Stream: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // Non-JSON body (rare) — fall through to a status-based error below.
  }

  if (!res.ok || !payload || payload.success === false) {
    const detail = payload && Array.isArray(payload.errors) && payload.errors.length
      ? payload.errors.map((e) => e.message || e.code).join('; ')
      : `HTTP ${res.status}`;
    throw new Error(`Cloudflare Stream error: ${detail}`);
  }
  return payload.result;
}

// A Stream video's playback host. Prefer the explicitly configured customer
// subdomain, otherwise the one discovered from an upload/details response and
// cached in memory for the rest of the process's life.
function rememberSubdomainFrom(result) {
  if (CUSTOMER_SUBDOMAIN) return;
  const src = (result && (result.playback && result.playback.hls)) || (result && result.preview) || '';
  const m = String(src).match(/https?:\/\/(customer-[a-z0-9]+)\.cloudflarestream\.com/i);
  if (m) CUSTOMER_SUBDOMAIN = m[1];
}

// ---------------------------------------------------------------------------
// Ingestion
//
// The uploaded video already lives in StudyCore's own object storage (R2, or
// local disk in dev) by the time a route handler runs. To hand it to Stream
// we read those bytes back and POST them to Cloudflare's "basic upload"
// endpoint as multipart/form-data. This path works no matter which storage
// backend produced the object, needs no extra dependency and no presigning,
// and Cloudflare encodes the video asynchronously afterwards.
//
// Cloudflare's basic upload caps a single request at 200MB, which is exactly
// StudyCore's default MAX_UPLOAD_MB — callers must therefore only route files
// at or under STREAM_BASIC_UPLOAD_MAX_BYTES here and keep larger uploads on
// the R2 progressive player. `uploadBasicMaxBytes` is exported so callers can
// make that decision without hard-coding the limit.
// ---------------------------------------------------------------------------

const STREAM_BASIC_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

function uploadBasicMaxBytes() {
  return STREAM_BASIC_UPLOAD_MAX_BYTES;
}

// Upload raw video bytes to Cloudflare Stream. `buffer` is the whole file;
// `meta.name` shows in the Stream dashboard. Returns { uid, status, ... }.
async function uploadFromBuffer(buffer, meta) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Cannot upload an empty video to Cloudflare Stream.');
  }
  if (buffer.length > STREAM_BASIC_UPLOAD_MAX_BYTES) {
    const err = new Error('Video exceeds the Cloudflare Stream basic-upload limit.');
    err.code = 'STREAM_TOO_LARGE';
    throw err;
  }
  const form = new FormData();
  const name = (meta && meta.name) || 'StudyCore video';
  form.append('file', new Blob([buffer], { type: (meta && meta.contentType) || 'video/mp4' }), (meta && meta.fileName) || `${name}.mp4`);
  if (String(process.env.CF_STREAM_SIGNED || '').toLowerCase() === 'true') {
    form.append('requireSignedURLs', 'true');
  }
  // Do NOT set Content-Type manually: fetch derives the multipart boundary.
  const result = await callStream('', {
    method: 'POST',
    body: form,
    timeoutMs: 180000
  });
  rememberSubdomainFrom(result);
  return normaliseVideo(result);
}

// Alternative ingestion: ask Cloudflare to pull the video from a URL it can
// fetch (e.g. a presigned R2 link). Kept for large-file / future use; the
// upload path above is the default because it needs no presigning.
async function copyFromUrl(sourceUrl, meta) {
  const body = {
    url: sourceUrl,
    meta: Object.assign({ name: 'StudyCore video' }, meta || {})
  };
  if (String(process.env.CF_STREAM_SIGNED || '').toLowerCase() === 'true') {
    body.requireSignedURLs = true;
  }
  const result = await callStream('/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 60000
  });
  rememberSubdomainFrom(result);
  return normaliseVideo(result);
}

// Fetch current details for a Stream video (used to poll encoding status).
async function getVideo(uid) {
  const result = await callStream(`/${encodeURIComponent(uid)}`);
  rememberSubdomainFrom(result);
  return normaliseVideo(result);
}

async function deleteVideo(uid) {
  if (!uid) return;
  await callStream(`/${encodeURIComponent(uid)}`, { method: 'DELETE' });
}

function normaliseVideo(result) {
  if (!result) return null;
  return {
    uid: result.uid,
    status: (result.status && result.status.state) || 'unknown',
    readyToStream: Boolean(result.readyToStream),
    duration: Number(result.duration) || 0,
    thumbnail: result.thumbnail || null,
    raw: result
  };
}

// ---------------------------------------------------------------------------
// Playback URLs (browser-facing)
// ---------------------------------------------------------------------------

function customerSubdomain() {
  return CUSTOMER_SUBDOMAIN || null;
}

// The official Stream iframe embed. Its player carries the adaptive-bitrate
// quality selector (Auto / 1080p / 720p / …) natively. Query flags disable
// the download button to match StudyCore's view-only policy.
function iframeUrl(uid, opts) {
  const sub = customerSubdomain();
  if (!uid || !sub) return null;
  const params = new URLSearchParams();
  if (opts && Number.isFinite(opts.startTime) && opts.startTime > 0) {
    params.set('startTime', `${Math.floor(opts.startTime)}s`);
  }
  const qs = params.toString();
  return `https://${sub}.cloudflarestream.com/${encodeURIComponent(uid)}/iframe${qs ? `?${qs}` : ''}`;
}

// The HLS manifest, for the (optional) custom-player path. Adaptive by design.
function hlsUrl(uid) {
  const sub = customerSubdomain();
  if (!uid || !sub) return null;
  return `https://${sub}.cloudflarestream.com/${encodeURIComponent(uid)}/manifest/video.m3u8`;
}

function thumbnailUrl(uid) {
  const sub = customerSubdomain();
  if (!uid || !sub) return null;
  return `https://${sub}.cloudflarestream.com/${encodeURIComponent(uid)}/thumbnails/thumbnail.jpg`;
}

module.exports = {
  isConfigured,
  streamConfigured,
  missingVars,
  uploadBasicMaxBytes,
  uploadFromBuffer,
  copyFromUrl,
  getVideo,
  deleteVideo,
  iframeUrl,
  hlsUrl,
  thumbnailUrl,
  customerSubdomain
};
