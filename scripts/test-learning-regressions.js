'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { db, call, createUser, createResource, cookieFor } = require('./helpers/test-app');
const { programCanSeeResource, resourceVisibilityClause, resolveCourse } = require('../lib/program-access');

const questions = [
  { id: 'mcq', type: 'mcq', prompt: 'Two plus two?', options: ['3', '4'], correct: [1], points: 2, explanation: 'Add two pairs.' },
  { id: 'text', type: 'text', prompt: 'Name the gas O2.', answers: ['oxygen'], points: 3, explanation: 'O2 is molecular oxygen.' }
];

async function createQuiz(overrides = {}) {
  const result = await call('POST', '/api/quiz', {
    user: createUser({ role: 'admin' }),
    body: { title: `Quiz ${randomUUID()}`, targetAll: true, passingPercent: 50, questions, ...overrides }
  });
  assert.equal(result.status, 201, result.text);
  return result.data.quiz;
}

function visibleInSql(user, row) {
  const visibility = resourceVisibilityClause(user, 'r');
  return Boolean(db.prepare(`SELECT 1 FROM resources r WHERE r.id = @id ${visibility.clause ? `AND ${visibility.clause}` : ''}`)
    .get({ id: row.id, ...visibility.params }));
}

test('direct and SQL visibility enforce both targeting and course membership', () => {
  const law = createUser();
  const mines = createUser({ program_code: 'SMMS' });
  const nonQuota = createUser({ program_code: 'SMNS' });
  const unassigned = createUser({ program_code: null });
  const publisher = createUser({ role: 'content_admin' });
  const admin = createUser({ role: 'admin' });
  const lawCourse = resolveCourse('LS110').id;
  const sharedCourse = resolveCourse('MA110').id;
  const cases = [
    [createResource(), [law, mines, nonQuota, unassigned, admin]],
    [createResource({ course_id: lawCourse }), [law, admin]],
    [createResource({ course_id: sharedCourse }), [mines, nonQuota, admin]],
    [createResource({ target_all: 0 }, ['LAW']), [law, admin]],
    [createResource({ target_all: 0, course_id: sharedCourse }, ['LAW']), [admin]],
    [createResource({ target_all: 0, course_id: sharedCourse }, ['SMMS']), [mines, admin]]
  ];
  for (const [row, allowedUsers] of cases) {
    for (const user of [law, mines, nonQuota, unassigned, publisher, admin, null]) {
      const expected = allowedUsers.includes(user);
      const context = `${user?.role || 'anonymous'} / ${user?.program_code || 'unassigned'} / ${row.id}`;
      assert.equal(programCanSeeResource(user, row), expected, `direct: ${context}`);
      assert.equal(visibleInSql(user, row), expected, `SQL: ${context}`);
    }
  }
  assert.equal(programCanSeeResource(admin, null), false, 'a missing resource is not accessible');
});

test('course-bound all-program resources cannot be opened by an unrelated or unassigned student', async () => {
  const row = createResource({ course_id: resolveCourse('LS110').id });
  for (const user of [createUser({ program_code: 'SMMS' }), createUser({ program_code: null })]) {
    const listed = await call('GET', `/api/resources?search=${row.id}`, { user });
    assert.equal(listed.status, 200);
    assert.equal(listed.data.resources.length, 0);
    for (const [method, suffix] of [['GET', ''], ['GET', '/stream'], ['HEAD', '/stream'], ['POST', '/bookmark'], ['POST', '/complete']]) {
      const result = await call(method, `/api/resources/${row.id}${suffix}`, { user });
      assert.equal(result.status, 403, `${method} ${suffix}: ${result.text}`);
    }
    assert.equal((await call('GET', `/api/programs/lesson/${row.id}`, { user })).status, 403);
  }
  assert.equal((await call('GET', `/api/resources/${row.id}`, { user: createUser() })).status, 200);
});

test('legacy course homes and lesson navigation do not expose other programs resources', async () => {
  const user = createUser();
  const visible = createResource({ target_all: 0 }, ['LAW']);
  const hidden = createResource({ target_all: 0 }, ['SMMS']);
  const hiddenCourse = createResource({ course_id: resolveCourse('MA110').id });
  const home = await call('GET', '/api/courses/mathematics', { user });
  assert.equal(home.status, 200, home.text);
  assert.ok(home.data.lessons.some((r) => r.id === visible.id));
  for (const row of [hidden, hiddenCourse]) {
    assert.ok(!home.text.includes(row.id), 'restricted resources must not appear in any course section');
    assert.equal((await call('GET', `/api/courses/lesson/${row.id}`, { user })).status, 403);
  }
  const flow = await call('GET', `/api/courses/lesson/${visible.id}`, { user });
  assert.equal(flow.status, 200, flow.text);
  assert.ok(!flow.text.includes(hidden.id));
  assert.ok(!flow.text.includes(hiddenCourse.id));
});

test('dashboard lesson counts and progress use the same visible published learning set as the course home', async () => {
  const courseId = `course-${randomUUID()}`;
  db.prepare('INSERT INTO courses (id, code, slug, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(courseId, courseId, courseId, 'Regression course', new Date().toISOString());
  db.prepare('INSERT INTO program_courses (program_code, course_id) VALUES (?, ?)').run('LAW', courseId);
  const user = createUser();
  const lessons = ['video', 'document', 'tutorial', 'past_paper'].map((category) => createResource({ course_id: courseId, category }));
  const excluded = [
    createResource({ course_id: courseId, category: 'announcement' }),
    createResource({ course_id: courseId, category: 'quiz' }),
    createResource({ course_id: courseId, publish_status: 'draft' }),
    createResource({ course_id: courseId, target_all: 0 }, ['SMMS'])
  ];
  // Old progress can survive an admin unpublishing/re-targeting a resource;
  // it must no longer inflate the current course's completion percentage.
  for (const row of [lessons[0], lessons[1], ...excluded]) {
    db.prepare('INSERT INTO lesson_progress (id, user_id, resource_id, completed_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), user.id, row.id, new Date().toISOString());
  }
  const result = await call('GET', '/api/programs/mine', { user });
  assert.equal(result.status, 200, result.text);
  const course = result.data.courses.find((c) => c.id === courseId);
  assert.deepEqual(course.counts, { lessons: 4, videos: 1, documents: 1, tutorials: 1, pastPapers: 1 });
  assert.deepEqual(course.progress, { completed: 2, total: 4, percent: 50 });
  const home = await call('GET', `/api/programs/course/${courseId}`, { user });
  assert.equal(home.data.progress.totalCount, course.progress.total);
  assert.equal(home.data.progress.completedCount, course.progress.completed);
  assert.equal(home.data.progress.percent, course.progress.percent);
});

test('program-targeted quizzes use the current database program, not missing or stale JWT fields', async () => {
  const quiz = await createQuiz({ targetAll: false, programs: ['LAW'], courseId: resolveCourse('LS110').id });
  const user = createUser();
  const cookie = cookieFor(user);
  const listed = await call('GET', '/api/quiz/student', { cookie });
  assert.equal(listed.status, 200, listed.text);
  assert.ok(listed.data.quizzes.some((q) => q.id === quiz.id), 'an enrolled student must see their quiz');
  const take = await call('GET', `/api/quiz/${quiz.id}`, { cookie });
  assert.equal(take.status, 200, take.text);
  const attempt = await call('POST', `/api/quiz/${quiz.id}/attempt`, { cookie, body: { answers: [] } });
  assert.equal(attempt.status, 201, attempt.text);

  db.prepare('UPDATE users SET program_code = ? WHERE id = ?').run('SMMS', user.id);
  const changed = await call('GET', '/api/quiz/student', { cookie });
  assert.ok(!changed.data.quizzes.some((q) => q.id === quiz.id));
  assert.equal((await call('GET', `/api/quiz/${quiz.id}`, { cookie })).status, 403);
  assert.equal((await call('POST', `/api/quiz/${quiz.id}/attempt`, { cookie, body: { answers: [] } })).status, 403);
});

test('quiz cards and take payloads supply the metadata rendered by the student UI', async () => {
  const quiz = await createQuiz({ targetAll: false, programs: ['LAW'] });
  // Admin can preview quizzes too and should receive the same basic metadata.
  const admin = createUser({ role: 'admin' });
  const list = await call('GET', '/api/quiz/student', { user: admin });
  const card = list.data.quizzes.find((q) => q.id === quiz.id);
  assert.equal(card.targetAll, false);
  assert.deepEqual(card.programCodes, ['LAW']);
  assert.equal(card.passingPercent, 50);
  const take = await call('GET', `/api/quiz/${quiz.id}`, { user: admin });
  assert.equal(take.data.totalPoints, 5, 'the quiz heading must not display undefined points');
  for (const question of take.data.questions) {
    for (const secret of ['correct', 'answers', 'explanation']) assert.ok(!(secret in question));
  }
});

test('generic resource list, detail and bookmarks never disclose quiz answers to students', async () => {
  const quiz = await createQuiz();
  const user = createUser();
  assert.equal((await call('POST', `/api/resources/${quiz.id}/bookmark`, { user })).status, 200);
  const responses = [
    await call('GET', `/api/resources?category=quiz&search=${encodeURIComponent(quiz.title)}`, { user }),
    await call('GET', `/api/resources/${quiz.id}`, { user }),
    await call('GET', '/api/resources/bookmarks/mine', { user })
  ];
  for (const result of responses) {
    assert.equal(result.status, 200, result.text);
    const rows = result.data.resources || [result.data.resource];
    assert.ok(rows.some((r) => r.id === quiz.id));
    for (const row of rows) assert.equal(row.quizData, null, 'correct answers belong only in authoring and graded responses');
  }
  const admin = createUser({ role: 'admin' });
  const management = await call('GET', `/api/quiz/${quiz.id}/manage`, { user: admin });
  assert.deepEqual(management.data.quiz.questions[0].correct, [1], 'authoring still has the answer key');
});

test('trial and expired students cannot use generic resource endpoints to bypass Premium quizzes', async () => {
  const quiz = await createQuiz();
  for (const user of [createUser({ subscription: 'trial' }), createUser({ subscription_end: '2000-01-01T00:00:00.000Z' })]) {
    const list = await call('GET', `/api/resources?category=quiz&search=${encodeURIComponent(quiz.title)}`, { user });
    assert.equal(list.status, 200);
    const card = list.data.resources.find((r) => r.id === quiz.id);
    assert.equal(card.quizData, null);
    assert.ok(card.locked);
    assert.equal((await call('GET', `/api/resources/${quiz.id}`, { user })).status, 403);
    assert.equal((await call('GET', `/api/quiz/${quiz.id}`, { user })).status, 403);
    assert.equal((await call('POST', `/api/quiz/${quiz.id}/attempt`, { user, body: { answers: [] } })).status, 403);
  }
});

test('the obsolete client-score endpoint cannot forge quiz results or completion', async () => {
  const quiz = await createQuiz();
  const user = createUser();
  const result = await call('POST', `/api/resources/${quiz.id}/quiz-attempt`, { user, body: { score: 100, total: 100 } });
  assert.equal(result.status, 410, result.text);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM quiz_attempts WHERE user_id = ?').get(user.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lesson_progress WHERE user_id = ?').get(user.id).n, 0);
});

test('canonical quiz grading ignores claimed scores and returns timestamped history', async () => {
  const quiz = await createQuiz();
  const user = createUser();
  const result = await call('POST', `/api/quiz/${quiz.id}/attempt`, {
    user,
    body: { score: 100, total: 100, answers: [{ questionId: 'mcq', value: [0] }, { questionId: 'text', value: 'OXYGEN' }] }
  });
  assert.equal(result.status, 201, result.text);
  assert.equal(result.data.score, 3);
  assert.equal(result.data.total, 5);
  assert.equal(result.data.percent, 60);
  const history = await call('GET', `/api/quiz/${quiz.id}/attempts/mine`, { user });
  assert.equal(history.status, 200);
  const saved = db.prepare('SELECT created_at FROM quiz_attempts WHERE user_id = ? AND resource_id = ?').get(user.id, quiz.id);
  assert.equal(history.data.attempts[0].createdAt, saved.created_at);
  const legacyHistory = await call('GET', `/api/resources/${quiz.id}/quiz-attempts/mine`, { user });
  assert.equal(legacyHistory.data.attempts.length, 1, 'historical read compatibility remains available');
});

test('a valid zero-percent quiz pass mark is not silently changed to fifty', async () => {
  const quiz = await createQuiz({ passingPercent: 0 });
  assert.equal(quiz.passingPercent, 0);
  const user = createUser();
  const take = await call('GET', `/api/quiz/${quiz.id}`, { user });
  assert.equal(take.data.passingPercent, 0);
  const result = await call('POST', `/api/quiz/${quiz.id}/attempt`, { user, body: { answers: [] } });
  assert.equal(result.status, 201, result.text);
  assert.equal(result.data.score, 0);
  assert.equal(result.data.passingPercent, 0);
  assert.equal(result.data.passed, true);
});
