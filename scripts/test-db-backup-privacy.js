// =============================================================================
// StudyCore — database backups are private
// -----------------------------------------------------------------------------
// The db-backups/ folder holds a copy of every account. These tests prove it
// cannot be reached from the web:
//   · no public URL or static path serves it
//   · the storage layer refuses the folder to every ordinary caller, so...
//   · ...even a resource row that is made to point at a backup (the Drive
//     file-id field is free text) can neither be streamed nor used to delete it
//
// Run: node --test scripts/test-db-backup-privacy.js
// =============================================================================

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { db, storage, call, createUser, createResource, cookieFor, baseUrl } = require('./helpers/test-app');
const { resolveCourse } = require('../lib/program-access');
const { ROLES } = require('../lib/roles');

const KEY = 'db-backups/studycore-2026-11-10T03-00-00Z.sqlite.gz';
const SECRET = 'SECRET-BACKUP-BYTES';
const backupFile = () => path.join(storage.LOCAL_DIR, KEY);
const MA110 = resolveCourse('MA110');

test.before(async () => {
  await storage.putObject({ key: KEY, body: Buffer.from(SECRET), internal: true });
  assert.ok(fs.existsSync(backupFile()));
});

async function sendForm(method, pathname, user, values) {
  const form = new FormData();
  for (const [k, v] of Object.entries(values || {})) form.append(k, v);
  const response = await fetch(`${baseUrl()}${pathname}`, {
    method, headers: { Cookie: cookieFor(user) }, body: values ? form : undefined
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, text };
}

test('the storage layer refuses the backup folder to ordinary callers', async () => {
  const variants = [KEY, `/${KEY}`, `./${KEY}`, KEY.toUpperCase(), KEY.replace('/', '\\'), `db-backups//${path.basename(KEY)}`];
  for (const key of variants) {
    await assert.rejects(storage.getObject(key), { code: 'InvalidKey' }, `getObject ${key}`);
    await assert.rejects(storage.headObject(key), { code: 'InvalidKey' }, `headObject ${key}`);
    await assert.rejects(storage.readBytes(key, 0, 15), { code: 'InvalidKey' }, `readBytes ${key}`);
    await assert.rejects(storage.deleteObject(key), { code: 'InvalidKey' }, `deleteObject ${key}`);
    await assert.rejects(storage.putObject({ key, body: Buffer.from('x') }), { code: 'InvalidKey' }, `putObject ${key}`);
    await assert.rejects(storage.getLocalObject(key), { code: 'InvalidKey' }, `getLocalObject ${key}`);
    await assert.rejects(storage.putLocalObject({ key, body: Buffer.from('x') }), { code: 'InvalidKey' }, `putLocalObject ${key}`);
  }
  assert.equal(fs.readFileSync(backupFile(), 'utf8'), SECRET, 'the backup is untouched');
});

test('no public URL serves a backup, signed in or not', async () => {
  const admin = createUser({ role: ROLES.ADMIN, program_code: null });
  const student = createUser({ program_code: 'SMMS' });
  const urls = [
    `/${KEY}`, `/uploads/${KEY}`, `/data/uploads/${KEY}`, `/data/${KEY}`,
    `/api/quiz/image/${encodeURIComponent(KEY)}`, `/api/quiz/image/${path.basename(KEY)}`,
    `/api/resources/${encodeURIComponent(KEY)}/stream`, `/api/uploads/${encodeURIComponent(KEY)}`
  ];
  for (const url of urls) {
    for (const user of [undefined, student, admin]) {
      const res = await call('GET', url, { user });
      assert.ok(res.status >= 400, `${url} must not succeed (got ${res.status})`);
      assert.ok(!res.text.includes(SECRET), `${url} leaked backup bytes`);
    }
  }
});

test('a resource row pointing at a backup cannot be streamed', async () => {
  const student = createUser({ program_code: 'SMMS' });
  const admin = createUser({ role: ROLES.ADMIN, program_code: null });
  const resource = createResource({
    category: 'document', stored_name: KEY, file_name: 'notes.pdf', mime_type: 'application/pdf',
    file_size: SECRET.length, is_premium: 0
  });
  for (const user of [student, admin]) {
    for (const method of ['GET', 'HEAD']) {
      const res = await call(method, `/api/resources/${resource.id}/stream`, { user });
      assert.ok(res.status >= 400, `${method} stream must fail (got ${res.status})`);
      assert.ok(!res.text.includes(SECRET));
    }
  }
});

test('a Content Admin cannot expose or delete a backup through the Drive file-id field', async () => {
  const publisher = createUser({ role: ROLES.CONTENT_ADMIN, program_code: null });
  const student = createUser({ program_code: 'SMMS' });
  const fields = {
    resourceType: 'notes', programCode: 'SMMS', courseId: MA110.id, topic: 'Limits', title: 'Notes',
    description: 'd', semester: 'Term 1', publishStatus: 'published',
    file_name: 'a.pdf', mime_type: 'application/pdf', file_size: '10'
  };

  const created = await sendForm('POST', '/api/content-admin/resources', publisher, { ...fields, google_drive_file_id: KEY });
  if (created.status === 201) {
    const id = created.data.resource.id;
    // Drop the Drive id so the row falls back to its stored reference.
    await sendForm('PUT', `/api/content-admin/resources/${id}`, publisher, { ...fields, google_drive_file_id: '' });
    const stream = await call('GET', `/api/resources/${id}/stream`, { user: student });
    assert.ok(stream.status >= 400, `stream must fail (got ${stream.status})`);
    assert.ok(!stream.text.includes(SECRET), 'backup bytes leaked to a student');

    await sendForm('DELETE', `/api/content-admin/resources/${id}`, publisher);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(fs.readFileSync(backupFile(), 'utf8'), SECRET, 'the backup still exists and is unchanged');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0, true);
});
