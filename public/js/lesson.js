// =============================================
// STUDYCORE — Lesson Experience (js/lesson.js)
// -----------------------------------------------
// The continuous learning flow:
//   StudyCore → Course → Topic → Lesson
// with breadcrumbs, the StudyCore video player
// (Premium) or document viewer, key concepts,
// related resources, mark-complete and
// previous/next navigation.
//
// What is shown is a reflection of
// server-side access: the `locked` flag on the
// lesson is computed in routes/courses.routes.js
// from the user's real subscription state, and
// the stream endpoint enforces the same rules.
// =============================================

(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const lessonId = params.get('id');
  const subjectParam = params.get('subject') || '';

  let flow = null;
  let playerHandle = null;
  let readerHandle = null;

  const $ = (sel) => document.querySelector(sel);

  function metaChips(lesson) {
    const chips = [];
    chips.push(`<span class="lesson-type">${SC.icon(SC.courseCategoryIcon(lesson.category), { size: 13 })} ${CATEGORY_LABELS[lesson.category] || 'Lesson'}</span>`);
    if (lesson.subject) chips.push(`<span class="lesson-type">${SC.icon('library', { size: 13 })} ${escapeHtml(lesson.subject)}</span>`);
    if (lesson.topic && lesson.topic !== 'General') chips.push(`<span class="lesson-type">${SC.icon('layers', { size: 13 })} ${escapeHtml(lesson.topic)}</span>`);
    if (lesson.yearLevel) chips.push(`<span class="lesson-type">${SC.icon('calendar', { size: 13 })} ${escapeHtml(lesson.yearLevel)}</span>`);
    if (lesson.fileSize) chips.push(`<span class="lesson-type">${SC.icon('file', { size: 13 })} ${formatFileSize(lesson.fileSize)}</span>`);
    return chips.join('');
  }

  function renderBreadcrumb(lesson) {
    const bc = $('#lessonBreadcrumb');
    const sep = '<span class="sep" aria-hidden="true"></span>';
    const slug = subjectSlug(lesson.subject || subjectParam);
    let html = `<a href="/">StudyCore</a>${sep}<a href="/pages/courses.html">Courses</a>`;
    if (slug) html += `${sep}<a href="/pages/subjects/${slug}.html">${escapeHtml(lesson.subject || subjectParam)}</a>`;
    if (lesson.topic && lesson.topic !== 'General') {
      html += `${sep}<a href="/pages/subjects/${slug}.html#lesson-topic-${String(lesson.topic).toLowerCase().replace(/[^a-z0-9]+/g, '-')}">${escapeHtml(lesson.topic)}</a>`;
    }
    html += `${sep}<span class="current">${escapeHtml(lesson.title)}</span>`;
    bc.innerHTML = html;
    document.title = `${lesson.title} | ${lesson.subject || 'StudyCore'} | StudyCore`;
  }

  function renderHeader(lesson) {
    $('#lessonIcon').innerHTML = SC.icon(SC.courseCategoryIcon(lesson.category), { size: 26 });
    $('#lessonTitle').textContent = lesson.title;
    $('#lessonMeta').innerHTML = metaChips(lesson);
  }

  /* ── Video player (Premium) ─────────────── */
  function initVideoPlayer(lesson, accessPremium) {
    const host = $('#lessonPlayerHost');
    if (lesson.locked) {
      playerHandle = StudyCorePlayer.init(host, {
        resourceId: lesson.id,
        title: lesson.title,
        premium: false,
        lockText: lesson.locked === 'video'
          ? 'This video is available exclusively to StudyCore Premium students. Upgrade to unlock it and keep learning.'
          : 'Your free access period has ended. Upgrade to StudyCore Premium to watch this video.'
      });
      return;
    }
    playerHandle = StudyCorePlayer.init(host, {
      resourceId: lesson.id,
      title: lesson.title,
      premium: accessPremium,
      onComplete: async () => {
        setCompleted(true);
        showToast('Lesson complete — nicely done.', 'success');
      }
    });
  }

  function inferClientMime(lesson) {
    const rawGiven = String(lesson.mimeType || '').trim();
    const given = rawGiven.toLowerCase().split(';')[0].trim();
    // If the server gave us a real mime (not octet-stream), trust it.
    if (given && given !== 'application/octet-stream' && given !== 'binary/octet-stream' && given !== '') {
      return given;
    }
    const name = String(lesson.fileName || '').toLowerCase();
    if (name.endsWith('.pdf')) return 'application/pdf';
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.gif')) return 'image/gif';
    if (name.endsWith('.txt')) return 'text/plain';
    if (name.endsWith('.csv')) return 'text/csv';
    // Bare UUID filenames (e.g. "9735a310-575d-469d-9fbb-1f720e13c396")
    // happen when a mobile browser uploaded without an extension.
    // Those files are overwhelmingly PDFs in StudyCore — treat them as PDF
    // rather than leaving them as octet-stream, which made the reader show
    // "Preview not available" and forced Android to show an "Open with
    // <uuid>" system dialog.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(lesson.fileName || '').trim())) {
      return 'application/pdf';
    }
    // For document-category lessons, default to PDF when mime is unknown —
    // the server's sniff will still set the correct Content-Type header, and
    // the reader will try PDF first.
    if (lesson.category === 'document' || lesson.category === 'tutorial' || lesson.category === 'past_paper') {
      return 'application/pdf';
    }
    return rawGiven || 'application/pdf';
  }

  /* ── Document viewer ────────────────────── */
  // Rendering is delegated to StudyCoreReader (js/doc-reader.js), which
  // decodes the PDF with the self-hosted pdf.js engine and paints pages to
  // canvas. The previous implementation embedded the stream URL in an
  // <iframe> and relied on the browser's native PDF plugin — desktop
  // browsers have one, mobile browsers do not, which is exactly why notes
  // opened on a laptop and showed a blank box on a phone.
  function initDocumentViewer(lesson) {
    const host = $('#lessonPlayerHost');
    if (readerHandle) { readerHandle.destroy(); readerHandle = null; }

    if (lesson.locked) {
      host.innerHTML = `
        <div class="player-shell lock-wall">
          <div class="player-premium-lock">
            <div class="lock-ring">${SC.icon('lock', { size: 32 })}</div>
            <h3>Premium Resource</h3>
            <p>Your free access period has ended. Upgrade to StudyCore Premium to continue reading this resource.</p>
            <a class="btn btn-amber" href="/dashboard.html#premium">${SC.icon('crown', { size: 17 })} Upgrade to Premium</a>
          </div>
        </div>`;
      return;
    }

    readerHandle = StudyCoreReader.init(host, {
      url: StudyCoreAPI.streamUrl(lesson.id),
      title: lesson.title,
      fileSize: lesson.fileSize,
      fileName: lesson.fileName,
      mimeType: inferClientMime(lesson),
      // Only offered by the reader when a file can't be previewed
      // in-browser (e.g. PowerPoint). The endpoint applies the same
      // server-side access checks as the stream, so nothing new is exposed.
      downloadUrl: StudyCoreAPI.downloadUrl(lesson.id)
    });
  }

  /* ── About + key concepts ───────────────── */
  function renderAbout(lesson) {
    const about = $('#aboutCard');
    if (!lesson.description) { about.style.display = 'none'; return; }
    about.innerHTML = `
      <h3 style="margin-bottom:8px;">About this lesson</h3>
      <p style="white-space:pre-wrap;">${escapeHtml(lesson.description)}</p>
      ${lesson.tags && lesson.tags.length ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">
          ${lesson.tags.map((t) => `<span class="chip" style="cursor:default;">${escapeHtml(t)}</span>`).join('')}
        </div>` : ''}`;
    const concepts = $('#keyConcepts');
    // Prefer individual sentences; fall back to the whole (short) description
    // so the card still shows something useful.
    let points = (lesson.description.match(/(?:[A-Z0-9][^.\n]{15,120})\./g) || []).slice(0, 5);
    if (!points.length && lesson.description.trim().length >= 10) points = [lesson.description.trim()];
    if (points.length) {
      $('#conceptsCard').hidden = false;
      $('#conceptsCard h3 span').innerHTML = SC.icon('sparkles', { size: 18 });
      concepts.innerHTML = points.map((p) => `<li>${SC.icon('check', { size: 15 })}<span>${escapeHtml(p.trim())}</span></li>`).join('');
    }
  }

  /* ── Related resources ──────────────────── */
  async function renderRelated(lesson) {
    const card = $('#relatedCard');
    const grid = $('#relatedGrid');
    let items = [];
    try {
      // Same topic first, then same subject of the same type
      const byTopic = await StudyCoreAPI.listResources({ subject: lesson.subject, topic: lesson.topic, pageSize: 12 });
      items = (byTopic.resources || []).filter((r) => r.id !== lesson.id && r.category !== 'announcement');
      if (items.length < 3) {
        const bySubject = await StudyCoreAPI.listResources({ subject: lesson.subject, excludeCategory: 'announcement,video', pageSize: 12 });
        for (const r of (bySubject.resources || [])) {
          if (r.id !== lesson.id && !items.find((x) => x.id === r.id)) items.push(r);
        }
      }
    } catch { return; }
    items = items.slice(0, 4);
    if (!items.length) { card.style.display = 'none'; return; }
    try {
      const bm = await StudyCoreAPI.myBookmarks();
      renderRelatedItems(items, new Set(bm.resources.map((r) => r.id)));
    } catch {
      renderRelatedItems(items, new Set());
    }
  }

  function renderRelatedItems(items, bookmarked) {
    $('#relatedCard').hidden = false;
    $('#relatedGrid').innerHTML = items.map((r) => resourceCard(r, bookmarked)).join('');
    bindCardInteractions($('#relatedGrid'));
  }

  /* ── Complete bar + nav ─────────────────── */
  function renderCompleteBar(lesson) {
    const bar = $('#completeBar');
    bar.classList.toggle('done', lesson.completed);
    bar.innerHTML = `
      <div>
        <strong style="font-family:var(--font-display);color:var(--ink);">${lesson.completed ? 'Lesson completed' : 'Finished with this lesson?'}</strong>
        <p style="font-size:0.85rem;margin-top:2px;">${lesson.completed
          ? 'Marked complete. You can review it any time.'
          : 'Mark it complete to track your progress and move on.'}</p>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn ${lesson.completed ? 'btn-outline' : 'btn-teal'}" id="toggleCompleteBtn">
          ${SC.icon(lesson.completed ? 'check-circle' : 'check', { size: 17 })}
          ${lesson.completed ? 'Mark as not complete' : 'Mark as Complete'}
        </button>
        ${flow.next ? `<a class="btn btn-primary" href="/pages/lesson.html?id=${flow.next.id}&subject=${encodeURIComponent(flow.next.subject || lesson.subject)}">Next Lesson ${SC.icon('arrow-right', { size: 16 })}</a>` : ''}
      </div>`;
    document.getElementById('toggleCompleteBtn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        if (lesson.completed) {
          await StudyCoreAPI.markIncomplete(lesson.id);
          setCompleted(false);
          showToast('Marked as not complete.', 'info');
        } else {
          await StudyCoreAPI.markComplete(lesson.id);
          setCompleted(true);
          showToast('Lesson complete — nicely done.', 'success');
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function setCompleted(value) {
    if (!flow) return;
    flow.lesson.completed = value;
    renderCompleteBar(flow.lesson);
    renderNavCard(flow);
  }

  function renderNavCard(flowData) {
    const card = $('#navCard');
    const lesson = flowData.lesson;
    const prev = flowData.previous, next = flowData.next;
    const slot = (label, item) => item ? `
      <a class="nav-slot" href="/pages/lesson.html?id=${item.id}&subject=${encodeURIComponent(item.subject || lesson.subject)}">
        <span>${SC.icon(label === 'Previous' ? 'arrow-left' : 'arrow-right', { size: 16 })}</span>
        <span style="min-width:0;">
          <span class="dir">${label} lesson</span>
          <span class="slot-title" style="display:block;">${escapeHtml(item.title)}</span>
        </span>
      </a>` : `
      <div class="nav-slot disabled">
        <span>${SC.icon(label === 'Previous' ? 'arrow-left' : 'arrow-right', { size: 16 })}</span>
        <span style="min-width:0;">
          <span class="dir">${label} lesson</span>
          <span class="slot-title" style="display:block;">${label === 'Previous' ? 'This is the first lesson' : 'You have reached the end'}</span>
        </span>
      </div>`;
    card.innerHTML = `
      ${slot('Previous', prev)}
      <div class="nav-slot" style="justify-content:center;cursor:default;">
        <span class="slot-title">Lesson ${flowData.index + 1} of ${flowData.total} in ${escapeHtml(lesson.subject || 'this course')}</span>
      </div>
      ${slot('Next', next)}`;
  }

  async function renderTopicProgress(lesson) {
    if (!lesson.topic || lesson.topic === 'General') return;
    try {
      const data = await StudyCoreAPI.courseHome(lesson.subject || subjectParam);
      const t = (data.topics || []).find((x) => x.name === lesson.topic);
      if (!t) return;
      const card = $('#topicProgressCard');
      card.hidden = false;
      card.innerHTML = `
        <h3 style="margin-bottom:12px;display:flex;align-items:center;gap:9px;">${SC.icon('layers', { size: 18 })} Topic progress</h3>
        <div class="progress-labels"><span>${escapeHtml(t.name)}</span><strong>${t.percent}%</strong></div>
        <div class="progress" style="margin-bottom:10px;"><span style="width:${t.percent}%"></span></div>
        <p style="font-size:0.82rem;">${t.completed} of ${t.total} lessons complete in this topic.</p>`;
    } catch { /* non-fatal */ }
  }

  /* ── Boot ───────────────────────────────── */
  async function initLessonPage() {
    const user = await StudyCoreAuth.fetchSession();
    if (!user) { window.location.href = '/login.html'; return; }
    if (!lessonId) {
      $('#lessonContent').hidden = false;
      $('#lessonLoading').hidden = true;
      $('#lessonPlayerHost').innerHTML = emptyState({ icon: 'alert-triangle', title: 'No lesson specified', body: 'Open a lesson from a course page instead.' });
      return;
    }

    try {
      flow = await StudyCoreAPI.lessonFlow(lessonId);
    } catch (err) {
      $('#lessonContent').hidden = false;
      $('#lessonLoading').hidden = true;
      $('#lessonPlayerHost').innerHTML = emptyState({ icon: 'alert-triangle', title: 'Could not open this lesson', body: escapeHtml(err.message) });
      return;
    }

    const lesson = flow.lesson;
    renderBreadcrumb(lesson);
    renderHeader(lesson);
    $('#lessonLoading').hidden = true;
    $('#lessonContent').hidden = false;

    const isVideo = lesson.category === 'video';
    if (isVideo) initVideoPlayer(lesson, !lesson.locked);
    else initDocumentViewer(lesson);

    renderAbout(lesson);
    renderCompleteBar(lesson);
    renderNavCard(flow);
    renderTopicProgress(lesson);
    renderRelated(lesson);
  }

  document.addEventListener('DOMContentLoaded', initLessonPage);
})();
