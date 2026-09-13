// =============================================
// STUDYCORE — Shared Rendering (js/main.js)
// -----------------------------------------------
// Small shared helpers used across pages:
// HTML escaping, formatting, category metadata,
// resource cards (no download/share controls -
// everything opens inside StudyCore), skeletons
// and empty states.
//
// Every resource shown anywhere on the site comes
// from a live fetch to GET /api/resources - new
// admin uploads appear automatically.
// =============================================

const CATEGORY_LABELS = {
  document: 'Notes',
  video: 'Video lesson',
  tutorial: 'Tutorial sheet',
  past_paper: 'Past paper',
  lab_report: 'Lab report',
  announcement: 'Announcement',
  quiz: 'Quiz',
  assignment: 'Assignment',
  material: 'Resource'
};

const CATEGORY_ICONS = {
  document: 'file-text',
  video: 'video',
  tutorial: 'file-text',
  past_paper: 'file',
  lab_report: 'flask',
  announcement: 'bell',
  quiz: 'circle-help',
  assignment: 'edit',
  material: 'library'
};

const SUBJECT_OPTIONS = ['Mathematics', 'Physics', 'Chemistry', 'Biology', 'Communication Skills', 'Programming'];

// ---------------------------------------------------------------------------
// Terms and access policy — these mirror lib/terms.js and lib/access-policy.js
// on the server. The server is always the authority (it re-checks every
// upload and every read); these copies only drive labels, required-field
// markers and lock badges so the UI never contradicts the API.
// ---------------------------------------------------------------------------
const TERMS = ['Term 1', 'Term 2', 'Term 3'];
const UNSCHEDULED_TERM = 'Other';

// Study material that students revise term by term. Lab reports are keyed to
// a lab session rather than a term, so they are deliberately absent.
const TERMED_CATEGORIES = ['video', 'document', 'tutorial', 'past_paper'];

// Always free, even once a trial or subscription has ended.
const ALWAYS_FREE_CATEGORIES = ['past_paper', 'document', 'tutorial', 'announcement'];
// Premium OR an active trial.
const TRIAL_PREMIUM_CATEGORIES = ['lab_report'];

function termAppliesTo(category) {
  return TERMED_CATEGORIES.includes(String(category || '').trim().toLowerCase());
}

function isAlwaysFreeCategory(category) {
  return ALWAYS_FREE_CATEGORIES.includes(String(category || '').trim().toLowerCase());
}

function isTrialPremiumCategory(category) {
  return TRIAL_PREMIUM_CATEGORIES.includes(String(category || '').trim().toLowerCase());
}

// Accepts the loose forms a person might type or a legacy row might hold
// ("term2", "T2", "2") and returns the one canonical label, or null.
function normalizeTerm(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/^(?:t|term)?[\s_-]*([123])$/);
  return match ? `Term ${match[1]}` : null;
}

const SUBJECT_SLUGS = {
  'mathematics': 'mathematics',
  'physics': 'physics',
  'chemistry': 'chemistry',
  'biology': 'biology',
  'communication skills': 'communication',
  'communication': 'communication',
  'programming': 'programming'
};

function subjectSlug(subject) {
  return SUBJECT_SLUGS[String(subject || '').toLowerCase()] || '';
}

// Categories that open in the internal document viewer (/viewer/:id) rather
// than the lesson experience page. Videos always play in the lesson player.
const DOC_VIEWER_CATEGORIES = new Set(['document', 'tutorial', 'past_paper', 'lab_report', 'material']);

function isViewerCategory(category) {
  return DOC_VIEWER_CATEGORIES.has(category);
}

// Single source of truth for where a resource opens. Documents, tutorials,
// past papers and materials open inside StudyCore's dedicated viewer; videos
// (and any other content) open the lesson experience page.
//
// Resources belonging to a dynamic program course carry `courseCode`/
// `courseId` — those open the lesson page with a course flag so the
// previous/next flow stays inside the student's program course.
function resourceHref(resource, subjectFallback) {
  if (!resource || !resource.id) return '#';
  const subject = resource.subject || subjectFallback || '';
  if (isViewerCategory(resource.category)) {
    return `/viewer/${encodeURIComponent(resource.id)}`;
  }
  const courseKey = resource.courseCode || resource.courseSlug || '';
  const courseParam = courseKey ? `&course=${encodeURIComponent(courseKey)}` : '';
  return `/pages/lesson.html?id=${encodeURIComponent(resource.id)}${courseParam}${(!courseKey && subject) ? `&subject=${encodeURIComponent(subject)}` : ''}`;
}
SC.resourceHref = resourceHref;
SC.isViewerCategory = isViewerCategory;

function formatFileSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes), i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return formatDate(iso);
}

// Every string below can originate from an admin's upload form (title,
// description, tags, subject...) or a student's own profile fields. None of
// it is safe to drop into innerHTML unescaped - escape before interpolation,
// everywhere.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

async function initPage() {
  await StudyCoreAuth.fetchSession();
}

// ── Skeletons & empty states ─────────────────
function skeletonCards(n = 4, cls = 'skeleton-card') {
  return Array.from({ length: n }, () => `<div class="skeleton ${cls}"></div>`).join('');
}

function emptyState({ icon = 'library', title = 'Nothing here yet', body = 'New material appears here as soon as it is published.', cta = null }) {
  return `
    <div class="empty-state" style="grid-column:1/-1;">
      <div class="empty-icon">${SC.icon(icon, { size: 28 })}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(body)}</p>
      ${cta || ''}
    </div>
  `;
}

// ── Resource card (no download/share controls) ──
//
// Cards open the item INSIDE StudyCore: video lessons go to the lesson
// page (player), documents/past papers go to the lesson page (reader).
// Locked items render an honest Premium overlay with an upgrade path.
// The lock copy has to name the real reason, because the three reasons now
// carry different remedies: a video needs Premium, a lab report opens on a
// trial too, and everything else that locks is legacy premium content.
const LOCK_COPY = {
  video: {
    title: 'Premium Video',
    body: 'Video lessons are available exclusively to StudyCore Premium students.',
    href: '/pages/pricing.html'
  },
  lab_report: {
    title: 'Premium Lab Report',
    body: 'Lab reports are Premium study material. Start a trial or upgrade to open them.',
    href: '/pages/pricing.html'
  },
  quiz: {
    title: 'Premium Quiz',
    body: 'Practice quizzes are available to StudyCore Premium students.',
    href: '/pages/pricing.html'
  },
  premium: {
    title: 'Premium Resource',
    body: 'Your free access period has ended. Upgrade to keep reading.',
    href: '/dashboard.html#premium'
  }
};

function lockOverlayHtml(reason) {
  const copy = LOCK_COPY[reason] || LOCK_COPY.premium;
  return `<div class="resource-lock-overlay">
        <div class="lock-ring">${SC.icon('lock', { size: 22 })}</div>
        <strong>${escapeHtml(copy.title)}</strong>
        <p>${escapeHtml(copy.body)}</p>
        <a class="btn btn-amber btn-sm" href="${copy.href}">${SC.icon('crown', { size: 14 })} Upgrade to Premium</a>
      </div>`;
}

// Renders the API's `terms` shelves (Term 1/2/3 plus an "Other" bucket for
// legacy content that predates the term field). Empty terms are kept so a
// student can see that a term exists but has nothing published yet.
function termShelvesHtml(groups, renderItems, options) {
  const opts = options || {};
  const shelves = (groups || []).filter((g) => g && (g.lessons || g.items || []).length > 0 || !opts.hideEmpty);
  if (!shelves.length) return '';
  return shelves.map((group) => {
    const items = group.lessons || group.items || [];
    const count = items.length;
    return `
      <div class="term-group" id="${opts.anchorPrefix ? `${opts.anchorPrefix}-${slugifyTerm(group.term)}` : ''}">
        <h3 class="term-group-heading">
          ${escapeHtml(group.term)}
          <span class="resource-meta">${count === 0 ? 'Nothing published yet' : `${count} ${count === 1 ? opts.noun || 'item' : opts.nounPlural || `${opts.noun || 'item'}s`}`}</span>
        </h3>
        ${count ? renderItems(items, group) : `<p class="resource-meta" style="margin:0 0 6px;">${escapeHtml(opts.emptyBody || `Nothing has been published for ${group.term} yet.`)}</p>`}
      </div>`;
  }).join('');
}

function slugifyTerm(term) {
  return String(term || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Notes and tutorial sheets share one "Resources" section, so their two term
// shelves are zipped into a single list that keeps Term 1/2/3/Other order.
function mergeTermShelves(...shelfLists) {
  const byTerm = new Map();
  for (const shelves of shelfLists) {
    for (const group of shelves || []) {
      if (!byTerm.has(group.term)) byTerm.set(group.term, { term: group.term, lessons: [] });
      byTerm.get(group.term).lessons.push(...(group.lessons || []));
    }
  }
  return [...byTerm.values()];
}

function resourceCard(resource, bookmarkedIds) {
  const isBookmarked = bookmarkedIds && bookmarkedIds.has(resource.id);
  const meta = SC.icon(CATEGORY_ICONS[resource.category] || 'file-text', { size: 15 });
  const metaLine = [resource.subject, resource.topic, resource.yearLevel].filter(Boolean).map(escapeHtml).join(' · ');
  const lessonHref = resourceHref(resource);
  const bookmarkBtn = `
    <button class="icon-btn" style="width:32px;height:32px;" data-bookmark="${resource.id}" aria-label="${isBookmarked ? 'Remove bookmark' : 'Bookmark'}">
      ${SC.icon(isBookmarked ? 'bookmark-check' : 'bookmark', { size: 16 })}
    </button>`;

  const lockOverlay = resource.locked ? lockOverlayHtml(resource.locked) : '';

  return `
    <div class="resource-card" data-resource-id="${resource.id}">
      ${lockOverlay}
      <div class="resource-card-top" style="${resource.locked ? 'filter:blur(2px);user-select:none;' : ''}">
        <h3>${escapeHtml(resource.title)}</h3>
        ${bookmarkBtn}
      </div>
      ${resource.description ? `<p style="${resource.locked ? 'filter:blur(2px);user-select:none;' : ''}">${escapeHtml(resource.description)}</p>` : ''}
      <div class="resource-card-meta" style="${resource.locked ? 'filter:blur(2px);' : ''}">
        <span style="display:inline-flex;align-items:center;gap:6px;font-weight:700;">${meta} ${CATEGORY_LABELS[resource.category] || 'Resource'}</span>
        ${metaLine ? `<span>· ${metaLine}</span>` : ''}
        <span>· ${formatDate(resource.createdAt)}</span>
      </div>
      ${resource.locked ? '' : `<a class="course-card-cta" href="${lessonHref}">Open ${resource.category === 'video' ? 'lesson' : 'in StudyCore'} ${SC.icon('arrow-right', { size: 15 })}</a>`}
    </div>
  `;
}

function bindCardInteractions(grid) {
  grid.querySelectorAll('[data-bookmark]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-bookmark');
      const bookmarked = btn.getAttribute('aria-label') === 'Remove bookmark';
      try {
        if (bookmarked) await StudyCoreAPI.unbookmark(id);
        else await StudyCoreAPI.bookmark(id);
        btn.innerHTML = SC.icon(bookmarked ? 'bookmark' : 'bookmark-check', { size: 16 });
        btn.setAttribute('aria-label', bookmarked ? 'Bookmark' : 'Remove bookmark');
        showToast(bookmarked ? 'Removed from bookmarks.' : 'Saved to bookmarks.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// ── Lesson row (course pages + Video Lessons pages) ──
// One lesson entry: status icon (done / locked / category), title, meta
// line, resume position for half-watched videos, and a Premium CTA for
// locked items. Links into the lesson experience page.
// extraAttrs (optional) is appended to the <a> — the course page uses it
// for topic deep-link anchors.
function lessonRowHtml(item, subject, extraAttrs) {
  const icon = item.completed
    ? SC.icon('check', { size: 16 })
    : (item.locked ? SC.icon('lock', { size: 15 }) : SC.icon(SC.courseCategoryIcon(item.category), { size: 15 }));
  const meta = [item.subject && '', item.term, item.topic, item.yearLevel].filter(Boolean).map(escapeHtml).join(' · ');
  const timeLabel = (typeof StudyCorePlayer !== 'undefined' && StudyCorePlayer.fmtTime)
    ? StudyCorePlayer.fmtTime(item.videoPosition)
    : `${Math.floor(item.videoPosition / 60)}:${String(Math.floor(item.videoPosition % 60)).padStart(2, '0')}`;
  const resume = item.videoPosition ? `<span class="lesson-type" style="color:var(--teal-600);">${SC.icon('play', { size: 12 })} Resume at ${timeLabel}</span>` : '';
  const cta = item.locked
    ? `<a class="btn btn-amber btn-sm" href="/pages/pricing.html">${SC.icon('crown', { size: 14 })} Premium</a>`
    : `<span class="lesson-type">${CATEGORY_LABELS[item.category] || 'Resource'}</span>`;
  return `
    <a class="lesson-row ${item.completed ? 'completed' : ''} ${item.locked ? 'locked' : ''}"${extraAttrs ? ` ${extraAttrs}` : ''}
       href="${resourceHref(item, subject)}">
      <span class="lesson-status">${icon}</span>
      <span class="lesson-row-main">
        <span class="lesson-row-title">${escapeHtml(item.title)}</span>
        <span class="lesson-row-meta">
          <span>${meta || CATEGORY_LABELS[item.category] || ''}</span>${resume}
        </span>
      </span>
      <span class="lesson-row-action">${cta}${item.locked ? '' : SC.icon('chevron-right', { size: 17 })}</span>
    </a>
  `;
}

// Filter chips (used by Resources page + search page)
function renderChips(container, { items, active = '', onChange }) {
  if (!container) return;
  container.innerHTML = items.map((it) =>
    `<button class="chip ${it.value === active ? 'active' : ''}" data-chip="${escapeHtml(it.value)}">${it.icon ? SC.icon(it.icon, { size: 15 }) : ''}${escapeHtml(it.label)}</button>`
  ).join(' ');
  container.querySelectorAll('[data-chip]').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-chip]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.getAttribute('data-chip'));
    });
  });
}

document.addEventListener('DOMContentLoaded', initPage);
