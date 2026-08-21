// =============================================
// STUDYCORE — Course Hero Animations (js/hero.js)
// -----------------------------------------------
// Unique, subtle animated visual identity for
// each course hero. Pure canvas 2D - no
// libraries, no video, no big assets.
//
//   · Loaded ONLY on course (subject) pages
//   · Pauses when off-screen or tab hidden
//   · Honors prefers-reduced-motion (static
//     frame instead of animation)
//   · Low opacity behind the hero gradient,
//     title/CTA always the primary focus
// =============================================

(function (global) {
  'use strict';

  const rand = (a, b) => a + Math.random() * (b - a);
  const TAU = Math.PI * 2;

  const PALETTE = {
    teal: '43,178,161',
    amber: '245,166,35',
    blue: '96,165,250',
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

  // ── MATHEMATICS: floating symbols, functions, a live sine curve ──
  function mathematics(env) {
    const glyphs = ['Σ', 'π', '∫', '∞', '√', 'Δ', 'θ', '∂', '≈', '±', 'dx', 'dy', 'ƒ', 'x²', 'e', 'ln', '∮', '≤'];
    const parts = Array.from({ length: 26 }, () => ({
      x: Math.random(), y: Math.random(), s: rand(13, 30), sp: rand(0.008, 0.03),
      g: glyphs[Math.floor(Math.random() * glyphs.length)], a: rand(0.12, 0.4), ph: rand(0, TAU)
    }));
    return (t) => {
      const { ctx, size } = env; const { w, h } = size();
      ctx.clearRect(0, 0, w, h);
      // faint graph grid
      ctx.strokeStyle = `rgba(${PALETTE.teal},0.07)`; ctx.lineWidth = 1;
      const step = 56;
      for (let x = (t * 0.01) % step; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      // live sine wave
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${PALETTE.teal},0.5)`; ctx.lineWidth = 2;
      for (let x = 0; x <= w; x += 4) {
        const y = h * 0.72 + Math.sin(x * 0.012 + t * 0.0012) * h * 0.1 * Math.sin(t * 0.0004 + 1);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      // second wave (amber, faint)
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${PALETTE.amber},0.28)`; ctx.lineWidth = 1.5;
      for (let x = 0; x <= w; x += 4) {
        const y = h * 0.3 + Math.cos(x * 0.008 + t * 0.0008) * h * 0.08;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      // floating glyphs
      for (const p of parts) {
        p.y -= p.sp * 0.016;
        if (p.y < -0.08) { p.y = 1.08; p.x = Math.random(); }
        const x = p.x * w + Math.sin(t * 0.001 + p.ph) * 14;
        const y = p.y * h;
        ctx.font = `600 ${p.s}px 'Poppins', sans-serif`;
        ctx.fillStyle = `rgba(${PALETTE.white},${p.a})`;
        ctx.fillText(p.g, x, y);
      }
    };
  }

  // ── PHYSICS: orbits, particles, waves, force vectors ──
  function physics(env) {
    const orbits = Array.from({ length: 4 }, (_, i) => ({ r: 60 + i * 54, sp: rand(0.0004, 0.001) * (i % 2 ? -1 : 1), ph: rand(0, TAU) }));
    const dots = Array.from({ length: 34 }, () => ({ x: Math.random(), y: Math.random(), vx: rand(-0.02, 0.02), vy: rand(-0.02, 0.02), r: rand(1, 2.6) }));
    const vectors = Array.from({ length: 5 }, () => ({ x: Math.random(), y: Math.random(), ang: rand(0, TAU), len: rand(34, 70) }));
    return (t) => {
      const { ctx, size } = env; const { w, h } = size();
      ctx.clearRect(0, 0, w, h);
      const cx = w * 0.72, cy = h * 0.5;
      // nucleus
      const pulse = 1 + Math.sin(t * 0.002) * 0.12;
      ctx.beginPath(); ctx.arc(cx, cy, 10 * pulse, 0, TAU);
      ctx.fillStyle = `rgba(${PALETTE.amber},0.85)`; ctx.fill();
      // orbits + electrons
      orbits.forEach((o, i) => {
        ctx.save();
        ctx.translate(cx, cy); ctx.rotate(0.4 + i * 0.25);
        ctx.beginPath();
        ctx.strokeStyle = `rgba(${PALETTE.teal},${0.22 - i * 0.03})`; ctx.lineWidth = 1.2;
        ctx.ellipse(0, 0, o.r * 1.5, o.r * 0.62, 0, 0, TAU);
        ctx.stroke();
        const a = t * o.sp + o.ph;
        const ex = Math.cos(a) * o.r * 1.5, ey = Math.sin(a) * o.r * 0.62;
        ctx.beginPath(); ctx.arc(ex, ey, 3.4, 0, TAU);
        ctx.fillStyle = `rgba(${PALETTE.white},0.8)`; ctx.fill();
        ctx.restore();
      });
      // drifting particles + connecting lines
      for (const d of dots) {
        d.x += d.vx * 0.016; d.y += d.vy * 0.016;
        if (d.x < 0 || d.x > 1) d.vx *= -1;
        if (d.y < 0 || d.y > 1) d.vy *= -1;
        ctx.beginPath(); ctx.arc(d.x * w, d.y * h, d.r, 0, TAU);
        ctx.fillStyle = `rgba(${PALETTE.white},0.35)`; ctx.fill();
      }
      // force vectors (arrows)
      for (const v of vectors) {
        v.ang += 0.0006;
        const x = v.x * w, y = v.y * h;
        const tx = x + Math.cos(v.ang) * v.len, ty = y + Math.sin(v.ang) * v.len;
        ctx.strokeStyle = `rgba(${PALETTE.amber},0.3)`; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - Math.cos(v.ang - 0.45) * 9, ty - Math.sin(v.ang - 0.45) * 9);
        ctx.lineTo(tx - Math.cos(v.ang + 0.45) * 9, ty - Math.sin(v.ang + 0.45) * 9);
        ctx.closePath();
        ctx.fillStyle = `rgba(${PALETTE.amber},0.3)`; ctx.fill();
      }
      // traveling wave
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${PALETTE.teal},0.4)`; ctx.lineWidth = 1.8;
      for (let x = 0; x <= w; x += 4) {
        const env2 = Math.sin((x / w) * Math.PI);
        const y = h * 0.85 + Math.sin(x * 0.03 + t * 0.002) * 16 * env2;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
  }

  // ── CHEMISTRY: atoms, orbiting electrons, molecules ──
  function chemistry(env) {
    const atoms = Array.from({ length: 6 }, () => ({
      x: Math.random(), y: Math.random(), s: rand(18, 40),
      e: rand(0, TAU), esp: rand(0.0008, 0.002) * (Math.random() > 0.5 ? -1 : 1),
      orbit: Math.random() > 0.4, a: rand(0.2, 0.5)
    }));
    const molecules = Array.from({ length: 3 }, () => ({
      x: Math.random(), y: Math.random(), vx: rand(-0.01, 0.01), vy: rand(-0.01, 0.01),
      n: 2 + Math.floor(Math.random() * 3), r: rand(10, 16)
    }));
    return (t) => {
      const { ctx, size } = env; const { w, h } = size();
      ctx.clearRect(0, 0, w, h);
      for (const m of molecules) {
        m.x += m.vx * 0.016; m.y += m.vy * 0.016;
        if (m.x < 0 || m.x > 1) m.vx *= -1;
        if (m.y < 0 || m.y > 1) m.vy *= -1;
        const mx = m.x * w, my = m.y * h;
        for (let i = 1; i < m.n; i++) {
          const bx = mx + i * m.r * 1.7 - (m.n - 1) * m.r * 0.85;
          ctx.strokeStyle = `rgba(${PALETTE.white},0.22)`; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(bx, my); ctx.stroke();
          ctx.beginPath(); ctx.arc(bx, my, m.r * 0.7, 0, TAU);
          ctx.fillStyle = `rgba(${PALETTE.blue},0.3)`; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(mx, my, m.r, 0, TAU);
        ctx.fillStyle = `rgba(${PALETTE.teal},0.4)`; ctx.fill();
      }
      for (const a of atoms) {
        a.e += a.esp * 16;
        const x = a.x * w, y = a.y * h;
        if (a.orbit) {
          ctx.save();
          ctx.translate(x, y); ctx.rotate(0.5);
          ctx.beginPath();
          ctx.strokeStyle = `rgba(${PALETTE.teal},${a.a * 0.6})`; ctx.lineWidth = 1.1;
          ctx.ellipse(0, 0, a.s * 1.35, a.s * 0.55, 0, 0, TAU);
          ctx.stroke();
          ctx.restore();
          const ex = x + Math.cos(a.e) * a.s * 1.35, ey = y + Math.sin(a.e) * a.s * 0.55;
          ctx.beginPath(); ctx.arc(ex, ey, 2.6, 0, TAU);
          ctx.fillStyle = `rgba(${PALETTE.white},0.7)`; ctx.fill();
        }
        const pulse = 1 + Math.sin(t * 0.0015 + a.x * 9) * 0.08;
        ctx.beginPath(); ctx.arc(x, y, a.s * 0.32 * pulse, 0, TAU);
        ctx.fillStyle = `rgba(${PALETTE.amber},${a.a * 0.8})`; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, a.s * 0.32 * pulse + 5, 0, TAU);
        ctx.strokeStyle = `rgba(${PALETTE.white},${a.a * 0.35})`; ctx.lineWidth = 1; ctx.stroke();
      }
    };
  }

  // ── BIOLOGY: DNA helix, cells, membrane dots ──
  function biology(env) {
    const cells = Array.from({ length: 8 }, () => ({
      x: Math.random(), y: Math.random(), r: rand(14, 40), vx: rand(-0.008, 0.008), vy: rand(-0.008, 0.008), a: rand(0.1, 0.3)
    }));
    return (t) => {
      const { ctx, size } = env; const { w, h } = size();
      ctx.clearRect(0, 0, w, h);
      for (const c of cells) {
        c.x += c.vx * 0.016; c.y += c.vy * 0.016;
        if (c.x < 0 || c.x > 1) c.vx *= -1;
        if (c.y < 0 || c.y > 1) c.vy *= -1;
        const x = c.x * w, y = c.y * h;
        ctx.beginPath(); ctx.arc(x, y, c.r, 0, TAU);
        ctx.strokeStyle = `rgba(${PALETTE.white},${c.a})`; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.beginPath(); ctx.arc(x + c.r * 0.2, y + c.r * 0.15, c.r * 0.42, 0, TAU);
        ctx.fillStyle = `rgba(${PALETTE.teal},${c.a * 0.8})`; ctx.fill();
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(x - c.r * 0.35 + i * c.r * 0.22, y - c.r * 0.3 + (i % 2) * c.r * 0.5, 1.6, 0, TAU);
          ctx.fillStyle = `rgba(${PALETTE.white},${c.a})`; ctx.fill();
        }
      }
      // double helix
      const baseY = h * 0.52, amp = h * 0.16, k = 0.014;
      for (let x = -40; x <= w + 40; x += 4) {
        const p = t * 0.0006;
        const y1 = baseY + Math.sin(x * k + p) * amp;
        const y2 = baseY + Math.sin(x * k + p + Math.PI) * amp;
        ctx.fillStyle = `rgba(${PALETTE.teal},0.65)`;
        ctx.beginPath(); ctx.arc(x, y1, 2.2, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(${PALETTE.amber},0.55)`;
        ctx.beginPath(); ctx.arc(x, y2, 2.2, 0, TAU); ctx.fill();
      }
      // rungs
      for (let x = 0; x <= w; x += 46) {
        const p = t * 0.0006;
        const depth = Math.sin(x * k + p);
        if (Math.abs(depth) < 0.25) continue;
        const y1 = baseY + depth * amp;
        const y2 = baseY - depth * amp;
        ctx.strokeStyle = `rgba(${PALETTE.white},${0.14 + Math.abs(depth) * 0.2})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2); ctx.stroke();
      }
    };
  }

  // ── PROGRAMMING: code glyphs, nodes, connections ──
  function programming(env) {
    const glyphs = ['{ }', '< >', 'fn', '=>', ';', '()', 'if', '[]', '&&', '01', 'λ', '0x1F', '++', '::', 'let'];
    const cols = Math.max(6, Math.floor(window.innerWidth / 90));
    const drops = Array.from({ length: cols }, (_, i) => ({ x: (i + 0.5) / cols, y: Math.random(), sp: rand(0.04, 0.12) }));
    const nodes = Array.from({ length: 9 }, () => ({ x: Math.random(), y: Math.random(), vx: rand(-0.012, 0.012), vy: rand(-0.012, 0.012) }));
    return (t) => {
      const { ctx, size } = env; const { w, h } = size();
      ctx.clearRect(0, 0, w, h);
      // network nodes
      for (const n of nodes) {
        n.x += n.vx * 0.016; n.y += n.vy * 0.016;
        if (n.x < 0 || n.x > 1) n.vx *= -1;
        if (n.y < 0 || n.y > 1) n.vy *= -1;
      }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = (nodes[i].x - nodes[j].x) * w, dy = (nodes[i].y - nodes[j].y) * h;
          const d = Math.hypot(dx, dy);
          if (d < 190) {
            ctx.strokeStyle = `rgba(${PALETTE.teal},${0.28 * (1 - d / 190)})`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(nodes[i].x * w, nodes[i].y * h); ctx.lineTo(nodes[j].x * w, nodes[j].y * h); ctx.stroke();
          }
        }
      }
      for (const n of nodes) {
        ctx.beginPath(); ctx.arc(n.x * w, n.y * h, 3, 0, TAU);
        ctx.fillStyle = `rgba(${PALETTE.white},0.6)`; ctx.fill();
      }
      // drifting code glyphs
      ctx.font = "600 15px 'Courier New', monospace";
      for (const d of drops) {
        d.y += d.sp * 0.016;
        if (d.y > 1.1) { d.y = -0.1; d.x = Math.random(); }
        const g = glyphs[Math.floor((d.x * 100 + t * 0.001) % glyphs.length)];
        ctx.fillStyle = `rgba(${PALETTE.teal},0.4)`;
        ctx.fillText(g, d.x * w, d.y * h);
      }
    };
  }

  // ── COMMUNICATION: speech bubbles, letters, quote marks ──
  function communication(env) {
    const letters = 'AEIOUabcefghlmnopqrst'.split('');
    const parts = Array.from({ length: 22 }, () => ({
      x: Math.random(), y: Math.random(), s: rand(13, 26), sp: rand(0.008, 0.028),
      ch: letters[Math.floor(Math.random() * letters.length)], a: rand(0.14, 0.42), ph: rand(0, TAU)
    }));
    const bubbles = Array.from({ length: 5 }, () => ({
      x: Math.random(), y: Math.random(), w: rand(60, 130), h: rand(34, 58),
      vx: rand(-0.008, 0.008), vy: rand(-0.008, 0.008), lines: 1 + Math.floor(Math.random() * 3)
    }));
    return (t) => {
      const { ctx, size } = env; const { w, h } = size();
      ctx.clearRect(0, 0, w, h);
      for (const b of bubbles) {
        b.x += b.vx * 0.016; b.y += b.vy * 0.016;
        if (b.x < 0 || b.x > 1) b.vx *= -1;
        if (b.y < 0 || b.y > 1) b.vy *= -1;
        const x = b.x * w, y = b.y * h;
        ctx.strokeStyle = `rgba(${PALETTE.white},0.24)`; ctx.lineWidth = 1.5;
        ctx.fillStyle = `rgba(${PALETTE.teal},0.07)`;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, b.w, b.h, 12);
        else ctx.rect(x, y, b.w, b.h);
        ctx.fill(); ctx.stroke();
        // tail
        ctx.beginPath();
        ctx.moveTo(x + 14, y + b.h); ctx.lineTo(x + 8, y + b.h + 10); ctx.lineTo(x + 26, y + b.h);
        ctx.closePath(); ctx.stroke();
        // text lines
        for (let i = 0; i < b.lines; i++) {
          ctx.strokeStyle = `rgba(${PALETTE.white},0.3)`; ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x + 12, y + 14 + i * 11);
          ctx.lineTo(x + b.w - 12 - (i === b.lines - 1 ? b.w * 0.3 : 0), y + 14 + i * 11);
          ctx.stroke();
        }
      }
      for (const p of parts) {
        p.y -= p.sp * 0.016;
        if (p.y < -0.08) { p.y = 1.08; p.x = Math.random(); }
        const x = p.x * w + Math.sin(t * 0.001 + p.ph) * 12;
        ctx.font = `700 ${p.s}px 'Poppins', sans-serif`;
        ctx.fillStyle = `rgba(${PALETTE.amber},${p.a * 0.7})`;
        ctx.fillText(p.ch, x, p.y * h);
      }
      // big quote marks
      ctx.font = "800 90px Georgia, serif";
      ctx.fillStyle = 'rgba(226,240,250,0.07)';
      ctx.fillText('\u201C', w * 0.08, h * 0.62);
      ctx.fillText('\u201D', w * 0.8, h * 0.85);
    };
  }

  const SCENES = { mathematics, physics, chemistry, biology, programming, communication };

  function init(heroEl, subjectSlug) {
    if (!heroEl) return;
    const scene = SCENES[subjectSlug];
    if (!scene) return;
    const reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
    const env = makeCanvas(heroEl);
    if (!env) return;
    const frame = scene(env);

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
