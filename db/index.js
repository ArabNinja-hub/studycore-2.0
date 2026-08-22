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

// Course structure: every resource can belong to a named topic inside its
// subject (e.g. Physics > Circular Motion > "Centripetal Force"). Topics are
// free-text labels chosen by the admin at upload time - the course page
// groups and orders lessons by topic, falling back to a single "General"
// group for content that has no topic set. Safe to run every boot.
try {
  db.exec('ALTER TABLE resources ADD COLUMN topic TEXT');
} catch {
  // column already exists - fine
}

// Announcements can be pinned to the top of the announcement centre.
try {
  db.exec('ALTER TABLE resources ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
} catch {
  // column already exists - fine
}

// Student profile pictures are stored in R2 like every other upload; the
// key (not a public URL) is kept here on the user row.
try {
  db.exec('ALTER TABLE users ADD COLUMN avatar_key TEXT');
} catch {
  // column already exists - fine
}

// Video playback position, per student per lesson - powers "resume where you
// left off" and the 90%-watched completion signal. Only written server-side
// for authorized (Premium) playback, never trusted from arbitrary state.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_progress (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      position REAL NOT NULL DEFAULT 0,
      duration REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, resource_id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_video_progress_user ON video_progress(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_video_progress_resource ON video_progress(resource_id)');
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

function migrateBareUuidDocuments() {
  try {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rows = db.prepare(`SELECT id, file_name, stored_name, mime_type, file_size FROM resources WHERE file_name IS NOT NULL`).all();
    let fixed = 0;
    for (const r of rows) {
      const fn = String(r.file_name || '').trim();
      if (!uuidRe.test(fn)) continue;
      // Bare UUID as file_name — this is the bug reported as
      // "open with 9735a310-...". Fix mime and ensure stored file has .pdf
      // extension on local disk so future HEAD probes work.
      const needsMimeFix = !r.mime_type || r.mime_type === 'application/octet-stream' || r.mime_type === 'binary/octet-stream';
      if (needsMimeFix) {
        try {
          db.prepare(`UPDATE resources SET mime_type = 'application/pdf', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), r.id);
          fixed += 1;
        } catch { /* ignore */ }
      }
      // If stored_name is also bare UUID without extension, try to rename
      // the local file to have .pdf extension if it exists on disk.
      if (r.stored_name && uuidRe.test(String(r.stored_name).trim())) {
        try {
          const localDir = path.join(DATA_DIR, 'uploads');
          const oldPath = path.join(localDir, r.stored_name);
          const newKey = r.stored_name + '.pdf';
          const newPath = path.join(localDir, newKey);
          if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
            fs.renameSync(oldPath, newPath);
            db.prepare(`UPDATE resources SET stored_name = ?, updated_at = ? WHERE id = ?`).run(newKey, new Date().toISOString(), r.id);
            fixed += 1;
          }
        } catch { /* ignore — R2 backend or missing file */ }
      }
    }
    if (fixed > 0) {
      console.log(`StudyCore: fixed ${fixed} bare-UUID document records (open with <uuid> bug).`);
    }
  } catch (e) {
    console.warn('StudyCore: bare-UUID migration failed', e.message);
  }
}

migrateBareUuidDocuments();

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

// The referral-code backfill above runs before seedAdmin() on the very first
// boot, so the freshly-created admin (and any account inserted by scripts
// that predate the column) can still have a NULL referral_code until the
// next restart. Fill them in now so /api/auth/referral and the dashboard's
// "share your link" always have a real code on first boot.
const stillMissingCode = db.prepare('SELECT id FROM users WHERE referral_code IS NULL').all();
for (const user of stillMissingCode) {
  db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(generateReferralCode(), user.id);
}

db.generateReferralCode = generateReferralCode;

module.exports = db;
