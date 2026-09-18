'use strict';

// Tests for the StudyCore transactional email system (Resend).
//
// Covers:
//   1. Template rendering for all three ACTIVE emails (branding, tagline,
//      student name, production links, HTML escaping, text alternative)
//   2. The prepared-but-inactive templates still render
//   3. The transport never throwing, its not-configured fallback, and the
//      fact that it never logs or returns the API key
//   4. TEST 1 - registering a student sends exactly one welcome email, to the
//      address stored in the database
//   5. TEST 2 - an admin approving a payment sends exactly one approval email
//      to that student's stored address
//   6. TEST 3 - an admin rejecting a payment sends exactly one rejection
//      email to that student's stored address
//   7. Duplicate protection for every one of the three flows
//   8. Email failure never breaking registration, approval or rejection
//   9. RESEND_API_KEY never appearing in any API response
//
// No real email is ever sent and no network call is made: the transport's
// test seam captures the outgoing payload. RESEND_API_KEY is never needed.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

// Isolated database and test-only secrets - never a developer's real data.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-emails-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  JWT_SECRET: 'test-only-studycore-jwt-secret-0123456789',
  CONTENT_ADMIN_ACCESS_CODE: 'test-only-content-admin-access-code',
  ADMIN_EMAIL: '',
  ADMIN_PASSWORD: '',
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET_NAME: '',
  SMTP_HOST: '',
  // Deliberately unset: the suite must pass without any Resend credential.
  RESEND_API_KEY: '',
  EMAIL_FROM: 'StudyCore <no-reply@studycore.academy>',
  APP_URL: 'https://studycore.academy'
});

const db = require('../db');
const emailService = require('../lib/email');
const templates = require('../lib/email/templates');
const transport = require('../lib/email/transport');
const { createToken, COOKIE_NAME } = require('../middleware/auth');

const NOW = new Date().toISOString();
const IN_30_DAYS = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

// ---------------------------------------------------------------------------
// Outgoing-message capture (replaces the real Resend call)
// ---------------------------------------------------------------------------

let outbox = [];
let failNextSends = false;

function installCapture() {
  outbox = [];
  failNextSends = false;
  transport.__setTestSender(async (payload, meta) => {
    if (failNextSends) {
      // Mirrors a real Resend outage: transport.send() resolves with an
      // error result, it never throws.
      return { sent: false, error: 'Simulated Resend outage' };
    }
    outbox.push({ ...payload, kind: meta.kind });
    return { sent: true, id: `test-${outbox.length}` };
  });
}

function uninstallCapture() {
  transport.__setTestSender(null);
}

function mailsTo(address, kind) {
  return outbox.filter((m) => m.to.includes(address) && (!kind || m.kind === kind));
}

// ---------------------------------------------------------------------------
// 1. Templates - the three ACTIVE emails
// ---------------------------------------------------------------------------

test('welcome template: branding, student name, explanation and production link', () => {
  const { subject, html, text } = templates.welcome({ name: 'Chipo Banda' });

  assert.match(subject, /StudyCore/, 'subject carries the brand');
  assert.match(html, /StudyCore/, 'HTML carries the brand wordmark');
  assert.match(html, /Stay curious and winning/, 'HTML carries the tagline');
  assert.match(html, /Welcome to StudyCore, Chipo/, 'greets the student by name');
  assert.match(html, /program-based learning platform/i, 'explains what StudyCore is');
  assert.match(html, /https:\/\/studycore\.academy/, 'links to the production site');
  assert.ok(!/localhost|example\.com|onrender/.test(html), 'no placeholder or invented domain');

  assert.match(text, /Welcome to StudyCore, Chipo/, 'text alternative greets the student');
  assert.match(text, /Stay curious and winning/, 'text alternative carries the tagline');
  assert.match(text, /https:\/\/studycore\.academy/, 'text alternative has a real link');
});

test('approved template: name, clear approval, access confirmation, button, branding', () => {
  const { subject, html, text } = templates.subscriptionAccepted({
    name: 'Mwila Phiri',
    subscriptionEnd: IN_30_DAYS
  });

  assert.match(subject, /approved/i, 'subject states the outcome');
  assert.match(html, /Mwila/, 'greets the student by name');
  assert.match(html, /approved/i, 'clearly confirms approval');
  assert.match(html, /access all the resources/i, 'confirms what they can now access');
  assert.match(html, /Start learning/, 'has a call-to-action button');
  assert.match(html, /https:\/\/studycore\.academy/, 'button points at the production site');
  assert.match(html, /Stay curious and winning/, 'carries the tagline');
  assert.match(text, /APPROVED/, 'text alternative states the outcome');
});

test('rejected template: name, clear non-approval, support contact, branding', () => {
  const { subject, html, text } = templates.subscriptionRejected({ name: 'Bwalya Tembo' });

  assert.match(subject, /subscription/i, 'subject references the subscription');
  assert.match(html, /Bwalya/, 'greets the student by name');
  assert.match(html, /not approved/i, 'clearly states it was not approved');
  // The support number StudyCore already publishes site-wide.
  assert.match(html, /\+260981474031/, 'includes the existing support contact');
  assert.match(html, /wa\.me/, 'support contact is reachable');
  assert.match(html, /https:\/\/studycore\.academy/, 'links back to StudyCore');
  assert.match(html, /Stay curious and winning/, 'carries the tagline');
  assert.match(text, /NOT approved/, 'text alternative states the outcome');
});

test('templates: student-supplied names are HTML-escaped', () => {
  const html = templates.welcome({ name: '<script>alert(1)</script> Chipo' }).html;
  assert.ok(!html.includes('<script>'), 'raw script tag never reaches the markup');
  assert.ok(html.includes('&lt;script&gt;'), 'it is escaped to entities instead');
});

test('templates: a missing name degrades to a neutral greeting', () => {
  assert.match(templates.welcome({ name: '' }).html, /Welcome to StudyCore, there/);
  assert.match(templates.subscriptionAccepted({ name: null }).html, /Good news, there/);
});

test('templates: inbox-compatibility basics (tables, inline styles, Outlook button)', () => {
  const html = templates.subscriptionAccepted({ name: 'Chipo', subscriptionEnd: IN_30_DAYS }).html;
  assert.match(html, /<table role="presentation"/, 'uses table layout for Outlook');
  assert.match(html, /max-width:600px/, 'constrained, mobile-friendly content column');
  assert.match(html, /<!--\[if mso\]>/, 'has an Outlook (VML) button fallback');
  assert.match(html, /name="viewport"/, 'declares a viewport for mobile clients');
  assert.ok(!/<style[\s>]/.test(html), 'no <style> block - Gmail strips them in places');
});

// ---------------------------------------------------------------------------
// 2. Prepared-but-inactive templates still render
// ---------------------------------------------------------------------------

test('prepared templates render without being wired to any flow', () => {
  const prepared = [
    templates.loginNotification({ name: 'A', when: NOW, device: 'Chrome on Windows' }),
    templates.emailVerification({ name: 'B', verifyUrl: 'https://studycore.academy/verify?t=x' }),
    templates.passwordReset({ name: 'C', resetUrl: 'https://studycore.academy/reset?t=x' }),
    templates.subscriptionExpiring({ name: 'D', subscriptionEnd: IN_30_DAYS, daysLeft: 3 }),
    templates.subscriptionExpired({ name: 'E', subscriptionEnd: NOW })
  ];
  for (const message of prepared) {
    assert.ok(message.subject && message.html && message.text, 'every prepared template is complete');
    assert.match(message.html, /StudyCore/, 'prepared templates are branded too');
    assert.match(message.html, /Stay curious and winning/, 'and carry the tagline');
  }
});

test('all eight required send functions exist and are callable', () => {
  for (const name of [
    'sendWelcomeEmail',
    'sendSubscriptionAcceptedEmail',
    'sendSubscriptionRejectedEmail',
    'sendLoginNotificationEmail',
    'sendEmailVerificationEmail',
    'sendPasswordResetEmail',
    'sendSubscriptionExpiringEmail',
    'sendSubscriptionExpiredEmail'
  ]) {
    assert.equal(typeof emailService[name], 'function', `${name} is exported`);
  }
});

// ---------------------------------------------------------------------------
// 3. Transport safety
// ---------------------------------------------------------------------------

test('transport: no API key configured means nothing is sent and nothing throws', async () => {
  assert.equal(emailService.isEmailConfigured(), false, 'RESEND_API_KEY must be unset in tests');
  const result = await transport.send({
    to: 'student@example.com', subject: 'x', html: '<p>x</p>', text: 'x', kind: 'unit'
  });
  assert.equal(result.sent, false);
  assert.equal(result.simulated, true, 'reported as simulated rather than failed');
});

test('transport: an unusable stored address is reported, never thrown', async () => {
  const result = await transport.send({ to: 'not-an-address', subject: 'x', html: 'x', text: 'x', kind: 'unit' });
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.ok(result.error, 'reports why');
});

test('transport: addresses are masked in logs', () => {
  // "chipo.banda" is 11 characters: the first 2 are kept, the other 9 masked.
  assert.equal(transport.maskEmail('chipo.banda@gmail.com'), 'ch*********@gmail.com');
  // Always at least one '*', so even a one-character local part is never
  // written to the log verbatim.
  assert.equal(transport.maskEmail('a@b.com'), 'a*@b.com');
  assert.equal(transport.maskEmail(''), '(invalid address)');
});

test('emailStatus() never exposes the API key', () => {
  process.env.RESEND_API_KEY = 're_test_supersecretvalue_1234567890';
  try {
    const status = emailService.emailStatus();
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes('supersecret'), 'the key value never appears in the status payload');
    assert.ok(!serialized.includes('re_test_'), 'not even a prefix of the key is exposed');
    assert.equal(status.configured, true, 'it only reports that a key is present');
    assert.equal(status.from, 'StudyCore <no-reply@studycore.academy>', 'reports the public From identity');
  } finally {
    process.env.RESEND_API_KEY = '';
  }
});

test('config uses process.env.EMAIL_FROM and process.env.APP_URL', () => {
  const config = require('../lib/email/config');
  process.env.EMAIL_FROM = 'StudyCore <no-reply@studycore.academy>';
  assert.equal(config.fromAddress(), 'StudyCore <no-reply@studycore.academy>');
  // A bare address is normalised into a named sender.
  process.env.EMAIL_FROM = 'no-reply@studycore.academy';
  assert.equal(config.fromAddress(), 'StudyCore <no-reply@studycore.academy>');
  process.env.EMAIL_FROM = 'StudyCore <no-reply@studycore.academy>';
  assert.equal(config.appUrl(), 'https://studycore.academy');
});

// ---------------------------------------------------------------------------
// 4-9. End-to-end HTTP flows against the real routes
// ---------------------------------------------------------------------------

const express = require('express');
const cookieParser = require('cookie-parser');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', require('../routes/auth.routes'));
  app.use('/api/admin', require('../routes/admin.routes'));
  return app;
}

async function withServer(run) {
  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

// The registration route needs a real program code (it is validated against
// the live programs table seeded at boot).
function someProgramCode() {
  const row = db.prepare('SELECT code FROM programs LIMIT 1').get();
  assert.ok(row, 'the program catalog is seeded');
  return row.code;
}

function makeAdmin() {
  const admin = {
    id: `admin-${randomUUID()}`,
    name: 'Mail Admin',
    email: `admin.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@studycore.test`,
    password: 'x',
    role: 'admin',
    created_at: NOW
  };
  db.prepare(`INSERT INTO users (id, name, email, password, role, created_at)
              VALUES (@id, @name, @email, @password, @role, @created_at)`).run(admin);
  return admin;
}

function makeStudentWithPendingPayment() {
  const student = {
    id: `student-${randomUUID()}`,
    name: 'Test Student',
    email: `student.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@studycore.test`,
    password: 'x',
    role: 'student',
    created_at: NOW
  };
  db.prepare(`INSERT INTO users (id, name, email, password, role, created_at)
              VALUES (@id, @name, @email, @password, @role, @created_at)`).run(student);
  const paymentId = `payment-${randomUUID()}`;
  db.prepare(`INSERT INTO payments (id, user_id, method, phone, amount, status, created_at)
              VALUES (?, ?, 'MTN MoMo', '0962838485', 50, 'PENDING', ?)`).run(paymentId, student.id, NOW);
  return { student, paymentId };
}

// --- TEST 1: registration -> welcome email ---------------------------------

test('TEST 1: registering a student sends exactly one welcome email to the stored address', async () => {
  installCapture();
  try {
    await withServer(async (baseUrl) => {
      const email = `newstudent.${Date.now()}@studycore.test`;
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Chipo Banda',
          email,
          password: 'secret123',
          program: someProgramCode()
        })
      });
      assert.equal(res.status, 201, 'registration succeeds');

      // The email is dispatched after the response is sent.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const sent = mailsTo(email, 'welcome');
      assert.equal(sent.length, 1, 'exactly one welcome email');
      assert.match(sent[0].subject, /Welcome to StudyCore/);
      assert.match(sent[0].html, /Chipo/, 'addressed to the student by name');
      assert.equal(sent[0].from, 'StudyCore <no-reply@studycore.academy>', 'uses EMAIL_FROM');

      // It went to the address the database actually stored (lower-cased).
      const stored = db.prepare('SELECT email FROM users WHERE email = ?').get(email.toLowerCase());
      assert.ok(stored, 'the student row exists');
      assert.equal(sent[0].to[0], stored.email, 'recipient is the stored address');
    });
  } finally {
    uninstallCapture();
  }
});

test('TEST 1 (duplicate protection): a repeated signup never sends a second welcome email', async () => {
  installCapture();
  try {
    await withServer(async (baseUrl) => {
      const email = `dupe.${Date.now()}@studycore.test`;
      const body = JSON.stringify({
        name: 'Repeat Student', email, password: 'secret123', program: someProgramCode()
      });
      const headers = { 'Content-Type': 'application/json' };

      const first = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers, body });
      assert.equal(first.status, 201);
      // A frontend retry / double-submit: the second attempt is a conflict.
      const second = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers, body });
      assert.equal(second.status, 409, 'the duplicate registration is rejected');

      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(mailsTo(email, 'welcome').length, 1, 'still exactly one welcome email');
    });
  } finally {
    uninstallCapture();
  }
});

test('registration still succeeds when Resend is failing', async () => {
  installCapture();
  failNextSends = true;
  try {
    await withServer(async (baseUrl) => {
      const email = `resilient.${Date.now()}@studycore.test`;
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Resilient Student', email, password: 'secret123', program: someProgramCode()
        })
      });
      assert.equal(res.status, 201, 'the account is still created');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
      assert.ok(row, 'the student row was not rolled back by the email failure');
    });
  } finally {
    uninstallCapture();
  }
});

// --- TEST 2: admin approval -> approval email ------------------------------

test('TEST 2: approving a payment sends exactly one approval email to that student', async () => {
  installCapture();
  try {
    await withServer(async (baseUrl) => {
      const admin = makeAdmin();
      const { student, paymentId } = makeStudentWithPendingPayment();
      const cookie = `${COOKIE_NAME}=${createToken(admin)}`;

      const res = await fetch(`${baseUrl}/api/admin/payments/${paymentId}/approve`, {
        method: 'POST', headers: { Cookie: cookie }
      });
      assert.equal(res.status, 200, 'approval succeeds');
      const data = await res.json();
      assert.equal(data.emailSent, true, 'the response reports the email went out');

      // Subscription really was activated (the DB action is the priority).
      const updated = db.prepare('SELECT subscription FROM users WHERE id = ?').get(student.id);
      assert.equal(updated.subscription, 'premium');

      const sent = mailsTo(student.email, 'subscription_accepted');
      assert.equal(sent.length, 1, 'exactly one approval email');
      assert.match(sent[0].subject, /approved/i);
      assert.match(sent[0].html, /Test Student|Test/, 'addressed to the right student');
      assert.equal(sent[0].to[0], student.email, 'sent to the stored address');

      // And nobody else was emailed.
      assert.equal(outbox.length, 1, 'no other message was produced');
    });
  } finally {
    uninstallCapture();
  }
});

test('TEST 2 (duplicate protection): a second approve click cannot send a second email', async () => {
  installCapture();
  try {
    await withServer(async (baseUrl) => {
      const admin = makeAdmin();
      const { student, paymentId } = makeStudentWithPendingPayment();
      const cookie = `${COOKIE_NAME}=${createToken(admin)}`;

      const first = await fetch(`${baseUrl}/api/admin/payments/${paymentId}/approve`, { method: 'POST', headers: { Cookie: cookie } });
      assert.equal(first.status, 200);
      const second = await fetch(`${baseUrl}/api/admin/payments/${paymentId}/approve`, { method: 'POST', headers: { Cookie: cookie } });
      assert.equal(second.status, 400, 'the already-reviewed payment is refused');

      assert.equal(mailsTo(student.email, 'subscription_accepted').length, 1, 'still exactly one approval email');
    });
  } finally {
    uninstallCapture();
  }
});

test('TEST 2 (dedupe ledger): the service itself refuses to resend for the same payment', async () => {
  installCapture();
  try {
    const { student, paymentId } = makeStudentWithPendingPayment();
    const args = { userId: student.id, name: student.name, email: student.email, paymentId, subscriptionEnd: IN_30_DAYS };

    const a = await emailService.sendSubscriptionAcceptedEmail(args);
    const b = await emailService.sendSubscriptionAcceptedEmail(args);

    assert.equal(a.sent, true, 'the first call sends');
    assert.equal(b.sent, false, 'the second does not');
    assert.equal(b.skipped, true);
    assert.equal(b.reason, 'duplicate');
    assert.equal(mailsTo(student.email, 'subscription_accepted').length, 1);
  } finally {
    uninstallCapture();
  }
});

test('approval is NOT rolled back when Resend fails', async () => {
  installCapture();
  failNextSends = true;
  try {
    await withServer(async (baseUrl) => {
      const admin = makeAdmin();
      const { student, paymentId } = makeStudentWithPendingPayment();
      const cookie = `${COOKIE_NAME}=${createToken(admin)}`;

      const res = await fetch(`${baseUrl}/api/admin/payments/${paymentId}/approve`, { method: 'POST', headers: { Cookie: cookie } });
      assert.equal(res.status, 200, 'the request still succeeds');
      const data = await res.json();
      assert.equal(data.emailSent, false, 'it honestly reports the email failed');
      assert.match(data.message, /still active/, 'and says the subscription stands');

      const updated = db.prepare('SELECT subscription FROM users WHERE id = ?').get(student.id);
      assert.equal(updated.subscription, 'premium', 'the student is still premium');
      const paymentRow = db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId);
      assert.equal(paymentRow.status, 'SUCCESS', 'the payment is still approved');
    });
  } finally {
    uninstallCapture();
  }
});

// --- TEST 3: admin rejection -> rejection email ----------------------------

test('TEST 3: rejecting a payment sends exactly one rejection email to that student', async () => {
  installCapture();
  try {
    await withServer(async (baseUrl) => {
      const admin = makeAdmin();
      const { student, paymentId } = makeStudentWithPendingPayment();
      const cookie = `${COOKIE_NAME}=${createToken(admin)}`;

      const res = await fetch(`${baseUrl}/api/admin/payments/${paymentId}/reject`, {
        method: 'POST', headers: { Cookie: cookie }
      });
      assert.equal(res.status, 200, 'rejection succeeds');
      const data = await res.json();
      assert.equal(data.emailSent, true);

      const paymentRow = db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId);
      assert.equal(paymentRow.status, 'REJECTED');

      // Rejecting must not touch the student's plan.
      const updated = db.prepare('SELECT subscription FROM users WHERE id = ?').get(student.id);
      assert.notEqual(updated.subscription, 'premium', 'rejection does not grant premium');

      const sent = mailsTo(student.email, 'subscription_rejected');
      assert.equal(sent.length, 1, 'exactly one rejection email');
      assert.match(sent[0].html, /not approved/i);
      assert.match(sent[0].html, /\+260981474031/, 'tells them how to reach support');
      assert.equal(sent[0].to[0], student.email, 'sent to the stored address');
    });
  } finally {
    uninstallCapture();
  }
});

test('TEST 3 (duplicate protection): a second reject click cannot send a second email', async () => {
  installCapture();
  try {
    await withServer(async (baseUrl) => {
      const admin = makeAdmin();
      const { student, paymentId } = makeStudentWithPendingPayment();
      const cookie = `${COOKIE_NAME}=${createToken(admin)}`;

      const first = await fetch(`${baseUrl}/api/admin/payments/${paymentId}/reject`, { method: 'POST', headers: { Cookie: cookie } });
      assert.equal(first.status, 200);
      const second = await fetch(`${baseUrl}/api/admin/payments/${paymentId}/reject`, { method: 'POST', headers: { Cookie: cookie } });
      assert.equal(second.status, 400, 'the already-reviewed payment is refused');

      assert.equal(mailsTo(student.email, 'subscription_rejected').length, 1, 'still exactly one rejection email');
    });
  } finally {
    uninstallCapture();
  }
});

test('rejection is still recorded when Resend fails', async () => {
  installCapture();
  failNextSends = true;
  try {
    await withServer(async (baseUrl) => {
      const admin = makeAdmin();
      const { paymentId } = makeStudentWithPendingPayment();
      const cookie = `${COOKIE_NAME}=${createToken(admin)}`;

      const res = await fetch(`${baseUrl}/api/admin/payments/${paymentId}/reject`, { method: 'POST', headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const paymentRow = db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId);
      assert.equal(paymentRow.status, 'REJECTED', 'the rejection stands despite the email failure');
    });
  } finally {
    uninstallCapture();
  }
});

// --- Security ---------------------------------------------------------------

test('security: the admin email endpoints never expose the API key', async () => {
  installCapture();
  process.env.RESEND_API_KEY = 're_live_thisisnotarealkey_0987654321';
  try {
    await withServer(async (baseUrl) => {
      const admin = makeAdmin();
      const cookie = `${COOKIE_NAME}=${createToken(admin)}`;

      const res = await fetch(`${baseUrl}/api/admin/email/status`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(!body.includes('thisisnotarealkey'), 'the key value is absent from the response');
      assert.ok(!body.includes('re_live_'), 'no key prefix either');
      assert.match(body, /"configured":true/, 'it only reports that a key exists');
    });
  } finally {
    process.env.RESEND_API_KEY = '';
    uninstallCapture();
  }
});

test('security: students cannot reach the admin email endpoints', async () => {
  installCapture();
  try {
    await withServer(async (baseUrl) => {
      const { student } = makeStudentWithPendingPayment();
      const cookie = `${COOKIE_NAME}=${createToken({ ...student, role: 'student' })}`;

      const status = await fetch(`${baseUrl}/api/admin/email/status`, { headers: { Cookie: cookie } });
      assert.equal(status.status, 403, 'a student cannot read email status');

      const send = await fetch(`${baseUrl}/api/admin/email/test`, { method: 'POST', headers: { Cookie: cookie } });
      assert.equal(send.status, 403, 'a student cannot trigger a test send');

      const anon = await fetch(`${baseUrl}/api/admin/email/test`, { method: 'POST' });
      assert.equal(anon.status, 401, 'an anonymous visitor cannot either');

      assert.equal(outbox.length, 0, 'no email was produced by any of that');
    });
  } finally {
    uninstallCapture();
  }
});

test('security: the admin test email ignores any client-supplied recipient', async () => {
  installCapture();
  try {
    await withServer(async (baseUrl) => {
      const admin = makeAdmin();
      const cookie = `${COOKIE_NAME}=${createToken(admin)}`;

      const res = await fetch(`${baseUrl}/api/admin/email/test?template=welcome`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        // A hostile client trying to use this as an open relay.
        body: JSON.stringify({ to: 'attacker@evil.test', email: 'attacker@evil.test' })
      });
      assert.equal(res.status, 200);

      assert.equal(outbox.length, 1, 'one message');
      assert.equal(outbox[0].to[0], admin.email, 'addressed to the admin, not the attacker');
      assert.ok(!outbox.some((m) => m.to.includes('attacker@evil.test')), 'the supplied address was ignored');
    });
  } finally {
    uninstallCapture();
  }
});

test('security: no send function accepts a recipient that is not passed explicitly by the server', async () => {
  installCapture();
  try {
    // A student row is the only source of an address in the live flows; the
    // service has no route that takes an arbitrary "to" from the browser.
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.routes.js'), 'utf8')
      + fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.routes.js'), 'utf8');
    assert.ok(!/email:\s*req\.body/.test(routes), 'no route passes a request-body address into the email service');
    assert.ok(!/to:\s*req\.body/.test(routes), 'and none passes a request-body "to" either');
  } finally {
    uninstallCapture();
  }
});

test('security: RESEND_API_KEY is not referenced anywhere in frontend code', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html|css)$/.test(entry.name)) {
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes('RESEND_API_KEY') || /\bre_[A-Za-z0-9]{16,}\b/.test(content)) offenders.push(full);
      }
    }
  })(publicDir);
  assert.deepEqual(offenders, [], 'no frontend asset mentions the Resend key');

  // Views are server-rendered HTML shells - check them too.
  const viewsDir = path.join(__dirname, '..', 'views');
  for (const file of fs.readdirSync(viewsDir)) {
    const content = fs.readFileSync(path.join(viewsDir, file), 'utf8');
    assert.ok(!content.includes('RESEND_API_KEY'), `${file} does not mention the Resend key`);
  }
});

test('security: the key is read only inside lib/email and never hard-coded', () => {
  const root = path.join(__dirname, '..');
  const skip = new Set(['node_modules', '.git', 'data', 'dist', 'coverage']);
  const readers = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes('process.env.RESEND_API_KEY')) readers.push(path.relative(root, full));
        // A real key literal must never appear in the source.
        assert.ok(!/['"]re_[A-Za-z0-9]{20,}['"]/.test(content.replace(/re_test_supersecretvalue_1234567890|re_live_thisisnotarealkey_0987654321/g, '')),
          `${entry.name} must not contain a hard-coded Resend key`);
      }
    }
  })(root);

  for (const file of readers) {
    assert.ok(
      file.startsWith(path.join('lib', 'email')) || file.startsWith(path.join('scripts', 'test-emails')),
      `RESEND_API_KEY should only be read inside lib/email (found in ${file})`
    );
  }
});

// --- Ledger -----------------------------------------------------------------

test('the email ledger records a safe audit trail (no addresses, no key)', async () => {
  installCapture();
  try {
    const { student, paymentId } = makeStudentWithPendingPayment();
    await emailService.sendSubscriptionAcceptedEmail({
      userId: student.id, name: student.name, email: student.email, paymentId, subscriptionEnd: IN_30_DAYS
    });

    const row = db.prepare('SELECT * FROM email_log WHERE dedupe_key = ?').get(`payment:${paymentId}`);
    assert.ok(row, 'the dispatch was recorded');
    assert.equal(row.kind, 'subscription_accepted');
    assert.equal(row.status, 'sent');
    assert.ok(row.provider_id, 'the provider message id is stored for lookup');

    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes(student.email), 'the ledger does not store the address');
    assert.ok(!serialized.includes('re_'), 'and certainly not a key');
  } finally {
    uninstallCapture();
  }
});

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
