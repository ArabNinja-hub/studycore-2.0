// =============================================
// STUDYCORE — Course Home Module (js/course.js)
// By Dr. Relentless | Stay Curious & Winning
// -----------------------------------------------
// Everything on this page is real: progress, streak, and completion state
// all come from actual database records (lesson_progress / quiz_attempts),
// not anything simulated in the browser. Access control for locked/premium
// items is enforced server-side regardless of what this page displays -
// the lock icon here is just an honest reflection of that, not the thing
// doing the blocking.
// =============================================

let courseData = null;
let activeTabKey = null;

const TAB_DEFS = [
  { key: 'lectures', label: '🎥 Lectures' },
  { key: 'notes', label: '📄 Notes' },
  { key: 'tutorials', label: '📑 Tutorials' },
  { key: 'pastPapers', label: '📝 Past Papers' },
  { key: 'quizzes', label: '🧠 Quizzes' },
  { key: 'assignments', label: '🗂 Resources' },
  { key: 'announcements', label: '📢 Announcements' }
];

function getSubjectFromUrl() {
  return new URLSearchParams(window.location.search).get('subject') || '';
}

function lessonRow(item, opts = {}) {
  const icon = item.completed ? '✓' : (item.locked ? '🔒' : '▶');
  const rowClasses = ['lesson-row'];
  if (item.completed) rowClasses.push('completed');
  if (item.locked) rowClasses.push('locked');

  const meta = [item.subject, item.course].filter(Boolean).join(' • ');
  const freeBadge = !item.isPremium ? '<span class="free-badge">FREE PREVIEW</span>' : '';

  let scoreBadge = '';
  if (item.category === 'quiz' && typeof item.bestPercent === 'number') {
    scoreBadge = `<span class="quiz-score-badge">Best: ${item.bestPercent}%</span>`;
  }

  return `
    <div class="${rowClasses.join(' ')}" data-resource-id="${item.id}" data-category="${item.category}">
      <div class="lesson-status-icon" data-status-icon>${icon}</div>
      <div class="lesson-row-main">
        <div class="lesson-row-title">${escapeHtml(item.title)}${freeBadge}</div>
        <div class="lesson-row-meta">${escapeHtml(meta)}${item.fileSize ? ` • ${formatFileSize(item.fileSize)}` : ''}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        ${scoreBadge}
        ${item.locked
          ? `<a class="btn btn-outline btn-sm" href="dashboard.html">Subscribe to unlock</a>`
          : renderActionButton(item)}
      </div>
    </div>
  `;
}

function renderActionButton(item) {
  if (item.category === 'quiz') {
    return `<button class="btn btn-primary btn-sm" data-open-quiz="${item.id}">Start Quiz</button>`;
  }
  if (item.category === 'video') {
    return `<a class="btn btn-outline btn-sm" href="/api/resources/${item.id}/stream" target="_blank" rel="noopener">▶ Watch</a>`;
  }
  if (item.hasFile) {
    return `
      <a class="btn btn-outline btn-sm" href="/api/resources/${item.id}/stream" target="_blank" rel="noopener">👁 View</a>
      <a class="btn btn-primary btn-sm" href="/api/resources/${item.id}/download">⬇ Download</a>
    `;
  }
  return '';
}

function renderLecturesPanel(termGroups, flatFallback) {
  // If the backend didn't send grouped data for some reason (or every video
  // is search-filtered into a flat array client-side - see bindSearch()
  // below), fall back to a plain flat list rather than showing nothing.
  if (!termGroups || !termGroups.length) {
    return renderTabPanel('lectures', flatFallback || []);
  }
  const body = termGroups.map((group) => `
    <div class="term-group">
      <h3 class="term-group-heading">${escapeHtml(group.term)} <span class="resource-meta">(${group.lectures.length})</span></h3>
      ${group.lectures.map((i) => lessonRow(i)).join('')}
    </div>
  `).join('');
  return `<div class="course-tab-panel" data-panel="lectures">${body}</div>`;
}

function renderTabPanel(key, items) {
  if (!items.length) {
    return `<div class="course-tab-panel" data-panel="${key}"><div class="empty-tab-state">Nothing here yet - check back soon.</div></div>`;
  }
  return `<div class="course-tab-panel" data-panel="${key}">${items.map((i) => lessonRow(i)).join('')}</div>`;
}

function bindLessonInteractions(container) {
  container.querySelectorAll('[data-open-quiz]').forEach((btn) => {
    btn.addEventListener('click', () => openQuizWithScoreTracking(btn.getAttribute('data-open-quiz')));
  });
}

// openQuiz() (from main.js) now saves every score itself - this wrapper
// just refreshes the course page's progress/streak display afterward.
async function openQuizWithScoreTracking(id) {
  await openQuiz(id, async () => {
    await reloadCourse();
  });
}

async function toggleComplete(resourceId, rowEl) {
  const isCompleted = rowEl.classList.contains('completed');
  try {
    if (isCompleted) {
      await StudyCoreAPI.markIncomplete(resourceId);
    } else {
      await StudyCoreAPI.markComplete(resourceId);
    }
    await reloadCourse();
    // Small completion animation on the icon that now shows the checkmark.
    const newRow = document.querySelector(`[data-resource-id="${resourceId}"]`);
    const icon = newRow && newRow.querySelector('[data-status-icon]');
    if (icon && !isCompleted) {
      icon.classList.add('just-completed');
      setTimeout(() => icon.classList.remove('just-completed'), 400);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderHeader(data) {
  document.getElementById('courseEyebrow').textContent = 'Course';
  document.getElementById('courseTitle').textContent = data.subject;
  document.title = `${data.subject} | StudyCore`;

  document.getElementById('courseProgressLabel').textContent = `${data.progress.percent}% Complete`;
  document.getElementById('courseProgressCount').textContent = `${data.progress.completedCount} of ${data.progress.totalCount} items completed`;
  document.getElementById('courseProgressFill').style.width = `${data.progress.percent}%`;

  const streakEl = document.getElementById('courseStreak');
  if (data.streak > 0) {
    streakEl.style.display = 'flex';
    document.getElementById('courseStreakText').textContent = `${data.streak} day study streak`;
  } else {
    streakEl.style.display = 'none';
  }

  const continueCard = document.getElementById('continueLearningCard');
  if (data.continueLearning) {
    continueCard.style.display = 'flex';
    document.getElementById('continueTitle').textContent = data.continueLearning.title;
    const btn = document.getElementById('continueBtn');
    if (data.continueLearning.category === 'quiz') {
      btn.href = '#';
      btn.onclick = (e) => { e.preventDefault(); openQuizWithScoreTracking(data.continueLearning.id); };
    } else if (data.continueLearning.category === 'video') {
      btn.href = `/api/resources/${data.continueLearning.id}/stream`;
      btn.target = '_blank';
      btn.onclick = null;
    } else {
      btn.href = `/api/resources/${data.continueLearning.id}/stream`;
      btn.target = '_blank';
      btn.onclick = null;
    }
  } else {
    continueCard.style.display = 'none';
  }
}

function renderTabs(data) {
  // Only show tabs that actually have content, per the design brief - an
  // empty "Tutorials" tab on a subject with no tutorials uploaded yet would
  // just be clutter.
  const availableTabs = TAB_DEFS.filter((t) => (data[t.key] || []).length > 0);
  if (!availableTabs.length) {
    document.getElementById('courseTabs').innerHTML = '';
    document.getElementById('courseTabPanels').innerHTML = '<div class="empty-tab-state">No content published for this course yet.</div>';
    return;
  }

  if (!activeTabKey || !availableTabs.some((t) => t.key === activeTabKey)) {
    activeTabKey = availableTabs[0].key;
  }

  document.getElementById('courseTabs').innerHTML = availableTabs.map((t) => `
    <button class="course-tab ${t.key === activeTabKey ? 'active' : ''}" data-tab="${t.key}" role="tab">${t.label} (${data[t.key].length})</button>
  `).join('');

  document.getElementById('courseTabPanels').innerHTML = availableTabs.map((t) =>
    t.key === 'lectures' ? renderLecturesPanel(data.lecturesByTerm, data.lectures) : renderTabPanel(t.key, data[t.key])
  ).join('');

  document.querySelectorAll('[data-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.getAttribute('data-panel') === activeTabKey);
  });

  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTabKey = btn.getAttribute('data-tab');
      document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('active', p.getAttribute('data-panel') === activeTabKey));
    });
  });

  bindLessonInteractions(document.getElementById('courseTabPanels'));

  // Clicking anywhere on a non-locked, non-quiz row's status icon toggles
  // completion directly - quizzes get marked complete automatically when
  // scored, so their icon isn't independently clickable.
  document.querySelectorAll('.lesson-row:not(.locked)').forEach((row) => {
    const category = row.getAttribute('data-category');
    if (category === 'quiz') return;
    const icon = row.querySelector('[data-status-icon]');
    icon.style.cursor = 'pointer';
    icon.title = row.classList.contains('completed') ? 'Mark as not complete' : 'Mark as complete';
    icon.addEventListener('click', () => toggleComplete(row.getAttribute('data-resource-id'), row));
  });
}

async function reloadCourse() {
  const subject = getSubjectFromUrl();
  courseData = await StudyCoreAPI.courseHome(subject);
  renderHeader(courseData);
  renderTabs(courseData);
}

function bindSearch() {
  const input = document.getElementById('courseSearch');
  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const term = input.value.trim().toLowerCase();
      if (!term || !courseData) {
        renderTabs(courseData);
        return;
      }
      const filtered = { ...courseData };
      TAB_DEFS.forEach((t) => {
        filtered[t.key] = (courseData[t.key] || []).filter((item) =>
          item.title.toLowerCase().includes(term) || (item.description || '').toLowerCase().includes(term)
        );
      });
      // Term groups would otherwise still show the unfiltered lecture list
      // during a search - clearing this makes the Lectures tab fall back to
      // the correctly-filtered flat list instead.
      filtered.lecturesByTerm = null;
      renderTabs(filtered);
    }, 250);
  });
}

async function initCoursePage() {
  const user = await StudyCoreAuth.fetchSession();
  StudyCoreAuth.updateAuthUI();
  if (!user) { window.location.href = '/login.html'; return; }

  const subject = getSubjectFromUrl();
  if (!subject) {
    document.getElementById('courseTitle').textContent = 'No course specified';
    return;
  }

  try {
    await reloadCourse();
  } catch (err) {
    document.getElementById('courseTitle').textContent = 'Could not load this course';
    document.getElementById('courseTabPanels').innerHTML = `<div class="empty-tab-state">${escapeHtml(err.message)}</div>`;
  }

  bindSearch();
}

document.addEventListener('DOMContentLoaded', initCoursePage);
