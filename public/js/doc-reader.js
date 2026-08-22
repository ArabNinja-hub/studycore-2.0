// =============================================
// STUDYCORE — Document Reader (js/doc-reader.js)
// -----------------------------------------------
// Renders protected StudyCore documents INSIDE
// StudyCore, on desktop and mobile alike.
//
// Why this exists
// ---------------
// The previous reader put the authorized stream
// URL into an <iframe> and relied on the browser's
// built-in PDF plugin. Desktop Chrome/Firefox/Edge
// ship one, so it worked there. iOS Safari, Android
// Chrome and most mobile browsers do NOT render
// application/pdf in an iframe — they abort the
// subframe navigation (ERR_ABORTED) and the student
// is left staring at an empty white box.
//
// This reader instead decodes the PDF itself with
// pdf.js (self-hosted in /vendor/pdfjs — no CDN, no
// third party ever sees a StudyCore document) and
// paints each page onto a <canvas>. That path is
// identical on every browser, so mobile behaves the
// same as desktop.
//
// Protected-content requirements are preserved:
//   · bytes only ever come from the session-gated
//     /api/resources/:id/stream endpoint, fetched
//     with credentials
//   · no download / print / save controls
//   · context menu and drag are blocked
//   · nothing is written to a blob: URL the student
//     could lift out of devtools as a whole file
//
// Mobile specifics handled here:
//   · canvas pixel budget (a 2000px-wide page at
//     dpr 3 is a 24MP canvas — iOS Safari kills the
//     tab). Scale is capped by device.
//   · only pages near the viewport are rasterised;
//     canvases outside the window are released so a
//     200-page past paper never exhausts memory.
//   · pinch-zoom friendly: the scroller owns the
//     panning, pages reflow to container width.
//   · PDFs load in small, on-demand byte ranges on every device; the reader
//     never waits for or retains a complete PDF before showing page one.
// =============================================

(function (global) {
  'use strict';

  const PDFJS_LIB = '/vendor/pdfjs/pdf.min.js';
  const PDFJS_WORKER = '/vendor/pdfjs/pdf.worker.min.js';
  const PDFJS_FONTS = '/vendor/pdfjs/standard_fonts/';
  const MAMMOTH_LIB = '/vendor/mammoth/mammoth.browser.min.js';

  // How many pages either side of the visible one keep a live canvas.
  const RENDER_WINDOW = 2;

  let pdfjsPromise = null;
  let mammothPromise = null;

  // Self-hosted Word (.docx) converter (mammoth, Apache-2.0). Loaded lazily,
  // only when a document actually turns out to be a Word file, so PDF
  // readers never pay for it.
  function loadMammoth() {
    if (global.mammoth) return Promise.resolve(global.mammoth);
    if (mammothPromise) return mammothPromise;
    mammothPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MAMMOTH_LIB;
      s.async = true;
      s.onload = () => {
        if (global.mammoth && typeof global.mammoth.convertToHtml === 'function') return resolve(global.mammoth);
        mammothPromise = null;
        reject(new Error('Could not load the StudyCore Word document engine.'));
      };
      s.onerror = () => { mammothPromise = null; reject(new Error('Could not load the StudyCore Word document engine.')); };
      document.head.appendChild(s);
    });
    return mammothPromise;
  }

  // Magic-byte dispatch: what is this file, really? Used whenever the
  // server could not (or did not) tell us — octet-stream, bare-UUID names,
  // missing metadata. Returns 'pdf' | 'docx' | 'image' | 'text' | 'other'.
  function sniffBytes(data) {
    if (!data || data.length < 4) return 'other';
    if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) return 'pdf'; // %PDF-
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image';               // JPEG
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image'; // PNG
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image';                  // GIF
    if (data.length >= 12 && new TextDecoder('ascii').decode(data.subarray(0, 4)) === 'RIFF' &&
        new TextDecoder('ascii').decode(data.subarray(8, 12)) === 'WEBP') return 'image';          // WebP
    // ZIP container — Word/PowerPoint/Excel are ZIPs. Word part names are
    // referenced by [Content_Types].xml, one of the first entries, so the
    // first kilobyte is usually enough to tell a .docx from a plain .zip.
    if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
      const head = new TextDecoder('latin1').decode(data.subarray(0, Math.min(data.length, 8192)));
      if (head.includes('word/document.xml')) return 'docx';
      return 'other';
    }
    // Rough plain-text check: almost every byte is whitespace or printable.
    let ok = 0;
    const sample = Math.min(data.length, 1024);
    for (let i = 0; i < sample; i += 1) {
      const b = data[i];
      if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 128) ok += 1;
    }
    if (sample > 0 && ok / sample >= 0.97) return 'text';
    return 'other';
  }

  function loadPdfJs() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFJS_LIB;
      s.async = true;
      s.onload = () => {
        if (!global.pdfjsLib) return reject(new Error('PDF engine failed to initialise.'));
        try {
          global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        } catch (e) {
          console.warn('[StudyCore reader] could not set worker src', e);
        }
        resolve(global.pdfjsLib);
      };
      s.onerror = () => reject(new Error('Could not load the StudyCore PDF engine.'));
      document.head.appendChild(s);
    });
    return pdfjsPromise;
  }

  function isMobileViewport() {
    try {
      return Math.min(window.innerWidth, window.innerHeight) <= 820;
    } catch {
      return false;
    }
  }

  // A phone GPU/renderer will not survive a desktop-sized canvas. Cap the
  // total pixels per page, then derive the device-pixel scale from that.
  function pixelBudget() {
    const mem = Number(navigator.deviceMemory) || 0;
    if (isMobileViewport()) return mem && mem <= 2 ? 2.2e6 : 4.2e6;
    return 1.6e7;
  }

  function maxOutputScale() {
    const dpr = global.devicePixelRatio || 1;
    return isMobileViewport() ? Math.min(dpr, 2) : Math.min(dpr, 2);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>\"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function icon(name, size) {
    if (global.SC && typeof global.SC.icon === 'function') return global.SC.icon(name, { size: size });
    return '';
  }

  function fmtSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function isBareUuid(str) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(str || '').trim());
  }

  /**
   * init(host, options)
   *   host        - element to render into
   *   options.url      - authorized stream URL (required)
   *   options.title    - document title
   *   options.fileSize - bytes (display only)
   *   options.mimeType - best-known type
   *   options.fileName - original name (type sniffing fallback)
   */
  function init(host, options) {
    const o = options || {};
    const url = o.url;
    if (!host || !url) return { destroy() {} };

    let destroyed = false;
    let pdfDoc = null;
    let resizeRaf = null;
    const pageEntries = [];      // { n, wrap, canvas, task, rendered, width, height, scale }
    let zoom = 1;
    let currentPage = 1;
    // Loop guard: how many times the file has bounced between "thought to be
    // PDF" and "sniffed the bytes". Bounds the retry chains so a corrupt
    // file reaches the error state instead of ping-ponging.
    let dispatchDepth = 0;

    /* ── Search state ───────────────────────── */
    const textCache = new Map();   // pageNum -> [{ str, transform, width, height }]
    let searchResults = [];        // [{ pageNum, itemIndex }]
    let searchCursor = -1;
    let searchActive = false;
    let searchSeq = 0;             // invalidates superseded async search passes

    /* ── Chrome ─────────────────────────────── */
    // `chrome: 'bare'` renders only the reading surface (stage + scroll) with
    // no card wrapper, header or toolbar — the standalone /viewer/:id page
    // provides its own StudyCore chrome and drives this reader through the
    // controller object returned below. The default 'card' chrome keeps the
    // embedded lesson-page reader exactly as before (plus search).
    const isBare = o.chrome === 'bare';
    const headHtml = isBare ? '' : `
      <div class="doc-reader-head">
        <span class="doc-reader-icon">${icon('file-text', 17)}</span>
        <strong class="doc-reader-title">${esc(o.title || 'Document')}</strong>
        <span class="doc-reader-sub">${esc(fmtSize(o.fileSize))}${o.fileSize ? ' · ' : ''}StudyCore Document Viewer</span>
        <div class="doc-reader-tools" id="scDocTools" hidden>
          <button type="button" class="doc-tool" id="scDocPrev" aria-label="Previous page">${icon('arrow-left', 16)}</button>
          <span class="doc-tool-label" id="scDocPageLabel" aria-live="polite">1 / 1</span>
          <button type="button" class="doc-tool" id="scDocNext" aria-label="Next page">${icon('arrow-right', 16)}</button>
          <span class="doc-tool-sep" aria-hidden="true"></span>
          <button type="button" class="doc-tool" id="scDocZoomOut" aria-label="Zoom out">${icon('zoom-out', 16)}</button>
          <span class="doc-tool-label" id="scDocZoomLabel">100%</span>
          <button type="button" class="doc-tool" id="scDocZoomIn" aria-label="Zoom in">${icon('zoom-in', 16)}</button>
          <button type="button" class="doc-tool" id="scDocFit" aria-label="Fit to width">${icon('minimize', 16)}</button>
          <button type="button" class="doc-tool" id="scDocSearchBtn" aria-label="Search document" aria-expanded="false">${icon('search', 16)}</button>
          <button type="button" class="doc-tool" id="scDocFs" aria-label="Fullscreen">${icon('maximize', 16)}</button>
        </div>
      </div>
      <div class="doc-reader-search" id="scDocSearchBar" hidden>
        <div class="doc-reader-search-field">
          ${icon('search', 16)}
          <input type="text" id="scDocSearchInput" placeholder="Search this document…" aria-label="Search inside document" autocomplete="off" />
        </div>
        <span class="doc-tool-label" id="scDocSearchCount" aria-live="polite"></span>
        <button type="button" class="doc-tool" id="scDocSearchPrev" aria-label="Previous match">${icon('arrow-left', 16)}</button>
        <button type="button" class="doc-tool" id="scDocSearchNext" aria-label="Next match">${icon('arrow-right', 16)}</button>
        <button type="button" class="doc-tool" id="scDocSearchClose" aria-label="Close search">${icon('x', 16)}</button>
      </div>`;

    host.innerHTML = `
      ${isBare ? '' : '<div class="card doc-reader" id="scDocReader">'}
      ${headHtml}
      <div class="doc-reader-stage" id="scDocStage">
        <div class="doc-reader-status" id="scDocStatus">
          <div class="player-spinner"></div>
          <p id="scDocStatusText">Opening document…</p>
        </div>
        <div class="doc-reader-scroll" id="scDocScroll" tabindex="0"></div>
      </div>
      ${isBare ? '' : '</div>'}`;

    const reader = host.querySelector('#scDocReader');
    const stage = host.querySelector('#scDocStage');
    const scroll = host.querySelector('#scDocScroll');
    const tools = host.querySelector('#scDocTools');
    const statusBox = host.querySelector('#scDocStatus');
    const pageLabel = host.querySelector('#scDocPageLabel');
    const zoomLabel = host.querySelector('#scDocZoomLabel');
    const fsTarget = reader || stage;

    // Protected content: no right-click "save", no drag-out. In bare mode the
    // reading surface (stage) carries the same protection the card carries in
    // embedded mode.
    const protectEl = reader || stage;
    if (protectEl) {
      protectEl.addEventListener('contextmenu', (e) => e.preventDefault());
      protectEl.addEventListener('dragstart', (e) => e.preventDefault());
    }

    function setStatus(text) {
      if (!statusBox) return;
      statusBox.hidden = false;
      statusBox.classList.remove('is-error');
      statusBox.innerHTML = `<div class="player-spinner"></div><p>${esc(text)}</p>`;
    }

    function clearStatus() {
      if (statusBox) statusBox.hidden = true;
    }

    function showError(message, canRetry) {
      if (!statusBox) return;
      statusBox.hidden = false;
      statusBox.classList.add('is-error');
      statusBox.innerHTML = `
        ${icon('alert-triangle', 34)}
        <h3>Document unavailable</h3>
        <p>${esc(message)}</p>
        ${canRetry === false ? '' : `<button class="btn btn-teal btn-sm" type="button" id="scDocRetry">${icon('refresh', 15)} Try again</button>`}`;
      const retry = statusBox.querySelector('#scDocRetry');
      if (retry) retry.addEventListener('click', () => { destroy(false); init(host, o); });
    }

    /* ── Type detection ─────────────────────── */
    // Returns: 'pdf' | 'docx' | 'image' | 'text' | 'office-other' | 'unknown'
    // 'unknown' means the metadata says nothing useful (octet-stream, bare
    // UUID, empty) — boot() resolves it by sniffing the actual bytes before
    // picking a renderer, so a Word file uploaded without an extension is no
    // longer misread as a PDF (the old code forced these into the PDF path
    // and students got "This file is not a readable PDF").
    function guessType(servedType) {
      const rawName = String(o.fileName || '').trim();
      const name = rawName.toLowerCase();
      const t = String(servedType || o.mimeType || '').split(';')[0].trim().toLowerCase();

      // Direct mime wins
      if (t === 'application/pdf') return 'pdf';
      if (t === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
      if (t.startsWith('image/')) return 'image';
      if (t.startsWith('text/')) return 'text';
      if (['application/msword', 'application/vnd.ms-powerpoint', 'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip']
          .includes(t)) return 'office-other';

      // Extension based
      if (/\.pdf$/i.test(name)) return 'pdf';
      if (/\.docx$/i.test(name)) return 'docx';
      if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)) return 'image';
      if (/\.(txt|csv|md)$/i.test(name)) return 'text';
      if (/\.(doc|ppt|pptx|xls|xlsx|zip)$/i.test(name)) return 'office-other';

      // Bare UUID case — the bug reported as "open with 9735a310-...".
      // These are files that lost their extension during upload on some
      // mobile browsers. We no longer assume PDF blindly: the server's
      // metadata usually fixes the Content-Type, and if it could not,
      // 'unknown' lets boot() inspect only the first bytes and select the
      // matching in-browser renderer.
      if (isBareUuid(rawName)) return 'unknown';
      if (isBareUuid(name.replace(/\.[a-z0-9]+$/i, ''))) return 'unknown';

      // Octet-stream / missing mime — the server's sniff has already had a
      // chance to set a real Content-Type; if it still says nothing, resolve
      // it from the bytes.
      if (t === 'application/octet-stream' || t === 'binary/octet-stream' || !t) return 'unknown';

      return 'office-other';
    }

    /* ── PDF path ───────────────────────────── */
    function availableWidth() {
      const pad = isMobileViewport() ? 16 : 40;
      // scroll.clientWidth can be 0 if the element hasn't been laid out yet
      // (e.g. during initial boot or in a hidden tab). Fall back to stage,
      // host, or a sensible default so we never create a 0-width canvas,
      // which would crash the render and leave a blank "open with" state.
      const candidates = [
        scroll ? scroll.clientWidth : 0,
        stage ? stage.clientWidth : 0,
        host ? host.clientWidth : 0,
        640
      ];
      const w = (candidates.find((v) => v && v > 0) || 640) - pad;
      return Math.max(220, w);
    }

    function scheduleVisible() {
      // Render the pages currently in the window, release the rest.
      const scrollTop = scroll.scrollTop;
      const viewH = scroll.clientHeight || 1;
      let nearest = currentPage;
      let nearestDist = Infinity;
      pageEntries.forEach((entry) => {
        const top = entry.wrap.offsetTop;
        const bottom = top + entry.wrap.offsetHeight;
        const dist = (top > scrollTop + viewH) ? top - (scrollTop + viewH)
          : (bottom < scrollTop ? scrollTop - bottom : 0);
        entry.distance = dist;
        if (dist < nearestDist) { nearestDist = dist; nearest = entry.n; }
      });
      if (nearest !== currentPage) {
        currentPage = nearest;
        updatePageLabel();
      }
      const windowPx = viewH * (RENDER_WINDOW + 0.5);
      pageEntries.forEach((entry) => {
        if (entry.distance <= windowPx) renderPage(entry);
        else releasePage(entry);
      });
    }

    function updatePageLabel() {
      if (pageLabel && pdfDoc) pageLabel.textContent = `${currentPage} / ${pdfDoc.numPages}`;
      emitState();
    }

    /* ── State + search callbacks ───────────── */
    function emitState() {
      if (typeof o.onState === 'function') {
        o.onState({ page: currentPage, numPages: pdfDoc ? pdfDoc.numPages : 0, zoom: Math.round(zoom * 100) });
      }
    }

    function updateSearchUi(info) {
      const countEl = host.querySelector('#scDocSearchCount');
      if (countEl) {
        if (info.searching) countEl.textContent = `Searching… (${info.total || 0})`;
        else if (info.active && info.total > 0) countEl.textContent = `${info.current} / ${info.total}`;
        else if (info.active) countEl.textContent = 'No matches';
        else countEl.textContent = '';
      }
      const btn = host.querySelector('#scDocSearchBtn');
      if (btn) btn.classList.toggle('active', Boolean(info.active));
    }

    function emitSearch(info) {
      updateSearchUi(info);
      if (typeof o.onSearchUpdate === 'function') o.onSearchUpdate(info);
    }

    /* ── Search engine ──────────────────────── */
    // Extracts a page's text once and caches it. Lazy + per-page so a large
    // past paper is never fully parsed just to search, and a query that
    // matches early returns fast.
    async function getPageText(pageNum) {
      if (textCache.has(pageNum)) return textCache.get(pageNum);
      const page = await pdfDoc.getPage(pageNum);
      try {
        const tc = await page.getTextContent();
        const items = (tc && tc.items ? tc.items : [])
          .filter((it) => it && typeof it.str === 'string' && it.str.trim().length);
        textCache.set(pageNum, items);
        return items;
      } finally {
        if (typeof page.cleanup === 'function') { try { page.cleanup(); } catch { /* noop */ } }
      }
    }

    async function runSearch(query) {
      const q = String(query || '').trim();
      if (!q) { clearSearch(); return; }
      if (!pdfDoc) return;
      searchSeq += 1;
      const seq = searchSeq;
      searchActive = true;
      searchResults = [];
      searchCursor = -1;
      emitSearch({ active: true, searching: true, current: 0, total: 0 });
      const lower = q.toLowerCase();
      const maxMatches = 2000;
      let total = 0;
      const totalPages = pdfDoc.numPages;
      for (let n = 1; n <= totalPages; n += 1) {
        if (seq !== searchSeq || destroyed) return;
        let items;
        try { items = await getPageText(n); } catch { continue; }
        if (seq !== searchSeq || destroyed) return;
        for (let i = 0; i < items.length; i += 1) {
          const it = items[i];
          if (it.str.toLowerCase().indexOf(lower) !== -1) {
            searchResults.push({ pageNum: n, itemIndex: i });
            total += 1;
            if (total >= maxMatches) break;
          }
        }
        emitSearch({ active: true, searching: true, current: 0, total });
        if (total >= maxMatches) break;
      }
      if (seq !== searchSeq || destroyed) return;
      if (!searchResults.length) {
        clearHighlight();
        emitSearch({ active: true, searching: false, current: 0, total: 0, done: true });
        return;
      }
      searchCursor = 0;
      goToPage(searchResults[0].pageNum);
      emitSearch({ active: true, searching: false, current: 1, total: searchResults.length, done: true });
    }

    function searchStep(delta) {
      if (!searchActive || !searchResults.length) return;
      searchCursor = (searchCursor + delta + searchResults.length) % searchResults.length;
      const m = searchResults[searchCursor];
      goToPage(m.pageNum);
      emitSearch({ active: true, searching: false, current: searchCursor + 1, total: searchResults.length, done: true });
    }

    function clearSearch() {
      searchSeq += 1;
      searchActive = false;
      searchResults = [];
      searchCursor = -1;
      clearHighlight();
      emitSearch({ active: false, searching: false, current: 0, total: 0, done: true });
    }

    function toggleSearchUi() {
      const bar = host.querySelector('#scDocSearchBar');
      const input = host.querySelector('#scDocSearchInput');
      if (!bar) return;
      const open = bar.hidden;
      bar.hidden = !open;
      const btn = host.querySelector('#scDocSearchBtn');
      if (btn) btn.setAttribute('aria-expanded', String(open));
      if (open) {
        setTimeout(() => { if (input) input.focus(); }, 0);
      } else {
        clearSearch();
        if (input) input.value = '';
      }
    }

    /* ── Match highlight (canvas overlay) ───── */
    function clearHighlight() {
      pageEntries.forEach((e) => {
        if (e.wrap) e.wrap.querySelectorAll('.doc-highlight').forEach((n) => n.remove());
      });
    }

    // Draws a translucent rect over the active match on a rendered page. Item
    // coordinates come from getTextContent() in PDF user space (origin
    // bottom-left); entry.cssScale + entry.base map them to the page wrap's
    // CSS space (origin top-left).
    function drawHighlights(entry) {
      if (!searchActive || searchCursor < 0) return;
      const match = searchResults[searchCursor];
      if (!match || match.pageNum !== entry.n) return;
      const items = textCache.get(entry.n);
      const base = entry.base;
      const cssScale = entry.cssScale;
      if (!items || !base || !cssScale) return;
      const it = items[match.itemIndex];
      if (!it) return;
      const wrapW = entry.wrap.clientWidth || base.width * cssScale;
      const x = it.transform[4] * cssScale;
      const baseline = (base.height - it.transform[5]) * cssScale;
      const w = Math.max(2, (it.width || 1) * cssScale);
      const hRaw = (typeof it.height === 'number' && it.height > 0) ? it.height : (Math.abs(it.transform[0]) || 12);
      const h = Math.max(4, hRaw * cssScale);
      const top = baseline - h;
      const div = document.createElement('div');
      div.className = 'doc-highlight';
      div.style.left = Math.max(0, x - 1) + 'px';
      div.style.top = Math.max(0, top - 2) + 'px';
      div.style.width = Math.min(Math.max(2, wrapW - x), w + 2) + 'px';
      div.style.height = Math.max(4, h + 4) + 'px';
      entry.wrap.appendChild(div);
    }

    function refreshHighlight() {
      clearHighlight();
      if (!searchActive || searchCursor < 0) return;
      const match = searchResults[searchCursor];
      if (!match) return;
      const entry = pageEntries.find((e) => e.n === match.pageNum);
      if (entry) drawHighlights(entry);
    }

    function releasePage(entry) {
      if (!entry.rendered && !entry.task) return;
      if (entry.task) { try { entry.task.cancel(); } catch { /* already done */ } entry.task = null; }
      if (entry.canvas) {
        // Zeroing the canvas is what actually frees the backing store on iOS.
        entry.canvas.width = 0;
        entry.canvas.height = 0;
        entry.canvas.remove();
        entry.canvas = null;
      }
      entry.rendered = false;
    }

    async function renderPage(entry) {
      if (destroyed || entry.rendered || entry.task || !pdfDoc) return;
      let page;
      try {
        page = await pdfDoc.getPage(entry.n);
      } catch {
        return;
      }
      if (destroyed) return;

      const cssWidth = availableWidth() * zoom;
      const base = page.getViewport({ scale: 1 });
      const cssScale = cssWidth / base.width;
      entry.base = base;
      entry.cssScale = cssScale;

      // Device pixels, capped both by dpr and by an absolute pixel budget.
      let outScale = maxOutputScale();
      const budget = pixelBudget();
      const wantPixels = (base.width * cssScale * outScale) * (base.height * cssScale * outScale);
      if (wantPixels > budget) outScale = Math.max(1, outScale * Math.sqrt(budget / wantPixels));

      const viewport = page.getViewport({ scale: cssScale * outScale });
      const actualRatio = base.height / base.width;
      if (entry.ratio !== actualRatio) {
        entry.ratio = actualRatio;
        entry.wrap.style.height = Math.round(cssWidth * actualRatio) + 'px';
      }
      const canvas = document.createElement('canvas');
      canvas.className = 'doc-page-canvas';
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Page ${entry.n}`);

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;

      entry.canvas = canvas;
      entry.wrap.innerHTML = '';
      entry.wrap.appendChild(canvas);

      const task = page.render({ canvasContext: ctx, viewport: viewport });
      entry.task = task;
      try {
        await task.promise;
        entry.rendered = true;
        if (searchActive && searchCursor >= 0) refreshHighlight();
      } catch (err) {
        if (!destroyed && err && err.name !== 'RenderingCancelledException') {
          entry.wrap.innerHTML = `<div class="doc-page-fallback">Page ${entry.n} could not be displayed.</div>`;
        }
      } finally {
        entry.task = null;
        if (typeof page.cleanup === 'function') { try { page.cleanup(); } catch { /* noop */ } }
      }
    }

    async function layoutPages(pdf) {
      scroll.innerHTML = '';
      pageEntries.length = 0;
      const width = availableWidth() * zoom;

      // Fetching metadata with getPage() for every page at once made pdf.js
      // parse an entire long document before showing page one. That can exceed
      // Safari's memory limit and is especially painful on mobile data. Use
      // page one's dimensions as the initial placeholder; each page corrects
      // its own ratio lazily when it enters the render window.
      let defaultRatio = 1.414;
      try {
        const firstPage = await pdf.getPage(1);
        const firstViewport = firstPage.getViewport({ scale: 1 });
        defaultRatio = firstViewport.height / firstViewport.width;
        if (typeof firstPage.cleanup === 'function') firstPage.cleanup();
      } catch { /* A4-like fallback keeps the layout usable. */ }

      const fragment = document.createDocumentFragment();
      for (let n = 1; n <= pdf.numPages; n += 1) {
        const wrap = document.createElement('div');
        wrap.className = 'doc-page';
        wrap.setAttribute('data-page', String(n));
        wrap.style.width = width + 'px';
        wrap.style.height = Math.round(width * defaultRatio) + 'px';
        fragment.appendChild(wrap);
        pageEntries.push({
          n,
          wrap,
          canvas: null,
          task: null,
          rendered: false,
          distance: Infinity,
          ratio: defaultRatio
        });
      }
      scroll.appendChild(fragment);
    }

    function applyZoomSizes() {
      const width = availableWidth() * zoom;
      clearHighlight();
      pageEntries.forEach((entry) => {
        entry.wrap.style.width = width + 'px';
        if (entry.ratio) entry.wrap.style.height = Math.round(width * entry.ratio) + 'px';
        // Force a re-raster at the new scale.
        releasePage(entry);
      });
      if (zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + '%';
      emitState();
      scheduleVisible();
    }

    function goToPage(n) {
      const entry = pageEntries[Math.min(Math.max(1, n), pageEntries.length) - 1];
      if (!entry) return;
      currentPage = entry.n;
      updatePageLabel();
      scroll.scrollTo({ top: entry.wrap.offsetTop - 8, behavior: 'smooth' });
      renderPage(entry);
      if (searchActive && searchCursor >= 0) refreshHighlight();
    }

    function toggleFullscreen() {
      const target = fsTarget;
      if (!target) return;
      const active = document.fullscreenElement || document.webkitFullscreenElement;
      if (active) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
        return;
      }
      const req = target.requestFullscreen || target.webkitRequestFullscreen;
      if (req) req.call(target);
    }

    function bindTools() {
      if (!tools) return;
      tools.hidden = false;
      const on = (id, fn) => {
        const el = host.querySelector(id);
        if (el) el.addEventListener('click', fn);
      };
      on('#scDocPrev', () => goToPage(currentPage - 1));
      on('#scDocNext', () => goToPage(currentPage + 1));
      on('#scDocZoomOut', () => { zoom = Math.max(0.5, Math.round((zoom - 0.25) * 100) / 100); applyZoomSizes(); });
      on('#scDocZoomIn', () => { zoom = Math.min(3, Math.round((zoom + 0.25) * 100) / 100); applyZoomSizes(); });
      on('#scDocFit', () => { zoom = 1; applyZoomSizes(); });
      on('#scDocFs', () => toggleFullscreen());
      on('#scDocSearchBtn', () => toggleSearchUi());
      on('#scDocSearchClose', () => toggleSearchUi());
      on('#scDocSearchPrev', () => searchStep(-1));
      on('#scDocSearchNext', () => searchStep(1));

      const searchInput = host.querySelector('#scDocSearchInput');
      if (searchInput) {
        let debounce = null;
        searchInput.addEventListener('input', () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => runSearch(searchInput.value), 320);
        });
        searchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); runSearch(searchInput.value); }
          else if (e.key === 'Escape') toggleSearchUi();
        });
      }
    }

    async function openPdf(opts) {
      const prefetchedBytes = (opts && opts.bytes) || null;
      let pdfjs;
      try {
        pdfjs = await loadPdfJs();
      } catch (err) {
        showError(err.message || 'Could not load the StudyCore PDF engine.');
        return;
      }
      if (destroyed) return;

      // Give pdf.js the protected URL directly on every device. Streaming is
      // deliberately disabled in favour of byte ranges: page one can open
      // from the first/last chunks without buffering the complete PDF, and
      // later pages are fetched only as the student reaches them.
      const pdfSource = prefetchedBytes
        ? { data: prefetchedBytes }
        : { url: url, withCredentials: true };
      const usedPrefetchedBytes = Boolean(prefetchedBytes);

      if (destroyed) return;
      setStatus('Opening document…');

      const task = pdfjs.getDocument({
        ...pdfSource,
        disableRange: false,
        // Range-only loading prevents the browser from pulling the complete
        // file in the background. 128 KB balances first-page latency against
        // request count on slower mobile connections.
        disableStream: true,
        disableAutoFetch: true,
        rangeChunkSize: 131072,
        standardFontDataUrl: PDFJS_FONTS,
        isEvalSupported: false
      });

      task.onProgress = (p) => {
        if (!p || !p.total || destroyed) return;
        const pct = Math.min(99, Math.round((p.loaded / p.total) * 100));
        if (statusBox && !statusBox.hidden) setStatus(`Opening document… ${pct}%`);
      };

      let pdf;
      try {
        pdf = await task.promise;
      } catch (err) {
        if (destroyed) return;
        const name = err && err.name;
        // pdf.js rejected the bytes. If we never looked at the actual file
        // (URL/range path), the type metadata was probably wrong — sniff the
        // real type and route to the renderer that fits, with a depth guard
        // so a genuinely corrupt file can't bounce between the two forever.
        if (name === 'InvalidPDFException' && !usedPrefetchedBytes && dispatchDepth < 2) {
          console.warn('[StudyCore reader] pdf.js rejected the file — sniffing real type');
          return sniffAndDispatch();
        }
        let message = 'This document could not be opened.';
        if (name === 'PasswordException') message = 'This document is password protected.';
        else if (name === 'InvalidPDFException') message = 'This file appears to be corrupted. Ask your admin to re-upload a PDF version.';
        else if (name === 'MissingPDFException') message = 'This document is missing from storage.';
        else if (name === 'UnexpectedResponseException') {
          message = err.status === 401 ? 'Please log in again to open this document.'
            : err.status === 403 ? 'You do not have access to this document with your current plan.'
              : 'The document server could not be reached. Please try again.';
        } else if (err && err.message) message = err.message;
        console.error('[StudyCore reader] pdf open failed', err);
        showError(message);
        return;
      }
      if (destroyed) { try { pdf.destroy(); } catch { /* noop */ } return; }

      pdfDoc = pdf;
      try {
        await layoutPages(pdf);
      } catch (e) {
        console.error('[StudyCore reader] layout failed', e);
        showError('This document could not be displayed. Try again or ask admin for a PDF version.');
        return;
      }
      if (destroyed) return;

      // Paint page one before scheduling nearby pages. Previously pages two
      // and three began decoding at the same time and competed with the page
      // the student was waiting to see, especially on slower phones.
      if (pageEntries[0]) await renderPage(pageEntries[0]);
      if (destroyed) return;

      clearStatus();
      bindTools();
      updatePageLabel();
      if (zoomLabel) zoomLabel.textContent = '100%';

      scroll.addEventListener('scroll', () => {
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => { resizeRaf = null; scheduleVisible(); });
      }, { passive: true });

      scheduleVisible();
      if (typeof o.onOpen === 'function') o.onOpen({ pages: pdf.numPages });
    }

    /* ── Image path ─────────────────────────── */
    function openImage() {
      clearStatus();
      scroll.innerHTML = `<div class="doc-page doc-page-image"><img alt="${esc(o.title || 'Document')}" /></div>`;
      const img = scroll.querySelector('img');
      img.addEventListener('error', () => showError('This image could not be displayed.'));
      img.src = url;
    }

    /* ── Text path ──────────────────────────── */
    async function openText() {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        const res = await fetch(url, { credentials: 'include', signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) {
          let message = 'This document could not be opened.';
          try { const d = await res.json(); if (d && d.message) message = d.message; } catch { /* not JSON */ }
          showError(message);
          return;
        }
        const text = await res.text();
        if (destroyed) return;
        clearStatus();
        const pre = document.createElement('pre');
        pre.className = 'doc-reader-text';
        pre.textContent = text;
        scroll.innerHTML = '';
        scroll.appendChild(pre);
      } catch (err) {
        showError(err.name === 'AbortError'
          ? 'The document server did not respond in time.'
          : 'Check your connection and try again.');
      }
    }

    /* ── Word (.docx) path ─────────────────── */
    // Word documents are converted to HTML in-browser with the self-hosted
    // mammoth engine (no CDN, no third party ever sees the file). One
    // credentialed fetch on every device — docx files are small, and a
    // single request is the most reliable pattern on mobile.
    async function openDocx(prefetched) {
      let mammoth;
      try {
        mammoth = await loadMammoth();
      } catch (err) {
        return showUnrenderable('engine');
      }
      if (destroyed) return;
      setStatus('Opening document…');
      let data = prefetched;
      try {
        if (!data) {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 60000);
          const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) {
            const err = new Error('');
            err.status = res.status;
            throw err;
          }
          data = new Uint8Array(await res.arrayBuffer());
        }
        if (data.length < 4) throw new Error('empty');
        if (!(data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04)) {
          // Not a ZIP after all — the type was mis-guessed. Re-sniff and
          // route to the renderer that actually fits instead of failing.
          const kind = sniffBytes(data);
          if (kind === 'pdf') return openPdf({ bytes: data });
          if (kind === 'text') return openTextWithBytes(data);
          return showUnrenderable('mismatch');
        }
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const out = await mammoth.convertToHtml({ arrayBuffer: ab });
        if (destroyed) return;
        const html = String(out && out.value || '').replace(/<script[\s\S]*?<\/script>/gi, '').trim();
        if (!html) return showUnrenderable('empty');
        renderDocx(html, out && out.messages);
      } catch (err) {
        if (destroyed) return;
        if (err && err.status === 401) return showError('Please log in again to open this document.');
        if (err && err.status === 403) return showError('You do not have access to this document with your current plan.');
        console.error('[StudyCore reader] docx open failed', err);
        return showUnrenderable('error');
      }
    }

    function renderDocx(html, messages) {
      clearStatus();
      scroll.innerHTML = `
        <div class="doc-page doc-page-docx">
          <article class="docx-content">${html}</article>
        </div>`;
      const sub = host.querySelector('.doc-reader-sub');
      if (sub) sub.textContent = `${fmtSize(o.fileSize)}${o.fileSize ? ' · ' : ''}Word document · StudyCore Document Viewer`;
      // Surface mammoth warnings (rare: unsupported constructs) without
      // blocking the content.
      const warnings = Array.isArray(messages)
        ? messages.filter((m) => m && m.type === 'warning').map((m) => m.message).slice(0, 3)
        : [];
      if (warnings.length) {
        const note = document.createElement('p');
        note.className = 'docx-note';
        note.textContent = `Some formatting may be missing: ${warnings.join(' ')}`;
        scroll.appendChild(note);
      }
      if (typeof o.onOpen === 'function') o.onOpen({ pages: null, type: 'docx' });
    }

    /* ── Text path with pre-fetched bytes ───── */
    function openTextWithBytes(data) {
      clearStatus();
      const text = new TextDecoder('utf-8').decode(data);
      const pre = document.createElement('pre');
      pre.className = 'doc-reader-text';
      pre.textContent = text;
      scroll.innerHTML = '';
      scroll.appendChild(pre);
    }

    /* ── Byte-sniff dispatch for ambiguous types ── */
    // The metadata said octet-stream / nothing (or a bare UUID name). Fetch
    // a small slice, decide what the file really is, and route it to the
    // matching renderer — so nothing ever dead-ends with a misleading
    // "not a readable PDF" error.
    async function sniffAndDispatch() {
      if (dispatchDepth >= 2) {
        return showError('This document could not be opened. It may be corrupted — ask your admin to re-upload a PDF version.');
      }
      dispatchDepth += 1;
      setStatus('Opening document…');
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        let res = await fetch(url, {
          method: 'GET', credentials: 'include', cache: 'no-store',
          headers: { Range: 'bytes=0-8191' }, signal: ctrl.signal
        });
        clearTimeout(t);
        if (!res.ok && res.status !== 206) {
          let message = 'This document could not be opened.';
          if (res.status === 401) message = 'Please log in again to open this document.';
          else if (res.status === 403) message = 'You do not have access to this document with your current plan.';
          try { const d = await res.json(); if (d && d.message) message = d.message; } catch { /* not JSON */ }
          return showError(message);
        }
        const data = new Uint8Array(await res.arrayBuffer());
        if (destroyed) return;
        if (data.length < 4) return showError('The uploaded file is empty or corrupted.');
        // The slice above is for IDENTIFICATION only. Every renderer below
        // does its own full-file load — handing it the 8KB slice would mean
        // rendering a truncated document.
        const kind = sniffBytes(data);
        if (kind === 'pdf') return openPdf();
        if (kind === 'docx') return openDocx();
        if (kind === 'image') return openImage();
        if (kind === 'text') return openText();
        return showUnrenderable(kind);
      } catch (err) {
        if (destroyed) return;
        if (err && err.name === 'AbortError') return showError('The document server did not respond in time.');
        // Range request failed (shouldn't happen — the stream endpoint
        // supports ranges). PDF is the dominant document type here, so try
        // the normal PDF path before giving up.
        console.warn('[StudyCore reader] sniff probe failed, trying PDF', err);
        return openPdf();
      }
    }

    /* ── Unrenderable fallback ────────────────── */
    // File types the in-browser reader cannot paint (legacy .doc,
    // PowerPoint, Excel, plain zips, corrupt files) stay view-only. There is
    // intentionally no fallback link that exports the protected source file.
    function showUnrenderable(kind) {
      if (destroyed) return;
      clearStatus();
      const name = String(o.fileName || '').trim();
      const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
      const OFFICE_LABELS = {
        doc: 'Word (.doc)', ppt: 'PowerPoint', pptx: 'PowerPoint',
        xls: 'Excel', xlsx: 'Excel', zip: 'ZIP archive'
      };
      let body;
      if (kind === 'empty') body = 'The uploaded file appears to be empty or corrupted. Ask your admin to re-upload it.';
      else if (OFFICE_LABELS[ext]) body = `${OFFICE_LABELS[ext]} files cannot be displayed by the protected reader. Ask your admin to upload a PDF version for in-browser reading.`;
      else if (kind === 'engine') body = 'The document engine could not be loaded. Check your connection and try again.';
      else if (kind === 'mismatch') body = 'This file could not be identified as a supported in-browser format. Ask your admin to upload a PDF version.';
      else body = `This file type${ext ? ` (${ext.toUpperCase()})` : ''} can't be previewed in the StudyCore viewer. Ask your admin whether a PDF version is available.`;
      scroll.innerHTML = `
        <div class="doc-page-fallback doc-page-fallback-lg">
          ${icon('file', 26)}
          <h3>Preview not available in-browser</h3>
          <p>${esc(body)}</p>
        </div>`;
    }

    /* ── Boot: use metadata, then let the renderer validate access ── */
    (function boot() {
      setStatus('Opening document…');
      // Resource metadata came from an authenticated endpoint immediately
      // before this reader was created. Starting the matching renderer now
      // avoids a separate HEAD request (and its storage round trip). Unknown
      // legacy uploads use one tiny range probe instead.
      const kind = guessType(o.mimeType || '');
      if (kind === 'pdf') return openPdf();
      if (kind === 'docx') return openDocx();
      if (kind === 'image') return openImage();
      if (kind === 'text') return openText();
      if (kind === 'unknown') return sniffAndDispatch();
      return showUnrenderable(kind);
    })();

    /* ── Reflow on rotate / resize ──────────── */
    let resizeTimer = null;
    let lastWidth = window.innerWidth;
    function onResize() {
      if (destroyed || !pdfDoc) return;
      // Pages are sized from the container WIDTH, so a height-only change
      // needs no reflow. On mobile the address bar collapsing/expanding
      // fires resize events while the width stays put — re-rasterising every
      // page for those (the old behaviour) blanked the pages mid-read and
      // cost real battery on phones. Only reflow when the width actually
      // changed (rotation or real window resize), on any device.
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (!destroyed) applyZoomSizes(); }, 220);
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    function destroy(full) {
      destroyed = true;
      searchSeq += 1;
      searchActive = false;
      searchResults = [];
      textCache.clear();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      clearTimeout(resizeTimer);
      pageEntries.forEach(releasePage);
      if (pdfDoc) { try { pdfDoc.destroy(); } catch { /* noop */ } pdfDoc = null; }
      if (full !== false) host.innerHTML = '';
    }

    // Controller — the standalone viewer page (and any other embedder) drives
    // the reader through this instead of reaching into the DOM.
    return {
      nextPage: () => goToPage(currentPage + 1),
      prevPage: () => goToPage(currentPage - 1),
      goToPage: (n) => goToPage(n),
      zoomIn: () => { zoom = Math.min(3, Math.round((zoom + 0.25) * 100) / 100); applyZoomSizes(); },
      zoomOut: () => { zoom = Math.max(0.5, Math.round((zoom - 0.25) * 100) / 100); applyZoomSizes(); },
      fitWidth: () => { zoom = 1; applyZoomSizes(); },
      toggleFullscreen,
      search: (q) => runSearch(q),
      searchNext: () => searchStep(1),
      searchPrev: () => searchStep(-1),
      clearSearch,
      getState: () => ({ page: currentPage, numPages: pdfDoc ? pdfDoc.numPages : 0, zoom: Math.round(zoom * 100) }),
      destroy: () => destroy(true)
    };
  }

  global.StudyCoreReader = { init };
})(window);
