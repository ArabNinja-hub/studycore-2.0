// =============================================
// STUDYCORE — Resource Rendering Module (js/main.js)
// By Dr. Relentless | Stay Curious & Winning
// -----------------------------------------------
// Every resource shown anywhere on the site comes from a live fetch to
// GET /api/resources (see routes/resources.routes.js). There is no
// localStorage-backed content anywhere in this file - new admin uploads
// appear automatically the next time a student loads a page, because the
// data always comes straight from the database.
// =============================================

const CATEGORY_LABELS = {
  document: 'Document',
  video: 'Video',
  tutorial: 'Tutorial',
  past_paper: 'Past Paper',
  quiz: 'Quiz',
  assignment: 'Assignment',
  announcement: 'Announcement',
  material: 'Resource'
};

const SUBJECT_OPTIONS = ['Mathematics', 'Physics', 'Chemistry', 'Biology', 'Communication', 'Programming'];

function formatFileSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Every string below can originate from an admin's upload form (title,
// description, tags, subject...) or a student's own profile fields. None of
// it is safe to drop into innerHTML unescaped - a compromised or malicious
// admin account could otherwise store a <script> payload that runs in every
// visiting student's browser. Escape before interpolation, everywhere.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

async function initPage() {
  await StudyCoreAuth.fetchSession();
  StudyCoreAuth.updateAuthUI();
}

// -----------------------------------------------------------------------
// Filter toolbar - injected above any resource grid that opts in.
// -----------------------------------------------------------------------
function renderFilterToolbar(container, { onChange, subjects = SUBJECT_OPTIONS, defaultSubject = '' }) {
  if (!container || container.dataset.toolbarBound === 'true') return;
  container.dataset.toolbarBound = 'true';
  container.innerHTML = `
    <div class="filter-toolbar" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px;">
      <input type="search" id="fltSearch" placeholder="Search by title, subject, or keyword…" style="flex:1;min-width:220px;padding:10px 14px;border-radius:8px;border:1px solid var(--border,#ccc);" />
      <select id="fltSubject" style="padding:10px 14px;border-radius:8px;border:1px solid var(--border,#ccc);">
        <option value="">All subjects</option>
        ${subjects.map((s) => `<option value="${s}" ${s.toLowerCase() === (defaultSubject || '').toLowerCase() ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <select id="fltSort" style="padding:10px 14px;border-radius:8px;border:1px solid var(--border,#ccc);">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="popular">Most downloaded</option>
        <option value="title">Title A-Z</option>
      </select>
    </div>
  `;
  let debounceTimer;
  const fire = () => onChange({
    search: document.getElementById('fltSearch').value.trim(),
    subject: document.getElementById('fltSubject').value,
    sort: document.getElementById('fltSort').value
  });
  document.getElementById('fltSearch').addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fire, 300);
  });
  document.getElementById('fltSubject').addEventListener('change', fire);
  document.getElementById('fltSort').addEventListener('change', fire);
}

// -----------------------------------------------------------------------
// Resource card markup
// -----------------------------------------------------------------------
function resourceCard(resource, bookmarkedIds, referralCode) {
  const isBookmarked = bookmarkedIds && bookmarkedIds.has(resource.id);
  const meta = [resource.subject, resource.yearLevel, resource.semester].filter(Boolean).join(' • ');

  let actionHtml = '';
  if (resource.category === 'video' && resource.hasFile) {
    actionHtml = `<div class="video-player-box"><video controls controlsList="nodownload noremoteplayback" disablePictureInPicture oncontextmenu="return false;" preload="none" src="/api/resources/${resource.id}/stream"></video></div>`;
  } else if (resource.category === 'quiz') {
    actionHtml = `<button class="btn btn-primary btn-sm" data-open-quiz="${resource.id}">Start Quiz</button>`;
  } else if (resource.hasFile) {
    // Opens the file in a new browser tab (PDFs/images render inline in the
    // browser itself) without downloading it - reading online rather than
    // saving a copy. The download button below stays available separately
    // for anyone who wants an offline copy.
    actionHtml = `<a class="btn btn-outline btn-sm" href="/api/resources/${resource.id}/stream" target="_blank" rel="noopener">👁 View online</a>`;
  }

  const downloadBtn = (resource.category !== 'video' && (resource.hasFile || resource.externalUrl))
    ? `<a class="btn btn-primary btn-sm" href="${StudyCoreAPI.downloadUrl(resource.id)}">⬇ Download${resource.fileSize ? ` (${formatFileSize(resource.fileSize)})` : ''}</a>`
    : '';

  // Sharing a resource points a friend at signup (resources require an
  // account, so there's nothing else useful to link to) and carries the
  // sharer's referral code along automatically when we have one, so
  // spreading the word also earns them bonus days without any extra effort.
  let shareBtn = '';
  if (referralCode) {
    const signupLink = `${window.location.origin}/signup.html?ref=${referralCode}`;
    const shareText = `Check out "${resource.title}" on StudyCore - free study notes, videos and quizzes. Sign up with my link and we both get 7 bonus days: ${signupLink}`;
    shareBtn = `<a class="btn btn-outline btn-sm" href="https://wa.me/?text=${encodeURIComponent(shareText)}" target="_blank" rel="noopener" aria-label="Share on WhatsApp" title="Share on WhatsApp">📤 Share</a>`;
  }

  const dueHtml = resource.dueDate ? `<span class="dashboard-pill">Due ${formatDate(resource.dueDate)}</span>` : '';

  return `
    <div class="info-card resource-card" data-resource-id="${resource.id}">
      <div class="resource-card-top">
        <h3>${escapeHtml(resource.title)}</h3>
        <button class="btn btn-outline btn-sm" data-bookmark="${resource.id}" aria-label="Bookmark" title="${isBookmarked ? 'Remove bookmark' : 'Bookmark'}">${isBookmarked ? '★' : '☆'}</button>
      </div>
      ${meta ? `<div class="resource-meta">${escapeHtml(meta)}</div>` : ''}
      ${resource.description ? `<p>${escapeHtml(resource.description)}</p>` : ''}
      ${actionHtml}
      <div class="resource-card-top" style="margin-top:auto;">
        <span class="resource-meta">${formatDate(resource.createdAt)}${resource.downloadCount ? ` • ${resource.downloadCount} downloads` : ''}</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">${dueHtml}${shareBtn}${downloadBtn}</div>
      </div>
    </div>
  `;
}

function bindCardInteractions(grid, refreshFn) {
  grid.querySelectorAll('[data-bookmark]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-bookmark');
      const isBookmarked = btn.textContent.trim() === '★';
      try {
        if (isBookmarked) await StudyCoreAPI.unbookmark(id);
        else await StudyCoreAPI.bookmark(id);
        btn.textContent = isBookmarked ? '☆' : '★';
        showToast(isBookmarked ? 'Removed from bookmarks.' : 'Saved to bookmarks.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
  grid.querySelectorAll('[data-open-quiz]').forEach((btn) => {
    btn.addEventListener('click', () => openQuiz(btn.getAttribute('data-open-quiz')));
  });
}

// -----------------------------------------------------------------------
// Main entry point used by every content page (documents/videos/quizzes/…)
// -----------------------------------------------------------------------
async function renderResourceSection({ category, gridId, toolbarId, subjects, subject: fixedSubject }) {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  // Don't trust getCurrentUser() yet if the session check hasn't actually
  // finished - awaiting fetchSession() here is safe even if main.js's own
  // initPage() already kicked one off, since fetchSession() now shares one
  // in-flight request rather than racing a second one.
  const user = await StudyCoreAuth.fetchSession();

  const urlSubject = new URLSearchParams(window.location.search).get('subject');
  const initialSubject = fixedSubject || urlSubject || '';

  if (!user) {
    grid.innerHTML = `
      <div class="info-card">
        <h3>Log in to view this</h3>
        <p>Create a free StudyCore account or log in to browse ${(CATEGORY_LABELS[category] || 'this').toLowerCase()} resources.</p>
        <a class="btn btn-primary btn-sm" href="${StudyCoreAuth.getPageLink('login.html')}">Log In</a>
        <a class="btn btn-outline btn-sm" href="${StudyCoreAuth.getPageLink('signup.html')}">Sign Up</a>
      </div>`;
    return;
  }

  let bookmarkedIds = new Set();
  try {
    const bm = await StudyCoreAPI.myBookmarks();
    bookmarkedIds = new Set(bm.resources.map((r) => r.id));
  } catch { /* not fatal */ }

  let referralCode = null;
  try {
    const ref = await StudyCoreAPI.myReferral();
    referralCode = ref.code;
  } catch { /* not fatal - Share button just won't render without it */ }

  async function load(filters = {}) {
    grid.innerHTML = Array.from({ length: 4 }).map(() => '<div class="skeleton-card"></div>').join('');
    try {
      const { resources } = await StudyCoreAPI.listResources({ category, sort: 'newest', subject: fixedSubject || filters.subject || initialSubject, ...filters });
      if (!resources.length) {
        grid.innerHTML = '<div class="info-card"><h3>Nothing here yet</h3><p>Check back soon - new material appears here as soon as it is published.</p></div>';
        return;
      }
      grid.innerHTML = resources.map((r) => resourceCard(r, bookmarkedIds, referralCode)).join('');
      bindCardInteractions(grid, load);
    } catch (err) {
      if (err.locked) {
        grid.innerHTML = `<div class="info-card"><h3>Your trial has ended</h3><p>${err.message}</p><a class="btn btn-primary btn-sm" href="${StudyCoreAuth.getPageLink('dashboard.html')}">Subscribe to continue</a></div>`;
      } else {
        grid.innerHTML = `<div class="info-card"><p>${err.message}</p></div>`;
      }
    }
  }

  if (toolbarId) {
    renderFilterToolbar(document.getElementById(toolbarId), { onChange: load, subjects, defaultSubject: initialSubject });
  }
  load(initialSubject ? { subject: initialSubject } : {});
}

// -----------------------------------------------------------------------
// Quiz taking
// -----------------------------------------------------------------------
async function openQuiz(id, onSubmit) {
  let resource;
  try {
    const data = await StudyCoreAPI.getResource(id);
    resource = data.resource;
  } catch (err) {
    return showToast(err.message, 'error');
  }
  const questions = resource.quizData || [];
  if (!questions.length) return showToast('This quiz has no questions yet.', 'error');

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9998;padding:20px;';
  modal.innerHTML = `
    <div class="info-card" style="max-width:560px;width:100%;max-height:85vh;overflow-y:auto;">
      <h3>${escapeHtml(resource.title)}</h3>
      <form id="quizRunnerForm">
        ${questions.map((q, i) => `
          <div style="margin:16px 0;">
            <p><strong>${i + 1}. ${escapeHtml(q.question || q.prompt)}</strong></p>
            ${(q.options || []).map((opt, j) => `
              <label style="display:block;margin:4px 0;">
                <input type="radio" name="q${i}" value="${j}" required /> ${escapeHtml(opt)}
              </label>
            `).join('')}
          </div>
        `).join('')}
        <button class="btn btn-primary" type="submit">Submit Answers</button>
        <button class="btn btn-outline" type="button" id="quizCloseBtn">Close</button>
      </form>
      <div id="quizResult" style="margin-top:14px;font-weight:600;"></div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#quizCloseBtn').addEventListener('click', () => modal.remove());
  modal.querySelector('#quizRunnerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    let correct = 0;
    questions.forEach((q, i) => {
      const chosen = modal.querySelector(`input[name="q${i}"]:checked`);
      if (chosen && Number(chosen.value) === Number(q.answer)) correct += 1;
    });
    modal.querySelector('#quizResult').textContent = `You scored ${correct} / ${questions.length}.`;

    // Persist the score for real - this is what powers course progress,
    // quiz history, and "best score" badges. Failing to save shouldn't
    // block the student from seeing their result, so this is non-fatal.
    try {
      await StudyCoreAPI.submitQuizAttempt(id, correct, questions.length);
    } catch { /* the visible score above still stands even if saving failed */ }

    if (typeof onSubmit === 'function') {
      try { await onSubmit(correct, questions.length); } catch { /* caller's problem, not ours */ }
    }
  });
}

function bindLoginForm() {
  const form = document.getElementById('loginForm');
  if (!form || form.dataset.bound === 'true') return;
  form.dataset.bound = 'true';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) return showToast('Email and password are required.', 'error');
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const data = await StudyCoreAPI.login({ email, password });
      showToast(`Welcome back, ${data.user.name.split(' ')[0]}!`, 'success');
      window.location.href = StudyCoreAuth.getDashboardPage(data.user);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function bindSignupForm() {
  const form = document.getElementById('signupForm');
  if (!form || form.dataset.bound === 'true') return;
  form.dataset.bound = 'true';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    const learningLevel = document.getElementById('signupLevel')?.value || 'secondary';
    if (!name || !email || !password) return showToast('All fields are required.', 'error');
    if (password.length < 6) return showToast('Password must be at least 6 characters.', 'error');
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const data = await StudyCoreAPI.register({ name, email, password, learningLevel });
      showToast('Account created! Welcome to StudyCore.', 'success');
      window.location.href = StudyCoreAuth.getDashboardPage(data.user);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

document.addEventListener('DOMContentLoaded', initPage);
