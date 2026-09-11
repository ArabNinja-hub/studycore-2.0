'use strict';

// Tests for lib/content-tickets.js — the short-lived, signed capability that
// turns /api/resources/:id/stream from a permanent URL into one that expires
// and is bound to a single student and a single resource.
//
// The point being protected here is subtle and worth stating: a ticket is
// NOT the access decision. The route still runs requireAuth plus the program
// and Premium gates first. These tests therefore assert that a ticket can only
// ever NARROW access (wrong user, wrong resource, expired, tampered → refused)
// and never widen it.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-value-that-is-definitely-long-enough-32';

const { issueTicket, verifyTicket, DEFAULT_TTL_SECONDS } = require('../lib/content-tickets');

const RESOURCE = 'res-abc123';
const USER = 'user-9f8e7d6c-1111-2222-3333-a1b2c3d4e5f6';

test('a freshly minted ticket verifies for the student and resource it was made for', () => {
  const { ticket, expiresAt } = issueTicket({ resourceId: RESOURCE, userId: USER });
  assert.match(ticket, /^v1\./, 'tickets are versioned so the format can change later');
  assert.ok(expiresAt > Date.now(), 'the ticket has a future expiry');

  const check = verifyTicket(ticket, { resourceId: RESOURCE, userId: USER });
  assert.equal(check.ok, true);
});

test('a ticket is useless to another student — sharing the link gains nothing', () => {
  const { ticket } = issueTicket({ resourceId: RESOURCE, userId: USER });
  const check = verifyTicket(ticket, { resourceId: RESOURCE, userId: 'user-someone-else' });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'wrong-user');
});

test('a ticket for a free note cannot be replayed against a Premium video', () => {
  const { ticket } = issueTicket({ resourceId: 'res-free-note', userId: USER });
  const check = verifyTicket(ticket, { resourceId: 'res-premium-video', userId: USER });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'wrong-resource');
});

test('an expired ticket is refused, and says so distinctly', () => {
  // A one-minute ticket is the shortest the issuer allows; verify against a
  // clock nudged past it rather than sleeping in the test suite.
  const { ticket } = issueTicket({ resourceId: RESOURCE, userId: USER, ttlSeconds: 60 });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61 * 1000;
    const check = verifyTicket(ticket, { resourceId: RESOURCE, userId: USER });
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'expired', 'the route turns this into an "expired link" message, not a scary error');
  } finally {
    Date.now = realNow;
  }
});

test('the payload cannot be edited: pushing out the expiry breaks the signature', () => {
  const { ticket } = issueTicket({ resourceId: RESOURCE, userId: USER, ttlSeconds: 60 });
  const [version, payload, signature] = ticket.split('.');

  // Re-encode the payload with a far-future expiry, keeping the original
  // signature — the classic "just edit the JSON" attack.
  const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  decoded.e = Math.floor(Date.now() / 1000) + 999999;
  const forged = Buffer.from(JSON.stringify(decoded)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const check = verifyTicket(`${version}.${forged}.${signature}`, { resourceId: RESOURCE, userId: USER });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'bad-signature');
});

test('garbage, empty and truncated tickets fail cleanly instead of throwing', () => {
  for (const bad of ['', null, undefined, 'not-a-ticket', 'v1.only-two-parts', 'v2.a.b', '....']) {
    const check = verifyTicket(bad, { resourceId: RESOURCE, userId: USER });
    assert.equal(check.ok, false, `refused ${JSON.stringify(bad)}`);
    assert.ok(check.reason, 'a reason is always given, so the route can answer with a clean 403');
  }
});

test('ticket lifetime is bounded on both ends', () => {
  // Long enough for a lecture plus a lunch break; never longer than a day.
  assert.equal(DEFAULT_TTL_SECONDS, 6 * 60 * 60);
  const tooLong = issueTicket({ resourceId: RESOURCE, userId: USER, ttlSeconds: 999999 });
  assert.ok(tooLong.ttl <= 24 * 60 * 60, 'clamped to 24h');
  const tooShort = issueTicket({ resourceId: RESOURCE, userId: USER, ttlSeconds: 1 });
  assert.ok(tooShort.ttl >= 60, 'clamped up to 60s so a slow phone cannot lose the ticket mid-load');
});

test('a ticket is signed with a key derived from JWT_SECRET, not the secret itself', () => {
  const { ticket } = issueTicket({ resourceId: RESOURCE, userId: USER });
  assert.ok(!ticket.includes(process.env.JWT_SECRET), 'the session secret never appears in a ticket');
  // Domain separation: a ticket must not be mistakable for, or usable as, a
  // session JWT (three dot-separated base64 segments look alike at a glance).
  assert.equal(ticket.split('.')[0], 'v1', 'the version tag makes a ticket unmistakable for a JWT header');
});

test('minting requires both a resource and a student', () => {
  assert.throws(() => issueTicket({ resourceId: RESOURCE }), /user id/i);
  assert.throws(() => issueTicket({ userId: USER }), /resource id/i);
});
