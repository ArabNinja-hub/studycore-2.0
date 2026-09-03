// =============================================
// STUDYCORE — Courses page
// -----------------------------------------------
// University → School / Faculty → Programme
// → Year → Course.
//
// A signed-in student sees their own programme's
// courses first (with real progress from
// /api/programs/mine), then the full catalogue so
// they can see what else the university offers.
// A visitor sees the catalogue and is invited to
// pick a programme.
//
// Client-side search filters the rendered tree
// only — the catalogue is small and already
// fetched, so there is no extra request to make.
// =============================================

(function () {
  'use strict';

  let tree = [];
  let myCourses = null;

  function paintIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (el.dataset.iconDone) return;
      el.dataset.iconDone = '1';
      el.innerHTML = SC.icon(el.getAttribute('data-icon'), { size: Number(el.getAttribute('data-icon-size')) || 20 });
      el.style.display = 'inline-flex';
    });
  }

  /* ── Catalogue tree ── */
  function matches(course, q) {
    if (!q) return true;
    return `${course.code} ${course.name} ${course.description || ''}`.toLowerCase().includes(q);
  }

  function programBlock(program, q) {
    const courses = (program.courses || []).filter((c) => matches(c, q));
    if (!courses.length) return '';

    // Group by year of study so "Year 1 / Year 2" is visible when the
    // programme declares one; unassigned courses fall under "All years".
    const years = new Map();
    for (const c of courses) {
      const key = c.yearLevel || 'All years';
      if (!years.has(key)) years.set(key, []);
      years.get(key).push(c);
    }
    const ordered = [...years.entries()].sort(([a], [b]) => (a === 'All years' ? 1 : b === 'All years' ? -1 : a.localeCompare(b)));

    return `
      <div class="sc-program-block">
        <div class="sc-program-head">
          <span class="sc-program-code">${escapeHtml(program.code)}</span>
          <strong>${escapeHtml(program.name)}</strong>
          <span class="badge badge-neutral">${courses.length} course${courses.length === 1 ? '' : 's'}</span>
        </div>
        ${ordered.map(([year, list]) => `
          <div class="sc-year-label">${escapeHtml(year)}</div>
          <div class="sc-course-grid">
            ${list.map((c) => SCUi.courseCard(c, {
              subtitle: escapeHtml(program.shortName || program.name),
              cta: myCourses && myCourses.program ? 'View course' : undefined
            })).join('')}
          </div>`).join('')}
      </div>`;
  }

  function facultyBlock(faculty, q, index) {
    const programs = (faculty.programs || [])
      .map((p) => programBlock(p, q))
      .filter(Boolean);
    if (!programs.length) return '';
    return `
      <div class="sc-faculty${index === 0 && !q ? ' is-open' : ''}" data-faculty>
        <button type="button" class="sc-faculty-head" aria-expanded="${index === 0 && !q}" data-faculty-toggle>
          <span class="sc-faculty-ic">${SC.icon(faculty.icon || 'library', { size: 17 })}</span>
          <strong>${escapeHtml(faculty.shortName || faculty.name)}</strong>
          <span class="sc-faculty-count">${programs.length} programme${programs.length === 1 ? '' : 's'}</span>
          <span class="sc-faculty-caret">${SC.icon('chevron-down', { size: 17 })}</span>
        </button>
        <div class="sc-faculty-body" data-faculty-body${index === 0 && !q ? '' : ' hidden'}>
          ${programs.join('')}
        </div>
      </div>`;
  }

  function universityBlock(university, q) {
    const faculties = (university.faculties || [])
      .map((f, i) => facultyBlock(f, q, i))
      .filter(Boolean);
    const orphanPrograms = (university.orphanPrograms || [])
      .map((p) => programBlock(p, q))
      .filter(Boolean);
    if (!faculties.length && !orphanPrograms.length) return '';

    return `
      <article class="sc-uni">
        <div class="sc-uni-head">
          <span class="sc-uni-ic">${SC.icon(university.icon || 'school', { size: 22 })}</span>
          <div style="flex:1;min-width:0;">
            <h3>${escapeHtml(university.name)}</h3>
            <p>${escapeHtml(university.description || '')}</p>
          </div>
          <span class="badge badge-neutral">${escapeHtml(university.shortName || university.code)}</span>
        </div>
        <div class="sc-uni-body">
          ${faculties.join('')}
          ${orphanPrograms.length ? `<div class="sc-faculty-body" style="padding:15px 0 0;">${orphanPrograms.join('')}</div>` : ''}
        </div>
      </article>`;
  }

  function renderTree(q) {
    const host = document.getElementById('catalogueTree');
    host.setAttribute('aria-busy', 'false');
    const query = (q || '').trim().toLowerCase();
    const blocks = tree.map((u) => universityBlock(u, query)).filter(Boolean);

    if (!blocks.length) {
      host.className = '';
      host.innerHTML = query
        ? SCUi.state({
            icon: 'search',
            title: `No courses match “${escapeHtml(q)}”`,
            body: 'Try a course code such as CH110, or a subject such as Chemistry.',
            actions: '<button type="button" class="btn btn-outline btn-sm" data-action="clear-search">Clear search</button>'
          })
        : SCUi.state({
            kind: 'error',
            title: 'Could not load the course catalogue',
            body: 'Please refresh the page to try again.',
            actions: '<button type="button" class="btn btn-outline btn-sm" data-action="retry">Try again</button>'
          });
      const clear = host.querySelector('[data-action="clear-search"]');
      if (clear) clear.addEventListener('click', () => {
        const input = document.getElementById('courseSearch');
        input.value = '';
        renderTree('');
        input.focus();
      });
      const retry = host.querySelector('[data-action="retry"]');
      if (retry) retry.addEventListener('click', () => loadCatalogue());
      return;
    }

    host.className = 'sc-tree';
    host.innerHTML = blocks.join('');
    bindFaculties();
    paintIcons(host);
  }

  function bindFaculties() {
    document.querySelectorAll('[data-faculty-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const block = btn.closest('[data-faculty]');
        const body = block.querySelector('[data-faculty-body]');
        const open = body.hasAttribute('hidden');
        if (open) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
        block.classList.toggle('is-open', open);
        btn.setAttribute('aria-expanded', String(open));
      });
    });
  }

  /* ── My courses (students) ── */
  function renderMyCourses() {
    const section = document.getElementById('myCoursesSection');
    const grid = document.getElementById('myCoursesGrid');
    const banner = document.getElementById('programBanner');
    if (!myCourses) { section.hidden = true; return; }

    section.hidden = false;
    grid.setAttribute('aria-busy', 'false');
    const program = myCourses.program;
    const uni = program.university;
    const faculty = program.faculty;

    banner.innerHTML = `
      <div class="sc-uni" style="margin-bottom:26px;">
        <div class="sc-uni-head">
          <span class="sc-uni-ic">${SC.icon(program.icon || 'graduation-cap', { size: 22 })}</span>
          <div style="flex:1;min-width:0;">
            <h3>${escapeHtml(program.name)}</h3>
            <p>${[uni && uni.name, faculty && (faculty.shortName || faculty.name), `${myCourses.courses.length} course${myCourses.courses.length === 1 ? '' : 's'}`].filter(Boolean).map(escapeHtml).join(' · ')}</p>
          </div>
          <a class="btn btn-outline btn-sm" href="/dashboard.html">Open dashboard</a>
        </div>
      </div>`;

    document.getElementById('myCoursesTitle').textContent = `${program.shortName || program.name} — my courses`;
    document.getElementById('myCoursesIntro').textContent =
      'Open a course to see its topics, notes, video lessons and past papers, with your own progress on each.';

    if (!myCourses.courses.length) {
      grid.className = '';
      grid.innerHTML = SCUi.state({
        icon: 'library',
        title: 'Courses coming soon',
        body: 'Your programme has no courses yet. They appear here as soon as an administrator adds them.'
      });
      return;
    }
    grid.innerHTML = myCourses.courses
      .map((c) => SCUi.courseCard(c, { subtitle: escapeHtml(program.shortName || program.name) }))
      .join('');
    paintIcons(grid);
  }

  /* ── Loading ── */
  async function loadCatalogue() {
    const host = document.getElementById('catalogueTree');
    host.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch('/api/universities?courses=1', { credentials: 'include' });
      if (!res.ok) throw new Error('catalogue unavailable');
      tree = (await res.json()).universities || [];
      renderTree(document.getElementById('courseSearch').value);
    } catch {
      tree = [];
      renderTree('');
    }
  }

  async function loadMyCourses(user) {
    if (!user || StudyCoreAuth.normalizedRole(user) !== 'student') return;
    try {
      const data = await StudyCoreAPI.myProgram();
      if (data && data.program) {
        myCourses = data;
        document.getElementById('coursesHeading').textContent = `${data.program.name} — your courses`;
        document.getElementById('coursesEyebrow').textContent = 'My programme';
        document.getElementById('coursesIntro').textContent =
          'These are the courses available for your programme. Work through topics, watch lessons, read notes and attempt past papers.';
      } else {
        document.getElementById('coursesHeading').textContent = 'Choose your programme to see your courses';
        document.getElementById('coursesIntro').textContent =
          'Your programme determines which courses, notes, videos and past papers you can access.';
        document.getElementById('programBanner').innerHTML = SCUi.state({
          icon: 'school',
          title: 'No programme selected yet',
          body: 'Pick your university faculty or student category and StudyCore will build your course space.',
          actions: '<a class="btn btn-primary btn-sm" href="/dashboard.html#profile">Choose programme</a>'
        });
      }
    } catch { /* the catalogue below still works */ }
    renderMyCourses();
  }

  function bindSearch() {
    const input = document.getElementById('courseSearch');
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => renderTree(input.value), 180);
    });
  }

  async function init() {
    paintIcons(document);
    SCUi.ensureSprite();
    bindSearch();

    let user = null;
    try { user = await StudyCoreAuth.fetchSession(); } catch { user = null; }

    if (user && StudyCoreAuth.isContentAdmin(user)) {
      window.location.replace('/content-admin.html');
      return;
    }
    if (user && StudyCoreAuth.isAdmin(user)) {
      document.getElementById('coursesHeading').textContent = 'Programmes & courses';
      document.getElementById('coursesIntro').textContent =
        'Create universities, faculties and programmes, assign courses to them, then publish resources against the right course.';
      document.getElementById('programBanner').innerHTML = SCUi.state({
        icon: 'settings',
        title: 'Manage programmes and courses from the admin dashboard',
        body: 'Universities, faculties, programmes, courses and content targeting are all managed there.',
        actions: '<a class="btn btn-primary btn-sm" href="/admin.html">Open admin dashboard</a>'
      });
      document.getElementById('myCoursesSection').hidden = true;
    }

    await Promise.all([loadCatalogue(), loadMyCourses(user)]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
