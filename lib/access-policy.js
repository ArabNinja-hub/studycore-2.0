'use strict';

// =============================================
// STUDYCORE — Free vs Premium content policy
// -----------------------------------------------
// ONE source of truth for "can this student open this row right now?".
// Before this module the same four-line rule was copy-pasted into
// routes/resources, routes/courses and routes/programs, which is exactly how
// the three surfaces drifted apart.
//
// THE POLICY
// ----------
//   Past papers, notes/documents and tutorial sheets are FREE, permanently.
//   They stay readable after a trial expires and after a Premium plan lapses —
//   a student who can no longer pay must still be able to revise. These
//   categories ignore the per-row is_premium flag entirely, so a legacy row
//   that was written with is_premium = 1 becomes free the moment this policy
//   loads, with no data migration required.
//
//   Lab reports are the PREMIUM study material. They are readable with an
//   active Premium subscription OR during the free trial, and lock as soon as
//   the tier ends.
//
//   Video lessons stay Premium-only (never unlocked by a trial), quizzes stay
//   Premium-only, and announcements stay open to every signed-in student.
//
// Everything here is evaluated SERVER-SIDE against the freshest users row;
// the client only ever renders the answer.
// =============================================

// Read for free by anybody with an account, forever. is_premium is ignored.
const ALWAYS_FREE_CATEGORIES = Object.freeze(new Set([
  'past_paper',
  'document',
  'tutorial',
  'announcement'
]));

// Premium study material: Premium subscription or an active free trial.
const TRIAL_PREMIUM_CATEGORIES = Object.freeze(new Set(['lab_report']));

// Premium subscription ONLY — a trial never unlocks these.
const PREMIUM_ONLY_CATEGORIES = Object.freeze(new Set(['video', 'quiz']));

function normalizeCategory(value) {
  return String(value || '').trim().toLowerCase();
}

// Is this category free for everyone regardless of plan?
function isAlwaysFreeCategory(category) {
  return ALWAYS_FREE_CATEGORIES.has(normalizeCategory(category));
}

// Is this category gated behind the paid tier (allowing the trial)?
function isPremiumCategory(category) {
  const key = normalizeCategory(category);
  return TRIAL_PREMIUM_CATEGORIES.has(key) || PREMIUM_ONLY_CATEGORIES.has(key);
}

// The value is_premium should hold for a freshly written row of this
// category. Returns null when the category has no forced value and the
// uploader's own choice (free preview vs premium) should be respected.
function premiumFlagForCategory(category) {
  const key = normalizeCategory(category);
  if (ALWAYS_FREE_CATEGORIES.has(key)) return 0;
  if (TRIAL_PREMIUM_CATEGORIES.has(key)) return 1;
  return null;
}

// Resolve is_premium for a write, honouring the forced value when the policy
// defines one and falling back to the uploader's choice otherwise.
function resolvePremiumFlag(category, requested, fallback = 1) {
  const forced = premiumFlagForCategory(category);
  if (forced !== null) return forced;
  if (requested === undefined || requested === null) return fallback ? 1 : 0;
  if (requested === false || requested === 'false' || requested === '0' || requested === 0) return 0;
  return 1;
}

// `access` is { premium, trial } as computed by each route's accessFor().
function canAccessResource(row, access) {
  if (!row) return false;
  const category = normalizeCategory(row.category);
  const state = access || {};

  // Free forever — the whole point of this change. Checked before is_premium
  // so historical rows do not need to be rewritten to become free.
  if (ALWAYS_FREE_CATEGORIES.has(category)) return true;

  // Quizzes are graded Premium features; a free-preview flag must not open
  // the answer flow, so this is checked before the is_premium escape hatch.
  if (category === 'quiz') return Boolean(state.premium);

  // An explicit free preview (is_premium = 0) set by the Main Admin.
  if (!row.is_premium) return true;

  if (category === 'video') return Boolean(state.premium);
  if (TRIAL_PREMIUM_CATEGORIES.has(category)) return Boolean(state.premium || state.trial);

  // Anything else (assignments, legacy categories) keeps the historical rule.
  return Boolean(state.premium || state.trial);
}

// Why it is locked — drives the exact upgrade copy the student is shown.
//   'quiz'       -> Premium quiz wall
//   'video'      -> Premium video wall
//   'lab_report' -> Premium lab-report wall
//   'premium'    -> generic "your access period ended" wall
function lockReasonForResource(row, access) {
  if (canAccessResource(row, access)) return null;
  const category = normalizeCategory(row && row.category);
  if (category === 'quiz') return 'quiz';
  if (category === 'video') return 'video';
  if (TRIAL_PREMIUM_CATEGORIES.has(category)) return 'lab_report';
  return 'premium';
}

const LOCK_MESSAGES = Object.freeze({
  quiz: 'Quizzes are a Premium feature. Upgrade your plan to take this quiz.',
  video: 'Video lessons are available exclusively to StudyCore Premium students. Upgrade to unlock this video.',
  lab_report: 'Lab reports are Premium study material. Upgrade to StudyCore Premium to open this lab report.',
  premium: 'Your free access period has ended. Upgrade to StudyCore Premium to continue reading this resource.'
});

function lockMessage(reason) {
  return LOCK_MESSAGES[reason] || 'This content is not available with your current plan.';
}

module.exports = {
  ALWAYS_FREE_CATEGORIES,
  TRIAL_PREMIUM_CATEGORIES,
  PREMIUM_ONLY_CATEGORIES,
  LOCK_MESSAGES,
  isAlwaysFreeCategory,
  isPremiumCategory,
  premiumFlagForCategory,
  resolvePremiumFlag,
  canAccessResource,
  lockReasonForResource,
  lockMessage
};
