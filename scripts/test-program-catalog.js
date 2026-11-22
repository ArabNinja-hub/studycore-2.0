'use strict';

// Regression tests for the active CBU program/course catalog and the one-time
// cleanup of categories retired from the built-in StudyCore catalog.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-program-catalog-'));
process.env.DATA_DIR = testDataDir;
process.env.ADMIN_EMAIL = 'admin@catalog-test.com';
process.env.ADMIN_PASSWORD = 'Catalog-Pass-1';
process.env.JWT_SECRET = 'test-only-studycore-jwt-secret-0123456789';
process.env.CONTENT_ADMIN_ACCESS_CODE = 'content-admin-test-access-code';

const db = require('../db');
const {
  PROGRAM_CATALOG,
  COURSE_CATALOG,
  RETIRED_PROGRAM_CODES,
  courseCodeToSlug,
  pruneRetiredPrograms,
  pruneLegacySeedCourses
} = require('../lib/programs');
const { createSessionBackedToken, COOKIE_NAME } = require('../middleware/auth');
const app = require('../server');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function call(method, pathname, { cookie, body } = {}) {
  const headers = {};
  const options = { method, headers };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return { status: response.status, data };
}

function cookieFor(user) {
  return `${COOKIE_NAME}=${createSessionBackedToken(user)}`;
}

async function makeStudent(name, email, program) {
  const res = await call('POST', '/api/auth/register', {
    body: { name, email, password: 'student-pass-1', program }
  });
  assert.equal(res.status, 201, `register ${email} (program ${program}): ${JSON.stringify(res.data)}`);
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function loadClientProgramHelpers() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'programs.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'public/js/programs.js' });
  assert.ok(sandbox.window.SCPrograms, 'public/js/programs.js must expose window.SCPrograms');
  return sandbox.window.SCPrograms;
}

function insertProgram(code, name = `${code} test program`) {
  db.prepare(`
    INSERT OR IGNORE INTO programs (code, name, short_name, group_name, icon, description, created_at)
    VALUES (?, ?, ?, NULL, 'book-open', '', ?)
  `).run(code, name, code, new Date().toISOString());
}

function insertCourse(id, code, name = code) {
  db.prepare(`
    INSERT OR IGNORE INTO courses (id, code, slug, name, icon, subject, created_at)
    VALUES (?, ?, ?, ?, 'book-open', NULL, ?)
  `).run(id, code, courseCodeToSlug(code), name, new Date().toISOString());
}

function insertResource({ id, title, courseId = null, targetAll = 1 }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO resources (id, title, category, course_id, target_all, created_at, updated_at)
    VALUES (?, ?, 'document', ?, ?, ?, ?)
  `).run(id, title, courseId, targetAll, now, now);
}

// ---- 1. The built-in catalog contains only the requested categories --------

test('only School of Mines, Non-Quota and SICT are seeded and advertised', async () => {
  const expectedCodes = ['SMMS', 'SMNS', 'SICT'];
  assert.deepEqual(PROGRAM_CATALOG.map((program) => program.code), expectedCodes);
  assert.deepEqual(RETIRED_PROGRAM_CODES, ['LAW', 'BS', 'SNR', 'SBE']);

  const databaseCodes = db.prepare('SELECT code FROM programs ORDER BY rowid').all().map((row) => row.code);
  assert.deepEqual(databaseCodes, expectedCodes);
  for (const code of RETIRED_PROGRAM_CODES) {
    assert.equal(db.prepare('SELECT 1 FROM programs WHERE code = ?').get(code), undefined,
      `${code} should not be seeded`);
  }

  const res = await call('GET', '/api/programs');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.programs.map((program) => program.code), expectedCodes);
  assert.equal(res.data.programs.find((program) => program.code === 'SMNS').name, 'Non-Quota');
  assert.equal(res.data.programs.find((program) => program.code === 'SMMS').name, 'School of Mines');
  assert.equal(res.data.programs.find((program) => program.code === 'SICT').shortName, 'SICT');
});

test('the seeded course catalog has no duplicate codes or slugs', () => {
  const seenCodes = new Set();
  const seenSlugs = new Set();
  for (const course of COURSE_CATALOG) {
    assert.ok(course.code && course.code.trim(), 'every seeded course needs a code');
    assert.ok(course.name && course.name.trim(), `${course.code} needs a name`);
    const slug = courseCodeToSlug(course.code);
    assert.ok(slug, `${course.code} must produce a non-empty slug`);
    assert.ok(!seenCodes.has(course.code), `duplicate course code seeded: ${course.code}`);
    assert.ok(!seenSlugs.has(slug), `duplicate course slug seeded: ${slug} (from ${course.code})`);
    seenCodes.add(course.code);
    seenSlugs.add(slug);
  }
});

test('seeded courses and program links belong only to the three retained categories', () => {
  const known = new Set(PROGRAM_CATALOG.map((program) => program.code));
  for (const course of COURSE_CATALOG) {
    assert.ok(Array.isArray(course.programs) && course.programs.length,
      `${course.code} must be attached to at least one program`);
    for (const code of course.programs) {
      assert.ok(known.has(code), `${course.code} references unknown program ${code}`);
    }
  }

  const expectedAssignments = COURSE_CATALOG.reduce((count, course) => count + course.programs.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM program_courses').get().c, expectedAssignments);
  const orphaned = db.prepare(`
    SELECT COUNT(*) c FROM program_courses pc
    LEFT JOIN programs p ON p.code = pc.program_code
    LEFT JOIN courses c ON c.id = pc.course_id
    WHERE p.code IS NULL OR c.id IS NULL
  `).get().c;
  assert.equal(orphaned, 0, 'every program_courses row must resolve to a program and a course');

  for (const row of db.prepare('SELECT code, slug FROM courses').all()) {
    assert.equal(row.slug, courseCodeToSlug(row.code), `slug drift for ${row.code}`);
  }
});

test('the active first-year course lists are kept intact and in catalog order', async () => {
  const expected = {
    SMMS: ['CH110', 'MA110', 'PH110', 'CS110', 'LA111', 'ED'],
    SMNS: ['CH110', 'MA110', 'PH110', 'CS110', 'LA111', 'BI110'],
    SICT: ['MA110', 'PH110', 'CS120', 'CS130', 'CS150']
  };

  for (const [programCode, codes] of Object.entries(expected)) {
    const actual = db.prepare(`
      SELECT c.code FROM program_courses pc
      JOIN courses c ON c.id = pc.course_id
      WHERE pc.program_code = ?
      ORDER BY pc.sort_order ASC, c.code ASC
    `).all(programCode).map((row) => row.code);
    assert.deepEqual(actual, codes, `${programCode} course order`);
  }

  const mines = await makeStudent('Mina Mines', 'mina@catalog-test.com', 'SMMS');
  const nonQuota = await makeStudent('Nia NQ', 'nia@catalog-test.com', 'SMNS');
  const sict = await makeStudent('Sam SICT', 'sam@catalog-test.com', 'SICT');

  for (const [student, codes] of [
    [mines, expected.SMMS],
    [nonQuota, expected.SMNS],
    [sict, expected.SICT]
  ]) {
    const mine = await call('GET', '/api/programs/mine', { cookie: cookieFor(student) });
    assert.equal(mine.status, 200, JSON.stringify(mine.data));
    assert.deepEqual(mine.data.courses.map((course) => course.code), codes);
  }

  const minesCanOpenED = await call('GET', '/api/programs/course/ed', { cookie: cookieFor(mines) });
  const nqCannotOpenED = await call('GET', '/api/programs/course/ed', { cookie: cookieFor(nonQuota) });
  const nqCanOpenBiology = await call('GET', '/api/programs/course/bi110', { cookie: cookieFor(nonQuota) });
  const minesCannotOpenBiology = await call('GET', '/api/programs/course/bi110', { cookie: cookieFor(mines) });
  assert.equal(minesCanOpenED.status, 200);
  assert.equal(nqCannotOpenED.status, 403);
  assert.equal(nqCanOpenBiology.status, 200);
  assert.equal(minesCannotOpenBiology.status, 403);
});

test('retired programs cannot be selected after catalog cleanup', async () => {
  const res = await call('POST', '/api/auth/register', {
    body: {
      name: 'Retired Program User',
      email: 'retired@catalog-test.com',
      password: 'student-pass-1',
      program: 'LAW'
    }
  });
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE email = ?').get('retired@catalog-test.com'), undefined);
});

// ---- 2. Client metadata mirrors the active catalog -------------------------

test('public/js/programs.js mirrors only the active seeded programs', () => {
  const SCPrograms = loadClientProgramHelpers();
  for (const program of PROGRAM_CATALOG) {
    const meta = SCPrograms.PROGRAM_META[program.code];
    assert.ok(meta, `PROGRAM_META is missing ${program.code}`);
    assert.equal(meta.name, program.name, `${program.code} name drift`);
    assert.equal(meta.shortName, program.shortName, `${program.code} shortName drift`);
    assert.equal(meta.icon, program.icon, `${program.code} icon drift`);
    assert.equal(meta.groupName || null, program.groupName || null, `${program.code} groupName drift`);
  }
  assert.deepEqual([...SCPrograms.FILTER_ORDER], PROGRAM_CATALOG.map((program) => program.code));
  assert.deepEqual(Object.keys(SCPrograms.PROGRAM_META).sort(), ['SICT', 'SMMS', 'SMNS']);
  for (const code of RETIRED_PROGRAM_CODES) {
    assert.equal(SCPrograms.PROGRAM_META[code], undefined, `${code} should not be mirrored in the UI`);
  }
});

// ---- 3. Existing databases are cleaned without losing shared data ----------

test('retired programs and their exclusive courses/content are removed safely', () => {
  const now = new Date().toISOString();
  for (const code of RETIRED_PROGRAM_CODES) insertProgram(code);

  insertCourse('course-law-seed', 'LS100', 'Law course');
  insertCourse('course-business-seed', 'BS 110', 'Business course');
  insertCourse('course-snr-seed', 'BI100', 'Natural Resources course');
  insertCourse('course-sbe-seed', 'ES 100', 'Built Environment course');

  const attach = db.prepare(
    'INSERT OR IGNORE INTO program_courses (program_code, course_id, sort_order) VALUES (?, ?, 0)'
  );
  attach.run('LAW', 'course-law-seed');
  attach.run('BS', 'course-business-seed');
  attach.run('SNR', 'course-snr-seed');
  attach.run('SBE', 'course-sbe-seed');
  // MA110 is shared with retained categories. Removing SNR must not remove it.
  attach.run('SNR', 'course-ma110');

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, program_code, created_at)
    VALUES ('retired-user', 'Retired User', 'retired-user@catalog-test.com', 'unused', 'student', 'LAW', ?)
  `).run(now);

  insertResource({ id: 'law-course-content', title: 'Law course notes', courseId: 'course-law-seed', targetAll: 1 });
  insertResource({ id: 'law-only-general', title: 'Law-only guide', targetAll: 0 });
  insertResource({ id: 'law-and-sict-guide', title: 'Shared target guide', targetAll: 0 });
  insertResource({ id: 'snr-only-ma110', title: 'Old SNR maths notes', courseId: 'course-ma110', targetAll: 0 });
  insertResource({ id: 'global-guide', title: 'All-student guide', targetAll: 1 });

  const target = db.prepare('INSERT INTO resource_programs (resource_id, program_code) VALUES (?, ?)');
  target.run('law-only-general', 'LAW');
  target.run('law-and-sict-guide', 'LAW');
  target.run('law-and-sict-guide', 'SICT');
  target.run('snr-only-ma110', 'SNR');

  const removed = pruneRetiredPrograms(db);
  assert.deepEqual(removed.removedPrograms.sort(), [...RETIRED_PROGRAM_CODES].sort());
  assert.equal(removed.removedCourses.length, 4);
  assert.equal(removed.removedResources.length, 3);

  for (const code of RETIRED_PROGRAM_CODES) {
    assert.equal(db.prepare('SELECT 1 FROM programs WHERE code = ?').get(code), undefined);
  }
  assert.equal(db.prepare('SELECT program_code FROM users WHERE id = ?').get('retired-user').program_code, null,
    'accounts remain but need to choose one of the active programs');
  for (const id of ['course-law-seed', 'course-business-seed', 'course-snr-seed', 'course-sbe-seed']) {
    assert.equal(db.prepare('SELECT 1 FROM courses WHERE id = ?').get(id), undefined, `${id} should be removed`);
  }
  assert.ok(db.prepare('SELECT 1 FROM courses WHERE id = ?').get('course-ma110'), 'shared MA110 survives');
  assert.ok(db.prepare("SELECT 1 FROM program_courses WHERE program_code = 'SICT' AND course_id = 'course-ma110'").get());
  assert.ok(db.prepare("SELECT 1 FROM program_courses WHERE program_code = 'SMMS' AND course_id = 'course-ma110'").get());
  assert.ok(db.prepare("SELECT 1 FROM program_courses WHERE program_code = 'SMNS' AND course_id = 'course-ma110'").get());

  for (const id of ['law-course-content', 'law-only-general', 'snr-only-ma110']) {
    assert.equal(db.prepare('SELECT 1 FROM resources WHERE id = ?').get(id), undefined, `${id} should be deleted`);
  }
  assert.ok(db.prepare('SELECT 1 FROM resources WHERE id = ?').get('global-guide'), 'global content is kept');
  assert.deepEqual(
    db.prepare('SELECT program_code FROM resource_programs WHERE resource_id = ?').all('law-and-sict-guide')
      .map((row) => row.program_code),
    ['SICT'],
    'content with a remaining program audience is retained'
  );

  const second = pruneRetiredPrograms(db);
  assert.deepEqual(second.removedPrograms, [], 'cleanup is idempotent');

  // Remove test fixtures so the remaining tests see only the normal catalog.
  db.prepare("DELETE FROM resources WHERE id IN ('law-and-sict-guide', 'global-guide')").run();
  db.prepare("DELETE FROM users WHERE id = 'retired-user'").run();
  for (const id of ['course-law-seed', 'course-business-seed', 'course-snr-seed', 'course-sbe-seed']) {
    db.prepare('DELETE FROM program_courses WHERE course_id = ?').run(id);
    db.prepare('DELETE FROM courses WHERE id = ?').run(id);
  }
});

// ---- 4. Legacy excess seed rows are still pruned ---------------------------

test('legacy non-first-year seed courses are pruned, admin & content courses are not', () => {
  const now = new Date().toISOString();
  const legacy = ['EBA/B 250', 'ESQ 420', 'CS 280'];
  for (const code of legacy) {
    const id = `course-${courseCodeToSlug(code)}`;
    insertCourse(id, code);
    db.prepare('INSERT OR IGNORE INTO program_courses (program_code, course_id, sort_order) VALUES (?, ?, ?)')
      .run('SICT', id, 90);
  }

  insertCourse('course-admin-made', 'ES 999', 'Admin added course');
  db.prepare('INSERT OR IGNORE INTO program_courses (program_code, course_id, sort_order) VALUES (?, ?, ?)')
    .run('SICT', 'course-admin-made', 91);
  db.prepare('INSERT OR IGNORE INTO resources (id, title, category, course_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('legacy-resource', 'Old notes', 'document', `course-${courseCodeToSlug('ESQ 420')}`, now, now);

  const first = pruneLegacySeedCourses(db);
  assert.equal(first.removed, 2, 'empty legacy seed courses must be removed');
  assert.equal(first.kept, 1, 'a legacy course with content is kept, not silently deleted');

  const codes = db.prepare(`
    SELECT c.code FROM program_courses pc
    JOIN courses c ON c.id = pc.course_id
    WHERE pc.program_code = 'SICT'
  `).all().map((row) => row.code);
  assert.ok(!codes.includes('EBA/B 250'));
  assert.ok(!codes.includes('CS 280'));
  assert.ok(codes.includes('ES 999'), 'admin-created courses are never pruned');
  assert.ok(codes.includes('ESQ 420'), 'content-bearing courses are never pruned');
  for (const code of ['MA110', 'PH110', 'CS120', 'CS130', 'CS150']) {
    assert.ok(codes.includes(code), `${code} is a retained first-year course`);
  }

  const second = pruneLegacySeedCourses(db);
  assert.equal(second.removed, 0);

  db.prepare('DELETE FROM resources WHERE id = ?').run('legacy-resource');
  for (const id of [`course-${courseCodeToSlug('ESQ 420')}`, 'course-admin-made']) {
    db.prepare('DELETE FROM program_courses WHERE course_id = ?').run(id);
    db.prepare('DELETE FROM courses WHERE id = ?').run(id);
  }
});

test('each active program advertises its real first-year course count', async () => {
  const res = await call('GET', '/api/programs?counts=1');
  assert.equal(res.status, 200);
  for (const program of res.data.programs) {
    const expected = COURSE_CATALOG.filter((course) => course.programs.includes(program.code)).length;
    assert.equal(program.courseCount, expected);
    assert.ok(program.courseCount > 0 && program.courseCount <= 12);
  }
});
