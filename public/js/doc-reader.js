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
//   · one credentialed fetch for normal-sized mobile PDFs (avoids WebView
//     range/cookie bugs), with range loading retained for large documents.
// =============================================

(function (global) {
  'use strict';

  const PDFJS_LIB = '/vendor/pdfjs/pdf.min.js';
  const PDFJS_WORKER = '/vendor/pdfjs/pdf.worker.min.js';
  const PDFJS_FONTS = '/vendor/pdfjs/standard_fonts/';

  // How many pages either side of the visible one keep a live canvas.
  const RENDER_WINDOW = 2;

  let pdfjsPromise = null;

  function loadPdfJs() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFJS_LIB;
      s.async = true;
      s.onload = () => {
        if (!global.pdfjsLib) return reject(new Error('PDF engine failed to initialise.'));
        global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        resolve(global.pdfjsLib);
      };
      s.onerror = () => reject(new Error('Could not load the StudyCore PDF engine.'));
      document.head.appendChild(s);
    });
    return pdfjsPromise;
  }

  function isMobileViewport() {
    return Math.min(window.innerWidth, window.innerHeight) <= 820;
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
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
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
    let observer = null;
    let resizeRaf = null;
    const pageEntries = [];      // { n, wrap, canvas, task, rendered, width, height, scale }
    let zoom = 1;
    let fitScale = 1;
    let currentPage = 1;
    let streamSize = Number(o.fileSize) || 0;

    /* ── Chrome ─────────────────────────────── */
    host.innerHTML = `
      <div class="card doc-reader" id="scDocReader">
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
            <button type="button" class="doc-tool" id="scDocFs" aria-label="Fullscreen">${icon('maximize', 16)}</button>
          </div>
        </div>
        <div class="doc-reader-stage" id="scDocStage">
          <div class="doc-reader-status" id="scDocStatus">
            <div class="player-spinner"></div>
            <p id="scDocStatusText">Opening document…</p>
          </div>
          <div class="doc-reader-scroll" id="scDocScroll" tabindex="0"></div>
        </div>
      </div>`;

    const reader = host.querySelector('#scDocReader');
    const stage = host.querySelector('#scDocStage');
    const scroll = host.querySelector('#scDocScroll');
    const tools = host.querySelector('#scDocTools');
    const statusBox = host.querySelector('#scDocStatus');
    const statusText = host.querySelector('#scDocStatusText');
    const pageLabel = host.querySelector('#scDocPageLabel');
    const zoomLabel = host.querySelector('#scDocZoomLabel');

    // Protected content: no right-click "save", no drag-out.
    reader.addEventListener('contextmenu', (e) => e.preventDefault());
    reader.addEventListener('dragstart', (e) => e.preventDefault());

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
    function guessType(servedType) {
      const name = String(o.fileName || '').toLowerCase();
      const t = String(servedType || o.mimeType || '').split(';')[0].trim().toLowerCase();
      if (t === 'application/pdf' || /\.pdf$/.test(name)) return 'pdf';
      if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/.test(name)) return 'image';
      if (t.startsWith('text/') || /\.(txt|csv|md)$/.test(name)) return 'text';
      if (t === 'application/octet-stream' || !t) {
        if (/\.pdf$/.test(name)) return 'pdf';
      }
      return 'other';
    }

    /* ── PDF path ───────────────────────────── */
    function availableWidth() {
      const pad = isMobileViewport() ? 16 : 40;
      const w = (scroll.clientWidth || stage.clientWidth || host.clientWidth || 640) - pad;
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
      pageEntries.forEach((entry) => {
        entry.wrap.style.width = width + 'px';
        if (entry.ratio) entry.wrap.style.height = Math.round(width * entry.ratio) + 'px';
        // Force a re-raster at the new scale.
        releasePage(entry);
      });
      if (zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + '%';
      scheduleVisible();
    }

    function goToPage(n) {
      const entry = pageEntries[Math.min(Math.max(1, n), pageEntries.length) - 1];
      if (!entry) return;
      currentPage = entry.n;
      updatePageLabel();
      scroll.scrollTo({ top: entry.wrap.offsetTop - 8, behavior: 'smooth' });
      renderPage(entry);
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
      on('#scDocFs', () => {
        const active = document.fullscreenElement || document.webkitFullscreenElement;
        if (active) {
          const exit = document.exitFullscreen || document.webkitExitFullscreen;
          if (exit) exit.call(document);
          return;
        }
        const req = reader.requestFullscreen || reader.webkitRequestFullscreen;
        if (req) req.call(reader);
      });
    }

    async function fetchPdfForMobile() {
      setStatus('Loading document for mobile…');
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 90000);
      try {
        const res = await fetch(url, {
          credentials: 'include',
          cache: 'no-store',
          signal: ctrl.signal
        });
        if (!res.ok) {
          const err = new Error(`Document request failed (${res.status}).`);
          err.status = res.status;
          throw err;
        }
        const data = new Uint8Array(await res.arrayBuffer());
        const header = new TextDecoder('ascii').decode(data.subarray(0, Math.min(1024, data.length)));
        if (!header.includes('%PDF-')) {
          throw new Error('The uploaded file is not a readable PDF.');
        }
        return data;
      } finally {
        clearTimeout(timeout);
      }
    }

    async function openPdf() {
      let pdfjs;
      try {
        pdfjs = await loadPdfJs();
      } catch (err) {
        showError(err.message || 'Could not load the StudyCore PDF engine.');
        return;
      }
      if (destroyed) return;

      // Mobile Safari and some Android WebViews are unreliable when pdf.js
      // performs many authenticated range requests from its network layer.
      // For normal-sized PDFs, make one credentialed request in the page and
      // hand the bytes directly to pdf.js. Larger files keep progressive
      // range loading to avoid exhausting the device's memory.
      const mobileBufferLimit = 32 * 1024 * 1024;
      let pdfSource = { url: url, withCredentials: true };
      if (isMobileViewport() && streamSize > 0 && streamSize <= mobileBufferLimit) {
        try {
          pdfSource = { data: await fetchPdfForMobile() };
        } catch (err) {
          if (err && (err.status === 401 || err.status === 403 || /not a readable PDF/i.test(err.message))) {
            showError(err.status === 401
              ? 'Please log in again to open this document.'
              : err.status === 403
                ? 'You do not have access to this document with your current plan.'
                : err.message);
            return;
          }
          // A one-shot fetch can fail on a transient mobile connection. The
          // normal range loader is still worth trying before showing an error.
          console.warn('[StudyCore reader] mobile buffered load failed; trying ranges', err);
          pdfSource = { url: url, withCredentials: true };
        }
      }

      if (destroyed) return;
      setStatus('Opening document…');
      const task = pdfjs.getDocument({
        ...pdfSource,
        disableRange: false,
        disableStream: false,
        // Auto-fetch is required by some linearized and cross-reference-heavy
        // PDFs on Safari. The lazy canvas window still controls render memory.
        disableAutoFetch: false,
        rangeChunkSize: 262144,
        standardFontDataUrl: PDFJS_FONTS,
        isEvalSupported: false
      });

      task.onProgress = (p) => {
        if (!p || !p.total || destroyed) return;
        const pct = Math.min(99, Math.round((p.loaded / p.total) * 100));
        if (statusText && !statusBox.hidden) setStatus(`Opening document… ${pct}%`);
      };

      let pdf;
      try {
        pdf = await task.promise;
      } catch (err) {
        if (destroyed) return;
        const name = err && err.name;
        let message = 'This document could not be opened.';
        if (name === 'PasswordException') message = 'This document is password protected.';
        else if (name === 'InvalidPDFException') message = 'This file is not a readable PDF.';
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
      await layoutPages(pdf);
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

    /* ── Boot: confirm access, learn the real type, then render ── */
    (async function boot() {
      setStatus('Opening document…');
      let servedType = o.mimeType || '';
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        let probe = await fetch(url, { method: 'HEAD', credentials: 'include', signal: ctrl.signal });
        if (probe.status === 405 || probe.status === 501) {
          probe = await fetch(url, { method: 'GET', credentials: 'include', headers: { Range: 'bytes=0-0' }, signal: ctrl.signal });
          if (probe.body && probe.body.cancel) { try { await probe.body.cancel(); } catch { /* closed */ } }
        }
        clearTimeout(t);
        if (!probe.ok && probe.status !== 206) {
          let message = 'This document could not be opened.';
          if (probe.status === 401) message = 'Please log in again to open this document.';
          else if (probe.status === 403) message = 'You do not have access to this document with your current plan.';
          else if (probe.status === 404) message = 'This document is missing from storage.';
          else if (probe.status === 503) message = 'File storage is not configured yet, so this file cannot be opened.';
          try { const d = await probe.json(); if (d && d.message) message = d.message; } catch { /* not JSON */ }
          showError(message);
          return;
        }
        servedType = probe.headers.get('content-type') || servedType;
        const servedLength = Number(probe.headers.get('content-length'));
        if (Number.isFinite(servedLength) && servedLength > 0) streamSize = servedLength;
      } catch (err) {
        if (destroyed) return;
        showError(err.name === 'AbortError'
          ? 'The document server did not respond in time.'
          : 'Could not reach the document. Check your connection and try again.');
        return;
      }
      if (destroyed) return;

      const kind = guessType(servedType);
      if (kind === 'pdf') return openPdf();
      if (kind === 'image') return openImage();
      if (kind === 'text') return openText();

      clearStatus();
      scroll.innerHTML = `
        <div class="doc-page-fallback doc-page-fallback-lg">
          ${icon('file', 26)}
          <h3>Preview not available in-browser</h3>
          <p>This file type (${esc((servedType || 'unknown').split(';')[0])}) can't be rendered in the StudyCore viewer.
          Ask your admin whether a PDF version is available.</p>
        </div>`;
    })();

    /* ── Reflow on rotate / resize ──────────── */
    let resizeTimer = null;
    let lastWidth = window.innerWidth;
    function onResize() {
      if (destroyed || !pdfDoc) return;
      if (window.innerWidth === lastWidth) return; // ignore mobile URL-bar height changes
      lastWidth = window.innerWidth;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (!destroyed) applyZoomSizes(); }, 220);
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    function destroy(full) {
      destroyed = true;
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      clearTimeout(resizeTimer);
      if (observer) observer.disconnect();
      pageEntries.forEach(releasePage);
      if (pdfDoc) { try { pdfDoc.destroy(); } catch { /* noop */ } pdfDoc = null; }
      if (full !== false) host.innerHTML = '';
    }

    return { destroy: () => destroy(true) };
  }

  global.StudyCoreReader = { init };
})(window);
