// =============================================================================
// StudyCore — short-lived signed tickets for protected resource bytes
// -----------------------------------------------------------------------------
// WHY THIS EXISTS
//
// `/api/resources/:id/stream` was already session-gated (requireAuth + program
// visibility + Premium gating), so it was never guessable by an anonymous
// visitor. What it WAS, though, is a *permanent* URL: once a student had it,
// that exact string kept working for the whole 7-day session lifetime, and it
// looked like an ordinary file link that could be pasted anywhere.
//
// A ticket turns it into a short-lived, single-student, single-resource
// capability:
//
//   * bound to the resource id  — a ticket for a free note cannot be replayed
//     against a Premium video;
//   * bound to the user id      — a ticket pasted into a group chat is refused
//     for everyone except the account it was minted for (and that account
//     could have opened the lesson anyway, so nothing is gained by sharing);
//   * bound to a wall-clock expiry — it stops working, unlike a session cookie
//     that lives for a week;
//   * HMAC-signed with a key derived from JWT_SECRET, so the payload cannot be
//     edited (swap the resource id, push out the expiry) without detection.
//
// It is deliberately an ADDITIONAL factor, never a replacement: the stream
// route still runs requireAuth and the program/Premium gate first. A valid
// ticket for a resource the student is no longer allowed to see is still
// refused, because authorization is re-evaluated on every single request. In
// other words this is defence in depth, not a bearer token that grants access
// on its own.
// =============================================================================

'use strict';

const crypto = require('crypto');

// Derived rather than reused verbatim so a ticket signature can never be
// confused with (or used to attack) a session JWT signed with the same secret.
// HKDF-style domain separation via a labelled SHA-256.
function signingKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('FATAL: JWT_SECRET must be set to issue content tickets.');
  }
  return crypto.createHash('sha256').update(`studycore:content-ticket:v1:${secret}`).digest();
}

// Six hours. Long enough that a student can leave a 90-minute lecture open,
// pause for lunch and come back to it without the video dying mid-seek — and
// short enough that a copied URL is worthless by tomorrow. The session cookie
// (7 days) remains the outer bound.
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', signingKey()).update(payloadB64).digest());
}

/**
 * Mint a ticket for one student and one resource.
 * @returns {{ ticket: string, expiresAt: number, ttl: number }}
 */
function issueTicket({ resourceId, userId, ttlSeconds }) {
  if (!resourceId || !userId) throw new Error('A content ticket needs both a resource id and a user id.');
  const ttl = Math.min(Math.max(Number(ttlSeconds) || DEFAULT_TTL_SECONDS, 60), 24 * 60 * 60);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = b64url(JSON.stringify({ r: String(resourceId), u: String(userId), e: exp }));
  return {
    ticket: `v1.${payload}.${sign(payload)}`,
    expiresAt: exp * 1000,
    ttl
  };
}

/**
 * Verify a ticket against the resource and student actually making the
 * request. Returns { ok: true } or { ok: false, reason } — never throws, so a
 * malformed ticket produces a clean 403 instead of a 500.
 */
function verifyTicket(ticket, { resourceId, userId }) {
  const raw = String(ticket || '');
  if (!raw) return { ok: false, reason: 'missing' };

  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };
  const [, payloadB64, signature] = parts;

  // Constant-time comparison: a byte-by-byte early exit would leak the
  // expected signature to a patient attacker.
  let expected;
  try {
    expected = sign(payloadB64);
  } catch {
    return { ok: false, reason: 'unconfigured' };
  }
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };

  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'malformed' };
  if (String(payload.r) !== String(resourceId)) return { ok: false, reason: 'wrong-resource' };
  if (String(payload.u) !== String(userId)) return { ok: false, reason: 'wrong-user' };
  if (!Number.isFinite(Number(payload.e)) || Number(payload.e) * 1000 <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, expiresAt: Number(payload.e) * 1000 };
}

module.exports = { issueTicket, verifyTicket, DEFAULT_TTL_SECONDS };
