// =============================================
// STUDYCORE — Multi-program platform core
// -----------------------------------------------
// Single source of truth for the university
// program/category model:
//
//   StudyCore → Program → Course → Topics →
//   Notes / Videos / Past Papers / Resources /
//   Announcements
//
// A student's program (users.program_code)
// decides which courses and content they see.
// School of Mines (SMMS) and Non-Quota (SMNS)
// are stored as SEPARATE student categories
// even though they share a general academic
// platform: their course lists differ
// (E.D vs BI110).
//
// All program and course rows live in the
// database; the catalog below only SEEDS the
// database on first boot. After that the admin
// dashboard manages programs and courses
// without any code changes.
// =============================================

const PROGRAM_CATALOG = [
  {
    code: 'LAW',
    name: 'Law',
    shortName: 'Law',
    groupName: null,
    icon: 'shield',
    description: 'Faculty of Law — constitutional, contract, tort and human-rights law.'
  },
  {
    code: 'BS',
    name: 'Business Studies',
    shortName: 'Business',
    groupName: null,
    icon: 'wallet',
    description: 'Business, management, accounting and entrepreneurship. Courses are added by the admin.'
  },
  {
    code: 'SNR',
    name: 'School of Natural Resources',
    shortName: 'SNR',
    groupName: null,
    icon: 'leaf',
    description: 'School of Natural Resources — biology, physics, chemistry, mathematics and communication.'
  },
  {
    code: 'SMMS',
    name: 'School of Mines',
    shortName: 'Mines',
    // Mines and Non-Quota share the same general academic platform and are
    // visually grouped together, but they remain SEPARATE categories.
    groupName: 'School of Mines / Non-Quota',
    icon: 'shapes',
    description: 'School of Mines — chemistry, mathematics, physics, computer science, communication and engineering drawing.'
  },
  {
    code: 'SMNS',
    name: 'Non-Quota',
    shortName: 'Non-Quota',
    groupName: 'School of Mines / Non-Quota',
    icon: 'shapes',
    description: 'Non-Quota — shared foundation sciences plus biology.'
  },
  {
    code: 'SICT',
    name: 'Computer Science / SICT',
    shortName: 'SICT',
    groupName: null,
    icon: 'code',
    description: 'School of Information and Communication Technology — computer science, mathematics and physics.'
  }
];

// Every seed course is GLOBAL (one row keyed by code) and attached to the
// programs that teach it. The same code can legitimately belong to several
// programs (MA110, PH110, ...) — that sharing is the entire point of the
// program_courses join table.
//
// `subject` mirrors the legacy subjects table so seeded content also appears
// on the legacy subject pages; it is best-effort metadata only.
const COURSE_CATALOG = [
  // ---- Law ----
  { code: 'LS100', name: 'Constitutional, Administrative and Local Government Law', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS110', name: 'Law of Contract', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS120', name: 'Law of Torts', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS131', name: 'Legal Context Skills & Ethics', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS141', name: 'Human Rights and Civil Liberties', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS151', name: 'Equity, Trusts & Wills', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS161', name: 'Remedies in Private Law', subject: null, icon: 'book-open', programs: ['LAW'] },

  // ---- Shared Mines / Non-Quota foundation ----
  { code: 'CH110', name: 'Chemistry', subject: 'Chemistry', icon: 'flask', programs: ['SMMS', 'SMNS'] },
  { code: 'MA110', name: 'Mathematics', subject: 'Mathematics', icon: 'calculator', programs: ['SMMS', 'SMNS', 'SICT', 'SNR'] },
  { code: 'PH110', name: 'Physics', subject: 'Physics', icon: 'atom', programs: ['SMMS', 'SMNS', 'SICT', 'SNR'] },
  { code: 'CS110', name: 'Computer Science', subject: 'Programming', icon: 'code', programs: ['SMMS', 'SMNS'] },
  { code: 'LA111', name: 'Communication Skills', subject: 'Communication Skills', icon: 'message', programs: ['SMMS', 'SMNS'] },

  // ---- School of Mines ONLY ----
  { code: 'ED', name: 'Engineering Drawing', subject: null, icon: 'ruler', programs: ['SMMS'] },

  // ---- Non-Quota ONLY ----
  { code: 'BI110', name: 'Biology', subject: 'Biology', icon: 'dna', programs: ['SMNS'] },

  // ---- SICT ----
  { code: 'CS120', name: 'Computer Science — CS120', subject: 'Programming', icon: 'code', programs: ['SICT'] },
  { code: 'CS130', name: 'Computer Science — CS130', subject: 'Programming', icon: 'code', programs: ['SICT'] },
  { code: 'CS150', name: 'Computer Science — CS150', subject: 'Programming', icon: 'code', programs: ['SICT'] },

  // ---- School of Natural Resources ----
  { code: 'BI100', name: 'Biology', subject: 'Biology', icon: 'dna', programs: ['SNR'] },
  { code: 'CH130', name: 'Chemistry', subject: 'Chemistry', icon: 'flask', programs: ['SNR'] },
  { code: 'NR120', name: 'Communication Skills', subject: 'Communication Skills', icon: 'message', programs: ['SNR'] }
];

const VALID_PROGRAM_CODES = new Set(PROGRAM_CATALOG.map((p) => p.code));

// URL-safe slug for a course: MA110 -> ma110, E.D -> ed, "LA 111" -> la111.
function courseCodeToSlug(code) {
  return String(code || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Display label shown everywhere a program is named.
function programDisplayName(program) {
  if (!program) return '';
  return program.name || program.shortName || program.code;
}

// "MA110 — Mathematics"
function courseDisplay(course) {
  if (!course) return '';
  return `${course.code} — ${course.name}`;
}

// Serialize a program row (with optional counts) for API responses.
function serializeProgram(row, extra = {}) {
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    shortName: row.short_name || row.name,
    groupName: row.group_name || null,
    icon: row.icon || 'book-open',
    description: row.description || '',
    ...extra
  };
}

function serializeCourse(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    slug: row.slug || courseCodeToSlug(row.code),
    icon: row.icon || 'book-open',
    subject: row.subject || null,
    ...extra
  };
}

// Idempotent seeding: insert any missing program/course/assignment rows.
// Safe to call on every boot — existing admin-managed data is never touched.
function seedProgramCatalog(db) {
  const insertProgram = db.prepare(`
    INSERT OR IGNORE INTO programs (code, name, short_name, group_name, icon, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const p of PROGRAM_CATALOG) {
    insertProgram.run(p.code, p.name, p.shortName, p.groupName, p.icon, p.description, now);
  }

  const insertCourse = db.prepare(`
    INSERT OR IGNORE INTO courses (id, code, slug, name, icon, subject, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of COURSE_CATALOG) {
    insertCourse.run(`course-${courseCodeToSlug(c.code)}`, c.code, courseCodeToSlug(c.code), c.name, c.icon, c.subject, now);
  }

  const courseIdByCode = new Map(
    db.prepare('SELECT id, code FROM courses').all().map((r) => [r.code, r.id])
  );

  const link = db.prepare(`
    INSERT OR IGNORE INTO program_courses (program_code, course_id, sort_order)
    VALUES (?, ?, ?)
  `);
  for (const c of COURSE_CATALOG) {
    const courseId = courseIdByCode.get(c.code);
    if (!courseId) continue;
    c.programs.forEach((programCode, index) => {
      link.run(programCode, courseId, index);
    });
  }
}

module.exports = {
  PROGRAM_CATALOG,
  COURSE_CATALOG,
  VALID_PROGRAM_CODES,
  courseCodeToSlug,
  programDisplayName,
  courseDisplay,
  serializeProgram,
  serializeCourse,
  seedProgramCatalog
};
