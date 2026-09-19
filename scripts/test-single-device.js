'use strict';

// =============================================================================
// StudyCore — single-active-device login regression tests
// -----------------------------------------------------------------------------
// Covers the full second-device flow end to end:
//
//   1.  First login on Device A works and creates a server-side session
//   2.  Browsing / re-logging in on the SAME device keeps working
//   3.  Login from Device B does NOT replace Device A's session — it starts
//       an email-verification challenge instead
//   4.  Device A stays fully active while Device B waits for verification
//   5.  Wrong verification codes are rejected and counted
//   6.  Expired codes are rejected
//   7.  A code cannot be reused after a successful verification
//   8.  Successful verification revokes Device A's session server-side
//   9.  Device A's NEXT request is rejected with the device-switch reason
//   10. Device B becomes the only active session
//   11. Logout on Device B revokes the server-side session immediately
//   12. The student can log in again normally afterwards
//   13. Concurrent Device B/C logins can never produce two active sessions
//   14. Verification emails and code guessing are rate-limited
//   15. Admin / Content Admin accounts are NOT restricted by the student rule
//
// Additional security checks: only hashes persist in the DB, legacy cookies
// without a server-side session die on first use, and the admin security
// audit endpoint is admin-only and never exposes secrets.
// =============================================================================

const assert = require('node:assert/strict');
const test = require('node:test');
const { db, call, createUser } = require('./helpers/test-app');
const transport = require('../lib/email/transport');
const { createToken, COOKIE_NAME } = require('../middleware/auth');

// ---------------------------------------------------------------------------
// Outgoing-message capture: the transport's test seam replaces Resend.
// ---------------------------------------------------------------------------
let outbox = [];
function installCapture() {
  outbox = [];
  transport.__setTestSender(async (payload, meta) => {
    outbox.push({ ...payload, kind: meta.kind });
    return { sent: true, id: `test-${outbox.length}` };
  });
}
installCapture();

function lastDeviceEmail() {
  for (let i = outbox.length - 1; i >= 0; i -= 1) {
    if (outbox[i].kind === 'device_login_verification') return outbox[i];
  }
  return null;
}

function deviceEmails() {
  return outbox.filter((m) => m.kind === 'device_login_verification');
}

function extractCode(email) {
  const match = /\b(\d{6})\b/.exec(email.html);
  assert.ok(match, 'the verification email contains a 6-digit code');
  return match[1];
}

function extractToken(email) {
  const match = /[?&]t=([a-f0-9]{96})/.exec(email.html);
  assert.ok(match, 'the verification email contains the magic link token');
  return match[1];
}

// The login route is IP-rate-limited (brute-force protection). Every fixture
// user gets a stable, unique forwarded address so the ~30 logins across this
// file never trip the shared 127.0.0.1 bucket - and so the device's coarse
// ip_hint gets exercised too.
function userIp(user) {
  let h = 0;
  for (const c of String(user.id)) h = ((h * 31) + c.charCodeAt(0)) >>> 0;
  return `10.98.${(h >> 8) & 255}.${h & 255}`;
}

async function login(user, extraHeaders = {}) {
  return call('POST', '/api/auth/login', {
    body: { email: user.email, password: 'regression-password' },
    headers: { 'User-Agent': 'test-browser', 'X-Forwarded-For': userIp(user), ...extraHeaders }
  });
}

function cookiePair(res) {
  const header = res.headers.get('set-cookie');
  assert.ok(header && header.includes(`${COOKIE_NAME}=`), 'a session cookie is set');
  return header.split(';')[0];
}

function me(cookie) {
  return call('GET', '/api/auth/me', { headers: cookie ? { Cookie: cookie } : {} });
}

function referral(cookie) {
  // A student-only, requireAuth-gated API endpoint: the cleanest probe for
  // "does this cookie still count as signed in".
  return call('GET', '/api/auth/referral', { headers: cookie ? { Cookie: cookie } : {} });
}

function activeSessions(userId) {
  return db.prepare('SELECT * FROM device_sessions WHERE user_id = ? AND revoked_at IS NULL').all(userId);
}

function openChallenges(userId) {
  return db.prepare('SELECT * FROM device_login_challenges WHERE user_id = ? AND used_at IS NULL').all(userId);
}

test('1-4: second-device login challenges while the first device stays active', async () => {
  const user = createUser();

  // (1) First login succeeds and creates exactly one active session row.
  const loginA = await login(user);
  assert.equal(loginA.status, 200, loginA.text);
  let cookieA = cookiePair(loginA);
  let sessions = activeSessions(user.id);
  assert.equal(sessions.length, 1, 'one active session after first login');
  assert.ok(sessions[0].device_id, 'a server-side device id exists');
  assert.ok(sessions[0].created_at && sessions[0].last_seen_at && sessions[0].expires_at);
  assert.equal(sessions[0].revoked_at, null);
  assert.equal(sessions[0].revocation_reason, null);

  // (2) Same device: session probes work, and re-entering credentials WITH
  // the cookie is a plain login, not a verification challenge.
  const probeA = await me(cookieA);
  assert.equal(probeA.status, 200, probeA.text);
  assert.equal(probeA.data.user.id, user.id);
  const reloginSameDevice = await login(user, { Cookie: cookieA });
  assert.equal(reloginSameDevice.status, 200, reloginSameDevice.text);
  assert.ok(!reloginSameDevice.data.requiresDeviceVerification, 'same-device re-login is not challenged');
  const cookieA2 = cookiePair(reloginSameDevice);
  assert.notEqual(cookieA2, cookieA, 'the session cookie rotates on re-login');
  assert.equal(activeSessions(user.id).length, 1, 'still exactly one active session');
  // From here on, the freshly re-bound cookie is device A's live cookie.
  cookieA = cookieA2;

  // (3) Device B logs in WITHOUT the cookie: challenged, not connected.
  outbox = [];
  const loginB = await login(user);
  assert.equal(loginB.status, 202, loginB.text);
  assert.equal(loginB.data.requiresDeviceVerification, true);
  assert.ok(loginB.data.challengeId, 'a pending challenge id is returned');
  assert.ok(loginB.data.maskedEmail && loginB.data.maskedEmail.includes('@'), 'the response hints at the registered email only');
  assert.match(loginB.data.message, /currently active on another device/i);
  assert.equal(activeSessions(user.id).length, 1, 'the existing session was NOT replaced');

  const challenge = openChallenges(user.id);
  assert.equal(challenge.length, 1, 'exactly one open challenge exists');
  assert.equal(challenge[0].id, loginB.data.challengeId);
  assert.ok(challenge[0].expires_at > new Date().toISOString());
  assert.match(challenge[0].code_hash, /^[a-f0-9]{64}$/, 'only a 6-digit code hash is stored');
  assert.match(challenge[0].magic_token_hash, /^[a-f0-9]{64}$/, 'only a magic token hash is stored');

  // Exactly one verification email, containing the code and the magic link.
  assert.equal(deviceEmails().length, 1, 'one verification email was dispatched');
  const email = deviceEmails()[0];
  assert.equal(email.subject, 'StudyCore: New device login verification');
  const code = extractCode(email);
  const tokenFromEmail = extractToken(email);
  // The email never contains the plaintext password or any session token.
  assert.ok(!email.html.includes('regression-password'));

  // (4) Device A remains fully active while B waits.
  const stillA = await referral(cookieA);
  assert.equal(stillA.status, 200, stillA.text);

  // (5) A wrong code is rejected and counted against the shared budget.
  const wrongCode = code === '000000' ? '000001' : '000000';
  const bad = await call('POST', '/api/auth/device-verify/code', {
    body: { challengeId: challenge[0].id, code: wrongCode }
  });
  assert.equal(bad.status, 400, bad.text);
  assert.match(bad.data.message, /not correct/i);
  const afterWrong = db.prepare('SELECT attempts FROM device_login_challenges WHERE id = ?').get(challenge[0].id);
  assert.equal(afterWrong.attempts, 1, 'the failed attempt was recorded');
  assert.equal(activeSessions(user.id).length, 1);

  // (8)+(7)+(9)+(10): correct code verifies, swaps the session, and cannot be reused.
  const verify = await call('POST', '/api/auth/device-verify/code', {
    body: { challengeId: challenge[0].id, code }
  });
  assert.equal(verify.status, 200, verify.text);
  const cookieB = cookiePair(verify);

  const rows = db.prepare('SELECT * FROM device_sessions WHERE user_id = ? ORDER BY created_at').all(user.id);
  assert.equal(rows.length, 2, 'the revoked row is preserved for the audit trail');
  const active = activeSessions(user.id);
  assert.equal(active.length, 1, 'exactly one active session after the switch');
  const revoked = rows.find((r) => r.revoked_at);
  assert.ok(revoked, 'the old session was revoked');
  assert.equal(revoked.revocation_reason, 'switched-device', 'the reason names the device switch');
  const usedChallenge = db.prepare('SELECT used_reason, new_session_id FROM device_login_challenges WHERE id = ?').get(challenge[0].id);
  assert.equal(usedChallenge.used_reason, 'verified');

  // (9) Device A's very next request is rejected with the device-switch reason.
  const afterA = await referral(cookieA);
  assert.equal(afterA.status, 401, afterA.text);
  assert.equal(afterA.data.code, 'SESSION_REVOKED');
  assert.equal(afterA.data.reason, 'signed-in-elsewhere');
  assert.match(afterA.data.message, /signed in on another device/i);
  // And a full page navigation lands on the login screen with the reason.
  const page = await call('GET', '/dashboard.html', { headers: { Cookie: cookieA } });
  assert.equal(page.status, 302, page.text);
  assert.equal(page.headers.get('location'), '/login.html?session=signed-in-elsewhere');

  // (7) The burnt code cannot be replayed.
  const replay = await call('POST', '/api/auth/device-verify/code', {
    body: { challengeId: challenge[0].id, code }
  });
  assert.equal(replay.status, 400, replay.text);

  // (10) Device B is now the only usable session.
  const onB = await me(cookieB);
  assert.equal(onB.status, 200, onB.text);
  assert.equal(onB.data.user.id, user.id);

  // (11) Logout on B revokes the SERVER-side session, not just the cookie.
  const logout = await call('POST', '/api/auth/logout', { headers: { Cookie: cookieB } });
  assert.equal(logout.status, 200, logout.text);
  const afterLogout = db.prepare('SELECT revoked_at, revocation_reason FROM device_sessions WHERE id = ?').get(active[0].id);
  assert.ok(afterLogout.revoked_at, 'the session row is revoked');
  assert.equal(afterLogout.revocation_reason, 'logout');
  const deadB = await referral(cookieB);
  assert.equal(deadB.status, 401, 'the revoked cookie no longer works');

  // (12) A fresh login afterwards is a completely normal login again.
  const again = await login(user);
  assert.equal(again.status, 200, again.text);
  assert.ok(!again.data.requiresDeviceVerification);
  assert.equal(activeSessions(user.id).length, 1);

  void tokenFromEmail; // token path is covered in its own test below
});

test('6: expired verification challenges are rejected', async () => {
  const user = createUser();
  const first = await login(user);
  assert.equal(first.status, 200, first.text);
  const second = await login(user);
  assert.equal(second.status, 202, second.text);

  const email = lastDeviceEmail();
  const code = extractCode(email);

  // Move the challenge's moment of truth into the past.
  db.prepare('UPDATE device_login_challenges SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), second.data.challengeId);

  const expired = await call('POST', '/api/auth/device-verify/code', {
    body: { challengeId: second.data.challengeId, code }
  });
  assert.equal(expired.status, 400, expired.text);
  assert.match(expired.data.message, /expired/i);
  assert.equal(activeSessions(user.id).length, 1, 'the original device is unchanged');
});

test('the magic link verifies and is single-use', async () => {
  const user = createUser();
  await login(user);
  const second = await login(user);
  assert.equal(second.status, 202, second.text);

  const emailHtmlToken = extractToken(lastDeviceEmail());
  const link = await call('POST', '/api/auth/device-verify/link', { body: { token: emailHtmlToken } });
  assert.equal(link.status, 200, link.text);
  cookiePair(link);

  const replay = await call('POST', '/api/auth/device-verify/link', { body: { token: emailHtmlToken } });
  assert.equal(replay.status, 400, 'the same magic link can never be used twice');
  assert.equal(activeSessions(user.id).length, 1);
});

test('5 & 14: max failed attempts burn the challenge', async () => {
  const user = createUser();
  await login(user);
  const second = await login(user);
  assert.equal(second.status, 202, second.text);
  const challengeId = second.data.challengeId;
  const realCode = extractCode(lastDeviceEmail());

  let wrong = '999999';
  if (wrong === realCode) wrong = '999998';
  for (let i = 0; i < 5; i += 1) {
    const res = await call('POST', '/api/auth/device-verify/code', {
      body: { challengeId, code: wrong }
    });
    if (i < 4) assert.equal(res.status, 400, `attempt ${i + 1}: ${res.text}`);
  }
  // The 5th wrong attempt burns the challenge with the shared budget message.
  const sixth = await call('POST', '/api/auth/device-verify/code', {
    body: { challengeId, code: wrong }
  });
  assert.equal(sixth.status, 429, sixth.text);
  // Even the CORRECT code no longer works once the challenge is burned.
  const correctTooLate = await call('POST', '/api/auth/device-verify/code', {
    body: { challengeId, code: realCode }
  });
  assert.equal(correctTooLate.status, 429, correctTooLate.text);
  assert.equal(correctTooLate.data.reason, 'too-many-attempts');
  assert.equal(activeSessions(user.id).length, 1);
});

test('14: verification emails are rate-limited per account', async () => {
  const user = createUser();
  await login(user); // active session on "device A"

  outbox = [];
  const challenge1 = await login(user);
  assert.equal(challenge1.status, 202);
  assert.equal(deviceEmails().length, 1, 'the first challenge emails once');

  // An immediate resend request is within the cooldown: acknowledged but no email.
  const resend1 = await call('POST', '/api/auth/device-verify/resend', {
    body: { challengeId: challenge1.data.challengeId }
  });
  assert.equal(resend1.status, 200, resend1.text);
  assert.equal(resend1.data.resent, false, 'the per-challenge cooldown blocks the resend');
  assert.equal(deviceEmails().length, 1);

  // Similar immediate challenges from other "devices" (no cookie) rotate the
  // challenge but cannot spam the inbox: the user-level cooldown holds.
  const challenge2 = await login(user);
  assert.equal(challenge2.status, 202);
  assert.equal(deviceEmails().length, 1, 'the user-level cooldown still holds');
  assert.equal(challenge2.data.emailSent, false);

  // Hourly ceiling: five emails in the last hour per account, then silence.
  const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  for (let i = 0; i < 4; i += 1) {
    db.prepare(`
      INSERT INTO device_login_challenges
        (id, user_id, pending_device_id, pending_device_label, code_hash, magic_token_hash,
         attempts, created_at, expires_at, email_sent_at, email_attempts, request_ip,
         used_at, used_reason, new_session_id, superseded_by)
      VALUES (?, ?, ?, 'x', 'h', ?, 0, ?, ?, ?, 1, NULL, ?, 'superseded', NULL, NULL)
    `).run(
      `crafted-${i}`, user.id, `pdev-${i}`, `mh-${i}`,
      past, past, past, past
    );
  }
  const challenge3 = await login(user);
  assert.equal(challenge3.status, 202);
  assert.equal(deviceEmails().length, 1, 'the hourly ceiling stops further mail');
  assert.equal(challenge3.data.emailSent, false);
});

test('13: concurrent logins and verifies can never produce two active sessions', async () => {
  // (a) Two simultaneous logins while NO session exists: one wins, one is challenged.
  const raceUser = createUser();
  const [r1, r2] = await Promise.all([login(raceUser), login(raceUser)]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 202], `one login wins, one is challenged (${statuses})`);
  assert.equal(activeSessions(raceUser.id).length, 1, 'exactly one active session emerged');

  // (b) Two simultaneous CHALLENGED logins (B and C) produce ONE live challenge.
  // The user-level email cooldown would rightly throttle the second of two
  // back-to-back challenged logins, so rewind the send timestamps between
  // the attempts to keep both emails observable for the token check below.
  const switchUser = createUser();
  const first = await login(switchUser);
  assert.equal(first.status, 200, first.text);
  const challengedB = await login(switchUser);
  assert.equal(challengedB.status, 202, challengedB.text);
  db.prepare('UPDATE device_login_challenges SET email_sent_at = ? WHERE user_id = ?')
    .run(new Date(Date.now() - 5 * 60 * 1000).toISOString(), switchUser.id);
  const challengedC = await login(switchUser);
  assert.equal(challengedC.status, 202, challengedC.text);
  assert.equal(openChallenges(switchUser.id).length, 1, 'only one pending verification survives');
  assert.equal(challengedC.data.emailSent, true, 'the live challenge has a real email');

  // (c) Two simultaneous verifications OF THE SAME challenge: one consumes it.
  const email = lastDeviceEmail();
  const token = extractToken(email);
  const [v1, v2] = await Promise.all([
    call('POST', '/api/auth/device-verify/link', { body: { token } }),
    call('POST', '/api/auth/device-verify/link', { body: { token } })
  ]);
  const verifyStatuses = [v1.status, v2.status].sort();
  assert.deepEqual(verifyStatuses, [200, 400], 'the magic link is consumable exactly once');
  assert.deepEqual(
    db.prepare('SELECT COUNT(*) AS n FROM device_sessions WHERE user_id = ? AND revoked_at IS NULL').get(switchUser.id).n,
    1,
    'the account still has exactly one active session'
  );
});

test('15: admin and content admin accounts are exempt from the single-device rule', async () => {
  const admin = createUser({ role: 'admin' });
  const publisher = createUser({ role: 'content_admin' });

  for (const user of [admin, publisher]) {
    const headers = { 'X-Forwarded-For': userIp(user) };
    const first = await call('POST', '/api/auth/login', {
      body: { email: user.email, password: 'regression-password' },
      headers
    });
    assert.equal(first.status, 200, first.text);
    // A second login WITHOUT the cookie would be challenged for a student.
    // For staff accounts it is a completely normal login.
    const second = await call('POST', '/api/auth/login', {
      body: { email: user.email, password: 'regression-password' },
      headers
    });
    assert.equal(second.status, 200, second.text);
    assert.ok(!second.data.requiresDeviceVerification, `${user.role} never gets the device challenge`);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM device_sessions WHERE user_id = ?').get(user.id).n,
      0,
      `${user.role} never gets device_sessions rows`
    );
  }
});

test('legacy cookies without a server-side session die on first use', async () => {
  const user = createUser();
  // Directly signed JWT: exactly what pre-feature StudyCore held in cookies.
  const legacyCookie = `${COOKIE_NAME}=${createToken(user)}`;
  const res = await referral(legacyCookie);
  assert.equal(res.status, 401, res.text);
  assert.equal(res.data.code, 'SESSION_REVOKED');
  assert.equal(res.data.reason, 'session-expired');
  // After a real login, the same token is still dead: it was never bound.
  await login(user);
  const res2 = await referral(legacyCookie);
  assert.equal(res2.status, 401, res2.text);
});

test('the admin security audit endpoint is admin-only and redacted', async () => {
  const student = createUser();
  const admin = createUser({ role: 'admin' });

  // Seed a device switch so the timeline has content, keeping the winning cookie.
  await login(student);
  await login(student);
  const email = lastDeviceEmail();
  const verify = await call('POST', '/api/auth/device-verify/code', {
    body: { challengeId: db.prepare('SELECT id FROM device_login_challenges WHERE user_id = ? AND used_at IS NULL').get(student.id).id, code: extractCode(email) }
  });
  assert.equal(verify.status, 200, verify.text);
  const liveStudentCookie = cookiePair(verify);

  const asStudent = await call('GET', '/api/admin/device-security', { user: student });
  assert.equal(asStudent.status, 403, asStudent.text);

  const asAdmin = await call('GET', '/api/admin/device-security', { user: admin });
  assert.equal(asAdmin.status, 200, asAdmin.text);
  assert.ok(typeof asAdmin.data.activeSessions === 'number');
  const events = asAdmin.data.events.filter((e) => e.user_id === student.id);
  assert.ok(events.some((e) => e.kind === 'session'), 'session creation events are visible');
  assert.ok(events.some((e) => e.kind === 'challenge'), 'verification attempts are visible');
  const serialized = JSON.stringify(asAdmin.data);
  assert.ok(!/[a-f0-9]{64}/.test(serialized), 'no token/code hashes ever appear');

  const detail = await call('GET', `/api/admin/device-security/${student.id}`, { user: admin });
  assert.equal(detail.status, 200, detail.text);
  assert.ok(detail.data.sessions.length >= 2, 'the per-student timeline lists the old and new sessions');

  // Force-revoke: the student's current cookie dies immediately.
  const revoke = await call('POST', `/api/admin/device-security/${student.id}/revoke`, { user: admin });
  assert.equal(revoke.status, 200, revoke.text);
  const after = await referral(liveStudentCookie);
  assert.equal(after.status, 401, 'admin revocation takes effect on the next request');
  // Non-student targets are rejected politely.
  const nonsense = await call('POST', `/api/admin/device-security/${admin.id}/revoke`, { user: admin });
  assert.equal(nonsense.status, 400, nonsense.text);
});

test('database state only ever holds hashes and redacted locations', async () => {
  const user = createUser();
  await login(user);
  await login(user);

  const challenges = db.prepare('SELECT * FROM device_login_challenges WHERE user_id = ?').all(user.id);
  assert.ok(challenges.length >= 1);
  for (const row of challenges) {
    assert.match(row.code_hash, /^[a-f0-9]{64}$/);
    assert.match(row.magic_token_hash, /^[a-f0-9]{64}$/);
    assert.ok(!row.request_ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(row.request_ip), 'no full IP addresses are stored');
  }
  const sessions = db.prepare('SELECT * FROM device_sessions WHERE user_id = ?').all(user.id);
  for (const row of sessions) {
    assert.match(row.session_token_hash, /^[a-f0-9]{64}$/, 'the JWT itself is never stored');
  }
});
