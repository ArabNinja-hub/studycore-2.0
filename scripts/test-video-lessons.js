'use strict';

// Regression tests for the two Video Lessons problems reported in production:
//
//   1. "The video lessons are loading too much."
//      /pages/videos.html renders ONE course and ONE term, but it used to ask
//      for the entire course home (every topic, note, tutorial, past paper,
//      announcement, the recommendation set and the study streak) and throw
//      almost all of it away. These tests pin the compact `?view=videos`
//      payload: it must contain the term's videos, must NOT contain the heavy
//      sections, and must enforce exactly the same access rules as the full
//      course home — narrower, never wider.
//
//   2. "When uploading videos there is a bit of failure."
//      A valid MP4/MOV whose first atom is not `ftyp` (phone recordings,
//      screen recorders and non-faststart exports lead with moov/mdat/wide)
//      was deleted after upload with "does not match its file type". These
//      tests pin the container check that accepts any real top-level atom
//      while still rejecting a disguised file.

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { db, call, createUser, createResource } = require('./helpers/test-app');
const { resolveCourse } = require('../lib/program-access');

const MA110 = resolveCourse('MA110');

function createVideo(overrides = {}, programs = []) {
  return createResource({
    category: 'video',
    course_id: MA110.id,
    subject: MA110.name,
    semester: 'Term 1',
    stored_name: `videos/${randomUUID()}.mp4`,
    file_name: 'lecture.mp4',
    mime_type: 'video/mp4',
    file_size: 2048,
    ...overrides
  }, programs);
}

// ---------------------------------------------------------------------------
// 1. Payload weight
// ---------------------------------------------------------------------------

test('the Video Lessons view returns one term and omits the heavy course-home sections', async () => {
  const student = createUser({ program_code: 'SMMS' });
  const wanted = createVideo({ title: 'Limits and continuity', semester: 'Term 1' });
  const otherTerm = createVideo({ title: 'Integration', semester: 'Term 2' });
  // Non-video course content exists but must never be shipped to this page.
  createResource({ category: 'document', course_id: MA110.id, title: 'Algebra notes' });
  createResource({ category: 'past_paper', course_id: MA110.id, title: '2024 paper' });
  createResource({ category: 'announcement', course_id: MA110.id, title: 'Class moved' });

  const res = await call('GET', `/api/programs/course/MA110?view=videos&term=${encodeURIComponent('Term 1')}`, { user: student });
  assert.equal(res.status, 200, res.text);

  const titles = res.data.lectures.map((l) => l.title);
  assert.ok(titles.includes(wanted.title), 'the requested term is present');
  assert.ok(!titles.includes(otherTerm.title), 'other terms are not shipped');

  const serialized = JSON.stringify(res.data);
  assert.doesNotMatch(serialized, /Algebra notes/, 'notes are not in the video payload');
  assert.doesNotMatch(serialized, /2024 paper/, 'past papers are not in the video payload');
  assert.doesNotMatch(serialized, /Class moved/, 'announcements are not in the video payload');

  // The expensive course-home sections must be absent entirely.
  for (const key of ['topics', 'lessons', 'notes', 'tutorials', 'pastPapers', 'announcements', 'recommended', 'progress', 'streak']) {
    assert.equal(res.data[key], undefined, `${key} must not be in the compact video payload`);
  }
  // …while everything the page actually renders is present.
  assert.ok(Array.isArray(res.data.videoTerms), 'term nav data is present');
  assert.ok(res.data.course, 'course chrome is present');
  assert.ok(res.data.access, 'access flags are present');
});

test('the compact video payload is dramatically smaller than the full course home', async () => {
  const student = createUser({ program_code: 'SMMS' });
  createVideo({ title: 'Vectors' });
  for (let i = 0; i < 25; i += 1) {
    createResource({ category: 'document', course_id: MA110.id, title: `Notes chapter ${i}`, topic: `Topic ${i}` });
    createResource({ category: 'past_paper', course_id: MA110.id, title: `Paper ${i}`, topic: `Topic ${i}` });
  }

  const full = await call('GET', '/api/programs/course/MA110', { user: student });
  const compact = await call('GET', `/api/programs/course/MA110?view=videos&term=${encodeURIComponent('Term 1')}`, { user: student });
  assert.equal(full.status, 200, full.text);
  assert.equal(compact.status, 200, compact.text);

  assert.ok(
    compact.text.length * 4 < full.text.length,
    `expected the video view to be far smaller (compact ${compact.text.length}B vs full ${full.text.length}B)`
  );
});

test('the legacy subject route serves the same compact video view', async () => {
  const student = createUser({ program_code: 'LAW' });
  createResource({
    category: 'video', subject: 'Physics', semester: 'Term 2', title: 'Newton laws',
    stored_name: 'videos/p.mp4', file_name: 'p.mp4', mime_type: 'video/mp4'
  });
  createResource({ category: 'document', subject: 'Physics', title: 'Physics notes' });

  const res = await call('GET', `/api/courses/physics?view=videos&term=${encodeURIComponent('Term 2')}`, { user: student });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.data.lectures.map((l) => l.title), ['Newton laws']);
  assert.doesNotMatch(JSON.stringify(res.data), /Physics notes/);
  assert.equal(res.data.topics, undefined, 'no topic tree in the compact view');
});

// ---------------------------------------------------------------------------
// 2. Access control must be identical to the full course home
// ---------------------------------------------------------------------------

test('the video view never widens access: another program still gets 403', async () => {
  const outsider = createUser({ program_code: 'LAW' }); // LAW does not include MA110
  createVideo({ title: 'Mines only lecture' });
  const res = await call('GET', '/api/programs/course/MA110?view=videos', { user: outsider });
  assert.equal(res.status, 403, 'program membership is still enforced on the compact view');
});

test('the video view applies the same program targeting filter as the course home', async () => {
  const mines = createUser({ program_code: 'SMMS' });
  const nonQuota = createUser({ program_code: 'SMNS' });
  // Targeted at Mines only, on a course both programs share.
  createVideo({ title: 'Targeted at Mines', target_all: 0 }, ['SMMS']);

  const forMines = await call('GET', '/api/programs/course/MA110?view=videos', { user: mines });
  const forNonQuota = await call('GET', '/api/programs/course/MA110?view=videos', { user: nonQuota });
  assert.ok(forMines.data.lectures.some((l) => l.title === 'Targeted at Mines'));
  assert.ok(!forNonQuota.data.lectures.some((l) => l.title === 'Targeted at Mines'),
    'a non-targeted program must not receive the video through the compact view');
});

test('a non-premium student gets the video lock flag, never a playable payload', async () => {
  const expired = createUser({
    program_code: 'SMMS',
    subscription: 'trial',
    subscription_end: new Date(Date.now() - 86400000).toISOString(),
    trial_end: new Date(Date.now() + 86400000).toISOString()
  });
  createVideo({ title: 'Premium lecture' });

  const res = await call('GET', '/api/programs/course/MA110?view=videos', { user: expired });
  assert.equal(res.status, 200, res.text);
  const lesson = res.data.lectures.find((l) => l.title === 'Premium lecture');
  assert.ok(lesson, 'the lesson is still listed');
  assert.equal(lesson.locked, 'video', 'videos stay Premium-only in the compact view');
  assert.equal(res.data.access.premium, false);
});

test('an unknown or missing term does not leak other terms', async () => {
  const student = createUser({ program_code: 'SMMS' });
  createVideo({ title: 'T1 lecture', semester: 'Term 1' });
  createVideo({ title: 'T3 lecture', semester: 'Term 3' });

  const bogus = await call('GET', '/api/programs/course/MA110?view=videos&term=Term%2099', { user: student });
  assert.equal(bogus.status, 200, bogus.text);
  // An unrecognised term falls back to "all terms" grouped correctly, rather
  // than erroring or mixing terms into one bucket.
  const t1 = bogus.data.videoTerms.find((g) => g.term === 'Term 1').lessons.map((l) => l.title);
  const t3 = bogus.data.videoTerms.find((g) => g.term === 'Term 3').lessons.map((l) => l.title);
  assert.ok(t1.includes('T1 lecture') && !t1.includes('T3 lecture'));
  assert.ok(t3.includes('T3 lecture') && !t3.includes('T1 lecture'));
});

test('resume position and completion state survive the compact view', async () => {
  const student = createUser({ program_code: 'SMMS' });
  const video = createVideo({ title: 'Resumable lecture' });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO video_progress (user_id, resource_id, position, duration, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(student.id, video.id, 125.5, 600, now);

  const res = await call('GET', '/api/programs/course/MA110?view=videos', { user: student });
  const lesson = res.data.lectures.find((l) => l.id === video.id);
  assert.equal(Math.round(lesson.videoPosition), 126, 'resume position is preserved');
  assert.equal(lesson.videoDuration, 600);
  assert.equal(res.data.continueLearning.id, video.id, 'continue-watching still works');
});

test('playback progress reporting accepts sub-second precision differences at video end', async () => {
  const student = createUser({ program_code: 'SMMS' });
  const video = createVideo({ title: 'Ending lecture' });

  // Browser currentTime at video end can be e.g. 600.005 while duration is 600
  const res = await call('POST', `/api/resources/${video.id}/video-progress`, {
    user: student,
    body: { position: 600.005, duration: 600 }
  });
  assert.equal(res.status, 200, res.text);

  const prog = db.prepare('SELECT position, duration FROM video_progress WHERE user_id = ? AND resource_id = ?')
    .get(student.id, video.id);
  assert.equal(prog.position, 600, 'position is clamped to duration');

  const completed = db.prepare('SELECT * FROM lesson_progress WHERE user_id = ? AND resource_id = ?')
    .get(student.id, video.id);
  assert.ok(completed, 'reaching the end auto-completes the lesson');
});

// ---------------------------------------------------------------------------
// 3. Upload: video container signature detection
// ---------------------------------------------------------------------------

const uploadPath = path.join(__dirname, '..', 'middleware', 'upload.js');

function headerFor(box) {
  // 4-byte big-endian box size followed by the FourCC, as in a real file.
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(0x20, 0);
  buf.write(box, 4, 'latin1');
  return buf;
}

test('real-world MP4/MOV first atoms are accepted, not deleted as type mismatches', () => {
  // matchesSignature is module-private, so exercise it through a fresh load
  // of the module's own logic via require cache introspection.
  delete require.cache[require.resolve(uploadPath)];
  const mod = require(uploadPath);
  assert.ok(typeof mod.matchesSignature === 'function',
    'upload.js should export matchesSignature so this behaviour is testable');

  // Every one of these is a legitimate first atom for an .mp4/.mov file.
  for (const box of ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot']) {
    for (const ext of ['.mp4', '.mov', '.m4v']) {
      assert.equal(mod.matchesSignature(headerFor(box), ext), true,
        `${ext} starting with "${box}" must be accepted`);
    }
  }
});

test('a disguised non-video is still rejected', () => {
  delete require.cache[require.resolve(uploadPath)];
  const mod = require(uploadPath);
  const html = Buffer.from('<!DOCTYPE html><script>alert(1)</script>', 'utf8');
  assert.equal(mod.matchesSignature(html, '.mp4'), false, 'HTML renamed to .mp4 is refused');
  const pdf = Buffer.from('%PDF-1.7\n%aaaaaaaa', 'utf8');
  assert.equal(mod.matchesSignature(pdf, '.mp4'), false, 'a PDF renamed to .mp4 is refused');
  // …and the formats that were already correct stay correct.
  assert.equal(mod.matchesSignature(pdf, '.pdf'), true);
  assert.equal(mod.matchesSignature(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]), '.webm'), true);
});

// ---------------------------------------------------------------------------
// 4. Upload: the Cloudflare Stream offload must not block the response
// ---------------------------------------------------------------------------

test('Stream offload is queued in the background, never awaited inside a request', () => {
  const fs = require('node:fs');
  const ingest = require('../lib/stream-ingest');
  assert.equal(typeof ingest.queueOffload, 'function', 'a background queue is exposed');

  for (const route of ['admin', 'content-admin']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', `${route}.routes.js`), 'utf8');
    assert.doesNotMatch(src, /await\s+offloadResourceToStream/,
      `${route}.routes.js must not block the upload response on Cloudflare Stream`);
    assert.match(src, /queueOffload\(/, `${route}.routes.js schedules the offload instead`);
  }

  // Unconfigured Stream (as in tests) simply declines to queue anything.
  assert.equal(ingest.queueOffload('res-does-not-exist'), false);
  assert.equal(ingest.pendingOffloads(), 0);
});
