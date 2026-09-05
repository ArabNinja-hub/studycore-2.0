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
//   · Fully pauses off-screen and on tab hide.
//   · Honors prefers-reduced-motion and Save-Data /
//     2G: a single static frame, no rotation, no drift.
//   · If the first photo fails to load, the layer removes
//     itself and the hero keeps its navy gradient — a
//     broken image never damages the page.
// =============================================

(function (global) {
  'use strict';

  const FADE_MS = 1600;        // crossfade duration (mirrored in CSS)
  const HOLD_MS = 6400;        // time a photo stays fully visible
  const HOLD_MS_CALM = 9000;   // slower cadence when motion is reduced

  function prefersReducedMotion() {
    return Boolean(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Respect the student's data plan. On Save-Data or a 2G-class link we
  // show one frame and stop — no background downloads for decoration.
  function isFrugalConnection() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
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
  function load(img, src) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        img.onload = null;
        img.onerror = null;
        ok ? resolve() : reject(new Error(`hero image failed: ${src}`));
      };
      img.onload = () => {
        if (typeof img.decode === 'function') img.decode().then(() => done(true), () => done(true));
        else done(true);
      };
      img.onerror = () => done(false);
      img.src = src;
    });
  }

  function prefetch(src) {
    if (!src) return;
    const idle = global.requestIdleCallback || ((fn) => setTimeout(fn, 900));
    idle(() => { const i = new Image(); i.decoding = 'async'; i.src = src; });
  }

  function init(host) {
    if (!host || host.dataset.heroReady === 'true') return;
    const images = readImages(host);
    if (!images.length) return;
    host.dataset.heroReady = 'true';

    const reduced = prefersReducedMotion();
    const frugal = isFrugalConnection();
    const canRotate = images.length > 1 && !frugal;

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

    function schedule() {
      clear();
      if (!running || !canRotate) return;
      timer = setTimeout(next, (reduced ? HOLD_MS_CALM : HOLD_MS) + FADE_MS);
    }

    async function next() {
      if (!running || swapping || document.hidden || !visible) { schedule(); return; }
      swapping = true;
      const nextIndex = (index + 1) % images.length;
      const back = layers[1 - front];
      try {
        await load(back.img, images[nextIndex]);
      } catch {
        // One bad file must not stop the show — skip past it.
        swapping = false;
        index = nextIndex;
        schedule();
        return;
      }
      if (!running) { swapping = false; return; }
      const outgoing = layers[front];
      // Restart the slow drift from the top for the incoming frame.
      back.layer.classList.remove('is-drifting');
      void back.layer.offsetWidth;
      back.layer.classList.add('is-active', 'is-drifting');
      outgoing.layer.classList.remove('is-active');
      // Stop the faded-out layer animating once it is invisible.
      window.setTimeout(() => outgoing.layer.classList.remove('is-drifting'), FADE_MS + 120);
      front = 1 - front;
      index = nextIndex;
      swapping = false;
      prefetch(images[(index + 1) % images.length]);
      schedule();
    }

    function start() { if (running) return; running = true; schedule(); }
    function stop() { running = false; clear(); }

    // ── First frame ──────────────────────────
    load(a.img, images[0]).then(() => {
      host.classList.add('is-loaded');
      a.layer.classList.add('is-active');
      if (!reduced) a.layer.classList.add('is-drifting');
      if (canRotate) {
        prefetch(images[1]);
        start();
      }
    }).catch(() => {
      // No usable photography: fall back to the plain navy hero.
      host.classList.add('is-unavailable');
      host.replaceChildren();
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
