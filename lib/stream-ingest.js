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

module.exports = { offloadResourceToStream };
