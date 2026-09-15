// =============================================================================
// StudyCore — regression tests for concurrent database writers
// -----------------------------------------------------------------------------
// The app database is opened by more than one process in normal operation: the
// running server, plus every maintenance script (make-admin, seed-documents,
// list-drive-linked-resources, ...) that the README tells operators to run
// against a live deployment.
//
// WAL mode allows concurrent readers with one writer, but a second *writer*
// must wait for the write lock. node:sqlite's default busy_timeout is 0, which
// turns "wait" into "fail instantly with `database is locked`".
//
// Two consequences, both reproduced below:
//   1. A maintenance script run while the server happens to be writing dies —
//      often at require() time, inside db/index.js's boot migrations.
//   2. Far worse: those boot migrations are wrapped in bare `catch {}` because
//      "duplicate column" is their expected failure. A lock-induced failure is
//      swallowed by the same catch, so a schema migration is silently skipped
//      and the process continues against a half-migrated database.
//
// Run: node scripts/test-db-concurrency.js
// =============================================================================

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO_ROOT = path.join(__dirname, '..');

// The busy_timeout the shared db module actually configures. Read from a real
// child process so the tests below exercise the app's true setting rather than
// a value hardcoded in the test.
function appBusyTimeout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-busy-probe-'));
  const out = execFileSync(
    process.execPath,
    ['-e', "const db=require('./db');process.stdout.write('BUSY_TIMEOUT=' + db.prepare('PRAGMA busy_timeout').get().timeout)"],
    { cwd: REPO_ROOT, env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const match = /BUSY_TIMEOUT=(\d+)/.exec(out);
  assert.ok(match, `could not read busy_timeout from db module output: ${out.trim()}`);
  return Number(match[1]);
}

function holdWriteLockFor(dbFile, ms) {
  const readyFile = `${dbFile}.locked`;
  try { fs.unlinkSync(readyFile); } catch { /* not there */ }
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'helpers', 'db-lock-holder.js'), dbFile, String(ms), readyFile],
    { stdio: 'ignore' }
  );
  // Synchronously poll for the readiness file. A sync spin is required: these
  // tests drive the contending writer with execFileSync, which blocks this
  // event loop entirely, so nothing async could observe readiness.
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(readyFile) && Date.now() < deadline) {
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},25)'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  assert.ok(fs.existsSync(readyFile), 'lock holder process failed to acquire the write lock');
  return child;
}

// ---------------------------------------------------------------------------
// 1. The shared db module must configure a non-zero busy timeout.
//    This is the property the two behavioural tests below depend on.
// ---------------------------------------------------------------------------
test('db module sets a non-zero busy_timeout', () => {
  const timeout = appBusyTimeout();
  assert.ok(
    timeout > 0,
    `expected a positive busy_timeout so a contended write waits instead of throwing, got ${timeout}`
  );
});

// ---------------------------------------------------------------------------
// 2. Loading the db module while another writer holds the lock must not throw.
//    Without busy_timeout this dies inside seedProgramCatalog at require time.
// ---------------------------------------------------------------------------
test('a maintenance script can load db/ while another process is writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-busy-b-'));
  // Materialise the schema first, exactly as a real deployment would have.
  execFileSync(process.execPath, ['-e', "require('./db')"], {
    cwd: REPO_ROOT, env: { ...process.env, DATA_DIR: dir }, stdio: 'ignore'
  });

  // Hold the lock for ~1.2s: inside the busy_timeout window, so a patient
  // writer succeeds and an impatient one fails immediately.
  const holder = holdWriteLockFor(path.join(dir, 'studycore.sqlite'), 1200);

  try {
    // A make-admin-style write, issued while the lock is held.
    execFileSync(
      process.execPath,
      ['-e', "const db=require('./db');db.prepare(\"UPDATE users SET role='admin' WHERE email=?\").run('nobody@example.com')"],
      { cwd: REPO_ROOT, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 }
    );
  } catch (err) {
    const detail = (err.stderr && err.stderr.toString()) || err.message;
    throw new Error(`maintenance script failed against a busy database: ${detail.split('\n').slice(0, 3).join(' | ')}`);
  } finally {
    try { holder.kill(); } catch { /* already exited */ }
  }
});

// ---------------------------------------------------------------------------
// 3. The silent-corruption case. db/index.js runs ALTER TABLE migrations inside
//    bare `catch {}` blocks (a duplicate column is the expected error). Prove a
//    lock no longer masquerades as "already applied": with a busy timeout the
//    ALTER waits and actually lands.
// ---------------------------------------------------------------------------
test('a boot-style ALTER migration is not silently skipped by a lock', () => {
  const busyTimeout = appBusyTimeout();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-busy-c-'));
  const dbFile = path.join(dir, 'mig.sqlite');

  const setup = new DatabaseSync(dbFile);
  setup.exec('PRAGMA journal_mode = WAL');
  setup.exec('CREATE TABLE resources (id TEXT PRIMARY KEY)');
  setup.close();

  const holder = holdWriteLockFor(dbFile, 1200);

  // Mimic db/index.js exactly: same PRAGMAs — including the busy_timeout the
  // real module configures — and the same swallow-the-error migration shape.
  // Using the app's actual value (not a hardcoded one) is what makes this test
  // fail when the fix is reverted.
  const migrator = new DatabaseSync(dbFile);
  migrator.exec('PRAGMA journal_mode = WAL');
  migrator.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  try {
    migrator.exec('ALTER TABLE resources ADD COLUMN content_hash TEXT');
  } catch {
    // "column already exists" — indistinguishable from "database is locked".
  }

  try { holder.kill(); } catch { /* already exited */ }

  const columns = migrator.prepare('PRAGMA table_info(resources)').all().map((c) => c.name);
  migrator.close();

  assert.ok(
    columns.includes('content_hash'),
    'the ALTER TABLE migration was swallowed by the lock and the column is missing — ' +
    'the database would be left half-migrated with no error reported'
  );
});

