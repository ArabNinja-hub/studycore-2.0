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
  announcement: 'bell',
  quiz: 'circle-help',
  assignment: 'edit',
  material: 'library'
};

const SUBJECT_OPTIONS = ['Mathematics', 'Physics', 'Chemistry', 'Biology', 'Communication Skills', 'Programming'];

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
function resourceCard(resource, bookmarkedIds) {
  const isBookmarked = bookmarkedIds && bookmarkedIds.has(resource.id);
  const meta = SC.icon(CATEGORY_ICONS[resource.category] || 'file-text', { size: 15 });
  const metaLine = [resource.subject, resource.topic, resource.yearLevel].filter(Boolean).map(escapeHtml).join(' · ');
  const lessonHref = `/pages/lesson.html?id=${resource.id}${resource.subject ? `&subject=${encodeURIComponent(resource.subject)}` : ''}`;
  const bookmarkBtn = `
    <button class="icon-btn" style="width:32px;height:32px;" data-bookmark="${resource.id}" aria-label="${isBookmarked ? 'Remove bookmark' : 'Bookmark'}">
      ${SC.icon(isBookmarked ? 'bookmark-check' : 'bookmark', { size: 16 })}
    </button>`;

  const lockOverlay = resource.locked
    ? `<div class="resource-lock-overlay">
        <div class="lock-ring">${SC.icon('lock', { size: 22 })}</div>
        <strong>${resource.locked === 'video' ? 'Premium Video' : 'Premium Resource'}</strong>
        <p>${resource.locked === 'video'
            ? 'Video lessons are available exclusively to StudyCore Premium students.'
            : 'Your free access period has ended. Upgrade to keep reading.'}</p>
        <a class="btn btn-amber btn-sm" href="${resource.locked === 'video' ? '/pages/pricing.html' : '/dashboard.html#premium'}">${SC.icon('crown', { size: 14 })} Upgrade to Premium</a>
      </div>`
    : '';

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
       href="/pages/lesson.html?id=${item.id}&subject=${encodeURIComponent(item.subject || subject)}">
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
