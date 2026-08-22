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
    let observer = null;
    let resizeRaf = null;
    const pageEntries = [];      // { n, wrap, canvas, task, rendered, width, height, scale }
    let zoom = 1;
    let fitScale = 1;
    let currentPage = 1;
    let streamSize = Number(o.fileSize) || 0;
    // Loop guard: how many times the file has bounced between "thought to be
    // PDF" and "sniffed the bytes". Bounds the retry chains so a corrupt
    // file reaches the error state instead of ping-ponging.
    let dispatchDepth = 0;

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
      // sniff usually fixed the Content-Type by now, and if it could not,
      // 'unknown' lets boot() inspect the bytes and route to the right
      // renderer (PDF, Word or the download fallback).
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

    // One credentialed fetch of the whole file — the most reliable pattern
    // on mobile (WebViews mishandle many small authenticated range
    // requests). Returns the bytes, or throws with .status for auth errors.
    // JSON error bodies that slipped through (e.g. a 401 with a message)
    // are surfaced as their real message instead of a PDF error.
    async function fetchDocumentBytes() {
      setStatus('Loading document…');
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
        if (data.length < 4) {
          throw new Error('The uploaded file is empty or corrupted.');
        }
        // A JSON body here means an error response slipped through —
        // surface its real message rather than treating bytes as a file.
        if (data[0] === 0x7b /* '{' */) {
          try {
            const j = JSON.parse(new TextDecoder('utf-8').decode(data.subarray(0, Math.min(data.length, 2048))));
            if (j && j.message) {
              const err = new Error(j.message);
              err.status = res.status;
              throw err;
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) {
              throw new Error('The uploaded file is corrupted.');
            }
            throw parseErr;
          }
        }
        return data;
      } finally {
        clearTimeout(timeout);
      }
    }

    // Dispatch on the bytes we actually have, now that the file's real type
    // is known. Re-uses already-fetched data so nothing is downloaded twice.
    function dispatchOnBytes(data) {
      const kind = sniffBytes(data);
      if (kind === 'pdf') return openPdf({ bytes: data });
      if (kind === 'docx') return openDocx(data);
      if (kind === 'image') return openImage();
      if (kind === 'text') return openTextWithBytes(data);
      return showUnrenderable(kind, { kind });
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

      // Mobile Safari and some Android WebViews are unreliable when pdf.js
      // performs many authenticated range requests from its network layer.
      // For normal-sized PDFs, make one credentialed request in the page and
      // hand the bytes directly to pdf.js. Larger files keep progressive
      // range loading to avoid exhausting the device's memory.
      //
      // The buffered path is ALWAYS tried on mobile first, regardless of
      // whether we know the size: when the size is unknown, range loading
      // on a phone crashed and left a blank white box that the OS then tried
      // to "Open with" — the original mobile reader bug.
      const mobileBufferLimit = 32 * 1024 * 1024;
      let pdfSource = { url: url, withCredentials: true };
      let usedBuffered = false;

      if (prefetchedBytes) {
        pdfSource = { data: prefetchedBytes };
        usedBuffered = true;
      } else if (isMobileViewport()) {
        const tryBuffered = streamSize === 0 || streamSize <= mobileBufferLimit;
        if (tryBuffered) {
          try {
            const data = await fetchDocumentBytes();
            if (data.length > 80 * 1024 * 1024) {
              console.warn('[StudyCore reader] mobile file too large for buffered, trying ranges', data.length);
            } else {
              // The file may not actually be a PDF (metadata lies — that is
              // how bare-UUID Word uploads used to land here). If the magic
              // bytes say otherwise, route it to the renderer that fits
              // instead of erroring with "not a readable PDF".
              const isPdf = data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
              if (!isPdf) {
                console.warn('[StudyCore reader] expected PDF, bytes say otherwise — dispatching on real type');
                return dispatchOnBytes(data);
              }
              pdfSource = { data: data };
              usedBuffered = true;
            }
          } catch (err) {
            if (err && (err.status === 401 || err.status === 403 || /log in again/i.test(err.message) || /access/i.test(err.message))) {
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
        // pdf.js rejected the bytes. If we never looked at the actual file
        // (URL/range path), the type metadata was probably wrong — sniff the
        // real type and route to the renderer that fits, with a depth guard
        // so a genuinely corrupt file can't bounce between the two forever.
        if (name === 'InvalidPDFException' && !usedBuffered && dispatchDepth < 2) {
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
          return showUnrenderable('mismatch', { kind });
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
        return showUnrenderable(kind, { kind });
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

    /* ── Unrenderable fallback (never a dead end) ── */
    // File types the in-browser reader cannot paint (legacy .doc,
    // PowerPoint, Excel, plain zips, corrupt files). The session-gated
    // download endpoint applies the exact same server-side access rules as
    // the stream, so the button is safe to offer: a student who can open
    // this resource may download it to their device's own app.
    function showUnrenderable(kind, ctx) {
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
      else if (OFFICE_LABELS[ext]) body = `${OFFICE_LABELS[ext]} files need an app on your device to open. Download it below, or ask your admin to upload a PDF version for in-browser reading.`;
      else if (kind === 'engine') body = 'The document engine could not be loaded. Check your connection and try again.';
      else if (kind === 'mismatch') body = 'This file could not be identified as a supported format. Download it to open it on this device.';
      else body = `This file type${ext ? ` (${ext.toUpperCase()})` : ''} can't be previewed in the StudyCore viewer. Ask your admin whether a PDF version is available.`;
      scroll.innerHTML = `
        <div class="doc-page-fallback doc-page-fallback-lg">
          ${icon('file', 26)}
          <h3>Preview not available in-browser</h3>
          <p>${esc(body)}</p>
          ${o.downloadUrl ? `<a class="btn btn-teal btn-sm" href="${esc(o.downloadUrl)}" target="_blank" rel="noopener">${icon('download', 15)} Download to open on this device</a>` : ''}
        </div>`;
      const link = scroll.querySelector('a[href]');
      if (link) {
        // Keep the reader's context-menu/drag blockers honest: the download
        // is a deliberate action, not an accidental drag-out.
        link.addEventListener('contextmenu', (e) => e.preventDefault());
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
          else if (probe.body && typeof probe.body.getReader === 'function') {
            try { const r = probe.body.getReader(); await r.cancel(); } catch { /* ignore */ }
          }
        }
        clearTimeout(t);
        if (!probe.ok && probe.status !== 206) {
          let message = 'This document could not be opened.';
          if (probe.status === 401) message = 'Please log in again to open this document.';
          else if (probe.status === 403) message = 'You do not have access to this document with your current plan.';
          else if (probe.status === 404) message = 'This document is missing from storage.';
          else if (probe.status === 503) message = 'File storage is not configured yet, so this file cannot be opened.';
          try {
            const clone = probe.clone ? probe.clone() : probe;
            const d = await clone.json();
            if (d && d.message) message = d.message;
          } catch { /* not JSON */ }
          showError(message);
          return;
        }
        servedType = probe.headers.get('content-type') || servedType;
        const servedLength = Number(probe.headers.get('content-length'));
        if (Number.isFinite(servedLength) && servedLength > 0) streamSize = servedLength;
      } catch (err) {
        if (destroyed) return;
        // If HEAD fails (e.g. network hiccup), don't abort — try to open as PDF
        // anyway. The PDF open will do its own fetch with better error handling.
        console.warn('[StudyCore reader] HEAD probe failed, trying PDF anyway', err);
        // Keep servedType from options, which lesson.js now ensures is PDF for
        // bare-UUID names.
      }
      if (destroyed) return;

      const kind = guessType(servedType);
      if (kind === 'pdf') return openPdf();
      if (kind === 'docx') return openDocx();
      if (kind === 'image') return openImage();
      if (kind === 'text') return openText();
      if (kind === 'unknown') return sniffAndDispatch();
      return showUnrenderable(kind, { kind });
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
