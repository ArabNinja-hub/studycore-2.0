// =============================================
// STUDYCORE — Course Hero Ambient Canvas (js/hero.js)
// -----------------------------------------------
// ONE shared, calm background visual for every course
// hero: a sparse field of soft orbs drifting slowly,
// plus a single faint wave low in the frame. Same
// visual language on all six course pages — course
// identity comes from the icon, title and content,
// not from competing particle systems.
//
//   · Loaded ONLY on course (subject) pages
//   · Fewer than 15 moving elements, all slow
//   · Pauses when off-screen or tab hidden
//   · Honors prefers-reduced-motion (static frame)
//   · Low opacity behind the hero content — the
//     title/CTA always stay the primary focus
// =============================================

(function (global) {
  'use strict';

  const rand = (a, b) => a + Math.random() * (b - a);

  const PALETTE = {
    teal: '43,178,161',
    amber: '245,166,35',
    white: '226,240,250'
  };

  function makeCanvas(host) {
    const canvas = document.createElement('canvas');
    canvas.className = 'course-hero-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.prepend(canvas);
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return null; // no 2D context available (ancient engines, test DOMs)
    let w = 0, h = 0, dpr = 1;
    let staticFrame = null;
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = host.clientWidth; h = host.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', () => { resize(); if (staticFrame) staticFrame(0); });
    return { canvas, ctx, size: () => ({ w, h }), resize, setStaticFrame: (fn) => { staticFrame = fn; } };
  }

  // Sparse, slow orbs. Alpha and speed are deliberately low so the canvas
  // reads as ambient light, never as a particle show.
  function ambientScene(env) {
    const orbs = Array.from({ length: 13 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: rand(1.5, 26),
      vx: rand(-0.006, 0.006),
      vy: rand(-0.004, 0.004),
      a: rand(0.06, 0.16),
      c: Math.random() > 0.72 ? PALETTE.amber : (Math.random() > 0.45 ? PALETTE.teal : PALETTE.white)
    }));
    return (t) => {
      const { ctx, size } = env;
      const { w, h } = size();
      ctx.clearRect(0, 0, w, h);
      for (const o of orbs) {
        o.x += o.vx * 0.016;
        o.y += o.vy * 0.016;
        if (o.x < -0.05) o.x = 1.05; else if (o.x > 1.05) o.x = -0.05;
        if (o.y < -0.05) o.y = 1.05; else if (o.y > 1.05) o.y = -0.05;
        ctx.beginPath();
        ctx.arc(o.x * w, o.y * h, o.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${o.c},${o.a})`;
        ctx.fill();
      }
      // One slow, faint wave near the bottom edge.
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${PALETTE.teal},0.18)`;
      ctx.lineWidth = 1.4;
      for (let x = 0; x <= w; x += 6) {
        const y = h * 0.86 + Math.sin(x * 0.01 + t * 0.0004) * 10;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
  }

  function init(heroEl, subjectSlug) {
    if (!heroEl) return;
    const reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
    const env = makeCanvas(heroEl);
    if (!env) return;
    const frame = ambientScene(env);

    if (reduced) {
      const staticFrame = () => frame(0);
      env.setStaticFrame(staticFrame);
      staticFrame();
      return;
    }

    let raf = null;
    let visible = true;
    function loop(t) {
      if (visible) frame(t);
      raf = requestAnimationFrame(loop);
    }
    function start() { if (!raf) raf = requestAnimationFrame(loop); }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        visible ? start() : stop();
      }, { threshold: 0.05 });
      io.observe(heroEl);
    }
    document.addEventListener('visibilitychange', () => {
      document.hidden ? stop() : (visible && start());
    });
    start();
  }

  global.SC = global.SC || {};
  global.SC.Hero = { init };
})(window);
