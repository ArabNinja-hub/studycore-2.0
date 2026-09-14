'use strict';

// END-TO-END proof of the reported bug and its fix.
//
// THE REPORT: "for some students it's telling them to ask for access from the
// admin who uploaded the document from Google Drive".
//
// This suite runs the real server and walks the whole path:
//   Content Admin picks a Drive file -> publishes it -> a student who has NO
//   relationship whatsoever with the uploader's Google account opens it.
//
// The student must receive the document's actual bytes from StudyCore. Any
// redirect to Google, or any response mentioning access requests, is the bug.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-drive-e2e-'));
process.env.DATA_DIR = testDataDir;
process.env.CONTENT_ADMIN_ACCESS_CODE = 'drive-e2e-access-code';
process.env.JWT_SECRET = 'test-only-studycore-jwt-secret-0123456789';
process.env.NODE_ENV = 'test';
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
const { ROLES } = require('../lib/roles');
const app = require('../server');

// The document the admin has in their private Drive. The student must end up
// holding exactly these bytes.
const DRIVE_PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n', 'latin1'),
  Buffer.from('1 0 obj<</Type/Catalog>>endobj\n', 'latin1'),
  Buffer.from('StudyCore Drive import: Contract Law lecture notes.\n', 'latin1'),
  Buffer.from('trailer<</Root 1 0 R>>\n%%EOF', 'latin1')
]);
const DRIVE_FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

// Stand-in for Google Drive. Crucially it models the real permission rule:
// the file is PRIVATE, so it is released only to a caller presenting the
// uploader's OAuth token - a student could never fetch it directly.
const ADMIN_TOKEN = 'ya29.admin-picker-token';
function installFakeDrive() {
  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.startsWith('https://www.googleapis.com/drive/')) {
      return realFetch(url, options);
    }
    const auth = (options.headers && options.headers.Authorization) || '';
    if (auth !== `Bearer ${ADMIN_TOKEN}`) {
      // Exactly what Drive does to a caller without permission.
      return { ok: false, status: 404, json: async () => ({ error: { message: 'File not found' } }) };
    }
    if (target.includes('fields=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: DRIVE_FILE_ID,
          name: 'Contract Law Lecture Notes.pdf',
          mimeType: 'application/pdf',
          size: String(DRIVE_PDF.length)
        })
      };
    }
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(DRIVE_PDF));
          controller.close();
        }
      })
    };
  };
  return () => { global.fetch = realFetch; };
}

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')];
  const raw = values.find(Boolean);
  assert.ok(raw, 'expected a session cookie');
  return raw.split(';')[0];
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
  const buffer = Buffer.from(await response.arrayBuffer());
  const raw = buffer.toString('utf8');
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return { response, data, raw, buffer };
}

function createStudent() {
  const now = new Date().toISOString();
  const user = {
    id: `student-${uuidv4()}`,
    name: 'Chanda Student',
    email: `student-${uuidv4()}@test.studycore`,
    password: bcrypt.hashSync('student-password', 4),
    role: ROLES.STUDENT,
    program_code: 'LAW',
    subscription: 'premium',
    trial_end: new Date(Date.now() + 86400000).toISOString(),
    subscription_end: new Date(Date.now() + 86400000).toISOString(),
    created_at: now
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, program_code, subscription, trial_end, subscription_end, created_at)
    VALUES (@id, @name, @email, @password, @role, @program_code, @subscription, @trial_end, @subscription_end, @created_at)
  `).run(user);
  return { ...user, cookie: `${COOKIE_NAME}=${createToken(user)}` };
}

test('a Drive-published document is readable by a student who has no Drive access', {
  timeout: 30000, concurrency: false
}, async (t) => {
  const restoreDrive = installFakeDrive();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // ── The Content Admin publishes a file straight from their Drive ──────
    const signup = await call(baseUrl, 'POST', '/api/auth/register-content-admin', {
      body: {
        name: 'Alice Publisher',
        email: `alice-${uuidv4()}@test.studycore`,
        password: 'secure-password',
        confirmPassword: 'secure-password',
        adminAccessCode: process.env.CONTENT_ADMIN_ACCESS_CODE
      }
    });
    assert.equal(signup.response.status, 201, signup.raw);
    const adminCookie = cookieFrom(signup.response);

    const course = db.prepare(`
      SELECT c.id FROM courses c
      JOIN program_courses pc ON pc.course_id = c.id
      WHERE pc.program_code = 'LAW' LIMIT 1
    `).get();
    assert.ok(course, 'the seeded Law catalog provides a course');

    const form = new FormData();
    Object.entries({
      resourceType: 'notes',
      programCode: 'LAW',
      courseId: course.id,
      topic: 'Foundations',
      title: 'Contract Law Lecture Notes',
      semester: 'Term 1',
      publishStatus: 'published',
      // Exactly what the Picker hands the dashboard.
      google_drive_file_id: DRIVE_FILE_ID,
      google_drive_url: `https://drive.google.com/file/d/${DRIVE_FILE_ID}/view`,
      google_drive_access_token: ADMIN_TOKEN,
      file_name: 'Contract Law Lecture Notes.pdf',
      mime_type: 'application/pdf',
      file_size: String(DRIVE_PDF.length)
    }).forEach(([k, v]) => form.append(k, v));

    const publish = await call(baseUrl, 'POST', '/api/content-admin/resources', {
      cookie: adminCookie, body: form
    });
    assert.equal(publish.response.status, 201, publish.raw);
    const resourceId = publish.data.resource.id;

    await t.test('publishing copied the file into StudyCore storage', () => {
      const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
      // The decisive assertion: stored_name is a real storage key, NOT the
      // Drive file id that the old code wrote here.
      assert.ok(row.stored_name, 'the resource has a stored object');
      assert.notEqual(row.stored_name, DRIVE_FILE_ID,
        'stored_name must be a storage key, never the Drive file id');
      assert.match(row.stored_name, /\.pdf$/);
      assert.notEqual(row.storage_provider, 'google_drive',
        'the bytes live in StudyCore storage now, so the provider is local/r2');
      assert.equal(row.file_size, DRIVE_PDF.length);
      // Provenance is retained, but it is no longer what serves the file.
      assert.equal(row.google_drive_file_id, DRIVE_FILE_ID);
    });

    // ── The student: a different person, no Google account involved ───────
    const student = createStudent();

    await t.test('the student gets the document bytes, not an access request', async () => {
      const meta = await call(baseUrl, 'GET', `/api/resources/${resourceId}`, { cookie: student.cookie });
      assert.equal(meta.response.status, 200, meta.raw);
      assert.equal(meta.data.resource.hasFile, true);

      const stream = await call(baseUrl, 'GET', `/api/resources/${resourceId}/stream`, {
        cookie: student.cookie, manualRedirect: true
      });

      // The bug produced a 302 to docs.google.com / drive.google.com.
      assert.equal(stream.response.status, 200,
        'the student must be served the file directly, never redirected to Google');
      assert.equal(stream.response.headers.get('content-type'), 'application/pdf');
      assert.deepEqual(stream.buffer, DRIVE_PDF,
        'the student receives the exact document the admin picked from Drive');

      // Nothing anywhere in the response points at Google or asks for access.
      assert.doesNotMatch(stream.raw, /request access/i);
      assert.doesNotMatch(stream.raw, /drive\.google\.com/i);
      assert.equal(stream.response.headers.get('location'), null);
    });

    await t.test('the reader ticket path also serves the document', async () => {
      const ticket = await call(baseUrl, 'GET', `/api/resources/${resourceId}/ticket`, { cookie: student.cookie });
      assert.equal(ticket.response.status, 200, ticket.raw);
      const viaTicket = await call(baseUrl, 'GET', ticket.data.url, {
        cookie: student.cookie, manualRedirect: true
      });
      assert.equal(viaTicket.response.status, 200);
      assert.deepEqual(viaTicket.buffer, DRIVE_PDF);
    });

    await t.test('the student never needs, and never receives, Google credentials', async () => {
      const meta = await call(baseUrl, 'GET', `/api/resources/${resourceId}`, { cookie: student.cookie });
      // The admin's OAuth token must never leak into a student-facing payload.
      assert.doesNotMatch(meta.raw, /ya29\./, 'no OAuth access token is exposed');
      assert.doesNotMatch(meta.raw, new RegExp(ADMIN_TOKEN));
    });

    await t.test('a legacy Drive-LINKED row reports honestly instead of bouncing to Google', async () => {
      // Simulate a row published before the fix: provider google_drive and a
      // Drive id sitting in stored_name.
      const legacyId = `res-legacy-${uuidv4()}`;
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO resources (id, title, category, resource_type, subject, course, course_id,
          target_all, topic, semester, file_name, stored_name, file_size, mime_type,
          is_premium, publish_status, uploaded_by, uploader_role, uploaded_at, created_at,
          updated_at, storage_provider, google_drive_file_id, google_drive_url)
        VALUES (@id, @title, 'document', 'Notes', @subject, @course, @course_id,
          0, 'Foundations', 'Term 1', 'legacy.pdf', @stored_name, 1234, 'application/pdf',
          0, 'published', NULL, 'content_admin', @now, @now, @now, 'google_drive',
          @drive_id, @drive_url)
      `).run({
        id: legacyId, title: 'Legacy Drive Notes', subject: 'Law', course: 'LAW',
        course_id: course.id, stored_name: DRIVE_FILE_ID, now,
        drive_id: DRIVE_FILE_ID, drive_url: `https://drive.google.com/file/d/${DRIVE_FILE_ID}/view`
      });
      db.prepare('INSERT INTO resource_programs (resource_id, program_code) VALUES (?, ?)')
        .run(legacyId, 'LAW');

      const stream = await call(baseUrl, 'GET', `/api/resources/${legacyId}/stream`, {
        cookie: student.cookie, manualRedirect: true
      });
      // It cannot be served (the bytes were never copied), but the student is
      // NOT sent to Google to beg the admin for permission.
      assert.equal(stream.response.status, 404);
      assert.equal(stream.response.headers.get('location'), null);
      assert.doesNotMatch(stream.raw, /request access/i);
      assert.doesNotMatch(stream.raw, /drive\.google\.com/i);
      assert.match(stream.data.message, /being moved into StudyCore/i);
    });

    await t.test('the main admin dashboard cannot re-create the broken state', async () => {
      // The main admin route has no Drive Picker and so no OAuth token: it
      // could never fetch the bytes, only write a link. Left open, it was a
      // second way to produce a row that sends students to Google.
      const mainAdmin = {
        id: `admin-${uuidv4()}`,
        name: 'Main Admin',
        email: `main-${uuidv4()}@test.studycore`,
        password: bcrypt.hashSync('admin-password', 4),
        role: ROLES.ADMIN,
        program_code: 'LAW',
        subscription: 'premium',
        trial_end: new Date(Date.now() + 86400000).toISOString(),
        subscription_end: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString()
      };
      db.prepare(`
        INSERT INTO users (id, name, email, password, role, program_code, subscription, trial_end, subscription_end, created_at)
        VALUES (@id, @name, @email, @password, @role, @program_code, @subscription, @trial_end, @subscription_end, @created_at)
      `).run(mainAdmin);
      const cookie = `${COOKIE_NAME}=${createToken(mainAdmin)}`;

      const link = new FormData();
      link.append('google_drive_file_id', '1ZzYyXxWwVvUuTtSsRrQqPpOoNnMmLlK');
      link.append('google_drive_url', 'https://drive.google.com/file/d/1ZzYyXxWwVvUuTtSsRrQqPpOoNnMmLlK/view');

      const attempt = await call(baseUrl, 'PUT', `/api/admin/resources/${resourceId}`, {
        cookie, body: link
      });
      assert.equal(attempt.response.status, 400, attempt.raw);
      assert.match(attempt.data.message, /no longer be linked to Google Drive/i);

      // And the already-imported resource is untouched: still readable.
      const after = db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
      assert.notEqual(after.storage_provider, 'google_drive');
      const reread = await call(baseUrl, 'GET', `/api/resources/${resourceId}/stream`, {
        cookie: student.cookie, manualRedirect: true
      });
      assert.equal(reread.response.status, 200);
      assert.ok(reread.buffer.equals(DRIVE_PDF));
    });
  } finally {
    restoreDrive();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
});
