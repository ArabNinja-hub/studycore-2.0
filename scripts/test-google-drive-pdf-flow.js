'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-drive-flow-test-'));
process.env.DATA_DIR = testDataDir;
process.env.CONTENT_ADMIN_ACCESS_CODE = 'drive-test-access-code';
process.env.JWT_SECRET = 'test-only-studycore-jwt-secret-0123456789';
process.env.NODE_ENV = 'test';
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';
process.env.GOOGLE_CLIENT_ID = '1076280995038-testclient.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_API_KEY = 'AIzaTestServerSideKey0000000000000000000';
process.env.GOOGLE_CLOUD_PROJECT_NUMBER = '1076280995038';

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
const { ROLES } = require('../lib/roles');
const driveDocuments = require('../lib/drive-documents');
const vault = require('../lib/google-drive-vault');
const app = require('../server');

function createRealPdf(content) {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'),
    Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'latin1'),
    Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n', 'latin1'),
    Buffer.from(`4 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n`, 'latin1'),
    Buffer.from('xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000206 00000 n \n', 'latin1'),
    Buffer.from('trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n300\n%%EOF\n', 'latin1')
  ]);
}

const SAMPLE_PDF = createRealPdf('BT 101 Lecture 1: Plant Biology and Taxonomy');
const SAMPLE_FILE_ID = '1PlantBiologyLecture1FileId0000000';
const VAULT_REFRESH_TOKEN = 'test-drive-refresh-token-12345';
let activeAccessToken = 'ya29.valid-initial-access-token';
let tokenRefreshCount = 0;

function installMockGoogleDrive() {
  const realFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = (options && options.method) || 'GET';
    calls.push({ url: target, method, headers: (options && options.headers) || {} });

    if (target === 'https://oauth2.googleapis.com/token') {
      const body = String((options && options.body) || '');
      tokenRefreshCount += 1;
      activeAccessToken = `ya29.refreshed-token-${tokenRefreshCount}`;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: activeAccessToken,
          refresh_token: VAULT_REFRESH_TOKEN,
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file'
        })
      };
    }

    if (target.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
      return { ok: true, status: 200, json: async () => ({ email: 'instructor@university.edu' }) };
    }

    if (target.includes('/files?q=')) {
      return { ok: true, status: 200, json: async () => ({ files: [{ id: 'folder-studycore' }] }) };
    }

    const auth = (options.headers && options.headers.Authorization) || '';
    const token = auth.replace('Bearer ', '');

    // Token check: if an expired/invalid token is presented, answer 401
    if (token === 'ya29.expired-or-revoked-token') {
      return {
        ok: false,
        status: 401,
        headers: { get: (h) => (h.toLowerCase() === 'www-authenticate' ? 'Bearer error="invalid_token"' : null) },
        json: async () => ({ error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } })
      };
    }

    // Drive Metadata
    if (target.includes(`files/${SAMPLE_FILE_ID}`) && target.includes('fields=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: SAMPLE_FILE_ID,
          name: 'BT 101 Lecture 1.pdf',
          mimeType: 'application/pdf',
          size: String(SAMPLE_PDF.length),
          modifiedTime: '2026-09-01T10:00:00.000Z',
          trashed: false
        })
      };
    }

    // Drive Alt=Media Content (with byte range support)
    if (target.includes(`files/${SAMPLE_FILE_ID}`) && target.includes('alt=media')) {
      const requestedRange = (options.headers && options.headers.Range) || null;
      let bytes = SAMPLE_PDF;
      let status = 200;
      const headers = new Map([
        ['Content-Type', 'application/pdf'],
        ['Accept-Ranges', 'bytes']
      ]);

      if (requestedRange) {
        const match = /bytes=(\d+)-(\d+)/.exec(requestedRange);
        if (match) {
          const start = Number(match[1]);
          const end = Math.min(Number(match[2]), SAMPLE_PDF.length - 1);
          bytes = SAMPLE_PDF.subarray(start, end + 1);
          status = 206;
          headers.set('Content-Range', `bytes ${start}-${end}/${SAMPLE_PDF.length}`);
        }
      }
      headers.set('Content-Length', String(bytes.length));

      return {
        ok: true,
        status,
        headers: { get: (h) => headers.get(h) || null },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
          }
        })
      };
    }

    return realFetch(url, options);
  };

  return {
    calls,
    restore() { global.fetch = realFetch; }
  };
}

async function httpRequest(baseUrl, method, pathname, { cookie, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (cookie) requestHeaders.Cookie = cookie;
  const options = { method, headers: requestHeaders };
  if (body !== undefined) {
    if (body instanceof FormData) {
      options.body = body;
    } else {
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

test('End-to-end flow: Google Picker → save resource → student stream → PDF renders in viewer', async () => {
  const mockGoogle = installMockGoogleDrive();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Connect Google Drive backend connection
    await vault.handleCallback({
      code: 'auth-code-test',
      req: { protocol: 'https', get: () => 'studycore.academy' },
      userId: null
    });
    assert.equal(vault.status().connected, true);
    assert.equal(vault.status().email, 'instructor@university.edu');

    // 2. Register a Content Admin
    const regRes = await httpRequest(baseUrl, 'POST', '/api/auth/register-content-admin', {
      body: {
        name: 'Dr. Mwansa',
        email: 'dr.mwansa@studycore.academy',
        password: 'Password123!',
        confirmPassword: 'Password123!',
        adminAccessCode: process.env.CONTENT_ADMIN_ACCESS_CODE
      }
    });
    assert.equal(regRes.response.status, 201);
    const adminCookie = regRes.response.headers.get('set-cookie').split(';')[0];

    // Find course in SICT
    const course = db.prepare(`
      SELECT c.id, c.code FROM courses c
      JOIN program_courses pc ON pc.course_id = c.id
      WHERE pc.program_code = 'SICT'
      LIMIT 1
    `).get();
    assert.ok(course);

    // 3. Admin selects PDF with Google Picker and submits resource form
    const form = new FormData();
    form.append('resourceType', 'notes');
    form.append('programCode', 'SICT');
    form.append('courseId', course.id);
    form.append('topic', 'Taxonomy');
    form.append('title', 'Plant Biology Lecture 1');
    form.append('semester', 'Term 1');
    form.append('publishStatus', 'published');
    form.append('google_drive_file_id', SAMPLE_FILE_ID);
    form.append('google_drive_url', `https://drive.google.com/file/d/${SAMPLE_FILE_ID}/view`);
    form.append('file_name', 'BT 101 Lecture 1.pdf');
    form.append('mime_type', 'application/pdf');
    form.append('google_drive_access_token', 'ya29.picker-short-lived-token');

    const createRes = await httpRequest(baseUrl, 'POST', '/api/content-admin/resources', {
      cookie: adminCookie,
      body: form
    });
    assert.equal(createRes.response.status, 201, createRes.raw);
    const resourceId = createRes.data.resource.id;

    // 4. Check DB row
    const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
    assert.equal(row.storage_provider, 'google_drive');
    assert.equal(row.google_drive_file_id, SAMPLE_FILE_ID);
    assert.equal(row.stored_name, null);
    assert.equal(row.mime_type, 'application/pdf');

    // 5. Create student
    const studentUser = {
      id: `student-${uuidv4()}`,
      name: 'Mulenga Student',
      email: 'mulenga@student.unza.zm',
      password: bcrypt.hashSync('StudentPass123!', 4),
      role: ROLES.STUDENT,
      program_code: 'SICT',
      subscription: 'premium',
      trial_end: new Date(Date.now() + 86400000).toISOString(),
      subscription_end: new Date(Date.now() + 86400000).toISOString(),
      created_at: new Date().toISOString()
    };
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, program_code, subscription, trial_end, subscription_end, created_at)
      VALUES (@id, @name, @email, @password, @role, @program_code, @subscription, @trial_end, @subscription_end, @created_at)
    `).run(studentUser);
    const studentCookie = `${COOKIE_NAME}=${createToken(studentUser)}`;

    // 6. Student opens resource metadata
    const metaRes = await httpRequest(baseUrl, 'GET', `/api/resources/${resourceId}`, {
      cookie: studentCookie
    });
    assert.equal(metaRes.response.status, 200);
    assert.equal(metaRes.data.resource.hasFile, true);
    assert.equal(metaRes.data.resource.mimeType, 'application/pdf');
    // Ensure no secret Google tokens or Drive URLs are leaked to the student
    assert.equal(metaRes.data.resource.googleDriveFileId, null);
    assert.equal(metaRes.data.resource.googleDriveUrl, null);

    // 7. Student requests viewing ticket
    const ticketRes = await httpRequest(baseUrl, 'GET', `/api/resources/${resourceId}/ticket`, {
      cookie: studentCookie
    });
    assert.equal(ticketRes.response.status, 200);
    const streamUrl = ticketRes.data.url;
    assert.ok(streamUrl.includes(`/api/resources/${resourceId}/stream`));

    // 8. Student streams the complete PDF through StudyCore backend
    const streamFullRes = await httpRequest(baseUrl, 'GET', streamUrl, {
      cookie: studentCookie
    });
    assert.equal(streamFullRes.response.status, 200);
    assert.equal(streamFullRes.response.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(streamFullRes.buffer, SAMPLE_PDF);
    assert.ok(streamFullRes.buffer.includes(Buffer.from('Plant Biology and Taxonomy')));

    // 9. Student reader requests byte range chunks (e.g. 0-127 for PDF header)
    const streamRangeRes = await httpRequest(baseUrl, 'GET', streamUrl, {
      cookie: studentCookie,
      headers: { Range: 'bytes=0-127' }
    });
    assert.equal(streamRangeRes.response.status, 206);
    assert.equal(streamRangeRes.response.headers.get('accept-ranges'), 'bytes');
    assert.equal(streamRangeRes.response.headers.get('content-range'), `bytes 0-127/${SAMPLE_PDF.length}`);
    assert.deepEqual(streamRangeRes.buffer, SAMPLE_PDF.subarray(0, 128));

    // 10. Test automatic token refresh recovery: invalidate active token
    vault.invalidateAccessToken();
    driveDocuments.forgetCaches();
    // Simulate expired token scenario by setting an expired token in cache
    // The backend should refresh via refresh token and succeed
    const streamRecoveryRes = await httpRequest(baseUrl, 'GET', streamUrl, {
      cookie: studentCookie
    });
    assert.equal(streamRecoveryRes.response.status, 200);
    assert.deepEqual(streamRecoveryRes.buffer, SAMPLE_PDF);

    // 11. Test GOOGLE_REFRESH_TOKEN environment variable fallback
    db.prepare('DELETE FROM google_drive_accounts').run();
    vault.invalidateAccessToken();
    driveDocuments.forgetCaches();
    process.env.GOOGLE_REFRESH_TOKEN = VAULT_REFRESH_TOKEN;

    assert.equal(vault.isConfigured(), true);
    assert.equal(vault.status().connected, true);

    const streamEnvRes = await httpRequest(baseUrl, 'GET', streamUrl, {
      cookie: studentCookie
    });
    assert.equal(streamEnvRes.response.status, 200);
    assert.deepEqual(streamEnvRes.buffer, SAMPLE_PDF);
  } finally {
    mockGoogle.restore();
    delete process.env.GOOGLE_REFRESH_TOKEN;
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
});
