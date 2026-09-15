'use strict';

// Documents must be VIEW-ONLY: readable inside the StudyCore reader, never
// savable as a file.
//
// WHAT WAS STILL OPEN
//
// The download button was removed and /api/resources/:id/download returns
// 403, but the stream URL itself remained a perfectly good file link. Pasted
// into the address bar — or reached via "Open in new tab", "Save link as", or
// by handing the URL to a native PDF plugin — it returned the complete PDF
// with its real filename. Every browser renders that in its BUILT-IN PDF
// viewer, which has its own Save and Print buttons, so the student got the
// file and none of the client-side guards in public/js/privacy-guard.js ever
// ran (they live on the reader page, which was never loaded).
//
// HOW IT IS CLOSED
//
// Fetch Metadata distinguishes the reader from the address bar with no
// guessing: the reader reads bytes via fetch()/XHR or an <img>/<video>
// element (Sec-Fetch-Dest empty/image/video), while a top-level navigation
// sends Sec-Fetch-Dest: document + Sec-Fetch-Mode: navigate — a combination
// the reader never produces.
//
// WHAT THIS IS NOT
//
// This is deterrence, consistent with docs/content-protection.md: a client
// that omits Sec-Fetch-* headers is still served, because refusing it would
// break older browsers to stop an attacker who can set headers anyway. The
// actual access control is requireAuth + the program and Premium gates, which
// these tests also re-assert.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-no-download-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-studycore-jwt-secret-0123456789';
process.env.CONTENT_ADMIN_ACCESS_CODE = 'no-download-access-code';
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db');
const storage = require('../lib/storage');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
const { ROLES } = require('../lib/roles');
const app = require('../server');

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n', 'latin1'),
  Buffer.from('1 0 obj<</Type/Catalog>>endobj\n', 'latin1'),
  Buffer.from('0123456789'.repeat(64), 'latin1'),
  Buffer.from('trailer<</Root 1 0 R>>\n%%EOF', 'latin1')
]);

// Headers a real browser sends for each way of asking for the URL.
const AS_ADDRESS_BAR = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1'
};
const AS_NEW_TAB = {
  Accept: 'text/html,application/xhtml+xml',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin'
};
const AS_PDF_PLUGIN = { 'Sec-Fetch-Dest': 'embed', 'Sec-Fetch-Mode': 'navigate' };
const AS_IFRAME = { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate' };
// What the reader itself sends.
const AS_READER = { 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' };
const AS_IMG = { 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors' };
const AS_VIDEO = { 'Sec-Fetch-Dest': 'video', 'Sec-Fetch-Mode': 'no-cors' };

let server;
let baseUrl;
let student;
let resourceId;

test.before(async () => {
  const now = new Date().toISOString();
  const key = `obj-${uuidv4()}.pdf`;
  const put = await storage.putObject({
    key,
    body: Readable.from([PDF_BYTES]),
    contentType: 'application/pdf'
  });

  resourceId = `res-${uuidv4()}`;
  db.prepare(`
    INSERT INTO resources (id, title, category, resource_type, publish_status, target_all,
      file_name, stored_name, file_size, mime_type, storage_provider, is_premium,
      uploaded_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(resourceId, 'Contract Law Past Paper', 'past_paper', 'Past Paper', 'published',
    'Past Paper 2024.pdf', key, PDF_BYTES.length, 'application/pdf', put.backend, now, now, now);

  const user = {
    id: `student-${uuidv4()}`,
    name: 'Chanda Student',
    email: `student-${uuidv4()}@test.studycore`,
    password: bcrypt.hashSync('student-password', 4),
    role: ROLES.STUDENT,
    subscription: 'premium',
    trial_end: new Date(Date.now() + 86400000).toISOString(),
    subscription_end: new Date(Date.now() + 86400000).toISOString(),
    created_at: now
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, subscription, trial_end, subscription_end, created_at)
    VALUES (@id, @name, @email, @password, @role, @subscription, @trial_end, @subscription_end, @created_at)
  `).run(user);
  student = { ...user, cookie: `${COOKIE_NAME}=${createToken(user)}` };

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
});

function streamUrl() {
  return `${baseUrl}/api/resources/${resourceId}/stream`;
}

async function get(headers, extra = {}) {
  const res = await fetch(streamUrl(), {
    redirect: 'manual',
    headers: { Cookie: student.cookie, ...headers, ...extra }
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { res, buffer, text: buffer.toString('utf8') };
}

// ---------------------------------------------------------------------------
// The file must not come back for anything that can save it
// ---------------------------------------------------------------------------

for (const [label, headers] of [
  ['the address bar', AS_ADDRESS_BAR],
  ['"Open link in new tab"', AS_NEW_TAB],
  ['a native PDF plugin (<embed>)', AS_PDF_PLUGIN],
  ['an <iframe>', AS_IFRAME]
]) {
  test(`the document is refused when the URL is opened through ${label}`, async () => {
    const { res, buffer, text } = await get(headers);

    assert.equal(res.status, 403, `${label} must not receive the file`);
    assert.ok(!buffer.includes(Buffer.from('%PDF', 'latin1')),
      `${label} must not receive a single byte of the PDF`);
    assert.ok(!text.includes('0123456789'.repeat(4)),
      `${label} must not receive the document body`);

    // A saved/stale link is usually a mistake, so point at the reader.
    assert.match(text, new RegExp(`/viewer/${resourceId}`),
      'the refusal directs the student to the StudyCore reader');
    // Nothing cacheable, and never an attachment the browser would save.
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const disposition = res.headers.get('content-disposition');
    assert.ok(!disposition || !/attachment/i.test(disposition),
      'the refusal must never be served as a download');
  });
}

test('the refusal never leaks the real filename a saved copy would use', async () => {
  const { res, text } = await get(AS_ADDRESS_BAR);
  assert.equal(res.status, 403);
  assert.ok(!text.includes('Past Paper 2024.pdf'),
    'the original filename is not disclosed to a navigation attempt');
});

// ---------------------------------------------------------------------------
// …while every legitimate reader path keeps working
// ---------------------------------------------------------------------------

test('the reader still receives the whole document', async () => {
  const { res, buffer } = await get(AS_READER);
  assert.equal(res.status, 200);
  assert.ok(buffer.equals(PDF_BYTES), 'the reader gets the exact bytes');
  assert.match(String(res.headers.get('content-type')), /application\/pdf/);
  // Still inline for the reader — never an attachment.
  assert.match(String(res.headers.get('content-disposition')), /^inline/);
});

test('pdf.js range paging still works', async () => {
  const { res, buffer } = await get(AS_READER, { Range: 'bytes=0-127' });
  assert.equal(res.status, 206, 'range requests are still served');
  assert.equal(buffer.length, 128);
  assert.ok(buffer.equals(PDF_BYTES.subarray(0, 128)));
});

test('<img> and <video> element loads are not mistaken for navigations', async () => {
  for (const [label, headers] of [['<img>', AS_IMG], ['<video>', AS_VIDEO]]) {
    const { res } = await get(headers);
    assert.equal(res.status, 200, `${label} must still load — it cannot save the file`);
  }
});

test('a client that sends no Fetch Metadata headers is still served', async () => {
  // Older browsers and non-browser clients. Refusing them would break real
  // students to stop an attacker who can set headers anyway, so this is
  // deliberately allowed — see docs/content-protection.md.
  const { res, buffer } = await get({});
  assert.equal(res.status, 200);
  assert.ok(buffer.equals(PDF_BYTES));
});

// ---------------------------------------------------------------------------
// The guard is deterrence layered ON TOP of real access control
// ---------------------------------------------------------------------------

test('the explicit download route is still refused', async () => {
  const res = await fetch(`${baseUrl}/api/resources/${resourceId}/download`, {
    headers: { Cookie: student.cookie }
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.message, /disabled/i);
});

test('the navigation guard never substitutes for authentication', async () => {
  // No session at all: still refused, and NOT with the friendly view-only
  // page, which would imply the document exists to an anonymous visitor.
  const res = await fetch(streamUrl(), { redirect: 'manual', headers: AS_READER });
  assert.ok(res.status === 401 || res.status === 403,
    `an anonymous read is refused (got ${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  assert.ok(!buffer.includes(Buffer.from('%PDF', 'latin1')));
});

test('an anonymous navigation cannot reach the document either', async () => {
  const res = await fetch(streamUrl(), { redirect: 'manual', headers: AS_ADDRESS_BAR });
  const buffer = Buffer.from(await res.arrayBuffer());
  assert.ok(res.status >= 400, `refused (got ${res.status})`);
  assert.ok(!buffer.includes(Buffer.from('%PDF', 'latin1')),
    'no bytes leak to an unauthenticated navigation');
});
