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
//
// PROGRAMS ARE CBU SCHOOLS/CATEGORIES:
// Law, Business Studies, School of Natural
// Resources, School of Mines, Non-Quota, SICT
// and the School of the Built Environment (SBE,
// covering Architecture, Construction
// Management, Quantity Surveying, Real Estate
// Studies and Urban & Regional Planning).
//
// Course codes below are the ones Copperbelt
// University publishes on its own programme
// pages — see docs/cbu-course-catalog.md for
// the exact page each block came from. Do not
// invent a code for a course CBU has not
// published one for; add it through the admin
// dashboard instead so it is easy to correct.
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
  },
  {
    code: 'SBE',
    name: 'School of the Built Environment',
    shortName: 'Built Environment',
    groupName: null,
    icon: 'home',
    description: 'School of the Built Environment — architecture, construction management, quantity surveying, real estate studies and urban & regional planning.'
  }
];

// Every seed course is GLOBAL (one row keyed by code) and attached to the
// programs that teach it. The same code can legitimately belong to several
// programs (MA110, PH110, ...) — that sharing is the entire point of the
// program_courses join table.
//
// The catalog is FIRST-YEAR ONLY. CBU course codes carry their year block in
// the hundreds digit (BS 1xx, CS 2xx, ES 3xx ...), so every course seeded here
// is a year-1 course and each program's course list is that school's true
// first-year foundation. Later-year courses are NOT seeded — the admin can add
// them from the dashboard once the codes are confirmed (exactly the same rule
// as the Law Stage II–IV rows). This is what keeps the advertised course counts
// honest: a Built Environment first year is 7 courses, not 118.
//
// `subject` mirrors the legacy subjects table so seeded content also appears
// on the legacy subject pages; it is best-effort metadata only.
const COURSE_CATALOG = [
  // ---- Law (Stage I — first year) ----
  { code: 'LS100', name: 'Constitutional, Administrative and Local Government Law', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS110', name: 'Law of Contract', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS120', name: 'Law of Torts', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS131', name: 'Legal Context Skills & Ethics', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS141', name: 'Human Rights and Civil Liberties', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS151', name: 'Equity, Trusts & Wills', subject: null, icon: 'book-open', programs: ['LAW'] },
  { code: 'LS161', name: 'Remedies in Private Law', subject: null, icon: 'book-open', programs: ['LAW'] },

  // ---- Business Studies — School of Business first year (cbu.ac.zm) ----
  // BS 110 is "Microeconomics" on the Lusaka Campus page and "Principles of
  // Microeconomics" on the School of Business page; the shorter title is used.
  { code: 'BS 110', name: 'Microeconomics', subject: null, icon: 'chart', programs: ['BS'] },
  { code: 'BS 120', name: 'Basic Financial Accounting', subject: null, icon: 'calculator', programs: ['BS'] },
  { code: 'BS 140', name: 'Mathematical Analysis', subject: 'Mathematics', icon: 'calculator', programs: ['BS'] },
  { code: 'BS 150', name: 'Principles of Management', subject: null, icon: 'list-checks', programs: ['BS'] },
  { code: 'BS 151', name: 'Business Communication', subject: 'Communication Skills', icon: 'message', programs: ['BS'] },
  { code: 'BS 153', name: 'Business Environment', subject: null, icon: 'globe', programs: ['BS'] },
  { code: 'BS 190', name: 'Business Law', subject: null, icon: 'shield', programs: ['BS'] },
  { code: 'HRM 190', name: 'Principles of Law', subject: null, icon: 'shield', programs: ['BS'] },

  // ---- Shared Mines / Non-Quota first-year foundation ----
  // MA110 and PH110 are also the SICT and School of Natural Resources first
  // year — CBU states the SICT first year IS the Non-Quota first year, and
  // both foundation sciences are shared by SNR too.
  { code: 'CH110', name: 'Chemistry', subject: 'Chemistry', icon: 'flask', programs: ['SMMS', 'SMNS'] },
  { code: 'MA110', name: 'Mathematics', subject: 'Mathematics', icon: 'calculator', programs: ['SMMS', 'SMNS', 'SICT', 'SNR'] },
  { code: 'PH110', name: 'Physics', subject: 'Physics', icon: 'atom', programs: ['SMMS', 'SMNS', 'SICT', 'SNR'] },
  { code: 'CS110', name: 'Computer Science', subject: 'Programming', icon: 'code', programs: ['SMMS', 'SMNS'] },
  { code: 'LA111', name: 'Communication Skills', subject: 'Communication Skills', icon: 'message', programs: ['SMMS', 'SMNS'] },

  // ---- School of Mines ONLY ----
  { code: 'ED', name: 'Engineering Drawing', subject: null, icon: 'ruler', programs: ['SMMS'] },

  // ---- Non-Quota ONLY ----
  { code: 'BI110', name: 'Biology', subject: 'Biology', icon: 'dna', programs: ['SMNS'] },

  // ---- SICT (first year — shared foundation plus the CS1xx sequence) ----
  { code: 'CS120', name: 'Computer Science — CS120', subject: 'Programming', icon: 'code', programs: ['SICT'] },
  { code: 'CS130', name: 'Computer Science — CS130', subject: 'Programming', icon: 'code', programs: ['SICT'] },
  { code: 'CS150', name: 'Computer Science — CS150', subject: 'Programming', icon: 'code', programs: ['SICT'] },

  // ---- School of Natural Resources (first year) ----
  // SNR first-year biology/chemistry are coded BI100/CH130 (kept stable so
  // existing seeded content keeps its course id), while CBU's Wildlife
  // Management page writes NR 100 / NR 130.
  { code: 'BI100', name: 'Biology', subject: 'Biology', icon: 'dna', programs: ['SNR'] },
  { code: 'CH130', name: 'Chemistry', subject: 'Chemistry', icon: 'flask', programs: ['SNR'] },
  { code: 'NR120', name: 'Communication Skills', subject: 'Communication Skills', icon: 'message', programs: ['SNR'] },

  // ============================================================
  // School of the Built Environment (SBE) — shared first year
  // ------------------------------------------------------------
  // CBU's five SBE undergraduate degrees all share the same ES 1xx first
  // year, which is why SBE is one program with one shared foundation block.
  // The degree-specific second- to fifth-year courses are not seeded; the
  // admin adds them for the programme the student is enrolled in.
  // ============================================================
  { code: 'ES 100', name: 'Studio Project', subject: null, icon: 'pen', programs: ['SBE'] },
  { code: 'ES 110', name: 'Built Environment', subject: null, icon: 'home', programs: ['SBE'] },
  { code: 'ES 120', name: 'Introduction to Economics', subject: null, icon: 'chart', programs: ['SBE'] },
  { code: 'ES 130', name: 'Introduction to Physical and Human Geography', subject: null, icon: 'globe', programs: ['SBE'] },
  { code: 'ES 141', name: 'Introduction to Sociology', subject: null, icon: 'users', programs: ['SBE'] },
  { code: 'ES 142', name: 'Communication Skills', subject: 'Communication Skills', icon: 'message', programs: ['SBE'] },
  { code: 'ES 150', name: 'Mathematics', subject: 'Mathematics', icon: 'calculator', programs: ['SBE'] }
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
  // Courses are numbered in catalog order WITHIN each program, which is the
  // same convention the admin UI uses when it appends a course
  // (MAX(sort_order) + 1). Without this every single-program course would
  // land on sort_order 0 and the program would fall back to an alphabetical
  // sort — which for a large catalog like the School of the Built Environment
  // buries the shared first-year ES 1xx block under later-year courses.
  const nextOrderForProgram = new Map();
  for (const c of COURSE_CATALOG) {
    const courseId = courseIdByCode.get(c.code);
    if (!courseId) continue;
    for (const programCode of c.programs) {
      const order = nextOrderForProgram.get(programCode) || 0;
      link.run(programCode, courseId, order);
      nextOrderForProgram.set(programCode, order + 1);
    }
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
