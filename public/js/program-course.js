// =============================================
// STUDYCORE — Dynamic Program Course (js/program-course.js)
// -----------------------------------------------
// Powers /course/:key — the course home inside the
// multi-program platform:
//   StudyCore → Program → Course → Topics →
//   Notes / Videos / Past Papers / Resources
// The course key (code/slug) comes from the URL.
// Every figure, lesson and lock state is served by
// GET /api/programs/course/:key, which enforces
// program enrollment server-side (a student from
// another program gets a 403).
// =============================================

(function () {
  'use strict';

  const key = decodeURIComponent((location.pathname.split('/course/')[1] || '').replace(/\.html?$/, ''));
  const $ = (sel) => document.querySelector(sel);

  SC.Hero.init($('#courseHero'), key);

  function setStats(values) {
    document.querySelectorAll('[data-stat]').forEach((el) => {
      el.textContent = values[el.getAttribute('data-stat')] ?? '0';
    });
  }

  function topicAnchor(name) {
    return `lesson-topic-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  }

  function rowHtml(item, course) {
    // Tag lessons with their course code so the lesson flow stays inside
    // this program course.
    const withCourse = { ...item, courseCode: course.code, courseSlug: course.slug };
    return lessonRowHtml(withCourse, course.name, `data-topic-anchor="${escapeHtml(topicAnchor(item.topic || 'General'))}"`);
  }

  function termVideosHref(term) {
    return `/pages/videos.html?course=${encodeURIComponent(courseKey())}&term=${encodeURIComponent(term)}&program=1`;
  }
  function courseKey() { return window.__course ? window.__course.slug : key; }

  function termCardHtml(term, copy) {
    return `
      <a class="video-term-card" href="${termVideosHref(term)}">
        <div class="video-term-card-heading">
          <span class="card-icon">${SC.icon('play', { size: 20 })}</span>
          <div><h3>${escapeHtml(term)}</h3><p>${escapeHtml(copy)}</p></div>
        </div>
        <span class="video-term-cta">Open ${escapeHtml(term)} videos ${SC.icon('arrow-right', { size: 16 })}</span>
      </a>`;
  }

  async function loadBookmarkedIds() {
    try {
      const { resources } = await StudyCoreAPI.myBookmarks();
      return new Set(resources.map((r) => r.id));
    } catch { return new Set(); }
  }

  async function render(data) {
    const course = data.course;
    const program = data.program;
    window.__course = course;

    document.title = `${course.code} — ${course.name} | StudyCore`;
    $('#courseTitle').textContent = `${course.code} — ${course.name}`;
    $('#courseHeroIcon').innerHTML = SC.icon(course.icon || 'book-open', { size: 30 });
    $('#courseProgramLine').textContent = program
      ? `${program.name}${program.groupName ? ' · ' + program.groupName : ''} — lessons, video learning, notes, tutorials and past papers for ${course.code}.`
      : `Lessons, video learning, notes, tutorials and past papers for ${course.code}.`;

    // Breadcrumb
    const sep = '<span class="sep" aria-hidden="true"></span>';
    $('#courseBreadcrumb').innerHTML =
      `<a href="/">StudyCore</a>${sep}<a href="/pages/courses.html">My Courses</a>${sep}<span class="current">${escapeHtml(course.code)} — ${escapeHtml(course.name)}</span>`;
    $('#progressHeading').textContent = `Your progress in ${course.code}`;

    setStats({
      topics: data.topics.length,
      lessons: data.progress.totalCount,
      videos: data.lectures.length,
      papers: data.pastPapers.length
    });

    if (data.streak > 0) {
      $('#courseStreakSlot').innerHTML = `<span class="course-streak-pill">${SC.icon('flame', { size: 16 })} ${data.streak} day study streak</span>`;
    }

    // Continue learning
    const cont = data.continueLearning;
    if (cont) {
      $('#continueSection').style.display = '';
      const contItem = { ...cont, courseCode: course.code, courseSlug: course.slug };
      $('#continueCard').innerHTML = `
        <span class="cc-icon">${SC.icon(cont.category === 'video' ? 'play' : 'file-text', { size: 24 })}</span>
        <span class="cc-body">
          <span class="cc-eyebrow">Continue where you left off${cont.via === 'recent' ? ' · recent' : ''}</span>
          <h4>${escapeHtml(cont.title)}</h4>
          ${cont.topic ? `<span class="lesson-type">${SC.icon('layers', { size: 12 })} ${escapeHtml(cont.topic)}</span>` : ''}
          ${cont.videoPosition ? `<div class="progress progress-thin" style="max-width:260px;margin-top:8px;"><span style="width:${Math.round((cont.videoPosition / Math.max(1, cont.videoDuration)) * 100)}%"></span></div>` : ''}
        </span>
        <a class="btn btn-primary" href="${SC.resourceHref(contItem, course.name)}">
          ${cont.completed ? 'Review lesson' : 'Continue lesson'} ${SC.icon('arrow-right', { size: 16 })}
        </a>`;
    }

    // Term cards
    $('#videoTermGrid').innerHTML = (data.videoTerms || []).map((group) => {
      const n = group.lessons.length;
      return termCardHtml(group.term, n === 0
        ? `No videos published for ${group.term} yet.`
        : `${n} video ${n === 1 ? 'lesson' : 'lessons'} in this course`);
    }).join('');

    // Topics
    $('#topicGrid').innerHTML = data.topics.length
      ? data.topics.map((t) => `
          <a class="topic-card" href="#${topicAnchor(t.name)}">
            <span class="card-icon">${SC.icon('layers', { size: 20 })}</span>
            <span class="topic-card-body"><h4>${escapeHtml(t.name)}</h4><p>${t.completed} of ${t.total} lessons complete</p></span>
            <span class="topic-card-progress">
              <div class="progress-labels"><span>${t.percent}%</span></div>
              <div class="progress progress-thin"><span style="width:${t.percent}%"></span></div>
            </span>
          </a>`).join('')
      : emptyState({ icon: 'layers', title: 'Topics coming soon', body: 'Lessons for this course are being organised into topics.' });

    // Lessons grouped by topic
    const groups = data.topics.length ? data.topics : [{ name: 'All lessons', lessons: data.lessons }];
    $('#lessonList').innerHTML = groups.length
      ? groups.map((g) => `
          <div class="term-group" id="${topicAnchor(g.name)}" style="scroll-margin-top:calc(var(--nav-h) + var(--nav-float) + 80px);">
            <h3 class="term-group-heading">${escapeHtml(g.name)} <span class="resource-meta">${g.completed} / ${g.total} complete</span></h3>
            ${g.lessons.map((l) => rowHtml(l, course)).join('')}
          </div>`).join('')
      : emptyState({ icon: 'play', title: 'No lessons yet', body: 'Lessons for this course will appear here as soon as they are published.' });

    // Resources
    const bookmarked = await loadBookmarkedIds();
    const resItems = [...data.notes, ...data.tutorials];
    $('#resourceGrid').innerHTML = resItems.length
      ? resItems.map((r) => resourceCard({ ...r, courseCode: course.code, courseSlug: course.slug }, bookmarked)).join('')
      : emptyState({ icon: 'file-text', title: 'No resources yet', body: `New ${escapeHtml(course.code)} notes and tutorials will appear here soon.` });
    bindCardInteractions($('#resourceGrid'));

    // Past papers
    const papers = [...data.pastPapers].sort((a, b) => String(b.yearLevel || '').localeCompare(String(a.yearLevel || '')));
    const paperGroups = new Map();
    for (const p of papers) {
      const year = p.yearLevel ? String(p.yearLevel) : 'All years';
      if (!paperGroups.has(year)) paperGroups.set(year, []);
      paperGroups.get(year).push(p);
    }
    $('#paperGrid').innerHTML = papers.length
      ? [...paperGroups.entries()].map(([year, items]) => `
          <div style="grid-column:1/-1;">
            <h3 style="margin-bottom:14px;font-size:1.05rem;">${escapeHtml(year)} ${items.length > 1 ? `<span class="resource-meta">(${items.length} papers)</span>` : ''}</h3>
            <div class="resource-grid">${items.map((r) => resourceCard({ ...r, courseCode: course.code, courseSlug: course.slug }, bookmarked)).join('')}</div>
          </div>`).join('')
      : emptyState({ icon: 'file', title: 'No past papers yet', body: `Past papers for ${escapeHtml(course.code)} will appear here soon.` });
    bindCardInteractions($('#paperGrid'));

    // Announcements
    if (data.announcements && data.announcements.length) {
      $('#course-announcements').style.display = '';
      $('#courseAnnouncementsList').innerHTML = data.announcements.map((a) => `
        <div class="activity-item" style="cursor:pointer;" data-ann="${a.id}">
          <span class="act-icon" style="${a.pinned ? 'background:var(--amber-100);color:var(--amber-600);' : ''}">${a.pinned ? SC.icon('crown', { size: 15 }) : SC.icon('bell', { size: 15 })}</span>
          <span class="act-body">
            <strong>${escapeHtml(a.title)}</strong>
            <span>${a.description ? escapeHtml(a.description) : ''} · ${formatDate(a.createdAt)}</span>
          </span>
        </div>`).join('');
      $('#courseAnnouncementsList').querySelectorAll('[data-ann]').forEach((el) => {
        el.addEventListener('click', () => {
          const ann = data.announcements.find((x) => x.id === el.getAttribute('data-ann'));
          if (ann && window.SCLayout && window.SCLayout.openAnnouncementModal) {
            StudyCoreAPI.markNotificationRead(ann.id).catch(() => {});
            window.SCLayout.openAnnouncementModal(ann);
          }
        });
      });
    }

    // Progress panel
    const topicsHtml = data.topics.map((t) => `
      <div style="margin-bottom:14px;">
        <div class="progress-labels"><span>${escapeHtml(t.name)}</span><span>${t.completed}/${t.total} · ${t.percent}%</span></div>
        <div class="progress progress-thin"><span style="width:${t.percent}%"></span></div>
      </div>`).join('');
    $('#progressPanel').innerHTML = `
      <div class="card card-pad" style="max-width:680px;margin:0 auto;">
        <div class="progress-labels" style="font-size:0.95rem;"><strong>${escapeHtml(course.code)} — ${escapeHtml(course.name)}</strong><strong>${data.progress.percent}% complete</strong></div>
        <div class="progress" style="height:12px;margin-bottom:22px;"><span style="width:${data.progress.percent}%"></span></div>
        ${topicsHtml || '<p>No topics yet.</p>'}
        <div style="display:flex;gap:22px;flex-wrap:wrap;margin-top:20px;padding-top:16px;border-top:1px solid var(--border);">
          <div><div style="font-family:var(--font-display);font-weight:800;font-size:1.3rem;">${data.progress.completedCount}</div><div style="font-size:0.78rem;color:var(--muted);">Lessons completed</div></div>
          <div><div style="font-family:var(--font-display);font-weight:800;font-size:1.3rem;">${data.progress.totalCount}</div><div style="font-size:0.78rem;color:var(--muted);">Total lessons</div></div>
          <div><div style="font-family:var(--font-display);font-weight:800;font-size:1.3rem;">${data.streak}</div><div style="font-size:0.78rem;color:var(--muted);">Day streak</div></div>
        </div>
      </div>`;

    if (data.progress.courseComplete) {
      $('#completionSection').style.display = '';
      $('#completionBanner').innerHTML = `
        <div class="trophy">${SC.icon('award', { size: 38 })}</div>
        <h2>${escapeHtml(course.code)} Complete</h2>
        <p>You have completed every lesson in this course. Well done — review anything you like, or explore another course.</p>
        <div class="cb-stats">
          <div><div class="num">${data.progress.completedCount}</div><div class="label">Lessons completed</div></div>
          <div><div class="num">${data.topics.length}</div><div class="label">Topics</div></div>
          <div><div class="num">${data.streak}</div><div class="label">Day streak</div></div>
        </div>
        <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;">
          <a class="btn btn-amber" href="#lessons">Review Course</a>
          <a class="btn btn-on-dark" href="/pages/courses.html">Explore Another Course</a>
        </div>`;
    }

    if (cont) {
      const cta = $('#courseCtaPrimary');
      cta.href = SC.resourceHref({ ...cont, courseCode: course.code, courseSlug: course.slug }, course.name);
      cta.textContent = cont.completed ? 'Review Course' : 'Continue Learning';
    }

    // Section nav highlighting
    wireSectionNav();
  }

  function wireSectionNav() {
    const sectionIds = ['topics', 'video-lessons', 'lessons', 'resources', 'past-papers', 'progress'];
    const sections = sectionIds.map((id) => document.getElementById(id)).filter(Boolean);
    const links = [...document.querySelectorAll('#courseSubnav a')];
    const jump = $('#courseJump');
    const setCurrent = (id) => {
      links.forEach((link) => {
        const active = link.getAttribute('href') === `#${id}`;
        link.classList.toggle('active', active);
      });
      if (jump) jump.value = `#${id}`;
    };
    if (jump) jump.addEventListener('change', () => {
      const target = document.getElementById(jump.value.slice(1));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    if ('IntersectionObserver' in window && sections.length) {
      const io = new IntersectionObserver((entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setCurrent(visible.target.id);
      }, { rootMargin: '-28% 0px -62% 0px', threshold: [0, 0.01, 0.25] });
      sections.forEach((s) => io.observe(s));
    }
    if (location.hash) {
      setTimeout(() => {
        let id = location.hash.slice(1);
        try { id = decodeURIComponent(id); } catch { return; }
        const target = document.getElementById(id);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 250);
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const user = await StudyCoreAuth.fetchSession();
    if (!user) { window.location.href = '/login.html'; return; }
    try {
      const data = await StudyCoreAPI.programCourseHome(key);
      await render(data);
    } catch (err) {
      $('#topicGrid').innerHTML = emptyState({
        icon: err.status === 403 ? 'lock' : 'alert-triangle',
        title: err.status === 403 ? 'This course is not part of your program' : 'Could not load this course',
        body: err.status === 403
          ? 'Your program determines which courses you can access. Head to My Courses to see what is available to you.'
          : escapeHtml(err.message),
        cta: '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;"><a class="btn btn-primary" href="/pages/courses.html">My Courses</a></div>'
      });
      $('#courseTitle').textContent = 'Course';
    }
  });
})();
