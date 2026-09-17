// =============================================
// STUDYCORE — Auth Stage (js/auth-stage.js)
// -----------------------------------------------
// The animated backdrop behind Log in / Create account / Create admin
// account, plus the rotating study line above the card.
//
// The visual is a STUDY DESK AT NIGHT: deep navy paper, faint graph-paper
// ruling drifting under everything, two slow teal auroras, one long light
// sweep, and a few course glyphs (the real StudyCore icon set — maths,
// physics, chemistry, biology, code, communication) floating far behind
// the form. All of the motion is declared in css/auth.css; this file only
// builds the layers, places the glyphs and drives the text rotation.
//
// Built for a student on a cheap Android on mobile data:
//   · Decoration only. The <main> form is untouched and fully usable if
//     this file never loads, 404s, or throws — the page still gets the
//     full navy gradient from css/auth.css.
//   · Zero network cost: no images, no fonts, no canvas. Everything is
//     CSS gradients plus inline SVG from the shared icon system.
//   · Only opacity/transform animate, so nothing repaints while the
//     student is typing their password.
//   · prefers-reduced-motion → a still frame (no beam, no glyphs).
//   · Save-Data, 2G, or a low-memory device → the calm static stage.
//   · Pauses entirely when the tab is hidden.
//   · Nothing is focusable or hit-testable: aria-hidden + pointer-events
//     none, so the stage can never sit between a student and the form.
// =============================================

(function (global) {
  'use strict';

  const ROTATE_MS = 5200;     // how long each study line is held
  const SWAP_MS = 340;        // fade-out/in of a line (mirrored in css/auth.css)

  // The page background also lives on the root element, so the browser
  // paints it BEFORE any element exists. That is what makes login → signup
  // read as one continuous screen instead of flashing white paper between
  // the two documents.
  const CANVAS = { light: '#07131f', dark: '#040c15' };

  // Set when leaving one auth screen for the other, so the next page knows
  // the desk is already lit and can skip the fade-up. sessionStorage (not a
  // query string) keeps the URLs clean and the flag per-tab.
  const CONTINUITY_KEY = 'sc_auth_stage_warm';

  function prefersReducedMotion() {
    return Boolean(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Respect the student's data plan and their hardware. Save-Data or a
  // 2G-class link is the site-wide signal for "this phone is doing enough
  // already" (js/hero-slideshow.js uses the same test); deviceMemory catches
  // the cheap handsets where a full-screen animation costs real frames.
  function isFrugalDevice() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c) {
      if (c.saveData) return true;
      if (['slow-2g', '2g'].includes(c.effectiveType)) return true;
    }
    if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory > 0 && navigator.deviceMemory <= 1) return true;
    return false;
  }

  // The glyph field needs clear room BESIDE the 440px form column. Below
  // this width there is none — the card is essentially the whole screen —
  // so the glyphs stand down rather than peeking out around its edges.
  const GLYPH_MIN_WIDTH = 1024;

  function hasRoomForGlyphs() {
    if (!global.matchMedia) return false;
    return global.matchMedia(`(min-width: ${GLYPH_MIN_WIDTH}px)`).matches;
  }

  function layer(className) {
    const el = document.createElement('div');
    el.className = className;
    return el;
  }

  // ── Course glyphs ────────────────────────────
  // A designed layout, never random. Positions are given as a percentage of
  // the MARGIN — the empty band between the edge of the screen and the form
  // column — not of the viewport, so a glyph can never drift under the
  // inputs no matter how wide the window is. `side` picks which margin,
  // `across` is how far into it (0 = screen edge, 1 = card edge), and `y` is
  // the usual share of the viewport height.
  const GLYPHS = [
    { icon: 'sigma',          side: 'left',  across: 0.34, y: '18%', size: 54, dur: '21s', delay: '0s' },
    { icon: 'atom',           side: 'right', across: 0.42, y: '24%', size: 66, dur: '27s', delay: '-4s' },
    { icon: 'flask',          side: 'left',  across: 0.58, y: '74%', size: 48, dur: '24s', delay: '-9s' },
    { icon: 'dna',            side: 'right', across: 0.30, y: '78%', size: 58, dur: '30s', delay: '-2s' },
    { icon: 'code',           side: 'left',  across: 0.14, y: '47%', size: 42, dur: '19s', delay: '-13s' },
    { icon: 'graduation-cap', side: 'right', across: 0.68, y: '52%', size: 46, dur: '26s', delay: '-7s' },
    { icon: 'book-open',      side: 'left',  across: 0.76, y: '33%', size: 34, dur: '23s', delay: '-16s' },
    { icon: 'calculator',     side: 'right', across: 0.12, y: '12%', size: 32, dur: '20s', delay: '-11s' },
    { icon: 'microscope',     side: 'right', across: 0.80, y: '90%', size: 36, dur: '28s', delay: '-5s' },
    { icon: 'message',        side: 'left',  across: 0.46, y: '90%', size: 30, dur: '22s', delay: '-18s' }
  ];

  // Width of the form column (.auth-shell max-width in css/auth.css) plus a
  // little breathing room, so nothing crowds the card's drop shadow either.
  const COLUMN_PX = 440;
  const COLUMN_GUTTER_PX = 56;

  function buildGlyphs() {
    // The icon system is the single source of every glyph on the site. If
    // it somehow has not loaded, the stage simply goes without them.
    if (!global.SC || typeof global.SC.icon !== 'function') return null;

    const host = layer('auth-glyphs');
    host.setAttribute('aria-hidden', 'true');

    GLYPHS.forEach((g) => {
      const node = document.createElement('div');
      node.className = 'auth-glyph';
      // calc() against the live viewport, so the layout follows a window
      // resize without this file listening for one. `margin` is half of
      // whatever is left once the form column is taken out of the middle.
      const margin = `((100vw - ${COLUMN_PX + COLUMN_GUTTER_PX * 2}px) / 2)`;
      node.style.setProperty(
        '--gx',
        g.side === 'left'
          ? `calc(${margin} * ${g.across})`
          : `calc(100vw - ${margin} * ${g.across})`
      );
      node.style.setProperty('--gy', g.y);
      node.style.setProperty('--gd', g.dur);
      // Negative delays start each glyph part-way through its loop, so the
      // field is already in motion on the first frame instead of every
      // glyph launching from the same pose in unison.
      node.style.setProperty('--gdelay', g.delay);
      node.innerHTML = global.SC.icon(g.icon, { size: g.size, stroke: 1.25 });
      host.appendChild(node);
    });
    return host;
  }

  function buildStage() {
    const stage = layer('auth-stage');
    stage.id = 'authStage';
    stage.setAttribute('aria-hidden', 'true');

    const reduced = prefersReducedMotion();
    const frugal = isFrugalDevice();
    const calm = reduced || frugal;

    stage.appendChild(layer('auth-aurora'));
    stage.appendChild(layer('auth-grid'));
    if (!calm) {
      stage.appendChild(layer('auth-beam'));
      if (hasRoomForGlyphs()) {
        const glyphs = buildGlyphs();
        if (glyphs) stage.appendChild(glyphs);
      }
    }
    stage.appendChild(layer('auth-vignette'));
    return stage;
  }

  // ── Rotating study line ──────────────────────
  // Lines are authored in the page's own markup (data-lines) so each screen
  // can speak for itself, and the first line is server-rendered inside the
  // element — with JavaScript off it simply stays put.
  function initRotator() {
    const host = document.querySelector('[data-auth-rotator]');
    if (!host) return;
    const slot = host.querySelector('span');
    if (!slot) return;

    let lines = [];
    try {
      const parsed = JSON.parse(host.getAttribute('data-lines') || '[]');
      if (Array.isArray(parsed)) lines = parsed.filter((s) => typeof s === 'string' && s.trim());
    } catch { /* a malformed list just means no rotation */ }

    if (lines.length < 2 || prefersReducedMotion() || isFrugalDevice()) return;

    let index = Math.max(0, lines.indexOf(slot.textContent.trim()));
    let timer = null;

    function tick() {
      host.classList.add('is-swapping');
      // Swap the text at the midpoint of the blur-out, so the line is
      // invisible while it changes and the two never cross-fade into
      // unreadable mush.
      global.setTimeout(() => {
        index = (index + 1) % lines.length;
        slot.textContent = lines[index];
        host.classList.remove('is-swapping');
      }, SWAP_MS);
    }

    function start() {
      if (timer) return;
      timer = global.setInterval(tick, ROTATE_MS);
    }
    function stop() {
      if (!timer) return;
      global.clearInterval(timer);
      timer = null;
    }

    start();
    document.addEventListener('visibilitychange', () => {
      document.hidden ? stop() : start();
    });
  }

  // ── The root background ──────────────────────
  // Painted on <html> so it is on screen before the first element renders,
  // and kept in sync with the light/dark toggle in the shared navbar.
  function paintCanvas() {
    const apply = () => {
      const dark = document.body.dataset.theme === 'dark';
      document.documentElement.style.backgroundColor = dark ? CANVAS.dark : CANVAS.light;
    };
    apply();
    if (typeof MutationObserver === 'function') {
      new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
    }
  }

  // ── Continuity between the auth screens ─────
  // Log in → Sign up → Create admin account should feel like one screen
  // where only the card changes. The desk is identical on all three, so the
  // arriving page shows it immediately instead of fading it up again; only
  // a cold arrival from elsewhere gets the entrance.
  function takeWarmFlag() {
    try {
      if (sessionStorage.getItem(CONTINUITY_KEY) !== '1') return false;
      sessionStorage.removeItem(CONTINUITY_KEY);
      return true;
    } catch {
      return false; // private mode: just play the entrance
    }
  }

  function markWarmOnAuthLinks() {
    document.addEventListener('click', (event) => {
      const anchor = event.target.closest && event.target.closest('a[href]');
      if (!anchor) return;
      let url;
      try { url = new URL(anchor.href, global.location.href); } catch { return; }
      if (url.origin !== global.location.origin) return;
      if (!/^\/(login|signup|content-admin-signup)\.html$/.test(url.pathname)) return;
      try { sessionStorage.setItem(CONTINUITY_KEY, '1'); } catch { /* private mode */ }
    }, true); // capture: layout.js calls preventDefault on the same click
  }

  function init() {
    if (document.body.dataset.page !== 'auth') return;
    if (document.getElementById('authStage')) return;

    paintCanvas();

    const stage = buildStage();
    const warm = takeWarmFlag();
    // Coming from the other auth screen the desk is already on screen, so
    // show it in the same frame — a second fade-up would read as a flicker.
    if (warm) stage.classList.add('is-instant', 'is-live');

    // First in the <body> so it sits behind every sibling, and outside
    // <main> so a long signup form scrolls over a steady backdrop.
    document.body.prepend(stage);

    if (!warm) {
      // Fade the decoration up on the NEXT frame: set in the same frame it
      // is inserted, the transition would have nothing to animate from.
      global.requestAnimationFrame(() => stage.classList.add('is-live'));
    } else {
      // Drop back to the normal transition once the instant paint has
      // happened, so later state changes still animate.
      global.requestAnimationFrame(() => stage.classList.remove('is-instant'));
    }

    // A backgrounded tab must not keep a phone's GPU busy on decoration.
    document.addEventListener('visibilitychange', () => {
      stage.classList.toggle('is-paused', document.hidden);
    });

    markWarmOnAuthLinks();
    initRotator();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  global.SC = global.SC || {};
  global.SC.AuthStage = { init };
})(window);
