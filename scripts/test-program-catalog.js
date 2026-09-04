'use strict';

// Regression tests for the seeded CBU program/course catalog.
//
// The catalog in lib/programs.js only SEEDS the database on first boot, but
// it is still the shape of a fresh install, and three things have to stay in
// step or a fresh deploy is quietly broken:
//   1. the catalog itself must be internally consistent — a duplicate course
//      code would collide on courses.code (UNIQUE) and a duplicate slug on
//      courses.slug (UNIQUE), so seeding would throw on boot;
//   2. every seeded course must be linked to a program that exists, otherwise
//      the program_courses insert fails its FK and the course is orphaned;
//   3. public/js/programs.js mirrors the catalog client-side for labels,
//      icons and the admin filter chips — a program added to the backend but
//      not to the mirror renders as its raw code and gets no filter chip.
//
// These tests boot the real database, seed through the real
// seedProgramCatalog() and then talk to the real API over HTTP.

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

const db = require('../db');
const { PROGRAM_CATALOG, COURSE_CATALOG, courseCodeToSlug, pruneLegacySeedCourses } = require('../lib/programs');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
// server.js exports its production app without binding a port when required,
// so this suite exercises the real API middleware end to end.
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
  return `${COOKIE_NAME}=${createToken(user)}`;
}

async function makeStudent(name, email, program) {
  const res = await call('POST', '/api/auth/register', {
    body: { name, email, password: 'student-pass-1', program }
  });
  assert.equal(res.status, 201, `register ${email} (program ${program}): ${JSON.stringify(res.data)}`);
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

// The client-side mirror is an IIFE that only touches `window`, so it can be
// evaluated in a sandbox exactly as the browser would run it.
function loadClientProgramHelpers() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'programs.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'public/js/programs.js' });
  assert.ok(sandbox.window.SCPrograms, 'public/js/programs.js must expose window.SCPrograms');
  return sandbox.window.SCPrograms;
}

// ---- 1. The catalog is internally consistent ------------------------------

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

test('every seeded course belongs only to seeded programs', () => {
  const known = new Set(PROGRAM_CATALOG.map((p) => p.code));
  for (const course of COURSE_CATALOG) {
    assert.ok(Array.isArray(course.programs) && course.programs.length,
      `${course.code} must be attached to at least one program`);
    for (const code of course.programs) {
      assert.ok(known.has(code), `${course.code} references unknown program ${code}`);
    }
  }
});

test('seeding produced one program_courses row per catalog assignment', () => {
  const expected = COURSE_CATALOG.reduce((n, c) => n + c.programs.length, 0);
  const actual = db.prepare('SELECT COUNT(*) c FROM program_courses').get().c;
  assert.equal(actual, expected, 'program_courses rows must match the catalog exactly');

  // No orphaned links (the FK is only enforced when the row is written).
  const orphaned = db.prepare(`
    SELECT COUNT(*) c FROM program_courses pc
    LEFT JOIN programs p ON p.code = pc.program_code
    LEFT JOIN courses c ON c.id = pc.course_id
    WHERE p.code IS NULL OR c.id IS NULL
  `).get().c;
  assert.equal(orphaned, 0, 'every program_courses row must resolve to a program and a course');

  // Course ids/slugs on disk are derived from the code the same way the API
  // resolves them, so /course/<slug> keeps working after a re-seed.
  for (const row of db.prepare('SELECT code, slug FROM courses').all()) {
    assert.equal(row.slug, courseCodeToSlug(row.code), `slug drift for ${row.code}`);
  }
});

test('courses keep catalog order inside each program', () => {
  // The admin UI appends new courses at MAX(sort_order) + 1, so the seed has
  // to number courses the same way or a program falls back to an alphabetical
  // sort and buries its shared first-year block.
  const byProgram = new Map();
  for (const course of COURSE_CATALOG) {
    for (const programCode of course.programs) {
      if (!byProgram.has(programCode)) byProgram.set(programCode, []);
      byProgram.get(programCode).push(course.code);
    }
  }
  for (const [programCode, expected] of byProgram) {
    const actual = db.prepare(`
      SELECT c.code FROM program_courses pc
      JOIN courses c ON c.id = pc.course_id
      WHERE pc.program_code = ?
      ORDER BY pc.sort_order ASC, c.code ASC
    `).all(programCode).map((r) => r.code);
    assert.deepEqual(actual, expected, `${programCode} course order must match the catalog`);
  }

  // Concretely: a Built Environment first year opens on the shared ES 1xx
  // foundation block, not on "EBA/B 250 Building Economics for Architects".
  const first = db.prepare(`
    SELECT c.code FROM program_courses pc
    JOIN courses c ON c.id = pc.course_id
    WHERE pc.program_code = 'SBE'
    ORDER BY pc.sort_order ASC, c.code ASC LIMIT 3
  `).all().map((r) => r.code);
  assert.deepEqual(first, ['ES 100', 'ES 110', 'ES 120']);
});

// ---- 2. The School of the Built Environment is live -----------------------

test('the School of the Built Environment is seeded and advertised publicly', async () => {
  const row = db.prepare('SELECT * FROM programs WHERE code = ?').get('SBE');
  assert.ok(row, 'SBE must exist in the programs table after seeding');
  assert.equal(row.name, 'School of the Built Environment');

  const res = await call('GET', '/api/programs');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const sbe = res.data.programs.find((p) => p.code === 'SBE');
  assert.ok(sbe, `SBE must appear on the public program directory: ${JSON.stringify(res.data.programs.map((p) => p.code))}`);
  assert.equal(sbe.shortName, 'Built Environment');
  assert.equal(sbe.icon, 'home');
  assert.ok(/Built Environment/.test(sbe.description), 'SBE needs a real description on signup');
});

test('a Built Environment student gets the CBU built-environment course list', async () => {
  const student = await makeStudent('Bea Surveyor', 'bea@catalog-test.com', 'SBE');
  assert.equal(student.program_code, 'SBE');

  const mine = await call('GET', '/api/programs/mine', { cookie: cookieFor(student) });
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.equal(mine.data.program.code, 'SBE');

  const codes = mine.data.courses.map((c) => c.code);
  const expectedCount = COURSE_CATALOG.filter((c) => c.programs.includes('SBE')).length;
  assert.equal(codes.length, expectedCount,
    `SBE should expose every seeded built-environment course (${expectedCount}), got ${codes.length}`);

  // The shared ES 1xx first-year block — the only courses CBU seeds for SBE.
  // (The degree-specific second- to fifth-year courses are deliberately not
  // seeded; the admin adds them per programme from the dashboard.)
  for (const code of [
    'ES 100',   // Studio Project
    'ES 110',   // Built Environment
    'ES 120',   // Introduction to Economics
    'ES 130',   // Introduction to Physical and Human Geography
    'ES 141',   // Introduction to Sociology
    'ES 142',   // Communication Skills
    'ES 150'    // Mathematics
  ]) {
    assert.ok(codes.includes(code), `SBE course list is missing ${code}; got: ${codes.join(', ')}`);
  }

  // Every seeded first-year course is reachable by its slug.
  for (const code of ['ES 100', 'ES 110', 'ES 120', 'ES 141', 'ES 142', 'ES 150']) {
    const slug = courseCodeToSlug(code);
    const page = await call('GET', `/api/programs/course/${slug}`, { cookie: cookieFor(student) });
    assert.equal(page.status, 200, `SBE student must be able to open ${code} (${slug}): ${JSON.stringify(page.data)}`);
    assert.equal(page.data.course.code, code);
  }
});

test('built-environment courses stay gated to Built Environment students', async () => {
  const sbe = await makeStudent('Bea Two', 'bea2@catalog-test.com', 'SBE');
  const law = await makeStudent('Lex Three', 'lex3@catalog-test.com', 'LAW');

  // A Law student must not be able to walk into a Built Environment course.
  const lawSeesSbe = await call('GET', '/api/programs/course/es150', { cookie: cookieFor(law) });
  assert.equal(lawSeesSbe.status, 403, `LAW student opening ES 150 must be refused, got ${lawSeesSbe.status}`);

  // ...and an SBE student must not walk into the law library either.
  const sbeSeesLaw = await call('GET', '/api/programs/course/ls110', { cookie: cookieFor(sbe) });
  assert.equal(sbeSeesLaw.status, 403, `SBE student opening LS110 must be refused, got ${sbeSeesLaw.status}`);

  // Shared foundation courses still work across the programs that teach them:
  // MA110 is a first-year foundation shared by SICT and the Mines/Non-Quota
  // group.
  const sict = await makeStudent('Cy Four', 'cy4@catalog-test.com', 'SICT');
  const sictMine = await call('GET', '/api/programs/mine', { cookie: cookieFor(sict) });
  const sictCodes = sictMine.data.courses.map((c) => c.code);
  assert.ok(sictCodes.includes('CS120'), `SICT must expose CBU's first-year courses, got: ${sictCodes.join(', ')}`);
  const sictOpens = await call('GET', `/api/programs/course/${courseCodeToSlug('CS120')}`, { cookie: cookieFor(sict) });
  assert.equal(sictOpens.status, 200, JSON.stringify(sictOpens.data));
});

// ---- 3. The client-side mirror has not drifted ---------------------------

test('public/js/programs.js mirrors every seeded program', () => {
  const SCPrograms = loadClientProgramHelpers();

  for (const program of PROGRAM_CATALOG) {
    const meta = SCPrograms.PROGRAM_META[program.code];
    assert.ok(meta, `PROGRAM_META is missing ${program.code} — the UI would render the raw code`);
    assert.equal(meta.name, program.name, `${program.code} name drift`);
    assert.equal(meta.shortName, program.shortName, `${program.code} shortName drift`);
    assert.equal(meta.icon, program.icon, `${program.code} icon drift`);
    assert.equal(meta.groupName || null, program.groupName || null, `${program.code} groupName drift`);
    assert.equal(SCPrograms.programName(program.code), program.name);
    assert.equal(SCPrograms.programIcon(program.code), program.icon);
  }

  // The admin filter chips are generated from FILTER_ORDER, so a program
  // missing from it can never be filtered on. Copied into a host-realm array
  // because the sandbox has its own Array prototype.
  assert.deepEqual(
    [...SCPrograms.FILTER_ORDER],
    PROGRAM_CATALOG.map((p) => p.code),
    'FILTER_ORDER must list the seeded programs in catalog order'
  );
});

test('the client mirror resolves built-environment course links by slug', () => {
  const SCPrograms = loadClientProgramHelpers();
  const slug = courseCodeToSlug('ES A/B 310');
  assert.equal(slug, 'esab310');
  assert.equal(SCPrograms.courseHref({ code: 'ES A/B 310', slug }), '/course/esab310');
  assert.equal(
    SCPrograms.courseLabel({ code: 'ESQ 420', name: 'Theory and Practice of Quantity Surveying' }),
    'ESQ 420 — Theory and Practice of Quantity Surveying'
  );
});

// ---- 4. Legacy multi-year seed rows are pruned on boot --------------------
//
// Seeding is INSERT OR IGNORE, so an existing deployment keeps every course an
// earlier build seeded — which is why the live site still advertised 31
// Business Studies, 118 Built Environment and 45 SICT courses for a first
// year. pruneLegacySeedCourses() removes those stale seed rows on boot.

test('legacy non-first-year seed courses are pruned, admin & content courses are not', () => {
  const now = new Date().toISOString();
  const legacy = ['EBA/B 250', 'ESQ 420', 'CS 280'];
  for (const code of legacy) {
    const id = `course-${courseCodeToSlug(code)}`;
    db.prepare('INSERT OR IGNORE INTO courses (id, code, slug, name, icon, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, code, courseCodeToSlug(code), code, 'book-open', null, now);
    db.prepare('INSERT OR IGNORE INTO program_courses (program_code, course_id, sort_order) VALUES (?, ?, ?)')
      .run('SBE', id, 90);
  }
  // An admin-created course (uuid id) must survive untouched.
  db.prepare('INSERT OR IGNORE INTO courses (id, code, slug, name, icon, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('course-admin-made', 'ES 999', 'es999', 'Admin added course', 'book-open', null, now);
  db.prepare('INSERT OR IGNORE INTO program_courses (program_code, course_id, sort_order) VALUES (?, ?, ?)')
    .run('SBE', 'course-admin-made', 91);
  // A legacy course that already holds content must survive too.
  db.prepare('INSERT OR IGNORE INTO resources (id, title, category, course_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('legacy-resource', 'Old notes', 'notes', `course-${courseCodeToSlug('ESQ 420')}`, now, now);

  const first = pruneLegacySeedCourses(db);
  assert.equal(first.removed, 2, 'empty legacy seed courses must be removed');
  assert.equal(first.kept, 1, 'a legacy course with content is kept, not silently deleted');

  const codes = db.prepare(`
    SELECT c.code FROM program_courses pc
    JOIN courses c ON c.id = pc.course_id
    WHERE pc.program_code = 'SBE'
  `).all().map((r) => r.code);
  assert.ok(!codes.includes('EBA/B 250'));
  assert.ok(!codes.includes('CS 280'));
  assert.ok(codes.includes('ES 999'), 'admin-created courses are never pruned');
  assert.ok(codes.includes('ESQ 420'), 'content-bearing courses are never pruned');
  for (const code of ['ES 100', 'ES 110', 'ES 150']) {
    assert.ok(codes.includes(code), `${code} is first year and must stay`);
  }

  // Idempotent: a second pass on the same database changes nothing more.
  const second = pruneLegacySeedCourses(db);
  assert.equal(second.removed, 0);

  // Clean up the fixtures this test introduced so it does not affect others.
  db.prepare('DELETE FROM resources WHERE id = ?').run('legacy-resource');
  for (const id of [`course-${courseCodeToSlug('ESQ 420')}`, 'course-admin-made']) {
    db.prepare('DELETE FROM program_courses WHERE course_id = ?').run(id);
    db.prepare('DELETE FROM courses WHERE id = ?').run(id);
  }
});

test('every program advertises a believable first-year course count', async () => {
  const res = await call('GET', '/api/programs?counts=1');
  assert.equal(res.status, 200);
  for (const p of res.data.programs) {
    const expected = COURSE_CATALOG.filter((c) => c.programs.includes(p.code)).length;
    assert.equal(p.courseCount, expected,
      `${p.code} advertises ${p.courseCount} courses but the first-year catalog has ${expected}`);
    assert.ok(p.courseCount > 0 && p.courseCount <= 12,
      `${p.code} course count ${p.courseCount} is not a first-year workload`);
  }
});
