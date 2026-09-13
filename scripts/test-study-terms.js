'use strict';

// Study Materials by term — /pages/study.html and its `?view=study` API.
//
// Terms on the course home used to be inline shelves: every note and every
// tutorial sheet for all three terms stacked into one "Resources" grid, with
// the two types merged together. Now a term is a CARD you click, which opens
// a page for that one term where notes and tutorial sheets sit in SEPARATE
// slots. These tests pin that contract:
//
//   * the payload is scoped to one course + one term,
//   * notes and tutorials come back as two distinct lists (never merged),
//   * the heavy course-home sections are absent,
//   * access rules are identical to the full course home — narrower, never
//     wider,
//   * and the front-end wiring (card → /pages/study.html, two slots on the
//     page) is actually in place.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { db, call, createUser, createResource } = require('./helpers/test-app');
const { resolveCourse } = require('../lib/program-access');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MA110 = resolveCourse('MA110');

// ---------------------------------------------------------------------------
// API: one course, one term, two separate lists
// ---------------------------------------------------------------------------

test('the study view returns one term, with notes and tutorials kept apart', async () => {
  const student = createUser({ program_code: 'SMMS' });
  createResource({ category: 'document', course_id: MA110.id, semester: 'Term 1', title: 'T1 notes' });
  createResource({ category: 'tutorial', course_id: MA110.id, semester: 'Term 1', title: 'T1 sheet' });
  createResource({ category: 'document', course_id: MA110.id, semester: 'Term 2', title: 'T2 notes' });

  const res = await call('GET', `/api/programs/course/MA110?view=study&term=${encodeURIComponent('Term 1')}`, { user: student });
  assert.equal(res.status, 200, res.text);

  // Two slots, not one merged grid.
  assert.deepEqual(res.data.notes.map((n) => n.title), ['T1 notes']);
  assert.deepEqual(res.data.tutorials.map((t) => t.title), ['T1 sheet']);
  assert.equal(res.data.term, 'Term 1');

  // Another term's content is not shipped.
  assert.doesNotMatch(JSON.stringify(res.data), /T2 notes/);
});

test('the study view never leaks videos, past papers, lab reports or announcements', async () => {
  const student = createUser({ program_code: 'SMMS' });
  createResource({ category: 'document', course_id: MA110.id, semester: 'Term 1', title: 'Real notes' });
  createResource({ category: 'video', course_id: MA110.id, semester: 'Term 1', title: 'A lecture video' });
  createResource({ category: 'past_paper', course_id: MA110.id, title: '2024 paper' });
  createResource({ category: 'announcement', course_id: MA110.id, title: 'Class moved' });

  const res = await call('GET', `/api/programs/course/MA110?view=study&term=${encodeURIComponent('Term 1')}`, { user: student });
  assert.equal(res.status, 200, res.text);

  const serialized = JSON.stringify(res.data);
  assert.match(serialized, /Real notes/);
  for (const unwanted of ['A lecture video', '2024 paper', 'Class moved']) {
    assert.doesNotMatch(serialized, new RegExp(unwanted), `${unwanted} must not be in the study payload`);
  }
  for (const item of [...res.data.notes, ...res.data.tutorials]) {
    assert.ok(['document', 'tutorial'].includes(item.category), `${item.title} is study material`);
  }
});

test('the study view drops the expensive course-home sections', async () => {
  const student = createUser({ program_code: 'SMMS' });
  createResource({ category: 'document', course_id: MA110.id, semester: 'Term 1', title: 'Notes' });

  const res = await call('GET', `/api/programs/course/MA110?view=study&term=${encodeURIComponent('Term 1')}`, { user: student });
  assert.equal(res.status, 200, res.text);

  for (const key of ['topics', 'lessons', 'lectures', 'pastPapers', 'announcements', 'progress', 'streak', 'terms']) {
    assert.equal(res.data[key], undefined, `${key} must not be in the compact study payload`);
  }
  // …while everything the page renders is present.
  assert.ok(res.data.course, 'course chrome is present');
  assert.ok(res.data.access, 'access flags are present');
  assert.ok(Array.isArray(res.data.termCounts), 'term switcher counts are present');
});

test('term counts cover all three terms so the switcher can show what is waiting', async () => {
  // A course of its own, so the counts are not disturbed by the MA110 rows
  // the other tests in this file create.
  const CS110 = resolveCourse('CS110');
  const student = createUser({ program_code: 'SMMS' });
  createResource({ category: 'document', course_id: CS110.id, semester: 'Term 1', title: 'N1' });
  createResource({ category: 'document', course_id: CS110.id, semester: 'Term 1', title: 'N2' });
  createResource({ category: 'tutorial', course_id: CS110.id, semester: 'Term 1', title: 'S1' });
  createResource({ category: 'tutorial', course_id: CS110.id, semester: 'Term 3', title: 'S2' });

  const res = await call('GET', `/api/programs/course/CS110?view=study&term=${encodeURIComponent('Term 2')}`, { user: student });
  assert.equal(res.status, 200, res.text);

  const counts = Object.fromEntries(res.data.termCounts.map((c) => [c.term, c]));
  assert.deepEqual(res.data.termCounts.map((c) => c.term), ['Term 1', 'Term 2', 'Term 3'], 'terms stay in order');
  assert.deepEqual(
    { notes: counts['Term 1'].notes, tutorials: counts['Term 1'].tutorials, total: counts['Term 1'].total },
    { notes: 2, tutorials: 1, total: 3 }
  );
  // An empty term is still reported, so the card can say "nothing yet".
  assert.deepEqual(
    { notes: counts['Term 2'].notes, tutorials: counts['Term 2'].tutorials, total: counts['Term 2'].total },
    { notes: 0, tutorials: 0, total: 0 }
  );
  assert.equal(counts['Term 3'].tutorials, 1);
});

test('the study view enforces the same program access as the course home', async () => {
  const outsider = createUser({ program_code: 'LAW' });
  const ED = resolveCourse('ED');
  const res = await call('GET', `/api/programs/course/${ED.code}?view=study&term=${encodeURIComponent('Term 1')}`, { user: outsider });
  assert.equal(res.status, 403, 'a course outside the student program is refused, view or no view');
});

test('the legacy subject route serves the same two-slot study view', async () => {
  const student = createUser({ program_code: 'LAW' });
  createResource({ category: 'document', subject: 'Physics', semester: 'Term 2', title: 'Physics notes' });
  createResource({ category: 'tutorial', subject: 'Physics', semester: 'Term 2', title: 'Physics sheet' });
  createResource({ category: 'document', subject: 'Physics', semester: 'Term 1', title: 'Earlier notes' });

  const res = await call('GET', `/api/courses/physics?view=study&term=${encodeURIComponent('Term 2')}`, { user: student });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.data.notes.map((n) => n.title), ['Physics notes']);
  assert.deepEqual(res.data.tutorials.map((t) => t.title), ['Physics sheet']);
  assert.doesNotMatch(JSON.stringify(res.data), /Earlier notes/);
  assert.equal(res.data.topics, undefined, 'no topic tree in the compact view');
  assert.ok(Array.isArray(res.data.termCounts));
});

test('the study view is far smaller than the full course home', async () => {
  const student = createUser({ program_code: 'SMMS' });
  for (let i = 0; i < 25; i += 1) {
    createResource({ category: 'document', course_id: MA110.id, semester: 'Term 1', title: `Notes ${i}`, topic: `Topic ${i}` });
    createResource({ category: 'past_paper', course_id: MA110.id, title: `Paper ${i}`, topic: `Topic ${i}` });
  }

  const full = await call('GET', '/api/programs/course/MA110', { user: student });
  const compact = await call('GET', `/api/programs/course/MA110?view=study&term=${encodeURIComponent('Term 2')}`, { user: student });
  assert.equal(full.status, 200, full.text);
  assert.equal(compact.status, 200, compact.text);
  assert.ok(
    compact.text.length * 4 < full.text.length,
    `expected the study view to be far smaller (compact ${compact.text.length}B vs full ${full.text.length}B)`
  );
});

// ---------------------------------------------------------------------------
// Front-end wiring
// ---------------------------------------------------------------------------

test('course term cards link into the per-term study page', () => {
  const mainJs = read('public/js/main.js');
  const courseJs = read('public/js/course.js');
  const programJs = read('public/js/program-course.js');

  assert.match(mainJs, /function studyTermCardsHtml\(/, 'the shared term card renderer exists');
  for (const [name, js] of [['course.js', courseJs], ['program-course.js', programJs]]) {
    assert.match(js, /\/pages\/study\.html\?course=/, `${name}: term cards point at the study page`);
    assert.match(js, /studyTermCardsHtml\(/, `${name}: the Resources section renders term cards`);
  }

  // The old merged inline shelf is gone from both course pages and from the
  // shared helpers — notes and tutorials must never be zipped together again.
  assert.doesNotMatch(mainJs, /mergeTermShelves/, 'the merge helper is removed');
  for (const [name, js] of [['course.js', courseJs], ['program-course.js', programJs]]) {
    assert.doesNotMatch(js, /mergeTermShelves|termShelvesHtml/, `${name}: no inline term shelves left`);
  }
});

test('the study page gives notes and tutorial sheets their own slots', () => {
  const html = read('public/pages/study.html');
  const js = read('public/js/study.js');

  // Two sections, two grids — not one shared grid.
  assert.match(html, /id="notes"/, 'there is a notes section');
  assert.match(html, /id="tutorial-sheets"/, 'there is a separate tutorial sheets section');
  assert.match(html, /id="notesGrid"/);
  assert.match(html, /id="tutorialGrid"/);
  assert.match(html, /id="termSubnavLinks"/, 'the term switcher is present');
  assert.match(html, /src="\/js\/study\.js"/);

  // The page renders each list independently from its own API field.
  assert.match(js, /data\.notes/);
  assert.match(js, /data\.tutorials/);
  assert.match(js, /#notesGrid/);
  assert.match(js, /#tutorialGrid/);
  assert.match(js, /courseStudyMaterials|programCourseStudyMaterials/);
});

test('the subject and program course pages render a term card grid, not stacked shelves', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'public', 'pages', 'subjects'))
    .filter((name) => name.endsWith('.html'))
    .map((name) => `public/pages/subjects/${name}`)
    .concat('views/course.html');

  for (const rel of pages) {
    const html = read(rel);
    assert.match(html, /<div class="video-term-grid" id="resourceGrid">/, `${rel}: Resources is a term card grid`);
    assert.doesNotMatch(html, /<div class="term-shelves" id="resourceGrid">/, `${rel}: the stacked shelf container is gone`);
  }
});

test('the study page is reachable and protected like the rest of the library', async () => {
  const res = await call('GET', '/pages/study.html');
  assert.equal(res.status, 200, 'the page is served');
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  assert.match(read('public/pages/study.html'), /privacy-guard\.js/, 'the privacy guard is loaded');
  assert.match(read('public/js/privacy-guard.js'), /study:/, 'the page has a privacy policy entry');
});

test('unauthenticated requests cannot read study materials through the API', async () => {
  const res = await call('GET', `/api/programs/course/MA110?view=study&term=${encodeURIComponent('Term 1')}`);
  assert.equal(res.status, 401, 'the compact view is behind auth like every other course read');
  db.prepare('SELECT 1').get();
});
