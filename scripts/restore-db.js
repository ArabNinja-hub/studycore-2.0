#!/usr/bin/env node
// Restore the StudyCore database from a backup made by lib/db-backup.js.
//
//   node scripts/restore-db.js --list             show the available backups
//   node scripts/restore-db.js --latest --yes     restore the newest backup
//   node scripts/restore-db.js <backup-name> --yes  restore one specific backup
//   node scripts/restore-db.js --backup-now       take a fresh backup right now
//
// (also available as: npm run restore-db -- --list)
//
// What a restore does, in order:
//   1. downloads the chosen backup and checks it is a healthy database
//      BEFORE touching anything;
//   2. moves the current database aside as
//      studycore.sqlite.before-restore-<time> (it is never deleted, so a
//      restore can itself be undone);
//   3. puts the backup in its place.
//
// After restoring you MUST restart the app (on Render: Manual Deploy ->
// "Restart service"). Until it restarts, the running app keeps using the old
// data, and anything it saves in that gap is not part of the restored
// database.
//
// Without --yes nothing is changed: the script only reports what it would do.
//
// This script deliberately does not load db/index.js - opening the live
// database here would create new -wal/-shm files next to the restored one.

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'studycore.sqlite');

function fmtSize(n) {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const named = args.find((a) => !a.startsWith('--'));
  const backup = require('../lib/db-backup');
  const storage = require('../lib/storage');

  if (flags.has('--backup-now')) {
    const result = await backup.runBackup({ reason: 'manual', db: require('../db') });
    return result.ok ? 0 : 1;
  }

  const backups = await backup.listBackups();
  console.log(`Backup storage: ${storage.backendName() === 'r2' ? 'Cloudflare R2' : 'local disk (R2 not configured)'}`);

  if (flags.has('--list') || (!named && !flags.has('--latest'))) {
    if (!backups.length) {
      console.log('No backups found.');
    } else {
      console.log(`${backups.length} backup(s), newest first:`);
      for (const b of backups) console.log(`  ${b.key}   ${b.takenAt}   ${fmtSize(b.size)}`);
      console.log('\nTo restore the newest:   node scripts/restore-db.js --latest --yes');
      console.log('To restore a specific:   node scripts/restore-db.js <backup-name> --yes');
    }
    return 0;
  }

  let chosen;
  if (named) {
    const wanted = named.startsWith(backup.PREFIX) ? named : backup.PREFIX + named;
    chosen = backups.find((b) => b.key === wanted);
    if (!chosen) {
      console.error(`Backup not found: ${named}\nRun with --list to see what is available.`);
      return 1;
    }
  } else {
    chosen = backups[0];
    if (!chosen) {
      console.error('No backups found - nothing to restore.');
      return 1;
    }
  }

  console.log(`Chosen backup: ${chosen.key} (taken ${chosen.takenAt}, ${fmtSize(chosen.size)})`);
  console.log(`Database file: ${DB_FILE}`);

  if (!flags.has('--yes')) {
    console.log('\nNothing was changed. Add --yes to actually restore this backup.');
    return 0;
  }

  // 1. Download + verify next to the live file (same disk, so the final
  //    rename is instant and cannot leave a half-written database behind).
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const incoming = `${DB_FILE}.restoring`;
  for (const f of [incoming, `${incoming}-wal`, `${incoming}-shm`]) fs.rmSync(f, { force: true });
  await backup.downloadBackup(chosen.key, incoming);
  for (const f of [`${incoming}-wal`, `${incoming}-shm`]) fs.rmSync(f, { force: true });
  console.log('Backup downloaded and passed its integrity check.');

  // 2. Move the current database (and its WAL side files) out of the way.
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  if (fs.existsSync(DB_FILE)) {
    const aside = `${DB_FILE}.before-restore-${stamp}`;
    fs.renameSync(DB_FILE, aside);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(DB_FILE + ext)) fs.renameSync(DB_FILE + ext, aside + ext);
    }
    console.log(`Previous database kept as: ${aside}`);
  }

  // 3. Put the backup in place.
  fs.renameSync(incoming, DB_FILE);
  console.log(`\nRESTORE COMPLETE: ${chosen.key} is now the live database file.`);
  console.log('NOW RESTART THE APP so it starts using the restored data.');
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(`RESTORE FAILED: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
);
