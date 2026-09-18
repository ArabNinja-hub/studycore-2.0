'use strict';

// Resend transport for StudyCore.
//
// This is the ONLY module in the codebase that touches the Resend SDK or
// process.env.RESEND_API_KEY. Everything else in the app calls the named
// functions in lib/email/index.js, which come through here.
//
// Guarantees this module makes to the rest of StudyCore:
//
//   1. send() NEVER throws and NEVER rejects. It always resolves to a plain
//      result object. A Resend outage therefore cannot fail, roll back or
//      even slow down the database operation that triggered the email.
//   2. The API key is never logged, never returned, never attached to a
//      result object, and never leaves this file.
//   3. When RESEND_API_KEY is unset (local dev, automated tests, first boot)
//      nothing is sent: the message is logged in a compact, non-sensitive
//      form and reported as `simulated`, mirroring the existing behaviour of
//      lib/mailer.js and lib/storage.js.

const { Resend } = require('resend');
const { fromAddress, isResendConfigured } = require('./config');

// Emails are a side effect of a user-facing request (registering, approving
// a payment). They must never hold that request open for long.
const SEND_TIMEOUT_MS = 10_000;

// The client is created lazily and cached against the key actually in use,
// so a rotated key in the environment is picked up without a code change and
// tests can toggle configuration between cases.
let cachedClient = null;
let cachedKeyFingerprint = null;

// A short non-reversible fingerprint used ONLY to decide whether the cached
// client still matches the current environment. It is never logged.
function keyFingerprint(key) {
  return `${key.length}:${key.slice(0, 3)}`;
}

function getClient() {
  const key = String(process.env.RESEND_API_KEY || '').trim();
  if (!key) return null;
  const fingerprint = keyFingerprint(key);
  if (!cachedClient || cachedKeyFingerprint !== fingerprint) {
    cachedClient = new Resend(key);
    cachedKeyFingerprint = fingerprint;
  }
  return cachedClient;
}

// Test seam: lets the email test suite intercept dispatch without holding a
// real API key and without contacting the network. Production code never
// calls this - it is exercised only by scripts/test-emails.js.
let testOverride = null;
function __setTestSender(fn) {
  testOverride = typeof fn === 'function' ? fn : null;
}

/**
 * Masks an address for logs: "chipo.banda@gmail.com" -> "ch***@gmail.com".
 * Enough to confirm WHICH student a message went to during testing without
 * writing full personal addresses into the server log.
 */
function maskEmail(address) {
  const value = String(address || '').trim();
  const at = value.lastIndexOf('@');
  if (at < 1) return '(invalid address)';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}@${domain}`;
}

// Basic shape validation. The address always comes from the database, so
// this guards against a malformed legacy row rather than untrusted input.
function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

// Resend returns { data, error } rather than throwing for API-level errors.
// Normalise both that and a thrown network error into one safe string.
function describeError(error) {
  if (!error) return 'Unknown email error';
  if (typeof error === 'string') return error;
  const name = error.name ? `${error.name}: ` : '';
  return `${name}${error.message || 'Unknown email error'}`.slice(0, 300);
}

/**
 * Sends one transactional email through Resend.
 *
 * @param {object} message
 * @param {string} message.to        Recipient address (always read from the DB).
 * @param {string} message.subject   Subject line.
 * @param {string} message.html      Rendered HTML body.
 * @param {string} message.text      Plain-text alternative.
 * @param {string} message.kind      Short template id, used only for logging.
 * @param {string} [message.replyTo] Optional Reply-To address.
 *
 * @returns {Promise<{sent: boolean, id?: string, simulated?: boolean, skipped?: boolean, reason?: string, error?: string}>}
 *          Always resolves. Never throws.
 */
async function send({ to, subject, html, text, kind = 'email', replyTo }) {
  const recipient = String(to || '').trim();
  const label = kind;

  if (!isEmailAddress(recipient)) {
    console.error(`[email] ${label}: no valid recipient address on the account - nothing sent.`);
    return { sent: false, skipped: true, reason: 'invalid-recipient', error: 'No valid recipient address' };
  }

  const payload = {
    from: fromAddress(),
    to: [recipient],
    subject,
    html,
    text,
    ...(replyTo ? { replyTo } : {})
  };

  if (testOverride) {
    try {
      const result = await testOverride(payload, { kind: label });
      return result || { sent: true, id: 'test-override' };
    } catch (err) {
      return { sent: false, error: describeError(err) };
    }
  }

  if (!isResendConfigured()) {
    // Dev/test fallback: never fail the surrounding operation just because
    // mail is not set up. Log a one-line, non-sensitive summary.
    console.log(
      `[email] ${label}: RESEND_API_KEY is not set - email NOT sent (simulated). ` +
      `to=${maskEmail(recipient)} subject="${subject}"`
    );
    return { sent: false, simulated: true, reason: 'resend-not-configured' };
  }

  const client = getClient();
  if (!client) {
    return { sent: false, simulated: true, reason: 'resend-not-configured' };
  }

  try {
    // Hard timeout so a hanging API call cannot keep an admin's approve
    // request (or a student's signup response) waiting.
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve({ __timedOut: true }), SEND_TIMEOUT_MS).unref?.();
    });
    const result = await Promise.race([client.emails.send(payload), timeout]);

    if (result && result.__timedOut) {
      console.error(`[email] ${label}: timed out after ${SEND_TIMEOUT_MS}ms - to=${maskEmail(recipient)}. The StudyCore action itself was not affected.`);
      return { sent: false, error: 'Resend request timed out' };
    }

    const { data, error } = result || {};
    if (error) {
      console.error(`[email] ${label}: Resend rejected the message - to=${maskEmail(recipient)} reason="${describeError(error)}"`);
      return { sent: false, error: describeError(error) };
    }

    const id = data && data.id ? String(data.id) : '';
    // This is the line to look for when verifying delivery: it proves the
    // message was accepted by Resend and gives the id to look up in the
    // Resend dashboard. No API key, no full address, no personal data.
    console.log(`[email] ${label}: accepted by Resend - to=${maskEmail(recipient)} id=${id || 'n/a'}`);
    return { sent: true, id };
  } catch (err) {
    // Network failure, DNS failure, SDK bug - all handled identically.
    console.error(`[email] ${label}: send failed - to=${maskEmail(recipient)} reason="${describeError(err)}". The StudyCore action itself was not affected.`);
    return { sent: false, error: describeError(err) };
  }
}

module.exports = {
  send,
  maskEmail,
  isEmailAddress,
  SEND_TIMEOUT_MS,
  __setTestSender
};
