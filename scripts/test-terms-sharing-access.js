'use strict';

// =============================================
// Regression suite for three linked rules:
//
//   1. TERMS — every revisable resource type (notes, tutorial sheets, past
//      papers, videos) is filed under Term 1/2/3 and served on term shelves.
//      Lab reports are exempt.
//
//   2. SHARING — School of Mines (SMMS) and Non-Quota (SMNS) pool their
//      content from a single upload, EXCEPT Biology (BI110) and Engineering
//      Drawing (ED). Pooling must never widen to an unrelated program.
//
//   3. ACCESS — past papers, notes and tutorial sheets are free forever (even
//      once a trial/subscription has ended); lab reports are the Premium
//      study material; videos and quizzes stay Premium-only.
// =============================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-terms-sharing-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  JWT_SECRET: 'test-only-studycore-terms-secret-0123456789',
  CONTENT_ADMIN_ACCESS_CODE: 'content-admin-test-access-code',
  ADMIN_EMAIL: '',
  ADMIN_PASSWORD: '',
  R2_ACCOUNT_ID: '',
  R2_BUCKET_NAME: '',
  SMTP_HOST: ''
});

const db = require('../db');
const app = require('../server');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
const { resolveCourse, coursesForProgram, programIncludesCourse } = require('../lib/program-access');
const sharing = require('../lib/program-sharing');
const terms = require('../lib/terms');
const accessPolicy = require('../lib/access-policy');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function cookieFor(user) {
  return `${COOKIE_NAME}=${createToken(user)}`;
}

async function call(method, pathname, { user, body } = {}) {
  const headers = {};
  if (user) headers.Cookie = cookieFor(user);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, text };
}

const DAY = 86400000;

function makeUser(overrides = {}) {
  const id = `u-${randomUUID()}`;
  const row = {
    id,
    name: 'Term Student',
    email: `${id}@studycore.test`,
    password: 'not-used',
    role: 'student',
    program_code: 'SMMS',
    subscription: 'premium',
    trial_end: new Date(Date.now() + DAY).toISOString(),
    subscription_end: new Date(Date.now() + DAY).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, program_code, subscription,
      trial_end, subscription_end, created_at)
    VALUES (@id, @name, @email, @password, @role, @program_code, @subscription,
      @trial_end, @subscription_end, @created_at)
  `).run(row);
  return row;
}

// A student whose trial AND subscription have both lapsed — the exact case
// the "free even when tier ends" rule exists for.
function makeExpiredStudent(programCode = 'SMMS') {
  return makeUser({
    program_code: programCode,
    subscription: 'free',
    subscription_end: new Date(Date.now() - DAY).toISOString(),
    trial_end: new Date(Date.now() - DAY).toISOString()
  });
}

function makeTrialStudent(programCode = 'SMMS') {
  return makeUser({
    program_code: programCode,
    subscription: 'trial',
    subscription_end: new Date(Date.now() - DAY).toISOString(),
    trial_end: new Date(Date.now() + DAY).toISOString()
  });
}

function addResource(overrides = {}, programs = []) {
  const id = `res-${randomUUID()}`;
  const now = new Date().toISOString();
  const row = {
    id,
    title: id,
    category: 'document',
    course_id: null,
    subject: null,
    topic: 'General',
    semester: null,
    target_all: 1,
    is_premium: 1,
    publish_status: 'published',
    created_at: now,
    updated_at: now,
    ...overrides
  };
  const columns = Object.keys(row);
  db.prepare(`
    INSERT INTO resources (${columns.join(', ')})
    VALUES (${columns.map((c) => `@${c}`).join(', ')})
  `).run(row);
  const link = db.prepare('INSERT INTO resource_programs (resource_id, program_code) VALUES (?, ?)');
  for (const program of programs) link.run(id, program);
  return row;
}

// ---------------------------------------------------------------------------
// 1. Terms
// ---------------------------------------------------------------------------

test('term labels normalize to one canonical form', () => {
  for (const input of ['Term 2', 'term2', 'TERM  2', 't2', '2', ' Term_2 ']) {
    assert.equal(terms.normalizeTerm(input), 'Term 2', `"${input}" must normalize`);
  }
  for (const input of ['', null, undefined, 'Term 4', 'semester 1', 'zero']) {
    assert.equal(terms.normalizeTerm(input), null, `"${input}" is not a term`);
  }
});

test('terms apply to notes, tutorials, past papers and videos but never to lab reports', () => {
  for (const category of ['document', 'tutorial', 'past_paper', 'video']) {
    assert.equal(terms.termAppliesTo(category), true, `${category} is termed`);
    assert.equal(terms.termRequiredFor(category, { courseId: 'course-x' }), true);
  }
  for (const category of ['lab_report', 'announcement', 'quiz']) {
    assert.equal(terms.termAppliesTo(category), false, `${category} is term-exempt`);
    assert.equal(terms.termRequiredFor(category, { courseId: 'course-x' }), false);
  }
  // A general, non-course resource has no term shelf, so the term stays optional.
  assert.equal(terms.termRequiredFor('document', { courseId: null }), false);
});

test('grouping keeps Term 1/2/3 order and collects untermed content under Other', () => {
  const grouped = terms.groupByTerm([
    { id: 'c', term: 'Term 3' },
    { id: 'a', term: 'Term 1' },
    { id: 'x', term: null },
    { id: 'b', term: 'term2' }
  ]);
  assert.deepEqual(grouped.map((g) => g.term), ['Term 1', 'Term 2', 'Term 3', 'Other']);
  assert.deepEqual(grouped.flatMap((g) => g.items.map((i) => i.id)), ['a', 'b', 'c', 'x']);
});

test('the course home returns term shelves for every revisable resource type', async () => {
  const course = resolveCourse('MA110');
  const student = makeUser({ program_code: 'SMMS' });
  addResource({ title: 'T1 notes', category: 'document', course_id: course.id, semester: 'Term 1' });
  addResource({ title: 'T3 paper', category: 'past_paper', course_id: course.id, semester: 'Term 3' });
  addResource({ title: 'T2 sheet', category: 'tutorial', course_id: course.id, semester: 'Term 2' });
  addResource({ title: 'Legacy note', category: 'document', course_id: course.id, semester: null });

  const home = await call('GET', `/api/programs/course/${course.slug}`, { user: student });
  assert.equal(home.status, 200, home.text);

  // Every term exists as a shelf even before anything is published into it.
  for (const key of ['notes', 'tutorials', 'pastPapers', 'lessons']) {
    const shelf = home.data.terms[key];
    assert.ok(Array.isArray(shelf), `${key} has term shelves`);
    assert.deepEqual(shelf.slice(0, 3).map((g) => g.term), terms.TERMS, `${key} keeps term order`);
  }

  const notesByTerm = Object.fromEntries(home.data.terms.notes.map((g) => [g.term, g.lessons.map((l) => l.title)]));
  assert.deepEqual(notesByTerm['Term 1'], ['T1 notes']);
  assert.deepEqual(notesByTerm['Term 2'], []);
  // Untermed legacy content is still reachable rather than silently dropped.
  assert.deepEqual(notesByTerm[terms.UNSCHEDULED_TERM], ['Legacy note']);

  const papersByTerm = Object.fromEntries(home.data.terms.pastPapers.map((g) => [g.term, g.lessons.map((l) => l.title)]));
  assert.deepEqual(papersByTerm['Term 3'], ['T3 paper']);
  const tutorialsByTerm = Object.fromEntries(home.data.terms.tutorials.map((g) => [g.term, g.lessons.map((l) => l.title)]));
  assert.deepEqual(tutorialsByTerm['Term 2'], ['T2 sheet']);
});

// ---------------------------------------------------------------------------
// 2. Mines ↔ Non-Quota sharing
// ---------------------------------------------------------------------------

test('Mines and Non-Quota are pooled; no other program is', () => {
  assert.deepEqual(sharing.sharedProgramCodes('SMMS'), ['SMNS']);
  assert.deepEqual(sharing.sharedProgramCodes('SMNS'), ['SMMS']);
  for (const code of ['LAW', 'BS', 'SNR', 'SICT', 'SBE']) {
    assert.deepEqual(sharing.sharedProgramCodes(code), [], `${code} pools with nobody`);
  }
});

test('Biology and Engineering Drawing never cross the sharing boundary', () => {
  assert.equal(sharing.isShareableCourse(resolveCourse('BI110')), false, 'Biology stays Non-Quota only');
  assert.equal(sharing.isShareableCourse(resolveCourse('ED')), false, 'Engineering Drawing stays Mines only');
  for (const code of ['MA110', 'PH110', 'CH110', 'CS110', 'LA111']) {
    assert.equal(sharing.isShareableCourse(resolveCourse(code)), true, `${code} is shared`);
  }
});

test('one upload for Mines reaches Non-Quota students, and vice versa', async () => {
  const course = resolveCourse('CH110');
  const mines = makeUser({ program_code: 'SMMS' });
  const nonQuota = makeUser({ program_code: 'SMNS' });

  const fromMines = addResource({
    title: 'Titration past paper', category: 'past_paper', course_id: course.id,
    semester: 'Term 1', target_all: 0
  }, ['SMMS']);
  const fromNonQuota = addResource({
    title: 'Bonding notes', category: 'document', course_id: course.id,
    semester: 'Term 2', target_all: 0
  }, ['SMNS']);

  for (const student of [mines, nonQuota]) {
    const home = await call('GET', `/api/programs/course/${course.slug}`, { user: student });
    assert.equal(home.status, 200, home.text);
    const titles = home.data.lessons.map((l) => l.title);
    assert.ok(titles.includes('Titration past paper'), 'the Mines upload is pooled');
    assert.ok(titles.includes('Bonding notes'), 'the Non-Quota upload is pooled');
  }

  // Only ONE row exists per upload — sharing is a visibility rule, not a copy.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM resources WHERE title = ?').get('Titration past paper').n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM resources WHERE title = ?').get('Bonding notes').n, 1);
  assert.ok(fromMines.id && fromNonQuota.id);
});

test('Biology and Engineering Drawing content stays with its own school', async () => {
  const biology = resolveCourse('BI110');
  const drawing = resolveCourse('ED');
  const mines = makeUser({ program_code: 'SMMS' });
  const nonQuota = makeUser({ program_code: 'SMNS' });

  addResource({
    title: 'Cell structure notes', category: 'document', course_id: biology.id,
    semester: 'Term 1', target_all: 0
  }, ['SMNS']);
  addResource({
    title: 'Orthographic projection notes', category: 'document', course_id: drawing.id,
    semester: 'Term 1', target_all: 0
  }, ['SMMS']);

  // Non-Quota keeps Biology; Mines is refused it outright.
  const nqBiology = await call('GET', `/api/programs/course/${biology.slug}`, { user: nonQuota });
  assert.equal(nqBiology.status, 200);
  assert.ok(nqBiology.data.lessons.some((l) => l.title === 'Cell structure notes'));
  assert.equal((await call('GET', `/api/programs/course/${biology.slug}`, { user: mines })).status, 403,
    'a Mines student must not reach Biology');

  // Mines keeps Engineering Drawing; Non-Quota is refused it outright.
  const minesDrawing = await call('GET', `/api/programs/course/${drawing.slug}`, { user: mines });
  assert.equal(minesDrawing.status, 200);
  assert.ok(minesDrawing.data.lessons.some((l) => l.title === 'Orthographic projection notes'));
  assert.equal((await call('GET', `/api/programs/course/${drawing.slug}`, { user: nonQuota })).status, 403,
    'a Non-Quota student must not reach Engineering Drawing');

  assert.equal(programIncludesCourse('SMMS', biology.id), false);
  assert.equal(programIncludesCourse('SMNS', drawing.id), false);
});

test('pooling never widens to an unrelated program', async () => {
  const course = resolveCourse('MA110');
  const law = makeUser({ program_code: 'LAW' });
  addResource({
    title: 'Mines calculus sheet', category: 'tutorial', course_id: course.id,
    semester: 'Term 1', target_all: 0
  }, ['SMMS']);

  // LAW does not teach MA110 at all, so the course itself is refused.
  assert.equal((await call('GET', `/api/programs/course/${course.slug}`, { user: law })).status, 403);
  const list = await call('GET', '/api/resources?search=Mines%20calculus', { user: law });
  assert.equal(list.status, 200, list.text);
  assert.equal(list.data.resources.length, 0, 'a Law student never receives pooled Mines content');
});

test('a Law-targeted resource on a shared course does not leak to the pooled schools', async () => {
  const course = resolveCourse('MA110');
  const mines = makeUser({ program_code: 'SMMS' });
  const nonQuota = makeUser({ program_code: 'SMNS' });
  addResource({
    title: 'Law-only maths primer', category: 'document', course_id: course.id,
    semester: 'Term 1', target_all: 0
  }, ['LAW']);

  for (const student of [mines, nonQuota]) {
    const list = await call('GET', '/api/resources?search=Law-only', { user: student });
    assert.equal(list.data.resources.length, 0,
      'sharing a course must not turn another program\'s targeting into a grant');
  }
});

test('the student course list pools the partner school\'s shareable courses only', () => {
  const minesCourses = coursesForProgram('SMMS').map((c) => c.code);
  const nonQuotaCourses = coursesForProgram('SMNS').map((c) => c.code);

  assert.ok(minesCourses.includes('ED'), 'Mines keeps Engineering Drawing');
  assert.ok(!minesCourses.includes('BI110'), 'Mines never receives Biology');
  assert.ok(nonQuotaCourses.includes('BI110'), 'Non-Quota keeps Biology');
  assert.ok(!nonQuotaCourses.includes('ED'), 'Non-Quota never receives Engineering Drawing');
  for (const shared of ['CH110', 'MA110', 'PH110', 'CS110', 'LA111']) {
    assert.ok(minesCourses.includes(shared) && nonQuotaCourses.includes(shared), `${shared} is in both`);
  }
});

// ---------------------------------------------------------------------------
// 3. Free vs Premium
// ---------------------------------------------------------------------------

test('the access policy keeps study material free and lab reports premium', () => {
  const expired = { premium: false, trial: false };
  const trial = { premium: false, trial: true };
  const premium = { premium: true, trial: false };

  for (const category of ['past_paper', 'document', 'tutorial']) {
    // is_premium = 1 on the row is deliberately ignored for these categories,
    // so historical uploads become free with no data migration.
    const row = { category, is_premium: 1 };
    assert.equal(accessPolicy.canAccessResource(row, expired), true, `${category} stays free after the tier ends`);
    assert.equal(accessPolicy.canAccessResource(row, trial), true);
    assert.equal(accessPolicy.canAccessResource(row, premium), true);
    assert.equal(accessPolicy.lockReasonForResource(row, expired), null);
  }

  const lab = { category: 'lab_report', is_premium: 1 };
  assert.equal(accessPolicy.canAccessResource(lab, expired), false, 'lab reports lock when the tier ends');
  assert.equal(accessPolicy.canAccessResource(lab, trial), true, 'the trial opens lab reports');
  assert.equal(accessPolicy.canAccessResource(lab, premium), true);
  assert.equal(accessPolicy.lockReasonForResource(lab, expired), 'lab_report');

  const video = { category: 'video', is_premium: 1 };
  assert.equal(accessPolicy.canAccessResource(video, trial), false, 'videos stay Premium-only');
  assert.equal(accessPolicy.canAccessResource(video, premium), true);
});

test('uploads get the policy premium flag regardless of what is requested', () => {
  for (const category of ['past_paper', 'document', 'tutorial']) {
    assert.equal(accessPolicy.resolvePremiumFlag(category, 'true'), 0, `${category} publishes free`);
    assert.equal(accessPolicy.resolvePremiumFlag(category, undefined), 0);
  }
  assert.equal(accessPolicy.resolvePremiumFlag('lab_report', 'false'), 1, 'lab reports publish premium');
  // Categories the policy does not name keep honouring the admin's choice.
  assert.equal(accessPolicy.resolvePremiumFlag('video', 'false'), 0);
  assert.equal(accessPolicy.resolvePremiumFlag('video', undefined), 1);
});

test('an expired student still opens notes, tutorials and past papers but not lab reports', async () => {
  const course = resolveCourse('PH110');
  const expired = makeExpiredStudent('SMMS');

  const free = [
    addResource({ title: 'Free paper', category: 'past_paper', course_id: course.id, semester: 'Term 1', is_premium: 1 }),
    addResource({ title: 'Free notes', category: 'document', course_id: course.id, semester: 'Term 1', is_premium: 1 }),
    addResource({ title: 'Free sheet', category: 'tutorial', course_id: course.id, semester: 'Term 2', is_premium: 1 })
  ];
  const lab = addResource({
    title: 'Premium lab report', category: 'lab_report', course_id: course.id,
    subject: 'Physics', is_premium: 1, target_all: 0
  }, ['SMMS']);

  for (const row of free) {
    const detail = await call('GET', `/api/resources/${row.id}`, { user: expired });
    assert.equal(detail.status, 200, `${row.title} must stay readable: ${detail.text}`);
  }

  const locked = await call('GET', `/api/resources/${lab.id}`, { user: expired });
  assert.equal(locked.status, 403, 'lab reports lock once the tier ends');
  assert.equal(locked.data.lockReason, 'lab_report');

  // The course home agrees with the detail endpoint.
  const home = await call('GET', `/api/programs/course/${course.slug}`, { user: expired });
  assert.equal(home.status, 200, home.text);
  for (const item of home.data.lessons.filter((l) => ['past_paper', 'document', 'tutorial'].includes(l.category))) {
    assert.equal(item.locked, undefined, `${item.title} must not be locked`);
  }
  const labCard = home.data.labReports.find((l) => l.id === lab.id);
  assert.ok(labCard, 'the lab report is still listed');
  assert.equal(labCard.locked, 'lab_report', 'but it is shown as locked');
});

test('a trial student opens lab reports, and loses them when the trial ends', async () => {
  const course = resolveCourse('PH110');
  const lab = addResource({
    title: 'Trial-visible lab report', category: 'lab_report', course_id: course.id,
    subject: 'Physics', is_premium: 1, target_all: 0
  }, ['SMMS']);

  const trial = makeTrialStudent('SMMS');
  assert.equal((await call('GET', `/api/resources/${lab.id}`, { user: trial })).status, 200,
    'the trial opens lab reports');

  // End the trial on the server; the very next request must lock it.
  db.prepare('UPDATE users SET trial_end = ? WHERE id = ?')
    .run(new Date(Date.now() - DAY).toISOString(), trial.id);
  const after = await call('GET', `/api/resources/${lab.id}`, { user: trial });
  assert.equal(after.status, 403, 'the lab report locks the moment the trial lapses');
  assert.equal(after.data.lockReason, 'lab_report');
});

test('publishing through the admin API applies the free/premium policy', async () => {
  const admin = makeUser({ role: 'admin', program_code: null });
  const course = resolveCourse('MA110');

  for (const [category, expectedPremium] of [['past_paper', 0], ['document', 0], ['tutorial', 0]]) {
    const created = await call('POST', '/api/admin/resources', {
      user: admin,
      body: {
        title: `${category} policy check`,
        category,
        courseId: course.id,
        semester: 'Term 1',
        // Deliberately ask for premium: the policy must overrule it.
        isPremium: 'true',
        targetAll: true
      }
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.data.resource.isPremium, false, `${category} must publish as free`);
    assert.equal(
      db.prepare('SELECT is_premium FROM resources WHERE id = ?').get(created.data.resource.id).is_premium,
      expectedPremium
    );
  }

  // A lab report asked to be free still publishes premium.
  const lab = await call('POST', '/api/admin/resources', {
    user: admin,
    body: {
      title: 'Lab policy check',
      category: 'lab_report',
      courseId: resolveCourse('PH110').id,
      subject: 'Physics',
      isPremium: 'false',
      programs: ['SMMS'],
      targetAll: false
    }
  });
  assert.equal(lab.status, 201, lab.text);
  assert.equal(lab.data.resource.isPremium, true, 'lab reports must publish as premium');
});

test('a course-bound upload without a term is refused, and lab reports are exempt', async () => {
  const admin = makeUser({ role: 'admin', program_code: null });
  const course = resolveCourse('MA110');

  const missingTerm = await call('POST', '/api/admin/resources', {
    user: admin,
    body: { title: 'No term paper', category: 'past_paper', courseId: course.id, targetAll: true }
  });
  assert.equal(missingTerm.status, 400, missingTerm.text);
  assert.match(missingTerm.data.message, /Term 1, Term 2, or Term 3/);

  // Lab reports never carry a term, so they publish without one.
  const lab = await call('POST', '/api/admin/resources', {
    user: admin,
    body: {
      title: 'Termless lab report', category: 'lab_report',
      courseId: resolveCourse('CH110').id, subject: 'Chemistry',
      programs: ['SMMS'], targetAll: false
    }
  });
  assert.equal(lab.status, 201, lab.text);
  assert.equal(db.prepare('SELECT semester FROM resources WHERE id = ?').get(lab.data.resource.id).semester, null);
});

test('a loosely-typed term is stored in canonical form', async () => {
  const admin = makeUser({ role: 'admin', program_code: null });
  const created = await call('POST', '/api/admin/resources', {
    user: admin,
    body: {
      title: 'Sloppy term notes', category: 'document',
      courseId: resolveCourse('MA110').id, semester: 'term 3', targetAll: true
    }
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(
    db.prepare('SELECT semester FROM resources WHERE id = ?').get(created.data.resource.id).semester,
    'Term 3'
  );
});
