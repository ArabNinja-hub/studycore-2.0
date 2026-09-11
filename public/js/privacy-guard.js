// =============================================
// STUDYCORE — Content Privacy Guard (js/privacy-guard.js)
// -----------------------------------------------
// Makes StudyCore's LEARNING CONTENT private: no right-click save, no
// copy/cut, no text selection, no drag-out, no printing and no in-page
// screen capture.
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
// 99%: it removes every in-browser copy route, it blanks printing and
// "Save as PDF", and it scrubs the clipboard after PrintScreen.
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

       'strict' — full treatment: deterrents + in-page capture guards
                  (canvas extraction, captureStream, picture-in-picture).
       'basic'  — deterrents only. Used on the listing pages, where the
                  extra in-page guards would be pointless.  */
  const PAGE_POLICY = {
    lesson: 'strict',    // /pages/lesson.html — player + document reader
    viewer: 'strict',    // /viewer/:id       — standalone document reader
    course: 'strict',    // /course/:key + /pages/subjects/*.html
    videos: 'strict',    // /pages/videos.html
    courses: 'basic',    // /pages/courses.html
    resources: 'basic',  // /pages/resources.html
    search: 'basic'      // /pages/search.html
  };

  /* ── Surfaces that carry the scoped capture guards ─────
     These are the elements that actually render protected media.

     Each is tagged with the `.sc-protected-surface` marker class so the
     scoped guards (canvas `toDataURL`/`toBlob`, `captureStream`, and
     picture-in-picture) can recognise protected content without touching
     unrelated canvases or media anywhere else on the site.

       .player-shell      is the video player (progressive + Cloudflare Stream)
       .doc-reader-stage  is the document reader, embedded and bare alike

     Note .doc-reader (the outer card in embedded/lesson mode) is NOT listed:
     it WRAPS .doc-reader-stage, so listing both would tag the lesson page
     twice. */
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
     Once it is up, none of the in-page guards can cover it, and the student
     can keep the lesson visible while they switch to a recorder. That is a
     straight hole through the protection, so it is closed on protected
     pages.

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
     before the browser sees them, so those keydowns are prevented
     best-effort for the cases where the browser does see them. */
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
      // Win+Shift+S snip. Best-effort: the OS usually wins the race.
      if ((e.metaKey && e.shiftKey && ['3', '4', '5', '6'].includes(key))
        || (e.metaKey && e.shiftKey && key === 's')) {
        e.preventDefault();
        notify('Screenshots of protected StudyCore content are not permitted.');
        return;
      }

      // Devtools shortcuts — the obvious way to strip this whole guard.
      const devtoolsCombo = key === 'f12'
        || (mod && e.shiftKey && ['i', 'j', 'c'].includes(key));
      if (devtoolsCombo) {
        e.preventDefault();
        notify('Developer tools are disabled on protected StudyCore content.');
      }
    }, true);
  }

  /* ══════════════════════════════════════════
     5. Protected-surface markers
     ══════════════════════════════════════════
     The scoped guards (canvas extraction, captureStream, picture-in-picture)
     recognise protected content by looking for the `.sc-protected-surface`
     marker class. Players and readers are built asynchronously after their
     fetch resolves, so the markers are applied by a MutationObserver rather
     than at DOMContentLoaded. */
  const surfaces = new WeakSet();

  function markSurface(surface) {
    if (!surface || surfaces.has(surface)) return;
    // Never mark a surface that sits inside another protected surface — that
    // is how a single reader ends up tagged twice.
    if (surface.parentElement && surface.parentElement.closest('.sc-protected-surface')) return;
    surfaces.add(surface);
    surface.classList.add('sc-protected-surface');
  }

  function scanSurfaces() {
    document.querySelectorAll(PROTECTED_SURFACES).forEach(markSurface);
  }

  function watchSurfaces() {
    const observer = new MutationObserver((records) => {
      let dirty = false;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches(PROTECTED_SURFACES)) { dirty = true; break; }
          if (node.querySelector && node.querySelector(PROTECTED_SURFACES)) { dirty = true; break; }
        }
        if (dirty) break;
      }
      if (dirty) scanSurfaces();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Heal markers that were stripped from a live surface.
    setInterval(scanSurfaces, 60000);
  }

  /* ══════════════════════════════════════════
     6. Native wrapper bridge
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
      scanSurfaces();
      watchSurfaces();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.SCPrivacy = {
    policy,
    page
  };
})(window);
