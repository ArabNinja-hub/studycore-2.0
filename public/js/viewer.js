// =============================================
// STUDYCORE — Standalone Document Viewer (js/viewer.js)
// -----------------------------------------------
// Powers /viewer/:documentId. Fetches the resource
// through the existing session-gated API and hands
// the authorized stream URL to StudyCoreReader
// (js/doc-reader.js) in "bare" mode, so the PDF is
// decoded client-side by pdf.js and painted onto
// canvases — identical on desktop and mobile.
//
// Access is enforced entirely by the server:
//   · GET /api/resources/:id        -> metadata + access check
//   · GET /api/resources/:id/stream -> protected, Range-capable reading
// Documents are view-only: the reader exposes no download path or control.
// =============================================

(function () {
  'use strict';

  const DOC_VIEWER_CATEGORIES = ['document', 'tutorial', 'past_paper', 'material'];

  const id = (function resolveId() {
    const m = location.pathname.match(/\/viewer\/([^/?#]+)/);
    if (!m || !m[1]) return null;
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  })();

  let reader = null;
  let resource = null;

  const $ = (sel) => document.querySelector(sel);

  /* ── Small helpers ───────────────────────── */
  function fillIcons() {
    document.querySelectorAll('[data-vicon]').forEach((el) => {
      el.innerHTML = SC.icon(el.getAttribute('data-vicon'), { size: 18 });
    });
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function formatFileSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = Number(bytes), i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  // Mirror the server's content-type normalisation so the reader can skip an
  // extra byte-sniff when the stored mime is a bare UUID / octet-stream.
  function inferMime(res) {
    const rawGiven = String(res.mimeType || '').trim();
    const given = rawGiven.toLowerCase().split(';')[0].trim();
    if (given && given !== 'application/octet-stream' && given !== 'binary/octet-stream' && given !== '') {
      return given;
    }
    const name = String(res.fileName || '').toLowerCase();
    if (name.endsWith('.pdf')) return 'application/pdf';
    if (name.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.gif')) return 'image/gif';
    if (name.endsWith('.txt')) return 'text/plain';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(res.fileName || '').trim())) {
      return 'application/pdf';
    }
    if (DOC_VIEWER_CATEGORIES.includes(res.category)) return 'application/pdf';
    return rawGiven || 'application/pdf';
  }

  /* ── State rendering (error / empty / lock) ── */
  function renderState(state) {
    // Tear down any in-flight reader (its pdf.js ranges/canvases) before
    // painting an error/lock screen, otherwise the background work keeps
    // running against a host element whose DOM is about to be replaced.
    if (reader) { try { reader.destroy(); } catch { /* noop */ } reader = null; }
    const host = $('#viewerHost');
    host.innerHTML = `
      <div class="viewer-state">
        <div class="viewer-state-card">
          <div class="viewer-state-icon">${SC.icon(state.icon || 'file-text', { size: 30 })}</div>
          <h2>${escapeHtml(state.title || 'Document unavailable')}</h2>
          <p>${escapeHtml(state.body || 'This document could not be opened.')}</p>
          <div class="viewer-state-actions">
            ${state.primary || ''}
            ${state.secondary || ''}
          </div>
        </div>
      </div>`;
    $('#viewerTools').hidden = true;
  }

  function lockWall(message) {
    renderState({
      icon: 'lock',
      title: 'Premium Resource',
      body: message || 'Your free access period has ended. Upgrade to StudyCore Premium to continue reading this resource.',
      primary: `<a class="btn btn-amber" href="/dashboard.html#premium">${SC.icon('crown', { size: 16 })} Upgrade to Premium</a>`,
      secondary: `<button class="btn btn-outline" type="button" data-viewer-back>${SC.icon('arrow-left', { size: 16 })} Go back</button>`
    });
    bindBackButtons();
  }

  function notFound() {
    renderState({
      icon: 'alert-triangle',
      title: 'Document not found',
      body: 'This document may have been removed, or the link is incorrect.',
      primary: `<a class="btn btn-primary" href="/dashboard.html">${SC.icon('layout-dashboard', { size: 16 })} Go to Dashboard</a>`
    });
  }

  function externalOnly() {
    renderState({
      icon: 'file',
      title: 'Preview unavailable',
      body: 'This resource is not stored in StudyCore, so it cannot be opened in the protected document reader. Ask your administrator to upload a PDF version.',
      secondary: `<button class="btn btn-outline" type="button" data-viewer-back>${SC.icon('arrow-left', { size: 16 })} Go back</button>`
    });
    bindBackButtons();
  }

  function noFile() {
    renderState({
      icon: 'file',
      title: 'No viewable file',
      body: 'There is no document file attached to this resource to view.',
      secondary: `<button class="btn btn-outline" type="button" data-viewer-back>${SC.icon('arrow-left', { size: 16 })} Go back</button>`
    });
    bindBackButtons();
  }

  /* ── Header / meta ───────────────────────── */
  function renderHeader() {
    $('#viewerTitleIcon').innerHTML = SC.icon(SC.courseCategoryIcon(resource.category), { size: 18 });
    $('#viewerTitle').textContent = resource.title;
    document.title = `${resource.title} | StudyCore`;

    const meta = [
      CATEGORY_LABELS[resource.category] || 'Resource',
      resource.subject,
      resource.topic && resource.topic !== 'General' ? resource.topic : null,
      resource.yearLevel,
      formatFileSize(resource.fileSize)
    ].filter(Boolean).join(' · ');
    $('#viewerMeta').textContent = meta || 'StudyCore Document Viewer';
  }

  /* ── Back navigation ─────────────────────── */
  function goBack() {
    // Program-course resources belong to /course/:key, not the legacy six
    // subject pages. A direct URL (no referrer) must therefore land students
    // back in the program course instead of a subject page that may not even
    // contain the resource.
    let fallback = '/dashboard.html';
    if (resource && resource.courseId) {
      fallback = `/course/${encodeURIComponent(String(resource.courseId).replace(/^course-/i, ''))}`;
    } else if (resource && resource.subject) {
      const slug = subjectSlug(resource.subject);
      if (slug) fallback = `/pages/subjects/${slug}.html`;
    }
    let referrerSameOrigin = false;
    try { referrerSameOrigin = document.referrer && new URL(document.referrer).origin === location.origin; } catch { referrerSameOrigin = false; }
    if (referrerSameOrigin && history.length > 1) {
      history.back();
    } else {
      location.href = fallback;
    }
  }

  function bindBackButtons() {
    document.querySelectorAll('[data-viewer-back]').forEach((el) => {
      el.addEventListener('click', goBack);
    });
  }

  /* ── Toolbar state ───────────────────────── */
  function setToolsEnabled(enabled) {
    ['#viewerPrev', '#viewerNext', '#viewerZoomOut', '#viewerZoomIn', '#viewerFit', '#viewerSearchBtn', '#viewerFullscreen']
      .forEach((sel) => {
        const el = $(sel);
        if (el) el.disabled = !enabled;
      });
  }

  function updateState(s) {
    const paged = Boolean(s.numPages && s.numPages > 0);
    $('#viewerPageLabel').textContent = paged ? `${s.page} / ${s.numPages}` : '';
    $('#viewerZoomLabel').textContent = paged ? `${s.zoom}%` : '';
    setToolsEnabled(paged);
  }

  function updateSearch(info) {
    const count = $('#viewerSearchCount');
    const prev = $('#viewerSearchPrev');
    const next = $('#viewerSearchNext');
    if (!count) return;
    if (info.searching) {
      count.textContent = `Searching… (${info.total || 0})`;
    } else if (info.active && info.total > 0) {
      count.textContent = `${info.current} / ${info.total}`;
    } else if (info.active) {
      count.textContent = 'No matches';
    } else {
      count.textContent = '';
    }
    if (prev) prev.disabled = !(info.active && info.total > 0);
    if (next) next.disabled = !(info.active && info.total > 0);
  }

  /* ── Search UI ───────────────────────────── */
  function setSearchOpen(open) {
    const bar = $('#viewerSearchBar');
    const btn = $('#viewerSearchBtn');
    const input = $('#viewerSearchInput');
    bar.hidden = !open;
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      setTimeout(() => { if (input) input.focus(); }, 0);
    } else {
      if (reader) reader.clearSearch();
      if (input) input.value = '';
    }
  }

  function wireSearch() {
    $('#viewerSearchBtn').addEventListener('click', () => {
      const bar = $('#viewerSearchBar');
      setSearchOpen(bar.hidden);
    });
    $('#viewerSearchClose').addEventListener('click', () => setSearchOpen(false));
    $('#viewerSearchPrev').addEventListener('click', () => reader && reader.searchPrev());
    $('#viewerSearchNext').addEventListener('click', () => reader && reader.searchNext());

    const input = $('#viewerSearchInput');
    let debounce = null;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => reader && reader.search(input.value), 320);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); reader && reader.search(input.value); }
      else if (e.key === 'Escape') setSearchOpen(false);
    });
  }

  /* ── Toolbar wiring ──────────────────────── */
  // Fullscreen targets the whole viewer shell (header + toolbar + surface) so
  // controls remain available while reading, unlike the embedded reader which
  // fullscreens just its card.
  function toggleFullscreen() {
    const el = $('#viewerShell');
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    if (active) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
      return;
    }
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) req.call(el);
  }

  function wireTools() {
    const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('click', fn); };
    on('#viewerPrev', () => reader && reader.prevPage());
    on('#viewerNext', () => reader && reader.nextPage());
    on('#viewerZoomOut', () => reader && reader.zoomOut());
    on('#viewerZoomIn', () => reader && reader.zoomIn());
    on('#viewerFit', () => reader && reader.fitWidth());
    on('#viewerFullscreen', () => toggleFullscreen());
  }

  /* ── Keyboard navigation ─────────────────── */
  function wireKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!reader) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (typing) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); reader.nextPage(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); reader.prevPage(); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); reader.zoomIn(); }
      else if (e.key === '-') { e.preventDefault(); reader.zoomOut(); }
      else if (e.key === '0') { e.preventDefault(); reader.fitWidth(); }
    });
  }

  /* ── Boot ────────────────────────────────── */
  async function init() {
    fillIcons();
    wireTools();
    wireSearch();
    wireKeyboard();
    bindBackButtons();
    $('#viewerBack').addEventListener('click', goBack);

    if (!id) { notFound(); return; }

    // The page route is already session-gated, and the resource endpoint
    // repeats that check. Do not wait for the navigation's /auth/me request:
    // fetching metadata in parallel removes a full round trip from startup.
    let data;
    try {
      data = await StudyCoreAPI.getResource(id);
    } catch (err) {
      if (err.status === 401) { location.href = '/login.html'; return; }
      if (err.status === 403) { lockWall(err.message); return; }
      if (err.status === 404) { notFound(); return; }
      renderState({
        icon: 'alert-triangle',
        title: 'Could not open this document',
        body: err.message || 'Something went wrong while loading this document.',
        secondary: `<button class="btn btn-outline" type="button" data-viewer-back>${SC.icon('arrow-left', { size: 16 })} Go back</button>`
      });
      bindBackButtons();
      return;
    }

    resource = data.resource;
    if (!resource) { notFound(); return; }

    // Videos always play in the lesson player, never here. When the video is
    // course-bound it keeps the course key so prev/next stays in the program
    // course.
    if (resource.category === 'video') {
      const course = resource.courseId ? `&course=${encodeURIComponent(String(resource.courseId).replace(/^course-/i, ''))}` : '';
      const subject = resource.subject ? `&subject=${encodeURIComponent(resource.subject)}` : '';
      location.replace(`/pages/lesson.html?id=${encodeURIComponent(resource.id)}${course}${subject}`);
      return;
    }

    renderHeader();

    // Legacy link-only resources have no stored file to render.
    if (!resource.hasFile) {
      if (resource.externalUrl) externalOnly();
      else noFile();
      return;
    }

    $('#viewerTools').hidden = false;

    reader = StudyCoreReader.init($('#viewerHost'), {
      url: StudyCoreAPI.streamUrl(resource.id),
      title: resource.title,
      fileSize: resource.fileSize,
      fileName: resource.fileName,
      mimeType: inferMime(resource),
      chrome: 'bare',
      onState: updateState,
      onSearchUpdate: updateSearch,
      // Only the PDF engine has pages, zoom levels and text search. For a
      // Word doc, image or text file those toolbar controls would appear
      // enabled but do nothing — reflect the real document type here.
      onOpen(info) {
        const isPaged = info && Number(info.pages) > 0;
        ['#viewerPrev', '#viewerNext', '#viewerPageLabel', '#viewerZoomOut', '#viewerZoomLabel', '#viewerZoomIn', '#viewerFit']
          .forEach((sel) => { const el = $(sel); if (el) el.hidden = !isPaged; });
        const searchBtn = $('#viewerSearchBtn');
        if (searchBtn) searchBtn.hidden = !isPaged;
        if (!isPaged) setSearchOpen(false);
        $('#viewerTools').hidden = false;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
