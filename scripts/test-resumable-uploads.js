'use strict';

// End-to-end coverage for resumable chunked uploads.
//
// The behaviour that matters is not "a file can be uploaded" — it is that an
// INTERRUPTED upload keeps the bytes it already sent and finishes from there.
// These tests therefore simulate the real failure: send some chunks, stop as
// if the phone locked or the signal died, then resume with a brand-new set of
// requests and assert the server assembles the complete, byte-identical file.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-resumable-'));
process.env.DATA_DIR = testDataDir;
process.env.JWT_SECRET = 'test-only-studycore-jwt-secret-0123456789';
process.env.CONTENT_ADMIN_ACCESS_CODE = 'content-admin-test-access-code';
process.env.NODE_ENV = 'test';
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';
process.env.R2_BUCKET_NAME = '';

const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const app = require('../server');
const storage = require('../lib/storage');
const resumable = require('../lib/resumable-uploads');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
const { ROLES } = require('../lib/roles');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  db.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

function makeUser(role = ROLES.CONTENT_ADMIN) {
  const id = `user-${randomUUID()}`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, subscription, created_at)
    VALUES (?, ?, ?, ?, ?, 'premium', ?)
  `).run(id, 'Uploader', `${id}@studycore.test`, bcrypt.hashSync('pw', 4), role, new Date().toISOString());
  return { id, role };
}

function cookieFor(user) {
  return `${COOKIE_NAME}=${createToken(user)}`;
}

async function api(method, pathname, { cookie, json, body, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (cookie) opts.headers.Cookie = cookie;
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (body !== undefined) {
    opts.body = body;
  }
  const res = await fetch(`${baseUrl}${pathname}`, opts);
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return { status: res.status, data, raw };
}

// A valid MP4 header so the magic-byte check on assembly passes, padded out
// to a realistic multi-chunk size.
function makeVideoBuffer(totalBytes) {
  const buf = crypto.randomBytes(totalBytes);
  Buffer.from([0x00, 0x00, 0x00, 0x18]).copy(buf, 0);
  Buffer.from('ftyp', 'latin1').copy(buf, 4);
  return buf;
}

async function startSession(cookie, { fileName, fileSize, mimeType, chunkSize }) {
  return api('POST', '/api/uploads/session', {
    cookie,
    json: { fileName, fileSize, mimeType, chunkSize }
  });
}

async function sendPart(cookie, sessionId, partNumber, chunk) {
  return api('PUT', `/api/uploads/session/${sessionId}/part/${partNumber}`, {
    cookie,
    body: chunk,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunk.length) }
  });
}

test('an interrupted upload resumes instead of restarting', async () => {
  const user = makeUser();
  const cookie = cookieFor(user);
  const chunkSize = resumable.MIN_CHUNK_SIZE; // 256KB keeps the test fast
  const file = makeVideoBuffer(chunkSize * 5 + 1234);

  const created = await startSession(cookie, {
    fileName: 'lecture.mp4',
    fileSize: file.length,
    mimeType: 'video/mp4',
    chunkSize
  });
  assert.equal(created.status, 201, created.raw);
  const session = created.data.session;
  assert.equal(session.totalChunks, 6);
  assert.deepEqual(session.receivedParts, []);

  // --- The uploader gets through two chunks, then the phone sleeps. --------
  for (const part of [0, 1]) {
    const chunk = file.subarray(part * chunkSize, Math.min(file.length, (part + 1) * chunkSize));
    const res = await sendPart(cookie, session.id, part, chunk);
    assert.equal(res.status, 200, res.raw);
  }

  // --- Later: the browser asks what survived. ------------------------------
  const resumeInfo = await api('GET', `/api/uploads/session/${session.id}`, { cookie });
  assert.equal(resumeInfo.status, 200, resumeInfo.raw);
  assert.deepEqual(resumeInfo.data.session.receivedParts, [0, 1],
    'the two delivered chunks must still be on the server');
  assert.deepEqual(resumeInfo.data.missingParts, [2, 3, 4, 5],
    'only the undelivered chunks should be requested again');
  assert.equal(resumeInfo.data.session.uploadedBytes, chunkSize * 2,
    'resumed progress must start from the bytes already stored, not zero');

  // --- Send only what is missing. ------------------------------------------
  for (const part of resumeInfo.data.missingParts) {
    const chunk = file.subarray(part * chunkSize, Math.min(file.length, (part + 1) * chunkSize));
    const res = await sendPart(cookie, session.id, part, chunk);
    assert.equal(res.status, 200, res.raw);
  }

  // --- Assemble and verify the bytes are exactly the original file. --------
  const row = resumable.getSession(session.id, user.id);
  assert.deepEqual(resumable.missingParts(row), []);
  const finalized = await resumable.finalizeSession(row);
  assert.equal(finalized.size, file.length);
  assert.equal(
    finalized.contentHash,
    crypto.createHash('sha256').update(file).digest('hex'),
    'the reassembled object must be byte-identical to the source file'
  );

  const stored = await storage.readBytes(finalized.key, 0, file.length - 1);
  assert.ok(stored.equals(file), 'stored object must match the original bytes');
});

test('re-sending a chunk that already landed is safe', async () => {
  const user = makeUser();
  const cookie = cookieFor(user);
  const chunkSize = resumable.MIN_CHUNK_SIZE;
  const file = makeVideoBuffer(chunkSize * 2);

  const created = await startSession(cookie, {
    fileName: 'notes.mp4', fileSize: file.length, mimeType: 'video/mp4', chunkSize
  });
  const session = created.data.session;

  const first = file.subarray(0, chunkSize);
  // After a dropped connection the client cannot know whether the last chunk
  // committed, so it re-sends. That must not corrupt or duplicate anything.
  await sendPart(cookie, session.id, 0, first);
  const again = await sendPart(cookie, session.id, 0, first);
  assert.equal(again.status, 200, again.raw);
  assert.deepEqual(again.data.receivedParts, [0], 'a re-sent chunk must not be recorded twice');

  await sendPart(cookie, session.id, 1, file.subarray(chunkSize));
  const row = resumable.getSession(session.id, user.id);
  const finalized = await resumable.finalizeSession(row);
  assert.equal(
    finalized.contentHash,
    crypto.createHash('sha256').update(file).digest('hex'),
    'an idempotent re-send must still assemble the correct file'
  );
});

test('a truncated chunk is rejected rather than silently corrupting the file', async () => {
  const user = makeUser();
  const cookie = cookieFor(user);
  const chunkSize = resumable.MIN_CHUNK_SIZE;
  const file = makeVideoBuffer(chunkSize * 2);

  const created = await startSession(cookie, {
    fileName: 'short.mp4', fileSize: file.length, mimeType: 'video/mp4', chunkSize
  });
  const session = created.data.session;

  // A non-final chunk that is shorter than chunk_size means the connection
  // died mid-chunk. Accepting it would corrupt the assembled file.
  const truncated = await sendPart(cookie, session.id, 0, file.subarray(0, 1000));
  assert.equal(truncated.status, 400, truncated.raw);

  const info = await api('GET', `/api/uploads/session/${session.id}`, { cookie });
  assert.deepEqual(info.data.session.receivedParts, [],
    'a partial chunk must not be recorded as received');
});

test('one uploader cannot touch another uploader\'s upload session', async () => {
  const owner = makeUser();
  const stranger = makeUser();
  const chunkSize = resumable.MIN_CHUNK_SIZE;

  const created = await startSession(cookieFor(owner), {
    fileName: 'private.mp4', fileSize: chunkSize * 2, mimeType: 'video/mp4', chunkSize
  });
  const session = created.data.session;

  const peek = await api('GET', `/api/uploads/session/${session.id}`, { cookie: cookieFor(stranger) });
  assert.equal(peek.status, 404, 'another account must not be able to inspect the session');

  const write = await sendPart(cookieFor(stranger), session.id, 0, Buffer.alloc(chunkSize));
  assert.equal(write.status, 404, 'another account must not be able to write chunks into it');

  const cancel = await api('DELETE', `/api/uploads/session/${session.id}`, { cookie: cookieFor(stranger) });
  assert.equal(cancel.status, 404, 'another account must not be able to cancel it');
});

test('students cannot open upload sessions at all', async () => {
  const student = makeUser(ROLES.STUDENT);
  const res = await startSession(cookieFor(student), {
    fileName: 'x.mp4', fileSize: 1024, mimeType: 'video/mp4'
  });
  assert.equal(res.status, 403);
});

test('oversized and unsupported files are refused before any bytes move', async () => {
  const user = makeUser();
  const cookie = cookieFor(user);

  const tooBig = await startSession(cookie, {
    fileName: 'huge.mp4', fileSize: 500 * 1024 * 1024 * 1024, mimeType: 'video/mp4'
  });
  assert.equal(tooBig.status, 413, 'the size limit must be enforced at session creation');

  const badType = await startSession(cookie, {
    fileName: 'payload.svg', fileSize: 2048, mimeType: 'image/svg+xml'
  });
  assert.equal(badType.status, 400, 'the extension allowlist must apply to resumable uploads too');
});

test('publishing a resource with a finished session stores the assembled file', async () => {
  const user = makeUser();
  const cookie = cookieFor(user);
  const chunkSize = resumable.MIN_CHUNK_SIZE;
  const file = makeVideoBuffer(chunkSize * 3);

  const program = db.prepare('SELECT code FROM programs LIMIT 1').get();
  const course = db.prepare(`
    SELECT c.id FROM courses c
    JOIN program_courses pc ON pc.course_id = c.id
    WHERE pc.program_code = ? LIMIT 1
  `).get(program.code);
  assert.ok(course, 'the seeded catalog should provide a course to publish into');

  const created = await startSession(cookie, {
    fileName: 'full-lecture.mp4', fileSize: file.length, mimeType: 'video/mp4', chunkSize
  });
  const session = created.data.session;
  for (let part = 0; part < session.totalChunks; part += 1) {
    const chunk = file.subarray(part * chunkSize, Math.min(file.length, (part + 1) * chunkSize));
    const res = await sendPart(cookie, session.id, part, chunk);
    assert.equal(res.status, 200, res.raw);
  }

  // The publish request carries the session id instead of the bytes, so it is
  // small and fast even though the video is not.
  const form = new FormData();
  form.append('resourceType', 'video');
  form.append('programCode', program.code);
  form.append('courseId', course.id);
  form.append('topic', 'Resumable topic');
  form.append('title', 'Resumable lecture');
  form.append('semester', 'Term 1');
  form.append('publishStatus', 'published');
  form.append('uploadSessionId', session.id);

  const published = await fetch(`${baseUrl}/api/content-admin/resources`, {
    method: 'POST', headers: { Cookie: cookie }, body: form
  });
  const body = await published.json();
  assert.equal(published.status, 201, JSON.stringify(body));
  assert.equal(body.resource.fileName, 'full-lecture.mp4');
  assert.equal(body.resource.fileSize, file.length);

  const row = db.prepare('SELECT stored_name FROM resources WHERE id = ?').get(body.resource.id);
  const stored = await storage.readBytes(row.stored_name, 0, file.length - 1);
  assert.ok(stored.equals(file), 'the published resource must hold the fully reassembled video');

  // The session is claimed, so the expiry sweeper must leave the live object
  // alone even once the session would otherwise have lapsed.
  db.prepare('UPDATE upload_sessions SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), session.id);
  await resumable.sweepExpiredSessions();
  const survives = await storage.readBytes(row.stored_name, 0, 3);
  assert.equal(survives.length, 4, 'a claimed upload must never be swept away');
});

test('expired, unclaimed sessions are swept along with their chunks', async () => {
  const user = makeUser();
  const cookie = cookieFor(user);
  const chunkSize = resumable.MIN_CHUNK_SIZE;

  const created = await startSession(cookie, {
    fileName: 'abandoned.mp4', fileSize: chunkSize * 2, mimeType: 'video/mp4', chunkSize
  });
  const session = created.data.session;
  await sendPart(cookie, session.id, 0, makeVideoBuffer(chunkSize));

  db.prepare('UPDATE upload_sessions SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), session.id);
  await resumable.sweepExpiredSessions();

  assert.equal(resumable.getSession(session.id, user.id), null,
    'the abandoned session should be gone');
  const gone = await api('GET', `/api/uploads/session/${session.id}`, { cookie });
  assert.equal(gone.status, 404);
});

test('a cancelled upload frees its chunks immediately', async () => {
  const user = makeUser();
  const cookie = cookieFor(user);
  const chunkSize = resumable.MIN_CHUNK_SIZE;

  const created = await startSession(cookie, {
    fileName: 'cancelled.mp4', fileSize: chunkSize * 2, mimeType: 'video/mp4', chunkSize
  });
  const session = created.data.session;
  await sendPart(cookie, session.id, 0, makeVideoBuffer(chunkSize));

  const cancelled = await api('DELETE', `/api/uploads/session/${session.id}`, { cookie });
  assert.equal(cancelled.status, 200, cancelled.raw);
  assert.equal(resumable.getSession(session.id, user.id), null);
});
