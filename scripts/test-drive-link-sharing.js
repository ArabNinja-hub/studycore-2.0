'use strict';

// Tests for the additive Google Drive step: after a Content Admin picks an
// existing Drive document through the EXISTING Picker, StudyCore ensures the
// file carries { type: 'anyone', role: 'reader' } — Drive's
// "General access → Anyone with the link → Viewer".
//
// What is pinned here:
//   1. Picking a NEW Drive document through the current Picker still saves the
//      existing document reference AND grants link-reader exactly once.
//   2. A file that already has "Anyone with the link" is left completely
//      alone (no permissions.create at all).
//   3. A Workspace policy block does NOT break the upload: the resource is
//      still saved with its Drive reference, and the admin gets a clear error.
//   4. Opening an EXISTING StudyCore document is unchanged — the student path
//      still works and makes no Drive permission calls.
//   5. No Google token is ever persisted or handed to a student.
//   6. The Picker itself is untouched and still hands the file to the
//      dashboard, now also passing the admin's token as an optional argument.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { db, call, createUser, createResource, cookieFor, baseUrl } = require('./helpers/test-app');
const { resolveCourse } = require('../lib/program-access');
const { ROLES } = require('../lib/roles');

const MA110 = resolveCourse('MA110');
const realFetch = global.fetch;

// ---------------------------------------------------------------------------
// A tiny stand-in for the Drive REST API. Only the two endpoints this feature
// touches exist; anything else (i.e. the local StudyCore server) is passed
// straight through to the real fetch.
// ---------------------------------------------------------------------------
function installDriveStub(handler) {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input.url || input);
    if (!url.startsWith('https://www.googleapis.com/drive/v3/')) return realFetch(input, init);
    const record = {
      url,
      method: (init.method || 'GET').toUpperCase(),
      authorization: (init.headers && (init.headers.Authorization || init.headers.authorization)) || '',
      body: init.body ? JSON.parse(init.body) : null
    };
    calls.push(record);
    const { status = 200, payload = {} } = handler(record) || {};
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  return calls;
}

function restoreFetch() { global.fetch = realFetch; }

function contentAdmin() {
  return createUser({
    role: ROLES.CONTENT_ADMIN,
    program_code: null,
    name: 'Drive Publisher'
  });
}

// Exactly the multipart body the existing dashboard builds for a picked Drive
// document (public/js/content-admin.js → buildFormData).
function drivePickBody({ fileId, token, ...overrides }) {
  const form = new FormData();
  const values = {
    resourceType: 'notes',
    programCode: 'SMMS',
    courseId: MA110.id,
    topic: 'Limits',
    title: 'Calculus notes from Drive',
    description: 'Picked from Google Drive.',
    semester: 'Term 1',
    publishStatus: 'published',
    google_drive_file_id: fileId,
    google_drive_url: `https://drive.google.com/file/d/${fileId}/view`,
    file_name: 'Calculus notes.pdf',
    mime_type: 'application/pdf',
    file_size: '123456',
    ...overrides
  };
  for (const [key, value] of Object.entries(values)) form.append(key, value);
  if (token) form.append('google_drive_access_token', token);
  return form;
}

async function postResource(user, form) {
  // The upload itself goes through the REAL fetch so the Drive stub only ever
  // sees Google traffic.
  const response = await realFetch(`${baseUrl()}/api/content-admin/resources`, {
    method: 'POST',
    headers: { Cookie: cookieFor(user) },
    body: form
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data, text };
}

// ---------------------------------------------------------------------------
// 1. Selecting a NEW existing Google Drive document through the current Picker
// ---------------------------------------------------------------------------

test('picking a new Drive document saves the reference AND grants Anyone-with-the-link Viewer', async (t) => {
  t.after(restoreFetch);
  const fileId = `drive-${randomUUID()}`;
  const calls = installDriveStub((req) => {
    if (req.method === 'GET') return { payload: { permissions: [{ id: 'owner-1', type: 'user', role: 'owner' }] } };
    return { payload: { id: 'anyoneWithLink' } };
  });

  const admin = contentAdmin();
  const result = await postResource(admin, drivePickBody({ fileId, token: 'ya29.picker-token' }));

  assert.equal(result.status, 201, result.text);
  assert.equal(result.data.driveShareWarning, undefined, 'a successful share raises no warning');

  // The EXISTING document reference is saved exactly as before.
  const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(result.data.resource.id);
  assert.equal(row.google_drive_file_id, fileId);
  assert.equal(row.google_drive_url, `https://drive.google.com/file/d/${fileId}/view`);
  assert.equal(row.storage_provider, 'google_drive');
  assert.equal(row.stored_name, fileId, 'the Drive file id stays the stored reference');

  // ...and exactly one permission was created, with the required shape.
  const created = calls.filter((c) => c.method === 'POST');
  assert.equal(created.length, 1, 'permissions.create runs exactly once');
  assert.deepEqual(created[0].body, { type: 'anyone', role: 'reader' },
    'the permission is precisely Anyone with the link → Viewer');
  assert.match(created[0].url, new RegExp(`/files/${fileId}/permissions`));
  assert.equal(created[0].authorization, 'Bearer ya29.picker-token',
    "the picking admin's own Picker token is used — the server holds no Drive credentials");

  // Nothing was moved, copied or downloaded.
  assert.ok(!calls.some((c) => /\/copy|alt=media|\/download/.test(c.url)),
    'no copy, download or export call is ever made');
});

test('the Google access token is never persisted or exposed to anyone', async (t) => {
  t.after(restoreFetch);
  const fileId = `drive-${randomUUID()}`;
  installDriveStub(() => ({ payload: { permissions: [] } }));

  const admin = contentAdmin();
  const result = await postResource(admin, drivePickBody({ fileId, token: 'ya29.super-secret-token' }));
  assert.equal(result.status, 201, result.text);
  assert.doesNotMatch(result.text, /ya29\./, 'the API response never echoes the token');

  const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(result.data.resource.id);
  assert.doesNotMatch(JSON.stringify(row), /ya29\./, 'no database column stores the token');

  // The student-facing payload carries the file reference only.
  const student = createUser({ program_code: 'SMMS' });
  const detail = await call('GET', `/api/resources/${result.data.resource.id}`, { user: student });
  assert.equal(detail.status, 200, detail.text);
  assert.doesNotMatch(detail.text, /ya29\./, 'students never receive a Google token');
  assert.equal(detail.data.resource.googleDriveFileId, fileId);
});

// ---------------------------------------------------------------------------
// 2. A file that is already shared must be left alone
// ---------------------------------------------------------------------------

test('a file that already has Anyone-with-the-link Viewer is not touched', async (t) => {
  t.after(restoreFetch);
  const fileId = `drive-${randomUUID()}`;
  const calls = installDriveStub(() => ({
    payload: { permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }] }
  }));

  const admin = contentAdmin();
  const result = await postResource(admin, drivePickBody({ fileId, token: 'ya29.picker-token' }));

  assert.equal(result.status, 201, result.text);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0,
    'already shared means do nothing — no permission is created');
  assert.equal(result.data.driveShareWarning, undefined);
});

test('existing broader link access (e.g. anyone/writer) is never downgraded', async (t) => {
  t.after(restoreFetch);
  const fileId = `drive-${randomUUID()}`;
  const calls = installDriveStub(() => ({
    payload: { permissions: [{ id: 'anyoneWithLink', type: 'anyone', role: 'writer' }] }
  }));

  const admin = contentAdmin();
  const result = await postResource(admin, drivePickBody({ fileId, token: 'ya29.picker-token' }));
  assert.equal(result.status, 201, result.text);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0,
    'a file that is already link-readable keeps the sharing the admin chose');
});

// ---------------------------------------------------------------------------
// 3. Workspace policy blocks public sharing → flow preserved, admin informed
// ---------------------------------------------------------------------------

test('a Workspace policy block preserves the upload and reports a clear admin error', async (t) => {
  t.after(restoreFetch);
  const fileId = `drive-${randomUUID()}`;
  installDriveStub((req) => {
    if (req.method === 'GET') return { payload: { permissions: [] } };
    return {
      status: 403,
      payload: {
        error: {
          code: 403,
          message: 'Sharing outside of the domain is not allowed.',
          errors: [{ reason: 'shareOutNotPermitted', message: 'Sharing outside of the domain is not allowed.' }]
        }
      }
    };
  });

  const admin = contentAdmin();
  const result = await postResource(admin, drivePickBody({ fileId, token: 'ya29.picker-token' }));

  // The existing flow is intact: the resource IS saved with its reference.
  assert.equal(result.status, 201, result.text);
  const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(result.data.resource.id);
  assert.equal(row.google_drive_file_id, fileId, 'the document reference survives a sharing failure');
  assert.equal(row.publish_status, 'published');

  // ...and the admin is told exactly what happened.
  assert.ok(result.data.driveShareWarning, 'the admin receives a warning');
  assert.match(result.data.driveShareWarning, /Anyone with the link/i);
  assert.match(result.data.driveShareWarning, /administrator|policy/i);

  // A student can still open it through the unchanged viewer path.
  const student = createUser({ program_code: 'SMMS' });
  const stream = await call('GET', `/api/resources/${result.data.resource.id}/stream`, { user: student });
  assert.equal(stream.status, 302, 'the existing Drive preview redirect still works');
});

test('Drive being unreachable never breaks the upload', async (t) => {
  t.after(restoreFetch);
  const fileId = `drive-${randomUUID()}`;
  global.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input.url || input);
    if (url.startsWith('https://www.googleapis.com/')) throw new Error('network down');
    return realFetch(input, init);
  };

  const admin = contentAdmin();
  const result = await postResource(admin, drivePickBody({ fileId, token: 'ya29.picker-token' }));
  assert.equal(result.status, 201, result.text);
  assert.equal(
    db.prepare('SELECT google_drive_file_id FROM resources WHERE id = ?').get(result.data.resource.id).google_drive_file_id,
    fileId
  );
  assert.ok(result.data.driveShareWarning, 'the admin is warned, the upload still succeeds');
});

test('a Drive selection without a token still saves exactly as before', async (t) => {
  t.after(restoreFetch);
  const fileId = `drive-${randomUUID()}`;
  const calls = installDriveStub(() => ({ payload: { permissions: [] } }));

  const admin = contentAdmin();
  // No google_drive_access_token: this is the pre-existing request shape, and
  // it must keep working without any Drive call at all.
  const result = await postResource(admin, drivePickBody({ fileId, token: null }));

  assert.equal(result.status, 201, result.text);
  assert.equal(calls.length, 0, 'no token means no Drive call — the old flow is untouched');
  assert.equal(result.data.driveShareWarning, undefined, 'and no scary warning for the legacy shape');
  assert.equal(
    db.prepare('SELECT google_drive_file_id FROM resources WHERE id = ?').get(result.data.resource.id).google_drive_file_id,
    fileId
  );
});

// ---------------------------------------------------------------------------
// 4. Opening an EXISTING StudyCore document is completely unchanged
// ---------------------------------------------------------------------------

test('an existing Drive-backed document added before this change still opens', async (t) => {
  t.after(restoreFetch);
  const calls = installDriveStub(() => ({ payload: { permissions: [] } }));

  const legacy = createResource({
    category: 'document',
    resource_type: 'Notes',
    course_id: MA110.id,
    subject: MA110.name,
    semester: 'Term 1',
    title: 'Legacy Drive notes',
    file_name: 'legacy.pdf',
    mime_type: 'application/pdf',
    storage_provider: 'google_drive',
    google_drive_file_id: 'legacy-drive-file',
    google_drive_url: 'https://drive.google.com/file/d/legacy-drive-file/view',
    stored_name: null,
    is_premium: 0,
    target_all: 1
  });

  const student = createUser({ program_code: 'SMMS' });

  const detail = await call('GET', `/api/resources/${legacy.id}`, { user: student });
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.data.resource.googleDriveFileId, 'legacy-drive-file');
  assert.equal(detail.data.resource.hasFile, true);

  const stream = await call('GET', `/api/resources/${legacy.id}/stream`, { user: student });
  assert.equal(stream.status, 302, 'the existing viewer redirect is unchanged');
  assert.match(stream.headers.get('location') || '', /legacy-drive-file/);

  assert.equal(calls.length, 0, 'simply opening a document never calls the Drive permissions API');
});

test('a locally stored (non-Drive) upload path is completely unaffected', async (t) => {
  t.after(restoreFetch);
  const calls = installDriveStub(() => ({ payload: { permissions: [] } }));

  const admin = contentAdmin();
  const form = new FormData();
  for (const [key, value] of Object.entries({
    resourceType: 'notes',
    programCode: 'SMMS',
    courseId: MA110.id,
    topic: 'Limits',
    title: 'Ordinary uploaded notes',
    description: 'A normal upload.',
    semester: 'Term 1',
    publishStatus: 'published'
  })) form.append(key, value);
  form.append('file', new Blob(['%PDF-1.4\nplain upload'], { type: 'application/pdf' }), 'notes.pdf');

  const result = await postResource(admin, form);
  assert.equal(result.status, 201, result.text);
  assert.equal(calls.length, 0, 'a normal upload never touches Google Drive');
  assert.equal(
    db.prepare('SELECT google_drive_file_id FROM resources WHERE id = ?').get(result.data.resource.id).google_drive_file_id,
    null
  );
});

// ---------------------------------------------------------------------------
// 5. The Picker and the admin workflow are not redesigned
// ---------------------------------------------------------------------------

test('the existing Picker flow is preserved and only passes the token along', () => {
  const picker = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'google-picker.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'content-admin.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'content-admin.html'), 'utf8');

  // The Picker still builds the same way and still hands off the same doc.
  assert.match(picker, /PickerBuilder/);
  assert.match(picker, /setDeveloperKey|setAppId|setOAuthToken/);
  assert.match(picker, /window\.onGoogleDriveFilePicked\(doc, state\.accessToken\)/,
    'the hand-off is the same call with one optional extra argument');

  // The admin UI is unchanged: same button, same status line, same fields.
  assert.match(html, /id="caSelectDriveBtn"/);
  assert.match(html, /id="caDriveStatus"/);
  assert.match(html, /id="caGoogleDriveFileId"/);

  // The token lives in memory only — never in a DOM field or storage.
  assert.doesNotMatch(html, /google_drive_access_token/,
    'the token is never rendered into the page');
  assert.doesNotMatch(dashboard, /localStorage[\s\S]{0,60}driveAccessToken/,
    'the token is never written to storage');
  assert.match(dashboard, /state\.driveAccessToken = null/,
    'the token is cleared with the form');
});

test('the server keeps no Google credentials of its own', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'google-drive.js'), 'utf8');
  assert.doesNotMatch(lib, /process\.env/,
    'the Drive helper reads no environment secret — it only uses the admin token it is given');
  assert.match(lib, /type: 'anyone', role: 'reader'/);
});
