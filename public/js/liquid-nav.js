// =============================================
// STUDYCORE — Liquid Navigation (js/liquid-nav.js)
// -----------------------------------------------
// Positions the gooey indicator (main pill + two
// trailing blobs) under the active item and slides
// it with a springy easing when the selection changes.
// =============================================

(function () {
  'use strict';

  function init() {
    const nav = document.getElementById('liquidNav');
    if (!nav) return;

    const items = Array.from(nav.querySelectorAll('.ln-list a'));
    const indicator = document.getElementById('lnIndicator');
    const main = indicator.querySelector('.ln-blob--main');
    const trailA = indicator.querySelector('.ln-blob--trail-a');
    const trailB = indicator.querySelector('.ln-blob--trail-b');
    const readout = document.getElementById('lnSelected');

    if (!items.length || !main) return;

    let activeIndex = Math.max(0, items.findIndex((a) => a.classList.contains('is-active')));
    let moveTimer = null;
    let initialised = false;

    function itemCenter(el) {
      const navRect = nav.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      return rect.left - navRect.left + rect.width / 2;
    }

    function moveTo(index, animate) {
      const item = items[index];
      if (!item) return;
      activeIndex = index;

      const center = itemCenter(item);

      items.forEach((a, i) => a.classList.toggle('is-active', i === index));
      if (readout) readout.textContent = item.dataset.lnLabel || item.textContent.trim();

      // First placement: snap without the goo "stretch" wobble so the
      // blob doesn't fly in from the left edge on load.
      if (!animate) {
        [main, trailA, trailB].forEach((b) => {
          b.style.transition = 'none';
          b.style.left = center + 'px';
        });
        // Force reflow, then restore transitions.
        void main.offsetWidth;
        [main, trailA, trailB].forEach((b) => { b.style.transition = ''; });
        initialised = true;
        return;
      }

      // Trigger the moving state (widens the pill, swells the trails)
      // for the duration of the spring animation.
      if (moveTimer) clearTimeout(moveTimer);
      nav.classList.add('is-moving');

      main.style.left = center + 'px';
      // Trailing blobs target the same center but arrive later thanks
      // to their longer, springier CSS transitions — the goo filter
      // melts the gap into a stretching tail.
      trailA.style.left = center + 'px';
      trailB.style.left = center + 'px';

      moveTimer = setTimeout(() => nav.classList.remove('is-moving'), 620);
    }

    items.forEach((a, i) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        moveTo(i, true);
      });
    });

    // Keep the indicator aligned if the layout shifts (font load, resize).
    let resizeT;
    window.addEventListener('resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => moveTo(activeIndex, initialised), 80);
    });

    // Defer the first placement until icons/fonts have settled so the
    // measured item centers are accurate.
    requestAnimationFrame(() => moveTo(activeIndex, false));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
