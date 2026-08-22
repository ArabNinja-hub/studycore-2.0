// =============================================
// STUDYCORE — Video Lessons (js/video.js)
// -----------------------------------------------
// Powers /pages/videos.html: a dedicated
// per-course video library. Every video lesson
// the administrator publishes appears here
// under the exact term selected at upload time
// (Term 1 / Term 2 / Term 3) — each term is a
// full page section, so a course's video
// lessons are browsable page by page on any
// device, phone included.
//
//   ?course=<slug>   selects the course
//   ?term=<Term N>   focuses on a single term
//   #term-N          in-page anchor (deep link)
//
// Logged-in students get their real locked /
// completed / resume state from
// GET /api/courses/:subject (access flags are
// computed server-side). Anonymous visitors see
// the public course picker + video counts and a
// login call-to-action, matching the course
// pages.
// =============================================

(function () {
  'use strict';

  const TERMS = ['Term 1', 'Term 2', 'Term 3'];
  const TERM_IDS = { 'Term 1': 'term-1', 'Term 2': 'term-2', 'Term 3': 'term-3' };
  const params = new URLSearchParams(location.search);
  const $ = (sel) => document.querySelector(sel);

  let courseSlug = (params.get('course') || 'mathematics').toLowerCase();
  const focusTerm = TERMS.includes(params.get('term')) ? params.get('term') : null;

  /* ── Course chips ───────────────────────── */
  function renderChips() {
    const host = $('#courseChips');
    const items = Object.entries(SC.COURSE_META).map(([slug, meta]) => ({
      value: slug,
      label: meta.name,
      icon: meta.icon
    }));
    host.innerHTML = items.map((it) =>
      `<button class="chip ${it.value === courseSlug ? 'active' : ''}" data-course="${it.value}" type="button">${SC.icon(it.icon, { size: 15 })}${escapeHtml(it.label)}</button>`
    ).join(' ');
    host.querySelectorAll('[data-course]').forEach((btn) => {
      btn.addEventListener('click', () => {
        courseSlug = btn.getAttribute('data-course');
        const url = new URL(location.href);
        url.searchParams.set('course', courseSlug);
        url.searchParams.delete('term');
        history.replaceState(null, '', url.toString());
        host.querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b === btn));
        loadCourse();
      });
    });
  }

  function courseSubject() {
    return (SC.COURSE_META[courseSlug] || {}).name || courseSlug;
  }

  /* ── Term section rendering ─────────────── */
  function termSection(term, lessons, { anonymous = false } = {}) {
    const id = TERM_IDS[term];
    const list = document.getElementById(`${id}-list`);
    const count = document.getElementById(`${id}-count`);
    if (!list) return;

    if (anonymous) {
      count.textContent = 'Log in to watch.';
      list.innerHTML = emptyState({
        icon: 'lock',
        title: 'Log in to view this term',
        body: `${lessons.length > 0 ? `${lessons.length} video ${lessons.length === 1 ? 'lesson' : 'lessons'} have been published for ${escapeHtml(term)}. ` : ''}Create a free account (or log in) to start watching.`,
        cta: '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;"><a class="btn btn-primary" href="/signup.html">Start Free Trial</a><a class="btn btn-outline" href="/login.html">Log In</a></div>'
      });
      return;
    }

    const n = lessons.length;
    count.textContent = n === 0
      ? 'No video lessons have been published for this term yet.'
      : `${n} video ${n === 1 ? 'lesson' : 'lessons'} · watch in the StudyCore player`;

    list.innerHTML = n
      ? lessons.map((l) => lessonRowHtml(l, courseSubject())).join('')
      : emptyState({
          icon: 'video',
          title: `Nothing in ${escapeHtml(term)} yet`,
          body: 'New video lessons appear here automatically as soon as the administrator publishes them for this term.'
        });
  }

  /* ── Continue card (video only) ─────────── */
  function renderContinue(cont) {
    if (!cont || cont.category !== 'video') return;
    const section = $('#continueSection');
    section.style.display = '';
    $('#continueCard').innerHTML = `
      <span class="cc-icon">${SC.icon('play', { size: 24 })}</span>
      <span class="cc-body">
        <span class="cc-eyebrow">Continue where you left off</span>
        <h4>${escapeHtml(cont.title)}</h4>
        ${cont.term ? `<span class="lesson-type">${SC.icon('layers', { size: 12 })} ${escapeHtml(cont.term)}</span>` : ''}
        ${cont.videoPosition ? `<div class="progress progress-thin" style="max-width:260px;margin-top:8px;"><span style="width:${Math.round((cont.videoPosition / Math.max(1, cont.videoDuration)) * 100)}%"></span></div>` : ''}
      </span>
      <a class="btn btn-primary" href="/pages/lesson.html?id=${cont.id}&subject=${encodeURIComponent(cont.subject || courseSubject())}">
        ${cont.completed ? 'Review lesson' : 'Continue lesson'} ${SC.icon('arrow-right', { size: 16 })}
      </a>`;
  }

  /* ── Page chrome ────────────────────────── */
  function setPageChrome() {
    const subject = courseSubject();
    document.title = `${subject} Video Lessons | StudyCore`;
    $('#videosTitle').textContent = `${subject} Video Lessons`;
    $('#videosSub').textContent =
      `Every video lesson published for ${subject}, grouped by the academic term the administrator selected at upload time.`;
    $('#courseHomeLink').href = `/pages/subjects/${courseSlug}.html`;
    $('#courseHomeLink').textContent = `Open the ${subject} course`;
    $('#courseVideosSectionLink').href = `/pages/subjects/${courseSlug}.html#video-lessons`;
    $('#courseVideosSectionLink').textContent = 'Video section on course page';
    TERMS.forEach((t) => {
      const h = document.getElementById(`${TERM_IDS[t]}-title`);
      if (h) h.textContent = `${subject} — ${t}`;
    });
  }

  /* ── Load ───────────────────────────────── */
  async function loadCourse() {
    setPageChrome();
    // Reset term sections to skeletons while the API responds.
    TERMS.forEach((t) => {
      const list = document.getElementById(`${TERM_IDS[t]}-list`);
      if (list) list.innerHTML = '<div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div>';
      const count = document.getElementById(`${TERM_IDS[t]}-count`);
      if (count) count.textContent = '';
    });

    const session = await StudyCoreAuth.fetchSession();
    if (session) {
      try {
        const data = await StudyCoreAPI.courseHome(courseSubject());
        const terms = (data.videoTerms && data.videoTerms.length === TERMS.length)
          ? data.videoTerms
          : TERMS.map((term) => ({ term, lessons: (data.lectures || []).filter((l) => l.term === term) }));
        terms.forEach((group) => {
          const idx = TERMS.indexOf(group.term);
          termSection(group.term, group.lessons || []);
          if (idx >= 0) document.getElementById(`${TERM_IDS[group.term]}-title`).textContent = `${data.subject || courseSubject()} — ${group.term}`;
        });
        renderContinue(data.continueLearning);
      } catch (err) {
        TERMS.forEach((t) => {
          const list = document.getElementById(`${TERM_IDS[t]}-list`);
          if (list) list.innerHTML = emptyState({ icon: 'alert-triangle', title: 'Could not load this course', body: escapeHtml(err.message) });
        });
      }
    } else {
      // Anonymous: public counts only — never per-student data.
      try {
        const { courses } = await StudyCoreAPI.listCourses();
        const course = courses.find((c) => c.slug === courseSlug);
        const totalVideos = course ? (course.counts && course.counts.videos) || 0 : 0;
        TERMS.forEach((t) => termSection(t, [], { anonymous: true }));
        $('#videosSub').textContent =
          (course && totalVideos > 0)
            ? `${totalVideos} video ${totalVideos === 1 ? 'lesson' : 'lessons'} published for ${course.subject}. Log in to watch them, grouped by term.`
            : `${course ? course.subject : 'This course'} video lessons appear here as soon as they are published. Log in to watch them, grouped by term.`;
      } catch {
        // Public list failed — the sections already explain login is required.
      }
    }

    // Single-term focus (?term=Term 1) hides the other sections so each
    // term effectively becomes its own page.
    TERMS.forEach((t) => {
      const section = document.getElementById(TERM_IDS[t]);
      if (section) section.style.display = (focusTerm && t !== focusTerm) ? 'none' : '';
      const link = document.querySelector(`#termSubnavLinks a[href="#${TERM_IDS[t]}"]`);
      if (link) link.classList.toggle('active', t === focusTerm || (!focusTerm && t === 'Term 1'));
    });
  }

  /* ── Boot ───────────────────────────────── */
  function boot() {
    // Validate the course param against the known courses.
    if (!SC.COURSE_META[courseSlug]) courseSlug = 'mathematics';
    renderChips();
    loadCourse();

    // Deep link to a specific term section.
    if (location.hash) {
      setTimeout(() => {
        const target = document.querySelector(location.hash);
        if (target) target.scrollIntoView({ behavior: 'smooth' });
      }, 250);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
