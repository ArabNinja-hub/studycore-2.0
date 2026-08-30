// =============================================
// STUDYCORE — Program-based content access
// -----------------------------------------------
// The permission chain is:
//
//   Student → Program → Course → Resource
//
// Every check below is performed SERVER-SIDE from
// the users/programs/courses rows in the database
// — the client never decides who can see what.
// A Law student manually requesting an SNR
// resource id is denied here, regardless of what
// the UI shows.
//
// Visibility rule for a resource (or announcement):
//   - ADMIN        -> everything
//   - target_all=1 -> every program ("All Programs")
//   - target_all=0 -> only programs listed in
//                     resource_programs
//   - if course_id is set, the student's program
//     must additionally include that course
// =============================================

const db = require('../db');

// Is this program allowed to see this resource?
function programCanSeeResource(user, row) {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  if (!row) return false;

  // All-programs targeting.
  if (row.target_all === 1 || row.target_all === true) return true;

  const programCode = user.program_code;
  if (!programCode) return false;

  // Explicit program targeting.
  const linked = db.prepare(
    'SELECT 1 FROM resource_programs WHERE resource_id = ? AND program_code = ?'
  ).get(row.id, programCode);
  if (!linked) return false;

  // Course-bound content: the student's program must actually contain
  // that course (so a Non-Quota student can never open an E.D resource
  // even though it lives under the shared platform).
  if (row.course_id) {
    const enrolled = db.prepare(
      'SELECT 1 FROM program_courses WHERE program_code = ? AND course_id = ?'
    ).get(programCode, row.course_id);
    if (!enrolled) return false;
  }

  return true;
}

// SQL fragment + params that constrain a resources query to what the given
// user may see. Returns '' for admins (they see everything). Used by the
// list/search/notifications endpoints so program rows never even leave the
// database for an unauthorized student.
//
// `alias` is the table alias/name for the resources table in the query.
// `paramName` names the bound parameter (must be unique per query) — node's
// sqlite binds named parameters from the params object, which callers merge
// into their own named-parameter object.
function resourceVisibilityClause(user, alias = 'r', paramName = 'visProgram') {
  if (user && user.role === 'ADMIN') return { clause: '', params: {} };
  const programCode = (user && user.program_code) || null;
  if (!programCode) {
    // A student with no program sees only all-programs content.
    return { clause: `(${alias}.target_all = 1)`, params: {} };
  }
  return {
    clause: `(
      ${alias}.target_all = 1
      OR EXISTS (
        SELECT 1 FROM resource_programs rp
        WHERE rp.resource_id = ${alias}.id AND rp.program_code = @${paramName}
      )
    ) AND (
      ${alias}.course_id IS NULL
      OR EXISTS (
        SELECT 1 FROM program_courses pc
        WHERE pc.course_id = ${alias}.course_id AND pc.program_code = @${paramName}
      )
    )`,
    params: { [paramName]: programCode }
  };
}

// Does this program include this course? (For the course-home endpoint.)
function programIncludesCourse(programCode, courseId) {
  if (!programCode || !courseId) return false;
  return Boolean(
    db.prepare('SELECT 1 FROM program_courses WHERE program_code = ? AND course_id = ?')
      .get(programCode, courseId)
  );
}

// Resolve a course by id, slug or code. Returns the courses row or null.
function resolveCourse(key) {
  if (!key) return null;
  const k = String(key).trim();
  return (
    db.prepare('SELECT * FROM courses WHERE id = ?').get(k) ||
    db.prepare('SELECT * FROM courses WHERE slug = ?').get(k.toLowerCase()) ||
    db.prepare('SELECT * FROM courses WHERE code = ?').get(k.toUpperCase()) ||
    null
  );
}

// All courses for a program, with content counts (published, visible to the
// program) for each. Ordered by program_courses.sort_order then code.
function coursesForProgram(programCode) {
  const rows = db.prepare(`
    SELECT c.*, pc.sort_order
    FROM program_courses pc
    JOIN courses c ON c.id = pc.course_id
    WHERE pc.program_code = ?
    ORDER BY pc.sort_order ASC, c.code ASC
  `).all(programCode);
  return rows;
}

// Programs that currently target this resource (codes), plus the target_all
// flag — used by admin serializers.
function targetingForResource(row) {
  const targetAll = !row || row.target_all === 1 || row.target_all === true;
  const programs = targetAll
    ? []
    : db.prepare('SELECT program_code FROM resource_programs WHERE resource_id = ?')
        .all(row.id).map((r) => r.program_code);
  return { targetAll, programs };
}

module.exports = {
  programCanSeeResource,
  resourceVisibilityClause,
  programIncludesCourse,
  resolveCourse,
  coursesForProgram,
  targetingForResource
};
