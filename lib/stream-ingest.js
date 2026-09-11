// =============================================================================
// StudyCore — helper that offloads a freshly-uploaded video to Cloudflare
// Stream, shared by the Main Admin and Content Admin upload routes so the
// behaviour cannot drift between them.
//
// Flow (only when Stream is configured AND the resource is a video with a
// stored object):
//   1. Read the object bytes back from StudyCore storage (R2 or local disk).
//   2. POST them to Cloudflare Stream, which encodes adaptive renditions.
//   3. Persist the returned stream_uid / stream_status / duration on the row
//      and flip storage_provider to 'stream'.
//
// It NEVER throws into the request: a Stream failure just leaves the resource
// on the existing R2 progressive player (storage_provider stays 'r2'/'local',
// stream_uid stays NULL), so a Stream outage can never fail an upload the
// admin already completed — mirroring the mailer/storage fallback philosophy.
//
// TIMING: the offload does NOT run inside the upload request.
// `queueOffload()` schedules it right after the response is sent. The upload
// route's job is finished once the bytes are safely in R2 and the row is
// committed; making the admin's browser also wait for StudyCore to download
// the whole video back out of R2 and re-upload it to Cloudflare doubled (or
// tripled) the perceived upload time and regularly blew past the client's
// finalize window, surfacing as "the server did not confirm the upload in
// time" on a video that had in fact uploaded perfectly. Students still get
// the progressive R2 player while encoding is pending, and the row flips to
// the adaptive Stream player as soon as the background offload lands.
// =============================================================================

'use strict';

const db = require('../db');
const storage = require('./storage');
const stream = require('./stream');

// Offload one already-inserted video resource row to Cloudflare Stream.
// Returns { offloaded: true, uid } on success, or { offloaded: false, reason }
// otherwise. Safe to call for any resource; it self-gates on category/config.
async function offloadResourceToStream(resource) {
  if (!stream.isConfigured()) return { offloaded: false, reason: 'not_configured' };
  if (!resource || resource.category !== 'video') return { offloaded: false, reason: 'not_video' };
  if (!resource.stored_name) return { offloaded: false, reason: 'no_stored_object' };
  if (resource.stream_uid) return { offloaded: false, reason: 'already_streamed' };

  const size = Number(resource.file_size) || 0;
  if (size > stream.uploadBasicMaxBytes()) {
    // Too large for the basic-upload path — keep it on the R2 player.
    return { offloaded: false, reason: 'too_large_for_stream' };
  }

  let buffer;
  try {
    // readBytes(key, start, end) — pull the whole object back from storage.
    buffer = await storage.readBytes(resource.stored_name, 0, Math.max(0, size - 1) || undefined);
  } catch (err) {
    console.warn('StudyCore Stream: could not read uploaded video back from storage:', err.message);
    return { offloaded: false, reason: 'read_failed' };
  }

  let video;
  try {
    video = await stream.uploadFromBuffer(buffer, {
      name: resource.title || 'StudyCore video',
      fileName: resource.file_name || undefined,
      contentType: resource.mime_type || 'video/mp4'
    });
  } catch (err) {
    console.warn('StudyCore Stream: upload to Cloudflare Stream failed:', err.message);
    return { offloaded: false, reason: 'upload_failed', error: err.message };
  }

  if (!video || !video.uid) return { offloaded: false, reason: 'no_uid' };

  try {
    db.prepare(`
      UPDATE resources
      SET stream_uid = ?, stream_status = ?, stream_duration = ?, storage_provider = 'stream', updated_at = ?
      WHERE id = ?
    `).run(video.uid, video.status || 'queued', video.duration || null, new Date().toISOString(), resource.id);
  } catch (err) {
    // The video is in Stream but we failed to record it. Best-effort clean up
    // the orphaned Stream video so it doesn't linger unreferenced.
    console.warn('StudyCore Stream: could not persist stream_uid, rolling back Stream video:', err.message);
    stream.deleteVideo(video.uid).catch(() => {});
    return { offloaded: false, reason: 'persist_failed' };
  }

  return { offloaded: true, uid: video.uid, status: video.status };
}

// ---------------------------------------------------------------------------
// Background scheduling
//
// Only one offload runs at a time. Each one holds the whole video in memory
// (Cloudflare's basic upload is not streaming), so letting a batch of uploads
// offload concurrently is the difference between ~200MB and 1GB+ of resident
// memory on a small dyno. A simple serial queue keeps the peak bounded and
// the uploads themselves instant.
// ---------------------------------------------------------------------------

const queue = [];
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const resourceId = queue.shift();
      let row = null;
      try {
        row = db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
      } catch (err) {
        console.warn('StudyCore Stream: could not reload resource for offload:', err.message);
      }
      if (!row) continue;
      try {
        await offloadResourceToStream(row);
      } catch (err) {
        // offloadResourceToStream already swallows its own failures; this is
        // the last line of defence so one bad video cannot kill the queue.
        console.warn('StudyCore Stream: background offload failed:', err.message);
      }
    }
  } finally {
    draining = false;
  }
}

// Schedule a video for background offload. Returns immediately — callers use
// this from an upload route so the admin's request finishes as soon as the
// bytes are stored, instead of waiting on a second round trip to Cloudflare.
function queueOffload(resourceId) {
  if (!resourceId || !stream.isConfigured()) return false;
  if (queue.includes(resourceId)) return true;
  queue.push(resourceId);
  // setImmediate keeps the work off the response path but still inside this
  // process, so a restart simply leaves the video on the progressive player.
  setImmediate(() => { drain().catch(() => {}); });
  return true;
}

// Test/diagnostic helper: resolves once the queue has fully drained.
function pendingOffloads() {
  return queue.length + (draining ? 1 : 0);
}

module.exports = { offloadResourceToStream, queueOffload, pendingOffloads };
