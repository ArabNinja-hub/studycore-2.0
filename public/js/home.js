// =============================================
// STUDYCORE — Homepage controller
// -----------------------------------------------
// The homepage is course-first: a signed-in
// student sees their own programme courses with
// real progress; a visitor sees the university /
// programme catalogue and the newest past papers.
// All page logic lives here (not inline in the
// HTML) so it is cacheable and testable.
// =============================================

(function () {
  'use strict';

  function paintIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (el.dataset.iconDone) return;
      el.dataset.iconDone = '1';
      el.innerHTML = SC.icon(el.getAttribute('data-icon'), { size: Number(el.getAttribute('data-icon-size')) || 22 });
      el.style.display = 'inline-flex';
    });
  }

  function setStat(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  /* ── Catalogue (visitors + students without a programme) ── */
  function programCard(program) {
    const count = Number(program.courseCount || 0);
    return `
      <article class="sc-course is-empty">
        <span class="sc-course-top">
          <span class="sc-course-ic">${SC.icon(program.icon || 'book-open', { size: 22 })}</span>
          <span class="sc-course-id">
            <span class="sc-course-code">${escapeHtml(program.code)}</span>
            <strong class="sc-course-name">${escapeHtml(program.name)}</strong>
            <span class="sc-course-sub">${escapeHtml(program.description || 'A focused course space for this programme.')}</span>
          </span>
        </span>
        <span class="sc-course-stats" style="grid-template-columns:repeat(2,minmax(0,1fr));">
          <span class="sc-course-stat"><b>${count}</b><span>${SC.icon('library', { size: 12 })} Courses</span></span>
          <span class="sc-course-stat"><b>${SCUi.formatCount(count * 12)}</b><span>${SC.icon('layers', { size: 12 })} Topics</span></span>
        </span>
        <span class="sc-course-cta">
          <a class="sc-cta-text" href="/signup.html" style="color:inherit;text-decoration:none;">
            Select this programme ${SC.icon('arrow-right', { size: 15 })}
          </a>
        </span>
      </article>`;
  }

  /* ── Past papers teaser ── */
  function paperRow(paper) {
    const locked = paper.locked && paper.locked !== 'login';
    const meta = [
      paper.courseCode ? `${SC.icon('library', { size: 12 })} ${escapeHtml(paper.courseCode)}` : '',
      paper.examYear ? `${SC.icon('calendar', { size: 12 })} ${escapeHtml(paper.examYear)}` : '',
      paper.examType ? `${SC.icon('list-checks', { size: 12 })} ${escapeHtml(paper.examType)}` : '',
      paper.programName ? `${SC.icon('school', { size: 12 })} ${escapeHtml(paper.programName)}` : ''
    ].filter(Boolean).join('');
    return `
      <a class="sc-paper${paper.locked ? ' is-locked' : ''}" href="/viewer/${encodeURIComponent(paper.id)}">
        <span class="sc-paper-ic">${SC.icon(paper.locked ? 'lock' : 'file', { size: 20 })}</span>
        <span class="sc-paper-main">
          <span class="sc-paper-title">${escapeHtml(paper.title)}</span>
          <span class="sc-paper-meta">${meta}</span>
        </span>
        <span class="sc-paper-side">
          ${paper.locked ? `<span class="badge badge-amber">${SC.icon('lock', { size: 12 })} ${paper.locked === 'login' ? 'Log in' : 'Premium'}</span>` : ''}
          ${SC.icon('chevron-right', { size: 18 })}
        </span>
      </a>`;
  }

  async function loadPastPapers() {
    const host = document.getElementById('homePapers');
    if (!host) return;
    try {
      const res = await fetch('/api/resources/past-papers?pageSize=4', { credentials: 'include' });
      if (!res.ok) throw new Error('past papers unavailable');
      const data = await res.json();
      setStat('statPapers', data.total ? `${data.total}+` : '0');

      const years = (data.facets && data.facets.years || []).slice(0, 3).map((y) => y.value);
      if (years.length) {
        const chips = host.closest('section').querySelectorAll('.sc-filter-row .sc-chips');
        if (chips && chips[0]) {
          chips[0].innerHTML = `<span class="sc-chip is-active">All years</span>` +
            years.map((y) => `<span class="sc-chip">${y}</span>`).join('');
        }
      }

      if (!data.papers.length) {
        host.innerHTML = SCUi.state({
          icon: 'file',
          title: 'Past papers are being uploaded',
          body: 'Examination papers appear here as soon as they are published for your courses.'
        });
        return;
      }
      host.innerHTML = data.papers.slice(0, 4).map(paperRow).join('');
    } catch {
      host.innerHTML = SCUi.state({
        kind: 'error',
        title: 'Could not load past papers',
        body: 'Please refresh the page to try again.',
        actions: '<a class="btn btn-outline btn-sm" href="/pages/past-papers.html">Open past papers</a>'
      });
    }
  }

  /* ── Directory counts (visitors) ── */
  async function loadDirectory() {
    try {
      const res = await fetch('/api/universities?courses=1', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      const unis = data.universities || [];
      // A course code is shared across programmes, so count distinct courses.
      const distinctCourses = new Set();
      for (const u of unis) {
        const programs = [...(u.faculties || []).flatMap((f) => f.programs || []), ...(u.orphanPrograms || [])];
        for (const p of programs) {
          for (const c of (p.courses || [])) distinctCourses.add(c.id || c.code);
        }
      }
      setStat('statUniversities', String(unis.length));
      setStat('statCourses', String(distinctCourses.size));
      setStat('pathPrograms', `${programsTotal(unis)} programmes`);
      setStat('pathCourses', `${distinctCourses.size} courses`);
    } catch { /* the strip keeps its em dash; counts are decorative */ }
  }

  function programsTotal(unis) {
    let n = 0;
    for (const u of unis || []) {
      n += (u.orphanPrograms || []).length;
      for (const f of (u.faculties || [])) n += (f.programs || []).length;
    }
    return n;
  }

  /* ── Main ── */
  async function init() {
    paintIcons(document);
    SCUi.ensureSprite();

    const catalog = document.getElementById('homeCatalog');
    const eyebrow = document.getElementById('catalogEyebrow');
    const title = document.getElementById('catalogTitle');
    const intro = document.getElementById('catalogIntro');
    const link = document.getElementById('catalogLink');

    // These three run independently: a slow endpoint never blocks the others.
    loadPastPapers();
    loadDirectory();

    let user = null;
    try { user = await StudyCoreAuth.fetchSession(); } catch { user = null; }

    if (user && StudyCoreAuth.normalizedRole(user) === 'student') {
      await renderStudentCatalog(catalog, eyebrow, title, intro, link, user);
    } else if (user && (StudyCoreAuth.isAdmin(user) || StudyCoreAuth.isContentAdmin(user))) {
      renderWorkspace(catalog, eyebrow, title, intro, link, user);
    } else {
      await renderVisitorCatalog(catalog, title, intro);
    }

    // Signed-in students get account CTAs instead of "Get Started".
    if (user) {
      const dashboard = StudyCoreAuth.getDashboardPage(user);
      const start = document.getElementById('heroStartCta');
      if (start) {
        start.href = dashboard;
        start.innerHTML = `${SC.icon('layout-dashboard', { size: 18 })} Open Dashboard`;
      }
      document.getElementById('heroEyebrow').innerHTML =
        `${SC.icon('graduation-cap', { size: 14 })} Welcome back to StudyCore`;
      document.getElementById('heroLead').textContent =
        'Pick up where you left off — your courses, topics, notes, videos and past papers are all filtered to your programme.';
    }

    paintIcons(document);
  }

  async function renderStudentCatalog(catalog, eyebrow, title, intro, link, user) {
    let data = null;
    try { data = await StudyCoreAPI.myProgram(); } catch { data = null; }

    if (!data || !data.program) {
      eyebrow.textContent = 'Get set up';
      title.textContent = 'Choose your programme to see your courses';
      intro.textContent = 'Your account is ready — pick your programme and StudyCore will build your course space.';
      link.style.display = 'none';
      catalog.setAttribute('aria-busy', 'false');
      catalog.className = '';
      catalog.innerHTML = SCUi.state({
        icon: 'school',
        title: 'No programme selected yet',
        body: 'Your programme decides which courses, notes, videos and past papers you can see.',
        actions: '<a class="btn btn-primary btn-sm" href="/dashboard.html#profile">Choose programme</a>'
      });
      return;
    }

    const programName = data.program.shortName || data.program.name;
    eyebrow.textContent = 'My programme';
    title.textContent = `${data.program.name} — your courses`;
    const uni = data.program.university;
    const faculty = data.program.faculty;
    intro.textContent = [uni && uni.name, faculty, `${data.courses.length} course${data.courses.length === 1 ? '' : 's'}`]
      .filter(Boolean).join(' · ') + '.';

    catalog.setAttribute('aria-busy', 'false');
    if (!data.courses.length) {
      catalog.className = '';
      catalog.innerHTML = SCUi.state({
        icon: 'library',
        title: 'Courses coming soon',
        body: 'Your programme has no courses yet. They appear here as soon as an administrator adds them.'
      });
      return;
    }

    catalog.innerHTML = data.courses.map((c) => SCUi.courseCard(c, { subtitle: escapeHtml(programName) })).join('');
  }

  function renderWorkspace(catalog, eyebrow, title, intro, link, user) {
    const isAdminRole = StudyCoreAuth.isAdmin(user);
    const dashboard = StudyCoreAuth.getDashboardPage(user);
    eyebrow.textContent = isAdminRole ? 'Administration' : 'Content Admin';
    title.textContent = isAdminRole ? 'Manage the course catalogue' : 'Your publishing workspace';
    intro.textContent = isAdminRole
      ? 'Create universities, faculties, programmes and courses, then publish resources against them.'
      : 'Upload notes, videos and past papers for the courses you own.';
    link.style.display = 'none';
    catalog.setAttribute('aria-busy', 'false');
    catalog.className = '';
    catalog.innerHTML = SCUi.state({
      icon: isAdminRole ? 'settings' : 'upload',
      title: isAdminRole ? 'Universities, programmes and content' : 'Content Admin workspace',
      body: isAdminRole
        ? 'Everything students see is managed from the admin dashboard.'
        : 'Open your dashboard to publish and manage your own resources.',
      actions: `<a class="btn btn-primary btn-sm" href="${dashboard}">Open dashboard</a>`
    });
  }

  async function renderVisitorCatalog(catalog, title, intro) {
    let programs = [];
    try {
      const res = await fetch('/api/programs?counts=1', { credentials: 'include' });
      if (res.ok) programs = (await res.json()).programs || [];
    } catch { programs = []; }

    setStat('pathPrograms', `${programs.length} programmes`);
    catalog.setAttribute('aria-busy', 'false');

    if (!programs.length) {
      catalog.className = '';
      catalog.innerHTML = SCUi.state({
        kind: 'error',
        title: 'Could not load programmes',
        body: 'Please refresh the page to try again.',
        actions: '<a class="btn btn-primary btn-sm" href="/signup.html">Create an account</a>'
      });
      return;
    }

    intro.textContent = 'Choose your faculty or student category at signup and StudyCore shows only the courses you study.';
    catalog.innerHTML = programs.map(programCard).join('');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
