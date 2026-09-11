// =============================================
// STUDYCORE — Content Privacy Guard (js/privacy-guard.js)
// -----------------------------------------------
// Makes StudyCore's LEARNING CONTENT private: no right-click save, no
// copy/cut, no text selection, no drag-out, no printing, no in-page screen
// capture, a black "content hidden" curtain whenever the window stops being
// the thing the student is actually looking at, and a per-student watermark
// burned over every protected video/document surface.
//
// ---------------------------------------------------------------------------
// READ THIS BEFORE CHANGING ANYTHING (what a browser can and cannot do)
// ---------------------------------------------------------------------------
// A web page CANNOT hard-block an operating-system screenshot. There is no
// web API for it — not in Chrome, Firefox, Safari or Edge. Windows Snipping
// Tool, macOS Cmd+Shift+4, Android/iOS screenshots and OBS all run OUTSIDE
// the browser sandbox, and a phone camera pointed at the monitor defeats
// every software control ever written. Anyone claiming otherwise is selling
// something.
//
// The only true screen-capture blocking on the web is hardware DRM
// (Widevine L1 / PlayReady SL3000 / FairPlay via Encrypted Media Extensions),
// where decoded frames never enter memory the OS compositor can read, so a
// recording comes out black. That requires DRM-packaged media — see
// docs/content-protection.md for how to switch StudyCore's video path onto
// Cloudflare Stream DRM when the owner is ready to pay for it.
//
// So this file does the next best thing, which in practice stops the casual
// 99%: it removes every in-browser copy route, it makes the common capture
// gestures produce a black rectangle instead of the lesson, it scrubs the
// clipboard after PrintScreen, and it stamps the student's own name and email
// across the content so anything that DOES leak is traceable to one account.
//
// Native wrappers: if StudyCore is ever shipped inside an Android WebView /
// PWA wrapper, `applyNativeSecureFlag()` below asks the host to set
// FLAG_SECURE, which IS a real OS-level screenshot block on Android.
// =============================================

(function (global) {
  'use strict';

  /* ── Which pages are protected ─────────────
     Scope: LEARNING CONTENT ONLY. Marketing pages (home, about, pricing,
     terms, privacy), the auth pages and the admin/content-admin dashboards
     are deliberately absent — publishers need normal copy/paste to do their
     job, and locking down the public site would only hurt SEO and support.

       'strict' — full treatment: deterrents + focus-loss curtain +
                  per-student watermark + devtools curtain.
       'basic'  — deterrents only (no curtain, no watermark). Used on the
                  listing pages, where a curtain would be pure annoyance.  */
  const PAGE_POLICY = {
    lesson: 'strict',    // /pages/lesson.html — player + document reader
    viewer: 'strict',    // /viewer/:id       — standalone document reader
    course: 'strict',    // /course/:key + /pages/subjects/*.html
    videos: 'strict',    // /pages/videos.html
    courses: 'basic',    // /pages/courses.html
    resources: 'basic',  // /pages/resources.html
    search: 'basic'      // /pages/search.html
  };

  /* ── Surfaces that carry the watermark ─────
     These are the elements that actually render protected media.

     Each one is deliberately the element that ALSO gets fullscreened, because
     a fullscreen element only paints its own subtree — a watermark anywhere
     else in the document vanishes the moment a student goes fullscreen,
     which is exactly when they would capture it.

       .player-shell      is `shell.requestFullscreen()` in player.js
       .doc-reader-stage  is `fsTarget = stage` in doc-reader.js

     Note .doc-reader (the outer card in embedded/lesson mode) is NOT listed:
     it WRAPS .doc-reader-stage, so listing both would stamp the lesson page
     twice, and the outer card is not the fullscreen target anyway. */
  const PROTECTED_SURFACES = [
    '.player-shell',       // video player (progressive + Cloudflare Stream)
    '.doc-reader-stage',   // document reader, embedded and bare alike
    '[data-sc-protect]'    // opt-in hook for anything added later
  ].join(',');

  const CLIPBOARD_NOTICE =
    'StudyCore protected content. Copying is disabled — open the lesson in StudyCore to study it.';

  const page = (document.body && document.body.dataset.page) || '';
  const policy = PAGE_POLICY[page] || null;

  // Nothing to do on unprotected pages. Exit before touching a single
  // listener so the marketing site and the dashboards behave exactly as
  // they always have.
  if (!policy) return;

  const strict = policy === 'strict';
  const isTouch = matchMedia('(hover: none)').matches || 'ontouchstart' in global;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Typing must keep working: the document reader's search box, the global
  // search field and every admin-style input stay fully interactive.
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  /* ── Feedback (throttled) ──────────────────
     One quiet toast, not a barrage — a student who right-clicks out of habit
     should be told once why nothing happened, not scolded on every click. */
  let lastToast = 0;
  function notify(message) {
    const now = Date.now();
    if (now - lastToast < 4000) return;
    lastToast = now;
    if (typeof global.showToast === 'function') global.showToast(message, 'info');
  }

  /* ══════════════════════════════════════════
     1. Copy / save / drag / selection routes
     ══════════════════════════════════════════ */
  function blockCopyRoutes() {
    // Right-click "Save image as…", "Save video as…", "Copy text".
    document.addEventListener('contextmenu', (e) => {
      if (isEditable(e.target)) return;
      e.preventDefault();
      notify('Right-click is disabled on protected StudyCore content.');
    });

    // Paste into the content area itself (not into a form field) is blocked
    // too: it is the other half of a clipboard round-trip and, more
    // practically, it stops a pasted script/HTML fragment from being dropped
    // into the reader. The document search box and every other input stay
    // fully pasteable — a student typing a search term must be able to paste
    // it.
    document.addEventListener('paste', (e) => {
      if (isEditable(e.target)) return;
      e.preventDefault();
    });

    // Copy / cut: replace whatever was grabbed with a notice, so even a
    // clipboard manager gets nothing useful.
    ['copy', 'cut'].forEach((type) => {
      document.addEventListener(type, (e) => {
        if (isEditable(e.target)) return;
        e.preventDefault();
        try {
          if (e.clipboardData) e.clipboardData.setData('text/plain', CLIPBOARD_NOTICE);
        } catch { /* clipboard is best-effort */ }
        notify('Copying is disabled on protected StudyCore content.');
      });
    });

    // Drag-out (dragging a canvas/image straight onto the desktop).
    document.addEventListener('dragstart', (e) => {
      if (isEditable(e.target)) return;
      e.preventDefault();
    });

    // Selection highlight — the visual precursor to a copy.
    document.addEventListener('selectstart', (e) => {
      if (isEditable(e.target)) return;
      e.preventDefault();
    });
  }

  /* ══════════════════════════════════════════
     2. Printing (and "Print to PDF", which is
        really a full-quality screenshot)
     ══════════════════════════════════════════ */
  function blockPrinting() {
    // CSS in privacy-guard.css blanks the page for print. This also stops
    // the dialog opening at all when it was triggered from our own code.
    try {
      global.print = function blockedPrint() {
        notify('Printing is disabled on protected StudyCore content.');
      };
    } catch { /* some browsers make window.print non-writable */ }

    global.addEventListener('beforeprint', () => {
      // Belt and braces with the print stylesheet: raise the curtain too, so
      // even a browser that ignores the @media print rule renders the black
      // overlay into the PDF instead of the lesson.
      if (strict) showCurtain('print');
    });
    global.addEventListener('afterprint', () => hideCurtain('print'));
  }

  /* ══════════════════════════════════════════
     3. Screen-capture APIs the PAGE could use
     ══════════════════════════════════════════
     Backs up the `display-capture=()` Permissions-Policy header set in
     middleware/security.js. Stops any injected script (or a rogue embed)
     from quietly recording the tab with getDisplayMedia. */
  function blockCaptureApis() {
    const blocked = function blockedGetDisplayMedia() {
      notify('Screen capture is disabled on protected StudyCore content.');
      const Err = global.DOMException || Error;
      return Promise.reject(new Err('Screen capture is disabled on StudyCore.', 'NotAllowedError'));
    };

    // Installed UNCONDITIONALLY rather than only when the API already
    // exists: a browser that adds getDisplayMedia later (or a script that
    // polyfills it to smuggle a recorder in) must hit the same refusal.
    try {
      if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = blocked;
    } catch { /* read-only in some hardened environments; the header still applies */ }
    try {
      // Legacy/prefixed entry point used by older recorders.
      navigator.getDisplayMedia = blocked;
    } catch { /* non-writable: nothing more to do */ }

    if (!strict) return;

    /* ── In-page capture of the PROTECTED SURFACES themselves ───────────
       getDisplayMedia records the screen. These next three record the
       CONTENT, without any permission prompt at all, and they matter here
       specifically because the document reader renders every PDF page into
       a <canvas>: `canvas.toDataURL()` in the console is a pixel-perfect,
       full-resolution copy of the page the student is reading, and
       `captureStream()` turns the same canvas (or the <video>) into a
       MediaStream a MediaRecorder can write to a file.

       Each is scoped to protected surfaces only. A canvas elsewhere on the
       site — a chart, an avatar cropper, anything added later — keeps
       working exactly as it always has, so this cannot break unrelated
       features. */
    function insideProtectedContent(el) {
      try {
        return Boolean(el && el.closest && el.closest('.sc-protected-surface, .player-shell, .doc-reader-stage'));
      } catch { return false; }
    }

    const refuse = (what) => {
      notify(`${what} is disabled on protected StudyCore content.`);
      const Err = global.DOMException || Error;
      return new Err(`${what} is disabled on StudyCore.`, 'SecurityError');
    };

    // Canvas → image data (the PDF page grab).
    ['toDataURL', 'toBlob'].forEach((method) => {
      try {
        const Canvas = global.HTMLCanvasElement;
        if (!Canvas || typeof Canvas.prototype[method] !== 'function') return;
        const original = Canvas.prototype[method];
        Canvas.prototype[method] = function guarded(...args) {
          if (!insideProtectedContent(this)) return original.apply(this, args);
          const err = refuse('Copying page images');
          // toBlob reports failure through its callback; toDataURL throws.
          if (method === 'toBlob' && typeof args[0] === 'function') return args[0](null);
          throw err;
        };
      } catch { /* frozen prototype: the surrounding deterrents still apply */ }
    });

    // Canvas / media → MediaStream (the silent in-page recorder).
    [global.HTMLCanvasElement, global.HTMLMediaElement].forEach((Ctor) => {
      try {
        if (!Ctor || typeof Ctor.prototype.captureStream !== 'function') return;
        const original = Ctor.prototype.captureStream;
        Ctor.prototype.captureStream = function guarded(...args) {
          if (!insideProtectedContent(this)) return original.apply(this, args);
          throw refuse('Recording this content');
        };
      } catch { /* not writable in this browser */ }
    });
  }

  /* ══════════════════════════════════════════
     3b. Picture-in-picture
     ══════════════════════════════════════════
     PiP floats the video in an OS-level window that lives OUTSIDE the page.
     Once it is up, the curtain cannot cover it, the watermark is still
     painted (it is composited into the video? — no, it is NOT: PiP shows the
     raw video frames only), and the student can keep the lesson visible
     while they switch to a recorder. That is a straight hole through the
     protection, so it is closed on protected pages.

     The progressive <video> already carries `disablepictureinpicture`, which
     removes the browser's own PiP button. This closes the JS route and the
     Android/desktop "auto-PiP on tab switch" behaviour too. */
  function blockPictureInPicture() {
    try {
      const proto = global.HTMLVideoElement && global.HTMLVideoElement.prototype;
      if (proto && typeof proto.requestPictureInPicture === 'function') {
        const original = proto.requestPictureInPicture;
        proto.requestPictureInPicture = function guarded(...args) {
          try {
            if (this.closest && this.closest('.sc-protected-surface, .player-shell')) {
              notify('Picture-in-picture is disabled on protected StudyCore content.');
              const Err = global.DOMException || Error;
              return Promise.reject(new Err('Picture-in-picture is disabled on StudyCore.', 'NotAllowedError'));
            }
          } catch { /* fall through to the original */ }
          return original.apply(this, args);
        };
      }
    } catch { /* non-writable prototype */ }

    // Belt and braces: if a browser opens PiP anyway (some do it
    // automatically when the tab is hidden), leave it again immediately.
    document.addEventListener('enterpictureinpicture', (e) => {
      const target = e && e.target;
      try {
        if (!target || !target.closest || !target.closest('.sc-protected-surface, .player-shell')) return;
        if (document.exitPictureInPicture) document.exitPictureInPicture().catch(() => {});
      } catch { /* nothing more to do */ }
    }, true);
  }

  /* ══════════════════════════════════════════
     4. Screenshot keys + clipboard scrubbing
     ══════════════════════════════════════════
     PrintScreen never reaches JS as a preventable action on Windows — the OS
     takes the shot first. What we CAN do is overwrite the clipboard the
     instant the key comes back up, so Ctrl+V pastes the notice instead of
     the lesson. This genuinely defeats the plain PrtSc → paste-into-WhatsApp
     route that most casual sharing uses.

     macOS Cmd+Shift+3/4/5 and Windows Win+Shift+S are grabbed by the OS
     before the browser sees them; we still curtain on the keydown we DO get
     (and on the focus loss the snipping overlay causes). */
  function blockScreenshotKeys() {
    const scrub = () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText && document.hasFocus()) {
          navigator.clipboard.writeText(CLIPBOARD_NOTICE).catch(() => {});
        }
      } catch { /* permission denied — nothing more we can do */ }
    };

    document.addEventListener('keyup', (e) => {
      if (e.key === 'PrintScreen' || e.code === 'PrintScreen' || e.keyCode === 44) {
        scrub();
        if (strict) flashCurtain();
        notify('Screenshots of protected StudyCore content are not permitted.');
      }
    }, true);

    document.addEventListener('keydown', (e) => {
      const key = String(e.key || '').toLowerCase();
      const mod = e.ctrlKey || e.metaKey;

      // Print / Save page / View source / Select all.
      if (mod && ['p', 's', 'u'].includes(key)) {
        e.preventDefault();
        notify('This action is disabled on protected StudyCore content.');
        return;
      }
      if (mod && key === 'a' && !isEditable(e.target)) {
        e.preventDefault();
        return;
      }

      // macOS screenshot cluster (Cmd+Shift+3/4/5/6) and the Windows
      // Win+Shift+S snip. Best-effort: the OS usually wins the race, so the
      // curtain below is what actually protects the frame.
      if ((e.metaKey && e.shiftKey && ['3', '4', '5', '6'].includes(key))
        || (e.metaKey && e.shiftKey && key === 's')) {
        e.preventDefault();
        if (strict) flashCurtain();
        notify('Screenshots of protected StudyCore content are not permitted.');
        return;
      }

      // Devtools shortcuts — the obvious way to strip this whole overlay.
      const devtoolsCombo = key === 'f12'
        || (mod && e.shiftKey && ['i', 'j', 'c'].includes(key));
      if (devtoolsCombo) {
        e.preventDefault();
        notify('Developer tools are disabled on protected StudyCore content.');
      }
    }, true);
  }

  /* ══════════════════════════════════════════
     5. The curtain
     ══════════════════════════════════════════
     The single most effective in-browser measure. Any capture route that
     takes focus away from the page — Snipping Tool, the macOS screenshot
     overlay, alt-tabbing to OBS, switching to the recorder's window, a
     screen-share picker — leaves a black panel in the shot instead of the
     lesson.

     Reasons are reference-counted: the print handler and the blur handler
     can both hold the curtain up without one cancelling the other. */
  let curtainEl = null;
  const curtainReasons = new Set();

  function buildCurtain() {
    if (curtainEl) return curtainEl;
    const el = document.createElement('div');
    el.className = 'sc-privacy-curtain';
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'assertive');
    el.innerHTML = `
      <div class="sc-privacy-curtain-inner">
        <svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor"
             stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="11" width="18" height="10" rx="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        <h2>Protected StudyCore content</h2>
        <p data-sc-curtain-note>Content viewing has been temporarily paused.</p>
        <p class="sc-privacy-curtain-hint" data-sc-curtain-hint>Return to this window to continue studying.</p>
        <p class="sc-privacy-curtain-id" data-sc-curtain-id></p>
      </div>`;
    curtainEl = el;
    return el;
  }

  // A short, human explanation per trigger. Deliberately calm and identical
  // in tone: the student has usually done nothing wrong (they alt-tabbed, or
  // a notification stole focus), so nothing here accuses them of anything.
  const CURTAIN_HINTS = {
    hidden: 'Return to this tab to continue studying.',
    focus: 'Click back into this window to continue studying.',
    print: 'Printing and "Save as PDF" are disabled for this material.',
    flash: 'Screen captures of this material are not permitted.',
    capture: 'Screen sharing and recording are disabled for this material.',
    devtools: 'Close developer tools to continue viewing this content.'
  };

  /* Media is paused while the curtain is up.
     Two reasons. First, a student who alt-tabs away should not lose two
     minutes of a lecture playing to an empty screen. Second, audio continuing
     under a black panel is exactly what an external recorder wants.
     Only videos WE paused are resumed, so a video the student had already
     paused stays paused. */
  const autoPaused = new Set();

  function pauseProtectedMedia() {
    document.querySelectorAll('.sc-protected-surface video, .player-shell video').forEach((v) => {
      if (v.paused || v.ended) return;
      try { v.pause(); autoPaused.add(v); } catch { /* detached */ }
    });
  }

  function resumeProtectedMedia() {
    autoPaused.forEach((v) => {
      // Never resume something that has since left the page, and never fight
      // an autoplay policy — a rejected play() is not an error worth showing.
      if (v.isConnected) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ } }
    });
    autoPaused.clear();
  }

  function showCurtain(reason) {
    curtainReasons.add(reason);
    const el = buildCurtain();
    // A fullscreen element only paints its own subtree, so the curtain has
    // to live INSIDE it while the student is watching fullscreen video.
    const host = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (el.parentNode !== host) host.appendChild(el);
    const idEl = el.querySelector('[data-sc-curtain-id]');
    if (idEl) idEl.textContent = watermarkText();
    const hintEl = el.querySelector('[data-sc-curtain-hint]');
    if (hintEl) hintEl.textContent = CURTAIN_HINTS[reason] || CURTAIN_HINTS.focus;
    // A momentary flash must not stop a lecture the student is watching.
    if (reason !== 'flash') pauseProtectedMedia();
    requestAnimationFrame(() => el.classList.add('is-visible'));
  }

  function hideCurtain(reason) {
    curtainReasons.delete(reason);
    if (curtainReasons.size || !curtainEl) return;
    curtainEl.classList.remove('is-visible');
    resumeProtectedMedia();
  }

  // A brief opaque flash for the capture gestures the OS steals from us —
  // if the shot lands during these few hundred milliseconds it captures the
  // curtain, not the lesson.
  function flashCurtain() {
    showCurtain('flash');
    setTimeout(() => hideCurtain('flash'), 1200);
  }

  function watchFocus() {
    let blurTimer = null;

    const drop = () => {
      clearTimeout(blurTimer);
      // Clicking into a same-page iframe (the Cloudflare Stream player!)
      // blurs the parent window. Curtaining there would black out the video
      // the moment a student pressed play, so ignore that case.
      blurTimer = setTimeout(() => {
        const active = document.activeElement;
        if (active && active.tagName === 'IFRAME') return;
        if (document.hasFocus()) return;
        showCurtain('focus');
      }, 120);
    };

    const restore = () => {
      clearTimeout(blurTimer);
      hideCurtain('focus');
    };

    global.addEventListener('blur', drop);
    global.addEventListener('focus', restore);

    /* ── Page Visibility API — the mobile workhorse ──────────────────────
       On Android and iOS there is no "window blur" the way there is on a
       desktop: the student presses the recent-apps button, pulls down the
       notification shade, or takes a system screenshot, and what the page
       actually observes is `visibilitychange` with document.hidden === true.

       Raising the curtain synchronously inside this handler matters: the
       browser paints the tab thumbnail (the card shown in the Android app
       switcher, and the frame a screen recorder keeps capturing after the
       app is backgrounded) from the last painted state. Doing this work in a
       timeout would let the un-curtained frame be the one that gets stored.

       Restoring is unconditional so the student never comes back to a
       stuck black screen — which would be a far worse bug than any leak
       this prevents. */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) showCurtain('hidden');
      else hideCurtain('hidden');
    });

    // Safari on iOS fires pagehide/pageshow (bfcache) where other browsers
    // fire visibilitychange; without these the curtain can be missed when a
    // student swipes to another app or uses the back gesture.
    global.addEventListener('pagehide', () => showCurtain('hidden'));
    global.addEventListener('pageshow', () => hideCurtain('hidden'));

    // Android's "freeze"/"resume" lifecycle (Chrome discards backgrounded
    // tabs). Harmless no-ops where unsupported.
    document.addEventListener('freeze', () => showCurtain('hidden'));
    document.addEventListener('resume', () => hideCurtain('hidden'));
    // Keep the curtain in the right DOM host across fullscreen transitions.
    ['fullscreenchange', 'webkitfullscreenchange'].forEach((evt) => {
      document.addEventListener(evt, () => {
        if (!curtainReasons.size || !curtainEl) return;
        const host = document.fullscreenElement || document.webkitFullscreenElement || document.body;
        if (curtainEl.parentNode !== host) host.appendChild(curtainEl);
      });
    });
  }

  /* ══════════════════════════════════════════
     6. Devtools heuristic
     ══════════════════════════════════════════
     Devtools is how someone would delete the watermark and the curtain, so
     an open inspector curtains the content.

     Calibrated against the CHROME SIZE AT LOAD rather than a fixed pixel
     threshold. A fixed threshold false-positives on setups with a bookmarks
     bar, a tab strip and an OS menu bar — and a student who gets a black
     screen for no reason simply cannot study. Baselining means we only react
     to devtools being OPENED during the session; devtools already open at
     load is missed, which is the right trade (zero false positives beats
     catching the rare pre-opened inspector). Disabled on touch devices,
     where the soft keyboard resizes the viewport constantly. */
  function watchDevtools() {
    if (isTouch) return;
    const baseW = Math.max(0, global.outerWidth - global.innerWidth);
    const baseH = Math.max(0, global.outerHeight - global.innerHeight);
    const GROWTH = 130; // px of new chrome before we call it "devtools"
    let open = false;

    setInterval(() => {
      const dw = Math.max(0, global.outerWidth - global.innerWidth) - baseW;
      const dh = Math.max(0, global.outerHeight - global.innerHeight) - baseH;
      const nowOpen = dw > GROWTH || dh > GROWTH;
      if (nowOpen === open) return;
      open = nowOpen;
      if (open) {
        showCurtain('devtools');
        notify('Close developer tools to continue viewing this content.');
      } else {
        hideCurtain('devtools');
      }
    }, 1000);
  }

  /* ══════════════════════════════════════════
     7. Per-student watermark
     ══════════════════════════════════════════
     Deterrence by attribution: a leaked screenshot carries the name, the
     account reference and the timestamp of the account that took it. This is
     the part that actually changes behaviour — students will happily
     screenshot anonymous content and will not screenshot content signed with
     their own name.

     WHAT MAY GO IN THE WATERMARK — read before adding a field.
     A watermark ends up in WhatsApp groups, on Facebook and on strangers'
     phones. It is therefore a PUBLICATION surface, and it must never carry
     anything that could harm the student it identifies:

        allowed  — display name, the StudyCore account reference below,
                   StudyCore branding, a timestamp
        NEVER    — email address, phone number, password, physical address,
                   payment details, national ID, or the raw session token

     The account reference is a short, opaque tag derived from the account id
     (which is itself a random `user-<uuid>`). It is enough for support to
     trace a leak back to one account from the database, and useless to
     anyone else — it is not a login, not a contact detail and cannot be
     reversed into one. */
  let identity = { name: '', ref: '' };
  const surfaces = new WeakSet();

  // A short, non-sensitive account reference: the tail of the random account
  // id, uppercased. `user-9f8e7d6c-…-a1b2c3d4` → `SC-A1B2C3D4`. Traceable in
  // the admin tools, meaningless to anyone who finds a leaked screenshot.
  function accountRef(id) {
    const clean = String(id || '').replace(/[^a-z0-9]/gi, '');
    if (!clean) return '';
    return `SC-${clean.slice(-8).toUpperCase()}`;
  }

  function stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function watermarkText() {
    const bits = [identity.name, identity.ref].filter(Boolean);
    if (!bits.length) return `StudyCore · ${stamp()}`;
    return `StudyCore · ${bits.join(' · ')} · ${stamp()}`;
  }

  /* Watermark motion.
     A watermark that never moves is a watermark that can be cropped or
     patched out once and forgotten. Nudging the tile a little every 20
     seconds means a leaker would have to redo the edit for every frame of a
     recording, and a single crop that misses it on one screenshot catches it
     on the next.

     The offsets are deliberately small (a fraction of the tile spacing) and
     the transition is slow, so it reads as "the page is alive", not as
     something twitching in front of the material a student is reading. The
     tile is oversized (inset: -40%), so shifting it never uncovers a corner.

     Honoured by CSS `prefers-reduced-motion`: the transition is dropped for
     students who have asked for less movement, but the repositioning still
     happens, so the protection is not lost. */
  const DRIFT_STEPS = [
    { x: 0, y: 0, r: -24 },
    { x: 4, y: -3, r: -22 },
    { x: -3, y: 4, r: -26 },
    { x: 3, y: 3, r: -23 },
    { x: -4, y: -2, r: -25 }
  ];
  let driftIndex = 0;

  function applyDrift(inner, step) {
    if (!inner || !inner.style) return;
    inner.style.transform = `translate3d(${step.x}%, ${step.y}%, 0) rotate(${step.r}deg)`;
  }

  function driftWatermarks() {
    driftIndex = (driftIndex + 1) % DRIFT_STEPS.length;
    const step = DRIFT_STEPS[driftIndex];
    document.querySelectorAll('.sc-watermark-inner').forEach((inner) => applyDrift(inner, step));
  }

  function buildWatermark() {
    const wm = document.createElement('div');
    wm.className = 'sc-watermark';
    wm.setAttribute('aria-hidden', 'true');
    wm.dataset.scWatermark = '1';
    const label = esc(watermarkText());
    // A diagonal tile repeated across the whole surface, so no crop of the
    // content can exclude it. The rows live in an inner element that is
    // deliberately larger than the surface; the outer element clips it, so
    // the rotated text never spills onto the rest of the page.
    let rows = '';
    for (let i = 0; i < 14; i += 1) {
      rows += `<span class="sc-watermark-row">${label} &nbsp;&nbsp;&nbsp; ${label} &nbsp;&nbsp;&nbsp; ${label} &nbsp;&nbsp;&nbsp; ${label}</span>`;
    }
    wm.innerHTML = `<div class="sc-watermark-inner">${rows}</div>`;
    // Rebuilt watermarks adopt the CURRENT drift position rather than
    // snapping back to the origin, so the hourly refresh does not visibly
    // jump the stamp back under the student's eye.
    applyDrift(wm.firstChild, DRIFT_STEPS[driftIndex]);
    return wm;
  }

  function applyWatermark(surface) {
    if (!surface || surfaces.has(surface)) return;
    // Never stamp a surface that sits inside another protected surface —
    // that is how a single reader ends up with two overlapping watermarks.
    if (surface.parentElement && surface.parentElement.closest('.sc-protected-surface')) return;
    surfaces.add(surface);
    // The watermark is absolutely positioned against the surface.
    const position = getComputedStyle(surface).position;
    if (position === 'static') surface.style.position = 'relative';
    surface.classList.add('sc-protected-surface');
    surface.appendChild(buildWatermark());
  }

  function refreshWatermarks() {
    document.querySelectorAll('.sc-protected-surface').forEach((surface) => {
      const existing = surface.querySelector(':scope > [data-sc-watermark]');
      if (existing) existing.remove();
      surface.appendChild(buildWatermark());
    });
  }

  function scanSurfaces() {
    document.querySelectorAll(PROTECTED_SURFACES).forEach(applyWatermark);
  }

  function watchSurfaces() {
    // Players and readers are built asynchronously after their fetch
    // resolves, so the surfaces do not exist at DOMContentLoaded.
    const observer = new MutationObserver((records) => {
      let dirty = false;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches(PROTECTED_SURFACES)) { dirty = true; break; }
          if (node.querySelector && node.querySelector(PROTECTED_SURFACES)) { dirty = true; break; }
        }
        // Tamper defence: a watermark removed from a live surface comes back.
        if (record.removedNodes.length && record.target.classList
          && record.target.classList.contains('sc-protected-surface')
          && !record.target.querySelector(':scope > [data-sc-watermark]')) {
          record.target.appendChild(buildWatermark());
        }
        if (dirty) break;
      }
      if (dirty) scanSurfaces();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Keep the timestamp honest and heal anything that got stripped.
    setInterval(() => {
      scanSurfaces();
      refreshWatermarks();
    }, 60000);

    // Move the stamp far more often than it is rebuilt: cheap (one transform
    // on an already-composited layer), and it is what makes the watermark
    // awkward to patch out of a recording.
    setInterval(driftWatermarks, 20000);
  }

  async function loadIdentity() {
    try {
      const auth = global.StudyCoreAuth;
      if (!auth) return;
      // fetchSession de-duplicates in flight, so this rides along with the
      // request layout.js already makes rather than firing a second one.
      const user = auth.getCurrentUser() || await auth.fetchSession();
      if (!user) return;
      // Deliberately NOT user.email — see the note above buildWatermark.
      identity = { name: user.name || '', ref: accountRef(user.id) };
      refreshWatermarks();
    } catch { /* an anonymous watermark is still a watermark */ }
  }

  /* ══════════════════════════════════════════
     8. Native wrapper bridge
     ══════════════════════════════════════════
     If StudyCore is running inside an Android WebView / TWA / PWA wrapper,
     ask the host to set FLAG_SECURE. Unlike everything else in this file
     that is a REAL, OS-enforced screenshot and screen-recording block —
     Android refuses the capture outright and recordings come out black.
     No-ops in a normal desktop browser. */
  function applyNativeSecureFlag() {
    try {
      if (global.WTN && typeof global.WTN.disableScreenshot === 'function') {
        global.WTN.disableScreenshot({ ssKey: true });
      }
      if (global.AndroidSecure && typeof global.AndroidSecure.setSecure === 'function') {
        global.AndroidSecure.setSecure(true);
      }
      if (global.ReactNativeWebView && typeof global.ReactNativeWebView.postMessage === 'function') {
        global.ReactNativeWebView.postMessage(JSON.stringify({ type: 'sc:secure-screen', value: true }));
      }
    } catch { /* not in a wrapper */ }
  }

  /* ══════════════════════════════════════════
     Boot
     ══════════════════════════════════════════ */
  function init() {
    document.body.dataset.scPrivacy = policy;

    blockCopyRoutes();
    blockPrinting();
    blockCaptureApis();
    blockScreenshotKeys();
    applyNativeSecureFlag();

    if (strict) {
      blockPictureInPicture();
      watchFocus();
      watchDevtools();
      scanSurfaces();
      watchSurfaces();
      loadIdentity();
      global.addEventListener('sc:session:refreshed', loadIdentity);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.SCPrivacy = {
    policy,
    page,
    watermarkText,
    accountRef,
    showCurtain,
    hideCurtain,
    refreshWatermarks,
    driftWatermarks
  };
})(window);
