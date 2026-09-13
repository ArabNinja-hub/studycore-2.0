// =============================================
// STUDYCORE — Study Materials by term (js/study.js)
// -----------------------------------------------
// Powers /pages/study.html: the notes and tutorial
// sheets for ONE course and ONE academic term.
//
//   ?course=<slug>   required (e.g. mathematics, ma110)
//   ?term=<Term N>   Term 1 / Term 2 / Term 3
//   ?program=1       program-course mode: <slug> is a
//                    dynamic program course and every
//                    figure comes from
//                    GET /api/programs/course/:key.
//
// Students reach this page by clicking a term card in
// the Resources section of a course home. Notes and
// tutorial sheets get their OWN slot here — they are
// deliberately never merged into one grid, because a
// student revising a term wants "what do I read" and
// "what do I practise" as two separate shelves.
//
// Mirrors js/video.js: same term sub-nav, same in-place
// term switching (no full page reload), same cache.
// =============================================

(function () {
  'use strict';

  const TERMS = ['Term 1', 'Term 2', 'Term 3'];
  const params = new URLSearchParams(location.search);
  const $ = (sel) => document.querySelector(sel);

  const courseSlug = (params.get('course') || '').toLowerCase();
  let focusTerm = TERMS.includes(params.get('term')) ? params.get('term') : 'Term 1';
  // A course key with no legacy subject meta is treated as a program course so
  // a directly typed /pages/study.html?course=ma110 URL still works.
  const isProgram = params.get('program') === '1' || !SC.COURSE_META[courseSlug];
  let courseInfo = null; // { code, name, slug, subject } for program courses
  let bookmarked = new Set();

  function courseSubject() {
    if (courseInfo) return courseInfo.name;
    return (SC.COURSE_META[courseSlug] || {}).name || courseSlug;
  }

  function courseLabel() {
    if (courseInfo) return `${courseInfo.code} — ${courseInfo.name}`;
    return courseSubject();
  }

  function termHref(term) {
    const flag = isProgram ? '&program=1' : '';
    return `/pages/study.html?course=${encodeURIComponent(courseSlug)}&term=${encodeURIComponent(term)}${flag}`;
  }

  // The sub-nav doubles as the term switcher. Once a term's counts are known
  // each link shows how much is waiting there, so a student can see at a
  // glance which term actually has material.
  function renderTermNav(counts) {
    const host = $('#termSubnavLinks');
    if (!host) return;
    const countFor = (term) => (counts || []).find((c) => c.term === term);
    host.innerHTML = TERMS.map((term) => {
      const c = countFor(term);
      const badge = c ? ` <span class="subnav-count">${c.total}</span>` : '';
      return `<li><a href="${termHref(term)}" data-term="${escapeHtml(term)}"${term === focusTerm ? ' class="active" aria-current="page"' : ''}>${escapeHtml(term)}${badge}</a></li>`;
    }).join('');
  }

  // Switching terms through a normal navigation re-downloads and re-parses
  // every script on the page. The three terms belong to the same course, so
  // swap them in place and just update the URL — back/forward still work via
  // the popstate handler below.
  function bindTermNav() {
    const host = $('#termSubnavLinks');
    if (!host) return;
    host.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-term]');
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      const term = link.getAttribute('data-term');
      if (!TERMS.includes(term) || term === focusTerm) {
        if (term === focusTerm) event.preventDefault();
        return;
      }
      event.preventDefault();
      focusTerm = term;
      history.pushState({ term }, '', termHref(term));
      loadTerm();
    });
  }

  function courseHomeHref() {
    if (isProgram) return `/course/${encodeURIComponent((courseInfo && courseInfo.slug) || courseSlug)}#resources`;
    return `/pages/subjects/${encodeURIComponent(courseSlug)}.html#resources`;
  }

  function setPageChrome(data) {
    if (isProgram && data && data.course) courseInfo = data.course;

    const label = courseLabel();
    const crumb = $('#courseCrumb');
    crumb.href = courseHomeHref();
    crumb.textContent = label;
    const back = $('#courseHomeLink');
    back.href = courseHomeHref();
    back.querySelector('span').textContent = `Back to ${label}`;

    document.title = `${label} · ${focusTerm} study materials | StudyCore`;
    $('#studyTitle').textContent = `${label} · ${focusTerm}`;
    $('#studySub').textContent = `Notes and tutorial sheets for ${courseSubject()} in ${focusTerm} only.`;
    $('#termCrumb').textContent = focusTerm;
  }

  function enrich(items) {
    if (!isProgram || !courseInfo) return items;
    return items.map((item) => ({ ...item, courseCode: courseInfo.code, courseSlug: courseInfo.slug }));
  }

  // One slot = one heading + one grid. Notes and tutorial sheets each get
  // their own, and an empty slot says so rather than disappearing — a student
  // should be able to see that Term 2 has notes but no tutorial sheets yet.
  function renderSlot({ grid, sub, items, noun, nounPlural, emptyTitle, emptyBody, icon }) {
    const n = items.length;
    $(sub).textContent = n === 0
      ? `Nothing published for ${focusTerm} yet.`
      : `${n} ${n === 1 ? noun : nounPlural} in ${focusTerm}.`;
    const host = $(grid);
    host.innerHTML = n
      ? enrich(items).map((r) => resourceCard(r, bookmarked)).join('')
      : emptyState({ icon, title: emptyTitle, body: emptyBody });
    bindCardInteractions(host);
  }

  function renderAnonymous() {
    for (const [grid, sub] of [['#notesGrid', '#notesSub'], ['#tutorialGrid', '#tutorialsSub']]) {
      $(sub).textContent = '';
      $(grid).innerHTML = emptyState({
        icon: 'lock',
        title: 'Log in to open these',
        body: `These ${courseSubject()} materials for ${focusTerm} are available after you log in.`,
        cta: '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;"><a class="btn btn-primary" href="/signup.html">Start Free Trial</a><a class="btn btn-outline" href="/login.html">Log In</a></div>'
      });
    }
  }

  // Term switching is a client-side swap, not a page load. One term of one
  // course is a small payload, so once fetched it is kept and re-rendered
  // instantly instead of re-requesting it (and re-showing a skeleton) each
  // time the student taps between Term 1/2/3.
  const termCache = new Map();

  async function fetchTerm(term) {
    if (termCache.has(term)) return termCache.get(term);
    const data = isProgram
      ? await StudyCoreAPI.programCourseStudyMaterials(courseSlug, term)
      : await StudyCoreAPI.courseStudyMaterials(courseSubject(), term);
    termCache.set(term, data);
    return data;
  }

  function paint(data) {
    setPageChrome(data);
    renderTermNav(data.termCounts);
    renderSlot({
      grid: '#notesGrid',
      sub: '#notesSub',
      items: data.notes || [],
      noun: 'set of notes',
      nounPlural: 'sets of notes',
      icon: 'file-text',
      emptyTitle: `No notes in ${focusTerm} yet`,
      emptyBody: `New ${courseSubject()} notes for this term appear here when they are published.`
    });
    renderSlot({
      grid: '#tutorialGrid',
      sub: '#tutorialsSub',
      items: data.tutorials || [],
      noun: 'tutorial sheet',
      nounPlural: 'tutorial sheets',
      icon: 'file-text',
      emptyTitle: `No tutorial sheets in ${focusTerm} yet`,
      emptyBody: `New ${courseSubject()} tutorial sheets for this term appear here when they are published.`
    });
  }

  function showSkeletons() {
    $('#notesGrid').innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';
    $('#tutorialGrid').innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';
  }

  async function loadTerm() {
    renderTermNav(termCache.has(focusTerm) ? termCache.get(focusTerm).termCounts : null);
    if (termCache.has(focusTerm)) {
      paint(termCache.get(focusTerm));
      return;
    }
    showSkeletons();

    const session = await StudyCoreAuth.fetchSession();
    if (!session) {
      renderAnonymous();
      return;
    }

    try {
      bookmarked = await loadBookmarkedIds();
      paint(await fetchTerm(focusTerm));
    } catch (err) {
      const message = emptyState({
        icon: 'alert-triangle',
        title: 'Could not load these materials',
        body: err.message
      });
      $('#notesGrid').innerHTML = message;
      $('#tutorialGrid').innerHTML = '';
    }
  }

  function boot() {
    if (!courseSlug) {
      location.replace('/pages/courses.html');
      return;
    }
    if (!TERMS.includes(params.get('term'))) {
      history.replaceState(null, '', termHref(focusTerm));
    }
    setPageChrome(null);
    renderTermNav(null);
    bindTermNav();
    // Back/forward between terms must move the lists, not leave stale ones.
    window.addEventListener('popstate', () => {
      const term = new URLSearchParams(location.search).get('term');
      focusTerm = TERMS.includes(term) ? term : 'Term 1';
      loadTerm();
    });
    loadTerm();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
