'use strict';

// Shared configuration for the StudyCore transactional email system.
//
// Every value is read from the process environment at call time (never
// cached at require time) so Render can rotate a value with a restart and
// so tests can flip configuration without re-requiring the module.
//
// SECURITY: RESEND_API_KEY is read here and NOWHERE else outside
// lib/email/transport.js. It is never returned by an API route, never sent
// to the browser, never written to the database and never logged - not even
// partially. The only thing any log line ever says about it is whether it is
// present.

// The production site. This is the app's existing public URL convention:
// APP_URL when the deployment sets one, otherwise the same studycore.academy
// fallback that lib/mailer.js and server.js already use. No new domain is
// introduced here.
const DEFAULT_APP_URL = 'https://studycore.academy';

// Matches the verified Resend domain. EMAIL_FROM in the Render environment
// overrides this; the fallback only exists so local development renders a
// sensible address instead of crashing.
const DEFAULT_FROM = 'StudyCore <no-reply@studycore.academy>';

// The support contact StudyCore already publishes site-wide (footer +
// About page, see server.js /api/config and public/js/layout.js).
const DEFAULT_SUPPORT_PHONE = '+260981474031';

// Treats the placeholder values shipped in .env.example as "not configured",
// exactly like lib/mailer.js does, so a copied-but-unedited .env behaves the
// same as an empty one.
function looksConfigured(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  return !/^your-|^changeme|^replace-this|^xxx+$/i.test(v);
}

/** Public base URL of this deployment, with any trailing slashes removed. */
function appUrl() {
  const raw = looksConfigured(process.env.APP_URL) ? process.env.APP_URL : DEFAULT_APP_URL;
  return String(raw).trim().replace(/\/+$/, '');
}

/** Absolute URL to a path on the production site (always a real StudyCore URL). */
function siteLink(pathname = '/') {
  const suffix = String(pathname || '/');
  return `${appUrl()}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

/**
 * The sender identity. Uses process.env.EMAIL_FROM as required; accepts
 * either a bare address or a "Name <address>" pair.
 */
function fromAddress() {
  const raw = looksConfigured(process.env.EMAIL_FROM) ? String(process.env.EMAIL_FROM).trim() : DEFAULT_FROM;
  return raw.includes('<') ? raw : `StudyCore <${raw}>`;
}

/** True when RESEND_API_KEY is present. Never reveals the value itself. */
function isResendConfigured() {
  return looksConfigured(process.env.RESEND_API_KEY);
}

/**
 * Cheap shape check used ONLY for a boot-time warning. Resend keys start
 * with "re_". This never logs, returns or stores the key - it answers a
 * boolean about a key the caller already holds.
 */
function resendKeyLooksValid() {
  return /^re_[A-Za-z0-9_-]{10,}$/.test(String(process.env.RESEND_API_KEY || '').trim());
}

/** Support phone StudyCore already shows in its footer. */
function supportPhone() {
  const raw = looksConfigured(process.env.SUPPORT_COMPLAINTS_PHONE)
    ? String(process.env.SUPPORT_COMPLAINTS_PHONE).trim()
    : DEFAULT_SUPPORT_PHONE;
  return raw;
}

/** wa.me link for the same support number, matching the site footer's behaviour. */
function supportWhatsAppUrl() {
  return `https://wa.me/${supportPhone().replace(/[^0-9]/g, '')}`;
}

module.exports = {
  DEFAULT_APP_URL,
  DEFAULT_FROM,
  looksConfigured,
  appUrl,
  siteLink,
  fromAddress,
  isResendConfigured,
  resendKeyLooksValid,
  supportPhone,
  supportWhatsAppUrl
};
