'use strict';

// End-to-end checks for the three-account Content Admin workflow. The suite
// uses an isolated temporary SQLite/data directory so it can run alongside the
// existing test files without sharing users, upload objects or migrations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-content-admin-'));
process.env.DATA_DIR = testDataDir;
process.env.CONTENT_ADMIN_ACCESS_CODE = 'content-admin-test-access-code';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
const { ROLES } = require('../lib/roles');
// server.js exports its production app without binding a port when required,
// so this suite covers the real API middleware, static files, and page gates.
const app = require('../server');

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')];
  const raw = values.find(Boolean);
  assert.ok(raw, 'an authenticated response should set a session cookie');
  return raw.split(';')[0];
}

function cookieFor(user) {
  return `${COOKIE_NAME}=${createToken(user)}`;
}

async function call(baseUrl, method, pathname, { cookie, body, manualRedirect = false } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  const options = { method, headers, redirect: manualRedirect ? 'manual' : 'follow' };
  if (body !== undefined) {
    if (body instanceof FormData) options.body = body;
    else {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
  }
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return { response, data, raw };
}

async function registerContentAdmin(baseUrl, name, email) {
  const result = await call(baseUrl, 'POST', '/api/auth/register-content-admin', {
    body: {
      name,
      email,
      password: 'secure-password',
      confirmPassword: 'secure-password',
      adminAccessCode: process.env.CONTENT_ADMIN_ACCESS_CODE,
      // A forged role field must be ignored; the server alone sets the
      // Content Admin role after validating the registration-only code.
      role: ROLES.ADMIN
    }
  });
  assert.equal(result.response.status, 201, result.raw);
  return { ...result, cookie: cookieFrom(result.response) };
}

function uploadBody(course, overrides = {}) {
  const form = new FormData();
  const values = {
    resourceType: 'notes',
    programCode: 'LAW',
    courseId: course.id,
    topic: 'Foundations',
    title: 'Contract Law revision notes',
    description: 'A concise revision pack.',
    semester: '',
    yearLevel: 'Year 1',
    publishStatus: 'published',
    ...overrides
  };
  for (const [key, value] of Object.entries(values)) form.append(key, value);
  if (!overrides.noFile) {
    form.append('file', new Blob(['%PDF-1.4\nContent Admin test resource'], { type: 'application/pdf' }), 'revision-notes.pdf');
  }
  return form;
}

function createMainAdmin() {
  const now = new Date().toISOString();
  const user = {
    id: `admin-content-test-${uuidv4()}`,
    name: 'Main Admin',
    email: `main-admin-${uuidv4()}@test.studycore`,
    password: 'not-used-by-token-test',
    role: ROLES.ADMIN,
    subscription: 'premium',
    subscription_start: now,
    subscription_end: new Date(Date.now() + 86400000).toISOString(),
    created_at: now
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, subscription, subscription_start, subscription_end, created_at)
    VALUES (@id, @name, @email, @password, @role, @subscription, @subscription_start, @subscription_end, @created_at)
  `).run(user);
  return user;
}

test('Content Admin registration, ownership, revocation and Main Admin oversight', { timeout: 30000, concurrency: false }, async (t) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let alice;
  let bob;
  let mainAdmin;
  let student;
  let resourceId;

  try {
    const publicSignup = fs.readFileSync(path.join(__dirname, '..', 'public', 'content-admin-signup.html'), 'utf8');
    const dashboardHtml = fs.readFileSync(path.join(__dirname, '..', 'views', 'content-admin.html'), 'utf8');
    const dashboardScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'content-admin.js'), 'utf8');
    assert.doesNotMatch(publicSignup, /Studycore2026#/i, 'the registration secret must not appear in the public page');
    assert.doesNotMatch(dashboardHtml, /Studycore2026#/i, 'the registration secret must not appear in the protected page source either');
    assert.doesNotMatch(dashboardScript, /Studycore2026#/i, 'the registration secret must not appear in Content Admin JavaScript');
    assert.match(publicSignup, /Create Admin Account/);
    for (const label of ['Dashboard', 'Profile', 'Upload Resource', 'My Uploads', 'Logout']) {
      assert.match(dashboardHtml, new RegExp(`>${label}<`), `the dedicated navigation includes ${label}`);
    }
    assert.match(dashboardHtml, /Account Type/);
    assert.match(dashboardScript, /Welcome, \$\{profile\.name\}/);
    const publicConfig = await call(baseUrl, 'GET', '/api/config');
    assert.equal(publicConfig.response.status, 200);
    assert.doesNotMatch(publicConfig.raw, /content-admin-test-access-code/i, 'the registration secret must not be exposed by a public API');

    const mismatch = await call(baseUrl, 'POST', '/api/auth/register-content-admin', {
      body: {
        name: 'Mismatch', email: `mismatch-${uuidv4()}@test.studycore`,
        password: 'secure-password', confirmPassword: 'different-password',
        adminAccessCode: process.env.CONTENT_ADMIN_ACCESS_CODE
      }
    });
    assert.equal(mismatch.response.status, 400);

    const badCode = await call(baseUrl, 'POST', '/api/auth/register-content-admin', {
      body: {
        name: 'Bad Code', email: `bad-code-${uuidv4()}@test.studycore`,
        password: 'secure-password', confirmPassword: 'secure-password', adminAccessCode: 'wrong-code'
      }
    });
    assert.equal(badCode.response.status, 403);
    assert.doesNotMatch(badCode.raw, /wrong-code/i, 'the server must not echo a supplied access code');

    const aliceSignup = await registerContentAdmin(baseUrl, 'Alice Publisher', `alice-${uuidv4()}@test.studycore`);
    alice = { ...aliceSignup.data.user, cookie: aliceSignup.cookie };
    assert.equal(alice.role, ROLES.CONTENT_ADMIN);
    assert.doesNotMatch(aliceSignup.raw, /content-admin-test-access-code/i, 'the registration response must not expose the access code');
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(alice.id).role, ROLES.CONTENT_ADMIN);
    const contentAdminStudentPage = await call(baseUrl, 'GET', '/pages/community.html', { cookie: alice.cookie, manualRedirect: true });
    assert.equal(contentAdminStudentPage.response.status, 302, 'Content Admin student-page URLs are redirected server-side');
    assert.equal(contentAdminStudentPage.response.headers.get('location'), '/content-admin.html');
    // Registration code is never part of normal authentication: subsequent
    // Content Admin login uses the same email/password form as every account.
    const normalLogin = await call(baseUrl, 'POST', '/api/auth/login', {
      body: { email: alice.email, password: 'secure-password' }
    });
    assert.equal(normalLogin.response.status, 200, normalLogin.raw);
    assert.equal(normalLogin.data.user.role, ROLES.CONTENT_ADMIN);

    const bobSignup = await registerContentAdmin(baseUrl, 'Bob Publisher', `bob-${uuidv4()}@test.studycore`);
    bob = { ...bobSignup.data.user, cookie: bobSignup.cookie };
    mainAdmin = createMainAdmin();
    const studentSignup = await call(baseUrl, 'POST', '/api/auth/register', {
      body: {
        name: 'Program Student',
        email: `student-${uuidv4()}@test.studycore`,
        password: 'secure-password',
        program: 'LAW',
        // Public signup must not honor a crafted privileged role either.
        role: ROLES.ADMIN
      }
    });
    assert.equal(studentSignup.response.status, 201, studentSignup.raw);
    assert.equal(studentSignup.data.user.role, ROLES.STUDENT);
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(studentSignup.data.user.id).role, ROLES.STUDENT);
    student = { ...studentSignup.data.user, cookie: cookieFrom(studentSignup.response) };
    const mainCookie = cookieFor(mainAdmin);
    const studentCookie = student.cookie;

    // Typed protected-page URLs route users to their own canonical dashboard.
    const aliceAdminPage = await call(baseUrl, 'GET', '/admin.html', { cookie: alice.cookie, manualRedirect: true });
    assert.equal(aliceAdminPage.response.status, 302);
    assert.equal(aliceAdminPage.response.headers.get('location'), '/content-admin.html');
    const mainContentPage = await call(baseUrl, 'GET', '/content-admin.html', { cookie: mainCookie, manualRedirect: true });
    assert.equal(mainContentPage.response.status, 302);
    assert.equal(mainContentPage.response.headers.get('location'), '/admin.html');
    const studentContentPage = await call(baseUrl, 'GET', '/content-admin.html', { cookie: studentCookie, manualRedirect: true });
    assert.equal(studentContentPage.response.status, 302);
    assert.equal(studentContentPage.response.headers.get('location'), '/dashboard.html');

    // Roles are enforced server-side, not merely by the Content Admin UI.
    assert.equal((await call(baseUrl, 'GET', '/api/admin/resources', { cookie: alice.cookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'GET', '/api/admin/users', { cookie: alice.cookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'GET', '/api/programs/admin', { cookie: alice.cookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'GET', '/api/programs/mine', { cookie: alice.cookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'GET', '/api/courses/mathematics', { cookie: alice.cookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'GET', '/api/notifications', { cookie: alice.cookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'GET', '/api/community', { cookie: alice.cookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'POST', '/api/auth/subscribe', {
      cookie: alice.cookie, body: { phone: '0970000000', method: 'MTN MoMo' }
    })).response.status, 403);
    assert.equal((await call(baseUrl, 'GET', '/api/content-admin/dashboard', { cookie: studentCookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'GET', '/api/content-admin/dashboard', { cookie: mainCookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'POST', '/api/content-admin/resources', { cookie: studentCookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'GET', '/api/resources', { cookie: alice.cookie })).response.status, 403);
    const publicProgramDirectory = await call(baseUrl, 'GET', '/api/programs?counts=1', { cookie: alice.cookie });
    assert.equal(publicProgramDirectory.response.status, 200);
    assert.ok(publicProgramDirectory.data.programs.every((program) => program.studentCount === undefined));

    const course = db.prepare(`
      SELECT c.id, c.code FROM courses c
      JOIN program_courses pc ON pc.course_id = c.id
      WHERE pc.program_code = 'LAW'
      ORDER BY pc.sort_order ASC
      LIMIT 1
    `).get();
    assert.ok(course, 'the seeded Law catalog must provide a course for the placement test');

    const upload = await call(baseUrl, 'POST', '/api/content-admin/resources', {
      cookie: alice.cookie,
      body: uploadBody(course)
    });
    assert.equal(upload.response.status, 201, upload.raw);
    resourceId = upload.data.resource.id;
    assert.equal(upload.data.resource.resourceType, 'Notes');
    assert.equal(upload.data.resource.programCode, 'LAW');
    assert.equal(upload.data.resource.courseId, course.id);
    assert.equal(upload.data.resource.topic, 'Foundations');
    const stored = db.prepare(`
      SELECT uploaded_by, uploader_role, uploader_name, uploader_email, uploaded_at, resource_type, target_all
      FROM resources WHERE id = ?
    `).get(resourceId);
    assert.deepEqual(
      { uploadedBy: stored.uploaded_by, role: stored.uploader_role, name: stored.uploader_name, email: stored.uploader_email, type: stored.resource_type, targetAll: stored.target_all },
      { uploadedBy: alice.id, role: ROLES.CONTENT_ADMIN, name: 'Alice Publisher', email: alice.email, type: 'Notes', targetAll: 0 }
    );
    assert.ok(stored.uploaded_at, 'each upload records a timestamp');
    assert.equal((await call(baseUrl, 'GET', `/api/resources/${encodeURIComponent(resourceId)}`, { cookie: alice.cookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'GET', `/api/resources/${encodeURIComponent(resourceId)}/stream`, { cookie: alice.cookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'POST', `/api/resources/${encodeURIComponent(resourceId)}/complete`, { cookie: alice.cookie })).response.status, 403);

    // A matching-program student sees the published resource through the
    // existing student-facing resource API.
    const studentResources = await call(baseUrl, 'GET', '/api/resources?pageSize=100', { cookie: studentCookie });
    assert.equal(studentResources.response.status, 200, studentResources.raw);
    assert.ok(studentResources.data.resources.some((resource) => resource.id === resourceId));
    const studentSearch = await call(baseUrl, 'GET', '/api/resources/search?q=law', { cookie: studentCookie });
    assert.equal(studentSearch.response.status, 200);
    assert.equal(studentSearch.data.authenticated, true, 'student search keeps its authenticated program-aware path');

    // The uploader can remove their own resource without affecting the shared
    // resource system or another uploader's ownership boundary.
    const disposableUpload = await call(baseUrl, 'POST', '/api/content-admin/resources', {
      cookie: alice.cookie,
      body: uploadBody(course, { title: 'Temporary resource to delete' })
    });
    assert.equal(disposableUpload.response.status, 201, disposableUpload.raw);
    const disposableId = disposableUpload.data.resource.id;
    const ownDelete = await call(baseUrl, 'DELETE', `/api/content-admin/resources/${encodeURIComponent(disposableId)}`, { cookie: alice.cookie });
    assert.equal(ownDelete.response.status, 200, ownDelete.raw);
    assert.equal(db.prepare('SELECT id FROM resources WHERE id = ?').get(disposableId), undefined);

    // A second Content Admin cannot enumerate, retrieve, edit or delete
    // Alice's resource even if they manually construct its ID.
    const bobList = await call(baseUrl, 'GET', '/api/content-admin/resources', { cookie: bob.cookie });
    assert.equal(bobList.response.status, 200);
    assert.ok(!bobList.data.resources.some((resource) => resource.id === resourceId));
    assert.equal((await call(baseUrl, 'GET', `/api/content-admin/resources/${encodeURIComponent(resourceId)}`, { cookie: bob.cookie })).response.status, 404);
    assert.equal((await call(baseUrl, 'PUT', `/api/content-admin/resources/${encodeURIComponent(resourceId)}`, {
      cookie: bob.cookie, body: uploadBody(course, { title: 'Attempted hijack', noFile: true })
    })).response.status, 404);
    assert.equal((await call(baseUrl, 'DELETE', `/api/content-admin/resources/${encodeURIComponent(resourceId)}`, { cookie: bob.cookie })).response.status, 404);

    const aliceUpdate = await call(baseUrl, 'PUT', `/api/content-admin/resources/${encodeURIComponent(resourceId)}`, {
      cookie: alice.cookie,
      body: uploadBody(course, { title: 'Contract Law revision notes — updated', noFile: true })
    });
    assert.equal(aliceUpdate.response.status, 200, aliceUpdate.raw);
    assert.equal(aliceUpdate.data.resource.title, 'Contract Law revision notes — updated');

    // A Content Admin can keep a work-in-progress private as a draft; it
    // remains in their own library but is not exposed through student APIs.
    const draftUpdate = await call(baseUrl, 'PUT', `/api/content-admin/resources/${encodeURIComponent(resourceId)}`, {
      cookie: alice.cookie,
      body: uploadBody(course, { title: 'Contract Law draft notes', publishStatus: 'draft', noFile: true })
    });
    assert.equal(draftUpdate.response.status, 200, draftUpdate.raw);
    assert.equal(draftUpdate.data.resource.publishStatus, 'draft');
    const hiddenFromStudent = await call(baseUrl, 'GET', '/api/resources?pageSize=100', { cookie: studentCookie });
    assert.ok(!hiddenFromStudent.data.resources.some((resource) => resource.id === resourceId));
    const republish = await call(baseUrl, 'PUT', `/api/content-admin/resources/${encodeURIComponent(resourceId)}`, {
      cookie: alice.cookie,
      body: uploadBody(course, { title: 'Contract Law revision notes — updated', publishStatus: 'published', noFile: true })
    });
    assert.equal(republish.response.status, 200, republish.raw);
    assert.equal(republish.data.resource.publishStatus, 'published');

    // Dynamic profile changes are reflected by the authenticated dashboard.
    const profile = await call(baseUrl, 'PUT', '/api/auth/profile', {
      cookie: alice.cookie,
      body: { name: 'Alice Updated', email: `alice-updated-${uuidv4()}@test.studycore` }
    });
    assert.equal(profile.response.status, 200, profile.raw);
    assert.equal(profile.data.user.accountType, 'Content Admin');
    const dashboard = await call(baseUrl, 'GET', '/api/content-admin/dashboard', { cookie: alice.cookie });
    assert.equal(dashboard.response.status, 200);
    assert.equal(dashboard.data.profile.name, 'Alice Updated');
    assert.equal(dashboard.data.profile.email, profile.data.user.email);
    assert.equal(dashboard.data.profile.accountType, 'Content Admin');
    const updatedSnapshot = db.prepare('SELECT uploader_name, uploader_email FROM resources WHERE id = ?').get(resourceId);
    assert.deepEqual({ ...updatedSnapshot }, { uploader_name: 'Alice Updated', uploader_email: profile.data.user.email });

    // Main Admin can see attribution, edit every resource and manage all
    // Content Admin accounts.
    const accounts = await call(baseUrl, 'GET', '/api/admin/content-admins', { cookie: mainCookie });
    assert.equal(accounts.response.status, 200, accounts.raw);
    const aliceAccount = accounts.data.contentAdmins.find((account) => account.id === alice.id);
    assert.ok(aliceAccount);
    assert.equal(aliceAccount.resourceCount, 1);
    assert.equal(aliceAccount.isActive, true);

    const adminResources = await call(baseUrl, 'GET', '/api/admin/resources', { cookie: mainCookie });
    assert.equal(adminResources.response.status, 200, adminResources.raw);
    const attributedResource = adminResources.data.resources.find((resource) => resource.id === resourceId);
    assert.equal(attributedResource.uploaderName, 'Alice Updated');
    assert.equal(attributedResource.uploaderRole, ROLES.CONTENT_ADMIN);
    assert.equal(attributedResource.resourceType, 'Notes');

    const mainEdit = new FormData();
    mainEdit.append('title', 'Main Admin reviewed notes');
    const editedByMain = await call(baseUrl, 'PUT', `/api/admin/resources/${encodeURIComponent(resourceId)}`, {
      cookie: mainCookie, body: mainEdit
    });
    assert.equal(editedByMain.response.status, 200, editedByMain.raw);
    assert.equal(editedByMain.data.resource.title, 'Main Admin reviewed notes');
    assert.equal(editedByMain.data.resource.uploaderName, 'Alice Updated');

    const revoke = await call(baseUrl, 'PATCH', `/api/admin/content-admins/${encodeURIComponent(alice.id)}/status`, {
      cookie: mainCookie, body: { isActive: false }
    });
    assert.equal(revoke.response.status, 200, revoke.raw);
    // The original cookie is immediately denied because auth reloads the
    // account's active flag from SQLite on every protected request. A new
    // email/password login is denied for the same reason.
    assert.equal((await call(baseUrl, 'GET', '/api/content-admin/dashboard', { cookie: alice.cookie })).response.status, 403);
    assert.equal((await call(baseUrl, 'POST', '/api/auth/login', {
      body: { email: profile.data.user.email, password: 'secure-password' }
    })).response.status, 403);
    const revokedSearch = await call(baseUrl, 'GET', '/api/resources/search?q=law', { cookie: alice.cookie });
    assert.equal(revokedSearch.response.status, 200);
    assert.equal(revokedSearch.data.authenticated, false, 'a revoked session is not accepted by optional-auth endpoints');
    const restore = await call(baseUrl, 'PATCH', `/api/admin/content-admins/${encodeURIComponent(alice.id)}/status`, {
      cookie: mainCookie, body: { isActive: true }
    });
    assert.equal(restore.response.status, 200, restore.raw);
    assert.equal((await call(baseUrl, 'GET', '/api/content-admin/dashboard', { cookie: alice.cookie })).response.status, 200);

    // Deletion is also Main-Admin-only. Resource attribution is retained as a
    // snapshot even once SQLite clears its live user FK.
    const deleteBob = await call(baseUrl, 'DELETE', `/api/admin/content-admins/${encodeURIComponent(bob.id)}`, { cookie: mainCookie });
    assert.equal(deleteBob.response.status, 200, deleteBob.raw);
    assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get(bob.id), undefined);

    const deleteAlice = await call(baseUrl, 'DELETE', `/api/admin/content-admins/${encodeURIComponent(alice.id)}`, { cookie: mainCookie });
    assert.equal(deleteAlice.response.status, 200, deleteAlice.raw);
    const retained = db.prepare('SELECT uploaded_by, uploader_name, uploader_role FROM resources WHERE id = ?').get(resourceId);
    assert.equal(retained.uploaded_by, null);
    assert.equal(retained.uploader_name, 'Alice Updated');
    assert.equal(retained.uploader_role, ROLES.CONTENT_ADMIN);
    const retainedList = await call(baseUrl, 'GET', '/api/admin/resources', { cookie: mainCookie });
    assert.equal(retainedList.data.resources.find((resource) => resource.id === resourceId).uploaderName, 'Alice Updated');

    const mainDelete = await call(baseUrl, 'DELETE', `/api/admin/resources/${encodeURIComponent(resourceId)}`, { cookie: mainCookie });
    assert.equal(mainDelete.response.status, 200, mainDelete.raw);
    resourceId = null;
  } finally {
    if (resourceId) db.prepare('DELETE FROM resources WHERE id = ?').run(resourceId);
    if (alice) db.prepare('DELETE FROM users WHERE id = ?').run(alice.id);
    if (bob) db.prepare('DELETE FROM users WHERE id = ?').run(bob.id);
    if (mainAdmin) db.prepare('DELETE FROM users WHERE id = ?').run(mainAdmin.id);
    if (student) db.prepare('DELETE FROM users WHERE id = ?').run(student.id);
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});
