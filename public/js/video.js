// =============================================
// STUDYCORE — Video Lessons (js/video.js)
// -----------------------------------------------
// Powers /pages/videos.html: videos for one course
// and one academic term only.
//
//   ?course=<slug>   required (e.g. mathematics)
//   ?term=<Term N>   Term 1 / Term 2 / Term 3
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

  function courseSubject() {
    return (SC.COURSE_META[courseSlug] || {}).name || courseSlug;
  }

  function termHref(term) {
    return `/pages/videos.html?course=${encodeURIComponent(courseSlug)}&term=${encodeURIComponent(term)}`;
  }

  function renderTermNav() {
    const host = $('#termSubnavLinks');
    if (!host) return;
    host.innerHTML = TERMS.map((term) =>
      `<li><a href="${termHref(term)}"${term === focusTerm ? ' class="active" aria-current="page"' : ''}>${escapeHtml(term)}</a></li>`
    ).join('');
  }

  function setPageChrome() {
    const subject = courseSubject();
    document.title = `${subject} · ${focusTerm} | StudyCore`;
    $('#videosTitle').textContent = `${subject} · ${focusTerm}`;
    $('#videosSub').textContent = `Video lessons for ${subject} in ${focusTerm} only.`;
    $('#termCrumb').textContent = focusTerm;
    const courseUrl = `/pages/subjects/${courseSlug}.html`;
    const crumb = $('#courseCrumb');
    crumb.href = courseUrl;
    crumb.textContent = subject;
    const back = $('#courseHomeLink');
    back.href = `${courseUrl}#video-lessons`;
    back.querySelector('span').textContent = `Back to ${subject}`;
  }

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
      ? lessons.map((lesson) => lessonRowHtml(lesson, courseSubject())).join('')
      : emptyState({
          icon: 'video',
          title: `Nothing in ${escapeHtml(focusTerm)} yet`,
          body: `New ${escapeHtml(courseSubject())} videos for this term appear here when they are published.`
        });
  }

  async function loadTerm() {
    setPageChrome();
    renderTermNav();
    $('#videoList').innerHTML = '<div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div>';

    const session = await StudyCoreAuth.fetchSession();
    if (!session) {
      renderLessons([], { anonymous: true });
      return;
    }

    try {
      const data = await StudyCoreAPI.courseHome(courseSubject());
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
    if (!SC.COURSE_META[courseSlug]) {
      location.replace('/pages/courses.html');
      return;
    }
    if (!TERMS.includes(params.get('term'))) {
      history.replaceState(null, '', termHref(focusTerm));
    }
    loadTerm();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
