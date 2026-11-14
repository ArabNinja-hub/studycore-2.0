// Automatic backups of the SQLite database to object storage (Cloudflare R2).
//
// Why this exists: every user, payment and progress record lives in one
// SQLite file on the host's disk. If that disk is lost, so is StudyCore. This
// module copies the database off the machine once on startup and once a day.
//
// How a backup is taken:
//   1. SQLite's online backup API (node:sqlite `backup()`) writes a consistent
//      snapshot to a temporary file. This is safe while the app is writing -
//      unlike copying the .sqlite file, which can capture a half-written page
//      and silently miss everything still sitting in the -wal file.
//   2. The snapshot is opened and `PRAGMA integrity_check` must say "ok". A
//      snapshot that fails the check is never uploaded.
//   3. It is gzip-compressed and streamed to storage under
//      db-backups/studycore-<UTC timestamp>.sqlite.gz
//   4. Old backups are pruned: the newest backup of each of the most recent
//      14 days is kept, everything else under db-backups/ is deleted.
//
// Backups never overwrite each other (every key carries a timestamp), and a
// failure here never affects the running app: runBackup() resolves to a
// result object and does not throw.
//
// Storage goes through lib/storage.js, so the same private R2 bucket and
// credentials are used and no new secret is needed. The db-backups/ folder is
// locked inside lib/storage.js: only this module (which passes
// { internal: true }) can read, write or delete there. Without R2 (local
// development, tests) the same code writes to DATA_DIR/uploads/db-backups,
// which is what lets the test suite exercise a real backup + restore.
//
// Restore: scripts/restore-db.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const sqlite = require('node:sqlite');
const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
const storage = require('./storage');
const { r2, bucketName } = require('./r2');

const PREFIX = 'db-backups/';
const KEY_PATTERN = /^db-backups\/studycore-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.sqlite\.gz$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;

function keepDays() {
  const n = Number.parseInt(process.env.DB_BACKUP_KEEP_DAYS, 10);
  return Number.isFinite(n) && n >= 1 ? n : 14;
}

function isEnabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.DB_BACKUP_ENABLED || '').trim());
}

function keyForDate(date) {
  // 2026-11-14T03:00:00.000Z -> db-backups/studycore-2026-11-14T03-00-00Z.sqlite.gz
  const stamp = date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${PREFIX}studycore-${stamp}.sqlite.gz`;
}

function parseKey(key) {
  const m = KEY_PATTERN.exec(key);
  if (!m) return null;
  return { key, day: m[1], takenAt: `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` };
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Every backup in storage, newest first. Files under db-backups/ that do not
// match the backup naming pattern are ignored (and therefore never deleted).
async function listBackups() {
  const found = [];
  if (storage.isR2Configured()) {
    let token;
    do {
      const page = await r2.send(new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: PREFIX,
        ContinuationToken: token
      }));
      for (const obj of page.Contents || []) {
        const parsed = parseKey(obj.Key);
        if (parsed) found.push({ ...parsed, size: obj.Size });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } else {
    const dir = path.join(storage.LOCAL_DIR, PREFIX);
    let names = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const name of names) {
      const parsed = parseKey(PREFIX + name);
      if (!parsed) continue;
      const st = await fs.promises.stat(path.join(dir, name));
      found.push({ ...parsed, size: st.size });
    }
  }
  // The timestamp format sorts chronologically as plain text.
  found.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return found;
}

// Decide what to keep: the newest backup of each of the `days` most recent
// days that have a backup. Pure function so the rule is easy to test.
function selectBackupsToDelete(backups, days) {
  const newestFirst = [...backups].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const keptDays = new Set();
  const remove = [];
  for (const b of newestFirst) {
    if (!keptDays.has(b.day) && keptDays.size < days) keptDays.add(b.day);
    else remove.push(b);
  }
  return remove;
}

async function pruneBackups(days = keepDays()) {
  const remove = selectBackupsToDelete(await listBackups(), days);
  for (const b of remove) await storage.deleteObject(b.key, { internal: true });
  return remove.map((b) => b.key);
}

// Throws unless the file at `file` is a healthy SQLite database.
function verifySnapshot(file) {
  const snap = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const row = snap.prepare('PRAGMA integrity_check').get();
    const verdict = row ? Object.values(row)[0] : 'no result';
    if (verdict !== 'ok') throw new Error(`integrity check failed: ${verdict}`);
  } finally {
    snap.close();
  }
}

let running = null;

// Take one backup now. Never throws: resolves to
//   { ok: true, key, bytes, durationMs, pruned } or { ok: false, error }.
// `reason` only labels the log line ("startup", "daily", "manual").
function runBackup({ reason = 'manual', db, now = new Date() } = {}) {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    let tmpDir;
    try {
      const source = db || require('../db');
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'studycore-backup-'));
      const snapshot = path.join(tmpDir, 'snapshot.sqlite');

      await sqlite.backup(source, snapshot);
      verifySnapshot(snapshot);

      const zipped = `${snapshot}.gz`;
      await pipeline(fs.createReadStream(snapshot), zlib.createGzip(), fs.createWriteStream(zipped));
      const bytes = (await fs.promises.stat(zipped)).size;

      const key = keyForDate(now);
      await storage.putObject({ key, body: fs.createReadStream(zipped), contentType: 'application/gzip', internal: true });

      console.log(
        `[db-backup] SUCCESS (${reason}): saved ${key} to ${storage.backendName()} ` +
        `(${formatBytes(bytes)}, ${Date.now() - started}ms)`
      );

      // Pruning is housekeeping: if it fails the backup itself is still good.
      let pruned = [];
      try {
        pruned = await pruneBackups();
        if (pruned.length) {
          console.log(`[db-backup] Removed ${pruned.length} old backup(s); keeping the last ${keepDays()} days.`);
        }
      } catch (err) {
        console.error(`[db-backup] WARNING: backup saved, but old backups could not be cleaned up: ${err.message}`);
      }

      return { ok: true, key, bytes, durationMs: Date.now() - started, pruned };
    } catch (err) {
      console.error(`[db-backup] FAILED (${reason}): the database was NOT backed up: ${err && err.message ? err.message : err}`);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    } finally {
      if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  const done = running;
  done.finally(() => { running = null; });
  return done;
}

// Download a backup and write the uncompressed, verified database to
// `destFile`. Used by scripts/restore-db.js. Throws on any problem.
async function downloadBackup(key, destFile) {
  if (!parseKey(key)) throw new Error(`Not a StudyCore backup name: ${key}`);
  const obj = await storage.getObject(key, undefined, { internal: true });
  await pipeline(obj.body, zlib.createGunzip(), fs.createWriteStream(destFile));
  verifySnapshot(destFile);
  return destFile;
}

// Start automatic backups: one shortly after startup, then one every 24h.
// Only called from the real server process (see server.js), never in tests.
function startScheduler() {
  if (!isEnabled()) {
    console.log('[db-backup] Automatic database backups are turned OFF (DB_BACKUP_ENABLED=false).');
    return null;
  }
  if (!storage.isR2Configured()) {
    console.log('[db-backup] Cloudflare R2 is not configured, so automatic database backups are not running.');
    return null;
  }
  console.log(`[db-backup] Automatic database backups are ON: at startup and every 24 hours, keeping the last ${keepDays()} days.`);
  const initial = setTimeout(() => { runBackup({ reason: 'startup' }); }, STARTUP_DELAY_MS);
  if (typeof initial.unref === 'function') initial.unref();
  const timer = setInterval(() => { runBackup({ reason: 'daily' }); }, DAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  PREFIX,
  keepDays,
  isEnabled,
  keyForDate,
  parseKey,
  listBackups,
  selectBackupsToDelete,
  pruneBackups,
  runBackup,
  downloadBackup,
  startScheduler
};
