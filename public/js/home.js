// =============================================
// STUDYCORE — Homepage controller
// -----------------------------------------------
// The landing page is a friendly front door for the
// same hierarchy used by the learning app:
// University → Programme → Course → Topic → Lesson.
// Visitors get a public catalogue preview. Students
// get their own programme courses and real progress.
// The server remains the source of truth for access.
// =============================================

(function () {
  'use strict';

  let catalogueCourses = [];
  let activeUser = null;
  // The public directory and the authenticated programme request resolve in
  // parallel. This small piece of state prevents a slower public request from
  // painting over a student's programme-specific course list.
  let sessionCourseView = null;

  const fallbackCourses = [
    { id: 'fallback-ch110', code: 'CH110', slug: 'ch110', name: 'Chemistry', icon: 'flask', description: 'Atoms, bonding, reactions and quantitative chemistry.' },
    { id: 'fallback-ma110', code: 'MA110', slug: 'ma110', name: 'Mathematics', icon: 'calculator', description: 'Functions, calculus, algebra and problem-solving.' },
    { id: 'fallback-ph110', code: 'PH110', slug: 'ph110', name: 'Physics', icon: 'atom', description: 'Mechanics, waves, electricity and modern physics.' },
    { id: 'fallback-bi110', code: 'BI110', slug: 'bi110', name: 'Biology', icon: 'dna', description: 'Cells, genetics, physiology and living systems.' },
    { id: 'fallback-cs110', code: 'CS110', slug: 'cs110', name: 'Computer Science', icon: 'code', description: 'Programming fundamentals, data structures and logic.' },
    { id: 'fallback-la111', code: 'LA111', slug: 'la111', name: 'Communication Skills', icon: 'message', description: 'Writing, speaking, presentations and clarity.' }
  ];

  function paintIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (el.dataset.iconDone) return;
      el.dataset.iconDone = '1';
      el.innerHTML = SC.icon(el.getAttribute('data-icon'), {
        size: Number(el.getAttribute('data-icon-size')) || 20
      });
      el.style.display = 'inline-flex';
    });
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }

  function esc(value) {
    return typeof escapeHtml === 'function'
      ? escapeHtml(value)
      : String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
  }

  function courseSearchValue(course) {
    return [course.code, course.name, course.description, course.subject]
      .filter(Boolean).join(' ').toLowerCase();
  }

  function courseItem(course, subtitle) {
    // Keep the shared card component as the single visual source of truth for
    // course cards used on the homepage and in the full directory.
    const card = SCUi.courseCard({
      ...course,
      href: course.href || (window.SCPrograms ? SCPrograms.courseHref(course) : `/course/${encodeURIComponent(String(course.slug || course.code || '').toLowerCase())}`)
    }, subtitle ? { subtitle: esc(subtitle) } : {});
    return `<div class="sc-home-course-item" data-search="${esc(courseSearchValue(course))}">${card}</div>`;
  }

  function flattenCourses(universities) {
    const byId = new Map();
    const add = (course, program) => {
      if (!course || !course.code) return;
      const key = String(course.id || course.code).toLowerCase();
      if (!byId.has(key)) {
        byId.set(key, { ...course, programNames: [] });
      }
      const item = byId.get(key);
      const label = program && (program.shortName || program.name);
      if (label && !item.programNames.includes(label)) item.programNames.push(label);
    };

    for (const university of universities || []) {
      for (const faculty of university.faculties || []) {
        for (const program of faculty.programs || []) {
          for (const course of program.courses || []) add(course, program);
        }
      }
      for (const program of university.orphanPrograms || []) {
        for (const course of program.courses || []) add(course, program);
      }
    }

    return [...byId.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  }

  function programCard(program) {
    const count = Number(program.courseCount || 0);
    const href = `/signup.html?program=${encodeURIComponent(program.code || '')}`;
    const shortDescription = program.description || 'A focused first-year course path with guided study resources.';
    return `
      <a class="sc-home-program-card" href="${href}">
        <span class="sc-home-program-icon">${SC.icon(program.icon || 'school', { size: 20 })}</span>
        <span class="sc-home-program-copy">
          <span class="sc-home-program-code">${esc(program.code)}</span>
          <strong>${esc(program.name)}</strong>
          <small>${esc(shortDescription)}</small>
        </span>
        <span class="sc-home-program-meta"><b>${count || '—'}</b><span>courses</span></span>
        <span class="sc-home-program-arrow">${SC.icon('arrow-up-right', { size: 16 })}</span>
      </a>`;
  }

  function paperRow(paper) {
    const lockLabel = paper.locked === 'login' ? 'Log in' : (paper.locked ? 'Premium' : 'Open');
    const meta = [
      paper.courseCode,
      paper.examYear,
      paper.examType
    ].filter(Boolean).map(esc).join(' · ');
    return `
      <a class="sc-paper${paper.locked ? ' is-locked' : ''}" href="/viewer/${encodeURIComponent(paper.id)}">
        <span class="sc-paper-ic">${SC.icon(paper.locked ? 'lock' : 'file', { size: 19 })}</span>
        <span class="sc-paper-main">
          <span class="sc-paper-title">${esc(paper.title || 'Past paper')}</span>
          <span class="sc-paper-meta">${meta || 'University examination paper'}</span>
        </span>
        <span class="sc-paper-side">
          <span class="sc-home-paper-status${paper.locked ? ' is-locked' : ''}">${paper.locked ? SC.icon('lock', { size: 11 }) : SC.icon('arrow-right', { size: 13 })} ${lockLabel}</span>
        </span>
      </a>`;
  }

  function renderCourseCatalogue(courses, options = {}) {
    const host = document.getElementById('homeCatalog');
    if (!host) return;
    const list = courses.length ? courses : fallbackCourses;
    const visible = options.limit ? list.slice(0, options.limit) : list;
    host.setAttribute('aria-busy', 'false');
    host.className = 'sc-course-grid sc-home-course-grid';
    host.innerHTML = visible.map((course) => courseItem(course, options.subtitle || '')).join('');
    catalogueCourses = visible;
    paintIcons(host);
    bindHomeSearch();
  }

  function bindHomeSearch() {
    const input = document.getElementById('homeCourseSearch');
    const empty = document.getElementById('homeCatalogEmpty');
    const host = document.getElementById('homeCatalog');
    if (!input || input.dataset.bound === '1') return;
    input.dataset.bound = '1';

    const filter = () => {
      const query = input.value.trim().toLowerCase();
      let matches = 0;
      host.querySelectorAll('.sc-home-course-item').forEach((item) => {
        const show = !query || item.dataset.search.includes(query);
        item.hidden = !show;
        if (show) matches += 1;
      });
      if (empty) empty.hidden = matches !== 0;
    };
    input.addEventListener('input', filter);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        input.value = '';
        filter();
      }
    });
  }

  function renderPrograms(programs) {
    const host = document.getElementById('homeProgramGrid');
    if (!host) return;
    host.setAttribute('aria-busy', 'false');
    if (!programs.length) {
      host.className = '';
      host.innerHTML = SCUi.state({
        kind: 'error',
        icon: 'school',
        title: 'Programme directory unavailable',
        body: 'Please refresh the page or choose a course from the directory.',
        actions: '<a class="btn btn-outline btn-sm" href="/pages/courses.html">Open course directory</a>'
      });
      return;
    }
    host.className = 'sc-home-program-grid';
    host.innerHTML = programs.map(programCard).join('');
    paintIcons(host);
  }

  async function loadDirectory() {
    try {
      const response = await fetch('/api/universities?courses=1', { credentials: 'include' });
      if (!response.ok) throw new Error('Directory unavailable');
      const data = await response.json();
      const universities = data.universities || [];
      const allCourses = flattenCourses(universities);
      const courseCount = allCourses.length;
      const programCount = universities.reduce((total, university) => {
        const facultyPrograms = (university.faculties || []).reduce((count, faculty) => count + (faculty.programs || []).length, 0);
        return total + facultyPrograms + (university.orphanPrograms || []).length;
      }, 0);
      setText('statUniversities', String(universities.length || 1));
      setText('statPrograms', String(programCount || 6));
      setText('statCourses', courseCount ? `${courseCount}+` : '20+');
      if (sessionCourseView && sessionCourseView.isStudent && sessionCourseView.courses) {
        renderCourseCatalogue(sessionCourseView.courses, {
          subtitle: sessionCourseView.subtitle || '',
          limit: 9
        });
      } else {
        renderCourseCatalogue(allCourses, { limit: 9 });
      }
      return { universities, courses: allCourses, programCount };
    } catch {
      setText('statUniversities', '1');
      setText('statPrograms', '6');
      setText('statCourses', '20+');
      if (sessionCourseView && sessionCourseView.isStudent && sessionCourseView.courses) {
        renderCourseCatalogue(sessionCourseView.courses, {
          subtitle: sessionCourseView.subtitle || '',
          limit: 9
        });
      } else {
        renderCourseCatalogue([], { limit: 6 });
      }
      return { universities: [], courses: fallbackCourses, programCount: 6 };
    }
  }

  async function loadPrograms() {
    try {
      const response = await fetch('/api/programs?counts=1', { credentials: 'include' });
      if (!response.ok) throw new Error('Programmes unavailable');
      const data = await response.json();
      renderPrograms(data.programs || []);
    } catch {
      renderPrograms([]);
    }
  }

  async function loadPastPapers() {
    const host = document.getElementById('homePapers');
    if (!host) return;
    try {
      const response = await fetch('/api/resources/past-papers?pageSize=4', { credentials: 'include' });
      if (!response.ok) throw new Error('Past papers unavailable');
      const data = await response.json();
      setText('statPapers', data.total ? `${data.total}+` : '0');
      setText('homePaperCount', data.total ? `${data.total} paper${data.total === 1 ? '' : 's'} in the library` : 'Library ready for new uploads');
      if (!data.papers || !data.papers.length) {
        host.innerHTML = SCUi.state({
          icon: 'file',
          title: 'Past papers are being uploaded',
          body: 'New examination papers will appear here as soon as they are published.',
          actions: '<a class="btn btn-outline btn-sm" href="/pages/past-papers.html">Open paper library</a>'
        });
      } else {
        host.innerHTML = data.papers.slice(0, 4).map(paperRow).join('');
      }
      host.setAttribute('aria-busy', 'false');
      paintIcons(host);
    } catch {
      setText('homePaperCount', 'Open the complete paper library');
      host.innerHTML = SCUi.state({
        kind: 'error',
        icon: 'alert-triangle',
        title: 'Could not load past papers',
        body: 'Please refresh the page to try again.',
        actions: '<a class="btn btn-outline btn-sm" href="/pages/past-papers.html">Open paper library</a>'
      });
      host.setAttribute('aria-busy', 'false');
    }
  }

  async function adaptForSession() {
    try { activeUser = await StudyCoreAuth.fetchSession(); } catch { activeUser = null; }
    const start = document.getElementById('heroStartCta');
    const heroEyebrow = document.getElementById('heroEyebrow');
    const heroLead = document.getElementById('heroLead');

    if (!activeUser) {
      sessionCourseView = { isStudent: false, courses: null };
      return;
    }
    const role = StudyCoreAuth.normalizedRole(activeUser);
    if (start) {
      start.href = StudyCoreAuth.getDashboardPage(activeUser);
      start.innerHTML = `${SC.icon('layout-dashboard', { size: 15 })} Open your dashboard`;
    }
    if (role === 'student') {
      try {
        const data = await StudyCoreAPI.myProgram();
        if (data && data.program) {
          const programName = data.program.shortName || data.program.name;
          sessionCourseView = { isStudent: true, courses: data.courses || [], subtitle: programName };
          setText('catalogEyebrow', 'My programme');
          setText('catalogTitle', `${programName} courses`);
          setText('catalogIntro', 'Your programme courses, with progress and study materials organised in one place.');
          if (data.courses && data.courses.length) {
            renderCourseCatalogue(data.courses, { subtitle: programName });
          }
        } else {
          sessionCourseView = { isStudent: true, courses: [] };
        }
      } catch {
        // A public catalogue is still useful if the session request fails.
        sessionCourseView = { isStudent: true, courses: null };
      }
      if (heroEyebrow) heroEyebrow.innerHTML = `${SC.icon('graduation-cap', { size: 14 })} Welcome back to StudyCore`;
      if (heroLead) heroLead.textContent = 'Pick up where you left off — your courses, topics, notes, videos and past papers are ready for you.';
    } else if (role === 'admin' || role === 'content_admin') {
      sessionCourseView = { isStudent: false, courses: null };
      if (heroEyebrow) heroEyebrow.innerHTML = `${SC.icon('settings', { size: 14 })} StudyCore workspace`;
      if (heroLead) heroLead.textContent = 'Manage the learning library, publish resources and keep every course path organised.';
    }
  }

  async function init() {
    paintIcons(document);
    if (window.SCUi) SCUi.ensureSprite();
    bindHomeSearch();
    // Directory, programme cards, paper library and session can resolve
    // independently so the hero never waits on a slow content request.
    loadDirectory();
    loadPrograms();
    loadPastPapers();
    adaptForSession();
    paintIcons(document);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
