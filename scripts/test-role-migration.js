'use strict';

// Regression coverage for real deployments created before Content Admins
// existed. It starts from the former uppercase-only users.role CHECK, then
// loads the current database bootstrap and verifies both data preservation and
// strict canonical roles afterwards.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-role-migration-'));
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD;

let upgradedDb = null;

test('legacy uppercase users migrate safely to canonical Content Admin roles', { concurrency: false }, () => {
  const filename = path.join(dataDir, 'studycore.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec('PRAGMA foreign_keys = ON');
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN','STUDENT')) DEFAULT 'STUDENT',
      school TEXT,
      grade TEXT,
      learning_level TEXT DEFAULT 'secondary',
      subscription TEXT NOT NULL DEFAULT 'trial',
      trial_end TEXT,
      subscription_start TEXT,
      subscription_end TEXT,
      referral_code TEXT UNIQUE,
      referred_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE resources (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      subject TEXT,
      course TEXT,
      year_level TEXT,
      semester TEXT,
      tags TEXT,
      file_name TEXT,
      stored_name TEXT,
      file_size INTEGER,
      mime_type TEXT,
      external_url TEXT,
      quiz_data TEXT,
      due_date TEXT,
      target_all INTEGER NOT NULL DEFAULT 1,
      publish_status TEXT NOT NULL DEFAULT 'published',
      uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      download_count INTEGER NOT NULL DEFAULT 0,
      view_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE lesson_progress (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      completed_at TEXT NOT NULL
    );
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  legacy.prepare('INSERT INTO users (id, name, email, password, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('legacy-admin', 'Legacy Admin', 'legacy-admin@test.studycore', 'hash', 'ADMIN', now);
  legacy.prepare('INSERT INTO users (id, name, email, password, role, referred_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('legacy-student', 'Legacy Student', 'legacy-student@test.studycore', 'hash', 'STUDENT', 'legacy-admin', now);
  legacy.prepare('INSERT INTO resources (id, title, category, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('legacy-resource', 'Legacy resource', 'document', 'legacy-student', now, now);
  legacy.prepare('INSERT INTO lesson_progress (id, user_id, resource_id, completed_at) VALUES (?, ?, ?, ?)')
    .run('legacy-progress', 'legacy-student', 'legacy-resource', now);
  legacy.close();

  // Requiring the bootstrap performs the actual production migration.
  upgradedDb = require('../db');
  const users = upgradedDb.prepare('SELECT id, role, is_active, referred_by FROM users WHERE id LIKE \'legacy-%\' ORDER BY id').all()
    .map((user) => ({ ...user }));
  assert.deepEqual(users, [
    { id: 'legacy-admin', role: 'admin', is_active: 1, referred_by: null },
    { id: 'legacy-student', role: 'student', is_active: 1, referred_by: 'legacy-admin' }
  ]);
  assert.equal(upgradedDb.prepare('SELECT COUNT(*) AS count FROM lesson_progress WHERE id = ?').get('legacy-progress').count, 1);

  const resource = { ...upgradedDb.prepare(`
    SELECT uploaded_by, uploader_role, uploader_name, uploader_email, uploaded_at, resource_type
    FROM resources WHERE id = 'legacy-resource'
  `).get() };
  assert.deepEqual(resource, {
    uploaded_by: 'legacy-student',
    uploader_role: 'student',
    uploader_name: 'Legacy Student',
    uploader_email: 'legacy-student@test.studycore',
    uploaded_at: now,
    resource_type: 'Document'
  });

  const schema = upgradedDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().sql
    .toLowerCase().replace(/\s+/g, '');
  assert.ok(schema.includes("check(rolein('admin','student','content_admin'))"));
  assert.deepEqual(upgradedDb.prepare('PRAGMA foreign_key_check').all(), []);

  upgradedDb.prepare(`
    INSERT INTO users (id, name, email, password, role, subscription, created_at)
    VALUES ('migrated-content-admin', 'Migrated Content Admin', 'migrated-content-admin@test.studycore', 'hash', 'content_admin', 'none', ?)
  `).run(now);
  assert.equal(upgradedDb.prepare('SELECT role FROM users WHERE id = ?').get('migrated-content-admin').role, 'content_admin');
  assert.throws(() => {
    upgradedDb.prepare(`
      INSERT INTO users (id, name, email, password, role, subscription, created_at)
      VALUES ('invalid-uppercase-role', 'Invalid', 'invalid-uppercase-role@test.studycore', 'hash', 'ADMIN', 'none', ?)
    `).run(now);
  }, /check constraint/i);

  // Existing resource ownership is cleared by the original FK on account
  // deletion, while the migration's uploader snapshot retains audit context.
  upgradedDb.prepare('DELETE FROM users WHERE id = ?').run('legacy-student');
  assert.deepEqual({ ...upgradedDb.prepare('SELECT uploaded_by, uploader_name, uploader_role FROM resources WHERE id = ?').get('legacy-resource') }, {
    uploaded_by: null,
    uploader_name: 'Legacy Student',
    uploader_role: 'student'
  });
  assert.deepEqual(upgradedDb.prepare('PRAGMA foreign_key_check').all(), []);
});

test.after(() => {
  if (upgradedDb) upgradedDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
