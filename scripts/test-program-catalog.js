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
const { PROGRAM_CATALOG, COURSE_CATALOG, courseCodeToSlug } = require('../lib/programs');
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
  // to number courses the same way or a program with a large catalog (the
  // School of the Built Environment has 118) falls back to an alphabetical
  // sort and buries its shared first year.
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

  // The shared ES 1xx first year plus one course from each of the five
  // degrees CBU runs in the school.
  for (const code of [
    'ES 100',   // shared first year — Studio Project
    'ES 142',   // shared first year — Communication Skills
    'ESA 300',  // Bachelor of Architecture
    'ESB 420',  // BSc Construction Management
    'ESQ 420',  // BSc Quantity Surveying
    'ESR 350',  // BSc Real Estate Studies
    'ESP 440'   // BSc Urban and Regional Planning
  ]) {
    assert.ok(codes.includes(code), `SBE course list is missing ${code}; got: ${codes.join(', ')}`);
  }

  // Every course is reachable by its slug, including the codes CBU writes with
  // a programme letter and a slash (ESA/B 200 -> esab200), which cannot be
  // addressed by code in a URL.
  for (const code of ['ES 100', 'ESA/B 200', 'ES A/B 310', 'ESB/Q 250', 'ESQ 420']) {
    const slug = courseCodeToSlug(code);
    const page = await call('GET', `/api/programs/course/${slug}`, { cookie: cookieFor(student) });
    assert.equal(page.status, 200, `SBE student must be able to open ${code} (${slug}): ${JSON.stringify(page.data)}`);
    assert.equal(page.data.course.code, code);
  }
});

test('built-environment courses stay gated to Built Environment students', async () => {
  const sbe = await makeStudent('Bea Two', 'bea2@catalog-test.com', 'SBE');
  const law = await makeStudent('Lex Three', 'lex3@catalog-test.com', 'LAW');

  // A Law student must not be able to walk into a quantity-surveying course.
  const lawSeesQs = await call('GET', '/api/programs/course/esq420', { cookie: cookieFor(law) });
  assert.equal(lawSeesQs.status, 403, `LAW student opening ESQ 420 must be refused, got ${lawSeesQs.status}`);

  // ...and an SBE student must not walk into the law library either.
  const sbeSeesLaw = await call('GET', '/api/programs/course/ls110', { cookie: cookieFor(sbe) });
  assert.equal(sbeSeesLaw.status, 403, `SBE student opening LS110 must be refused, got ${sbeSeesLaw.status}`);

  // Shared foundation courses still work across the programs that teach them:
  // MA 210 is seeded for SICT, and MA110 for the Mines/Non-Quota/SNR group.
  const sict = await makeStudent('Cy Four', 'cy4@catalog-test.com', 'SICT');
  const sictMine = await call('GET', '/api/programs/mine', { cookie: cookieFor(sict) });
  const sictCodes = sictMine.data.courses.map((c) => c.code);
  assert.ok(sictCodes.includes('CS 250'), `SICT must expose CBU's BSc Computer Science courses, got: ${sictCodes.join(', ')}`);
  const sictOpens = await call('GET', `/api/programs/course/${courseCodeToSlug('CS 250')}`, { cookie: cookieFor(sict) });
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
