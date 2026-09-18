#!/usr/bin/env node
'use strict';

// Renders the StudyCore email templates to HTML files you can open in a
// browser (or forward to a real inbox for a rendering check).
//
// This is a SAFE, offline testing tool:
//   * it sends nothing and makes no network call;
//   * it needs no RESEND_API_KEY and never reads one;
//   * it touches no student, subscription or production data.
//
// Usage:
//   node scripts/preview-emails.js                 # writes to a temp folder
//   node scripts/preview-emails.js ./out           # writes to ./out
//   APP_URL=https://studycore.academy node scripts/preview-emails.js
//
// To check real delivery instead, use the admin-only endpoint, which always
// sends to the signed-in administrator's own stored address:
//   POST /api/admin/email/test?template=welcome|approved|rejected

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const templates = require('../lib/email/templates');
const config = require('../lib/email/config');

const outDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'studycore-email-preview-'));
fs.mkdirSync(outDir, { recursive: true });

const SAMPLE_NAME = 'Chipo Banda';
const IN_30_DAYS = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

const samples = [
  // The three emails that are ACTIVE in StudyCore today.
  ['welcome', templates.welcome({ name: SAMPLE_NAME }), 'ACTIVE'],
  ['subscription-approved', templates.subscriptionAccepted({ name: SAMPLE_NAME, subscriptionEnd: IN_30_DAYS }), 'ACTIVE'],
  ['subscription-rejected', templates.subscriptionRejected({ name: SAMPLE_NAME }), 'ACTIVE'],
  // Prepared for future features - not triggered by any flow yet.
  ['login-notification', templates.loginNotification({ name: SAMPLE_NAME, when: new Date().toISOString(), device: 'Chrome on Windows' }), 'prepared'],
  ['email-verification', templates.emailVerification({ name: SAMPLE_NAME, verifyUrl: config.siteLink('/verify?token=sample') }), 'prepared'],
  ['password-reset', templates.passwordReset({ name: SAMPLE_NAME, resetUrl: config.siteLink('/reset?token=sample') }), 'prepared'],
  ['subscription-expiring', templates.subscriptionExpiring({ name: SAMPLE_NAME, subscriptionEnd: IN_30_DAYS, daysLeft: 3 }), 'prepared'],
  ['subscription-expired', templates.subscriptionExpired({ name: SAMPLE_NAME, subscriptionEnd: new Date().toISOString() }), 'prepared']
];

console.log(`StudyCore email previews`);
console.log(`  links point at: ${config.appUrl()}`);
console.log(`  sender identity: ${config.fromAddress()}`);
console.log('');

for (const [slug, message, status] of samples) {
  fs.writeFileSync(path.join(outDir, `${slug}.html`), message.html);
  fs.writeFileSync(path.join(outDir, `${slug}.txt`), message.text);
  console.log(`  [${status.padEnd(8)}] ${slug.padEnd(24)} ${message.subject}`);
}

console.log('');
console.log(`Written to: ${outDir}`);
console.log('Open the .html files in a browser to check the layout.');
