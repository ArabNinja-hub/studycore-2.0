'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, call, createUser, createResource, db } = require('./helpers/test-app');

test('Smoke Test: 1. All public static HTML pages serve 200 with HTML MIME', async () => {
  const pages = [
    '/', '/login.html', '/signup.html', '/content-admin-signup.html', '/404.html',
    '/pages/about.html', '/pages/announcements.html', '/pages/courses.html',
    '/pages/lesson.html', '/pages/pricing.html', '/pages/privacy.html',
    '/pages/resources.html', '/pages/search.html', '/pages/terms.html',
    '/pages/videos.html', '/pages/subjects/biology.html', '/pages/subjects/chemistry.html',
    '/pages/subjects/communication.html', '/pages/subjects/mathematics.html',
    '/pages/subjects/physics.html', '/pages/subjects/programming.html'
  ];

  for (const p of pages) {
    const res = await call('GET', p);
    assert.equal(res.status, 200, `Expected 200 for ${p}, got ${res.status}`);
    assert.match(res.headers.get('content-type') || '', /text\/html/, `Expected text/html for ${p}`);
  }
});

test('Smoke Test: 2. Protected views redirect or gate unauthenticated requests', async () => {
  const protectedViews = ['/admin.html', '/content-admin.html', '/dashboard.html', '/quiz.html'];
  for (const pv of protectedViews) {
    const res = await call('GET', pv);
    assert.ok([302, 401, 403].includes(res.status), `Expected 302/401/403 for unauthenticated ${pv}, got ${res.status}`);
  }
});

test('Smoke Test: 3. All public JS scripts in public/js serve 200 with javascript MIME', async () => {
  const jsFiles = fs.readdirSync(path.join(__dirname, '..', 'public', 'js')).filter(f => f.endsWith('.js'));
  for (const jf of jsFiles) {
    const res = await call('GET', `/js/${jf}`);
    assert.equal(res.status, 200, `Expected 200 for /js/${jf}, got ${res.status}`);
    assert.match(res.headers.get('content-type') || '', /javascript/, `Expected javascript MIME for /js/${jf}`);
  }
});

test('Smoke Test: 4. All public CSS stylesheets in public/css serve 200 with CSS MIME', async () => {
  const cssFiles = fs.readdirSync(path.join(__dirname, '..', 'public', 'css')).filter(f => f.endsWith('.css'));
  for (const cf of cssFiles) {
    const res = await call('GET', `/css/${cf}`);
    assert.equal(res.status, 200, `Expected 200 for /css/${cf}, got ${res.status}`);
    assert.match(res.headers.get('content-type') || '', /css/, `Expected css MIME for /css/${cf}`);
  }
});

test('Smoke Test: 5. Auth API endpoints (me, config, payment-info, profile, referral)', async () => {
  const student = createUser({ program_code: 'LAW' });

  const meRes = await call('GET', '/api/auth/me', { user: student });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.data.user.email, student.email);

  const cfgRes = await call('GET', '/api/auth/config', { user: student });
  assert.equal(cfgRes.status, 200);
  assert.ok(typeof cfgRes.data.maxUploadMB === 'number');

  const payRes = await call('GET', '/api/auth/payment-info', { user: student });
  assert.equal(payRes.status, 200);
  assert.ok(payRes.data.payTo);

  const profRes = await call('PUT', '/api/auth/profile', {
    user: student,
    body: { name: 'Updated Student Name' }
  });
  assert.equal(profRes.status, 200);
  assert.equal(resUser(profRes).name, 'Updated Student Name');

  const refRes = await call('GET', '/api/auth/referral', { user: student });
  assert.equal(refRes.status, 200);
  assert.ok(refRes.data.code);
});

function resUser(res) {
  return res.data.user || res.data;
}

test('Smoke Test: 6. Programs and Courses API endpoints', async () => {
  const student = createUser({ program_code: 'LAW' });

  const progRes = await call('GET', '/api/programs');
  assert.equal(progRes.status, 200);
  assert.ok(Array.isArray(progRes.data.programs));

  const myProgRes = await call('GET', '/api/programs/mine', { user: student });
  assert.equal(myProgRes.status, 200);
  assert.equal(myProgRes.data.program.code, 'LAW');

  const crsRes = await call('GET', '/api/courses');
  assert.equal(crsRes.status, 200);
  assert.ok(Array.isArray(crsRes.data.courses));

  const mathRes = await call('GET', '/api/courses/mathematics', { user: student });
  assert.equal(mathRes.status, 200);
  assert.ok(mathRes.data.subject);

  const mathVidRes = await call('GET', '/api/courses/mathematics?view=videos&term=Term%201', { user: student });
  assert.equal(mathVidRes.status, 200);
  assert.ok(Array.isArray(mathVidRes.data.lectures));
});

test('Smoke Test: 7. Resources, Search, Bookmarks, and Completion API endpoints', async () => {
  const student = createUser({ program_code: 'LAW' });
  const doc = createResource({ category: 'document', title: 'Jurisprudence Notes', subject: 'Law' });

  const listRes = await call('GET', '/api/resources', { user: student });
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.data.resources));

  const getRes = await call('GET', `/api/resources/${doc.id}`, { user: student });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.data.resource.id, doc.id);

  const searchRes = await call('GET', '/api/resources/search?q=Jurisprudence', { user: student });
  assert.equal(searchRes.status, 200);
  assert.ok(searchRes.data.results.some(r => r.id === doc.id));

  const bmPostRes = await call('POST', `/api/resources/${doc.id}/bookmark`, { user: student });
  assert.equal(bmPostRes.status, 200);

  const bmGetRes = await call('GET', '/api/resources/bookmarks/mine', { user: student });
  assert.equal(bmGetRes.status, 200);
  assert.ok(bmGetRes.data.resources.some(r => r.id === doc.id));

  const compPostRes = await call('POST', `/api/resources/${doc.id}/complete`, { user: student });
  assert.equal(compPostRes.status, 200);

  const compGetRes = await call('GET', '/api/resources/completed/mine', { user: student });
  assert.equal(compGetRes.status, 200);
  assert.ok(compGetRes.data.completed.some(c => c.resourceId === doc.id));
});

test('Smoke Test: 8. Notifications and Quiz API endpoints', async () => {
  const student = createUser({ program_code: 'LAW' });

  const notifRes = await call('GET', '/api/notifications', { user: student });
  assert.equal(notifRes.status, 200);
  assert.ok(Array.isArray(notifRes.data.announcements));

  const unreadRes = await call('GET', '/api/notifications/unread-count', { user: student });
  assert.equal(unreadRes.status, 200);
  assert.ok(typeof unreadRes.data.unreadCount === 'number');

  const quizRes = await call('GET', '/api/quiz/student', { user: student });
  assert.equal(quizRes.status, 200);
  assert.ok(Array.isArray(quizRes.data.quizzes));
});

test('Smoke Test: 9. Security Headers and Static Protection', async () => {
  const res = await call('GET', '/');
  assert.ok(res.headers.get('content-security-policy'), 'CSP header must be present');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(res.headers.get('x-powered-by'), null, 'X-Powered-By must be removed');
});
