const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

// On Render, set DATA_DIR to the mounted persistent disk's path (e.g.
// /var/data) in the Environment tab - this is what makes the database
// survive restarts and redeploys instead of being wiped every time. Locally,
// with no DATA_DIR set, it just uses a folder inside the project as before.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'studycore.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
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

CREATE TABLE IF NOT EXISTS resources (
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
  content_hash TEXT,
  external_url TEXT,
  quiz_data TEXT,
  due_date TEXT,
  is_premium INTEGER NOT NULL DEFAULT 1,
  publish_status TEXT NOT NULL DEFAULT 'published',
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lesson_progress (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL,
  UNIQUE(user_id, resource_id)
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lesson_progress_user ON lesson_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user ON quiz_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_resource ON quiz_attempts(resource_id);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, resource_id)
);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT,
  phone TEXT,
  amount REAL,
  status TEXT,
  reference TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category);
CREATE INDEX IF NOT EXISTS idx_resources_publish ON resources(publish_status);
CREATE INDEX IF NOT EXISTS idx_downloads_resource ON downloads(resource_id);
`);

// Lightweight migration: if this is an existing database created before
// content_hash existed, add the column. Safe to run every boot.
try {
  db.exec('ALTER TABLE resources ADD COLUMN content_hash TEXT');
} catch {
  // column already exists - fine
}
try {
  db.exec('ALTER TABLE users ADD COLUMN referral_code TEXT');
} catch {
  // column already exists - fine
}
try {
  db.exec('ALTER TABLE users ADD COLUMN referred_by TEXT');
} catch {
  // column already exists - fine
}
try {
  // Defaults to 1 (premium/subject to normal subscription rules) which
  // exactly matches how every resource already behaved before this column
  // existed - so existing deployments see zero change in access behavior
  // until an admin deliberately marks something as a free preview.
  db.exec('ALTER TABLE resources ADD COLUMN is_premium INTEGER NOT NULL DEFAULT 1');
} catch {
  // column already exists - fine
}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lesson_progress (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      completed_at TEXT NOT NULL,
      UNIQUE(user_id, resource_id)
    )
  `);
} catch {
  // already exists - fine
}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      score INTEGER NOT NULL,
      total INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
} catch {
  // already exists - fine
}
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_lesson_progress_user ON lesson_progress(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user ON quiz_attempts(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_quiz_attempts_resource ON quiz_attempts(resource_id)');
} catch {
  // already exist - fine
}

function generateReferralCode() {
  // Short, easy to read aloud/type on a phone - avoids ambiguous characters
  // like 0/O and 1/I/l.
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  let attempts = 0;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    attempts += 1;
  } while (db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code) && attempts < 20);
  return code;
}

const usersMissingCode = db.prepare('SELECT id FROM users WHERE referral_code IS NULL').all();
for (const user of usersMissingCode) {
  db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(generateReferralCode(), user.id);
}
try {
  db.exec('ALTER TABLE payments ADD COLUMN reference TEXT');
} catch {
  // column already exists - fine
}
try {
  db.exec('ALTER TABLE payments ADD COLUMN reviewed_at TEXT');
} catch {
  // column already exists - fine
}
try {
  db.exec('ALTER TABLE payments ADD COLUMN reviewed_by TEXT');
} catch {
  // column already exists - fine
}

function seedAdmin() {
  const existingAdmin = db.prepare(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`).get();
  if (existingAdmin) return;

  const email = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase().trim() : null;
  const password = process.env.ADMIN_PASSWORD || null;
  const name = process.env.ADMIN_NAME || 'Admin';

  // No hardcoded fallback credentials. If ADMIN_EMAIL / ADMIN_PASSWORD are not
  // set, no admin account is created - the operator must set them in .env
  // (see .env.example) or run `npm run make-admin -- someone@example.com`.
  if (!email || !password) {
    console.log('='.repeat(60));
    console.log('StudyCore: no admin account exists yet.');
    console.log('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env and restart,');
    console.log('or run: npm run make-admin -- someone@example.com "Full Name"');
    console.log('='.repeat(60));
    return;
  }

  const hashed = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, subscription, subscription_start, subscription_end, created_at)
    VALUES (@id, @name, @email, @password, 'ADMIN', 'premium', @now, @far, @now)
  `).run({
    id: `admin-${Date.now()}`,
    name,
    email,
    password: hashed,
    now,
    far: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString()
  });

  console.log('='.repeat(60));
  console.log(`StudyCore: seeded admin account -> ${email}`);
  console.log('Log in and change this password immediately.');
  console.log('='.repeat(60));
}

seedAdmin();

db.generateReferralCode = generateReferralCode;

module.exports = db;
