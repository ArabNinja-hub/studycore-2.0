'use strict';

// =============================================================================
// StudyCore — single-active-device session service
// -----------------------------------------------------------------------------
// WHAT THIS ENFORCES
//
// One STUDENT account = ONE active device/session at any moment.
//
// Two tables back that rule (created in db/index.js):
//
//   device_sessions
//     One row per login session. The token hash is bound to the JWT value
//     itself, so a copied JWT is useless the moment the real owner logs in
//     again (the active row no longer matches its hash) and a server-side
//     revocation is effective immediately - deleting the cookie client-side
//     is NOT the revocation mechanism. The partial UNIQUE index on
//     (user_id) WHERE revoked_at IS NULL is the hard backstop: no code path,
//     race, or crash can ever leave two live rows for one student.
//
//   device_login_challenges
//     A second device attempting to log in does NOT replace the current
//     session. It creates a pending challenge - a 6-digit code AND a one-time
//     magic link, both single-use, both expiring within 10 minutes, both
//     stored only as SHA-256 hashes. The new device only becomes active
//     after the student proves access to the registered email address.
//
// CONCURRENCY & RACE DESIGN
//
// Login and verification both do check-then-act over several rows (revoke old
// session, insert new session, consume challenge). They run inside
// `BEGIN IMMEDIATE` transactions: the writer locks at the first statement, a
// second writer queues on SQLite's busy_timeout, and on entering finds the
// final state left by the first. Two simultaneous logins therefore collapse
// into "winner logs in, loser starts an email challenge" - the single-session
// rule can never be raced around. The partial UNIQUE index catches anything
// the transaction story ever misses.
//
// DEVICE IDENTITY
//
// A "device" is a server-side generated random identifier per login, never
// an IP address, User-Agent value, fingerprint, or cookie. The short label
// ("Chrome on Android phone") and the two-octet IP hint exist ONLY so an
// administrator reading the security timeline can say "the phone signed out
// the laptop" - they cannot reconstruct or track an individual.
//
// LOGGING
//
// Sessions, device ids, token hashes, codes, and magic tokens are never
// printed here. The only observability is the device_sessions /
// device_login_challenges rows themselves, which redact everything sensitive.
// =============================================================================

const crypto = require('crypto');
const db = require('../db');

// ---------------------------------------------------------------------------
// Lifetimes and budgets
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;        // matches the JWT lifetime
const CHALLENGE_TTL_MS = 10 * 60 * 1000;               // 10 minutes to verify
const EMAIL_RESEND_COOLDOWN_MS = 60 * 1000;            // gap between verification emails
const EMAIL_MAX_PER_CHALLENGE = 5;                     // resends of one challenge
const EMAIL_MAX_PER_USER_PER_HOUR = 5;                 // user-level spam ceiling
const CHALLENGE_MAX_ATTEMPTS = 5;                      // 6-digit brute-force budget

const REVOKED = {
  LOGOUT: 'logout',
  SWITCHED: 'switched-device',
  EXPIRED: 'expired',
  ADMIN: 'admin-force-logout'
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function now() { return Date.now(); }
function iso(ms) { return new Date(ms).toISOString(); }
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

function hashesEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

// Six-digit, zero-padded, unbiased: rejection-samples around the 2^32 / 1e6
// remainder instead of applying a raw modulus.
function generateCode() {
  const LIMIT = 1000000;
  const MAX_SAFE = 4294967296 - (4294967296 % LIMIT);
  let n;
  do { n = crypto.randomBytes(4).readUInt32BE(0); } while (n >= MAX_SAFE);
  return String(n % LIMIT).padStart(6, '0');
}

// 48 random bytes -> 96 hex characters. Used inside the magic link only;
// never stored in plaintext.
function generateMagicToken() {
  return crypto.randomBytes(48).toString('hex');
}

// Derive a short, non-identifying label from the User-Agent header. Nearby
// browsers collapse to the same handful of labels by design - this is for a
// human-readable admin timeline, not for identification.
function deviceLabelFromUserAgent(userAgent) {
  const raw = String(userAgent || '').trim();
  if (!raw) return 'Unknown device';
  const ua = raw.slice(0, 200); // hard cap before any work

  let browserName = 'Browser';
  if (/Edg(e|A|iOS)?\//i.test(ua)) browserName = 'Microsoft Edge';
  else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) browserName = 'Opera';
  else if (/Chromium/i.test(ua)) browserName = 'Chromium';
  else if (/Chrome\//i.test(ua)) browserName = 'Chrome';
  else if (/Firefox\//i.test(ua)) browserName = 'Firefox';
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) browserName = 'Safari';

  let device = 'Unknown device';
  if (/iPhone/i.test(ua)) device = 'iPhone';
  else if (/iPad/i.test(ua)) device = 'iPad';
  else if (/Android/i.test(ua) && /Mobile/i.test(ua)) device = 'Android phone';
  else if (/Android/i.test(ua)) device = 'Android tablet';
  else if (/Macintosh|Mac OS X/i.test(ua)) device = 'Mac';
  else if (/Windows NT/i.test(ua)) device = 'Windows PC';
  else if (/Linux/i.test(ua)) device = 'Linux PC';

  return `${browserName} on ${device}`.slice(0, 80);
}

function ipHint(ip) {
  // Coarse prefix only: enough to tell "roughly the same network" apart for
  // the admin timeline, nowhere near enough to identify or track anyone.
  const value = String(ip || '').trim();
  if (!value || value === 'unknown') return null;
  if (value.startsWith('::ffff:')) {
    return ipHint(value.slice(7));
  }
  if (value.includes(':')) { // IPv6 — keep just the leading group
    return (value.split(':')[0] || 'ipv6').slice(0, 16);
  }
  const octets = value.split('.');
  if (octets.length === 4) return `${octets[0]}.${octets[1]}`.slice(0, 16);
  return null;
}

function tokenPlaceholder(sessionId) {
  // Placeholder stored between session-row creation and JWT signing (the JWT
  // needs the session id first). Randomly anchored so it can never collide
  // with the hash of a real token.
  return hash(`pre-jwt:${sessionId}:${crypto.randomBytes(16).toString('hex')}`);
}

// ---------------------------------------------------------------------------
// Session reads
// ---------------------------------------------------------------------------

/**
 * The currently active session row for a user, or null. Expired rows are
 * lazily revoked in place so the timeline keeps them.
 */
function getActiveSession(userId) {
  const row = db.prepare(`
    SELECT * FROM device_sessions
    WHERE user_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= now()) {
    const ts = iso(now());
    db.prepare(`
      UPDATE device_sessions
      SET revoked_at = @ts, revocation_reason = @reason
      WHERE id = @id AND revoked_at IS NULL
    `).run({ id: row.id, ts, reason: REVOKED.EXPIRED });
    return null;
  }
  return row;
}

/**
 * The most recent session row for a user regardless of state — used only to
 * explain WHY a stale request was rejected (switched device / signed out).
 */
function getLatestSession(userId) {
  return db.prepare(`
    SELECT * FROM device_sessions
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId) || null;
}

function getSessionById(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  return db.prepare('SELECT * FROM device_sessions WHERE id = ?').get(sessionId) || null;
}

// ---------------------------------------------------------------------------
// The request gate — runs on EVERY authenticated student request
// ---------------------------------------------------------------------------

/**
 * Decide whether the token presented on this request still maps to the
 * authoritative server-side session.
 *
 * Returns:
 *   { ok: true,  sessionId }
 *   { ok: false, reason, message }
 *
 * Messages are user-facing and deliberately generic except for the
 * "signed in on another device" case, which the product requires to be
 * explicit so the student understands what happened.
 */
function checkRequestSession(userId, rawToken) {
  const tokenHash = hash(rawToken || '');
  // Map the presented token to ITS row, not just to "the active one": after
  // a device switch the old device still holds the old token, and the
  // rejection message must name what actually happened to that session.
  const own = db.prepare(`
    SELECT * FROM device_sessions
    WHERE user_id = ? AND session_token_hash = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId, tokenHash);

  if (own) {
    if (!own.revoked_at && new Date(own.expires_at).getTime() > now()) {
      // Sliding last_seen only. expires_at stays anchored to the login
      // moment (7 days), matching the pre-existing cookie semantics; a
      // fresh login is what refreshes the window.
      db.prepare(`
        UPDATE device_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL
      `).run(iso(now()), own.id);
      return { ok: true, sessionId: own.id };
    }
    if (own.revocation_reason === REVOKED.SWITCHED) {
      return {
        ok: false,
        reason: 'signed-in-elsewhere',
        message: 'Your StudyCore account was signed in on another device.'
      };
    }
    if (own.revocation_reason === REVOKED.LOGOUT) {
      return {
        ok: false,
        reason: 'signed-out',
        message: 'You were signed out. Please log in again.'
      };
    }
    return {
      ok: false,
      reason: 'session-expired',
      message: 'Your session has expired. Please log in again.'
    };
  }

  // The token does not match ANY of this account's session rows: a legacy
  // pre-feature cookie, or a fabricated value. The message stays generic so
  // the response cannot be used to probe session state.
  return {
    ok: false,
    reason: 'session-expired',
    message: 'Your session has expired. Please log in again.'
  };
}

// ---------------------------------------------------------------------------
// Session writes
// ---------------------------------------------------------------------------

/**
 * Bind the just-signed JWT to its session row (hash of the token value), and
 * start the token's 7-day window. Any previously issued cookie for this
 * session stops being valid the moment this lands.
 */
function bindSessionToJwt(sessionId, rawToken) {
  db.prepare(`
    UPDATE device_sessions
    SET session_token_hash = @h, last_seen_at = @ts, expires_at = @expiresAt
    WHERE id = @id AND revoked_at IS NULL
  `).run({
    id: sessionId,
    h: hash(rawToken),
    ts: iso(now()),
    expiresAt: iso(now() + SESSION_TTL_MS)
  });
}

/**
 * Revoke one session row (normal logout path).
 */
function revokeSession(sessionId, reason) {
  const ts = iso(now());
  db.prepare(`
    UPDATE device_sessions
    SET revoked_at = @ts, revocation_reason = @reason
    WHERE id = @id AND revoked_at IS NULL
  `).run({ id: sessionId, ts, reason: reason || REVOKED.LOGOUT });
}

/**
 * Revoke every active session for a user (logout, switch, admin force).
 */
function revokeAllUserSessions(userId, reason) {
  const ts = iso(now());
  db.prepare(`
    UPDATE device_sessions
    SET revoked_at = @ts, revocation_reason = @reason
    WHERE user_id = @userId AND revoked_at IS NULL
  `).run({ userId, ts, reason: reason || REVOKED.LOGOUT });
}

/**
 * Mint a fresh active session regardless of prior state: revokes anything
 * active, inserts a new row, returns { sessionId }. Used by administrators
 * signing a student out and by the test harness - the interactive login and
 * verification flows use loginOrChallenge()/verify* below instead.
 */
function forceCreateSession(userId, { userAgent, ip } = {}) {
  let inTransaction = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    revokeAllUserSessions(userId, REVOKED.ADMIN);
    const sessionId = crypto.randomUUID();
    const createdAt = now();
    db.prepare(`
      INSERT INTO device_sessions
        (id, user_id, device_id, device_label, ip_hint, session_token_hash,
         created_at, last_seen_at, expires_at, revoked_at, revocation_reason)
      VALUES
        (@id, @userId, @deviceId, @deviceLabel, @ipHint, @tokenHash,
         @createdAt, @lastSeenAt, @expiresAt, NULL, NULL)
    `).run({
      id: sessionId,
      userId,
      deviceId: crypto.randomUUID(),
      deviceLabel: deviceLabelFromUserAgent(userAgent),
      ipHint: ipHint(ip),
      tokenHash: tokenPlaceholder(sessionId),
      createdAt: iso(createdAt),
      lastSeenAt: iso(createdAt),
      expiresAt: iso(createdAt + SESSION_TTL_MS)
    });
    db.exec('COMMIT');
    inTransaction = false;
    return { sessionId };
  } catch (err) {
    if (inTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* nothing to undo */ }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Login: create the session, or start an email-verification challenge
// ---------------------------------------------------------------------------

/**
 * Insert a fresh pending challenge under the caller's write transaction,
 * superseding any still-open challenge so exactly ONE is live per account.
 * Returns the plaintext proofs - the caller must deliver them by email and
 * must never persist or log them (only their hashes exist in the row).
 */
function insertChallengeSupersedingOpen(userId, label, requestIp) {
  const challengeId = crypto.randomUUID();
  const startedAt = now();

  db.prepare(`
    UPDATE device_login_challenges
    SET superseded_by = @newId, used_at = @ts, used_reason = 'superseded'
    WHERE user_id = @userId AND used_at IS NULL
  `).run({ userId, newId: challengeId, ts: iso(startedAt) });

  const code = generateCode();
  const magicToken = generateMagicToken();
  const expiresAtMs = startedAt + CHALLENGE_TTL_MS;

  db.prepare(`
    INSERT INTO device_login_challenges
      (id, user_id, pending_device_id, pending_device_label,
       code_hash, magic_token_hash, attempts, created_at, expires_at,
       email_sent_at, email_attempts, request_ip,
       used_at, used_reason, new_session_id, superseded_by)
    VALUES
      (@id, @userId, @deviceId, @deviceLabel,
       @codeHash, @magicHash, 0, @createdAt, @expiresAt,
       NULL, 0, @requestIp,
       NULL, NULL, NULL, NULL)
  `).run({
    id: challengeId,
    userId,
    deviceId: crypto.randomUUID(),
    deviceLabel: label,
    codeHash: hash(code),
    magicHash: hash(magicToken),
    createdAt: iso(startedAt),
    expiresAt: iso(expiresAtMs),
    requestIp: ipHint(requestIp)
  });

  return { id: challengeId, code, magicToken, expiresAtMs, deviceLabel: label };
}

/**
 * Called after the password has been verified.
 *
 *   no active session -> { action: 'login', sessionId }
 *   active session    -> { action: 'challenge', challenge }
 *                        (existing device is left completely untouched)
 */
function loginOrChallenge(userId, userAgent, ip) {
  const label = deviceLabelFromUserAgent(userAgent);
  const startedAt = now();

  let inTransaction = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;

    // The only check that matters: under the write lock. A simultaneous
    // login waits at BEGIN IMMEDIATE and then sees the session the first
    // request just created.
    let active = getActiveSession(userId);

    if (!active) {
      const sessionId = crypto.randomUUID();
      const insert = db.prepare(`
        INSERT INTO device_sessions
          (id, user_id, device_id, device_label, ip_hint, session_token_hash,
           created_at, last_seen_at, expires_at, revoked_at, revocation_reason)
        VALUES
          (@id, @userId, @deviceId, @deviceLabel, @ipHint, @tokenHash,
           @createdAt, @lastSeenAt, @expiresAt, NULL, NULL)
        ON CONFLICT(user_id) WHERE revoked_at IS NULL DO NOTHING
      `).run({
        id: sessionId,
        userId,
        deviceId: crypto.randomUUID(),
        deviceLabel: label,
        ipHint: ipHint(ip),
        tokenHash: tokenPlaceholder(sessionId),
        createdAt: iso(startedAt),
        lastSeenAt: iso(startedAt),
        expiresAt: iso(startedAt + SESSION_TTL_MS)
      });
      if (insert.changes) {
        db.exec('COMMIT');
        inTransaction = false;
        return { action: 'login', sessionId };
      }
      // A competing transaction committed a session between pre-check and
      // insert. Re-read and fall through to the challenge path.
      active = getActiveSession(userId);
    }

    // Active session exists -> pending challenge. The current device stays
    // signed in until the student verifies from the registered email; only
    // one challenge per account is ever open at a time.
    const challenge = insertChallengeSupersedingOpen(userId, label, ip);

    db.exec('COMMIT');
    inTransaction = false;

    return {
      action: 'challenge',
      challenge: {
        ...challenge,
        currentDeviceLabel: active ? active.device_label : null
      }
    };
  } catch (err) {
    if (inTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* nothing to undo */ }
    }
    throw err;
  }
}

/**
 * Mint a replacement challenge for a resend request. Unlike
 * loginOrChallenge this NEVER creates a session: if the active session is
 * gone (expired meanwhile) there is nothing left to supersede, so it returns
 * null and the student simply logs in again. The old challenge is superseded
 * so only the freshest email can ever complete the switch.
 */
function rotateChallengeForUser(userId, userAgent, ip) {
  const label = deviceLabelFromUserAgent(userAgent);
  let inTransaction = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    const active = getActiveSession(userId);
    if (!active) {
      db.exec('ROLLBACK');
      inTransaction = false;
      return null;
    }
    const challenge = insertChallengeSupersedingOpen(userId, label, ip);
    db.exec('COMMIT');
    inTransaction = false;
    return { ...challenge, currentDeviceLabel: active.device_label };
  } catch (err) {
    if (inTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* nothing to undo */ }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Challenge reads
// ---------------------------------------------------------------------------

function getChallengeById(challengeId) {
  if (!challengeId || typeof challengeId !== 'string') return null;
  return db.prepare('SELECT * FROM device_login_challenges WHERE id = ?').get(challengeId) || null;
}

function getChallengeByMagicToken(magicToken) {
  if (!magicToken || typeof magicToken !== 'string') return null;
  return db.prepare('SELECT * FROM device_login_challenges WHERE magic_token_hash = ?')
    .get(hash(magicToken)) || null;
}

// ---------------------------------------------------------------------------
// Email throttling (server-side; protects the student's inbox)
// ---------------------------------------------------------------------------

/**
 * Whether a verification email may be sent for this user right now:
 * a cooldown since the most recent send, plus a per-user hourly ceiling.
 */
function emailDispatchAllowed(userId) {
  const latestSent = db.prepare(`
    SELECT MAX(email_sent_at) AS latest FROM device_login_challenges WHERE user_id = ?
  `).get(userId);
  if (latestSent && latestSent.latest) {
    const last = new Date(latestSent.latest).getTime();
    if (last + EMAIL_RESEND_COOLDOWN_MS > now()) return { allowed: false, reason: 'cooldown' };
  }
  const hourly = db.prepare(`
    SELECT COUNT(*) AS n FROM device_login_challenges
    WHERE user_id = ? AND email_sent_at IS NOT NULL AND email_sent_at > ?
  `).get(userId, iso(now() - 60 * 60 * 1000));
  if (hourly.n >= EMAIL_MAX_PER_USER_PER_HOUR) return { allowed: false, reason: 'hourly-cap' };
  return { allowed: true };
}

/**
 * Whether this particular challenge may be re-emailed. The shared counter
 * lives on the challenge row so the budget survives restarts.
 */
function canResendChallenge(challenge) {
  if (!challenge || challenge.used_at || challenge.superseded_by) return false;
  if (new Date(challenge.expires_at).getTime() <= now()) return false;
  if ((Number(challenge.email_attempts) || 0) >= EMAIL_MAX_PER_CHALLENGE) return false;
  if (!challenge.email_sent_at) return true;
  return new Date(challenge.email_sent_at).getTime() + EMAIL_RESEND_COOLDOWN_MS <= now();
}

/**
 * Record that a verification email was actually handed to the transport.
 */
function markChallengeEmailed(challengeId) {
  db.prepare(`
    UPDATE device_login_challenges
    SET email_sent_at = @ts, email_attempts = email_attempts + 1
    WHERE id = @id
  `).run({ id: challengeId, ts: iso(now()) });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const VERIFY_OK = 'verified';

function classifyChallengeState(challenge) {
  if (!challenge) return 'unknown';
  if (challenge.used_at || challenge.used_reason) return challenge.used_reason || 'consumed';
  if (challenge.superseded_by) return 'superseded';
  if (new Date(challenge.expires_at).getTime() <= now()) return 'expired';
  if (challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) return 'too-many-attempts';
  return 'pending';
}

/**
 * Burn a challenge without a session swap: expired, exhaustion, misuse.
 */
function burnChallenge(challengeId, reason) {
  const ts = iso(now());
  db.prepare(`
    UPDATE device_login_challenges
    SET used_at = @ts, used_reason = @reason
    WHERE id = @id AND used_at IS NULL
  `).run({ id: challengeId, ts, reason });
}

/**
 * Shared failure path for a wrong proof: bump the attempt counter, burn at
 * the budget, and report back why.
 */
function recordFailedAttempt(challenge) {
  db.prepare('UPDATE device_login_challenges SET attempts = attempts + 1 WHERE id = ?').run(challenge.id);
  const res = db.prepare('SELECT attempts FROM device_login_challenges WHERE id = ?').get(challenge.id);
  if (res && res.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    burnChallenge(challenge.id, 'too-many-attempts');
    return { ok: false, reason: 'too-many-attempts' };
  }
  return { ok: false, reason: 'wrong-proof' };
}

/**
 * Atomically: revoke every other active session, activate the new one, and
 * consume the challenge. Runs under BEGIN IMMEDIATE so a verify can never
 * race a fresh login or a second verify for the same account.
 */
function finalizeChallengeSwap(challenge) {
  let inTransaction = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;

    // Re-read under the lock: a concurrent verify of the same challenge may
    // already have consumed it while this request queued.
    const open = db.prepare(`
      SELECT * FROM device_login_challenges
      WHERE id = @id AND used_at IS NULL AND superseded_by IS NULL AND expires_at > @now
    `).get({ id: challenge.id, now: iso(now()) });
    if (!open) {
      db.exec('ROLLBACK');
      inTransaction = false;
      return { ok: false, reason: 'consumed' };
    }

    const ts = iso(now());
    db.prepare(`
      UPDATE device_sessions
      SET revoked_at = @ts, revocation_reason = @reason
      WHERE user_id = @userId AND revoked_at IS NULL
    `).run({ userId: open.user_id, ts, reason: REVOKED.SWITCHED });

    const sessionId = crypto.randomUUID();
    const createdAt = now();
    db.prepare(`
      INSERT INTO device_sessions
        (id, user_id, device_id, device_label, ip_hint, session_token_hash,
         created_at, last_seen_at, expires_at, revoked_at, revocation_reason)
      VALUES
        (@id, @userId, @deviceId, @deviceLabel, @ipHint, @tokenHash,
         @createdAt, @lastSeenAt, @expiresAt, NULL, NULL)
    `).run({
      id: sessionId,
      userId: open.user_id,
      deviceId: open.pending_device_id,
      deviceLabel: open.pending_device_label,
      ipHint: open.request_ip,
      tokenHash: tokenPlaceholder(sessionId),
      createdAt: iso(createdAt),
      lastSeenAt: ts,
      expiresAt: iso(createdAt + SESSION_TTL_MS)
    });

    db.prepare(`
      UPDATE device_login_challenges
      SET used_at = @ts, used_reason = @verified, new_session_id = @sessionId
      WHERE id = @id AND used_at IS NULL
    `).run({ id: open.id, ts, verified: VERIFY_OK, sessionId });

    db.exec('COMMIT');
    inTransaction = false;
    return { ok: true, sessionId, userId: open.user_id };
  } catch (err) {
    if (inTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* nothing to undo */ }
    }
    throw err;
  }
}

/**
 * Verify with the 6-digit code typed into the new device.
 */
function verifyChallengeByCode(challengeId, code) {
  const challenge = getChallengeById(challengeId);
  const state = classifyChallengeState(challenge);
  if (state === 'expired') burnChallenge(challenge.id, 'expired');
  if (state !== 'pending') return { ok: false, reason: state };

  if (typeof code !== 'string') return { ok: false, reason: 'wrong-proof' };
  const supplied = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(supplied)) return recordFailedAttempt(challenge);
  if (!hashesEqual(hash(supplied), challenge.code_hash)) return recordFailedAttempt(challenge);
  return finalizeChallengeSwap(challenge);
}

/**
 * Verify with the magic token from the email link (already confirmed by a
 * human click on the verification page - GET requests never mutate state).
 */
function verifyChallengeByToken(magicToken) {
  const challenge = getChallengeByMagicToken(magicToken);
  const state = classifyChallengeState(challenge);
  if (state === 'expired') burnChallenge(challenge.id, 'expired');
  if (state !== 'pending') return { ok: false, reason: state };
  return finalizeChallengeSwap(challenge);
}

/**
 * Student changed their mind: stay signed in on the current device.
 */
function cancelChallenge(challengeId) {
  burnChallenge(challengeId, 'cancelled');
}

// ---------------------------------------------------------------------------
// Admin / audit read model (no secrets: hashes and raw locations stay out)
// ---------------------------------------------------------------------------
function sessionsForUser(userId, limit = 25) {
  return db.prepare(`
    SELECT id, device_id, device_label, ip_hint, created_at, last_seen_at,
           expires_at, revoked_at, revocation_reason
    FROM device_sessions
    WHERE user_id = @userId
    ORDER BY created_at DESC
    LIMIT @limit
  `).all({ userId, limit: Math.min(Math.max(Number(limit) || 25, 1), 100) });
}

function challengesForUser(userId, limit = 25) {
  return db.prepare(`
    SELECT id, pending_device_id, pending_device_label, request_ip, attempts,
           created_at, expires_at, email_sent_at, email_attempts,
           used_at, used_reason, new_session_id, superseded_by
    FROM device_login_challenges
    WHERE user_id = @userId
    ORDER BY created_at DESC
    LIMIT @limit
  `).all({ userId, limit: Math.min(Math.max(Number(limit) || 25, 1), 100) });
}

/**
 * Global admin feed: newest device events across every student, sessions and
 * challenges interleaved. Capped, redacted, and safe to render directly.
 */
function auditFeed(limit = 100) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db.prepare(`
    SELECT kind, ref_id, user_id, user_name, user_email, device_label, ip_hint,
           event_time, detail, outcome
    FROM (
      SELECT
        'session' AS kind,
        s.id AS ref_id,
        s.user_id AS user_id,
        u.name AS user_name,
        u.email AS user_email,
        s.device_label AS device_label,
        s.ip_hint AS ip_hint,
        s.created_at AS event_time,
        CASE
          WHEN s.revoked_at IS NULL AND s.expires_at > @now THEN 'active'
          WHEN s.revoked_at IS NULL THEN 'expired'
          ELSE 'revoked'
        END AS detail,
        COALESCE(s.revocation_reason,
          CASE WHEN s.revoked_at IS NULL AND s.expires_at > @now THEN 'active' ELSE 'ended' END
        ) AS outcome
      FROM device_sessions s
      JOIN users u ON u.id = s.user_id
      UNION ALL
      SELECT
        'challenge' AS kind,
        c.id AS ref_id,
        c.user_id AS user_id,
        u.name AS user_name,
        u.email AS user_email,
        c.pending_device_label AS device_label,
        c.request_ip AS ip_hint,
        c.created_at AS event_time,
        'attempts=' || c.attempts || ', emails=' || c.email_attempts AS detail,
        CASE
          WHEN c.used_reason IS NOT NULL THEN c.used_reason
          WHEN c.superseded_by IS NOT NULL THEN 'superseded'
          WHEN c.expires_at <= @now THEN 'expired'
          ELSE 'pending'
        END AS outcome
      FROM device_login_challenges c
      JOIN users u ON u.id = c.user_id
    )
    ORDER BY event_time DESC
    LIMIT @cap
  `).all({ now: iso(now()), cap });
}

// ---------------------------------------------------------------------------
// Periodic cleanup (server.js calls this at boot and hourly)
// ---------------------------------------------------------------------------
function purgeExpired() {
  const ts = iso(now());
  db.prepare(`
    UPDATE device_sessions
    SET revoked_at = @ts, revocation_reason = @reason
    WHERE revoked_at IS NULL AND expires_at <= @ts
  `).run({ ts, reason: REVOKED.EXPIRED });
  db.prepare(`
    UPDATE device_login_challenges
    SET used_at = @ts, used_reason = 'expired'
    WHERE used_at IS NULL AND expires_at <= @ts
  `).run({ ts });
}

module.exports = {
  SESSION_TTL_MS,
  CHALLENGE_TTL_MS,
  EMAIL_RESEND_COOLDOWN_MS,
  EMAIL_MAX_PER_CHALLENGE,
  EMAIL_MAX_PER_USER_PER_HOUR,
  CHALLENGE_MAX_ATTEMPTS,
  REVOKED,

  // request gate
  checkRequestSession,

  // reads
  getActiveSession,
  getLatestSession,
  getSessionById,
  getChallengeById,
  getChallengeByMagicToken,
  sessionsForUser,
  challengesForUser,
  auditFeed,

  // flows
  loginOrChallenge,
  rotateChallengeForUser,
  bindSessionToJwt,
  forceCreateSession,
  verifyChallengeByCode,
  verifyChallengeByToken,
  cancelChallenge,
  revokeSession,
  revokeAllUserSessions,

  // email throttling
  emailDispatchAllowed,
  canResendChallenge,
  markChallengeEmailed,

  // maintenance
  purgeExpired,

  // internals used by middleware/auth (hashing) and the regression suite.
  __internal: {
    hash,
    hashesEqual,
    generateCode,
    generateMagicToken,
    deviceLabelFromUserAgent,
    ipHint
  }
};
