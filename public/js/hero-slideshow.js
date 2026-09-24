// =============================================
// STUDYCORE — Hero Slideshow (js/hero-slideshow.js)
// -----------------------------------------------
// The home hero's photographic backdrop, treated as an
// AGED ARCHIVE PRINT: warm sepia patina, faded blacks,
// burnt edges and a fine film grain, so real graduation
// photos read as one calm, timeless surface instead of
// five different phone snapshots.
//
// Built for a student on mobile data:
//   · Exactly TWO <img> layers exist at any time (A/B
//     crossfade), recycled — not one node per photo.
//   · Only the first frame is fetched up front. The next
//     one is prefetched during idle time, never all five.
//   · A self-scheduling timeout chain (not setInterval)
//     that cannot pile up while the tab is backgrounded.
//   · Every photo load has a watchdog: a stalled download (the
//     browser fires neither onload nor onerror for a hung socket)
//     is given up on and skipped like any bad frame, so one stall
//     can never latch the crossfade and freeze the hero on a frame.
//   · Fully pauses off-screen and on tab hide.
//   · Honors prefers-reduced-motion and Save-Data /
//     2G: a single static frame, no rotation, no drift.
//   · If a photo fails, the remaining frames are tried before
//     falling back to the plain navy hero — one stale URL never
//     takes the whole slideshow down.
// =============================================

(function (global) {
  'use strict';

  const FADE_MS = 1600;        // crossfade duration (mirrored in CSS)
  const HOLD_MS = 6400;        // time a photo stays fully visible
  // Watchdogs for a HUNG photo download. The browser fires neither onload
  // nor onerror while a socket stalls, so without these budgets one bad
  // frame would latch `swapping` true and freeze the hero forever. The
  // up-front first frame is fetched cold, so it gets a generous budget;
  // swap frames are prefetched during idle and should resolve from cache,
  // so they get a tighter one before we skip past them.
  const FIRST_FRAME_TIMEOUT_MS = 20000;
  const SWAP_FRAME_TIMEOUT_MS = 10000;

  function prefersReducedMotion() {
    return Boolean(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Respect the student's data plan. On Save-Data or a 2G-class link we
  // show one frame and stop — no background downloads for decoration.
  function isFrugalConnection() {
    const nav = global.navigator;
    const c = nav && (nav.connection || nav.mozConnection || nav.webkitConnection);
    if (!c) return false;
    if (c.saveData) return true;
    return ['slow-2g', '2g'].includes(c.effectiveType);
  }

  function readImages(host) {
    const raw = host.getAttribute('data-images');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string' && s) : [];
    } catch {
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  function makeLayer() {
    const layer = document.createElement('div');
    layer.className = 'hero-shot';
    layer.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    layer.appendChild(img);
    return { layer, img };
  }

  // Load into an <img> and wait until the pixels are actually decoded, so a
  // crossfade never reveals a half-painted frame on a slow phone.
  //
  // The watchdog is what keeps the show from wedging: a stalled download
  // (hung socket, or a decode that never settles) fires neither onload nor
  // onerror, so the promise is force-settled after `timeoutMs` and the
  // caller's catch path skips the frame instead of latching on it.
  function load(img, src, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let watchdog = null;
      const done = (ok, error) => {
        if (settled) return;
        settled = true;
        if (watchdog) clearTimeout(watchdog);
        img.onload = null;
        img.onerror = null;
        ok ? resolve() : reject(error || new Error(`hero image failed: ${src}`));
      };
      const decoded = () => {
        // `decode()` prevents a partly-painted incoming frame. A few older
        // WebKit builds reject it for an otherwise usable image, so a reject
        // still counts as a successful load; the pixels are available.
        if (typeof img.decode === 'function') img.decode().then(() => done(true), () => done(true));
        else done(true);
      };

      if (timeoutMs > 0) {
        watchdog = setTimeout(() => done(false, new Error(`hero image timed out: ${src}`)), timeoutMs);
      }
      img.onload = decoded;
      img.onerror = () => done(false);
      img.src = src;

      // A frame can already be decoded when it comes from the memory cache.
      // In particular, assigning the same URL to a recycled <img> is allowed
      // to produce no new `load` event in some engines. Without this branch
      // the promise waits for its watchdog and the slideshow appears frozen.
      if (img.complete) {
        if (img.naturalWidth > 0) decoded();
        else done(false);
      }
    });
  }

  function prefetch(src) {
    if (!src || typeof global.Image !== 'function') return;
    const idle = global.requestIdleCallback || ((fn) => setTimeout(fn, 900));
    idle(() => { const i = new global.Image(); i.decoding = 'async'; i.src = src; });
  }

  function init(host) {
    if (!host || host.dataset.heroReady === 'true') return;
    const images = readImages(host);
    if (!images.length) return;
    host.dataset.heroReady = 'true';

    const reduced = prefersReducedMotion();
    const frugal = isFrugalConnection();
    // Reduced motion and constrained connections deliberately receive one
    // calm, static frame. The CSS also stops the drift, but this gate avoids
    // downloading or crossfading additional decorative images at all.
    const canRotate = images.length > 1 && !frugal && !reduced;

    // Aged-print treatment layers. Purely decorative, always behind the copy.
    const patina = document.createElement('div');
    patina.className = 'hero-patina';
    patina.setAttribute('aria-hidden', 'true');

    const grain = document.createElement('div');
    grain.className = 'hero-grain';
    grain.setAttribute('aria-hidden', 'true');

    const a = makeLayer();
    const b = makeLayer();
    host.append(a.layer, b.layer, patina, grain);

    const layers = [a, b];
    let front = 0;
    let index = 0;
    let timer = null;
    let running = false;
    let visible = true;
    let swapping = false;

    function clear() { if (timer) { clearTimeout(timer); timer = null; } }

    function canRunNow() {
      return canRotate && visible && !document.hidden;
    }

    function schedule() {
      clear();
      if (!running || !canRunNow()) return;
      timer = setTimeout(next, HOLD_MS + FADE_MS);
    }

    async function next() {
      if (!running || swapping || !canRunNow()) { schedule(); return; }
      swapping = true;
      const nextIndex = (index + 1) % images.length;
      const back = layers[1 - front];
      try {
        await load(back.img, images[nextIndex], SWAP_FRAME_TIMEOUT_MS);
      } catch {
        // One bad file must not stop the show — skip past it. Keep the
        // visible layer and advance the source cursor for the next attempt.
        swapping = false;
        index = nextIndex;
        schedule();
        return;
      }
      if (!running || !canRunNow()) { swapping = false; return; }
      const outgoing = layers[front];
      // Restart the slow drift from the top for the incoming frame.
      back.layer.classList.remove('is-drifting');
      void back.layer.offsetWidth;
      back.layer.classList.add('is-active', 'is-drifting');
      outgoing.layer.classList.remove('is-active');
      // Stop the faded-out layer animating once it is invisible.
      global.setTimeout(() => outgoing.layer.classList.remove('is-drifting'), FADE_MS + 120);
      front = 1 - front;
      index = nextIndex;
      swapping = false;
      prefetch(images[(index + 1) % images.length]);
      schedule();
    }

    function start() {
      if (running || !canRunNow()) return;
      running = true;
      schedule();
    }
    function stop() { running = false; clear(); }

    // ── First usable frame ───────────────────
    // The original implementation treated a missing first URL as a failure
    // for the entire hero. Try every declared image before hiding photography
    // so a renamed or stale first asset cannot make the slideshow disappear.
    async function showFirstAvailableFrame() {
      for (let candidate = 0; candidate < images.length; candidate += 1) {
        try {
          await load(a.img, images[candidate], candidate === 0 ? FIRST_FRAME_TIMEOUT_MS : SWAP_FRAME_TIMEOUT_MS);
          index = candidate;
          return true;
        } catch { /* try the next declarative frame */ }
      }
      return false;
    }

    showFirstAvailableFrame().then((loaded) => {
      if (!loaded) {
        // No usable photography: fall back to the plain navy hero.
        host.classList.add('is-unavailable');
        host.replaceChildren();
        return;
      }
      host.classList.add('is-loaded');
      a.layer.classList.add('is-active');
      if (!reduced) a.layer.classList.add('is-drifting');
      if (canRotate) {
        prefetch(images[(index + 1) % images.length]);
        start();
      }
    });

    // ── Only animate what the student can see ──
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else if (visible && canRotate) start();
    });

    if ('IntersectionObserver' in global) {
      const io = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (!visible) stop();
        else if (canRotate && !document.hidden) start();
      }, { threshold: 0.01 });
      io.observe(host);
    }
  }

  function boot() {
    document.querySelectorAll('[data-hero-slideshow]').forEach(init);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  global.SC = global.SC || {};
  global.SC.HeroSlideshow = { init };
})(window);
