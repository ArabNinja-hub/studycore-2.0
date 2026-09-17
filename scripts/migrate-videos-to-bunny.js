'use strict';

// Explicit, resumable legacy-video migration. This command never deletes a
// source object or a Bunny video. Run with --apply after reviewing --dry-run.
require('dotenv').config();
const db = require('../db');
const storage = require('../lib/storage');
const bunny = require('../lib/stream');

const apply = process.argv.includes('--apply');
const waitMs = Math.max(5000, Number(process.env.BUNNY_MIGRATION_POLL_MS) || 15000);
const maxWait = Math.max(1, Number(process.env.BUNNY_MIGRATION_MAX_MINUTES) || 180) * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function log(row, uid, upload, processing, verification) {
  console.log(JSON.stringify({ resourceId: row.id, title: row.title, oldProvider: row.storage_provider || 'local', bunnyVideoId: uid || null, uploadStatus: upload, processingStatus: processing, verification }));
}

async function migrate(row) {
  // Existing stream_uid is the idempotency key. Never create another video.
  if (row.stream_uid) {
    let video;
    try { video = await bunny.getVideo(row.stream_uid); } catch (e) { log(row, row.stream_uid, 'existing', 'lookup-error', e.message); return; }
    log(row, row.stream_uid, 'existing', video.status, video.readyToStream ? 'playable' : 'not-ready');
    if (apply) db.prepare('UPDATE resources SET stream_status = ?, stream_duration = ? WHERE id = ?').run(video.status, video.duration || null, row.id);
    return;
  }
  if (!row.stored_name || !['local', 'r2'].includes(row.storage_provider || 'local')) return;
  if (!apply) { log(row, null, 'dry-run', 'not-started', 'not-verified'); return; }

  // Read the source from the SAME backend the row was stored in, not from
  // whatever backend is globally configured. In production R2 is configured,
  // so storage.getObject() looks in R2 for EVERY key — correct for 'r2' rows
  // but wrong for 'local' rows whose bytes live on the Render persistent disk
  // (DATA_DIR/uploads). Dispatch on the recorded provider so local videos are
  // read from disk and R2 videos from R2.
  const provider = row.storage_provider || 'local';
  const source = provider === 'r2'
    ? await storage.getObject(row.stored_name)
    : await storage.getLocalObject(row.stored_name);
  const video = await bunny.uploadFromStream(source.body, { name: row.title, fileName: row.file_name, contentLength: source.contentLength });
  log(row, video.uid, 'uploaded', video.status, 'waiting');
  const started = Date.now();
  let current = video;
  while (!current.readyToStream && current.status !== 'error' && Date.now() - started < maxWait) {
    await sleep(waitMs);
    current = await bunny.getVideo(video.uid);
    log(row, video.uid, 'uploaded', current.status, current.readyToStream ? 'playable' : 'not-ready');
  }
  if (!current.readyToStream) throw new Error(`Bunny video ${video.uid} did not become playable (${current.status}). Source retained.`);
  // Only after Bunny confirms readiness do we make the old bytes unreachable
  // from normal playback. The source itself remains untouched for cleanup.
  db.prepare(`UPDATE resources SET storage_provider='bunny', stream_uid=?, stream_status=?, stream_duration=?, stored_name=NULL WHERE id=?`)
    .run(video.uid, current.status, current.duration || null, row.id);
  log(row, video.uid, 'uploaded', current.status, 'playable-and-committed');
}

(async () => {
  if (!bunny.isConfigured()) throw new Error(`Bunny is not configured: ${bunny.missingVars().join(', ')}`);
  const rows = db.prepare(`SELECT id,title,storage_provider,stored_name,file_name,stream_uid,stream_status FROM resources WHERE (stream_uid IS NOT NULL OR ((stored_name IS NOT NULL) AND (storage_provider IN ('local','r2') OR storage_provider IS NULL))) AND (mime_type LIKE 'video/%' OR lower(file_name) LIKE '%.mp4' OR lower(file_name) LIKE '%.webm' OR lower(file_name) LIKE '%.mov' OR lower(file_name) LIKE '%.m4v') ORDER BY id`).all();
  console.log(`${apply ? 'APPLY' : 'DRY-RUN'}: ${rows.length} legacy video(s); no source deletion is performed.`);
  for (const row of rows) {
    try { await migrate(row); } catch (e) { log(row, null, 'failed', 'not-committed', e.message); }
  }
})().catch((e) => { console.error(`Migration aborted: ${e.message}`); process.exitCode = 1; });
