'use strict';

// =============================================
// STUDYCORE — Academic terms (Term 1 / 2 / 3)
// -----------------------------------------------
// Every piece of course content is filed under a term so students can revise
// the way their year is actually structured. The term lives in the existing
// `resources.semester` column (kept for backwards compatibility) and is
// normalized through this module so "term1", "T2" and "Term 3 " all land on
// the same canonical label.
//
// Terms apply to notes/documents, tutorial sheets and video lessons. Past
// papers and lab reports are deliberately EXEMPT: past papers are filed by
// the year/sitting they come from rather than by the current teaching term,
// and lab reports follow the laboratory schedule — forcing a term on either
// would be a fake answer the uploader has to invent.
// =============================================

const TERMS = Object.freeze(['Term 1', 'Term 2', 'Term 3']);

// The bucket that holds content with no term (legacy rows, and general
// resources that are not attached to a program course).
const UNSCHEDULED_TERM = 'Other';

// Course content that must be filed under a term when it is attached to a
// program course.
const TERMED_CATEGORIES = Object.freeze(new Set(['video', 'document', 'tutorial']));

// Categories that never carry a term.
const TERM_EXEMPT_CATEGORIES = Object.freeze(new Set(['past_paper', 'lab_report', 'announcement', 'quiz', 'assignment']));

// Accepts 'Term 2', 'term2', 'TERM  2', 't2', '2' → 'Term 2'. Anything else
// (including empty) returns null, which callers treat as "no term".
function normalizeTerm(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return null;
  const match = raw.toLowerCase().replace(/[\s_-]+/g, '').match(/^(?:term|t)?([123])$/);
  if (!match) return null;
  return `Term ${match[1]}`;
}

function isValidTerm(value) {
  return normalizeTerm(value) !== null;
}

// Does a resource of this category need a term? Past papers and lab reports
// never do.
function termAppliesTo(category) {
  const key = String(category || '').trim().toLowerCase();
  if (TERM_EXEMPT_CATEGORIES.has(key)) return false;
  return TERMED_CATEGORIES.has(key);
}

// A term is only REQUIRED for content that is attached to a program course —
// that is where terms are displayed. A general, platform-wide resource with
// no course has no term shelf to sit on, so it stays optional there.
function termRequiredFor(category, { courseId } = {}) {
  return termAppliesTo(category) && Boolean(courseId);
}

// Sort key: Term 1 → 0, Term 2 → 1, Term 3 → 2, everything else last.
function termSortIndex(value) {
  const term = normalizeTerm(value);
  const index = TERMS.indexOf(term);
  return index === -1 ? TERMS.length : index;
}

// Compare two rows/items by term, for Array#sort.
function compareByTerm(a, b) {
  return termSortIndex(a) - termSortIndex(b);
}

// Group a list into ordered term buckets. `getTerm` reads the term off an
// item (defaults to `item.term`, falling back to `item.semester`).
// `includeEmpty` keeps Term 1/2/3 buckets that have no content, which is what
// the course page wants so a student can see the term exists but is empty.
function groupByTerm(items, { getTerm, includeEmpty = false } = {}) {
  const read = getTerm || ((item) => (item && (item.term !== undefined ? item.term : item.semester)));
  const buckets = new Map(TERMS.map((term) => [term, []]));
  const unscheduled = [];

  for (const item of items || []) {
    const term = normalizeTerm(read(item));
    if (term) buckets.get(term).push(item);
    else unscheduled.push(item);
  }

  const groups = TERMS
    .map((term) => ({ term, items: buckets.get(term) }))
    .filter((group) => includeEmpty || group.items.length > 0);

  if (unscheduled.length) groups.push({ term: UNSCHEDULED_TERM, items: unscheduled });
  return groups;
}

// Human-readable message used by both upload validators so Main Admin and
// Content Admin see identical wording. `label` is the resource-type name
// ("Notes", "Study Guide", …) and is lower-cased into the sentence.
function termRequiredMessage(label) {
  const what = String(label || '').trim().toLowerCase();
  const subject = what ? `every ${what} upload` : 'this resource';
  return `Choose Term 1, Term 2, or Term 3 for ${subject} so students find it under the right term.`;
}

// Term shelves for the compact Video Lessons payload (`?view=videos`) and the
// course home's video section. Every video lands on its designated term
// shelf:
//
//   · Without a focus term, the lessons are grouped Term 1 / Term 2 / Term 3
//     (empty shelves kept, so a student sees the term exists) plus an
//     "Other" shelf for legacy rows uploaded before terms were required —
//     nothing is left without a shelf. Non-canonical term strings ("t2",
//     "term 1") are normalized onto the right shelf too.
//   · With a focus term, the three term keys are still returned but only the
//     requested shelf is populated — the narrow view stays narrow.
function videoTermShelves(lessons, focusTerm) {
  if (focusTerm === null || focusTerm === undefined) {
    return groupByTerm(lessons, { includeEmpty: true })
      .map((group) => ({ term: group.term, lessons: group.items }));
  }
  return TERMS.map((term) => ({
    term,
    lessons: term === focusTerm
      ? (lessons || []).filter((lesson) => normalizeTerm(lesson.term) === term)
      : []
  }));
}

module.exports = {
  TERMS,
  UNSCHEDULED_TERM,
  TERMED_CATEGORIES,
  TERM_EXEMPT_CATEGORIES,
  normalizeTerm,
  isValidTerm,
  termAppliesTo,
  termRequiredFor,
  termSortIndex,
  compareByTerm,
  groupByTerm,
  termRequiredMessage,
  videoTermShelves
};
