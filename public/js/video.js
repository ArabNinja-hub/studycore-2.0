// =============================================
// STUDYCORE — Video Lessons (js/video.js)
// -----------------------------------------------
// Powers /pages/videos.html: videos for one course
// and one academic term only.
//
//   ?course=<slug>   required (e.g. mathematics)
//   ?term=<Term N>   Term 1 / Term 2 / Term 3
//   ?program=1       program-course mode: <slug> is a
//                    dynamic program course (e.g. ma110)
//                    and every figure comes from
//                    GET /api/programs/course/:key.
//
// Students reach this page from a course home
// term card. Switching terms stays inside the
// same course.
// =============================================

(function () {
  'use strict';

  const TERMS = ['Term 1', 'Term 2', 'Term 3'];
  const params = new URLSearchParams(location.search);
  const $ = (sel) => document.querySelector(sel);

  let courseSlug = (params.get('course') || '').toLowerCase();
  let focusTerm = TERMS.includes(params.get('term')) ? params.get('term') : 'Term 1';
  // Program-course pages carry ?program=1 (added by the dynamic course home).
  // A course key that has no legacy subject meta is also treated as a program
  // course so a directly typed /ma110 video URL still works instead of
  // bouncing the student back to the courses page.
  let isProgram = params.get('program') === '1' || !SC.COURSE_META[courseSlug];
  let courseInfo = null; // { code, name, slug, icon, subject } for program courses

  function courseSubject() {
    if (courseInfo) return courseInfo.name;
    return (SC.COURSE_META[courseSlug] || {}).name || courseSlug;
  }

  function courseLabel() {
    if (courseInfo) return `${courseInfo.code} — ${courseInfo.name}`;
    return courseSubject();
  }

  function courseHomeHref() {
    return isProgram ? `/course/${encodeURIComponent(courseSlug)}` : `/pages/subjects/${encodeURIComponent(courseSlug)}.html`;
  }

  function termHref(term) {
    const flag = isProgram ? '&program=1' : '';
    return `/pages/videos.html?course=${encodeURIComponent(courseSlug)}&term=${encodeURIComponent(term)}${flag}`;
  }

  function renderTermNav() {
    const host = $('#termSubnavLinks');
    if (!host) return;
    host.innerHTML = TERMS.map((term) =>
      `<li><a href="${termHref(term)}"${term === focusTerm ? ' class="active" aria-current="page"' : ''}>${escapeHtml(term)}</a></li>`
    ).join('');
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
    document.title = `${label} · ${focusTerm} | StudyCore`;
    $('#videosTitle').textContent = `${label} · ${focusTerm}`;
    $('#videosSub').textContent = `Video lessons for ${subject} in ${focusTerm} only.`;
    $('#termCrumb').textContent = focusTerm;
  }

  function renderContinue(cont) {
    if (!cont || cont.category !== 'video') return;
    const section = $('#continueSection');
    section.style.display = '';
    const courseKey = (isProgram && courseInfo && (courseInfo.slug || courseInfo.code)) || null;
    const item = courseKey ? { ...cont, courseCode: courseInfo.code, courseSlug: courseInfo.slug } : cont;
    $('#continueCard').innerHTML = `
      <span class="cc-icon">${SC.icon('play', { size: 24 })}</span>
      <span class="cc-body">
        <span class="cc-eyebrow">Continue where you left off</span>
        <h4>${escapeHtml(cont.title)}</h4>
        ${cont.term ? `<span class="lesson-type">${SC.icon('layers', { size: 12 })} ${escapeHtml(cont.term)}</span>` : ''}
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

  function renderLessons(lessons, { anonymous = false } = {}) {
    const list = $('#videoList');
    if (anonymous) {
      list.innerHTML = emptyState({
        icon: 'lock',
        title: 'Log in to watch',
        body: `These ${escapeHtml(courseSubject())} videos for ${escapeHtml(focusTerm)} are available after you log in.`,
        cta: '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;"><a class="btn btn-primary" href="/signup.html">Start Free Trial</a><a class="btn btn-outline" href="/login.html">Log In</a></div>'
      });
      return;
    }

    const n = lessons.length;
    $('#videosSub').textContent = n === 0
      ? `No ${courseSubject()} videos have been published for ${focusTerm} yet.`
      : `${n} ${courseSubject()} video ${n === 1 ? 'lesson' : 'lessons'} in ${focusTerm}.`;

    list.innerHTML = n
      ? enrichForProgram(lessons).map((lesson) => lessonRowHtml(lesson, courseLabel())).join('')
      : emptyState({
          icon: 'video',
          title: `Nothing in ${escapeHtml(focusTerm)} yet`,
          body: `New ${escapeHtml(courseSubject())} videos for this term appear here when they are published.`
        });
  }

  async function loadTerm() {
    renderTermNav();
    $('#videoList').innerHTML = '<div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div>';

    const session = await StudyCoreAuth.fetchSession();
    if (!session) {
      renderLessons([], { anonymous: true });
      return;
    }

    try {
      const data = isProgram
        ? await StudyCoreAPI.programCourseHome(courseSlug)
        : await StudyCoreAPI.courseHome(courseSubject());
      setPageChrome(data);
      renderTermNav();
      const group = (data.videoTerms || []).find((item) => item.term === focusTerm);
      const lessons = group
        ? (group.lessons || [])
        : (data.lectures || []).filter((lesson) => lesson.term === focusTerm);
      renderLessons(lessons);
      renderContinue(data.continueLearning);
    } catch (err) {
      $('#videoList').innerHTML = emptyState({
        icon: 'alert-triangle',
        title: 'Could not load these videos',
        body: escapeHtml(err.message)
      });
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
    loadTerm();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
