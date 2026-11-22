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
// remain separate student categories, while
// sharing their common first-year courses.
//
// The seed catalog contains the three active
// categories requested for StudyCore: School of
// Mines, Non-Quota (NQ), and SICT. Program and
// course rows live in the database; this catalog
// seeds their first-year records. The admin can
// still manage courses and any future categories
// from the dashboard.
//
// Course codes are based on Copperbelt University
// programme pages — see docs/cbu-course-catalog.md.
// Do not invent a code for a course CBU has not
// published one for; add it through the admin
// dashboard instead so it is easy to correct.
// =============================================

const PROGRAM_CATALOG = [
  {
    code: 'SMMS',
    name: 'School of Mines',
    shortName: 'Mines',
    // Mines and Non-Quota share the same general academic platform, but they
    // remain separate categories because their course lists differ (ED vs BI110).
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
    description: 'Non-Quota (NQ) — shared foundation sciences plus biology.'
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

// Formerly seeded program codes removed from the active StudyCore catalog.
// `pruneRetiredPrograms()` removes their database rows and data that has no
// remaining connection to the three active categories.
const RETIRED_PROGRAM_CODES = Object.freeze(['LAW', 'BS', 'SNR', 'SBE']);

// Every seed course is GLOBAL (one row keyed by code) and attached to the
// programs that teach it. The same code can legitimately belong to several
// programs (MA110, PH110, ...) — that sharing is the entire point of the
// program_courses join table.
//
// The catalog is FIRST-YEAR ONLY. Later-year courses are not seeded — the
// admin can add them from the dashboard once their codes are confirmed. This
// keeps the advertised course counts honest and avoids inventing course codes.
//
// `subject` mirrors the legacy subjects table so seeded content also appears
// on the legacy subject pages; it is best-effort metadata only.
const COURSE_CATALOG = [
  // ---- Shared Mines / Non-Quota first-year foundation ----
  // MA110 and PH110 are also the SICT first-year sciences.
  { code: 'CH110', name: 'Chemistry', subject: 'Chemistry', icon: 'flask', programs: ['SMMS', 'SMNS'] },
  { code: 'MA110', name: 'Mathematics', subject: 'Mathematics', icon: 'calculator', programs: ['SMMS', 'SMNS', 'SICT'] },
  { code: 'PH110', name: 'Physics', subject: 'Physics', icon: 'atom', programs: ['SMMS', 'SMNS', 'SICT'] },
  { code: 'CS110', name: 'Computer Science', subject: 'Programming', icon: 'code', programs: ['SMMS', 'SMNS'] },
  { code: 'LA111', name: 'Communication Skills', subject: 'Communication Skills', icon: 'message', programs: ['SMMS', 'SMNS'] },

  // ---- School of Mines ONLY ----
  { code: 'ED', name: 'Engineering Drawing', subject: null, icon: 'ruler', programs: ['SMMS'] },

  // ---- Non-Quota (NQ) ONLY ----
  { code: 'BI110', name: 'Biology', subject: 'Biology', icon: 'dna', programs: ['SMNS'] },

  // ---- SICT (first year — shared foundation plus the CS1xx sequence) ----
  { code: 'CS120', name: 'Computer Science — CS120', subject: 'Programming', icon: 'code', programs: ['SICT'] },
  { code: 'CS130', name: 'Computer Science — CS130', subject: 'Programming', icon: 'code', programs: ['SICT'] },
  { code: 'CS150', name: 'Computer Science — CS150', subject: 'Programming', icon: 'code', programs: ['SICT'] }
];

// URL-safe slug for a course: MA110 -> ma110, E.D -> ed, "LA 111" -> la111.
function courseCodeToSlug(code) {
  return String(code || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
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
    shared_with_course_id: row.shared_with_course_id || null,
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
  // sort — which can bury a shared foundation block under later-year courses.
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

// Remove programs that were part of the previous built-in catalog but are no
// longer offered. Shared courses survive when any active program still uses
// them; courses and uploads belonging only to a retired program are removed.
// Accounts are retained, with their program cleared so they can choose one of
// the remaining programs on their next visit.
//
// The cleanup is deliberately scoped to the four retired built-in codes.
// Admin-created categories remain under the existing dynamic catalog workflow.
// A course that still has any program link is retained. Resources attached to
// courses removed with the retired programs are removed; general resources
// with no course association are kept when they still have an audience.
function pruneRetiredPrograms(db) {
  const placeholders = RETIRED_PROGRAM_CODES.map(() => '?').join(', ');
  const retiredPrograms = db.prepare(
    `SELECT code FROM programs WHERE code IN (${placeholders})`
  ).all(...RETIRED_PROGRAM_CODES).map((row) => row.code);
  if (!retiredPrograms.length) {
    return { removedPrograms: [], removedCourses: [], removedResources: [] };
  }

  const retiredPlaceholders = retiredPrograms.map(() => '?').join(', ');
  const removedResources = [];
  const removedCourseIds = [];
  const resourceIdsToDelete = new Set();

  db.exec('BEGIN IMMEDIATE');
  try {
    const oldCourseIds = db.prepare(`
      SELECT DISTINCT course_id
      FROM program_courses
      WHERE program_code IN (${retiredPlaceholders})
    `).all(...retiredPrograms).map((row) => row.course_id);

    const previouslyTargetedResources = db.prepare(`
      SELECT DISTINCT r.id
      FROM resources r
      JOIN resource_programs rp ON rp.resource_id = r.id
      WHERE r.target_all = 0
        AND rp.program_code IN (${retiredPlaceholders})
    `).all(...retiredPrograms).map((row) => row.id);

    db.prepare(`UPDATE users SET program_code = NULL WHERE program_code IN (${retiredPlaceholders})`)
      .run(...retiredPrograms);
    db.prepare(`DELETE FROM resource_programs WHERE program_code IN (${retiredPlaceholders})`)
      .run(...retiredPrograms);
    db.prepare(`DELETE FROM program_courses WHERE program_code IN (${retiredPlaceholders})`)
      .run(...retiredPrograms);

    const courseStillAssigned = db.prepare(
      'SELECT 1 FROM program_courses WHERE course_id = ? LIMIT 1'
    );
    for (const courseId of oldCourseIds) {
      if (!courseStillAssigned.get(courseId)) {
        removedCourseIds.push(courseId);
        const courseResources = db.prepare(
          'SELECT id FROM resources WHERE course_id = ?'
        ).all(courseId);
        for (const resource of courseResources) resourceIdsToDelete.add(resource.id);
      }
    }

    const resourceStillTargeted = db.prepare(
      'SELECT 1 FROM resource_programs WHERE resource_id = ? LIMIT 1'
    );
    for (const resourceId of previouslyTargetedResources) {
      if (!resourceStillTargeted.get(resourceId)) resourceIdsToDelete.add(resourceId);
    }

    const resourceById = db.prepare(`
      SELECT id, stored_name, stream_uid, storage_provider, google_drive_file_id
      FROM resources WHERE id = ?
    `);
    const deleteResource = db.prepare('DELETE FROM resources WHERE id = ?');
    for (const resourceId of resourceIdsToDelete) {
      const resource = resourceById.get(resourceId);
      if (!resource) continue;
      removedResources.push(resource);
      deleteResource.run(resourceId);
    }

    const deleteCourse = db.prepare('DELETE FROM courses WHERE id = ?');
    for (const courseId of removedCourseIds) deleteCourse.run(courseId);

    db.prepare(`DELETE FROM programs WHERE code IN (${retiredPlaceholders})`)
      .run(...retiredPrograms);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw err;
  }

  console.log(
    `StudyCore: removed retired program(s) ${retiredPrograms.join(', ')} ` +
    `and their exclusive course/content records (${removedCourseIds.length} course(s), ` +
    `${removedResources.length} resource(s)); kept shared courses and general content.`
  );

  return {
    removedPrograms: retiredPrograms,
    removedCourses: removedCourseIds,
    removedResources
  };
}

// ---------------------------------------------------------------------------
// Prune legacy multi-year seed rows.
//
// Seeding is INSERT OR IGNORE, so it can only ever ADD rows. Deployments that
// booted an earlier StudyCore build may still carry a multi-year seed dump for
// a retained program (for example, the older SICT catalog). Those rows can
// keep showing up in the program directory even though this file is first-year
// only.
//
// This prune removes exactly those leftovers and nothing else:
//   * only rows whose id is the deterministic seed id `course-<slug(code)>`
//     are considered — admin-created courses get `course-<uuid>` ids and are
//     never touched;
//   * only codes that are NOT in the current first-year COURSE_CATALOG;
//   * only courses with no content attached (no resources point at them).
//     A stale course that already carries uploaded notes/videos is left in
//     place and reported, so nothing a student paid attention to disappears.
//
// Idempotent and cheap: on a clean or already-pruned database it deletes
// nothing.
function pruneLegacySeedCourses(db) {
  const keep = new Set(COURSE_CATALOG.map((c) => c.code));
  const seedIds = new Set(COURSE_CATALOG.map((c) => `course-${courseCodeToSlug(c.code)}`));

  const candidates = db.prepare('SELECT id, code FROM courses').all().filter((row) => {
    if (keep.has(row.code)) return false;
    if (seedIds.has(row.id)) return false;
    // Deterministic seed id => the row came from a previous catalog seed.
    return row.id === `course-${courseCodeToSlug(row.code)}`;
  });
  if (!candidates.length) return { removed: 0, kept: 0 };

  const contentCount = db.prepare('SELECT COUNT(*) c FROM resources WHERE course_id = ?');
  const unlink = db.prepare('DELETE FROM program_courses WHERE course_id = ?');
  const dropCourse = db.prepare('DELETE FROM courses WHERE id = ?');

  let removed = 0;
  let kept = 0;
  for (const row of candidates) {
    if (contentCount.get(row.id).c > 0) {
      kept += 1;
      continue;
    }
    unlink.run(row.id);
    dropCourse.run(row.id);
    removed += 1;
  }

  if (removed > 0) {
    console.log(`StudyCore: removed ${removed} legacy non-first-year seed course(s) from the catalog.`);
  }
  if (kept > 0) {
    console.warn(`StudyCore: ${kept} legacy non-first-year course(s) still hold uploaded content and were kept; remove them from the admin dashboard if they are not needed.`);
  }
  return { removed, kept };
}

module.exports = {
  PROGRAM_CATALOG,
  COURSE_CATALOG,
  RETIRED_PROGRAM_CODES,
  courseCodeToSlug,
  serializeProgram,
  serializeCourse,
  seedProgramCatalog,
  pruneRetiredPrograms,
  pruneLegacySeedCourses
};
