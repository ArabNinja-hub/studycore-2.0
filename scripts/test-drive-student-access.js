'use strict';

// END-TO-END proof that Google Drive Picker documents are readable by students
// through StudyCore's own backend — never Google's "Request access" wall.
//
// THE MODEL UNDER TEST
//
// Google Drive is the admin's DOCUMENT SOURCE LIBRARY, not StudyCore's
// storage. "Select from Google Drive" REGISTERS the picked file: the resource
// row stores the Drive file id plus Drive's own metadata, and no bytes are
// copied anywhere at publish time. When a student opens the resource, the
// StudyCore backend reads the original file from Drive with ITS OWN
// credentials — the connected Google account whose encrypted refresh token
// lives in google_drive_accounts — and streams it through the ordinary
// session/program/subscription-gated /api/resources/:id/stream endpoint.
//
// This suite runs the real server against a scripted Google (token endpoint,
// Drive metadata, alt=media downloads and Workspace PDF exports) and walks:
//
//   · Content Admin publishes a picked Drive PDF  → registered reference,
//   · Main Admin publishes a picked Drive PDF     → registered reference,
//   · a native Google Doc registers and serves as its PDF export,
//   · a legacy row (an earlier build's shape) still opens,
//   · a file the SERVER cannot read is REFUSED at publish time (so the
//     "Document unavailable" student error can never be published),
//   · students on desktop AND mobile read every document byte-for-byte,
//     with no Google redirect, no Drive URL, no OAuth token, no "being
//     moved" state,
//   · program gating and anonymous rejection still apply,
//   · deleting a resource never deletes the original Drive file.

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
// The SAME OAuth client the Picker uses — required by the server-side
// connection (see lib/google-drive-vault.js). The browser API key below is
// only the link-share fallback credential.
process.env.GOOGLE_CLIENT_ID = '1076280995038-testclient.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_API_KEY = 'AIzaTestServerSideKey0000000000000000000';

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
const { ROLES } = require('../lib/roles');
const driveDocuments = require('../lib/drive-documents');
const vault = require('../lib/google-drive-vault');
const app = require('../server');

// The source documents in Google Drive. These bytes are NEVER copied — the
// student stream must fetch exactly these bytes from Drive, server-side.
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
const GDOC_PDF = pdfOf('StudyCore Drive document: exported Google Doc syllabus.');
const ADMIN_PDF = pdfOf('StudyCore Drive document: Main Admin past paper pack.');

const NEW_FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const OLD_FILE_ID = '1OldLegacyDriveFileId000000000000';
const GDOC_FILE_ID = '1GdocFileIdGdocFileIdGdocFileId0';
const ADMIN_FILE_ID = '1AdminPickFileIdAdminPickFileId0';
// Exists in Drive, but the connected account was never granted it (a file
// from somebody else's library). Drive answers 404, exactly like reality.
const UNREADABLE_FILE_ID = '1NotGrantedToServerAccount0000000';
// Explicitly refuses the connected account (access revoked after publish).
const REVOKED_FILE_ID = '1RevokedFromServerAccount00000000';

// Credentials the scripted Google accepts. VAULT_TOKEN is what the server
// mints from the connected account's refresh token — the ONLY credential
// students' reads may depend on. ADMIN_TOKEN is the Picker's short-lived
// browser token. Students have neither.
const VAULT_TOKEN = 'ya29.server-vault-access-token';
const ADMIN_TOKEN = 'ya29.admin-picker-token';
const SERVER_KEY = process.env.GOOGLE_API_KEY;

// Stand-in for Google Drive + the OAuth token endpoint. It models the real
// permission rules:
//   * 'vault'  — the connected account (StudyCore's own server credential);
//   * 'picker' — the uploader's per-file Picker grant (browser only);
//   * 'key'    — the browser API key, which only reads link-shared files;
//   * unlisted callers get 404, because Drive hides the existence of files
//     a caller cannot see. A student could never fetch these files.
function installFakeGoogle() {
  const realFetch = global.fetch;
  const files = new Map([
    [NEW_FILE_ID, { name: 'Contract Law Lecture Notes.pdf', mime: 'application/pdf', bytes: NEW_PDF, grants: ['vault', 'picker'] }],
    [OLD_FILE_ID, { name: 'Torts Past Paper 2019.pdf', mime: 'application/pdf', bytes: OLD_PDF, grants: ['vault'] }],
    [GDOC_FILE_ID, { name: 'Contract Law Syllabus', mime: 'application/vnd.google-apps.document', bytes: null, grants: ['vault', 'picker'] }],
    [ADMIN_FILE_ID, { name: 'Past Paper Pack 2024.pdf', mime: 'application/pdf', bytes: ADMIN_PDF, grants: ['vault', 'picker'] }],
    [UNREADABLE_FILE_ID, { name: 'Somebody Elses Notes.pdf', mime: 'application/pdf', bytes: pdfOf('private to another library'), grants: [] }],
    [REVOKED_FILE_ID, { name: 'Revoked Notes.pdf', mime: 'application/pdf', bytes: pdfOf('revoked'), grants: [], refuseVaultWith: 403 }]
  ]);
  const calls = [];

  function driveResponse(file, target, options) {
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
  }

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = (options && options.method) || 'GET';

    // ── OAuth token endpoint: code exchange and refresh-token minting ─────
    if (target === 'https://oauth2.googleapis.com/token') {
      calls.push({ url: target, method });
      const body = String((options && options.body) || '');
      if (body.includes('grant_type=authorization_code')) {
        return {
          ok: true, status: 200,
          json: async () => ({ access_token: VAULT_TOKEN, refresh_token: 'persisted-encrypted-refresh-token', expires_in: 3600 })
        };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: VAULT_TOKEN, expires_in: 3600 })
      };
    }

    if (target.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
      return { ok: true, status: 200, json: async () => ({ email: 'library-owner@example.com' }) };
    }

    if (!target.startsWith('https://www.googleapis.com/drive/')) {
      return realFetch(url, options);
    }

    calls.push({ url: target, method, headers: (options && options.headers) || {} });

    // Credential this request carries.
    const auth = (options.headers && options.headers.Authorization) || '';
    const credential = auth === `Bearer ${VAULT_TOKEN}`
      ? 'vault'
      : auth === `Bearer ${ADMIN_TOKEN}` ? 'picker' : (target.includes(`key=${SERVER_KEY}`) ? 'key' : null);

    // The connected account's "StudyCore Documents" folder lookup.
    if (target.includes('/files?q=')) {
      return { ok: true, status: 200, json: async () => ({ files: [{ id: 'folder-studycore', name: 'StudyCore Documents' }] }) };
    }

    const idMatch = target.match(/\/drive\/v3\/files\/([^?/]+)/);
    const fileId = idMatch ? decodeURIComponent(idMatch[1]) : null;
    const file = files.get(fileId);

    if (target.includes('/permissions')) {
      return { ok: true, status: 200, json: async () => ({ id: 'perm-1' }) };
    }

    if (!file) return { ok: false, status: 404, json: async () => ({ error: { message: 'File not found' } }) };

    // Workspace export (Docs/Sheets/Slides → PDF).
    if (target.includes('/export')) {
      if (!file.grants.includes(credential)) {
        return { ok: false, status: 404, json: async () => ({ error: { message: 'File not found' } }) };
      }
      if (file.mime === 'application/vnd.google-apps.document') {
        const headers = new Map([['Content-Type', 'application/pdf'], ['Content-Length', String(GDOC_PDF.length)]]);
        return {
          ok: true, status: 200,
          headers: { get: (h) => headers.get(h) || null },
          arrayBuffer: async () => GDOC_PDF.buffer.slice(GDOC_PDF.byteOffset, GDOC_PDF.byteOffset + GDOC_PDF.byteLength),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(GDOC_PDF));
              controller.close();
            }
          })
        };
      }
      return { ok: false, status: 403, json: async () => ({}) };
    }

    // Metadata.
    if (target.includes('fields=')) {
      if (!file.grants.includes(credential)) {
        // Drive hides ungranted files behind 404; an explicit revocation
        // answers 403 instead.
        const status = credential === 'vault' && file.refuseVaultWith ? file.refuseVaultWith : 404;
        return { ok: false, status, json: async () => ({ error: { message: status === 403 ? 'Access denied' : 'File not found' } }) };
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          id: fileId,
          name: file.name,
          mimeType: file.mime,
          size: file.bytes ? String(file.bytes.length) : undefined,
          modifiedTime: '2025-01-01T00:00:00.000Z',
          trashed: false
        })
      };
    }

    // alt=media — the real byte read, with Range support.
    if (!file.grants.includes(credential)) {
      const status = credential === 'vault' && file.refuseVaultWith ? file.refuseVaultWith : 404;
      return { ok: false, status, json: async () => ({}) };
    }
    if (!file.bytes) {
      // Native Workspace files have no binary content to download.
      return { ok: false, status: 403, json: async () => ({ error: { message: 'Only files with binary content can be downloaded.' } }) };
    }
    return driveResponse(file, target, options);
  };
  return {
    calls,
    files,
    restore() { global.fetch = realFetch; }
  };
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
// every Drive-backed resource is held to the identical standard on both
// desktop and mobile.
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

test('Google Drive-backed documents open in the StudyCore viewer', {
  timeout: 60000, concurrency: false
}, async (t) => {
  const google = installFakeGoogle();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // ── The Main Admin connects the Google account that owns the library ──
    // This is the "Connect Google Drive" flow: Google returns a refresh
    // token, which StudyCore persists encrypted. From here on the SERVER
    // authenticates to Drive by itself — that is the credential students'
    // reads depend on.
    await vault.handleCallback({
      code: 'auth-code-123',
      req: { protocol: 'https', get: () => 'studycore.example' },
      userId: null
    });
    assert.equal(vault.status().connected, true, 'the Drive account is connected');
    assert.equal(vault.status().email, 'library-owner@example.com');
    {
      const row = db.prepare("SELECT * FROM google_drive_accounts WHERE status = 'active'").get();
      assert.ok(row, 'the connection row exists');
      assert.notEqual(row.encrypted_refresh_token, 'persisted-encrypted-refresh-token',
        'the refresh token is encrypted at rest');
    }

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

    const publishPickedFile = (cookie, { fileId, fileName, mimeType, url, extra = {} }) => {
      const form = new FormData();
      Object.entries({
        resourceType: 'notes',
        programCode: 'LAW',
        courseId: course.id,
        topic: 'Foundations',
        title: 'Contract Law Lecture Notes',
        semester: 'Term 1',
        publishStatus: 'published',
        // Exactly what the Picker hands the dashboard. The access token is
        // optional for the server — it registers with its OWN credentials.
        google_drive_file_id: fileId,
        google_drive_url: url || `https://drive.google.com/file/d/${fileId}/view`,
        file_name: fileName,
        mime_type: mimeType,
        ...extra
      }).forEach(([k, v]) => form.append(k, v));
      return call(baseUrl, 'POST', '/api/content-admin/resources', { cookie, body: form });
    };

    const publish = await publishPickedFile(adminCookie, {
      fileId: NEW_FILE_ID,
      fileName: 'Contract Law Lecture Notes.pdf',
      mimeType: 'application/pdf',
      extra: { google_drive_access_token: ADMIN_TOKEN }
    });
    assert.equal(publish.response.status, 201, publish.raw);
    const newResourceId = publish.data.resource.id;

    await t.test('publishing REGISTERS the Drive file — nothing is copied into StudyCore', async () => {
      const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(newResourceId);
      assert.equal(row.storage_provider, 'google_drive',
        'a picked Drive file is a Google Drive-backed resource');
      assert.equal(row.stored_name, null, 'no StudyCore storage key — no copy was made');
      assert.equal(row.google_drive_file_id, NEW_FILE_ID, 'the Drive file id is stored');
      assert.equal(row.file_name, 'Contract Law Lecture Notes.pdf', 'Drive\'s own name is stored');
      assert.equal(row.mime_type, 'application/pdf', 'the served type is stored');
      assert.equal(row.file_size, NEW_PDF.length, 'Drive\'s own size is stored');
      assert.equal(row.content_hash, null, 'no content hash — the bytes were never read at publish');

      // Publish validates the exact student-read path with a one-byte probe.
      // It does not copy the document into StudyCore, but it does catch a
      // metadata-allowed / media-denied Drive reference before it is listed.
      const publishWindow = google.calls.filter((c) => c.url.includes(NEW_FILE_ID));
      assert.ok(publishWindow.length >= 1, 'the server verified the file with Drive');
      const mediaProbe = publishWindow.filter((c) => c.url.includes('alt=media'));
      assert.equal(mediaProbe.length, 1, 'publish performs one media-readability probe');
      assert.equal(mediaProbe[0].headers.Range, 'bytes=0-0', 'the probe reads only one byte');
      for (const c of publishWindow) {
        assert.ok(!c.url.includes('/export'), 'binary files are not exported at publish time');
        assert.equal(c.headers.Authorization, `Bearer ${VAULT_TOKEN}`,
          'publish-time verification used the SERVER\'s Google credential');
      }
    });

    // ── The student: a different person, no Google account involved ───────
    const student = createStudent();

    await t.test('the student stream fetches the Drive file with the SERVER credential', async () => {
      const readsBefore = google.calls.filter((c) => c.url.includes('alt=media') && c.url.includes(NEW_FILE_ID)).length;
      const stream = await call(baseUrl, 'GET', `/api/resources/${newResourceId}/stream`, {
        cookie: student.cookie, manualRedirect: true
      });
      assert.equal(stream.response.status, 200, stream.raw);
      assert.ok(stream.buffer.equals(NEW_PDF), 'the student receives the exact Drive bytes');

      const readCalls = google.calls
        .filter((c) => c.url.includes('alt=media') && c.url.includes(NEW_FILE_ID))
        .slice(readsBefore);
      assert.ok(readCalls.length >= 1, 'the backend fetched the file from Drive');
      for (const c of readCalls) {
        assert.equal(c.headers.Authorization, `Bearer ${VAULT_TOKEN}`,
          'student reads use the connected account\'s token — not the student\'s (none exists) and not the Picker\'s');
      }
      assert.equal(stream.response.headers.get('location'), null, 'never redirected to Google');
      assert.doesNotMatch(stream.raw, /request access/i);
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

    await t.test('a native Google Doc registers and serves as its PDF export', async () => {
      const form = new FormData();
      Object.entries({
        resourceType: 'notes',
        programCode: 'LAW',
        courseId: course.id,
        topic: 'Foundations',
        title: 'Contract Law Syllabus (Google Doc)',
        semester: 'Term 1',
        publishStatus: 'published',
        google_drive_file_id: GDOC_FILE_ID,
        google_drive_url: `https://drive.google.com/file/d/${GDOC_FILE_ID}/view`,
        file_name: 'Contract Law Syllabus',
        mime_type: 'application/vnd.google-apps.document'
      }).forEach(([k, v]) => form.append(k, v));
      const published = await call(baseUrl, 'POST', '/api/content-admin/resources', {
        cookie: adminCookie, body: form
      });
      assert.equal(published.response.status, 201, published.raw);
      const gdocId = published.data.resource.id;

      const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(gdocId);
      assert.equal(row.storage_provider, 'google_drive');
      assert.equal(row.mime_type, 'application/pdf', 'a Google Doc is registered as its PDF export');
      assert.equal(row.file_name, 'Contract Law Syllabus');

      // Students receive the exported PDF bytes, through the same reader.
      await assertOpensInViewer(baseUrl, {
        resourceId: gdocId, student, expected: GDOC_PDF,
        label: 'gdoc/mobile', userAgent: MOBILE_UA
      });
      const exportCall = google.calls.find((c) => c.url.includes(`${GDOC_FILE_ID}`) && c.url.includes('/export'));
      assert.ok(exportCall, 'the Workspace file was exported to PDF on read');
      assert.equal(exportCall.headers.Authorization, `Bearer ${VAULT_TOKEN}`);
    });

    // ── An OLD row: the exact shape an earlier build wrote ────────────────
    const oldResourceId = `res-legacy-${uuidv4()}`;
    {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO resources (id, title, category, resource_type, subject, course, course_id,
          target_all, topic, semester, file_name, stored_name, file_size, mime_type,
          is_premium, publish_status, uploaded_by, uploader_role, uploaded_at, created_at,
          updated_at, storage_provider, google_drive_file_id, google_drive_url)
        VALUES (@id, 'Torts Past Paper 2019', 'document', 'Notes', @subject, @course, @course_id,
          0, 'Foundations', 'Term 1', 'Torts Past Paper 2019.pdf', @stored_name, NULL, 'application/pdf',
          0, 'published', NULL, 'content_admin', @now, @now, @now, 'google_drive',
          @drive_id, @drive_url)
      `).run({
        id: oldResourceId, subject: 'Law', course: 'LAW',
        course_id: course.id, stored_name: OLD_FILE_ID, now,
        drive_id: OLD_FILE_ID, drive_url: `https://drive.google.com/file/d/${OLD_FILE_ID}/view`
      });
      db.prepare('INSERT INTO resource_programs (resource_id, program_code) VALUES (?, ?)')
        .run(oldResourceId, 'LAW');
    }

    await t.test('an OLD Drive row (published by an earlier build) opens on desktop and mobile', async () => {
      await assertOpensInViewer(baseUrl, {
        resourceId: oldResourceId, student, expected: OLD_PDF,
        label: 'old/desktop', userAgent: DESKTOP_UA
      });
      await assertOpensInViewer(baseUrl, {
        resourceId: oldResourceId, student, expected: OLD_PDF,
        label: 'old/mobile', userAgent: MOBILE_UA
      });
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

    await t.test('a Drive file the SERVER cannot read is REFUSED at publish time', async () => {
      // The file exists in Drive, but it is not part of the connected
      // library (Drive answers 404 to the server). Publishing it would be
      // publishing a resource every student sees as "Document unavailable" —
      // the exact reported bug — so the publish must fail, clearly.
      const attempt = await publishPickedFile(adminCookie, {
        fileId: UNREADABLE_FILE_ID,
        fileName: 'Somebody Elses Notes.pdf',
        mimeType: 'application/pdf'
      });
      assert.equal(attempt.response.status, 404, attempt.raw);
      assert.match(attempt.data.message, /could not be found/i);
      assert.match(attempt.data.message, /Select from Google Drive/i);
      assert.doesNotMatch(attempt.data.message, /request access/i);

      const count = db.prepare('SELECT COUNT(*) AS n FROM resources WHERE google_drive_file_id = ?')
        .get(UNREADABLE_FILE_ID).n;
      assert.equal(count, 0, 'no resource row is created for an unreadable file');
    });

    await t.test('a Drive file that explicitly refuses the server is refused with reconnect guidance', async () => {
      const attempt = await publishPickedFile(adminCookie, {
        fileId: REVOKED_FILE_ID,
        fileName: 'Revoked Notes.pdf',
        mimeType: 'application/pdf'
      });
      assert.equal(attempt.response.status, 403, attempt.raw);
      assert.match(attempt.data.message, /could not read this file/i);
      assert.match(attempt.data.message, /Admin → Integrations/i);
    });

    await t.test('publishing from Drive without a connected Google account fails with instructions', async () => {
      vault.disconnect();
      try {
        const attempt = await publishPickedFile(adminCookie, {
          fileId: NEW_FILE_ID,
          fileName: 'Contract Law Lecture Notes.pdf',
          mimeType: 'application/pdf'
        });
        assert.equal(attempt.response.status, 503, attempt.raw);
        assert.match(attempt.data.message, /not connected to Google Drive/i);
        assert.match(attempt.data.message, /Admin → Integrations/i);
        const count = db.prepare('SELECT COUNT(*) AS n FROM resources WHERE title = ? AND google_drive_file_id = ?')
          .get('Contract Law Lecture Notes', NEW_FILE_ID).n;
        assert.equal(count, 1, 'only the earlier successful publish exists');
      } finally {
        // Reconnect for the remaining subtests.
        await vault.handleCallback({
          code: 'auth-code-456',
          req: { protocol: 'https', get: () => 'studycore.example' },
          userId: null
        });
      }
    });

    await t.test('the Main Admin dashboard registers a picked Drive file the same way', async () => {
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
        title: 'Registered From My Drive',
        category: 'document',
        courseId: course.id,
        semester: 'Term 1',
        topic: 'Foundations',
        targetAll: 'false',
        programs: 'LAW',
        publishStatus: 'published',
        // Exactly what the Picker hands the dashboard.
        google_drive_file_id: ADMIN_FILE_ID,
        google_drive_url: `https://drive.google.com/file/d/${ADMIN_FILE_ID}/view`,
        google_drive_access_token: ADMIN_TOKEN,
        file_name: 'Past Paper Pack 2024.pdf',
        mime_type: 'application/pdf'
      }).forEach(([k, v]) => form.append(k, v));

      const published = await call(baseUrl, 'POST', '/api/admin/resources', { cookie, body: form });
      assert.equal(published.response.status, 201, published.raw);
      const registeredId = published.data.resource.id;

      const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(registeredId);
      assert.equal(row.storage_provider, 'google_drive', 'the Main Admin publish registers a Drive reference too');
      assert.equal(row.stored_name, null, 'no StudyCore copy was made');
      assert.equal(row.google_drive_file_id, ADMIN_FILE_ID);

      // And a student reads it through StudyCore's own gated viewer.
      await assertOpensInViewer(baseUrl, {
        resourceId: registeredId, student, expected: ADMIN_PDF,
        label: 'main-admin-register', userAgent: DESKTOP_UA
      });
    });

    await t.test('re-picking a different Drive file re-registers the reference', async () => {
      const form = new FormData();
      Object.entries({
        resourceType: 'notes',
        programCode: 'LAW',
        courseId: course.id,
        topic: 'Foundations',
        title: 'Contract Law Lecture Notes (replaced)',
        semester: 'Term 1',
        publishStatus: 'published',
        google_drive_file_id: ADMIN_FILE_ID,
        google_drive_url: `https://drive.google.com/file/d/${ADMIN_FILE_ID}/view`,
        google_drive_access_token: ADMIN_TOKEN,
        file_name: 'Past Paper Pack 2024.pdf',
        mime_type: 'application/pdf'
      }).forEach(([k, v]) => form.append(k, v));
      const updated = await call(baseUrl, 'PUT', `/api/content-admin/resources/${newResourceId}`, {
        cookie: adminCookie, body: form
      });
      assert.equal(updated.response.status, 200, updated.raw);

      const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(newResourceId);
      assert.equal(row.google_drive_file_id, ADMIN_FILE_ID, 'the reference follows the new pick');
      assert.equal(row.storage_provider, 'google_drive');
      assert.equal(row.stored_name, null);

      const stream = await call(baseUrl, 'GET', `/api/resources/${newResourceId}/stream`, {
        cookie: student.cookie, manualRedirect: true
      });
      assert.equal(stream.response.status, 200);
      assert.ok(stream.buffer.equals(ADMIN_PDF), 'the student now receives the new file\'s bytes');
    });

    await t.test('a metadata-only edit keeps the Drive reference untouched', async () => {
      const form = new FormData();
      Object.entries({
        resourceType: 'notes',
        programCode: 'LAW',
        courseId: course.id,
        topic: 'Foundations',
        title: 'Contract Law Lecture Notes (retitled)',
        semester: 'Term 1',
        publishStatus: 'published',
        // No token (the Picker did not run) and the SAME id: a plain edit.
        google_drive_file_id: ADMIN_FILE_ID,
        google_drive_url: `https://drive.google.com/file/d/${ADMIN_FILE_ID}/view`
      }).forEach(([k, v]) => form.append(k, v));
      const updated = await call(baseUrl, 'PUT', `/api/content-admin/resources/${newResourceId}`, {
        cookie: adminCookie, body: form
      });
      assert.equal(updated.response.status, 200, updated.raw);

      const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(newResourceId);
      assert.equal(row.google_drive_file_id, ADMIN_FILE_ID, 'the reference is preserved');
      assert.equal(row.storage_provider, 'google_drive');
      assert.equal(row.title, 'Contract Law Lecture Notes (retitled)');

      const stream = await call(baseUrl, 'GET', `/api/resources/${newResourceId}/stream`, {
        cookie: student.cookie, manualRedirect: true
      });
      assert.equal(stream.response.status, 200, 'still streams after a plain edit');
    });

    await t.test('the student never needs, and never receives, Google credentials', async () => {
      for (const id of [oldResourceId, newResourceId]) {
        const meta = await call(baseUrl, 'GET', `/api/resources/${id}`, { cookie: student.cookie });
        assert.doesNotMatch(meta.raw, /ya29\./, 'no OAuth access token is exposed');
        assert.doesNotMatch(meta.raw, new RegExp(ADMIN_TOKEN));
        assert.doesNotMatch(meta.raw, /drive\.google\.com/i, 'the source Drive URL stays server-side');
      }
      // The admin-facing serializer DOES expose provenance to Main Admins —
      // but not to students, and never to anonymous visitors.
      const anon = await call(baseUrl, 'GET', `/api/resources/${newResourceId}`, { manualRedirect: true });
      assert.equal(anon.response.status, 401);
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

    await t.test('deleting the StudyCore resource does not delete the original Drive file', async () => {
      const before = google.calls.filter((c) => c.method === 'DELETE').length;
      const removed = await call(baseUrl, 'DELETE', `/api/content-admin/resources/${newResourceId}`, {
        cookie: adminCookie
      });
      assert.equal(removed.response.status, 200, removed.raw);
      const after = google.calls.filter((c) => c.method === 'DELETE').length;
      assert.equal(after, before,
        'the original source document belongs to its owner in Google Drive and must survive');
    });
  } finally {
    google.restore();
    driveDocuments.forgetCaches();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
});
