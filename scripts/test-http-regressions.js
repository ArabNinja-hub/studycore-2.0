'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const bcrypt = require('bcryptjs');
const { db, storage, call, createUser, createResource, baseUrl } = require('./helpers/test-app');

// Browsers send Origin on same-origin POSTs too; fetch-based API tests that
// omit it cannot catch a deployment that rejects its own login form.
test('same-origin browser requests work on local and reverse-proxied hosts', async () => {
  const user = createUser();
  const body = { email: user.email, password: 'regression-password' };
  const local = await call('POST', '/api/auth/login', { body, headers: { Origin: baseUrl() } });
  assert.equal(local.status, 200, local.text);

  const previewOrigin = 'https://3000-regression.e2b.app';
  const preview = await call('POST', '/api/auth/login', {
    body,
    headers: { Host: '3000-regression.e2b.app', 'X-Forwarded-Proto': 'https', Origin: previewOrigin }
  });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.headers.get('access-control-allow-origin'), previewOrigin);
});

test('CORS still rejects foreign origins, null origins and forged forwarded hosts', async () => {
  for (const origin of ['https://untrusted.studycore.test', 'null', 'https://127.0.0.1', `${baseUrl()}.evil.test`]) {
    const result = await call('POST', '/api/auth/logout', {
      headers: { Origin: origin, 'X-Forwarded-Host': origin.replace(/^https?:\/\//, '') }
    });
    assert.equal(result.status, 403, origin);
    assert.equal(result.headers.get('access-control-allow-origin'), null, origin);
  }
  const noOrigin = await call('GET', '/api/config');
  assert.equal(noOrigin.status, 200);
});

test('explicitly trusted cross-origin preflight requests retain credentials support', async () => {
  const result = await call('OPTIONS', '/api/auth/login', {
    headers: {
      Origin: 'https://trusted.studycore.test',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  });
  assert.equal(result.status, 204);
  assert.equal(result.headers.get('access-control-allow-origin'), 'https://trusted.studycore.test');
  assert.equal(result.headers.get('access-control-allow-credentials'), 'true');
});

test('viewing avatars does not spend the avatar upload allowance', async () => {
  const user = createUser();
  for (let i = 0; i < 12; i += 1) {
    const result = await call('GET', '/api/auth/avatar', { user });
    assert.equal(result.status, 404, `view ${i + 1}: ${result.text}`);
  }
  for (let i = 0; i < 10; i += 1) {
    const result = await call('POST', '/api/auth/avatar', { user });
    assert.equal(result.status, 400, `upload ${i + 1}: ${result.text}`);
  }
  assert.equal((await call('POST', '/api/auth/avatar', { user })).status, 429);
  assert.equal((await call('DELETE', '/api/auth/avatar', { user })).status, 429);
  assert.equal((await call('GET', '/api/auth/avatar', { user })).status, 404);
  assert.equal((await call('HEAD', '/api/auth/avatar', { user })).status, 404);
});

test('listing resources does not spend the resource upload allowance', async () => {
  const user = createUser({ role: 'admin' });
  for (let i = 0; i < 32; i += 1) {
    const result = await call('GET', '/api/admin/resources', { user });
    assert.equal(result.status, 200, `list ${i + 1}: ${result.text}`);
  }
  for (let i = 0; i < 30; i += 1) {
    const result = await call('POST', '/api/admin/resources', { user, body: {} });
    assert.equal(result.status, 400, `upload ${i + 1}: ${result.text}`);
  }
  assert.equal((await call('POST', '/api/admin/resources', { user, body: {} })).status, 429);
  assert.equal((await call('DELETE', '/api/admin/resources/missing', { user })).status, 429);
  assert.equal((await call('GET', '/api/admin/resources', { user })).status, 200);
});

test('malformed authentication fields return validation errors rather than hanging', async () => {
  const user = createUser();
  const invalid = [
    ['POST', '/api/auth/login', { email: {}, password: 'regression-password' }],
    ['POST', '/api/auth/login', { email: user.email, password: ['regression-password'] }],
    ['POST', '/api/auth/register', { name: {}, email: 'invalid@studycore.test', password: 'password', program: 'LAW' }],
    ['POST', '/api/auth/register', { name: 'Invalid', email: 'invalid@studycore.test', password: {}, program: 'LAW' }],
    ['POST', '/api/auth/register', { name: 'Invalid', email: 'invalid@studycore.test', password: 'password', program: 'LAW', school: {} }],
    ['POST', '/api/auth/register-content-admin', {
      name: ['Invalid'], email: 'invalid-publisher@studycore.test', password: 'password', confirmPassword: 'password',
      adminAccessCode: process.env.CONTENT_ADMIN_ACCESS_CODE
    }],
    ['POST', '/api/auth/register-content-admin', {
      name: 'Invalid', email: 'invalid-publisher@studycore.test', password: {}, confirmPassword: '[object Object]',
      adminAccessCode: process.env.CONTENT_ADMIN_ACCESS_CODE
    }],
    ['PUT', '/api/auth/password', { currentPassword: {}, newPassword: 'new-password' }],
    ['PUT', '/api/auth/password', { currentPassword: 'regression-password', newPassword: {} }]
  ];
  for (const [method, pathname, body] of invalid) {
    const result = await call(method, pathname, { user, body });
    assert.equal(result.status, 400, `${pathname}: ${result.text}`);
  }
  assert.equal((await call('POST', '/api/auth/login', {
    body: { email: user.email, password: 'regression-password' }
  })).status, 200, 'valid credentials still work after rejected input');
});

test('concurrent registrations of the same email return one success and one conflict', async () => {
  const bodies = [
    ['/api/auth/register', { name: 'Concurrent Student', email: 'duplicate-student@studycore.test', password: 'password', program: 'LAW' }],
    ['/api/auth/register-content-admin', {
      name: 'Concurrent Publisher', email: 'duplicate-publisher@studycore.test',
      password: 'password', confirmPassword: 'password', adminAccessCode: process.env.CONTENT_ADMIN_ACCESS_CODE
    }]
  ];
  for (const [pathname, body] of bodies) {
    const results = await Promise.all([call('POST', pathname, { body }), call('POST', pathname, { body })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], pathname);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE email = ?').get(body.email).n, 1);
  }
});

test('unexpected async route failures reach the sanitized HTTP error handler', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  t.mock.method(bcrypt, 'hash', async () => { throw new Error('private-regression-failure'); });
  const result = await call('POST', '/api/auth/register', {
    body: { name: 'Hash Failure', email: 'hash-failure@studycore.test', password: 'password', program: 'LAW' }
  });
  assert.equal(result.status, 500, result.text);
  assert.doesNotMatch(result.text, /private-regression-failure|stack|bcrypt/i);
  assert.ok(logged.length > 0, 'the full error remains available to server logs');
  assert.equal((await call('GET', '/api/config')).status, 200, 'the server continues serving requests');
});

test('legacy SVGs are served inertly without a const-assignment crash', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Legacy diagram</title></svg>';
  const row = createResource({ stored_name: 'legacy.svg', file_name: 'legacy.svg', mime_type: 'image/svg+xml', file_size: Buffer.byteLength(svg) });
  await storage.putObject({ key: row.stored_name, body: svg });
  const user = createUser();
  const result = await call('GET', `/api/resources/${row.id}/stream`, { user });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.headers.get('content-type'), 'application/octet-stream');
  assert.match(result.headers.get('content-disposition'), /^attachment;/);
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.text, svg);
});

test('Unicode filenames and PDF byte ranges produce valid response headers', async () => {
  const pdf = '%PDF-1.7\nRegression document\n%%EOF';
  const row = createResource({ stored_name: 'unicode.pdf', file_name: '\u6570\u5b66 \u2013 notes.pdf', mime_type: 'application/pdf', file_size: Buffer.byteLength(pdf) });
  await storage.putObject({ key: row.stored_name, body: pdf });
  const user = createUser();
  const result = await call('GET', `/api/resources/${row.id}/stream`, { user, headers: { Range: 'bytes=0-3' } });
  assert.equal(result.status, 206, result.text);
  assert.equal(result.text, '%PDF');
  assert.equal(result.headers.get('content-range'), `bytes 0-3/${Buffer.byteLength(pdf)}`);
  assert.ok(result.headers.get('content-disposition').includes(`filename*=UTF-8''${encodeURIComponent(row.file_name)}`));
  const head = await call('HEAD', `/api/resources/${row.id}/stream`, { user });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(pdf)));
  const invalid = await call('GET', `/api/resources/${row.id}/stream`, { user, headers: { Range: 'bytes=10000-' } });
  assert.equal(invalid.status, 416);
});
