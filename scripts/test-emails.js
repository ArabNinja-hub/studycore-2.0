'use strict';

// Tests for the "access granted" email that is sent when an admin approves a
// student's mobile-money payment request.
//
// Covers:
//   1. lib/mailer.js template rendering (HTML + text, escaping, method labels)
//   2. sendAccessGrantedEmail() never throwing, and its not-configured fallback
//   3. The full approve endpoint: subscription activated + email dispatch +
//      emailSent flag in the response + double-approval still rejected
//
// No real SMTP server is contacted: the tests run with SMTP unset, so the
// mailer takes its console-log fallback path.

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const db = require('../db');
const { createToken, COOKIE_NAME } = require('../middleware/auth');
const mailer = require('../lib/mailer');

const NOW = new Date().toISOString();
const IN_30_DAYS = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

test('mailer: access-granted email renders correctly', () => {
  assert.equal(mailer.isMailConfigured(), false, 'SMTP must be unset in the test environment');

  const html = mailer.renderAccessGrantedHtml({
    name: 'Chipo Banda',
    subscriptionEnd: IN_30_DAYS,
    method: 'MTN MoMo',
    amount: 50
  });
  const text = mailer.renderAccessGrantedText({
    name: 'Chipo Banda',
    subscriptionEnd: IN_30_DAYS,
    method: 'MTN MoMo',
    amount: 50
  });

  assert.match(html, /StudyCore/, 'HTML mentions the brand');
  assert.match(html, /Hi Chipo/, 'HTML greets the student by first name');
  assert.match(html, /MTN MoMo/, 'HTML mentions the payment method');
  assert.match(html, /K50/, 'HTML mentions the amount');
  assert.match(html, /Access granted/i, 'HTML announces access granted');
  assert.match(html, /href="[^"]*\/pages\/videos\.html"/, 'HTML has a link to the video lessons');
  assert.ok(!html.includes('Chipo Banda<'), 'full name not injected raw into markup');

  assert.match(text, /Hi Chipo/, 'Text greets the student');
  assert.match(text, /MTN MoMo/, 'Text mentions the payment method');
  assert.match(text, /pages\/videos\.html/, 'Text includes a plain link');
});

test('mailer: user-supplied values are HTML-escaped', () => {
  // A first name that is itself markup - must never reach the HTML raw.
  const html = mailer.renderAccessGrantedHtml({
    name: '<script>alert(1)</script> Chipo',
    subscriptionEnd: IN_30_DAYS,
    method: 'Airtel Money',
    amount: 50
  });
  assert.ok(!html.includes('<script>'), 'script tag must be escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'script tag is escaped to entities');
  assert.ok(!html.includes('Hi <script'), 'greeting does not inject raw markup');
});

test('mailer: payment method labels normalise safely', () => {
  assert.equal(mailer.paymentMethodLabel('MTN MoMo'), 'MTN MoMo');
  assert.equal(mailer.paymentMethodLabel('airtel money'), 'Airtel Money');
  assert.equal(mailer.paymentMethodLabel(null), 'mobile money');
  assert.equal(mailer.paymentMethodLabel(''), 'mobile money');
});

test('mailer: sendAccessGrantedEmail never throws', async () => {
  // With SMTP unconfigured this takes the console-log fallback...
  const fallback = await mailer.sendAccessGrantedEmail({
    to: 'student@example.com',
    name: 'Test Student',
    subscriptionEnd: IN_30_DAYS,
    method: 'MTN MoMo',
    amount: 50
  });
  assert.equal(fallback.sent, false, 'not sent when SMTP is unset');
  assert.equal(fallback.simulated, true, 'fallback is flagged as simulated');

  // ...and a missing recipient resolves (not rejects) with an error result.
  const noTo = await mailer.sendAccessGrantedEmail({ to: '', name: 'X', subscriptionEnd: IN_30_DAYS });
  assert.equal(noTo.sent, false);
  assert.ok(noTo.error, 'missing recipient reports an error');
});

test('HTTP API: approving a payment activates premium and dispatches the access-granted email', async () => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const adminRoutes = require('../routes/admin.routes');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin', adminRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const stamp = Date.now();
  const admin = { id: `admin-mail-${stamp}`, name: 'Mail Admin', email: `admin.mail.${stamp}@test.com`, password: 'pass', role: 'ADMIN', created_at: NOW };
  const student = { id: `student-mail-${stamp}`, name: 'Mail Student', email: `student.mail.${stamp}@test.com`, password: 'pass', role: 'STUDENT', created_at: NOW };
  db.prepare(`INSERT INTO users (id, name, email, password, role, created_at) VALUES (@id, @name, @email, @password, @role, @created_at)`).run(admin);
  db.prepare(`INSERT INTO users (id, name, email, password, role, created_at) VALUES (@id, @name, @email, @password, @role, @created_at)`).run(student);

  const paymentId = `payment-mail-${stamp}`;
  db.prepare(`INSERT INTO payments (id, user_id, method, phone, amount, status, created_at) VALUES (?, ?, 'MTN MoMo', '0962838485', 50, 'PENDING', ?)`)
    .run(paymentId, student.id, NOW);

  const authHeader = `${COOKIE_NAME}=${createToken(admin)}`;

  try {
    // 1. Non-admin can never approve
    const studentAuth = `${COOKIE_NAME}=${createToken(student)}`;
    const forbidden = await fetch(`${baseUrl}/api/admin/payments/${paymentId}/approve`, { method: 'POST', headers: { Cookie: studentAuth } });
    assert.equal(forbidden.status, 403, 'students must not be able to approve payments');

    // 2. Admin approves -> premium activated + email dispatched
    const approveRes = await fetch(`${baseUrl}/api/admin/payments/${paymentId}/approve`, { method: 'POST', headers: { Cookie: authHeader } });
    assert.equal(approveRes.status, 200, 'approve should return 200');
    const approveData = await approveRes.json();
    assert.equal(approveData.emailSent, false, 'emailSent=false because SMTP is unset in tests');
    assert.match(approveData.message, /Payment approved/, 'message confirms the approval');
    assert.match(approveData.message, /SMTP/, 'message explains why no email went out');

    const updatedUser = db.prepare('SELECT subscription, subscription_end FROM users WHERE id = ?').get(student.id);
    assert.equal(updatedUser.subscription, 'premium', 'student is premium after approval');
    const end = new Date(updatedUser.subscription_end).getTime();
    const days = (end - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(days > 29.9 && days <= 30, 'subscription end is ~30 days out');

    const paymentRow = db.prepare('SELECT status, reviewed_at, reviewed_by FROM payments WHERE id = ?').get(paymentId);
    assert.equal(paymentRow.status, 'SUCCESS', 'payment marked SUCCESS');
    assert.equal(paymentRow.reviewed_by, admin.id, 'reviewer recorded');

    // 3. Already-reviewed payment cannot be approved (and re-sent) again
    const again = await fetch(`${baseUrl}/api/admin/payments/${paymentId}/approve`, { method: 'POST', headers: { Cookie: authHeader } });
    assert.equal(again.status, 400, 'double approval is rejected');

    // 4. Unknown payment id -> 404
    const missing = await fetch(`${baseUrl}/api/admin/payments/does-not-exist/approve`, { method: 'POST', headers: { Cookie: authHeader } });
    assert.equal(missing.status, 404, 'unknown payment returns 404');
  } finally {
    server.close();
    db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId);
    db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(admin.id, student.id);
  }
});
