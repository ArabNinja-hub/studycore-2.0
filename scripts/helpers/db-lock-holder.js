// Test helper: hold the SQLite write lock on argv[2] for argv[3] ms, then
// release. Runs as its own process so a synchronous test can block while the
// lock is genuinely held by someone else. Touches argv[4] once the lock is
// acquired, giving the parent a race-free readiness signal it can poll
// synchronously.
'use strict';
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const [, , dbFile, holdMs, readyFile] = process.argv;
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('BEGIN IMMEDIATE');
db.exec('CREATE TABLE IF NOT EXISTS lock_probe (a)');
db.exec('INSERT INTO lock_probe VALUES (1)');
fs.writeFileSync(readyFile, 'LOCKED');
setTimeout(() => { try { db.exec('COMMIT'); } catch {} process.exit(0); }, Number(holdMs) || 1200);
