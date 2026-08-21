// =============================================
// STUDYCORE — Homepage hero image carousel
// -----------------------------------------------
// Full-bleed photos behind the existing hero copy.
// Crossfade + a slow Ken Burns pan/zoom. No libraries.
// =============================================

(function () {
  'use strict';

  function initHeroCarousel() {
    const root = document.getElementById('heroBackground');
    if (!root) return;
    const hero = root.closest('.hero');
    const slides = Array.from(root.querySelectorAll('.hero-bg-slide'));
    const dotsBox = document.getElementById('heroDots');
    const progress = document.getElementById('heroProgress');
    const progressFill = document.getElementById('heroProgressFill');
    if (!slides.length) return;

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const DURATION = 7500;
    const FADE = 1800;

    root.style.setProperty('--hero-hold', DURATION + 'ms');
    root.style.setProperty('--hero-fade', FADE + 'ms');

    slides.forEach((slide, i) => {
      slide.classList.toggle('pan-left', i % 2 === 1);
      if (i > 1) slide.setAttribute('loading', 'lazy');
    });

    const state = slides.map(() => 'loading');
    let order = [];
    let dots = [];
    let idx = 0;
    let current = -1;
    let timer = null;
    let dotsKey = '';
    let paused = false;
    let inView = true;

    function preload(src) {
      if (!src) return;
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
    }

    function stopTimer() {
      clearInterval(timer);
      timer = null;
      if (progressFill) progressFill.classList.remove('is-running');
    }

    function restartProgress() {
      if (!progressFill || reduce || order.length < 2) return;
      progressFill.classList.remove('is-running');
      void progressFill.offsetWidth;
      progressFill.classList.add('is-running');
      progressFill.style.animationPlayState = paused ? 'paused' : 'running';
    }

    function select(i) {
      if (!order.length) return;
      idx = ((i % order.length) + order.length) % order.length;
      current = order[idx];
      slides.forEach((slide, k) => {
        const on = k === current;
        if (on) {
          slide.classList.remove('is-active');
          void slide.offsetWidth;
        }
        slide.classList.toggle('is-active', on);
      });
      dots.forEach((dot, k) => {
        dot.classList.toggle('is-active', k === idx);
        dot.setAttribute('aria-current', k === idx ? 'true' : 'false');
      });
      const next = slides[order[(idx + 1) % order.length]];
      if (order.length > 1 && next) preload(next.currentSrc || next.getAttribute('src'));
      restartProgress();
    }

    function restart() {
      stopTimer();
      if (reduce || order.length < 2 || paused || !inView || document.hidden) {
        if (progressFill) progressFill.classList.remove('is-running');
        return;
      }
      restartProgress();
      timer = setInterval(() => select(idx + 1), DURATION);
    }

    function sync() {
      order = state.map((v, i) => (v === 'ready' ? i : -1)).filter((i) => i >= 0);

      if (!order.length) {
        root.classList.add('is-empty');
        if (dotsBox) dotsBox.hidden = true;
        if (progress) progress.hidden = true;
        slides.forEach((s) => s.classList.remove('is-active'));
        current = -1;
        stopTimer();
        return;
      }

      root.classList.remove('is-empty');
      if (dotsBox) dotsBox.hidden = false;
      if (progress) progress.hidden = reduce || order.length < 2;

      const key = order.join(',');
      if (key !== dotsKey && dotsBox) {
        dotsKey = key;
        dotsBox.innerHTML = '';
        dots = order.map((origIdx) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'hero-dot';
          b.setAttribute('aria-label', 'Show photo ' + (origIdx + 1));
          b.addEventListener('click', () => {
            select(order.indexOf(origIdx));
            restart();
          });
          dotsBox.appendChild(b);
          return b;
        });
      }

      if (current < 0 || order.indexOf(current) < 0) current = order[0];
      idx = order.indexOf(current);
      select(idx);
      restart();
    }

    slides.forEach((slide, i) => {
      const mark = (ok) => {
        state[i] = ok ? 'ready' : 'broken';
        sync();
      };
      if (slide.complete) mark(slide.naturalWidth > 0);
      else {
        slide.addEventListener('load', () => mark(true), { once: true });
        slide.addEventListener('error', () => mark(false), { once: true });
      }
    });

    if (hero) {
      hero.addEventListener('mouseenter', () => {
        paused = true;
        stopTimer();
        if (progressFill) progressFill.style.animationPlayState = 'paused';
      });
      hero.addEventListener('mouseleave', () => {
        paused = false;
        restart();
      });

      let touchX = null;
      hero.addEventListener('touchstart', (e) => {
        touchX = e.changedTouches[0].clientX;
      }, { passive: true });
      hero.addEventListener('touchend', (e) => {
        if (touchX == null || order.length < 2) return;
        const dx = e.changedTouches[0].clientX - touchX;
        touchX = null;
        if (Math.abs(dx) < 48) return;
        select(idx + (dx < 0 ? 1 : -1));
        restart();
      }, { passive: true });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopTimer();
      else restart();
    });

    if ('IntersectionObserver' in window && hero) {
      const io = new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
        if (inView) restart();
        else stopTimer();
      }, { threshold: 0.15 });
      io.observe(hero);
    }

    if (slides[1]) preload(slides[1].getAttribute('src'));
    sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHeroCarousel);
  } else {
    initHeroCarousel();
  }
})();
