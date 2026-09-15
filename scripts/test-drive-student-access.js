'use strict';

// END-TO-END proof that Google Drive Picker documents are readable by students
// without Google's "Request access" wall.
//
// THE REPORTED BUG
//
// Drive-picked resources used to be left as links to the uploader's private
// Drive file. Some students were then sent to Google's own permission screen
// and told to request access. The reliable behaviour is to import the selected
// bytes into StudyCore document storage at publish time.
//
// This suite runs the real server and walks the whole path for BOTH:
//
//   · a NEW resource, published right now through the Google Drive Picker and
//     imported into StudyCore storage, and
//   · an OLD legacy resource whose row still points at a Drive file id
//     (storage_provider='google_drive'), which StudyCore proxies server-side
//     as a compatibility fallback when it can still read the original.
//
// Each is opened by a student who has NO relationship with the uploader's
// Google account, using DESKTOP and MOBILE request patterns. The student must
// receive bytes from StudyCore with no Google redirect, no "request access"
// text, and no "being moved" state.

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
// StudyCore's own server-side Drive credential, used by the legacy
// storage_provider='google_drive' compatibility proxy. New Picker publishes use
// the uploader's short-lived Picker token once, then read from StudyCore storage.
process.env.GOOGLE_API_KEY = 'AIzaTestServerSideKey0000000000000000000';

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
const { ROLES } = require('../lib/roles');
const driveDocuments = require('../lib/drive-documents');
const documentStorage = require('../lib/document-storage');
const app = require('../server');

// The source documents in Google Drive. For the newly published resource these
// bytes are imported into StudyCore storage; for the legacy row they are read
// through the server-side Drive proxy.
function pdfOf(text) {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'),
    Buffer.from('1 0 obj<</Type/Catalog>>endobj\n', 'latin1'),
    Buffer.from(`${text}\n`, 'latin1'),
    // Padding so range requests have something meaningful to slice.
    Buffer.from('0123456789'.repeat(64), 'latin1'),
    Buffer.from('trailer<</Root 1 0 R>>\n%%EOF', 'latin1')
  ]);
}

const NEW_PDF = pdfOf('StudyCore Drive document: Contract Law lecture notes.');
const OLD_PDF = pdfOf('StudyCore Drive document: legacy Torts past paper.');
const NEW_FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const OLD_FILE_ID = '1OldLegacyDriveFileId000000000000';

// Stand-in for Google Drive. It models the real permission rule: these files
// are PRIVATE, released only to a caller presenting either the uploader's
// Picker token or StudyCore's own server-side credential. A student could
// never fetch them directly, which is the whole point of proxying.
const ADMIN_TOKEN = 'ya29.admin-picker-token';
const SERVER_KEY = process.env.GOOGLE_API_KEY;

function installFakeDrive() {
  const realFetch = global.fetch;
  const files = new Map([
    [NEW_FILE_ID, { name: 'Contract Law Lecture Notes.pdf', mime: 'application/pdf', bytes: NEW_PDF }],
    [OLD_FILE_ID, { name: 'Torts Past Paper 2019.pdf', mime: 'application/pdf', bytes: OLD_PDF }]
  ]);
  const calls = [];

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.startsWith('https://www.googleapis.com/drive/')) {
      return realFetch(url, options);
    }
    const method = (options && options.method) || 'GET';
    calls.push({ url: target, method, headers: (options && options.headers) || {} });

    const auth = (options.headers && options.headers.Authorization) || '';
    const authorized = auth === `Bearer ${ADMIN_TOKEN}` || target.includes(`key=${SERVER_KEY}`);
    if (!authorized) {
      // Exactly what Drive does to a caller without permission.
      return { ok: false, status: 404, json: async () => ({ error: { message: 'File not found' } }) };
    }

    const idMatch = target.match(/\/drive\/v3\/files\/([^?/]+)/);
    const fileId = idMatch ? decodeURIComponent(idMatch[1]) : null;

    if (target.includes('/permissions')) {
      return { ok: true, status: 200, json: async () => ({ id: 'perm-1' }) };
    }

    const file = files.get(fileId);
    if (!file) return { ok: false, status: 404, json: async () => ({}) };

    if (target.includes('fields=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: fileId, name: file.name, mimeType: file.mime, size: String(file.bytes.length)
        })
      };
    }

    // alt=media — the real byte read, with Range support.
    const requested = (options.headers && options.headers.Range) || null;
    let bytes = file.bytes;
    const headers = new Map([['Content-Type', file.mime]]);
    if (requested) {
      const m = /bytes=(\d+)-(\d+)/.exec(requested);
      if (m) {
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), file.bytes.length - 1);
        bytes = file.bytes.subarray(start, end + 1);
        headers.set('Content-Range', `bytes ${start}-${end}/${file.bytes.length}`);
      }
    }
    headers.set('Content-Length', String(bytes.length));
    return {
      ok: true,
      status: requested ? 206 : 200,
      headers: { get: (h) => headers.get(h) || null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        }
      })
    };
  };
  return { calls, restore() { global.fetch = realFetch; } };
}

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')];
  const raw = values.find(Boolean);
  assert.ok(raw, 'expected a session cookie');
  return raw.split(';')[0];
}

// A real iPhone Safari UA + the Range pattern mobile PDF readers issue.
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function call(baseUrl, method, pathname, { cookie, body, manualRedirect = false, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (cookie) requestHeaders.Cookie = cookie;
  const options = { method, headers: requestHeaders, redirect: manualRedirect ? 'manual' : 'follow' };
  if (body !== undefined) {
    if (body instanceof FormData) options.body = body;
    else {
      requestHeaders['Content-Type'] = 'application/json';
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

// Everything a student device does to read a document, asserted as a unit so
// both the old and the new resource are held to the identical standard on
// both desktop and mobile.
async function assertOpensInViewer(baseUrl, { resourceId, student, expected, label, userAgent }) {
  const ua = { 'User-Agent': userAgent };

  // 1. Metadata — what the viewer uses to choose its renderer.
  const meta = await call(baseUrl, 'GET', `/api/resources/${resourceId}`, { cookie: student.cookie, headers: ua });
  assert.equal(meta.response.status, 200, `${label}: metadata must load — ${meta.raw}`);
  assert.equal(meta.data.resource.hasFile, true, `${label}: the resource has a readable file`);
  assert.equal(meta.data.resource.mimeType, 'application/pdf', `${label}: served as a PDF`);
  // No Drive credential or "being moved" state may reach the browser.
  assert.doesNotMatch(meta.raw, /ya29\./, `${label}: no OAuth token exposed`);
  assert.doesNotMatch(meta.raw, /being moved/i, `${label}: no migration state`);

  // 2. A short-lived viewing ticket, exactly as the viewer mints one.
  const ticket = await call(baseUrl, 'GET', `/api/resources/${resourceId}/ticket`, { cookie: student.cookie, headers: ua });
  assert.equal(ticket.response.status, 200, `${label}: ticket — ${ticket.raw}`);

  // 3. The full document, through the ticketed URL the reader actually loads.
  const full = await call(baseUrl, 'GET', ticket.data.url, {
    cookie: student.cookie, manualRedirect: true, headers: ua
  });
  assert.equal(full.response.status, 200,
    `${label}: served directly by StudyCore, never redirected to Google`);
  assert.equal(full.response.headers.get('content-type'), 'application/pdf');
  assert.equal(full.response.headers.get('location'), null, `${label}: no redirect`);
  assert.deepEqual(full.buffer, expected, `${label}: the exact document bytes`);
  assert.doesNotMatch(full.raw, /request access/i, `${label}: no Google access wall`);
  assert.doesNotMatch(full.raw, /drive\.google\.com/i, `${label}: no Drive URL leaks`);
  assert.doesNotMatch(full.raw, /being moved/i, `${label}: no migration message`);

  // 4. Range reads — pdf.js pages a document in 128KB chunks on every device,
  //    and mobile Safari in particular will not render a PDF without them.
  const ranged = await call(baseUrl, 'GET', ticket.data.url, {
    cookie: student.cookie, manualRedirect: true, headers: { ...ua, Range: 'bytes=0-63' }
  });
  assert.equal(ranged.response.status, 206, `${label}: partial content is supported`);
  assert.equal(ranged.response.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(ranged.buffer, expected.subarray(0, 64), `${label}: correct byte range`);
  assert.equal(
    ranged.response.headers.get('content-range'),
    `bytes 0-63/${expected.length}`,
    `${label}: honest Content-Range`
  );

  // 5. A late-offset range (a student jumping to the last page).
  const tail = await call(baseUrl, 'GET', ticket.data.url, {
    cookie: student.cookie,
    manualRedirect: true,
    headers: { ...ua, Range: `bytes=${expected.length - 32}-${expected.length - 1}` }
  });
  assert.equal(tail.response.status, 206, `${label}: tail range`);
  assert.deepEqual(tail.buffer, expected.subarray(expected.length - 32), `${label}: correct tail bytes`);

  // 6. The viewer page itself is served to this device (same internal viewer,
  //    no Google-hosted preview).
  const page = await call(baseUrl, 'GET', `/viewer/${resourceId}`, {
    cookie: student.cookie, manualRedirect: true, headers: ua
  });
  assert.equal(page.response.status, 200, `${label}: the StudyCore viewer page loads`);
  assert.doesNotMatch(page.raw, /drive\.google\.com/i, `${label}: the viewer embeds no Drive frame`);
}

test('Google Drive documents — old and new — open in the StudyCore viewer', {
  timeout: 30000, concurrency: false
}, async (t) => {
  const drive = installFakeDrive();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // ── A Content Admin publishes a file straight from their Drive ────────
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
      google_drive_file_id: NEW_FILE_ID,
      google_drive_url: `https://drive.google.com/file/d/${NEW_FILE_ID}/view`,
      google_drive_access_token: ADMIN_TOKEN,
      file_name: 'Contract Law Lecture Notes.pdf',
      mime_type: 'application/pdf',
      file_size: String(NEW_PDF.length)
    }).forEach(([k, v]) => form.append(k, v));

    const publish = await call(baseUrl, 'POST', '/api/content-admin/resources', {
      cookie: adminCookie, body: form
    });
    assert.equal(publish.response.status, 201, publish.raw);
    const newResourceId = publish.data.resource.id;

    await t.test('publishing imports the Drive file into StudyCore storage', async () => {
      const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(newResourceId);
      assert.notEqual(row.storage_provider, 'google_drive',
        'new publishes must not leave the source Drive file as student storage');
      assert.equal(row.google_drive_file_id, NEW_FILE_ID, 'the original Drive id is kept only as provenance');
      assert.ok(row.stored_name, 'a real StudyCore storage key is recorded');
      assert.notEqual(row.stored_name, NEW_FILE_ID, 'the storage key is not the source Drive file id');
      assert.equal(row.file_size, NEW_PDF.length);

      const stored = await documentStorage.readBytes(row.stored_name, 0, NEW_PDF.length - 1, row.storage_provider);
      assert.deepEqual(Buffer.from(stored), NEW_PDF, 'the imported object matches the Drive file byte-for-byte');
    });

    // ── An OLD row: published from Drive BEFORE the storage changes ───────
    // This is the exact record shape that produced the reported error.
    const oldResourceId = `res-legacy-${uuidv4()}`;
    {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO resources (id, title, category, resource_type, subject, course, course_id,
          target_all, topic, semester, file_name, stored_name, file_size, mime_type,
          is_premium, publish_status, uploaded_by, uploader_role, uploaded_at, created_at,
          updated_at, storage_provider, google_drive_file_id, google_drive_url)
        VALUES (@id, @title, 'document', 'Notes', @subject, @course, @course_id,
          0, 'Foundations', 'Term 1', 'Torts Past Paper 2019.pdf', @stored_name, NULL, 'application/pdf',
          0, 'published', NULL, 'content_admin', @now, @now, @now, 'google_drive',
          @drive_id, @drive_url)
      `).run({
        id: oldResourceId, title: 'Torts Past Paper 2019', subject: 'Law', course: 'LAW',
        course_id: course.id, stored_name: OLD_FILE_ID, now,
        drive_id: OLD_FILE_ID, drive_url: `https://drive.google.com/file/d/${OLD_FILE_ID}/view`
      });
      db.prepare('INSERT INTO resource_programs (resource_id, program_code) VALUES (?, ?)')
        .run(oldResourceId, 'LAW');
    }

    // ── The student: a different person, no Google account involved ───────
    const student = createStudent();

    await t.test('a Drive-imported document remains readable when its old StudyCore copy is absent', async () => {
      // This is the recovery path for an older R2/local storage move: the
      // retained Picker provenance is used only by the server, after all
      // StudyCore student access checks have passed. The browser still gets
      // ordinary StudyCore bytes, never a Google URL or credential.
      const before = db.prepare('SELECT * FROM resources WHERE id = ?').get(newResourceId);
      await documentStorage.deleteObject(before.stored_name, before.storage_provider);

      const recovered = await call(baseUrl, 'GET', `/api/resources/${newResourceId}/stream`, {
        cookie: student.cookie, manualRedirect: true
      });
      assert.equal(recovered.response.status, 200, recovered.raw);
      assert.ok(recovered.buffer.equals(NEW_PDF), 'the server falls back to the original Drive bytes');
      assert.equal(recovered.response.headers.get('location'), null, 'students are never redirected to Google');
      assert.doesNotMatch(recovered.raw, /request access/i);
    });

    await t.test('NEW Drive document opens on desktop', async () => {
      await assertOpensInViewer(baseUrl, {
        resourceId: newResourceId, student, expected: NEW_PDF,
        label: 'new/desktop', userAgent: DESKTOP_UA
      });
    });

    await t.test('NEW Drive document opens on mobile', async () => {
      await assertOpensInViewer(baseUrl, {
        resourceId: newResourceId, student, expected: NEW_PDF,
        label: 'new/mobile', userAgent: MOBILE_UA
      });
    });

    await t.test('OLD Drive document (published before the storage changes) opens on desktop', async () => {
      await assertOpensInViewer(baseUrl, {
        resourceId: oldResourceId, student, expected: OLD_PDF,
        label: 'old/desktop', userAgent: DESKTOP_UA
      });
    });

    await t.test('OLD Drive document opens on mobile', async () => {
      await assertOpensInViewer(baseUrl, {
        resourceId: oldResourceId, student, expected: OLD_PDF,
        label: 'old/mobile', userAgent: MOBILE_UA
      });
    });

    await t.test('the "being moved into StudyCore" state is gone for good', async () => {
      for (const id of [oldResourceId, newResourceId]) {
        const stream = await call(baseUrl, 'GET', `/api/resources/${id}/stream`, {
          cookie: student.cookie, manualRedirect: true
        });
        assert.equal(stream.response.status, 200);
        assert.doesNotMatch(stream.raw, /being moved/i);
        assert.doesNotMatch(stream.raw, /check back shortly/i);
      }
    });

    await t.test('a HEAD request reports the true size from Drive', async () => {
      const head = await call(baseUrl, 'HEAD', `/api/resources/${oldResourceId}/stream`, {
        cookie: student.cookie, manualRedirect: true
      });
      assert.equal(head.response.status, 200);
      // The legacy row stored NO file_size; it comes back from Drive.
      assert.equal(head.response.headers.get('content-length'), String(OLD_PDF.length));
      assert.equal(head.response.headers.get('accept-ranges'), 'bytes');
    });

    await t.test('the student never needs, and never receives, Google credentials', async () => {
      for (const id of [oldResourceId, newResourceId]) {
        const meta = await call(baseUrl, 'GET', `/api/resources/${id}`, { cookie: student.cookie });
        assert.doesNotMatch(meta.raw, /ya29\./, 'no OAuth access token is exposed');
        assert.doesNotMatch(meta.raw, new RegExp(ADMIN_TOKEN));
        assert.doesNotMatch(meta.raw, new RegExp(NEW_FILE_ID), 'the source Drive file id stays server-side');
        assert.doesNotMatch(meta.raw, /drive\.google\.com/i, 'the source Drive URL stays server-side');
      }
    });

    await t.test('StudyCore access control still gates every Drive document', async () => {
      // A student in a different program must not read it. 'SICT' is a real
      // seeded program, so this exercises genuine program gating rather than
      // an unknown code.
      const outsider = createStudent();
      db.prepare('UPDATE users SET program_code = ? WHERE id = ?').run('SICT', outsider.id);
      const denied = await call(baseUrl, 'GET', `/api/resources/${oldResourceId}/stream`, {
        cookie: outsider.cookie, manualRedirect: true
      });
      assert.equal(denied.response.status, 403, 'program gating is unchanged');
      assert.notDeepEqual(denied.buffer, OLD_PDF);

      // And an unauthenticated request gets nothing at all.
      const anon = await call(baseUrl, 'GET', `/api/resources/${oldResourceId}/stream`, { manualRedirect: true });
      assert.equal(anon.response.status, 401);
    });

    await t.test('a Drive file that really is gone reports an honest error', async () => {
      const missingId = `res-missing-${uuidv4()}`;
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO resources (id, title, category, resource_type, subject, course, course_id,
          target_all, topic, semester, file_name, stored_name, file_size, mime_type,
          is_premium, publish_status, uploaded_by, uploader_role, uploaded_at, created_at,
          updated_at, storage_provider, google_drive_file_id, google_drive_url)
        VALUES (@id, 'Deleted Drive Notes', 'document', 'Notes', 'Law', 'LAW', @course_id,
          0, 'Foundations', 'Term 1', 'gone.pdf', @stored_name, NULL, 'application/pdf',
          0, 'published', NULL, 'content_admin', @now, @now, @now, 'google_drive',
          @drive_id, NULL)
      `).run({
        id: missingId, course_id: course.id, now,
        stored_name: '1GoneGoneGoneGoneGoneGoneGone0000',
        drive_id: '1GoneGoneGoneGoneGoneGoneGone0000'
      });
      db.prepare('INSERT INTO resource_programs (resource_id, program_code) VALUES (?, ?)')
        .run(missingId, 'LAW');

      const stream = await call(baseUrl, 'GET', `/api/resources/${missingId}/stream`, {
        cookie: student.cookie, manualRedirect: true
      });
      assert.equal(stream.response.status, 404);
      assert.equal(stream.response.headers.get('location'), null);
      // Honest about Drive, and NOT the fictional migration message.
      assert.match(stream.data.message, /Google Drive/i);
      assert.doesNotMatch(stream.data.message, /being moved/i);
      assert.doesNotMatch(stream.raw, /request access/i);
    });

    await t.test('the Main Admin dashboard imports a picked Drive file into StudyCore', async () => {
      // "Select from Google Drive" on the Main Admin upload form: Drive is the
      // SOURCE LIBRARY. The picked file is copied into StudyCore storage and
      // published as an ordinary StudyCore resource, and the student reads it
      // through the normal gated viewer — never from Google.
      const admin = {
        id: `admin-${uuidv4()}`,
        name: 'Importing Admin',
        email: `import-${uuidv4()}@test.studycore`,
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
      `).run(admin);
      const cookie = `${COOKIE_NAME}=${createToken(admin)}`;

      const form = new FormData();
      Object.entries({
        title: 'Imported From My Drive',
        category: 'document',
        courseId: course.id,
        semester: 'Term 1',
        topic: 'Foundations',
        targetAll: 'false',
        programs: 'LAW',
        publishStatus: 'published',
        // Exactly what the Picker hands the dashboard.
        google_drive_file_id: NEW_FILE_ID,
        google_drive_url: `https://drive.google.com/file/d/${NEW_FILE_ID}/view`,
        google_drive_access_token: ADMIN_TOKEN,
        file_name: 'Contract Law Lecture Notes.pdf',
        mime_type: 'application/pdf'
      }).forEach(([k, v]) => form.append(k, v));

      const published = await call(baseUrl, 'POST', '/api/admin/resources', { cookie, body: form });
      assert.equal(published.response.status, 201, published.raw);
      const importedId = published.data.resource.id;

      const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(importedId);
      // Drive is never the storage provider: the bytes are in StudyCore.
      assert.notEqual(row.storage_provider, 'google_drive');
      assert.notEqual(row.storage_provider, 'google_drive_vault');
      assert.ok(row.stored_name, 'a real StudyCore storage key is recorded');
      assert.notEqual(row.stored_name, NEW_FILE_ID);
      assert.equal(row.file_size, NEW_PDF.length);
      // The Drive id/URL survive as provenance only.
      assert.equal(row.google_drive_file_id, NEW_FILE_ID);

      const stored = await documentStorage.readBytes(row.stored_name, 0, NEW_PDF.length - 1, row.storage_provider);
      assert.deepEqual(Buffer.from(stored), NEW_PDF, 'the imported object matches the Drive file byte-for-byte');

      // And a student reads it through StudyCore's own gated viewer.
      await assertOpensInViewer(baseUrl, {
        resourceId: importedId, student, expected: NEW_PDF,
        label: 'main-admin-import', userAgent: DESKTOP_UA
      });
    });

    await t.test('a Drive file cannot be attached without a Picker token', async () => {
      // "Select from Google Drive" always supplies a short-lived OAuth token
      // alongside the file id, because that token is what lets StudyCore copy
      // the bytes in. A bare file id with no token cannot be imported, and
      // must never be stored as a bare Drive reference — that is exactly the
      // state that used to strand students on Google's "Request access" wall.
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

      const attempt = await call(baseUrl, 'PUT', `/api/admin/resources/${newResourceId}`, {
        cookie, body: link
      });
      assert.equal(attempt.response.status, 400, attempt.raw);
      assert.match(attempt.data.message, /Select from Google Drive/i);

      // And the existing imported document is untouched: still readable and
      // still stored in StudyCore, not relinked to the source Drive file.
      const after = db.prepare('SELECT * FROM resources WHERE id = ?').get(newResourceId);
      assert.notEqual(after.storage_provider, 'google_drive');
      assert.equal(after.google_drive_file_id, NEW_FILE_ID);
      assert.notEqual(after.stored_name, NEW_FILE_ID);
      const reread = await call(baseUrl, 'GET', `/api/resources/${newResourceId}/stream`, {
        cookie: student.cookie, manualRedirect: true
      });
      assert.equal(reread.response.status, 200);
      assert.ok(reread.buffer.equals(NEW_PDF));
    });

    await t.test('deleting the StudyCore resource does not delete the original Drive file', async () => {
      const before = drive.calls.filter((c) => c.method === 'DELETE').length;
      const removed = await call(baseUrl, 'DELETE', `/api/content-admin/resources/${newResourceId}`, {
        cookie: adminCookie
      });
      assert.equal(removed.response.status, 200, removed.raw);
      const after = drive.calls.filter((c) => c.method === 'DELETE').length;
      assert.equal(after, before,
        'the original source document belongs to its owner in Google Drive and must survive');
    });
  } finally {
    drive.restore();
    driveDocuments.forgetCaches();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
});
