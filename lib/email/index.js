'use strict';

// StudyCore transactional email service.
//
// This is the single entry point the rest of StudyCore uses to send mail.
// Routes never talk to Resend, never see the API key and never build a
// template - they call one named function with data from the database.
//
//   const { sendWelcomeEmail } = require('../lib/email');
//   await sendWelcomeEmail({ userId, name, email });
//
// ---------------------------------------------------------------------------
// Contract every function here honours
// ---------------------------------------------------------------------------
//
//   * It NEVER throws and NEVER rejects. A mail failure returns
//     { sent: false, error } so the caller's database work is untouched. No
//     StudyCore operation is ever rolled back because email failed.
//   * The recipient address is whatever the caller read from the database.
//     Callers must pass the stored address, never a value from the request
//     body (see routes/auth.routes.js and routes/admin.routes.js).
//   * Every send is deduplicated through the email_log table, so a single
//     registration or a single approval can only ever produce one message,
//     even if the browser retries the request, a component mounts twice, or
//     two requests race.
//
// ---------------------------------------------------------------------------
// Activation status
// ---------------------------------------------------------------------------
//
//   ACTIVE   sendWelcomeEmail                 - after student registration
//   ACTIVE   sendSubscriptionAcceptedEmail    - after admin approves a payment
//   ACTIVE   sendSubscriptionRejectedEmail    - after admin rejects a payment
//
//   PREPARED (implemented, tested, not called by any flow):
//            sendLoginNotificationEmail
//            sendEmailVerificationEmail
//            sendPasswordResetEmail
//            sendSubscriptionExpiringEmail
//            sendSubscriptionExpiredEmail
//
//   The prepared functions are deliberately inert: StudyCore has no login
//   notification preference, no email-verification step and no password-reset
//   flow today (password changes require the current password while signed
//   in, via PUT /api/auth/password). Calling one still works - it is simply
//   not wired to anything, so no behaviour changes until a future feature
//   invokes it.

const transport = require('./transport');
const templates = require('./templates');
const config = require('./config');

// Lazy so that merely rendering a template (e.g. in a unit test) does not
// have to open the SQLite database.
let _db = null;
function getDb() {
  if (!_db) _db = require('../../db');
  return _db;
}

// ---------------------------------------------------------------------------
// Duplicate protection
//
// A row is CLAIMED in email_log before the message is handed to Resend. The
// UNIQUE(kind, dedupe_key) constraint means a second attempt for the same
// logical event inserts nothing, so it is skipped instead of sending again.
// This holds across frontend retries, double-submits, concurrent requests
// and server restarts (unlike an in-memory guard).
// ---------------------------------------------------------------------------

/**
 * Tries to claim the right to send one email for one logical event.
 * @returns {boolean} true when this caller owns the send, false when it was
 *          already claimed (i.e. this is a duplicate).
 */
function claimDispatch({ kind, dedupeKey, userId }) {
  try {
    const result = getDb().prepare(`
      INSERT INTO email_log (id, kind, dedupe_key, user_id, status, created_at)
      VALUES (@id, @kind, @dedupe_key, @user_id, 'claimed', @created_at)
      ON CONFLICT(kind, dedupe_key) DO NOTHING
    `).run({
      id: `email-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      kind,
      dedupe_key: dedupeKey,
      user_id: userId || null,
      created_at: new Date().toISOString()
    });
    return result.changes > 0;
  } catch (err) {
    // If the ledger itself is unavailable we must not block the email (and
    // certainly not the surrounding operation). Fail open: send once.
    console.error(`[email] ${kind}: could not record dispatch claim - ${err.message}`);
    return true;
  }
}

/** Records the outcome of a claimed send. */
function recordDispatch({ kind, dedupeKey, status, providerId, error }) {
  try {
    getDb().prepare(`
      UPDATE email_log
         SET status = @status, provider_id = @provider_id, error = @error, sent_at = @sent_at
       WHERE kind = @kind AND dedupe_key = @dedupe_key
    `).run({
      kind,
      dedupe_key: dedupeKey,
      status,
      provider_id: providerId || null,
      // Errors are provider/network messages, never credentials.
      error: error ? String(error).slice(0, 300) : null,
      sent_at: new Date().toISOString()
    });
  } catch (err) {
    console.error(`[email] ${kind}: could not update dispatch record - ${err.message}`);
  }
}

/**
 * Releases a claim so a legitimate later attempt can still send.
 * Used when nothing was actually submitted to Resend (mail not configured,
 * or the stored address was unusable).
 */
function releaseDispatch({ kind, dedupeKey }) {
  try {
    getDb().prepare('DELETE FROM email_log WHERE kind = ? AND dedupe_key = ?').run(kind, dedupeKey);
  } catch {
    // Nothing to do - a stale claim only means one email is not retried.
  }
}

/**
 * Shared pipeline: claim -> render -> send -> record. Never throws.
 *
 * @param {string} kind        Template id, e.g. 'welcome'. Used in logs + ledger.
 * @param {string} dedupeKey   Stable id for the triggering event (user id,
 *                             payment id, ...). One email per key, ever.
 * @param {string} to          Recipient address, read from the database.
 * @param {object} message     { subject, html, text } from ./templates.
 * @param {string} [userId]    For the audit trail.
 */
async function dispatch({ kind, dedupeKey, to, message, userId }) {
  if (!dedupeKey) {
    // Without a key there is no duplicate protection - refuse rather than
    // risk sending the same student the same message twice.
    console.error(`[email] ${kind}: missing dedupe key - not sending.`);
    return { sent: false, skipped: true, reason: 'missing-dedupe-key' };
  }

  const owned = claimDispatch({ kind, dedupeKey, userId });
  if (!owned) {
    console.log(`[email] ${kind}: already dispatched for this event (key=${dedupeKey}) - duplicate suppressed.`);
    return { sent: false, skipped: true, reason: 'duplicate' };
  }

  const result = await transport.send({
    to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    kind
  });

  if (result.sent) {
    recordDispatch({ kind, dedupeKey, status: 'sent', providerId: result.id });
  } else if (result.simulated || result.skipped) {
    // Nothing reached Resend, so the claim must not block a real attempt.
    releaseDispatch({ kind, dedupeKey });
  } else {
    // A genuine send failure. The claim is intentionally kept: a timeout or
    // ambiguous provider error may still have delivered the message, and the
    // triggering actions (registration, approve, reject) are single-shot
    // anyway. The failure is preserved for inspection.
    recordDispatch({ kind, dedupeKey, status: 'failed', error: result.error });
  }

  return result;
}

// ---------------------------------------------------------------------------
// ACTIVE: wired into existing StudyCore flows
// ---------------------------------------------------------------------------

/**
 * Welcome email - sent once, immediately after a successful registration.
 * Trigger: POST /api/auth/register (routes/auth.routes.js), after the user
 * row has actually been inserted.
 *
 * @param {object} student  { userId, name, email } straight from the users row.
 */
async function sendWelcomeEmail({ userId, name, email }) {
  return dispatch({
    kind: 'welcome',
    // One welcome per account, for the lifetime of that account.
    dedupeKey: `user:${userId}`,
    to: email,
    userId,
    message: templates.welcome({ name })
  });
}

/**
 * Subscription approved - sent after an administrator approves the student's
 * pending payment.
 * Trigger: POST /api/admin/payments/:id/approve (routes/admin.routes.js),
 * after the payment row is SUCCESS and the user row is premium.
 *
 * @param {object} args  { userId, name, email, paymentId, subscriptionEnd }
 */
async function sendSubscriptionAcceptedEmail({ userId, name, email, paymentId, subscriptionEnd }) {
  return dispatch({
    kind: 'subscription_accepted',
    // One approval email per payment request.
    dedupeKey: `payment:${paymentId}`,
    to: email,
    userId,
    message: templates.subscriptionAccepted({ name, subscriptionEnd })
  });
}

/**
 * Subscription rejected - sent after an administrator rejects the student's
 * pending payment.
 * Trigger: POST /api/admin/payments/:id/reject (routes/admin.routes.js),
 * after the payment row is REJECTED.
 *
 * @param {object} args  { userId, name, email, paymentId }
 */
async function sendSubscriptionRejectedEmail({ userId, name, email, paymentId }) {
  return dispatch({
    kind: 'subscription_rejected',
    dedupeKey: `payment:${paymentId}`,
    to: email,
    userId,
    message: templates.subscriptionRejected({ name })
  });
}

// ---------------------------------------------------------------------------
// PREPARED: ready for a future feature, intentionally not called anywhere
// ---------------------------------------------------------------------------

/**
 * NOT ACTIVE. Notifies a student that their account was signed in to.
 * StudyCore has no login-notification setting today; wiring this into
 * POST /api/auth/login would email on every sign-in, which is not the
 * requested behaviour. Left ready for when that preference exists.
 */
async function sendLoginNotificationEmail({ userId, name, email, when, device, eventId }) {
  return dispatch({
    kind: 'login_notification',
    // Per sign-in event; the caller supplies the id of that event.
    dedupeKey: `login:${eventId || `${userId}:${when || new Date().toISOString()}`}`,
    to: email,
    userId,
    message: templates.loginNotification({ name, when, device })
  });
}

/**
 * NOT ACTIVE. Email-address verification. StudyCore does not currently have
 * a verification step or a token store; this is the template + send path
 * ready for one.
 */
async function sendEmailVerificationEmail({ userId, name, email, verifyUrl, tokenId, expiresInHours }) {
  return dispatch({
    kind: 'email_verification',
    dedupeKey: `verify:${tokenId || userId}`,
    to: email,
    userId,
    message: templates.emailVerification({ name, verifyUrl, expiresInHours })
  });
}

/**
 * NOT ACTIVE. Password reset. StudyCore's existing password change
 * (PUT /api/auth/password) requires the current password while signed in, so
 * there is no reset-token flow to hook into yet.
 */
async function sendPasswordResetEmail({ userId, name, email, resetUrl, tokenId, expiresInMinutes }) {
  return dispatch({
    kind: 'password_reset',
    // Per issued token, so a new request can always send a new email.
    dedupeKey: `reset:${tokenId || `${userId}:${Date.now()}`}`,
    to: email,
    userId,
    message: templates.passwordReset({ name, resetUrl, expiresInMinutes })
  });
}

/**
 * NOT ACTIVE. Advance warning that a subscription is about to lapse. Needs a
 * scheduled job, which StudyCore does not run today.
 */
async function sendSubscriptionExpiringEmail({ userId, name, email, subscriptionEnd, daysLeft }) {
  return dispatch({
    kind: 'subscription_expiring',
    // One warning per subscription end date, so a daily job is safe to rerun.
    dedupeKey: `expiring:${userId}:${subscriptionEnd || 'unknown'}`,
    to: email,
    userId,
    message: templates.subscriptionExpiring({ name, subscriptionEnd, daysLeft })
  });
}

/**
 * NOT ACTIVE. Notice that a subscription has lapsed. Also needs a scheduled
 * job.
 */
async function sendSubscriptionExpiredEmail({ userId, name, email, subscriptionEnd }) {
  return dispatch({
    kind: 'subscription_expired',
    dedupeKey: `expired:${userId}:${subscriptionEnd || 'unknown'}`,
    to: email,
    userId,
    message: templates.subscriptionExpired({ name, subscriptionEnd })
  });
}

// ---------------------------------------------------------------------------
// Safe self-test
// ---------------------------------------------------------------------------

/**
 * Renders one of the three live templates with the signed-in administrator's
 * own details and sends it to that administrator's own stored address. Used
 * by POST /api/admin/email/test to prove the Resend wiring end-to-end
 * without touching a single student account or subscription.
 *
 * The caller (routes/admin.routes.js) reads `email` from the users table -
 * this function never accepts a recipient from a request body. Unlike the
 * real triggers it is intentionally NOT deduplicated, so an admin can retest
 * as often as they need; it still cannot be reached by a student or an
 * anonymous visitor.
 */
async function sendTestEmailToAdmin({ userId, name, email, template = 'welcome' }) {
  const builders = {
    welcome: () => templates.welcome({ name }),
    approved: () => templates.subscriptionAccepted({
      name,
      subscriptionEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }),
    rejected: () => templates.subscriptionRejected({ name })
  };
  const build = builders[template] || builders.welcome;
  const message = build();

  const result = await transport.send({
    to: email,
    subject: `[Test] ${message.subject}`,
    html: message.html,
    text: message.text,
    kind: `test_${template}`
  });

  // Recorded for the audit trail, with a unique key so repeat tests are all
  // kept and none of them collides with a real student dispatch.
  if (result.sent || result.error) {
    try {
      getDb().prepare(`
        INSERT INTO email_log (id, kind, dedupe_key, user_id, status, provider_id, error, created_at, sent_at)
        VALUES (@id, @kind, @dedupe_key, @user_id, @status, @provider_id, @error, @created_at, @sent_at)
        ON CONFLICT(kind, dedupe_key) DO NOTHING
      `).run({
        id: `email-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        kind: `test_${template}`,
        dedupe_key: `test:${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        user_id: userId || null,
        status: result.sent ? 'sent' : 'failed',
        provider_id: result.id || null,
        error: result.error ? String(result.error).slice(0, 300) : null,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString()
      });
    } catch {
      // The ledger is an audit aid - never fail a test send because of it.
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Introspection helpers (safe: never expose credentials)
// ---------------------------------------------------------------------------

/** True when RESEND_API_KEY is present. Never reveals the key. */
function isEmailConfigured() {
  return config.isResendConfigured();
}

/**
 * Non-sensitive status summary for boot logs and the admin diagnostics
 * endpoint. Deliberately contains no key material - only whether a key
 * exists, the visible From identity and the site URL used in links.
 */
function emailStatus() {
  return {
    provider: 'resend',
    configured: config.isResendConfigured(),
    keyFormatValid: config.isResendConfigured() ? config.resendKeyLooksValid() : false,
    from: config.fromAddress(),
    appUrl: config.appUrl()
  };
}

module.exports = {
  // Active
  sendWelcomeEmail,
  sendSubscriptionAcceptedEmail,
  sendSubscriptionRejectedEmail,
  // Prepared for future use
  sendLoginNotificationEmail,
  sendEmailVerificationEmail,
  sendPasswordResetEmail,
  sendSubscriptionExpiringEmail,
  sendSubscriptionExpiredEmail,
  // Admin-only self-test (recipient is always the admin's own stored address)
  sendTestEmailToAdmin,
  // Helpers
  isEmailConfigured,
  emailStatus,
  templates,
  config,
  transport,
  // Exported for tests
  __internal: { dispatch, claimDispatch, recordDispatch, releaseDispatch }
};
