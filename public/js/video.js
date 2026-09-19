// =============================================
// STUDYCORE — Video Lessons (js/video.js)
// -----------------------------------------------
// Powers /pages/videos.html: every video lesson
// for one course, each rendered as a card on its
// designated term shelf.
//
//   ?course=<slug>   required (e.g. mathematics)
//   ?term=<Term N>   optional deep link: the page
//                    scrolls straight to that
//                    term's shelf
//   ?program=1       program-course mode: <slug> is a
//                    dynamic program course (e.g. ma110)
//                    and every figure comes from
//                    GET /api/programs/course/:key.
//
// Students reach this page from a course home term
// card. The page shows ALL terms at once — Term 1 /
// Term 2 / Term 3, plus an "Other" shelf for videos
// uploaded before terms existed — so every video
// lesson is visible in the term it belongs to and
// nothing is ever mixed in from another term. The
// term strip under the hero scrolls between shelves
// and doubles as a per-term counter.
// =============================================

(function () {
  'use strict';

  const TERMS = ['Term 1', 'Term 2', 'Term 3'];
  const params = new URLSearchParams(location.search);
  const $ = (sel) => document.querySelector(sel);

  let courseSlug = (params.get('course') || '').toLowerCase();
  // The ?term= param no longer narrows the payload — it only picks the shelf
  // the page scrolls to on arrival. Anything the student does not recognise
  // simply lands on the top of the page.
  const focusTerm = params.get('term');
  // Program-course pages carry ?program=1 (added by the dynamic course home).
  // A course key that has no legacy subject meta is also treated as a program
  // course so a directly typed /ma110 video URL still works instead of
  // bouncing the student back to the courses page.
  const isProgram = params.get('program') === '1' || !SC.COURSE_META[courseSlug];
  let courseInfo = null; // { code, name, slug, icon, subject } for program courses

  function courseSubject() {
    if (courseInfo) return courseInfo.name;
    return (SC.COURSE_META[courseSlug] || {}).name || courseSlug;
  }

  function courseLabel() {
    if (courseInfo) return `${courseInfo.code} — ${courseInfo.name}`;
    return courseSubject();
  }

  // Stable anchor id for a term shelf: "Term 1" → term-1, "Other" → other.
  // (slugifyTerm already carries the "term" word, so no extra prefix.)
  function shelfId(term) {
    return slugifyTerm(term);
  }

  // Does this value name a shelf the page can actually have? Accepts the
  // three teaching terms plus the "Other" shelf — anything else (a mistyped
  // ?term=) is ignored rather than echoed into the chrome.
  function isShelfTerm(value) {
    return TERMS.includes(value) || value === UNSCHEDULED_TERM;
  }

  function fmtTime(seconds) {
    if (typeof StudyCorePlayer !== 'undefined' && StudyCorePlayer.fmtTime) {
      return StudyCorePlayer.fmtTime(seconds);
    }
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  // ── Term strip ──────────────────────────────
  // One link per shelf, carrying its video count so a student can see at a
  // glance which term actually has material. The links are in-page anchors:
  // every shelf is already on the page, so switching terms is a scroll, not
  // another download. While loading (or signed out) the strip renders
  // without counts rather than guessing zeros.
  function renderTermNav(shelves) {
    const host = $('#termSubnavLinks');
    if (!host) return;
    const links = (shelves && shelves.length ? shelves : TERMS.map((term) => ({ term, lessons: null })));
    host.innerHTML = links.map((shelf) => {
      const count = Array.isArray(shelf.lessons)
        ? ` <span class="subnav-count">${shelf.lessons.length}</span>`
        : '';
      return `<li><a href="#${shelfId(shelf.term)}" data-term="${escapeHtml(shelf.term)}"${shelf.term === focusTerm ? ' class="active" aria-current="page"' : ''}>${escapeHtml(shelf.term)}${count}</a></li>`;
    }).join('');
  }

  // Keep the active term in the strip in sync with the shelf the student is
  // actually looking at, the same way the course home highlights its sections.
  function wireShelfSpy() {
    const links = [...document.querySelectorAll('#termSubnavLinks a[data-term]')];
    const shelves = [...document.querySelectorAll('#videoTermShelves .term-group')];
    if (!links.length || !shelves.length) return;
    const setActive = (id) => links.forEach((link) => {
      const active = link.getAttribute('href') === `#${id}`;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(visible.target.id);
      }, { rootMargin: '-30% 0px -60% 0px', threshold: [0, 0.01, 0.25] });
      shelves.forEach((shelf) => io.observe(shelf));
    }
    // Plain hash navigation (keyboard, back button) must also move the
    // highlight, not just the viewport.
    window.addEventListener('hashchange', () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (shelves.some((shelf) => shelf.id === id)) setActive(id);
    });
  }

  // ── Video lesson card ───────────────────────
  // One card per video lesson: thumbnail (the Bunny Stream preview when the
  // video has one, a branded play tile otherwise), a watched / locked flag,
  // the topic it belongs to, and a resume bar for half-watched videos.
  // Locked videos keep their card — the Premium overlay explains the upgrade
  // path instead of hiding the lesson.
  function videoCardHtml(lesson) {
    const thumbUrl = lesson.streamPlayback && lesson.streamPlayback.thumbnail;
    const pct = lesson.videoPosition && lesson.videoDuration
      ? Math.min(100, Math.round((lesson.videoPosition / Math.max(1, lesson.videoDuration)) * 100))
      : 0;
    const flag = lesson.completed
      ? `<span class="video-lesson-flag done">${SC.icon('check', { size: 13 })} Watched</span>`
      : (lesson.locked ? `<span class="video-lesson-flag locked">${SC.icon('lock', { size: 13 })} Premium</span>` : '');
    const resume = lesson.videoPosition && !lesson.completed
      ? `<span class="lesson-type video-lesson-resume">${SC.icon('play', { size: 12 })} Resume at ${fmtTime(lesson.videoPosition)}</span>`
      : '';
    const body = `
      <span class="video-lesson-thumb">
        ${thumbUrl ? `<img src="${escapeHtml(thumbUrl)}" alt="" loading="lazy" />` : ''}
        <span class="video-lesson-play">${SC.icon('play', { size: 22 })}</span>
        ${flag}
        ${pct ? `<span class="video-lesson-progress"><span style="width:${pct}%"></span></span>` : ''}
      </span>
      <span class="video-lesson-body">
        ${lesson.topic ? `<span class="video-lesson-kicker">${escapeHtml(lesson.topic)}</span>` : ''}
        <h3>${escapeHtml(lesson.title)}</h3>
        <span class="video-lesson-meta">
          <span class="lesson-type">${SC.icon('video', { size: 12 })} Video lesson</span>
          ${resume}
        </span>
      </span>`;
    if (lesson.locked) {
      return `<div class="video-lesson-card locked">${lockOverlayHtml(lesson.locked)}${body}</div>`;
    }
    return `<a class="video-lesson-card${lesson.completed ? ' completed' : ''}" href="${resourceHref(lesson, courseSubject())}">${body}</a>`;
  }

  // ── Term shelves ────────────────────────────
  // Each shelf keeps its own heading and its own card grid, so a term is
  // never mixed into another term's row. An empty shelf says so instead of
  // disappearing — a student should see that Term 3 exists but has no videos
  // yet.
  function shelfHtml(shelf) {
    const n = shelf.lessons.length;
    const heading = `${escapeHtml(shelf.term)} <span class="resource-meta">${n} ${n === 1 ? 'video lesson' : 'video lessons'}</span>`;
    const grid = `<div class="video-lesson-grid">${
      n
        ? shelf.lessons.map(videoCardHtml).join('')
        : emptyState({
            icon: 'video',
            title: `Nothing in ${escapeHtml(shelf.term)} yet`,
            body: `New ${escapeHtml(courseSubject())} videos for ${escapeHtml(shelf.term)} appear here when they are published.`
          })
    }</div>`;
    return `
      <div class="term-group" id="${shelfId(shelf.term)}" style="scroll-margin-top:calc(var(--nav-h) + var(--nav-float) + 96px);">
        <h3 class="term-group-heading">${heading}</h3>
        ${grid}
      </div>`;
  }

  function renderShelves(shelves) {
    const host = $('#videoTermShelves');
    host.innerHTML = shelves.length
      ? shelves.map(shelfHtml).join('')
      : emptyState({
          icon: 'video',
          title: 'No videos yet',
          body: `Video lessons for ${escapeHtml(courseSubject())} will appear here as soon as they are published.`
        });
    wireShelfSpy();

    // A ?term= deep link (the course home term cards) scrolls straight to
    // that shelf once the page has rendered.
    if (focusTerm) {
      const target = document.getElementById(shelfId(focusTerm));
      if (target && typeof target.scrollIntoView === 'function') {
        setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
      }
    }
  }

  function setPageChrome(data) {
    if (isProgram && data && data.course) {
      courseInfo = data.course;
      // Refresh the breadcrumb/nav now that we know the real program course.
      const crumb = $('#courseCrumb');
      crumb.href = `/course/${encodeURIComponent(courseInfo.slug || courseSlug)}`;
      crumb.textContent = `${courseInfo.code} — ${courseInfo.name}`;
      const back = $('#courseHomeLink');
      back.href = `/course/${encodeURIComponent(courseInfo.slug || courseSlug)}#video-lessons`;
      back.querySelector('span').textContent = `Back to ${courseInfo.code} — ${courseInfo.name}`;
    }
    const subject = courseSubject();
    const label = courseLabel();
    document.title = `${label} · Video Lessons | StudyCore`;
    $('#videosTitle').textContent = `${label} · Video Lessons`;
    // The crumb names the deep-linked term when the URL carries a real one
    // (Term 1/2/3, or "Other" from a course home's Other card).
    $('#termCrumb').textContent = isShelfTerm(focusTerm) ? focusTerm : 'Video lessons';
    return { subject, label };
  }

  function setSubCopy(shelves) {
    const total = (shelves || []).reduce((sum, shelf) => sum + (shelf.lessons || []).length, 0);
    $('#videosSub').textContent = total === 0
      ? `No ${courseSubject()} videos have been published yet.`
      : `${total} ${courseSubject()} video ${total === 1 ? 'lesson' : 'lessons'} — each one on its designated term shelf.`;
  }

  function renderContinue(cont) {
    if (!cont || cont.category !== 'video') return;
    const section = $('#continueSection');
    section.style.display = '';
    const courseKey = (isProgram && courseInfo && (courseInfo.slug || courseInfo.code)) || null;
    const item = courseKey ? { ...cont, courseCode: courseInfo.code, courseSlug: courseInfo.slug } : cont;
    const term = normalizeTerm(cont.term);
    $('#continueCard').innerHTML = `
      <span class="cc-icon">${SC.icon('play', { size: 24 })}</span>
      <span class="cc-body">
        <span class="cc-eyebrow">Continue where you left off</span>
        <h4>${escapeHtml(cont.title)}</h4>
        ${term ? `<span class="lesson-type">${SC.icon('layers', { size: 12 })} ${escapeHtml(term)}</span>` : ''}
        ${cont.videoPosition ? `<div class="progress progress-thin" style="max-width:260px;margin-top:8px;"><span style="width:${Math.round((cont.videoPosition / Math.max(1, cont.videoDuration)) * 100)}%"></span></div>` : ''}
      </span>
      <a class="btn btn-primary" href="${SC.resourceHref(item, courseSubject())}">
        ${cont.completed ? 'Review lesson' : 'Continue lesson'} ${SC.icon('arrow-right', { size: 16 })}
      </a>`;
  }

  function enrichForProgram(lessons) {
    if (!isProgram || !courseInfo) return lessons;
    return lessons.map((lesson) => ({ ...lesson, courseCode: courseInfo.code, courseSlug: courseInfo.slug }));
  }

  // The shelves come pre-grouped from the API (the server is the term
  // authority), so the page only enriches each shelf's lessons with the
  // program-course key that keeps the lesson flow inside this course.
  function enrichShelves(shelves) {
    return (shelves || []).map((shelf) => ({ ...shelf, lessons: enrichForProgram(shelf.lessons || []) }));
  }

  function renderAnonymous() {
    $('#videosSub').textContent = `Video lessons for ${courseSubject()} are available after you log in.`;
    $('#videoTermShelves').innerHTML = `
      <div class="video-lesson-grid">${emptyState({
        icon: 'lock',
        title: 'Log in to watch',
        body: `These ${escapeHtml(courseSubject())} video lessons are available after you log in.`,
        cta: '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;"><a class="btn btn-primary" href="/signup.html">Start Free Trial</a><a class="btn btn-outline" href="/login.html">Log In</a></div>'
      })}</div>`;
  }

  function paint(data) {
    setPageChrome(data);
    const shelves = enrichShelves(data.videoTerms);
    renderTermNav(shelves);
    setSubCopy(shelves);
    renderShelves(shelves);
    renderContinue(data.continueLearning);
  }

  // One compact payload carries the whole page: every video of the course,
  // already shelved by term (see lib/terms.js), without any of the heavy
  // course-home sections. It is fetched once — there is no per-term
  // re-download because all three shelves render from this single response.
  async function fetchCourseVideos() {
    return isProgram
      ? StudyCoreAPI.programCourseVideos(courseSlug, null)
      : StudyCoreAPI.courseVideos(courseSubject(), null);
  }

  async function load() {
    $('#videoTermShelves').innerHTML = `
      <div class="video-lesson-grid">
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
      </div>`;

    const session = await StudyCoreAuth.fetchSession();
    if (!session) {
      renderTermNav(null);
      renderAnonymous();
      return;
    }

    try {
      paint(await fetchCourseVideos());
    } catch (err) {
      $('#videoTermShelves').innerHTML = `
        <div class="video-lesson-grid">${emptyState({
          icon: 'alert-triangle',
          title: 'Could not load these videos',
          body: escapeHtml(err.message)
        })}</div>`;
    }
  }

  function boot() {
    if (!courseSlug) {
      location.replace('/pages/courses.html');
      return;
    }
    setPageChrome(null);
    renderTermNav(null);
    load();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
