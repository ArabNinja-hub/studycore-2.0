'use strict';

// Explicit, resumable legacy-video migration. This command never deletes a
// source object or a Bunny video. Run with --apply after reviewing --dry-run.
require('dotenv').config();
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const storage = require('../lib/storage');
const bunny = require('../lib/stream');

const apply = process.argv.includes('--apply');
const waitMs = Math.max(5000, Number(process.env.BUNNY_MIGRATION_POLL_MS) || 15000);
const maxWait = Math.max(1, Number(process.env.BUNNY_MIGRATION_MAX_MINUTES) || 180) * 60 * 1000;
let db;

function openDatabase() {
  if (apply) return { connection: require('../db'), owned: false };
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  return {
    // Do not load db/index.js during a dry run: that module intentionally runs
    // boot-time schema migrations. A read-only connection makes the dry-run
    // no-write guarantee enforceable by SQLite itself.
    connection: new DatabaseSync(path.join(dataDir, 'studycore.sqlite'), { readOnly: true }),
    owned: true
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function log(row, uid, upload, processing, verification) {
  console.log(JSON.stringify({ resourceId: row.id, title: row.title, oldProvider: row.storage_provider || 'local', bunnyVideoId: uid || null, uploadStatus: upload, processingStatus: processing, verification }));
}

function isLocalNotFound(err) {
  return Boolean(err) && (
    err.code === 'ENOENT' || err.code === 'NoSuchKey' || err.name === 'NoSuchKey'
  );
}

function isNotFound(err) {
  return isLocalNotFound(err) || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;
}

function localSourcePath(storageApi, key) {
  return path.join(storageApi.LOCAL_DIR, String(key));
}

async function readSource(storageApi, row, { metadataOnly = false, warn = console.warn } = {}) {
  const recordedProvider = row.storage_provider || 'local';
  if (recordedProvider === 'r2') {
    const source = metadataOnly
      ? await storageApi.headObject(row.stored_name)
      : await storageApi.getObject(row.stored_name);
    return { ...source, resolvedProvider: 'r2' };
  }

  const expectedPath = localSourcePath(storageApi, row.stored_name);
  try {
    const source = await storageApi.getLocalObject(row.stored_name);
    if (metadataOnly && source.body && typeof source.body.destroy === 'function') source.body.destroy();
    return { ...source, resolvedProvider: 'local' };
  } catch (localError) {
    // The cross-provider fallback is deliberately limited to a missing local
    // file. Permission, I/O, validation, and all other failures stay visible.
    if (!isLocalNotFound(localError)) throw localError;

    // storage_provider was introduced with DEFAULT 'local' even though the
    // production uploader already wrote every object to R2. Content Admin
    // uploads also explicitly recorded 'local' until Bunny-only uploads were
    // introduced. A legacy 'local' value therefore is not reliable evidence
    // that the bytes were ever written to Render's disk.
    if (!storageApi.isR2Configured()) {
      throw new Error(`Source is absent from local path "${expectedPath}" and R2 is not configured (${localError.code || localError.name}: ${localError.message}).`);
    }

    try {
      const source = metadataOnly
        ? await storageApi.headObject(row.stored_name)
        : await storageApi.getObject(row.stored_name);
      warn(JSON.stringify({
        resourceId: row.id,
        diagnostic: 'storage-provider-mismatch',
        recordedProvider,
        resolvedProvider: 'r2',
        attemptedLocalPath: expectedPath,
        r2Key: row.stored_name,
        localError: { code: localError.code || null, name: localError.name || null, message: localError.message }
      }));
      return { ...source, resolvedProvider: 'r2' };
    } catch (r2Error) {
      if (!isNotFound(r2Error)) throw r2Error;
      throw new Error(
        `Source is absent from both local path "${expectedPath}" and R2 key "${row.stored_name}" ` +
        `(local ${localError.code || localError.name}: ${localError.message}; R2 ${r2Error.code || r2Error.name}: ${r2Error.message}).`
      );
    }
  }
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
  if (!apply) {
    // A dry run performs metadata-only source verification. It opens no Bunny
    // upload, downloads no R2 object body, and changes neither files nor rows.
    const source = await readSource(storage, row, { metadataOnly: true });
    log(row, null, 'dry-run', 'not-started', `source-found:${source.resolvedProvider};bytes=${source.contentLength}`);
    return;
  }

  // Prefer the backend recorded on the row. Legacy `local` metadata is known
  // to be unreliable, though: the column's original DEFAULT and the old
  // Content Admin route labelled R2 uploads as local. If the local stat is a
  // genuine not-found, read the same key from R2; do not fall back for
  // permission, I/O, validation, or stream errors.
  const source = await readSource(storage, row);
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

async function main() {
  if (!bunny.isConfigured()) throw new Error(`Bunny is not configured: ${bunny.missingVars().join(', ')}`);
  const opened = openDatabase();
  db = opened.connection;
  try {
    const rows = db.prepare(`SELECT id,title,storage_provider,stored_name,file_name,stream_uid,stream_status FROM resources WHERE (stream_uid IS NOT NULL OR ((stored_name IS NOT NULL) AND (storage_provider IN ('local','r2') OR storage_provider IS NULL))) AND (mime_type LIKE 'video/%' OR lower(file_name) LIKE '%.mp4' OR lower(file_name) LIKE '%.webm' OR lower(file_name) LIKE '%.mov' OR lower(file_name) LIKE '%.m4v') ORDER BY id`).all();
    console.log(`${apply ? 'APPLY' : 'DRY-RUN'}: ${rows.length} legacy video(s); no source deletion is performed.`);
    for (const row of rows) {
      try { await migrate(row); } catch (e) { log(row, null, 'failed', 'not-committed', e.message); }
    }
  } finally {
    if (opened.owned) db.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`Migration aborted: ${e.message}`); process.exitCode = 1; });
}

module.exports = { isNotFound, readSource };
