'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-lab-reports-'));
process.env.DATA_DIR = testDataDir;
process.env.JWT_SECRET = 'test-only-studycore-lab-report-secret-0123456789';
process.env.CONTENT_ADMIN_ACCESS_CODE = 'content-admin-test-access-code';

const db = require('../db');
const app = require('../server');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
const { canUseLabReports, validateLabReportPlacement } = require('../lib/lab-reports');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

function makeStudent(programCode) {
  const now = new Date().toISOString();
  const user = {
    id: `lab-student-${programCode.toLowerCase()}`,
    name: `${programCode} Lab Student`,
    email: `lab-${programCode.toLowerCase()}@test.studycore`,
    password: 'not-used',
    role: 'student',
    program_code: programCode,
    subscription: 'premium',
    subscription_start: now,
    subscription_end: new Date(Date.now() + 86400000).toISOString(),
    trial_end: new Date(Date.now() + 86400000).toISOString(),
    created_at: now
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, program_code, subscription,
      subscription_start, subscription_end, trial_end, created_at)
    VALUES (@id, @name, @email, @password, @role, @program_code, @subscription,
      @subscription_start, @subscription_end, @trial_end, @created_at)
  `).run(user);
  return user;
}

function cookieFor(user) {
  return `${COOKIE_NAME}=${createToken(user)}`;
}

function addLabReport(id, courseCode, programs) {
  const course = db.prepare('SELECT * FROM courses WHERE code = ?').get(courseCode);
  assert.ok(course, `${courseCode} must be seeded`);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO resources (id, title, category, resource_type, course_id, subject, topic,
      publish_status, target_all, is_premium, created_at, updated_at)
    VALUES (?, ?, 'lab_report', 'Lab Report', ?, ?, 'Practical work', 'published', 0, 0, ?, ?)
  `).run(id, `${courseCode} laboratory report`, course.id, course.subject, now, now);
  const insertTarget = db.prepare('INSERT INTO resource_programs (resource_id, program_code) VALUES (?, ?)');
  for (const program of programs) insertTarget.run(id, program);
}

async function courseHome(user, slug) {
  const response = await fetch(`${baseUrl}/api/programs/course/${slug}`, {
    headers: { Cookie: cookieFor(user) }
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}

test('lab-report eligibility matches the requested schools and sciences', () => {
  const physics = { subject: 'Physics' };
  const chemistry = { subject: 'Chemistry' };
  const mathematics = { subject: 'Mathematics' };

  for (const program of ['SMMS', 'SMNS', 'SNR']) {
    assert.equal(canUseLabReports(program, physics), true);
    assert.equal(canUseLabReports(program, chemistry), true);
  }
  assert.equal(canUseLabReports('SICT', physics), true);
  assert.equal(canUseLabReports('SICT', chemistry), false);
  assert.equal(canUseLabReports('SMMS', mathematics), false);
  assert.ok(validateLabReportPlacement(['SICT'], chemistry));
  assert.ok(validateLabReportPlacement([], physics), 'All Programs must not be accepted');
});

test('eligible course APIs expose the dedicated lab-report slot and resources only there', async () => {
  addLabReport('lab-physics', 'PH110', ['SMMS', 'SMNS', 'SNR', 'SICT']);
  addLabReport('lab-chemistry-mines', 'CH110', ['SMMS', 'SMNS']);
  addLabReport('lab-chemistry-snr', 'CH130', ['SNR']);

  const students = Object.fromEntries(['SMMS', 'SMNS', 'SNR', 'SICT'].map((code) => [code, makeStudent(code)]));
  for (const code of Object.keys(students)) {
    const physics = await courseHome(students[code], 'ph110');
    assert.equal(physics.labReportsEnabled, true, `${code} Physics needs the slot`);
    assert.deepEqual(physics.labReports.map((item) => item.id), ['lab-physics']);
  }

  for (const code of ['SMMS', 'SMNS']) {
    const chemistry = await courseHome(students[code], 'ch110');
    assert.equal(chemistry.labReportsEnabled, true);
    assert.deepEqual(chemistry.labReports.map((item) => item.id), ['lab-chemistry-mines']);
  }
  const snrChemistry = await courseHome(students.SNR, 'ch130');
  assert.equal(snrChemistry.labReportsEnabled, true);
  assert.deepEqual(snrChemistry.labReports.map((item) => item.id), ['lab-chemistry-snr']);

  const sictMaths = await courseHome(students.SICT, 'ma110');
  assert.equal(sictMaths.labReportsEnabled, false, 'SICT must get the slot for Physics only');
  assert.deepEqual(sictMaths.labReports, []);
});

test('course page and both upload workflows include Lab Report support', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('views/course.html'), /id="lab-reports"[^>]*hidden/);
  assert.match(read('public/js/program-course.js'), /data\.labReportsEnabled/);
  assert.match(read('views/content-admin.html'), /value="lab_report">Lab Report/);
  assert.match(read('views/admin.html'), /value="lab_report">Lab Report/);
});
