// =============================================
// STUDYCORE — Scroll reveal (js/scroll-reveal.js)
// -----------------------------------------------
// One small, shared progressive-enhancement layer for
// the public site, course homes and authenticated views.
// It observes content once, reveals it when it enters the
// viewport, and also picks up cards rendered later by page
// scripts without needing a second animation system.
// =============================================

(function () {
  'use strict';

  const REVEAL_SELECTORS = [
    '[data-scroll-reveal]',
    '.hero-copy',
    '.hero-stats',
    '.page-hero > .container',
    '.course-hero > .container',
    '.section-heading',
    '.how-grid > .card:not(.skeleton)',
    '.course-grid > .course-card',
    '.feature-grid > .card:not(.skeleton)',
    '.plans-grid > *:not(.skeleton)',
    '.resource-grid > .resource-card',
    '.topic-grid > .topic-card',
    '.video-term-grid > .video-term-card',
    '.lesson-list > .lesson-row',
    '.term-group-heading',
    '.announcement-list > .announcement-card',
    '.premium-card',
    '.community-panel',
    '.status-banner',
    '.continue-card',
    '.complete-banner',
    '.course-quick-nav',
    '.lesson-layout > *',
    '.dash-hero',
    '.dash-grid > .card:not(.skeleton)',
    'main .card:not(.skeleton)',
    'main .pay-method',
    '.legal-wrap > h1',
    '.legal-wrap > h2',
    '.legal-wrap .placeholder-note',
    'main img:not([aria-hidden="true"])',
    '[data-scroll-reveal-image]'
  ].join(',');

  const STAGGER_SELECTORS = [
    '.how-grid',
    '.course-grid',
    '.feature-grid',
    '.resource-grid',
    '.topic-grid',
    '.video-term-grid',
    '.lesson-list',
    '.announcement-list',
    '.plans-grid',
    '.dash-grid',
    '.pay-methods'
  ].join(',');

  const HIDDEN_PARENT_SELECTOR = '[hidden], [aria-hidden="true"]';
  const MAX_STAGGER = 360;
  const STAGGER_STEP = 72;

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function isCandidateVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.matches(HIDDEN_PARENT_SELECTOR) || element.closest(HIDDEN_PARENT_SELECTOR)) return false;
    // offsetParent is null for display:none elements, while fixed elements
    // (which may legitimately be revealed) are handled by their rect.
    if (element.offsetParent === null && getComputedStyle(element).position !== 'fixed') return false;
    return true;
  }

  function candidatesIn(root) {
    const found = [];
    if (root instanceof Element && root.matches(REVEAL_SELECTORS)) found.push(root);
    if (root && root.querySelectorAll) found.push(...root.querySelectorAll(REVEAL_SELECTORS));
    return [...new Set(found)];
  }

  function setRevealDelay(element, delay) {
    const value = `${Math.max(0, delay)}ms`;
    // MutationObserver also watches inline display changes used by the page
    // scripts. Avoid writing the same CSS variable repeatedly, which would
    // otherwise create needless mutation callbacks.
    if (element.style.getPropertyValue('--sc-reveal-delay').trim() !== value) {
      element.style.setProperty('--sc-reveal-delay', value);
    }
  }

  function setStaggerDelay(element) {
    if (element.hasAttribute('data-scroll-reveal-delay')) {
      setRevealDelay(element, Number(element.getAttribute('data-scroll-reveal-delay')) || 0);
      return;
    }

    const group = element.closest(STAGGER_SELECTORS);
    if (!group) return;

    // Count reveal candidates in document order within the nearest content
    // group. The cap keeps long lesson/resource lists feeling immediate.
    const siblings = candidatesIn(group).filter((candidate) => candidate !== group && isCandidateVisible(candidate));
    const index = Math.max(0, siblings.indexOf(element));
    if (siblings.length > 1) setRevealDelay(element, Math.min(index * STAGGER_STEP, MAX_STAGGER));
  }

  function directionFor(element) {
    const direction = element.getAttribute('data-scroll-reveal');
    if (direction === 'fade-left' || direction === 'fade-right') return direction;
    if (element.matches('img') || element.hasAttribute('data-scroll-reveal-image')) return 'fade-right';
    return 'fade-up';
  }

  function prepare(elements, observer) {
    elements.forEach((element) => {
      if (!isCandidateVisible(element) || element.classList.contains('sc-reveal-visible')) return;

      const direction = directionFor(element);
      element.setAttribute('data-scroll-reveal', direction);
      setStaggerDelay(element);
      observer.observe(element);
    });
  }

  function init() {
    // No class is added and no content is hidden when motion is reduced, the
    // API is unavailable, or the browser does not support IntersectionObserver.
    // That makes the feature a true progressive enhancement: JS-off content
    // remains fully visible too.
    if (prefersReducedMotion() || !('IntersectionObserver' in window)) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const element = entry.target;
        observer.unobserve(element);
        element.classList.add('sc-reveal-visible');
      });
    }, {
      root: null,
      // Start just before the element reaches the visible reading area so the
      // motion feels connected to the scroll rather than late or distracting.
      rootMargin: '0px 0px -8% 0px',
      threshold: 0.08
    });

    const body = document.body;
    const initialCandidates = candidatesIn(document);
    prepare(initialCandidates, observer);
    // CSS only applies its hidden state after this opt-in class exists. If
    // this script fails or is blocked, the body never opts into hidden content.
    body.classList.add('scroll-reveal-enabled');

    // Page scripts replace skeletons with live cards after their API calls.
    // Observe those additions without polling or re-running animations.
    const mutations = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === 'childList') {
          record.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) prepare(candidatesIn(node), observer);
          });
        } else if (record.type === 'attributes') {
          prepare(candidatesIn(record.target), observer);
        }
      });
    });
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['hidden', 'style']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
