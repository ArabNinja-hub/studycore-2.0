'use strict';
/* =============================================================
   HEADLESS NAV SMOKE TEST (dev-only, not part of `npm test`)
   ------------------------------------------------------------
   Loads the real pages from the running dev server into jsdom,
   executes the real <script> tags, and verifies the quiet shared
   chrome:
     1. renders on every page (brand, links, dropdowns, footer)
     2. pins on scroll (is-scrolled)
     3. flyout panels are clamped into the viewport (—dd-shift)
     4. mobile drawer opens/closes via the hamburger
   Run with:  node server.js  (in one terminal)
              node scripts/debug-nav-smoke.js  (in another)
   ============================================================= */

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.error('This smoke test needs the jsdom dev package (not committed):');
  console.error('  npm install --no-save jsdom');
  process.exit(2);
}

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PAGES = [
  '/',
  '/pages/courses.html',
  '/pages/subjects/mathematics.html',
  '/pages/subjects/physics.html',
  '/pages/subjects/chemistry.html',
  '/pages/subjects/biology.html',
  '/pages/subjects/programming.html',
  '/pages/subjects/communication.html',
  '/pages/resources.html',
  '/login.html'
];

let failures = 0;
let passes = 0;

function check(label, cond, detail) {
  if (cond) {
    passes++;
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootPage(path, { width = 1440, height = 900 } = {}) {
  const pageErrors = [];

  const dom = await JSDOM.fromURL(BASE + path, {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    width,
    height,
    beforeParse(window) {
      // The site uses relative fetches; map them onto the dev server.
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? new URL(input, BASE).href : input;
        return fetch(url, init);
      };
      // jsdom does not implement matchMedia; real browsers always do.
      window.matchMedia = window.matchMedia || (function (query) {
        return {
          matches: false,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() { return false; }
        };
      });
      // jsdom ignores the constructor width option for innerWidth; pin it so
      // geometry assertions (flyout clamping) run against the intended width.
      try {
        Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
      } catch { /* jsdom may expose these read-only; assertions adapt */ }
      window.addEventListener('error', (e) => pageErrors.push(e.message || 'unknown error'));
    }
  });

  await new Promise((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  // Let async renders (session fetch, course counts, whatsapp links) settle.
  await sleep(500);
  return { dom, pageErrors };
}

function scrollWindow(window, y) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
  Object.defineProperty(window.document.documentElement, 'scrollTop', { value: y, configurable: true, writable: true });
  window.dispatchEvent(new window.Event('scroll'));
  // bindScrollMorph throttles through requestAnimationFrame
  return new Promise((r) => window.requestAnimationFrame(() => window.requestAnimationFrame(r)));
}

async function testDesktop(path) {
  console.log(`\n— ${path} (desktop 1440px) —`);
  const { dom, pageErrors } = await bootPage(path);
  const { window } = dom;
  const { document } = window;

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

  const nav = document.getElementById('siteNav');
  check('navbar host rendered with .navbar class', nav && nav.classList.contains('navbar'));
  check('brand present', !!nav?.querySelector('.nav-brand'));
  const items = [...nav?.querySelectorAll('.nav-item') || []];
  check('4 nav links rendered', items.length === 4, `got ${items.length}`);
  check('2 flyout dropdowns rendered', nav?.querySelectorAll('.nav-dropdown').length === 2, `got ${nav?.querySelectorAll('.nav-dropdown').length}`);
  const isCourseHome = document.body.dataset.page === 'course';
  check(
    isCourseHome ? 'search button omitted from course home' : 'search button present',
    isCourseHome ? !nav?.querySelector('#navSearchBtn') : !!nav?.querySelector('#navSearchBtn')
  );
  check(
    isCourseHome ? 'mobile search bar omitted from course home' : 'mobile search bar present',
    isCourseHome ? !document.getElementById('mobileSearchBtn') : !!document.getElementById('mobileSearchBtn')
  );
  if (isCourseHome) {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
    check('search shortcut disabled on course home', !document.getElementById('searchOverlay'));
  } else {
    document.getElementById('navSearchBtn')?.click();
    check('search button opens the global overlay', document.getElementById('searchOverlay')?.classList.contains('open'));
    document.getElementById('globalSearchClose')?.click();
    check('global search overlay closes', !document.getElementById('searchOverlay')?.classList.contains('open'));
  }
  // Quiet chrome: no glider pill, no scroll progress bar, no floating dock,
  // no promotional top bar.
  check('no glider pill', !nav?.querySelector('#navGlider'));
  check('no nav scroll progress', !nav?.querySelector('.nav-scroll-progress'));
  check('no floating dock', !document.getElementById('floatingNavDock'));
  check('no promo top bar', !document.querySelector('.top-bar') && !document.getElementById('topBarHost'));
  if (document.getElementById('siteFooter')) {
    check('footer rendered', !!document.querySelector('.footer'));
  }
  check('mobile drawer host rendered', !!document.getElementById('mobileNav'));

  // Scroll: island should pin (is-scrolled).
  await scrollWindow(window, 420);
  check('nav pins with .is-scrolled after scroll', nav?.classList.contains('is-scrolled'));

  await scrollWindow(window, 0);
  check('nav unpins at top of page', !nav?.classList.contains('is-scrolled'));

  // Flyout clamp: stub the hidden panel's rect (jsdom performs no layout),
  // fire the real mouseenter handler, and verify the computed shift.
  const vw = window.innerWidth;
  const item = nav?.querySelector('[data-nav-id="resources"]');
  const dd = item?.querySelector('.nav-dropdown');
  if (item && dd) {
    // Fits inside the viewport: no shift expected.
    dd.getBoundingClientRect = () => ({ left: 300, right: 880, width: 580, top: 0, bottom: 0 });
    item.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
    check('flyout in viewport → no shift', dd.style.getPropertyValue('--dd-shift') === '0px', dd.style.getPropertyValue('--dd-shift'));
    // Right edge sits 40px past the viewport; clamp margin is 10px, so the
    // panel must shift left by 40 + 10 = 50px.
    const overRight = 40;
    dd.getBoundingClientRect = () => ({ left: vw - 280, right: vw + overRight, width: 580, top: 0, bottom: 0 });
    item.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }));
    item.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
    check(`flyout clamped to right edge (-${overRight + 10}px)`, dd.style.getPropertyValue('--dd-shift') === `-${overRight + 10}px`, dd.style.getPropertyValue('--dd-shift'));
    // Left edge at -15px, clamp margin is 10px → panel shifts right by 25px.
    dd.getBoundingClientRect = () => ({ left: -15, right: 565, width: 580, top: 0, bottom: 0 });
    item.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }));
    item.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
    check('flyout clamped to left edge (+25px)', dd.style.getPropertyValue('--dd-shift') === '25px', dd.style.getPropertyValue('--dd-shift'));
  } else {
    check('resources flyout available for clamp test', false);
  }

  window.close();
}

async function testMobile() {
  console.log(`\n— / (mobile 375px) —`);
  const { dom, pageErrors } = await bootPage('/', { width: 375, height: 812 });
  const { window } = dom;
  const { document } = window;

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  const nav = document.getElementById('siteNav');
  const burger = document.getElementById('hamburgerBtn');
  const drawer = document.getElementById('mobileNav');
  check('hamburger rendered on mobile', !!burger);
  check('drawer starts closed', !!drawer && !drawer.classList.contains('open'));

  burger?.click();
  check('drawer opens on hamburger click', drawer?.classList.contains('open'));
  check('hamburger reports expanded', burger?.getAttribute('aria-expanded') === 'true');
  check('backdrop active', document.getElementById('navBackdrop')?.classList.contains('open'));

  // The drawer slides in under the floating island, which keeps the brand
  // and turns the hamburger into the close control — no duplicate brand row
  // or close button inside the drawer itself.
  check('no duplicate brand row in drawer', !drawer?.querySelector('.mobile-nav-header'));
  check('no duplicate close button in drawer', !drawer?.querySelector('#mobileNavClose'));
  check('hamburger morphs to close control', burger?.getAttribute('aria-label') === 'Close menu');

  // Close it again through the island hamburger (X).
  burger?.click();
  check('drawer closes via island hamburger', !drawer?.classList.contains('open'));
  check('hamburger reports collapsed', burger?.getAttribute('aria-expanded') === 'false');

  burger?.click();
  document.getElementById('navBackdrop')?.click();
  check('drawer closes via backdrop click', !drawer?.classList.contains('open'));

  window.close();
}

(async () => {
  for (const p of PAGES) {
    try {
      await testDesktop(p);
    } catch (err) {
      failures++;
      console.log(`  FAIL  ${p} crashed: ${err.message}`);
    }
  }
  try {
    await testMobile();
  } catch (err) {
    failures++;
    console.log(`  FAIL  mobile crashed: ${err.message}`);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
