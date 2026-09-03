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

// The six CBU FIRST-YEAR programmes StudyCore serves. A student picks exactly
// one at signup; that programme is the only thing that decides which courses
// and content they ever see. The school each programme belongs to lives in
// lib/universities.js and is admin-side organisation only.
const PROGRAM_CATALOG = [
  { code: 'SMMS', name: 'Mines and Mineral Sciences', shortName: 'Mines', groupName: null, icon: 'shapes',
    description: 'Chemistry, mathematics, physics, computer science, communication and engineering drawing.' },
  { code: 'SMNS', name: 'Non-Quota (Maths & Natural Sciences)', shortName: 'Non-Quota', groupName: null, icon: 'atom',
    description: 'Shared foundation sciences plus biology — the general first-year science stream.' },
  { code: 'SNR', name: 'Natural Resources', shortName: 'Natural Resources', groupName: null, icon: 'leaf',
    description: 'Biology, chemistry, mathematics, physics and communication for the natural resources sciences.' },
  { code: 'SICT', name: 'Information & Communication Technology', shortName: 'SICT', groupName: null, icon: 'code',
    description: 'Computer science, mathematics and physics for SICT students.' },
  { code: 'BS', name: 'Business Studies', shortName: 'Business', groupName: null, icon: 'wallet',
    description: 'Business, accounting, economics and communication first-year courses.' },
  { code: 'LAW', name: 'Law', shortName: 'Law', groupName: null, icon: 'shield',
    description: 'Constitutional, contract, tort and human-rights law, plus legal skills.' }
];

// Every seed course is GLOBAL (one row keyed by code) and attached to the
// programmes that teach it. The same code legitimately belongs to several
// programmes (MA110, PH110, ...) — that sharing is the whole point of the
// program_courses join table, so one upload reaches every programme that needs
// it instead of being duplicated per school.
const COURSE_CATALOG = [
  // ---- Shared first-year foundation (taught by several programmes) ----
  { code: 'CH110', name: 'Chemistry', subject: 'Chemistry', icon: 'flask', description: 'Atomic structure, chemical bonding, stoichiometry, gases, thermochemistry and the periodic behaviour of the elements.', programs: ['SMMS', 'SMNS'] },
  { code: 'MA110', name: 'Mathematics', subject: 'Mathematics', icon: 'calculator', description: 'Functions, limits, differentiation and integration with applications to science and engineering problems.', programs: ['SMMS', 'SMNS', 'SICT', 'SNR'] },
  { code: 'PH110', name: 'Physics', subject: 'Physics', icon: 'atom', description: 'Mechanics, circular motion, waves, electricity and magnetism, with laboratory and problem-solving practice.', programs: ['SMMS', 'SMNS', 'SICT', 'SNR'] },
  { code: 'BI110', name: 'Biology', subject: 'Biology', icon: 'dna', description: 'Cell biology, genetics, physiology, ecology and the diversity of living organisms.', programs: ['SMNS'] },
  { code: 'CS110', name: 'Computer Science', subject: 'Programming', icon: 'code', description: 'Programming fundamentals, problem decomposition, data structures and computational thinking.', programs: ['SMMS', 'SMNS'] },
  { code: 'LA111', name: 'Communication Skills', subject: 'Communication Skills', icon: 'message', description: 'Academic writing, critical reading, presentation skills and clear professional communication.', programs: ['SMMS', 'SMNS', 'BS', 'LAW'] },
  { code: 'ED', name: 'Engineering Drawing', subject: null, icon: 'ruler', description: 'Orthographic and isometric projection, dimensioning, sectional views and engineering drawing conventions.', programs: ['SMMS'] },

  // ---- School of Mines and Mineral Sciences ----
  { code: 'MG110', name: 'Introduction to Mining and Mineral Sciences', subject: null, icon: 'shapes', description: 'The mining value chain, mineral processing and the Zambian mining context.', programs: ['SMMS'] },

  // ---- School of Business ----
  { code: 'BS110', name: 'Introduction to Business', subject: null, icon: 'wallet', description: 'How businesses are organised, the Zambian business environment and entrepreneurship.', programs: ['BS'] },
  { code: 'BS120', name: 'Financial Accounting', subject: null, icon: 'chart', description: 'The accounting cycle, financial statements and double-entry bookkeeping.', programs: ['BS'] },
  { code: 'BS130', name: 'Business Mathematics', subject: 'Mathematics', icon: 'calculator', description: 'Algebra, ratios, interest, annuities and the mathematics used in business decisions.', programs: ['BS'] },
  { code: 'EC110', name: 'Microeconomics', subject: null, icon: 'trending-up', description: 'Demand, supply, elasticity, market structures and consumer behaviour.', programs: ['BS'] },

  // ---- School of Law ----
  { code: 'LS100', name: 'Constitutional, Administrative and Local Government Law', subject: null, icon: 'book-open', description: 'The constitutional framework of the state, administrative decision-making and local government.', programs: ['LAW'] },
  { code: 'LS110', name: 'Law of Contract', subject: null, icon: 'book-open', description: 'Formation, terms, vitiating factors, performance, discharge and remedies in the law of contract.', programs: ['LAW'] },
  { code: 'LS120', name: 'Law of Torts', subject: null, icon: 'book-open', description: 'Negligence, occupiers liability, nuisance, defamation and the defences available in tort.', programs: ['LAW'] },
  { code: 'LS131', name: 'Legal Skills & Ethics', subject: null, icon: 'book-open', description: 'Legal research, drafting, citation, professional conduct and the ethics of legal practice.', programs: ['LAW'] },

  // ---- School of Information and Communication Technology ----
  { code: 'CS120', name: 'Computer Programming I', subject: 'Programming', icon: 'code', description: 'Structured programming, problem solving and software design fundamentals.', programs: ['SICT'] },
  { code: 'CS130', name: 'Computer Programming II', subject: 'Programming', icon: 'code', description: 'Object-oriented programming, data structures and algorithms.', programs: ['SICT'] },
  { code: 'CS150', name: 'Computer Systems', subject: 'Programming', icon: 'terminal', description: 'Computer organisation, operating systems and the software-hardware interface.', programs: ['SICT'] },

  // ---- School of Natural Resources ----
  { code: 'BI100', name: 'Biology for Natural Resources', subject: 'Biology', icon: 'dna', description: 'Cells, genetics, physiology and living systems, with practical laboratory work.', programs: ['SNR'] },
  { code: 'CH130', name: 'Chemistry for Natural Resources', subject: 'Chemistry', icon: 'flask', description: 'General and organic chemistry for the natural resources sciences.', programs: ['SNR'] },
  { code: 'NR120', name: 'Communication Skills for Natural Resources', subject: 'Communication Skills', icon: 'message', description: 'Academic writing, reporting and presentation skills for the natural resources sciences.', programs: ['SNR'] }
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
    description: row.description || null,
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

  // Fill in a course description where one is missing. Existing descriptions
  // (including ones an admin has written) are never overwritten.
  const setDescription = db.prepare("UPDATE courses SET description = ? WHERE code = ? AND (description IS NULL OR description = '')");
  for (const c of COURSE_CATALOG) {
    if (c.description) setDescription.run(c.description, c.code);
  }

  const courseIdByCode = new Map(
    db.prepare('SELECT id, code FROM courses').all().map((r) => [r.code, r.id])
  );

  // StudyCore is a FIRST-YEAR platform, so every seeded programme→course link
  // sits in Year 1. The column exists so an administrator can later organise
  // other year levels without a schema change.
  const link = db.prepare(`
    INSERT OR IGNORE INTO program_courses (program_code, course_id, sort_order, year_level)
    VALUES (?, ?, ?, ?)
  `);
  const stampYear = db.prepare(`
    UPDATE program_courses SET year_level = ?
    WHERE program_code = ? AND course_id = ? AND year_level IS NULL
  `);
  for (const c of COURSE_CATALOG) {
    const courseId = courseIdByCode.get(c.code);
    if (!courseId) continue;
    c.programs.forEach((programCode, index) => {
      link.run(programCode, courseId, index, 'Year 1');
      stampYear.run('Year 1', programCode, courseId);
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
