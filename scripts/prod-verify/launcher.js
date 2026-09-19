'use strict';

/**
 * Production-parity launcher for the single-active-device verification.
 *
 * Boots the REAL StudyCore server (unmodified app code) in production mode
 * on 0.0.0.0, with one single harness seam: the email transport's own test
 * hook (`__setTestSender`, the same hook scripts/test-emails.js uses) so
 * every dispatched email is captured verbatim to emails.jsonl instead of
 * going to Resend. Nothing else is patched, mocked or stubbed: cookies,
 * JWTs, rate limiting, SQLite, redirects and the admin UI are all live.
 *
 * Usage:
 *   node scripts/prod-verify/launcher.js [run-directory]
 *
 * Environment (all optional, defaults shown):
 *   PORT                        4387
 *   STUDENT_SIGNUP_*            none needed — public registration is live
 *   ADMIN_EMAIL                 verify-admin@studycore.test   (main admin)
 *   ADMIN_PASSWORD              Verify-Admin-Password-9!      (main admin)
 *   CONTENT_ADMIN_ACCESS_CODE   content-verify-code-9         (publisher code)
 *
 * The run directory receives:
 *   emails.jsonl                one JSON object per dispatched email
 *   (and the whole SQLite database / uploads under <run-dir>/data)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const RUN_DIR = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'sc-prod-verify-')));
fs.mkdirSync(path.join(RUN_DIR, 'data'), { recursive: true });

Object.assign(process.env, {
  NODE_ENV: 'production',
  DATA_DIR: path.join(RUN_DIR, 'data'),
  PORT: process.env.PORT || '4387',
  APP_URL: process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || '4387'}`,
  JWT_SECRET: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'verify-admin@studycore.test',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'Verify-Admin-Password-9!',
  CONTENT_ADMIN_ACCESS_CODE: process.env.CONTENT_ADMIN_ACCESS_CODE || 'content-verify-code-9',
  // External services stay empty: R2 -> local disk storage, Resend -> the
  // captured test sender below, Google Picker/Bunny -> feature-flagged off.
  CORS_ALLOWED_ORIGINS: ''
});

// Harness seam: capture outgoing email BEFORE the server is required so the
// lazy transport factory picks the hook up on the first dispatch.
const transport = require('../../lib/email/transport');
const emailLogPath = path.join(RUN_DIR, 'emails.jsonl');
transport.__setTestSender(async (payload, meta) => {
  const record = JSON.stringify({
    at: new Date().toISOString(),
    kind: meta.kind,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text
  });
  fs.appendFileSync(emailLogPath, `${record}\n`);
  return { sent: true, id: `capture-${Date.now()}` };
});

const app = require('../../server');
const server = app.listen(Number(process.env.PORT || '4387'), '0.0.0.0', () => {
  console.log(`[prod-verify] production build listening on http://0.0.0.0:${server.address().port}`);
  console.log(`[prod-verify] run directory: ${RUN_DIR}`);
  console.log(`[prod-verify] email capture: ${emailLogPath}`);
});
