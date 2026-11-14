// =============================================================================
// StudyCore — database backup + restore
// -----------------------------------------------------------------------------
// Exercises lib/db-backup.js and scripts/restore-db.js end to end against a
// temporary database and the local object store (no R2, nothing real touched):
//   · a backup taken while the database is open is a healthy, complete copy
//   · retention keeps the newest backup of each of the last 14 days
//   · a failed backup is reported, never thrown
//   · the restore script really brings deleted data back, keeps the previous
//     database aside, and changes nothing without --yes
//
// Run: node --test scripts/test-db-backup.js
// =============================================================================

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-backup-test-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  JWT_SECRET: 'test-only-studycore-jwt-secret-0123456789',
  CONTENT_ADMIN_ACCESS_CODE: 'test-only-content-admin-access-code',
  ADMIN_EMAIL: '',
  ADMIN_PASSWORD: '',
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET_NAME: '',
  DB_BACKUP_ENABLED: '',
  DB_BACKUP_KEEP_DAYS: ''
});

const REPO_ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(dataDir, 'studycore.sqlite');
const db = require('../db');
const storage = require('../lib/storage');
const backup = require('../lib/db-backup');
const backupDir = path.join(storage.LOCAL_DIR, 'db-backups');

let dbOpen = true;
test.after(() => {
  if (dbOpen) db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function quiet(fn) {
  const { log, error } = console;
  const lines = [];
  console.log = (...a) => lines.push(['log', a.join(' ')]);
  console.error = (...a) => lines.push(['error', a.join(' ')]);
  return Promise.resolve().then(fn).finally(() => { console.log = log; console.error = error; }).then((r) => ({ result: r, lines }));
}

function addStudent(email) {
  db.prepare("INSERT INTO users (id, name, email, password, role, created_at) VALUES (?, ?, ?, 'x', 'student', '2026-11-10T00:00:00.000Z')")
    .run(`id-${email}`, 'Backup Test', email);
}

function restoreScript(...args) {
  return execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'restore-db.js'), ...args], {
    cwd: REPO_ROOT, env: process.env, encoding: 'utf8'
  });
}

test('a backup taken from the live database is a complete, healthy copy', async () => {
  addStudent('kept@backup.test');
  const { result, lines } = await quiet(() => backup.runBackup({ reason: 'test', db, now: new Date('2026-11-10T03:00:00Z') }));

  assert.equal(result.ok, true);
  assert.equal(result.key, 'db-backups/studycore-2026-11-10T03-00-00Z.sqlite.gz');
  assert.ok(lines.some(([level, l]) => level === 'log' && /\[db-backup\] SUCCESS/.test(l) && l.includes(result.key)),
    'success is logged with the backup name');

  const listed = await backup.listBackups();
  assert.deepEqual(listed.map((b) => b.key), [result.key]);

  // Unzip it by hand and read it as a database: the row must be there.
  const copy = path.join(dataDir, 'manual-check.sqlite');
  fs.writeFileSync(copy, zlib.gunzipSync(fs.readFileSync(path.join(backupDir, path.basename(result.key)))));
  const snap = new DatabaseSync(copy, { readOnly: true });
  assert.equal(Object.values(snap.prepare('PRAGMA integrity_check').get())[0], 'ok');
  assert.equal(snap.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'kept@backup.test'").get().n, 1);
  snap.close();
});

test('retention keeps the newest backup of each of the last 14 days', async () => {
  const fake = [];
  for (let d = 1; d <= 20; d += 1) {
    const day = `2026-10-${String(d).padStart(2, '0')}`;
    fake.push({ key: `db-backups/studycore-${day}T03-00-00Z.sqlite.gz`, day });
  }
  // Two extra backups on the newest day (restarts): only the latest survives.
  fake.push({ key: 'db-backups/studycore-2026-10-20T09-00-00Z.sqlite.gz', day: '2026-10-20' });
  fake.push({ key: 'db-backups/studycore-2026-10-20T18-30-00Z.sqlite.gz', day: '2026-10-20' });

  const remove = backup.selectBackupsToDelete(fake, 14).map((b) => b.key);
  const kept = fake.map((b) => b.key).filter((k) => !remove.includes(k)).sort();

  assert.equal(kept.length, 14);
  assert.equal(kept[0], 'db-backups/studycore-2026-10-07T03-00-00Z.sqlite.gz');
  assert.equal(kept[13], 'db-backups/studycore-2026-10-20T18-30-00Z.sqlite.gz');
  assert.ok(remove.includes('db-backups/studycore-2026-10-06T03-00-00Z.sqlite.gz'));
  assert.ok(remove.includes('db-backups/studycore-2026-10-20T03-00-00Z.sqlite.gz'));
});

test('old backups are really deleted from storage; unrelated files are left alone', async () => {
  for (let d = 1; d <= 16; d += 1) {
    fs.writeFileSync(path.join(backupDir, `studycore-2026-09-${String(d).padStart(2, '0')}T03-00-00Z.sqlite.gz`), 'old');
  }
  fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'not a backup');

  // Real backup (2026-11-10) + 16 old days = 17 days -> 3 oldest go.
  const removed = await backup.pruneBackups(14);
  assert.deepEqual(removed.sort(), [
    'db-backups/studycore-2026-09-01T03-00-00Z.sqlite.gz',
    'db-backups/studycore-2026-09-02T03-00-00Z.sqlite.gz',
    'db-backups/studycore-2026-09-03T03-00-00Z.sqlite.gz'
  ]);
  const left = await backup.listBackups();
  assert.equal(left.length, 14);
  assert.equal(left[0].key, 'db-backups/studycore-2026-11-10T03-00-00Z.sqlite.gz');
  assert.ok(fs.existsSync(path.join(backupDir, 'notes.txt')));

  // Leave only the real backup for the restore tests below.
  for (const b of left.slice(1)) await storage.deleteObject(b.key, { internal: true });
});

test('a failing backup is logged as FAILED and never throws', async () => {
  const closed = new DatabaseSync(':memory:');
  closed.close();
  const { result, lines } = await quiet(() => backup.runBackup({ reason: 'test', db: closed }));
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.ok(lines.some(([level, l]) => level === 'error' && /\[db-backup\] FAILED/.test(l)));
  assert.equal((await backup.listBackups()).length, 1, 'no broken backup was stored');
});

test('the restore script changes nothing without --yes', () => {
  const before = fs.statSync(DB_FILE).ino;
  const out = restoreScript('--latest');
  assert.match(out, /Nothing was changed/);
  assert.equal(fs.statSync(DB_FILE).ino, before);
  assert.match(restoreScript('--list'), /studycore-2026-11-10T03-00-00Z\.sqlite\.gz/);
});

test('restoring brings back data that was lost after the backup', () => {
  // Disaster: the student that was backed up is deleted, another is added.
  db.prepare("DELETE FROM users WHERE email = 'kept@backup.test'").run();
  addStudent('after@backup.test');
  db.close();
  dbOpen = false;

  const out = restoreScript('studycore-2026-11-10T03-00-00Z.sqlite.gz', '--yes');
  assert.match(out, /RESTORE COMPLETE/);

  const restored = new DatabaseSync(DB_FILE);
  assert.equal(Object.values(restored.prepare('PRAGMA integrity_check').get())[0], 'ok');
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'kept@backup.test'").get().n, 1,
    'the deleted student is back');
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'after@backup.test'").get().n, 0,
    'the database is exactly as it was at backup time');
  restored.close();

  // The pre-restore database is kept, so a restore can be undone.
  const aside = fs.readdirSync(dataDir).filter((f) => /^studycore\.sqlite\.before-restore-[^.]*Z$/.test(f));
  assert.equal(aside.length, 1);
  const old = new DatabaseSync(path.join(dataDir, aside[0]));
  assert.equal(old.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'after@backup.test'").get().n, 1);
  old.close();
  assert.ok(!fs.existsSync(`${DB_FILE}.restoring`));
});

test('the restored database boots the real app code', () => {
  const out = execFileSync(process.execPath, ['-e',
    "const db=require('./db');process.stdout.write('N='+db.prepare(\"SELECT COUNT(*) AS n FROM users WHERE email='kept@backup.test'\").get().n)"
  ], { cwd: REPO_ROOT, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(out, /N=1/);
});

test('an unknown backup name is refused and nothing is replaced', () => {
  const before = fs.statSync(DB_FILE).ino;
  assert.throws(() => execFileSync(process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'restore-db.js'), 'studycore-1999-01-01T00-00-00Z.sqlite.gz', '--yes'],
    { cwd: REPO_ROOT, env: process.env, encoding: 'utf8', stdio: 'pipe' }));
  assert.equal(fs.statSync(DB_FILE).ino, before);
});
