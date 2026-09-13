// StudyCore — Bunny Stream integration.
//
// This is the only module that reads BUNNY_API_KEY or calls Bunny's management
// API. The key is intentionally never exported, logged, persisted, or included
// in browser-facing URLs/responses.
'use strict';

const LIBRARY_ID = String(process.env.BUNNY_LIBRARY_ID || '').trim();
const API_KEY = String(process.env.BUNNY_API_KEY || '').trim();
const CDN_HOSTNAME = String(process.env.BUNNY_CDN_HOSTNAME || '').trim()
  .replace(/^https?:\/\//i, '').replace(/\/+$/, '');
const API_BASE = LIBRARY_ID ? `https://video.bunnycdn.com/library/${encodeURIComponent(LIBRARY_ID)}/videos` : null;

function looksConfigured(value) {
  const v = String(value || '').trim();
  return Boolean(v) && !/^your-|^changeme|^replace-this|^xxx+$/i.test(v);
}
const streamConfigured = looksConfigured(LIBRARY_ID) && looksConfigured(API_KEY) && looksConfigured(CDN_HOSTNAME);
function isConfigured() { return streamConfigured; }
function missingVars() {
  return [
    ['BUNNY_LIBRARY_ID', LIBRARY_ID],
    ['BUNNY_API_KEY', API_KEY],
    ['BUNNY_CDN_HOSTNAME', CDN_HOSTNAME]
  ].filter(([, value]) => !looksConfigured(value)).map(([name]) => name);
}

async function callBunny(url, options = {}) {
  if (!streamConfigured) throw new Error('Bunny Stream is not configured.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: Object.assign({ AccessKey: API_KEY, Accept: 'application/json' }, options.headers || {}),
      body: options.body,
      signal: controller.signal
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'Bunny Stream did not respond in time.' : `Could not reach Bunny Stream: ${err.message}`);
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    // Never include response bodies: a provider/proxy error can echo request
    // details, and credentials must not reach logs or API responses.
    throw new Error(`Bunny Stream request failed (HTTP ${response.status}).`);
  }
  if (response.status === 204 || options.noJson) return null;
  return response.json();
}

// StudyCore's current upload path buffers a video after reading it from R2.
// Keep the existing 200 MB safety ceiling to avoid exhausting a small Render
// instance; MAX_UPLOAD_MB defaults to the same value.
const BASIC_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
function uploadBasicMaxBytes() { return BASIC_UPLOAD_MAX_BYTES; }

function normaliseVideo(video) {
  if (!video) return null;
  const statusNumber = Number(video.status);
  // Bunny status 3 means encoding finished. Status 4 is emitted whenever an
  // individual resolution finishes and also means at least one rendition is
  // playable. Only status 5 is an encoding failure (6+ are upload/metadata
  // lifecycle events, not failures).
  const ready = statusNumber === 3 || statusNumber === 4;
  return {
    uid: video.guid,
    status: ready ? 'ready' : statusNumber === 5 ? 'error' : 'queued',
    readyToStream: ready,
    duration: Number(video.length) || 0,
    thumbnail: video.thumbnailFileName ? `https://${CDN_HOSTNAME}/${encodeURIComponent(video.guid)}/${encodeURIComponent(video.thumbnailFileName)}` : null,
    raw: video
  };
}

async function uploadFromBuffer(buffer, meta = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Cannot upload an empty video to Bunny Stream.');
  if (buffer.length > BASIC_UPLOAD_MAX_BYTES) {
    const err = new Error('Video exceeds the safe basic-upload limit.');
    err.code = 'STREAM_TOO_LARGE';
    throw err;
  }
  const created = await callBunny(API_BASE, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: meta.name || meta.fileName || 'StudyCore video' })
  });
  if (!created || !created.guid) throw new Error('Bunny Stream did not return a video ID.');
  try {
    await callBunny(`${API_BASE}/${encodeURIComponent(created.guid)}`, {
      method: 'PUT', headers: { 'Content-Type': meta.contentType || 'application/octet-stream' },
      body: buffer, timeoutMs: 180000, noJson: true
    });
  } catch (err) {
    await deleteVideo(created.guid).catch(() => {});
    throw err;
  }
  return normaliseVideo(created);
}

async function copyFromUrl(sourceUrl, meta = {}) {
  return normaliseVideo(await callBunny(`${API_BASE}/fetch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: sourceUrl, title: meta.name || 'StudyCore video' }), timeoutMs: 60000
  }));
}
async function getVideo(uid) { return normaliseVideo(await callBunny(`${API_BASE}/${encodeURIComponent(uid)}`)); }
async function deleteVideo(uid) {
  if (uid) await callBunny(`${API_BASE}/${encodeURIComponent(uid)}`, { method: 'DELETE', noJson: true });
}

// Bunny's hosted player is responsive and supports adaptive playback on both
// desktop and mobile. The library's player retrieves renditions from its
// configured pull-zone/CDN hostname; direct assets below also use that host.
function iframeUrl(uid, opts = {}) {
  if (!uid || !streamConfigured) return null;
  const params = new URLSearchParams({ autoplay: 'false', preload: 'metadata', responsive: 'true' });
  if (Number.isFinite(opts.startTime) && opts.startTime > 0) params.set('t', String(Math.floor(opts.startTime)));
  return `https://iframe.mediadelivery.net/embed/${encodeURIComponent(LIBRARY_ID)}/${encodeURIComponent(uid)}?${params}`;
}
function hlsUrl(uid) { return uid && CDN_HOSTNAME ? `https://${CDN_HOSTNAME}/${encodeURIComponent(uid)}/playlist.m3u8` : null; }
function thumbnailUrl(uid) { return uid && CDN_HOSTNAME ? `https://${CDN_HOSTNAME}/${encodeURIComponent(uid)}/thumbnail.jpg` : null; }
function customerSubdomain() { return CDN_HOSTNAME || null; }
function signedPlaybackRequired() { return false; }

module.exports = { isConfigured, streamConfigured, missingVars, uploadBasicMaxBytes, uploadFromBuffer,
  copyFromUrl, getVideo, deleteVideo, iframeUrl, hlsUrl, thumbnailUrl, customerSubdomain, signedPlaybackRequired };
