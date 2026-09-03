// =============================================
// STUDYCORE — Academic structure (CBU)
// -----------------------------------------------
//   University → School → Programme
//   → First Year → Semester → Course
//
// StudyCore serves Copperbelt University
// FIRST-YEAR students. This hierarchy exists so
// administrators can organise content properly —
// students never navigate it. A student picks a
// PROGRAMME at signup and then simply sees
// "My Courses". Everything above the programme
// is admin-side metadata.
//
// The catalog below only SEEDS the database on
// first boot (idempotent: missing rows are
// inserted, existing rows are never touched), so
// an admin can rename or reorganise freely from
// the dashboard.
// =============================================

const DEFAULT_UNIVERSITY = Object.freeze({
  code: 'CBU',
  name: 'Copperbelt University',
  shortName: 'CBU',
  country: 'Zambia',
  city: 'Kitwe',
  icon: 'school',
  description: 'First-year courses, notes, video lessons and past papers for every Copperbelt University school.'
});

// The six CBU schools StudyCore serves. Kept to exactly the schools whose
// first-year programmes are on the platform — a school with no programme here
// would only be clutter in the admin catalogue. Postgraduate units (School of
// Graduate Studies, the Dag Hammarskjöld Institute) are out for the same
// reason: StudyCore is a first-year platform.
const SCHOOL_CATALOG = [
  { code: 'SOM',  name: 'School of Mines and Mineral Sciences',            shortName: 'Mines',                  icon: 'shapes' },
  { code: 'SMNS', name: 'School of Mathematics and Natural Sciences',      shortName: 'Maths & Natural Sciences', icon: 'atom' },
  { code: 'SNR',  name: 'School of Natural Resources',                     shortName: 'Natural Resources',      icon: 'leaf' },
  { code: 'SICT', name: 'School of Information and Communication Technology', shortName: 'SICT',               icon: 'code' },
  { code: 'SOB',  name: 'School of Business',                              shortName: 'Business',               icon: 'wallet' },
  { code: 'SOL',  name: 'School of Law',                                   shortName: 'Law',                    icon: 'shield' }
];

// Programme code → school code. Only used to attach seeded programmes on first
// boot; an admin can move a programme afterwards. A programme with no school
// still works perfectly (the school is organisation, never a permission).
const PROGRAMME_SCHOOL = {
  SMMS: 'SOM',
  SMNS: 'SMNS',
  SNR: 'SNR',
  SICT: 'SICT',
  BS: 'SOB',
  LAW: 'SOL'
};

// StudyCore is a first-year platform, so every seeded course sits in Year 1.
const DEFAULT_YEAR_LEVEL = 'Year 1';
const YEAR_LEVELS = Object.freeze(['Year 1', 'Year 2', 'Year 3', 'Year 4', 'Year 5']);

// Examination types for past papers — the suggested values so the admin form
// and the Past Papers filters stay consistent. Free text is also accepted.
const EXAM_TYPES = Object.freeze(['Test 1', 'Test 2', 'Test 3', 'Sessional', 'Final Exam', 'Supplementary']);

// Semesters/terms used across the platform.
const SEMESTERS = Object.freeze(['Term 1', 'Term 2', 'Term 3']);

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function serializeUniversity(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    shortName: row.short_name || row.name,
    country: row.country || null,
    city: row.city || null,
    icon: row.icon || 'school',
    description: row.description || '',
    ...extra
  };
}

function serializeFaculty(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    universityId: row.university_id || null,
    name: row.name,
    shortName: row.short_name || row.name,
    icon: row.icon || 'library',
    description: row.description || '',
    ...extra
  };
}

// The single university StudyCore currently serves. Used by the UI to label a
// student's context ("CBU · First Year") without any extra request.
function defaultUniversityCode() {
  return DEFAULT_UNIVERSITY.code;
}

// Idempotent seeding. Existing rows are never overwritten, so an admin who
// renames a school or moves a programme keeps their changes across restarts.
function seedUniversityCatalog(db) {
  const now = new Date().toISOString();

  const universityId = `uni-${slugify(DEFAULT_UNIVERSITY.code)}`;
  db.prepare(`
    INSERT OR IGNORE INTO universities (id, code, name, short_name, country, city, icon, description, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(universityId, DEFAULT_UNIVERSITY.code, DEFAULT_UNIVERSITY.name, DEFAULT_UNIVERSITY.shortName,
    DEFAULT_UNIVERSITY.country, DEFAULT_UNIVERSITY.city, DEFAULT_UNIVERSITY.icon,
    DEFAULT_UNIVERSITY.description, 0, now);

  const insertSchool = db.prepare(`
    INSERT OR IGNORE INTO faculties (id, code, university_id, name, short_name, icon, description, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  SCHOOL_CATALOG.forEach((school, index) => {
    insertSchool.run(`fac-${slugify(DEFAULT_UNIVERSITY.code)}-${slugify(school.code)}`, school.code, universityId,
      school.name, school.shortName || null, school.icon || 'library', null, index, now);
  });

  // Attach seeded programmes to their school, but only while unassigned.
  const attach = db.prepare(`
    UPDATE programs
    SET university_id = @university_id, faculty_id = @faculty_id
    WHERE code = @code AND faculty_id IS NULL
  `);
  for (const [programCode, schoolCode] of Object.entries(PROGRAMME_SCHOOL)) {
    const school = db.prepare('SELECT id FROM faculties WHERE code = ?').get(schoolCode);
    if (!school) continue;
    attach.run({ code: programCode, university_id: universityId, faculty_id: school.id });
  }

  // Every StudyCore student is a first-year student, so any programme that has
  // not declared its length yet defaults to a single year.
  db.prepare('UPDATE programs SET year_count = 1 WHERE year_count IS NULL OR year_count < 1').run();
}

module.exports = {
  DEFAULT_UNIVERSITY,
  SCHOOL_CATALOG,
  PROGRAMME_SCHOOL,
  DEFAULT_YEAR_LEVEL,
  YEAR_LEVELS,
  EXAM_TYPES,
  SEMESTERS,
  slugify,
  serializeUniversity,
  serializeFaculty,
  defaultUniversityCode,
  seedUniversityCatalog
};
