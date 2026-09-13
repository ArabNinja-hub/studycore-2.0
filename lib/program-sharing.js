'use strict';

// =============================================
// STUDYCORE — Shared program groups
// -----------------------------------------------
// School of Mines (SMMS) and Non-Quota (SMNS) run the SAME general academic
// first year. They remain two separate student categories — a student still
// enrols in exactly one — but their study material is pooled: anything a
// Content Admin publishes for Mines also reaches Non-Quota, and vice versa.
//
// TWO COURSES ARE DELIBERATELY NOT POOLED:
//   * Engineering Drawing (ED) — School of Mines only
//   * Biology (BI110)          — Non-Quota only
// These are the courses that genuinely differ between the two schools, so
// their content never crosses the boundary. The exclusion is matched on the
// course itself (code, name and subject), not on the program link, so the
// rule holds even if an admin later attaches one of them to both programs by
// mistake.
//
// Sharing is implemented as a VISIBILITY rule, not by duplicating rows: one
// upload stays one resource with one owner and one set of analytics. Removing
// a program from this file instantly un-shares it, with no data to migrate.
// =============================================

// Each entry is a set of program codes that pool their content.
const SHARED_PROGRAM_GROUPS = Object.freeze([
  Object.freeze(['SMMS', 'SMNS'])
]);

// Courses that stay exclusive to the program that teaches them.
const UNSHARED_COURSE_CODES = Object.freeze(new Set(['ED', 'E.D', 'BI110']));
const UNSHARED_COURSE_SUBJECTS = Object.freeze(new Set(['biology', 'engineering drawing']));
const UNSHARED_COURSE_NAMES = Object.freeze(new Set(['biology', 'engineering drawing']));

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeLabel(value) {
  return String(value || '').trim().toLowerCase();
}

// The group this program belongs to, or null when it shares with nobody.
function sharingGroupFor(programCode) {
  const code = normalizeCode(programCode);
  if (!code) return null;
  return SHARED_PROGRAM_GROUPS.find((group) => group.includes(code)) || null;
}

// Peer programs that pool content with this one (never includes itself).
function sharedProgramCodes(programCode) {
  const group = sharingGroupFor(programCode);
  if (!group) return [];
  const code = normalizeCode(programCode);
  return group.filter((peer) => peer !== code);
}

// Every program code whose content this student may see: their own program
// first, then any pooled peers. Always returns at least the given code.
function visibleProgramCodes(programCode) {
  const code = normalizeCode(programCode);
  if (!code) return [];
  return [code, ...sharedProgramCodes(code)];
}

function hasSharedPrograms(programCode) {
  return sharedProgramCodes(programCode).length > 0;
}

// Is this course allowed to cross the share boundary? Engineering Drawing and
// Biology are not.
function isShareableCourse(course) {
  if (!course) return false;
  if (UNSHARED_COURSE_CODES.has(normalizeCode(course.code))) return false;
  // "E.D", "E D" and "ED" are all the same course.
  if (normalizeCode(course.code).replace(/[^A-Z0-9]/g, '') === 'ED') return false;
  if (UNSHARED_COURSE_SUBJECTS.has(normalizeLabel(course.subject))) return false;
  if (UNSHARED_COURSE_NAMES.has(normalizeLabel(course.name))) return false;
  return true;
}

// SQL predicate (for a `courses` alias) matching the courses that may NOT be
// shared. Used to exclude Biology/ED rows inside visibility queries without
// loading them into JavaScript first.
function unshareableCourseSqlPredicate(alias = 'c') {
  const codes = [...UNSHARED_COURSE_CODES].map((code) => `'${code.replace(/'/g, "''")}'`).join(', ');
  const labels = [...new Set([...UNSHARED_COURSE_SUBJECTS, ...UNSHARED_COURSE_NAMES])]
    .map((label) => `'${label.replace(/'/g, "''")}'`).join(', ');
  return `(
    UPPER(TRIM(${alias}.code)) IN (${codes})
    OR REPLACE(REPLACE(UPPER(TRIM(${alias}.code)), '.', ''), ' ', '') = 'ED'
    OR LOWER(TRIM(COALESCE(${alias}.subject, ''))) IN (${labels})
    OR LOWER(TRIM(COALESCE(${alias}.name, ''))) IN (${labels})
  )`;
}

// A short, human sentence for the upload dashboards, e.g.
// "School of Mines and Non-Quota share this content." Returns '' when the
// program has no pooled peers.
function sharingNoticeFor(programCode, nameByCode = {}) {
  const peers = sharedProgramCodes(programCode);
  if (!peers.length) return '';
  const names = peers.map((code) => nameByCode[code] || code);
  const list = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Content published here is also shown to ${list} students, except Biology and Engineering Drawing.`;
}

module.exports = {
  SHARED_PROGRAM_GROUPS,
  UNSHARED_COURSE_CODES,
  UNSHARED_COURSE_SUBJECTS,
  sharingGroupFor,
  sharedProgramCodes,
  visibleProgramCodes,
  hasSharedPrograms,
  isShareableCourse,
  unshareableCourseSqlPredicate,
  sharingNoticeFor
};
