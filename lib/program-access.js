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
//                     resource_programs, PLUS any
//                     program pooled with one of
//                     them (see lib/program-sharing.js)
//   - if course_id is set, the student's program
//     must additionally include that course —
//     either directly or through a pooled peer
// =============================================

const db = require('../db');
const { isAdmin, isStudent } = require('./roles');
const {
  sharedProgramCodes,
  isShareableCourse,
  unshareableCourseSqlPredicate
} = require('./program-sharing');

// Bind each pooled peer program as its own named parameter and return the
// placeholder list. Named parameters keep the codes out of the SQL string.
function bindPeerParams(peers, params, prefix) {
  return peers.map((code, index) => {
    const name = `${prefix}Peer${index}`;
    params[name] = code;
    return `@${name}`;
  });
}

// Is this program allowed to see this resource? Content Admin accounts have a
// separate publisher workflow and never inherit student-library access merely
// because they happen to be logged in.
function programCanSeeResource(user, row) {
  if (!user || !row) return false;
  if (isAdmin(user)) return true;
  if (!isStudent(user)) return false;

  const programCode = user.program_code;

  if (row.course_id && !programIncludesCourse(programCode, row.course_id)) {
    const isShared = db.prepare(`
      SELECT 1 FROM program_courses pc
      LEFT JOIN courses c ON c.id = ?
      WHERE pc.program_code = ? AND (
        pc.course_id = c.shared_with_course_id
        OR c.id = (SELECT shared_with_course_id FROM courses ch WHERE ch.id = pc.course_id)
        OR (pc.course_id = c.id AND (c.shared_with_course_id IS NOT NULL OR EXISTS (SELECT 1 FROM courses ch WHERE ch.shared_with_course_id = c.id)))
      )
    `).get(row.course_id, programCode);
    // Mines ↔ Non-Quota pool their courses too, so a shared course taught in
    // the peer program counts as "included" here — except Biology and
    // Engineering Drawing, which stay exclusive to their own school.
    if (!isShared && !peerProgramIncludesCourse(programCode, row.course_id)) return false;
  }

  if (row.target_all === 1 || row.target_all === true) return true;
  
  if (!programCode) return false;

  // The student's own program, plus any program pooled with it. One upload
  // for Mines is therefore visible to Non-Quota without duplicating the row.
  const candidateCodes = [programCode, ...sharedProgramCodes(programCode)];
  const directlyTargeted = candidateCodes.some((code) => {
    if (code !== programCode && !resourceIsShareable(row)) return false;
    return Boolean(db.prepare(
      'SELECT 1 FROM resource_programs WHERE resource_id = ? AND program_code = ?'
    ).get(row.id, code));
  });
  if (directlyTargeted) return true;

  if (row.course_id) {
    const isShared = db.prepare(`
      SELECT 1 FROM program_courses pc
      LEFT JOIN courses c ON c.id = ?
      WHERE pc.program_code = ? AND (
        pc.course_id = c.shared_with_course_id
        OR c.id = (SELECT shared_with_course_id FROM courses ch WHERE ch.id = pc.course_id)
        OR (pc.course_id = c.id AND (c.shared_with_course_id IS NOT NULL OR EXISTS (SELECT 1 FROM courses ch WHERE ch.shared_with_course_id = c.id)))
      )
    `).get(row.course_id, programCode);
    if (isShared) return true;

    // A course is global and can be attached to several programs. Once an
    // upload is addressed to one program which teaches that course, every
    // other program teaching the very same course receives it as well. This
    // keeps one canonical upload instead of making admins duplicate files.
    const targetedSharedCourse = db.prepare(`
      SELECT 1
      FROM program_courses recipient
      JOIN resource_programs rp ON rp.resource_id = ?
      JOIN program_courses source
        ON source.program_code = rp.program_code
       AND source.course_id = recipient.course_id
      WHERE recipient.program_code = ?
        AND recipient.course_id = ?
      LIMIT 1
    `).get(row.id, programCode, row.course_id);
    if (targetedSharedCourse) return true;
  }

  return false;
}

// Is this resource's course eligible to cross a program-sharing boundary?
// Resources with no course (general/announcement content) travel with the
// group; Biology and Engineering Drawing content never does.
function resourceIsShareable(row) {
  if (!row || !row.course_id) return true;
  const course = db.prepare('SELECT id, code, name, subject FROM courses WHERE id = ?').get(row.course_id);
  return isShareableCourse(course);
}

// Does a program pooled with this one teach this course? Used so a Mines
// student reaches a Non-Quota course's content (and vice versa) without the
// course having to be attached to both programs.
function peerProgramIncludesCourse(programCode, courseId) {
  const peers = sharedProgramCodes(programCode);
  if (!peers.length || !courseId) return false;
  const course = db.prepare('SELECT id, code, name, subject FROM courses WHERE id = ?').get(courseId);
  if (!isShareableCourse(course)) return false;
  // programOwnsCourse (not programIncludesCourse) — the peer's OWN link.
  // Recursing through programIncludesCourse here would bounce between the two
  // pooled programs forever.
  return peers.some((peer) => programOwnsCourse(peer, courseId));
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
  if (isAdmin(user)) return { clause: '', params: {} };
  if (!isStudent(user)) return { clause: '0 = 1', params: {} };
  const programCode = user.program_code || null;
  if (!programCode) {
    // Unassigned students can see global content, but cannot satisfy any
    // course-membership requirement until they select a program.
    return { clause: `(${alias}.target_all = 1 AND ${alias}.course_id IS NULL)`, params: {} };
  }

  const params = { [paramName]: programCode };
  const peers = sharedProgramCodes(programCode);
  const peerPlaceholders = bindPeerParams(peers, params, paramName);

  // ── Pooled programs (Mines ↔ Non-Quota) ────────────────────────────────
  // A peer program's content is visible too, but ONLY when the resource's
  // course is shareable: Biology and Engineering Drawing stay with the school
  // that teaches them. `notShareable` is the SQL form of that exclusion.
  const notShareable = peerPlaceholders.length
    ? `EXISTS (
        SELECT 1 FROM courses xc
        WHERE xc.id = ${alias}.course_id AND ${unshareableCourseSqlPredicate('xc')}
      )`
    : null;

  const peerTargeted = peerPlaceholders.length
    ? `OR (
        NOT ${notShareable}
        AND EXISTS (
          SELECT 1 FROM resource_programs rp
          WHERE rp.resource_id = ${alias}.id AND rp.program_code IN (${peerPlaceholders.join(', ')})
        )
      )`
    : '';

  const peerTeachesCourse = peerPlaceholders.length
    ? `OR (
        ${alias}.course_id IS NOT NULL
        AND NOT ${notShareable}
        AND EXISTS (
          SELECT 1 FROM program_courses pc
          WHERE pc.program_code IN (${peerPlaceholders.join(', ')})
            AND pc.course_id = ${alias}.course_id
        )
      )`
    : '';

  return {
    clause: `(
      ${alias}.target_all = 1
      OR EXISTS (
        SELECT 1 FROM resource_programs rp
        WHERE rp.resource_id = ${alias}.id AND rp.program_code = @${paramName}
      )
      OR (
        ${alias}.course_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM program_courses pc
          LEFT JOIN courses c ON c.id = ${alias}.course_id
          WHERE pc.program_code = @${paramName} AND (
            pc.course_id = c.shared_with_course_id
            OR c.id = (SELECT shared_with_course_id FROM courses ch WHERE ch.id = pc.course_id)
          )
        )
      )
      OR (
        ${alias}.course_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM program_courses recipient
          JOIN resource_programs shared_rp ON shared_rp.resource_id = ${alias}.id
          JOIN program_courses source
            ON source.program_code = shared_rp.program_code
           AND source.course_id = recipient.course_id
          WHERE recipient.program_code = @${paramName}
            AND recipient.course_id = ${alias}.course_id
        )
      )
      ${peerTargeted}
    ) AND (
      ${alias}.course_id IS NULL
      OR EXISTS (
        SELECT 1 FROM program_courses pc
        LEFT JOIN courses c ON c.id = ${alias}.course_id
        WHERE pc.program_code = @${paramName} AND (
          pc.course_id = ${alias}.course_id
          OR pc.course_id = c.shared_with_course_id
          OR c.id = (SELECT shared_with_course_id FROM courses ch WHERE ch.id = pc.course_id)
        )
      )
      ${peerTeachesCourse}
    )`,
    params
  };
}

// Resolve an arbitrary client-supplied value to a REAL program code.
// The catalog is dynamic — Main Admin can create new programs at any time
// (POST /api/programs/admin) — so validation must check the live programs
// table, never a static list of the six seeded codes. Returns the canonical
// upper-case code, or null when no such program exists.
function validProgramCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!code) return null;
  return db.prepare('SELECT code FROM programs WHERE code = ?').get(code) ? code : null;
}

// Does this program include this course? (For the course-home endpoint.)
// Pooled programs count: a Non-Quota student may open a Mines course, and
// vice versa — except Biology and Engineering Drawing.
function programIncludesCourse(programCode, courseId) {
  if (!programCode || !courseId) return false;
  const own = Boolean(
    db.prepare('SELECT 1 FROM program_courses WHERE program_code = ? AND course_id = ?')
      .get(programCode, courseId)
  );
  if (own) return true;
  return peerProgramIncludesCourse(programCode, courseId);
}

// Strictly the courses attached to THIS program — no pooled peers. Used where
// the literal enrolment link matters (admin course management, seeding).
function programOwnsCourse(programCode, courseId) {
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
//
// Pooled programs (Mines ↔ Non-Quota) contribute their shareable courses too,
// appended after the program's own list so a student's own curriculum still
// leads. Biology and Engineering Drawing are never pooled, so a Non-Quota
// student never sees E.D and a Mines student never sees BI110.
function coursesForProgram(programCode) {
  const rows = db.prepare(`
    SELECT c.*, pc.sort_order
    FROM program_courses pc
    JOIN courses c ON c.id = pc.course_id
    WHERE pc.program_code = ?
    ORDER BY pc.sort_order ASC, c.code ASC
  `).all(programCode);

  const peers = sharedProgramCodes(programCode);
  if (!peers.length) return rows;

  const seen = new Set(rows.map((row) => row.id));
  const shared = [];
  for (const peer of peers) {
    const peerRows = db.prepare(`
      SELECT c.*, pc.sort_order
      FROM program_courses pc
      JOIN courses c ON c.id = pc.course_id
      WHERE pc.program_code = ?
      ORDER BY pc.sort_order ASC, c.code ASC
    `).all(peer);
    for (const row of peerRows) {
      if (seen.has(row.id) || !isShareableCourse(row)) continue;
      seen.add(row.id);
      shared.push({ ...row, shared_from_program: peer });
    }
  }
  return [...rows, ...shared];
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
  validProgramCode,
  programIncludesCourse,
  programOwnsCourse,
  peerProgramIncludesCourse,
  resourceIsShareable,
  resolveCourse,
  coursesForProgram,
  targetingForResource
};
