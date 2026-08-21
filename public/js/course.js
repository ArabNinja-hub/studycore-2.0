// =============================================
// STUDYCORE — Course Home (js/course.js)
// -----------------------------------------------
// Powers every /pages/subjects/<slug>.html page:
// course hero stats, topic grid, lesson list,
// resources, past papers and progress.
//
// Anonymous visitors see the public course
// structure (counts + topics from GET
// /api/courses). Logged-in students get their
// real progress, continue-learning and locked
// states from GET /api/courses/:subject -
// access flags are computed server-side.
// =============================================

(function () {
  'use strict';

  const slug = document.body.dataset.subjectSlug;
  const subject = document.body.dataset.subject || slug;
  const $ = (sel) => document.querySelector(sel);

  // Hero visual + icon
  SC.Hero.init($('#courseHero'), slug);
  $('#courseHeroIcon').innerHTML = SC.icon(SC.courseIcon(slug), { size: 30 });

  const topicAnchor = (name) => `lesson-topic-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  function setStats(values) {
    document.querySelectorAll('[data-stat]').forEach((el) => {
      el.textContent = values[el.getAttribute('data-stat')] ?? '0';
    });
  }

  function renderStreak(streak) {
    const slot = $('#courseStreakSlot');
    if (!slot) return;
    if (streak > 0) {
      slot.innerHTML = `<span class="course-streak-pill">${SC.icon('flame', { size: 16 })} ${streak} day study streak</span>`;
    }
  }

  const fmtTime = (s) => (typeof StudyCorePlayer !== 'undefined' ? StudyCorePlayer.fmtTime(s) : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

  function lessonRowHtml(item) {
    const icon = item.completed
      ? SC.icon('check', { size: 16 })
      : (item.locked ? SC.icon('lock', { size: 15 }) : SC.icon(SC.courseCategoryIcon(item.category), { size: 15 }));
    const meta = [item.subject && '', item.topic, item.yearLevel].filter(Boolean).map(escapeHtml).join(' · ');
    const resume = item.videoPosition ? `<span class="lesson-type" style="color:var(--teal-600);">${SC.icon('play', { size: 12 })} Resume at ${fmtTime(item.videoPosition)}</span>` : '';
    const cta = item.locked
      ? `<a class="btn btn-amber btn-sm" href="/pages/pricing.html">${SC.icon('crown', { size: 14 })} Premium</a>`
      : `<span class="lesson-type">${CATEGORY_LABELS[item.category] || 'Resource'}</span>`;
    return `
      <a class="lesson-row ${item.completed ? 'completed' : ''} ${item.locked ? 'locked' : ''}"
         href="/pages/lesson.html?id=${item.id}&subject=${encodeURIComponent(item.subject || subject)}"
         data-topic-anchor="${escapeHtml(topicAnchor(item.topic || 'General'))}">
        <span class="lesson-status">${icon}</span>
        <span class="lesson-row-main">
          <span class="lesson-row-title">${escapeHtml(item.title)}</span>
          <span class="lesson-row-meta">
            <span>${meta || CATEGORY_LABELS[item.category] || ''}</span>${resume}
          </span>
        </span>
        <span class="lesson-row-action">${cta}${item.locked ? '' : SC.icon('chevron-right', { size: 17 })}</span>
      </a>
    `;
  }

  /* ── Anonymous / public view ────────────── */
  function renderPublic(course) {
    setStats({
      topics: course.topics.length,
      lessons: course.counts.lessons,
      videos: course.counts.videos,
      papers: course.counts.pastPapers
    });
    $('#topicGrid').innerHTML = course.topics.length
      ? course.topics.map((t) => `
          <a class="topic-card" href="/signup.html" title="Log in to open this topic">
            <span class="card-icon">${SC.icon('layers', { size: 20 })}</span>
            <span class="topic-card-body"><h4>${escapeHtml(t)}</h4><p>Open ${escapeHtml(subject)} to start this topic</p></span>
          </a>`).join('')
      : emptyState({ icon: 'layers', title: 'Topics coming soon', body: 'Lessons for this course are being organised into topics.' });
    $('#lessonList').innerHTML = emptyState({
      icon: 'play', title: 'Lessons appear when you log in',
      body: `Create a free account to open ${escapeHtml(subject)} lessons, notes and past papers — your 30-day trial starts immediately.`,
      cta: '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;"><a class="btn btn-primary" href="/signup.html">Start Free Trial</a><a class="btn btn-outline" href="/login.html">Log In</a></div>'
    });
    $('#resourceGrid').innerHTML = emptyState({ icon: 'file-text', title: 'Study notes', body: 'Log in to read this course\u2019s notes and tutorial sheets.' });
    $('#paperGrid').innerHTML = emptyState({ icon: 'file', title: 'Past papers', body: 'Log in to open this course\u2019s past papers.' });
    $('#progressPanel').innerHTML = `
      <div class="card card-pad" style="max-width:560px;margin:0 auto;text-align:center;">
        <div class="card-icon" style="margin:0 auto 14px;">${SC.icon('trending-up', { size: 22 })}</div>
        <h3>Track your ${escapeHtml(subject)} progress</h3>
        <p style="margin:8px 0 18px;">Course completion, study streaks and achievements unlock as soon as you have an account.</p>
        <a class="btn btn-primary" href="/signup.html">Create Free Account</a>
      </div>`;
  }

  /* ── Logged-in view ─────────────────────── */
  async function renderStudent(data) {
    setStats({
      topics: data.topics.length,
      lessons: data.progress.totalCount,
      videos: data.lectures.length,
      papers: data.pastPapers.length
    });
    renderStreak(data.streak);

    // Continue learning
    const cont = data.continueLearning;
    if (cont) {
      const section = $('#continueSection');
      section.style.display = '';
      $('#continueCard').innerHTML = `
        <span class="cc-icon">${SC.icon(cont.category === 'video' ? 'play' : 'file-text', { size: 24 })}</span>
        <span class="cc-body">
          <span class="cc-eyebrow">Continue where you left off${cont.via === 'recent' ? ' · recent' : ''}</span>
          <h4>${escapeHtml(cont.title)}</h4>
          ${cont.topic ? `<span class="lesson-type">${SC.icon('layers', { size: 12 })} ${escapeHtml(cont.topic)}</span>` : ''}
          ${cont.videoPosition ? `<div class="progress progress-thin" style="max-width:260px;margin-top:8px;"><span style="width:${Math.round((cont.videoPosition / Math.max(1, cont.videoDuration)) * 100)}%"></span></div>` : ''}
        </span>
        <a class="btn btn-primary" href="/pages/lesson.html?id=${cont.id}&subject=${encodeURIComponent(cont.subject || subject)}">
          ${cont.completed ? 'Review lesson' : 'Continue lesson'} ${SC.icon('arrow-right', { size: 16 })}
        </a>
      `;
    }

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

    // Lessons (grouped under topic headers for a clear hierarchy)
    const groups = data.topics.length ? data.topics : [{ name: 'All lessons', lessons: data.lessons }];
    $('#lessonList').innerHTML = groups.length
      ? groups.map((g) => `
          <div class="term-group" id="${topicAnchor(g.name)}" style="scroll-margin-top:130px;">
            <h3 class="term-group-heading">${escapeHtml(g.name)} <span class="resource-meta">${g.completed} / ${g.total} complete</span></h3>
            ${g.lessons.map(lessonRowHtml).join('')}
          </div>`).join('')
      : emptyState({ icon: 'play', title: 'No lessons yet', body: 'Lessons for this course will appear here as soon as they are published.' });

    // Resources (notes + tutorials)
    const resItems = [...data.notes, ...data.tutorials];
    const bookmarked = await loadBookmarkedIds();
    $('#resourceGrid').innerHTML = resItems.length
      ? resItems.map((r) => resourceCard(r, bookmarked)).join('')
      : emptyState({ icon: 'file-text', title: 'No resources yet', body: `New ${escapeHtml(subject)} notes and tutorials will appear here soon.` });
    bindCardInteractions($('#resourceGrid'));

    // Past papers (grouped by year when available)
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
            <div class="resource-grid">${items.map((r) => resourceCard(r, bookmarked)).join('')}</div>
          </div>`).join('')
      : emptyState({ icon: 'file', title: 'No past papers yet', body: `Past papers for ${escapeHtml(subject)} will appear here soon.` });
    bindCardInteractions($('#paperGrid'));

    // Progress panel
    const topicsHtml = data.topics.map((t) => `
      <div style="margin-bottom:14px;">
        <div class="progress-labels"><span>${escapeHtml(t.name)}</span><span>${t.completed}/${t.total} · ${t.percent}%</span></div>
        <div class="progress progress-thin"><span style="width:${t.percent}%"></span></div>
      </div>`).join('');
    $('#progressPanel').innerHTML = `
      <div class="card card-pad" style="max-width:680px;margin:0 auto;">
        <div class="progress-labels" style="font-size:0.95rem;"><strong>${escapeHtml(subject)} overall</strong><strong>${data.progress.percent}% complete</strong></div>
        <div class="progress" style="height:12px;margin-bottom:22px;"><span style="width:${data.progress.percent}%"></span></div>
        ${topicsHtml || '<p>No topics yet.</p>'}
        <div style="display:flex;gap:22px;flex-wrap:wrap;margin-top:20px;padding-top:16px;border-top:1px solid var(--border);">
          <div><div style="font-family:var(--font-display);font-weight:800;font-size:1.3rem;">${data.progress.completedCount}</div><div style="font-size:0.78rem;color:var(--muted);">Lessons completed</div></div>
          <div><div style="font-family:var(--font-display);font-weight:800;font-size:1.3rem;">${data.progress.totalCount}</div><div style="font-size:0.78rem;color:var(--muted);">Total lessons</div></div>
          <div><div style="font-family:var(--font-display);font-weight:800;font-size:1.3rem;">${data.streak}</div><div style="font-size:0.78rem;color:var(--muted);">Day streak</div></div>
        </div>
      </div>`;

    // Completion banner
    if (data.progress.courseComplete) {
      $('#completionSection').style.display = '';
      $('#completionBanner').innerHTML = `
        <div class="trophy">${SC.icon('award', { size: 38 })}</div>
        <h2>${escapeHtml(subject)} Complete</h2>
        <p>You have completed every lesson in this course. Well done — review anything you like, or explore another course.</p>
        <div class="cb-stats">
          <div><div class="num">${data.progress.completedCount}</div><div class="label">Lessons completed</div></div>
          <div><div class="num">${data.topics.length}</div><div class="label">Topics</div></div>
          <div><div class="num">${data.streak}</div><div class="label">Day streak</div></div>
        </div>
        <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;">
          <a class="btn btn-amber" href="#lessons">Review Course</a>
          <a class="btn btn-ghost" style="color:#fff;border:1.5px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.07);" href="/pages/courses.html">Explore Another Course</a>
        </div>`;
    }

    // Primary CTA -> continue
    if (cont) {
      const cta = $('#courseCtaPrimary');
      cta.href = `/pages/lesson.html?id=${cont.id}&subject=${encodeURIComponent(cont.subject || subject)}`;
      cta.textContent = cont.completed ? 'Review Course' : 'Continue Learning';
    }
  }

  async function loadBookmarkedIds() {
    try {
      const { resources } = await StudyCoreAPI.myBookmarks();
      return new Set(resources.map((r) => r.id));
    } catch { return new Set(); }
  }

  /* ── Boot ───────────────────────────────── */
  async function initCoursePage() {
    const user = await StudyCoreAuth.fetchSession();
    if (user) {
      try {
        const data = await StudyCoreAPI.courseHome(subject);
        await renderStudent(data);
      } catch (err) {
        $('#topicGrid').innerHTML = emptyState({ icon: 'alert-triangle', title: 'Could not load this course', body: escapeHtml(err.message) });
      }
    } else {
      try {
        const { courses } = await StudyCoreAPI.listCourses();
        const course = courses.find((c) => c.slug === slug);
        if (course) renderPublic(course);
      } catch { /* hero + overview remain */ }
    }

    // Subnav scroll-spy
    const sections = ['overview', 'topics', 'lessons', 'resources', 'past-papers', 'progress'].map((id) => document.getElementById(id)).filter(Boolean);
    const links = document.querySelectorAll('#courseSubnav a');
    if ('IntersectionObserver' in window && sections.length) {
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            links.forEach((l) => l.classList.toggle('active', l.getAttribute('href') === `#${entry.target.id}`));
          }
        }
      }, { rootMargin: '-30% 0px -60% 0px' });
      sections.forEach((s) => io.observe(s));
    }

    // Topic deep link (#circular-motion)
    if (location.hash) {
      setTimeout(() => {
        const target = document.querySelector(location.hash);
        if (target) target.scrollIntoView({ behavior: 'smooth' });
      }, 250);
    }
  }

  document.addEventListener('DOMContentLoaded', initCoursePage);
})();
