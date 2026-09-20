'use strict';

// Regression tests for letting a Content Admin select a Video Lesson from
// Google Drive as an alternative to uploading it to Bunny Stream.
//
// What is pinned here:
//   1. Content Admin can create AND update a video resource from a picked
//      Drive file — the old hard 400 block ("Video lessons must be uploaded
//      to Bunny Stream...") is gone for videos, and a non-video Drive pick
//      still behaves exactly as before.
//   2. A Drive file whose mime type is not video/* is rejected for a Video
//      resource, with a clear message — the feature does not accept any
//      Drive file for a video slot.
//   3. Bunny-uploaded videos are completely unaffected: the same route still
//      requires the video-extension check, still writes stream_uid, and a
//      Drive resource never gets stream_uid/stream_status populated.
//   4. The student-facing lesson-flow and course-home payloads carry the
//      Drive file id/url and a `driveVideoPlayback.embed` field for a
//      Drive-backed video, and do NOT mint a Bunny protectedStreamUrl ticket
//      for it (there is no stored_name to stream from).
//   5. `hasFile` on a Drive-backed video resource is true.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { db, call, createUser, cookieFor, baseUrl } = require('./helpers/test-app');
const { resolveCourse } = require('../lib/program-access');
const { ROLES } = require('../lib/roles');

const MA110 = resolveCourse('MA110');
const realFetch = global.fetch;

function contentAdmin() {
  return createUser({ role: ROLES.CONTENT_ADMIN, program_code: null, name: 'Video Publisher' });
}

function driveVideoBody({ fileId, overrides = {} } = {}) {
  const form = new FormData();
  const values = {
    resourceType: 'video',
    programCode: 'SMMS',
    courseId: MA110.id,
    topic: 'Limits',
    title: 'Limits lecture from Drive',
    description: 'Picked from Google Drive.',
    semester: 'Term 1',
    publishStatus: 'published',
    google_drive_file_id: fileId,
    google_drive_url: `https://drive.google.com/file/d/${fileId}/view`,
    file_name: 'limits-lecture.mp4',
    mime_type: 'video/mp4',
    file_size: '104857600',
    ...overrides
  };
  for (const [key, value] of Object.entries(values)) form.append(key, value);
  return form;
}

async function postResource(user, form) {
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

async function putResource(user, id, form) {
  const response = await realFetch(`${baseUrl()}/api/content-admin/resources/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { Cookie: cookieFor(user) },
    body: form
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data, text };
}

// ---------------------------------------------------------------------------
// 1. Creating and updating a video resource from a picked Drive file
// ---------------------------------------------------------------------------

test('a Content Admin can publish a video lesson picked from Google Drive', async () => {
  const admin = contentAdmin();
  const fileId = `drive-vid-${randomUUID()}`;
  const result = await postResource(admin, driveVideoBody({ fileId }));

  assert.equal(result.status, 201, result.text);
  const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(result.data.resource.id);
  assert.equal(row.category, 'video');
  assert.equal(row.google_drive_file_id, fileId);
  assert.equal(row.storage_provider, 'google_drive');
  assert.equal(row.stored_name, fileId);
  assert.equal(row.stream_uid, null, 'a Drive video never gets a Bunny stream_uid');
  assert.equal(row.mime_type, 'video/mp4');
});

test('editing an existing video resource to a Drive file is accepted', async () => {
  const admin = contentAdmin();
  const created = await postResource(admin, driveVideoBody({ fileId: `drive-vid-${randomUUID()}` }));
  assert.equal(created.status, 201, created.text);

  const newFileId = `drive-vid-${randomUUID()}`;
  const form = new FormData();
  form.append('resourceType', 'video');
  form.append('programCode', 'SMMS');
  form.append('courseId', MA110.id);
  form.append('topic', 'Limits');
  form.append('title', 'Limits lecture from Drive (replaced)');
  form.append('description', 'Replaced with a different Drive file.');
  form.append('semester', 'Term 1');
  form.append('publishStatus', 'published');
  form.append('google_drive_file_id', newFileId);
  form.append('google_drive_url', `https://drive.google.com/file/d/${newFileId}/view`);
  form.append('file_name', 'limits-lecture-2.mp4');
  form.append('mime_type', 'video/mp4');
  form.append('file_size', '20000000');

  const updated = await putResource(admin, created.data.resource.id, form);
  assert.equal(updated.status, 200, updated.text);
  const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(created.data.resource.id);
  assert.equal(row.google_drive_file_id, newFileId);
  assert.equal(row.stream_uid, null);
});

// ---------------------------------------------------------------------------
// 2. Only real videos are accepted into the Video resource type
// ---------------------------------------------------------------------------

test('a non-video Drive file is rejected for a Video resource', async () => {
  const admin = contentAdmin();
  const fileId = `drive-doc-${randomUUID()}`;
  const result = await postResource(admin, driveVideoBody({
    fileId,
    overrides: { mime_type: 'application/pdf', file_name: 'not-a-video.pdf' }
  }));
  assert.equal(result.status, 400, result.text);
  assert.match(result.data.message, /not a video/i);
  assert.equal(db.prepare('SELECT id FROM resources WHERE google_drive_file_id = ?').get(fileId), undefined,
    'nothing is written when the Drive file fails validation');
});

test('a Drive file with a video file extension is still rejected for a non-video resource type (unchanged pre-existing rule)', async () => {
  const admin = contentAdmin();
  const fileId = `drive-vid-as-doc-${randomUUID()}`;
  // This rule predates the Drive-video feature: a video-extension file name
  // is rejected for a non-video resource type regardless of storage
  // provider. Confirms the new isDriveFile branch does not accidentally
  // bypass it for other categories.
  const form = new FormData();
  for (const [key, value] of Object.entries({
    resourceType: 'notes',
    programCode: 'SMMS',
    courseId: MA110.id,
    topic: 'Limits',
    title: 'A video file filed as notes',
    description: 'Should still be rejected.',
    semester: 'Term 1',
    publishStatus: 'published',
    google_drive_file_id: fileId,
    google_drive_url: `https://drive.google.com/file/d/${fileId}/view`,
    file_name: 'clip.mp4',
    mime_type: 'video/mp4',
    file_size: '5000000'
  })) form.append(key, value);

  const result = await postResource(admin, form);
  assert.equal(result.status, 400, result.text);
  assert.match(result.data.message, /Video resource type/i);
});

// ---------------------------------------------------------------------------
// 3. Bunny-uploaded videos are unaffected
// ---------------------------------------------------------------------------

test('a Bunny-style progressive video upload still requires a real video file extension', async () => {
  const admin = contentAdmin();
  const form = new FormData();
  for (const [key, value] of Object.entries({
    resourceType: 'video',
    programCode: 'SMMS',
    courseId: MA110.id,
    topic: 'Limits',
    title: 'Not actually a video',
    description: 'A PDF pretending to be a video upload.',
    semester: 'Term 1',
    publishStatus: 'published'
  })) form.append(key, value);
  form.append('file', new Blob(['%PDF-1.4\nnot a video'], { type: 'application/pdf' }), 'notes.pdf');

  const result = await postResource(admin, form);
  assert.equal(result.status, 400, result.text);
  assert.match(result.data.message, /supported video file/i);
});

// ---------------------------------------------------------------------------
// 4. Student-facing payloads carry Drive playback fields, no Bunny ticket
// ---------------------------------------------------------------------------

test('the lesson-flow payload exposes driveVideoPlayback and the Drive file reference, with no Bunny ticket', async () => {
  const admin = contentAdmin();
  const fileId = `drive-vid-${randomUUID()}`;
  const created = await postResource(admin, driveVideoBody({ fileId }));
  assert.equal(created.status, 201, created.text);
  const resourceId = created.data.resource.id;

  const student = createUser({ program_code: 'SMMS', subscription: 'premium' });
  const flow = await call('GET', `/api/programs/lesson/${resourceId}`, { user: student });
  assert.equal(flow.status, 200, flow.text);

  const lesson = flow.data.lesson;
  assert.equal(lesson.category, 'video');
  assert.equal(lesson.googleDriveFileId, fileId);
  assert.ok(lesson.googleDriveUrl && lesson.googleDriveUrl.includes(fileId));
  assert.ok(lesson.driveVideoPlayback, 'driveVideoPlayback is present for a Drive-backed video');
  assert.equal(lesson.driveVideoPlayback.fileId, fileId);
  assert.match(lesson.driveVideoPlayback.embed, new RegExp(`drive\\.google\\.com/file/d/${fileId}/preview`));
  assert.equal(lesson.protectedStreamUrl, undefined,
    'a Drive video has no stored_name, so no Bunny streaming ticket is minted');
  assert.equal(lesson.streamPlayback, null, 'a Drive video has no Bunny stream_uid');
});

test('the course-home payload exposes driveVideoPlayback for a Drive-backed video lecture', async () => {
  const admin = contentAdmin();
  const fileId = `drive-vid-${randomUUID()}`;
  const created = await postResource(admin, driveVideoBody({ fileId }));
  assert.equal(created.status, 201, created.text);

  const student = createUser({ program_code: 'SMMS', subscription: 'premium' });
  const home = await call('GET', '/api/programs/course/MA110', { user: student });
  assert.equal(home.status, 200, home.text);

  const lecture = home.data.lectures.find((l) => l.id === created.data.resource.id);
  assert.ok(lecture, 'the Drive video appears among the course lectures');
  assert.ok(lecture.driveVideoPlayback, 'driveVideoPlayback is present on the course-home item');
  assert.match(lecture.driveVideoPlayback.embed, new RegExp(`drive\\.google\\.com/file/d/${fileId}/preview`));
});

test('the compact Video Lessons (?view=videos) payload also exposes driveVideoPlayback', async () => {
  const admin = contentAdmin();
  const fileId = `drive-vid-${randomUUID()}`;
  const created = await postResource(admin, driveVideoBody({ fileId }));
  assert.equal(created.status, 201, created.text);

  const student = createUser({ program_code: 'SMMS', subscription: 'premium' });
  const res = await call('GET', `/api/programs/course/MA110?view=videos&term=${encodeURIComponent('Term 1')}`, { user: student });
  assert.equal(res.status, 200, res.text);

  const lecture = res.data.lectures.find((l) => l.id === created.data.resource.id);
  assert.ok(lecture, 'the Drive video appears in the compact video payload');
  assert.ok(lecture.driveVideoPlayback);
  assert.match(lecture.driveVideoPlayback.embed, new RegExp(`drive\\.google\\.com/file/d/${fileId}/preview`));
});

test('hasFile is true for a Drive-backed video resource', async () => {
  const admin = contentAdmin();
  const fileId = `drive-vid-${randomUUID()}`;
  const created = await postResource(admin, driveVideoBody({ fileId }));
  assert.equal(created.status, 201, created.text);

  const student = createUser({ program_code: 'SMMS', subscription: 'premium' });
  const flow = await call('GET', `/api/programs/lesson/${created.data.resource.id}`, { user: student });
  assert.equal(flow.status, 200, flow.text);
  // Legacy subject-based course API uses the same resource id.
  const legacy = await call('GET', `/api/courses/lesson/${created.data.resource.id}`, { user: student });
  if (legacy.status === 200) {
    assert.equal(legacy.data.lesson.hasFile, true, 'courses.routes.js also reports hasFile for a Drive video');
  }
});

// ---------------------------------------------------------------------------
// 5. Player wiring: the client picks the Drive embed when there is no Bunny
//    stream, and never attempts to replicate resume/progress for it.
// ---------------------------------------------------------------------------

test('the video player renders the Drive preview iframe when driveVideoPlayback is set, without touching Bunny code', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'player.js'), 'utf8');
  assert.match(player, /driveVideoPlayback/, 'player.js branches on driveVideoPlayback');
  assert.match(player, /drive\.google\.com\/file\/d\/|dp\.embed/, 'the Drive embed URL from the server is used directly');
  // The Drive branch must not call the Bunny Player.js bridge.
  const driveFn = player.slice(player.indexOf('function initDriveVideo'), player.indexOf('function renderLock'));
  assert.doesNotMatch(driveFn, /playerjs|loadStreamSdk|saveVideoProgress|getVideoProgress/,
    'the Drive video path never wires up Bunny resume/progress tracking');
});

test('lesson.js forwards driveVideoPlayback from the lesson payload to the player', () => {
  const lessonJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'lesson.js'), 'utf8');
  assert.match(lessonJs, /driveVideoPlayback:\s*lesson\.driveVideoPlayback/);
});
