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
      html += `${sep}<a href="/pages/subjects/${slug}.html#${String(lesson.topic).toLowerCase().replace(/[^a-z0-9]+/g, '-')}">${escapeHtml(lesson.topic)}</a>`;
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
    const given = String(lesson.mimeType || '').trim();
    if (given && given !== 'application/octet-stream') return given;
    const name = String(lesson.fileName || '').toLowerCase();
    if (name.endsWith('.pdf')) return 'application/pdf';
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.gif')) return 'image/gif';
    if (name.endsWith('.txt')) return 'text/plain';
    if (name.endsWith('.csv')) return 'text/csv';
    return given;
  }

  function renderViewerError(host, title, body) {
    host.innerHTML = emptyState({ icon: 'alert-triangle', title, body });
  }

  /* ── Document viewer ────────────────────── */
  // Progressive: the iframe / img points at the authorized stream URL so the
  // browser can range-request the file. We never download the whole PDF into
  // a blob first — that was the main reason large notes sat on a spinner.
  async function initDocumentViewer(lesson) {
    const host = $('#lessonPlayerHost');
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

    const stream = StudyCoreAPI.streamUrl(lesson.id);
    const mime = inferClientMime(lesson);
    const isPdf = mime.startsWith('application/pdf') || /\.pdf$/i.test(lesson.fileName || '');
    const isImage = mime.startsWith('image/');
    const isText = mime.startsWith('text/');

    function paintChrome(stageInner) {
      host.innerHTML = `
        <div class="card doc-viewer" id="scDocViewer">
          <div class="doc-viewer-head">
            ${SC.icon('file-text', { size: 17 })}
            <strong class="doc-viewer-title">${escapeHtml(lesson.title)}</strong>
            <span class="resource-meta">${lesson.fileSize ? formatFileSize(lesson.fileSize) : ''} · StudyCore Document Viewer</span>
            <div class="doc-viewer-toolbar" id="scDocToolbar"></div>
          </div>
          <div class="doc-viewer-stage" id="scDocStage">${stageInner}</div>
        </div>`;
    }

    if (!isPdf && !isImage && !isText) {
      paintChrome(`
        <div class="empty-state" style="border:none;background:var(--bg-alt);margin:14px;">
          <div class="empty-icon">${SC.icon('file', { size: 28 })}</div>
          <h3>Preview not available in-browser</h3>
          <p>This file type (${escapeHtml(mime || 'unknown')}) can't be rendered directly in the StudyCore viewer. Ask your admin if a PDF or image version is available.</p>
        </div>`);
      return;
    }

    paintChrome(`
      <div class="doc-viewer-status" id="scDocLoading">
        <div class="player-spinner"></div>
        <p>Opening document…</p>
      </div>`);

    const OPEN_MS = 18000;
    let opened = false;
    const failTimer = setTimeout(() => {
      if (!opened) showDocError('This document is taking too long to open. Check your connection and try again.');
    }, OPEN_MS);

    function showDocError(message) {
      clearTimeout(failTimer);
      opened = true;
      const stage = host.querySelector('#scDocStage');
      if (!stage) {
        renderViewerError(host, 'Document unavailable', message);
        return;
      }
      stage.innerHTML = `
        <div class="doc-viewer-status doc-viewer-error">
          ${SC.icon('alert-triangle', { size: 36 })}
          <h3>Document unavailable</h3>
          <p>${escapeHtml(message)}</p>
          <button class="btn btn-teal btn-sm" type="button" id="scDocRetry">${SC.icon('refresh', { size: 15 })} Try again</button>
        </div>`;
      const retry = stage.querySelector('#scDocRetry');
      if (retry) retry.addEventListener('click', () => initDocumentViewer(lesson));
    }

    async function probeStream() {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      try {
        let res = await fetch(stream, { method: 'HEAD', credentials: 'include', signal: ctrl.signal });
        if (res.status === 405 || res.status === 501) {
          res = await fetch(stream, {
            method: 'GET',
            credentials: 'include',
            headers: { Range: 'bytes=0-0' },
            signal: ctrl.signal
          });
          if (res.body && typeof res.body.cancel === 'function') {
            try { await res.body.cancel(); } catch { /* already closed */ }
          }
        }
        return res;
      } finally {
        clearTimeout(t);
      }
    }

    let probe;
    try {
      probe = await probeStream();
    } catch (err) {
      console.error('[StudyCore reader] probe failed', err);
      showDocError(err.name === 'AbortError'
        ? 'The document server did not respond in time.'
        : (err.message || 'Could not reach the document. Check your connection and try again.'));
      return;
    }

    if (!probe.ok && probe.status !== 206) {
      let message = 'This document could not be opened.';
      if (probe.status === 401) message = 'Please log in again to open this document.';
      else if (probe.status === 403) message = 'You do not have access to this document with your current plan.';
      else if (probe.status === 404) message = 'This document is missing from storage.';
      else if (probe.status === 503) message = 'File storage is not configured yet, so this file cannot be opened.';
      try {
        const data = await probe.json();
        if (data && data.message) message = data.message;
      } catch { /* not JSON */ }
      console.error('[StudyCore reader] probe status', probe.status, message);
      showDocError(message);
      return;
    }

    const servedType = (probe.headers.get('content-type') || mime || '').split(';')[0].trim();
    const asPdf = isPdf || servedType === 'application/pdf';
    const asImage = isImage || servedType.startsWith('image/');
    const asText = isText || servedType.startsWith('text/');

    const toolbar = host.querySelector('#scDocToolbar');
    const stage = host.querySelector('#scDocStage');
    const viewer = host.querySelector('#scDocViewer');
    let zoom = 100;
    let page = 1;
    const ZOOM_MIN = 75;
    const ZOOM_MAX = 200;

    function toolbarHtml() {
      return `
        ${asPdf ? `
          <button type="button" class="icon-btn" id="scDocPrev" aria-label="Previous page">${SC.icon('arrow-left', { size: 16 })}</button>
          <span class="doc-page-label" id="scDocPage">Page ${page}</span>
          <button type="button" class="icon-btn" id="scDocNext" aria-label="Next page">${SC.icon('arrow-right', { size: 16 })}</button>
        ` : ''}
        <button type="button" class="icon-btn" id="scDocZoomOut" aria-label="Zoom out">${SC.icon('zoom-out', { size: 16 })}</button>
        <span class="doc-zoom-label" id="scDocZoom">${zoom}%</span>
        <button type="button" class="icon-btn" id="scDocZoomIn" aria-label="Zoom in">${SC.icon('zoom-in', { size: 16 })}</button>
        <button type="button" class="icon-btn" id="scDocFit" aria-label="Fit width">${SC.icon('minimize', { size: 16 })}</button>
        <button type="button" class="icon-btn" id="scDocFs" aria-label="Fullscreen">${SC.icon('maximize', { size: 16 })}</button>
      `;
    }

    function pdfSrc() {
      return `${stream}#page=${page}&zoom=${zoom}&toolbar=1&navpanes=0&view=FitH`;
    }

    function applyZoom() {
      const label = host.querySelector('#scDocZoom');
      if (label) label.textContent = `${zoom}%`;
      const canvas = host.querySelector('#scDocCanvas');
      if (canvas) canvas.style.transform = `scale(${zoom / 100})`;
    }

    function markOpen() {
      if (opened) return;
      opened = true;
      clearTimeout(failTimer);
      const loading = host.querySelector('#scDocLoading');
      if (loading) loading.hidden = true;
    }

    function bindToolbar() {
      const prev = host.querySelector('#scDocPrev');
      const next = host.querySelector('#scDocNext');
      const pageLabel = host.querySelector('#scDocPage');
      if (prev) prev.addEventListener('click', () => {
        page = Math.max(1, page - 1);
        if (pageLabel) pageLabel.textContent = `Page ${page}`;
        const frame = host.querySelector('#scDocFrame');
        if (frame) frame.src = pdfSrc();
      });
      if (next) next.addEventListener('click', () => {
        page += 1;
        if (pageLabel) pageLabel.textContent = `Page ${page}`;
        const frame = host.querySelector('#scDocFrame');
        if (frame) frame.src = pdfSrc();
      });
      host.querySelector('#scDocZoomOut').addEventListener('click', () => {
        zoom = Math.max(ZOOM_MIN, zoom - 25);
        applyZoom();
      });
      host.querySelector('#scDocZoomIn').addEventListener('click', () => {
        zoom = Math.min(ZOOM_MAX, zoom + 25);
        applyZoom();
      });
      host.querySelector('#scDocFit').addEventListener('click', () => {
        zoom = 100;
        applyZoom();
      });
      host.querySelector('#scDocFs').addEventListener('click', () => {
        const docFs = document.fullscreenElement || document.webkitFullscreenElement;
        if (docFs) {
          const exit = document.exitFullscreen || document.webkitExitFullscreen;
          if (exit) exit.call(document);
          return;
        }
        const req = viewer.requestFullscreen || viewer.webkitRequestFullscreen;
        if (req) req.call(viewer);
      });
    }

    if (asPdf) {
      if (toolbar) toolbar.innerHTML = toolbarHtml();
      stage.insertAdjacentHTML('beforeend', `
        <div class="doc-viewer-scroll">
          <div class="doc-viewer-canvas" id="scDocCanvas">
            <iframe class="doc-viewer-frame" id="scDocFrame" src="${pdfSrc()}" title="${escapeHtml(lesson.title)}"></iframe>
          </div>
        </div>`);
      const frame = host.querySelector('#scDocFrame');
      frame.addEventListener('load', markOpen);
      bindToolbar();
      return;
    }

    if (asImage) {
      if (toolbar) toolbar.innerHTML = toolbarHtml();
      stage.insertAdjacentHTML('beforeend', `
        <div class="doc-viewer-scroll doc-viewer-image">
          <div class="doc-viewer-canvas" id="scDocCanvas">
            <img id="scDocImage" src="${stream}" alt="${escapeHtml(lesson.title)}" />
          </div>
        </div>`);
      const img = host.querySelector('#scDocImage');
      img.addEventListener('load', markOpen);
      img.addEventListener('error', () => showDocError('This image could not be displayed.'));
      bindToolbar();
      return;
    }

    // Text / CSV — small enough to fetch, but still time-bounded.
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(stream, { credentials: 'include', signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) {
        let message = 'This document could not be opened.';
        try {
          const data = await res.json();
          if (data && data.message) message = data.message;
        } catch { /* not JSON */ }
        showDocError(message);
        return;
      }
      const text = await res.text();
      markOpen();
      if (toolbar) toolbar.innerHTML = toolbarHtml();
      stage.innerHTML = `<pre class="doc-viewer-text"></pre>`;
      stage.querySelector('pre').textContent = text;
      bindToolbar();
    } catch (err) {
      console.error('[StudyCore reader] text load failed', err);
      showDocError(err.name === 'AbortError'
        ? 'The document server did not respond in time.'
        : (err.message || 'Check your connection and try again.'));
    }
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
