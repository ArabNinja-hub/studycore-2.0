'use strict';

// Regression tests: the program catalog is DYNAMIC. Main Admin can create
// new programs at runtime (POST /api/programs/admin) and the UI advertises
// them on signup and in the targeting pickers. Program validation must
// therefore check the live programs table, not the six codes that seed a
// fresh install — otherwise:
//   1. students can never enroll in an admin-created program, and
//   2. content explicitly targeted at it is silently re-targeted to
//      "All Programs", leaking it to every other program's students.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-program-targeting-'));
process.env.DATA_DIR = testDataDir;
process.env.ADMIN_EMAIL = 'admin@targeting-test.com';
process.env.ADMIN_PASSWORD = 'Targeting-Pass-1';
// Mandatory startup secrets (no dev fallbacks) - test-only values.
process.env.JWT_SECRET = 'test-only-studycore-jwt-secret-0123456789';
process.env.CONTENT_ADMIN_ACCESS_CODE = 'content-admin-test-access-code';

const db = require('../db');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
const { ROLES } = require('../lib/roles');
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

async function adminCookie() {
  const admin = db.prepare(`SELECT * FROM users WHERE role = '${ROLES.ADMIN}' LIMIT 1`).get();
  return cookieFor(admin);
}

async function makeStudent(name, email, program) {
  const res = await call('POST', '/api/auth/register', {
    body: { name, email, password: 'student-pass-1', program }
  });
  assert.equal(res.status, 201, `register ${email} (program ${program}): ${JSON.stringify(res.data)}`);
  return res.data.user;
}

test('students can enroll in an admin-created program at registration', async () => {
  const admin = await adminCookie();
  const created = await call('POST', '/api/programs/admin', {
    cookie: admin,
    body: { code: 'MED', name: 'School of Medicine' }
  });
  assert.equal(created.status, 201, `admin creates program MED: ${JSON.stringify(created.data)}`);

  // A student picks the brand-new program exactly like the signup page does.
  const student = await makeStudent('Medic One', 'medic1@targeting-test.com', 'MED');
  assert.equal(student.program, 'MED');

  // The same student can later switch to another admin-created program.
  await call('POST', '/api/programs/admin', {
    cookie: admin,
    body: { code: 'ENG', name: 'School of Engineering' }
  });
  const userRow = db.prepare('SELECT * FROM users WHERE email = ?').get('medic1@targeting-test.com');
  const switched = await call('PUT', '/api/auth/program', {
    cookie: cookieFor(userRow),
    body: { program: 'eng' } // lower-case on purpose — must normalize
  });
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.equal(switched.data.user.program, 'ENG');
});

test('content targeted at an admin-created program stays hidden from other programs', async () => {
  const admin = await adminCookie();

  // "MED only" — the exact payload the admin upload form sends.
  const upload = await call('POST', '/api/admin/resources', {
    cookie: admin,
    body: {
      title: 'MED-Only Anatomy Notes',
      category: 'document',
      subject: 'Anatomy',
      programs: ['MED'],
      targetAll: false
    }
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.data));
  assert.equal(upload.data.resource.targetAll, false, 'explicit single-program targeting must not widen to all programs');
  assert.deepEqual(upload.data.resource.targetPrograms, ['MED']);

  const lawStudent = await makeStudent('Lawy One', 'lawy1@targeting-test.com', 'LAW');
  const medStudent = await makeStudent('Medic Two', 'medic2@targeting-test.com', 'MED');

  const lawRow = db.prepare('SELECT * FROM users WHERE email = ?').get('lawy1@targeting-test.com');
  const medRow = db.prepare('SELECT * FROM users WHERE email = ?').get('medic2@targeting-test.com');

  const lawList = await call('GET', '/api/resources?search=Anatomy', { cookie: cookieFor(lawRow) });
  const lawTitles = lawList.data.resources.map((r) => r.title);
  assert.ok(!lawTitles.includes('MED-Only Anatomy Notes'),
    `a LAW student must not see MED-only content, got: ${lawTitles.join(', ') || '(none)'}`);

  const medList = await call('GET', '/api/resources?search=Anatomy', { cookie: cookieFor(medRow) });
  const medTitles = medList.data.resources.map((r) => r.title);
  assert.ok(medTitles.includes('MED-Only Anatomy Notes'),
    `the MED student must see the MED-only resource, got: ${medTitles.join(', ') || '(none)'}`);

  // The file itself is gated too — a straight stream URL must be refused for
  // a student whose program does not include the content (403 program gate,
  // not 200 bytes).
  const stream = await call('GET', `/api/resources/${upload.data.resource.id}/stream`, { cookie: cookieFor(lawRow) });
  assert.equal(stream.status, 403, `law student stream must be refused, got ${stream.status}`);

  // Admin-managed student program changes accept new program codes as well.
  const moved = await call('PUT', `/api/admin/users/${lawRow.id}/program`, {
    cookie: admin,
    body: { program: 'MED' }
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
});

test('a targeting selection that matches no real program is refused, not broadcast', async () => {
  const admin = await adminCookie();
  const res = await call('POST', '/api/admin/resources', {
    cookie: admin,
    body: {
      title: 'Typo Targeting',
      category: 'document',
      subject: 'Misc',
      programs: ['NOTARealPROGRAM'],
      targetAll: false
    }
  });
  assert.equal(res.status, 400, `expected refusal, got: ${JSON.stringify(res.data)}`);

  // The resource must not exist in any form.
  const check = await call('GET', '/api/admin/resources?search=Typo+Targeting', { cookie: admin });
  assert.equal(check.data.resources.length, 0);

  // "ALL" and explicit all-programs targeting still work as before.
  const allRes = await call('POST', '/api/admin/resources', {
    cookie: admin,
    body: { title: 'Everyone Welcome', category: 'document', subject: 'Misc', targetAll: true }
  });
  assert.equal(allRes.status, 201, JSON.stringify(allRes.data));
  assert.equal(allRes.data.resource.targetAll, true);
});
