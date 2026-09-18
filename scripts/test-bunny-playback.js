'use strict';

// Regression tests for: "clicking a Bunny video fails with HTTP 400 —
// {"errors":{"preload":["The value 'metadata' is not valid."]}}".
//
// After the R2 → Bunny migration the rows look like:
//   storage_provider = 'bunny', stream_uid set, stream_status = 'ready',
//   stored_name = NULL
//
// The lesson payload correctly pointed those rows at Bunny's iframe player,
// but the embed URL carried `preload=metadata`. That value is legal only on an
// HTML <video preload> attribute; Bunny's embed endpoint validates `preload`
// as a boolean and rejected the entire request with an ASP.NET model
// validation 400, so the player frame never loaded a video.
//
// These tests pin the whole Bunny path end to end:
//   · the lesson payload carries a Bunny iframe URL Bunny will actually accept
//   · no Bunny-backed lesson is handed the legacy /stream byte fallback
//   · /stream refuses to deliver bytes for a Bunny row at all
//   · Google Drive documents and progressive videos are untouched
//
// Bunny must be configured BEFORE the app (and therefore lib/stream) is
// required — it reads its configuration once at module load.
Object.assign(process.env, {
  BUNNY_LIBRARY_ID: '12345',
  BUNNY_API_KEY: 'server-secret-test-key',
  BUNNY_CDN_HOSTNAME: 'video.example.b-cdn.net'
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { call, createUser, createResource } = require('./helpers/test-app');
const { resolveCourse } = require('../lib/program-access');
const stream = require('../lib/stream');

const MA110 = resolveCourse('MA110');

// A migrated lesson: lives entirely in Bunny, no R2/local object behind it.
function createBunnyVideo(overrides = {}) {
  return createResource({
    category: 'video',
    course_id: MA110.id,
    subject: MA110.name,
    semester: 'Term 1',
    title: 'Migrated Bunny lecture',
    file_name: 'lecture.mp4',
    mime_type: 'video/mp4',
    storage_provider: 'bunny',
    stream_uid: `bunny-${randomUUID()}`,
    stream_status: 'ready',
    stored_name: null,
    ...overrides
  });
}

function student() {
  return createUser({ program_code: 'SMMS' });
}

test('Bunny Stream is configured for this suite', () => {
  assert.equal(stream.isConfigured(), true, 'the Bunny path cannot be tested while Stream is unconfigured');
});

test('a migrated Bunny lesson plays through the Bunny iframe, not /stream', async () => {
  const video = createBunnyVideo();
  const flow = await call('GET', `/api/courses/lesson/${video.id}`, { user: student() });
  assert.equal(flow.status, 200, flow.text);

  const sp = flow.data.lesson.streamPlayback;
  assert.ok(sp, 'a Bunny-backed lesson must carry playback fields');
  assert.equal(sp.ready, true);
  assert.equal(sp.uid, video.stream_uid);

  const iframe = new URL(sp.iframe);
  assert.equal(iframe.hostname, 'iframe.mediadelivery.net', 'playback goes straight to Bunny');
  assert.equal(iframe.pathname, `/embed/12345/${video.stream_uid}`);

  // The exact bug: Bunny 400s the embed when preload is not a boolean.
  const preload = iframe.searchParams.get('preload');
  assert.notEqual(preload, 'metadata',
    "preload=metadata is what Bunny rejected with \"The value 'metadata' is not valid.\"");
  assert.ok(['true', 'false'].includes(preload), `preload must be a Bunny boolean, got ${preload}`);
});

test('a Bunny lesson is never given the legacy /stream byte-delivery URL', async () => {
  const video = createBunnyVideo();
  const flow = await call('GET', `/api/courses/lesson/${video.id}`, { user: student() });
  assert.equal(flow.status, 200, flow.text);
  assert.equal(flow.data.lesson.protectedStreamUrl, undefined,
    'a Bunny video must not fall back to /api/resources/:id/stream for its bytes');
  assert.doesNotMatch(JSON.stringify(flow.data.lesson.streamPlayback), /\/api\/resources\//,
    'nothing in the Bunny playback payload points back at the StudyCore stream endpoint');
});

test('the program lesson flow follows the same Bunny rules', async () => {
  const course = resolveCourse('LS110');
  const video = createBunnyVideo({ course_id: course.id, subject: course.name });
  const flow = await call('GET', `/api/programs/lesson/${video.id}`, { user: createUser({ program_code: 'LAW' }) });
  assert.equal(flow.status, 200, flow.text);

  const sp = flow.data.lesson.streamPlayback;
  assert.ok(sp && sp.iframe, 'program lessons also mount the Bunny player');
  assert.equal(new URL(sp.iframe).searchParams.get('preload'), 'true');
  assert.equal(flow.data.lesson.protectedStreamUrl, undefined,
    'a Bunny video must not fall back to /api/resources/:id/stream for its bytes');
});

test('/stream refuses to serve bytes for a Bunny row instead of proxying it', async () => {
  const video = createBunnyVideo();
  const res = await call('GET', `/api/resources/${video.id}/stream`, { user: student() });
  // Bunny-backed bytes are never proxied through StudyCore; the row has no
  // stored object at all now that the migration nulled stored_name.
  assert.ok(res.status >= 400, 'the legacy endpoint must not deliver Bunny bytes');
  assert.notEqual(res.status, 200);
});

test('the access model is unchanged: a lapsed student gets the lock, not a Bunny URL', async () => {
  const video = createBunnyVideo();
  const expired = createUser({
    program_code: 'SMMS',
    subscription: 'free',
    subscription_end: new Date(Date.now() - 86400000).toISOString(),
    trial_end: new Date(Date.now() - 86400000).toISOString()
  });
  const flow = await call('GET', `/api/courses/lesson/${video.id}`, { user: expired });
  assert.equal(flow.status, 200, flow.text);
  assert.equal(flow.data.lesson.locked, 'video', 'premium gating still applies to Bunny lessons');
  assert.equal(flow.data.lesson.protectedStreamUrl, undefined);
});

test('a student from another program still cannot reach a Bunny lesson', async () => {
  const course = resolveCourse('LS110');
  const video = createBunnyVideo({ course_id: course.id, subject: course.name });
  const outsider = createUser({ program_code: 'SMMS' });
  const res = await call('GET', `/api/programs/lesson/${video.id}`, { user: outsider });
  assert.ok(res.status === 403 || res.status === 404, `program isolation held (got ${res.status})`);

  const bytes = await call('GET', `/api/resources/${video.id}/stream`, { user: outsider });
  assert.equal(bytes.status, 403, 'program access checks still guard the stream endpoint');
});

test('Google Drive documents are unaffected by the Bunny playback path', async () => {
  const doc = createResource({
    category: 'document',
    course_id: MA110.id,
    subject: MA110.name,
    title: 'Drive notes',
    file_name: 'notes.pdf',
    mime_type: 'application/pdf',
    storage_provider: 'google_drive',
    google_drive_file_id: 'drive-file-123',
    google_drive_url: 'https://drive.google.com/file/d/drive-file-123/view',
    stored_name: null
  });

  const detail = await call('GET', `/api/resources/${doc.id}`, { user: student() });
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.data.resource.streamPlayback, null, 'a Drive document has no Bunny playback');
  assert.equal(detail.data.resource.googleDriveFileId, 'drive-file-123');
  assert.equal(detail.data.resource.hasFile, true);

  const res = await call('GET', `/api/resources/${doc.id}/stream`, { user: student() });
  assert.equal(res.status, 302, 'Drive resources still redirect to their preview link');
  assert.match(res.headers.get('location') || '', /drive-file-123/);
});

test('progressive (non-Bunny) videos still get their /stream ticket', async () => {
  const video = createResource({
    category: 'video',
    course_id: MA110.id,
    subject: MA110.name,
    semester: 'Term 1',
    title: 'Legacy progressive lecture',
    file_name: 'legacy.mp4',
    mime_type: 'video/mp4',
    stored_name: `videos/${randomUUID()}.mp4`,
    storage_provider: 'r2'
  });
  const flow = await call('GET', `/api/courses/lesson/${video.id}`, { user: student() });
  assert.equal(flow.status, 200, flow.text);
  assert.equal(flow.data.lesson.streamPlayback, null, 'no Bunny video, no Bunny player');
  assert.match(String(flow.data.lesson.protectedStreamUrl),
    new RegExp(`^/api/resources/${video.id}/stream\\?t=`),
    'progressive videos keep the ticketed stream URL');
});

test('preload=metadata stays where it belongs: the HTML <video> element only', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const player = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'player.js'), 'utf8');
  const serverSources = ['lib/stream.js', 'routes/resources.routes.js', 'routes/courses.routes.js', 'routes/programs.routes.js']
    .map((file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

  // No source may put preload=metadata into a URL query string.
  for (const src of [player, ...serverSources]) {
    assert.doesNotMatch(src, /[?&]preload=metadata/,
      'preload=metadata must never appear in a URL query string');
    assert.doesNotMatch(src, /preload:\s*'metadata'/,
      'preload must not be set to "metadata" in URL parameters');
  }

  // …and the front-end must never send preload to the stream endpoint.
  assert.doesNotMatch(player, /\/stream[^'"`\n]*preload/,
    'the stream endpoint is never given a preload parameter');
});
