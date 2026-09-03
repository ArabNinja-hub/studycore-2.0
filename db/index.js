const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const { seedProgramCatalog } = require('../lib/programs');
const { seedUniversityCatalog } = require('../lib/universities');
const { ROLES } = require('../lib/roles');

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
  -- Roles are stored and enforced in their canonical lower-case form.
  -- Legacy uppercase rows are normalized by upgradeUsersRoleSchema() below.
  role TEXT NOT NULL CHECK(role IN ('admin','student','content_admin')) DEFAULT 'student',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
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

-- University programs / student categories (Law, Business, SNR, Mines,
-- Non-Quota, SICT). A student picks exactly one at registration; that
-- program decides which courses and content they ever see.
CREATE TABLE IF NOT EXISTS programs (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  group_name TEXT,
  icon TEXT DEFAULT 'book-open',
  description TEXT,
  created_at TEXT NOT NULL
);

-- Global course catalog. One row per course CODE (CH110, MA110, ...); the
-- same code is attached to several programs through program_courses below.
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  icon TEXT DEFAULT 'book-open',
  subject TEXT,
  created_at TEXT NOT NULL
);

-- Program → Course (many-to-many). Mines and Non-Quota share CH110/MA110/
-- PH110/CS110/LA111, but E.D links only to SMMS and BI110 only to SMNS.
CREATE TABLE IF NOT EXISTS program_courses (
  program_code TEXT NOT NULL REFERENCES programs(code) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (program_code, course_id)
);
CREATE INDEX IF NOT EXISTS idx_program_courses_program ON program_courses(program_code);
CREATE INDEX IF NOT EXISTS idx_program_courses_course ON program_courses(course_id);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  subject TEXT,
  course TEXT,
  course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
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
  target_all INTEGER NOT NULL DEFAULT 1,
  publish_status TEXT NOT NULL DEFAULT 'published',
  -- Content Admin uploads stay in the same resource system as Main Admin
  -- uploads. These fields retain the individual uploader and the friendly
  -- resource-type choice without changing how students receive the content.
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  uploader_role TEXT,
  -- Snapshots retain attribution even if a Content Admin account is deleted;
  -- live views still join the active user row so profile-name changes show up.
  uploader_name TEXT,
  uploader_email TEXT,
  uploaded_at TEXT,
  resource_type TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Many-to-many targeting: which programs a resource/announcement reaches
-- when target_all = 0 (one or several specific programs).
CREATE TABLE IF NOT EXISTS resource_programs (
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  program_code TEXT NOT NULL REFERENCES programs(code) ON DELETE CASCADE,
  PRIMARY KEY (resource_id, program_code)
);
CREATE INDEX IF NOT EXISTS idx_resource_programs_resource ON resource_programs(resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_programs_program ON resource_programs(program_code);

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

CREATE TABLE IF NOT EXISTS announcement_reads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  announcement_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  UNIQUE(user_id, announcement_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_reads_user ON announcement_reads(user_id);
CREATE INDEX IF NOT EXISTS idx_announcement_reads_announcement ON announcement_reads(announcement_id);

CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category);
CREATE INDEX IF NOT EXISTS idx_resources_publish ON resources(publish_status);
CREATE INDEX IF NOT EXISTS idx_resources_uploaded_by ON resources(uploaded_by);
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
// Content Admin accounts can be revoked without deleting their upload
// history. Every auth middleware checks this database-backed flag.
try {
  db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
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

// Content attribution fields. `uploaded_by` already existed; these additions
// make the uploader's identity, role, date and chosen resource type explicit
// for both Content Admin "My Uploads" and Main Admin oversight.
try {
  db.exec('ALTER TABLE resources ADD COLUMN uploader_role TEXT');
} catch {
  // column already exists - fine
}
try {
  db.exec('ALTER TABLE resources ADD COLUMN uploader_name TEXT');
} catch {
  // column already exists - fine
}
try {
  db.exec('ALTER TABLE resources ADD COLUMN uploader_email TEXT');
} catch {
  // column already exists - fine
}
try {
  db.exec('ALTER TABLE resources ADD COLUMN uploaded_at TEXT');
} catch {
  // column already exists - fine
}
try {
  db.exec('ALTER TABLE resources ADD COLUMN resource_type TEXT');
} catch {
  // column already exists - fine
}

// ── Multi-program platform ──────────────────────────────────────────────
//
// Every piece of content (notes, videos, past papers, resources AND
// announcements) carries program targeting:
//   target_all = 1  -> visible to every program ("All Programs")
//   target_all = 0  -> visible only to the programs listed in
//                      resource_programs ("multiple programs").
// Course-bound content (course_id set) is additionally restricted to the
// programs that include that course — enforced server-side.
try {
  db.exec('ALTER TABLE resources ADD COLUMN course_id TEXT REFERENCES courses(id) ON DELETE SET NULL');
} catch {
  // column already exists - fine
}
try {
  db.exec('ALTER TABLE resources ADD COLUMN target_all INTEGER NOT NULL DEFAULT 1');
} catch {
  // column already exists - fine
}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_programs (
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      program_code TEXT NOT NULL REFERENCES programs(code) ON DELETE CASCADE,
      PRIMARY KEY (resource_id, program_code)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_resource_programs_resource ON resource_programs(resource_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_resource_programs_program ON resource_programs(program_code)');
} catch {
  // already exists - fine
}

// The student's program/category. Required at registration; enforced
// server-side on every content request. Never trusted from the client.
try {
  db.exec("ALTER TABLE users ADD COLUMN program_code TEXT REFERENCES programs(code) ON DELETE SET NULL");
} catch {
  // column already exists - fine
}

// Read status for announcements per user (persistent read/unread tracking)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcement_reads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      announcement_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      read_at TEXT NOT NULL,
      UNIQUE(user_id, announcement_id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_announcement_reads_user ON announcement_reads(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_announcement_reads_announcement ON announcement_reads(announcement_id)');
} catch {
  // already exists - fine
}

// Student profile pictures are stored in R2 like every other upload; the
// key (not a public URL) is kept here on the user row.
try {
  db.exec('ALTER TABLE users ADD COLUMN avatar_key TEXT');
} catch {
  // column already exists - fine
}

// SQLite cannot alter a CHECK constraint in place. Older StudyCore databases
// only allow ADMIN/STUDENT in users.role, or a previous lower()-based
// compatibility check, which would not strictly enforce the canonical values.
// Rebuild just the users table when either schema is detected, preserving every known user field and every child-table
// foreign-key relationship. New installations already have this schema and
// skip the migration entirely.
function upgradeUsersRoleSchema() {
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  const sql = String((current && current.sql) || '').toLowerCase().replace(/\s+/g, '');
  const hasCanonicalRoleCheck = sql.includes("check(rolein('admin','student','content_admin'))");
  if (hasCanonicalRoleCheck) return;

  let inTransaction = false;
  try {
    // This migration only runs during startup before requests are accepted.
    // Disabling FK enforcement while swapping the parent table keeps child
    // table definitions pointed at the final `users` table (SQLite updates
    // the self-reference when users_role_upgrade is renamed).
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    db.exec('DROP TABLE IF EXISTS users_role_upgrade');
    db.exec(`
      CREATE TABLE users_role_upgrade (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','student','content_admin')) DEFAULT 'student',
        is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
        school TEXT,
        grade TEXT,
        learning_level TEXT DEFAULT 'secondary',
        program_code TEXT REFERENCES programs(code) ON DELETE SET NULL,
        subscription TEXT NOT NULL DEFAULT 'trial',
        trial_end TEXT,
        subscription_start TEXT,
        subscription_end TEXT,
        referral_code TEXT UNIQUE,
        referred_by TEXT REFERENCES users_role_upgrade(id) ON DELETE SET NULL,
        avatar_key TEXT,
        created_at TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO users_role_upgrade (
        id, name, email, password, role, is_active, school, grade,
        learning_level, program_code, subscription, trial_end,
        subscription_start, subscription_end, referral_code, referred_by,
        avatar_key, created_at
      )
      SELECT
        id, name, email, password,
        CASE lower(role)
          WHEN 'admin' THEN 'admin'
          WHEN 'content_admin' THEN 'content_admin'
          ELSE 'student'
        END,
        CASE WHEN COALESCE(is_active, 1) = 0 THEN 0 ELSE 1 END,
        school, grade, learning_level, program_code, subscription, trial_end,
        subscription_start, subscription_end, referral_code, referred_by,
        avatar_key, created_at
      FROM users
    `);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_role_upgrade RENAME TO users');
    db.exec('COMMIT');
    inTransaction = false;
    console.log('StudyCore: upgraded users.role for Content Admin accounts.');
  } catch (err) {
    if (inTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    }
    console.error('StudyCore: could not upgrade the users role schema:', err.message);
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

upgradeUsersRoleSchema();

// Backfill attribution for uploads created before the Content Admin system.
// Existing timestamps remain the source of truth, and legacy categories get a
// useful human label without moving any resource or changing student access.
try {
  db.exec(`
    UPDATE resources
    SET uploaded_at = COALESCE(uploaded_at, created_at)
    WHERE uploaded_at IS NULL OR trim(uploaded_at) = ''
  `);
  db.exec(`
    UPDATE resources
    SET uploader_role = (
      SELECT lower(u.role) FROM users u WHERE u.id = resources.uploaded_by
    )
    WHERE (uploader_role IS NULL OR trim(uploader_role) = '')
      AND uploaded_by IS NOT NULL
  `);
  db.exec(`
    UPDATE resources
    SET uploader_name = (
      SELECT u.name FROM users u WHERE u.id = resources.uploaded_by
    )
    WHERE (uploader_name IS NULL OR trim(uploader_name) = '')
      AND uploaded_by IS NOT NULL
  `);
  db.exec(`
    UPDATE resources
    SET uploader_email = (
      SELECT u.email FROM users u WHERE u.id = resources.uploaded_by
    )
    WHERE (uploader_email IS NULL OR trim(uploader_email) = '')
      AND uploaded_by IS NOT NULL
  `);
  db.exec(`
    UPDATE resources
    SET resource_type = CASE category
      WHEN 'video' THEN 'Video'
      WHEN 'past_paper' THEN 'Past Paper'
      WHEN 'tutorial' THEN 'Study Guide'
      WHEN 'announcement' THEN 'Announcement'
      WHEN 'quiz' THEN 'Quiz'
      WHEN 'assignment' THEN 'Assignment'
      ELSE 'Document'
    END
    WHERE resource_type IS NULL OR trim(resource_type) = ''
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_resources_uploaded_by ON resources(uploaded_by)');
} catch (err) {
  // A pre-migration deployment may be starting for the first time with an
  // interrupted old schema. Keep startup explicit instead of silently losing
  // attribution data.
  console.warn('StudyCore: resource attribution migration failed:', err.message);
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

// Quizzes are stored as resources (category = 'quiz'); their questions live
// in resources.quiz_data and student attempts in quiz_attempts (both defined
// above). The on-site student community room was removed - quizzes replace it
// as the primary interactive, program-targeted student activity.

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

// ---------------------------------------------------------------------------
// Multi-university architecture (additive, idempotent)
//
//   University → School/Faculty → Programme → Year → Course → Topic → Lesson
//
// StudyCore was originally built around one institution's student categories
// (the `programs` table). Those programs are kept exactly as they are — every
// existing row, link and permission rule still works — but they now hang off
// a real university and faculty so a second institution can be added from the
// admin dashboard with no code change and no data migration.
// ---------------------------------------------------------------------------

// A course needs its own description (shown on the course page hero and in
// public course hubs). Nullable — an existing course simply shows none.
try {
  db.exec('ALTER TABLE courses ADD COLUMN description TEXT');
} catch {
  // column already exists - fine
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS universities (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      short_name TEXT,
      country TEXT,
      city TEXT,
      icon TEXT DEFAULT 'school',
      description TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
} catch {
  // already exists - fine
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS faculties (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      university_id TEXT REFERENCES universities(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      short_name TEXT,
      icon TEXT DEFAULT 'library',
      description TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(university_id, code)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_faculties_university ON faculties(university_id)');
} catch {
  // already exists - fine
}

// Link programs to their university + faculty. Both are nullable so an
// existing program keeps working before it is assigned, and the seeded
// catalog assigns them on first boot.
try {
  db.exec('ALTER TABLE programs ADD COLUMN university_id TEXT REFERENCES universities(id) ON DELETE SET NULL');
} catch {
  // column already exists - fine
}
try {
  db.exec('ALTER TABLE programs ADD COLUMN faculty_id TEXT REFERENCES faculties(id) ON DELETE SET NULL');
} catch {
  // column already exists - fine
}
try {
  db.exec('ALTER TABLE programs ADD COLUMN year_count INTEGER NOT NULL DEFAULT 1');
} catch {
  // column already exists - fine
}
// Which year of study a course is taught in, for a given program.
// "Year 1" / "Year 2" / ... — nullable so existing links stay unassigned.
try {
  db.exec('ALTER TABLE program_courses ADD COLUMN year_level TEXT');
} catch {
  // column already exists - fine
}

// Examination metadata for past papers, so students can filter by year and
// examination type (Test 1 / Test 2 / Sessional / Final Exam) instead of
// guessing from the title. Nullable: every pre-existing past paper keeps
// working and simply shows up under "All".
try {
  db.exec('ALTER TABLE resources ADD COLUMN exam_year INTEGER');
} catch {
  // column already exists - fine
}
try {
  db.exec('ALTER TABLE resources ADD COLUMN exam_type TEXT');
} catch {
  // column already exists - fine
}
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_resources_exam ON resources(category, exam_year, exam_type)');
} catch {
  // already exists - fine
}

// Per-student view history. Powers "Recently viewed" on the dashboard and
// "continue reading/watching" everywhere. Only resource ids the student was
// already authorized to open are ever recorded.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_views (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      viewed_at TEXT NOT NULL,
      UNIQUE(user_id, resource_id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_resource_views_user ON resource_views(user_id, viewed_at DESC)');
} catch {
  // already exists - fine
}

// Seed the six university programs, the global course catalog and the
// program→course assignments (Law, Business, SNR, Mines, Non-Quota, SICT).
// Idempotent — only inserts rows that do not yet exist, so admin-managed
// programs/courses survive every restart.
seedUniversityCatalog(db);
seedProgramCatalog(db);

function seedAdmin() {
  const existingAdmin = db.prepare(`SELECT id FROM users WHERE role = '${ROLES.ADMIN}' LIMIT 1`).get();
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
    VALUES (@id, @name, @email, @password, 'admin', 'premium', @now, @far, @now)
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
