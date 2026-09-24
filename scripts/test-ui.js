'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SUBJECT_DIR = path.join(ROOT, 'public', 'pages', 'subjects');
const subjectPages = fs.readdirSync(SUBJECT_DIR)
  .filter((name) => name.endsWith('.html'))
  .sort();

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test('all six course homes expose the same compact navigation', () => {
  assert.equal(subjectPages.length, 6);
  const targets = ['topics', 'video-lessons', 'resources', 'past-papers', 'progress'];

  for (const file of subjectPages) {
    const html = fs.readFileSync(path.join(SUBJECT_DIR, file), 'utf8');
    assert.match(html, /<nav class="course-subnav" aria-label="Course sections">/);
    assert.equal(occurrences(html, /id="courseSubnav"/g), 1, `${file}: desktop course navigation`);
    assert.equal(occurrences(html, /id="courseJump"/g), 1, `${file}: mobile section picker`);
    // The sticky subnav is the single source of course-section navigation;
    // a second shortcut grid would repeat the same links on the same screen.
    assert.doesNotMatch(html, /class="course-quick-nav"/, `${file}: no duplicate shortcut grid`);

    for (const target of targets) {
      assert.match(html, new RegExp(`(?:id="${target}"|value="#${target}")`), `${file}: ${target} is reachable`);
      assert.equal(occurrences(html, new RegExp(`id="${target}"`, 'g')), 1, `${file}: unique #${target}`);
    }

    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${file}: duplicate HTML id`);
  }
});

test('course homes no longer carry the flat "all lessons" list', () => {
  // Lessons are reached through Topics, Video lessons, Study materials and
  // Past papers. The old catch-all list duplicated all four, so the section,
  // its nav entries and every anchor into it are gone.
  const pages = [
    ...subjectPages.map((file) => path.join('public', 'pages', 'subjects', file)),
    'views/course.html'
  ];

  for (const file of pages) {
    const html = read(file);
    assert.doesNotMatch(html, /All lessons in this course/, `${file}: lessons heading removed`);
    assert.doesNotMatch(html, /id="lessons"/, `${file}: lessons section removed`);
    assert.doesNotMatch(html, /id="lessonList"/, `${file}: lesson list container removed`);
    assert.doesNotMatch(html, /href="#lessons"|value="#lessons"/, `${file}: no nav entry for the removed section`);
  }

  // The renderers must not write to the removed container, and nothing may
  // link to a #lessons / #lesson-topic-* anchor that no longer exists.
  for (const script of ['public/js/course.js', 'public/js/program-course.js']) {
    const source = read(script);
    assert.doesNotMatch(source, /lessonList/, `${script}: no write to the removed container`);
    assert.doesNotMatch(source, /#lessons\b/, `${script}: no link to the removed section`);
    assert.doesNotMatch(source, /lesson-topic-/, `${script}: no dead topic anchors`);
  }

  for (const script of ['public/js/layout.js', 'public/js/lesson.js', 'public/pages/search.html']) {
    assert.doesNotMatch(read(script), /lesson-topic-/, `${script}: topic links target a live section`);
  }
});

test('course homes do not render the shared search controls', () => {
  const layout = read('public/js/layout.js');
  const courseCss = read('public/css/course.css');

  assert.match(layout, /function globalSearchEnabled\(\)/);
  assert.match(layout, /return currentPage\(\) !== 'course'/);
  assert.match(layout, /const searchButtonHtml = globalSearchEnabled\(\)/);
  assert.match(layout, /const searchTabHtml = globalSearchEnabled\(\)/);
  assert.match(layout, /function bindNavSearch\(\) \{\s*if \(!globalSearchEnabled\(\)\) return;/);
  assert.match(layout, /function openSearchOverlay\(\) \{\s*if \(!globalSearchEnabled\(\)\) return;/);
  assert.doesNotMatch(courseCss, /course-search-row/, 'remove the obsolete course search styles');

  for (const file of subjectPages) {
    const html = fs.readFileSync(path.join(SUBJECT_DIR, file), 'utf8');
    assert.match(html, /<body data-page="course"/, `${file}: identifies itself as a course home`);
    assert.doesNotMatch(html, /<input[^>]+type="search"/i, `${file}: no course-level search field`);
  }
});

test('course terms open a single-course video page', () => {
  const courseJs = read('public/js/course.js');
  const videoJs = read('public/js/video.js');
  const videosHtml = read('public/pages/videos.html');
  const layout = read('public/js/layout.js');

  assert.match(courseJs, /\/pages\/videos\.html\?course=/);
  assert.match(courseJs, /term=\$\{encodeURIComponent\(term\)\}/);
  assert.match(videoJs, /one course/);
  assert.doesNotMatch(videoJs, /courseChips/);
  assert.doesNotMatch(videosHtml, /id="courseChips"/);
  assert.doesNotMatch(layout, /whatsapp-group-qr|communityQrHtml|qr-frame/);
});

test('video lessons render as cards on per-term shelves', () => {
  const videoJs = read('public/js/video.js');
  const videosHtml = read('public/pages/videos.html');
  const css = read('public/css/style.css');
  const scrollReveal = read('public/js/scroll-reveal.js');

  // The page hosts one shelf per term (Term 1/2/3 + Other), each with its own
  // card grid — not the old flat one-term row list.
  assert.match(videosHtml, /id="videoTermShelves"/);
  assert.doesNotMatch(videosHtml, /id="videoList"/, 'the old one-term row list is gone');
  assert.match(videoJs, /video-lesson-grid/);
  assert.match(videoJs, /video-lesson-card/);
  assert.match(videoJs, /term-group/);
  assert.match(videoJs, /videoTermShelves/);

  // Cards carry the video affordances: thumbnail stage, play button, watched
  // flag, resume pill, and the Premium overlay for locked lessons.
  assert.match(videoJs, /video-lesson-thumb/);
  assert.match(videoJs, /video-lesson-play/);
  assert.match(videoJs, /video-lesson-flag/);
  assert.match(videoJs, /video-lesson-resume/);
  assert.match(videoJs, /lockOverlayHtml/);

  // The term strip is an in-page anchor nav with per-term counts (all shelves
  // render from one payload — no per-term re-download).
  assert.match(videoJs, /subnav-count/);
  assert.match(videoJs, /data-term=/);
  assert.doesNotMatch(videoJs, /pushState/, 'term switching is a scroll, not a history rewrite');

  // The card system is part of the shared design language…
  assert.match(css, /\.video-lesson-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.video-lesson-card \{/);
  assert.match(css, /\.video-lesson-card\.locked \.video-lesson-thumb/);
  // …including its responsive columns and the scroll-reveal flight.
  assert.match(css, /\.video-lesson-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.video-lesson-grid \{[^}]*grid-template-columns: 1fr; \}/);
  assert.match(scrollReveal, /video-lesson-grid > \.video-lesson-card/);
});

test('global navigation keeps videos within the course hierarchy', () => {
  const layout = read('public/js/layout.js');
  const navBlock = layout.match(/const NAV_LINKS = \[(.*?)\n  \];/s)?.[1] || '';
  assert.match(navBlock, /label: 'Courses'/);
  assert.match(navBlock, /label: 'Resources'/);
  assert.doesNotMatch(navBlock, /label: 'Home'/);
  assert.doesNotMatch(navBlock, /label: 'Video Lessons'/);
  assert.doesNotMatch(layout.match(/function renderMobileTabs\(user\) \{[\s\S]*?\n  \}/)?.[0] || '', /> Video Lessons</);
});

test('mobile course controls and tab bar styles are present', () => {
  const css = read('public/css/style.css');
  assert.match(css, /body\.has-mobtabs \.mob-tabs \{ display: flex; \}/);
  assert.match(css, /body\[data-page='course'\] \.course-subnav \.subnav-links \{ display: none; \}/);
  assert.match(css, /\.course-jump \{ display: flex;/);
  assert.match(css, /body\[data-page='courses'\] \.course-card/);
});

test('mobile navigation uses a phone drawer and preserves the tablet account sheet', () => {
  const layout = read('public/js/layout.js');
  const auth = read('public/js/auth.js');
  const css = read('public/css/style.css');

  // The legacy accordion/navBackdrop implementation is still gone, but phones
  // now get the requested right-side pop-out drawer from the shared layout.
  assert.doesNotMatch(layout, /hamburgerBtn|mobile-accordion|mobileSubjectLinks|navBackdrop/);
  assert.doesNotMatch(auth, /initMobileNav/);
  assert.match(layout, /id="navMenuBtn"/);
  assert.match(layout, /function renderMobileDrawer\(user\) \{/);
  assert.match(layout, /id="mobileNavDrawer"/);
  assert.match(layout, /id="mobileNavBackdrop"/);
  assert.match(layout, /data-mobile-theme-toggle/);
  assert.match(layout, /data-mobile-search/);
  assert.match(layout, /e\.key === 'Escape'/);

  // The drawer is phone-only, slides from the right, and the backdrop closes it.
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*?\.nav-menu-btn \{ display: inline-flex; \}/);
  assert.match(css, /\.mobile-nav-drawer \{[\s\S]*?transform:\s*translateX\(105%\) scale\(0\.985\)/);
  assert.match(css, /\.mobile-nav-drawer\.open \{[\s\S]*?transform:\s*translateX\(0\) scale\(1\)/);
  assert.match(css, /\.mobile-nav-backdrop/);
  assert.match(css, /border-radius:\s*28px 0 0 28px/);
  assert.match(css, /body\.has-mobtabs \{ padding-bottom: 0; \}/);
  assert.match(css, /body\.has-mobtabs \.mob-tabs \{ display: none !important; \}/);

  // The tablet tab bar and Account bottom sheet still exist for the wider
  // mobile/tablet breakpoint and keep their focus/visibility contract.
  assert.match(layout, /function renderMobileTabs\(user\) \{/);
  assert.match(layout, /host\.id = 'mobTabsHost'/);
  assert.match(layout, /id="mobTabAccount"/);
  assert.match(layout, /teardownMobileTabs\(\); return;/);
  const renderTabs = layout.match(/function renderMobileTabs\(user\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.doesNotMatch(renderTabs, /if \(!user/, 'guests get the tab bar too');
  assert.match(layout, /function renderAccountSheet\(user\) \{/);
  assert.match(layout, /function openAccountSheet\(\) \{/);
  assert.match(css, /\.account-sheet\.open \{[^}]*transform:\s*translateY\(0\)/);
  assert.match(css, /\.account-sheet\.open \{[^}]*visibility:\s*visible/);
  assert.match(css, /\.sc-backdrop\.open \{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/);
  assert.match(css, /@media \(min-width: 1181px\) \{\s*\.mob-tabs, \.sc-backdrop, \.account-sheet, \.mobile-nav-drawer \{ display: none !important; \}/);
  assert.match(css, /body\.has-mobtabs \{ padding-bottom: calc\(\d+px \+ env\(safe-area-inset-bottom, 0px\)\); \}/);
});

test('scroll reveal is shared, progressive, and reduced-motion aware', () => {
  const revealJs = read('public/js/scroll-reveal.js');
  const css = read('public/css/style.css');

  assert.match(revealJs, /IntersectionObserver/);
  assert.match(revealJs, /MutationObserver/);
  assert.match(revealJs, /prefers-reduced-motion/);
  assert.match(revealJs, /observer\.unobserve\(element\)/);
  assert.match(css, /body\.scroll-reveal-enabled/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /translate3d\(var\(--sc-reveal-x\), var\(--sc-reveal-y\), 0\)/);

  const htmlFiles = [
    ...fs.readdirSync(path.join(ROOT, 'public')).filter((name) => name.endsWith('.html')).map((name) => path.join('public', name)),
    ...['public/pages', 'public/pages/subjects'].flatMap((dir) =>
      fs.readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith('.html')).map((name) => path.join(dir, name))
    ),
    ...fs.readdirSync(path.join(ROOT, 'views')).filter((name) => name.endsWith('.html')).map((name) => path.join('views', name))
  ];
  for (const file of htmlFiles) assert.match(read(file), /<script src="\/js\/scroll-reveal\.js"><\/script>/, `${file}: shared reveal script`);
});

test('document reader is view-only and uses on-demand PDF ranges', () => {
  const viewerHtml = read('views/viewer.html');
  const viewerJs = read('public/js/viewer.js');
  const lessonJs = read('public/js/lesson.js');
  const readerJs = read('public/js/doc-reader.js');
  const apiJs = read('public/js/api.js');
  const resourceRoutes = read('routes/resources.routes.js');

  assert.doesNotMatch(viewerHtml, /viewerDownload|aria-label="Download document"/);
  assert.doesNotMatch(viewerJs, /downloadUrl|viewerDownload/);
  assert.doesNotMatch(lessonJs, /downloadUrl/);
  assert.doesNotMatch(readerJs, /downloadUrl|fetchDocumentBytes|method:\s*['"]HEAD['"]/);
  assert.doesNotMatch(apiJs, /downloadUrl|myDownloads/);

  assert.match(readerJs, /disableStream:\s*true/);
  assert.match(readerJs, /disableAutoFetch:\s*true/);
  assert.match(readerJs, /rangeChunkSize:\s*131072/);
  assert.match(resourceRoutes, /fileSize:\s*row\.file_size/);
  assert.match(resourceRoutes, /router\.get\('\/:id\/download'[\s\S]*?res\.status\(403\)/);
  assert.doesNotMatch(resourceRoutes, /disposition:\s*['"]attachment['"]|INSERT INTO downloads/);
});

test('Google Drive previews go fullscreen and drop Google/floating buttons', () => {
  const viewerJs = read('public/js/viewer.js');
  const viewerCss = read('public/css/viewer.css');
  const readerJs = read('public/js/doc-reader.js');

  // The Drive branch must keep the toolbar up with only the Fullscreen
  // button. Hiding the whole toolbar (the old behaviour) left Drive
  // documents with no way to enter fullscreen at all.
  const driveBranch = viewerJs.slice(
    viewerJs.indexOf('if (resource.googleDriveFileId)'),
    viewerJs.indexOf('Legacy link-only resources')
  );
  assert.match(driveBranch, /showDriveToolbar\(\)/, 'Drive preview enables the Drive toolbar');
  assert.doesNotMatch(driveBranch, />Open in Google Drive<\/a>/, 'no floating "Open in Google Drive" button over the document');
  assert.doesNotMatch(driveBranch, /doc-reader-drive-preview/, 'old inline-styled Drive wrapper is gone');
  assert.match(driveBranch, /class="drive-preview-frame"/, 'Drive preview renders the cropped frame');

  // showDriveToolbar hides every control except Fullscreen.
  const driveToolbarFn = viewerJs.slice(viewerJs.indexOf('function showDriveToolbar'));
  assert.doesNotMatch(driveToolbarFn.slice(0, driveToolbarFn.indexOf('\n  }')), /viewerFullscreen/, 'Fullscreen must stay visible on Drive previews');

  // With no reader object (Drive path), fullscreen must target the reading
  // surface so the document fills the screen; the built-in reader still
  // promotes its own stage.
  assert.match(viewerJs, /const el = \$\('#viewerHost'\) \|\| \$\('#viewerShell'\);/);
  assert.match(viewerCss, /\.viewer-stage:fullscreen/);
  assert.match(readerJs, /const fsTarget = stage/);

  // Google's /preview frame is cross-origin, so its toolbar (which carries
  // the floating Share button) is cropped off: frame shifted up by the bar
  // height, grown by the same amount, wrapper clips the strip.
  assert.match(viewerCss, /\.drive-preview\s*\{[^}]*--drive-toolbar-crop:\s*64px/m);
  assert.match(viewerCss, /\.drive-preview\s*\{[^}]*overflow: hidden/m);
  assert.match(viewerCss, /\.drive-preview-frame\s*\{[^}]*top: calc\(-1 \* var\(--drive-toolbar-crop\)\)/m);
  assert.match(viewerCss, /\.drive-preview-frame\s*\{[^}]*height: calc\(100% \+ var\(--drive-toolbar-crop\)\)/m);

  // Hiding individual viewer controls needs explicit [hidden] suppression —
  // author display rules outrank the UA default.
  assert.match(viewerCss, /\.viewer-tool\[hidden\][\s\S]{0,120}?display: none;/);
});

test('homepage is program-aware and never ships the obsolete subject cards', () => {
  const indexHtml = read('public/index.html');
  const revealJs = read('public/js/scroll-reveal.js');

  // The homepage program/course cards participate in the same shared scroll
  // reveal as every other card grid, so they fly in as the student scrolls.
  assert.doesNotMatch(indexHtml, /id="homeCatalog"[^>]*data-no-scroll-reveal/);
  assert.match(indexHtml, /StudyCoreAPI\.myProgram\(\)/);
  assert.match(indexHtml, /StudyCoreAPI\.listPrograms\(true\)/);
  assert.match(indexHtml, /data\.courses\.map\(\(course\) => courseCard/);
  assert.match(indexHtml, /Choose your program\. We organise the rest\./);
  assert.doesNotMatch(indexHtml, /data-course="(?:mathematics|physics|chemistry|biology|programming|communication)"/);
  assert.doesNotMatch(indexHtml, /Pick a course and start learning/);
  assert.match(revealJs, /closest\('\[data-no-scroll-reveal\]'\)/);
});

test('hero has no decorative StudyCore logo', () => {
  const indexHtml = read('public/index.html');
  const css = read('public/css/style.css');
  const layout = read('public/js/layout.js');

  // The decorative emblem and all of its styling are gone from the hero.
  assert.doesNotMatch(indexHtml, /hero-bg-visual/);
  assert.doesNotMatch(indexHtml, /hero-floating-logo/);
  assert.doesNotMatch(indexHtml, /studycore-emblem\.png/);
  assert.doesNotMatch(css, /hero-floating-logo|hero-logo-img|hero-logo-glow|hero-logo-orbit|hero-bg-visual/);
  assert.doesNotMatch(css, /heroLogoEntrance|heroLogoFloat/);

  // Main StudyCore navbar branding remains intact.
  assert.match(layout, /<a href="\/" class="nav-brand" aria-label="StudyCore home">/);

  // Hero foreground content layering is untouched.
  assert.match(css, /\.hero \.container\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.hero \.container\s*\{[^}]*z-index:\s*2/);
});

test('home hero uses the photographic slideshow across every viewport', () => {
  const html = read('public/index.html');
  const css = read('public/css/style.css');
  const slideshow = read('public/js/hero-slideshow.js');

  // The retired SVG map must not sit on top of, or hide, the photography on
  // phones. The photo stage is full bleed and therefore works at every width.
  assert.doesNotMatch(html, /hero-map-scene|hero-map-svg|hero-floating-card/);
  assert.match(css, /\.hero-map-scene \{ display: none; \}/);
  assert.match(css, /\.hero-slideshow \{[\s\S]*?position: absolute;[\s\S]*?inset: 0;/);
  assert.match(css, /\.hero-slideshow\.is-loaded \{ opacity: 1; \}/);
  assert.match(css, /\.hero-shot img \{[\s\S]*?object-fit: cover;/);
  assert.match(css, /body\[data-page='home'\]:not\(\[data-theme='dark'\]\) \{ --bg: #ffffff; --bg-alt: #ffffff; \}/);

  // All declarative URLs point to real, committed photo assets. Keeping this
  // check next to the UI assertions stops a typo in the first frame from
  // making the entire visual treatment silently disappear after deployment.
  const rawList = html.match(/data-images='([\s\S]*?)'/)?.[1];
  assert.ok(rawList, 'home hero declares its image list');
  const imageUrls = JSON.parse(rawList);
  assert.ok(imageUrls.length > 1, 'home hero has more than one frame');
  for (const url of imageUrls) {
    const filename = decodeURIComponent(url).replace(/^\/images\/hero\//, '');
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'images', 'hero', filename)), `hero asset exists: ${filename}`);
  }

  // A cached/recycled image may not emit a second load event. The component
  // detects that case immediately instead of waiting for its watchdog, and it
  // tries the rest of the declared sources if the first one fails.
  assert.match(slideshow, /if \(img\.complete\) \{[\s\S]*?img\.naturalWidth > 0/);
  assert.match(slideshow, /async function showFirstAvailableFrame\(\)/);
  assert.match(slideshow, /for \(let candidate = 0; candidate < images\.length; candidate \+= 1\)/);
  assert.match(slideshow, /const canRotate = images\.length > 1 && !frugal && !reduced/);
});

test('hero slideshow advances cached and recycled frames without waiting for a load event', async () => {
  class FakeClassList {
    constructor() { this.values = new Set(); }
    add(...names) { names.forEach((name) => this.values.add(name)); }
    remove(...names) { names.forEach((name) => this.values.delete(name)); }
    contains(name) { return this.values.has(name); }
  }

  class FakeElement {
    constructor() {
      this.attributes = new Map();
      this.children = [];
      this.dataset = {};
      this.classList = new FakeClassList();
      this.className = '';
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) || null; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    get offsetWidth() { return 1; }
  }

  // This image reports an immediately decoded memory-cache result and never
  // dispatches `onload`, matching the browser edge case that froze the old
  // slideshow after recycling a frame.
  class CachedImage extends FakeElement {
    constructor() {
      super();
      this.complete = false;
      this.naturalWidth = 0;
    }
    set src(value) {
      this._src = value;
      this.complete = true;
      this.naturalWidth = 320;
    }
    get src() { return this._src; }
    decode() { return Promise.resolve(); }
  }

  const timers = new Map();
  const schedule = (fn, delay) => {
    const handle = {};
    timers.set(handle, { fn, delay });
    return handle;
  };
  const cancel = (handle) => timers.delete(handle);
  const document = {
    readyState: 'complete',
    hidden: false,
    addEventListener() {},
    createElement(tag) { return tag === 'img' ? new CachedImage() : new FakeElement(); },
    querySelectorAll() { return []; }
  };
  const window = {
    document,
    navigator: {},
    Image: CachedImage,
    matchMedia: () => ({ matches: false }),
    setTimeout: schedule,
    clearTimeout: cancel,
    SC: {}
  };
  const context = vm.createContext({ window, document, setTimeout: schedule, clearTimeout: cancel, Promise });
  new vm.Script(read('public/js/hero-slideshow.js'), { filename: 'public/js/hero-slideshow.js' }).runInContext(context);

  const host = new FakeElement();
  host.setAttribute('data-images', JSON.stringify(['/images/one.jpeg', '/images/two.jpeg']));
  window.SC.HeroSlideshow.init(host);
  // `decode` → `load` → async initial-frame setup spans a few microtasks.
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();

  assert.ok(host.classList.contains('is-loaded'), 'the cached first image becomes visible');
  assert.ok(host.children[0].classList.contains('is-active'), 'first layer is active');

  async function advanceSlide() {
    const next = [...timers.entries()].find(([, task]) => task.delay === 8000);
    assert.ok(next, 'a slide transition is scheduled');
    timers.delete(next[0]);
    next[1].fn();
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  }

  await advanceSlide();
  assert.ok(host.children[1].classList.contains('is-active'), 'second layer activates from cache');
  await advanceSlide();
  assert.ok(host.children[0].classList.contains('is-active'), 'recycled first layer activates without a new load event');
});

test('hero photography renders as an aged archive print, cheaply', () => {
  const indexHtml = read('public/index.html');
  const css = read('public/css/style.css');
  const js = read('public/js/hero-slideshow.js');

  // The slideshow is declarative markup + one shared module, not an inline
  // per-page script, and the photo list lives in the HTML.
  assert.match(indexHtml, /data-hero-slideshow/);
  assert.match(indexHtml, /<script src="\/js\/hero-slideshow\.js" defer><\/script>/);
  assert.doesNotMatch(indexHtml, /Hero image slideshow initialization/, 'inline slideshow script was replaced');
  assert.match(indexHtml, /rel="preload"[\s\S]*?as="image"/, 'first hero frame is preloaded');

  // The "ancient fade": sepia-drained shot + patina + grain.
  assert.match(css, /\.hero-shot img\s*\{[\s\S]*?filter:[\s\S]*?sepia\(/);
  assert.match(css, /\.hero-shot img\s*\{[\s\S]*?grayscale\(/);
  assert.match(css, /\.hero-patina\s*\{/);
  assert.match(css, /\.hero-grain\s*\{[\s\S]*?feTurbulence/);

  // Only compositor-friendly properties animate, and the expensive drift is
  // gated to large motion-safe screens so phones never scale a filtered image.
  assert.match(css, /\.hero-shot\s*\{[\s\S]*?transition: opacity/);
  assert.match(
    css,
    /@media \(min-width: 900px\) and \(prefers-reduced-motion: no-preference\)\s*\{\s*\.hero-shot\.is-drifting img/
  );

  // Two recycled layers only, data-plan aware, pauses when unseen.
  assert.match(js, /const a = makeLayer\(\);\s*const b = makeLayer\(\);/);
  assert.match(js, /saveData/);
  assert.match(js, /prefers-reduced-motion/);
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /visibilitychange/);
  assert.doesNotMatch(js, /setInterval\s*\(/, 'a self-scheduling timeout chain, never setInterval');
  assert.match(js, /is-unavailable/, 'a failed photo degrades to the plain hero');
});

test('the client is built for a phone on mobile data', () => {
  const api = read('public/js/api.js');
  const auth = read('public/js/auth.js');
  const css = read('public/css/style.css');

  // Timeouts + bounded retries, and writes are never replayed.
  assert.match(api, /AbortController/);
  assert.match(api, /TIMEOUT_MS/);
  assert.match(api, /const SAFE_METHODS = new Set\(\['GET', 'HEAD'\]\)/);
  assert.match(api, /safe \? NET\.RETRIES \+ 1 : 1/, 'only safe requests auto-retry');

  // One shared, honest connection state.
  assert.match(api, /SC\.net = \{/);
  assert.match(api, /onReconnect\(fn\)/);
  assert.match(api, /id = 'scNetStrip'/);
  assert.match(css, /\.sc-net-strip\s*\{/);

  // A dropped connection must not look like being signed out.
  assert.match(auth, /sessionUnknown/);
  assert.match(auth, /if \(err && err\.network\) \{\s*sessionUnknown = true;/);

  // iOS-safe scroll lock instead of body { overflow: hidden }.
  assert.match(auth, /function setScrollLock\(key, locked\)/);
  assert.match(auth, /SC\.setScrollLock = setScrollLock/);
  for (const file of ['public/js/layout.js', 'public/js/auth.js']) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      /document\.body\.style\.overflow/,
      `${file}: overlays must go through SC.setScrollLock`
    );
  }

  // Touch ergonomics: no sticky hover states, real press feedback, 44px targets.
  assert.match(css, /@media \(hover: none\)/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?min-height: 44px/);
  assert.match(css, /-webkit-tap-highlight-color: transparent/);
  assert.match(css, /scroll-padding-top: calc\(var\(--nav-h\)/);
});

test('every page opts into the mobile viewport and warms the font connection', () => {
  const pages = [
    ...fs.readdirSync(path.join(ROOT, 'public')).filter((n) => n.endsWith('.html')).map((n) => path.join('public', n)),
    ...fs.readdirSync(path.join(ROOT, 'public', 'pages')).filter((n) => n.endsWith('.html')).map((n) => path.join('public', 'pages', n)),
    ...subjectPages.map((n) => path.join('public', 'pages', 'subjects', n)),
    ...fs.readdirSync(path.join(ROOT, 'views')).filter((n) => n.endsWith('.html')).map((n) => path.join('views', n))
  ];

  assert.ok(pages.length >= 20);
  for (const page of pages) {
    const html = read(page);
    if (!/name="viewport"/.test(html)) continue;
    assert.match(html, /viewport-fit=cover/, `${page}: safe-area insets need viewport-fit=cover`);
    assert.match(html, /rel="preconnect" href="https:\/\/fonts\.gstatic\.com"/, `${page}: preconnect to the font CDN`);
  }
});

test('application JavaScript parses successfully', () => {
  const roots = [
    'server.js',
    ...['lib', 'middleware', 'routes', 'public/js'].flatMap((dir) =>
      fs.readdirSync(path.join(ROOT, dir))
        .filter((name) => name.endsWith('.js'))
        .map((name) => path.join(dir, name))
    )
  ];

  for (const relativePath of roots) {
    assert.doesNotThrow(
      () => new vm.Script(read(relativePath), { filename: relativePath }),
      `${relativePath} should parse`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────
// Mobile fit regressions.
//
// These lock in the specific defects that made phone layouts overflow
// while desktop and tablet looked fine. They are cheap static checks —
// the point is that a future edit reintroducing the pattern fails loudly.
// ─────────────────────────────────────────────────────────────────────

test('no inline grid-template-columns can outrank the mobile breakpoints', () => {
  const pages = [
    ...fs.readdirSync(path.join(ROOT, 'views')).filter((n) => n.endsWith('.html')).map((n) => path.join('views', n)),
    ...fs.readdirSync(path.join(ROOT, 'public')).filter((n) => n.endsWith('.html')).map((n) => path.join('public', n))
  ];
  for (const page of pages) {
    assert.doesNotMatch(
      read(page),
      /style="[^"]*grid-template-columns/i,
      `${page}: an inline grid-template-columns beats every media query, so the grid can never collapse on a phone. Put the columns in a class.`
    );
  }
});

test('fixed grid track minimums are clamped so they fit a 320px screen', () => {
  for (const file of ['public/css/style.css', 'public/css/quiz.css', 'public/css/content-admin.css']) {
    // Strip comments first: the explanatory prose next to these rules
    // legitimately quotes the bad pattern it is warning about.
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    // minmax(<fixed>px, …) with a minimum wider than a narrow column forces
    // horizontal overflow; min(<fixed>px, 100%) lets the track shrink.
    const offenders = [...css.matchAll(/minmax\(\s*(\d+)px/g)]
      .filter((match) => Number(match[1]) > 120)
      .map((match) => match[0]);
    assert.deepEqual(
      offenders, [],
      `${file}: use minmax(min(Npx, 100%), …) so the track can shrink below N on a phone.`
    );
  }
});

test('wide admin tables reflow into labelled cards on small screens', () => {
  const css = read('public/css/style.css');
  assert.match(css, /table\.table td::before\s*\{[\s\S]*?content: attr\(data-label\)/);
  assert.match(css, /table\.table thead\s*\{[\s\S]*?clip: rect\(0 0 0 0\)/);

  // Every cell the admin table renders must carry the label the CSS shows.
  const adminJs = read('public/js/admin.js');
  // Target the mapped resource row specifically — the loading/empty states
  // above it are single-cell colspan rows with no labels by design.
  const rowStart = adminJs.indexOf('<tr>', adminJs.indexOf('resources.map('));
  const rowMarkup = adminJs.slice(rowStart, adminJs.indexOf('</tr>', rowStart));
  const cells = [...rowMarkup.matchAll(/<td(\s[^>]*)?>/g)];
  assert.ok(cells.length >= 10, 'expected the full resource row');
  for (const cell of cells) {
    assert.match(cell[0], /data-label="/, `resource table cell ${cell[0]} needs a data-label for the mobile card view`);
  }
});

test('mobile layout rules let flex and grid children shrink', () => {
  const css = read('public/css/style.css');
  // min-width:auto on flex/grid items is the single most common cause of a
  // page that scrolls sideways on a phone.
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?min-width: 0;/);
  assert.match(css, /overflow-wrap: anywhere;/);
});

test('quiz taking and authoring have real phone styles', () => {
  const css = read('public/css/quiz.css');
  const mobile = css.slice(css.indexOf('@media (max-width: 600px)'));
  assert.match(mobile, /\.quiz-option\s*\{[^}]*min-height: 46px/, 'answer rows need a 44px+ touch target');
  assert.match(mobile, /\.quiz-text-input\s*\{[^}]*font-size: 16px/, '16px inputs stop iOS zooming the page');
  assert.match(mobile, /\.qa-editor-card/, 'the quiz builder needs phone styles too');
});

test('the navbar does not clip its own popovers', () => {
  const css = read('public/css/style.css');
  // The notification panel, the account menu and the course flyouts are all
  // absolutely positioned children of `.navbar`. If the island ever clips its
  // overflow again they get cut to zero height, and pressing the announcement
  // bell looks like it does nothing at all.
  const blocks = [...css.matchAll(/(^|\})\s*([^{}]*\.navbar[^{}]*)\{([^}]*)\}/gm)];
  assert.ok(blocks.length > 0, 'expected to find .navbar rules');

  for (const [, , selector, body] of blocks) {
    if (/::?(before|after)/.test(selector)) continue; // the sheen clips itself, on purpose
    const declarations = body.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(
      declarations,
      /overflow(-x|-y)?\s*:\s*(hidden|clip)/,
      `${selector.trim()} must not clip overflow — it would hide the notification panel`
    );
  }
});

test('the notification panel can actually become visible', () => {
  const css = read('public/css/style.css');
  const openRule = css.slice(css.indexOf('.notif-panel.open'));
  assert.match(openRule, /visibility:\s*visible/);
  assert.match(openRule, /pointer-events:\s*auto/);
  assert.match(openRule, /opacity:\s*1/);
});

// ─────────────────────────────────────────────────────────────────────
// Auth stage (css/auth.css + js/auth-stage.js).
//
// The backdrop behind Log in / Create account / Create admin account. It
// is pure decoration, which is exactly why it needs locking down: the one
// way a background like this does real damage is by getting between a
// student and the form, or by burning a cheap phone's battery.
// ─────────────────────────────────────────────────────────────────────

const AUTH_PAGES = ['public/login.html', 'public/signup.html', 'public/content-admin-signup.html'];

test('every auth screen loads the same shared stage', () => {
  for (const page of AUTH_PAGES) {
    const html = read(page);
    assert.match(html, /<body data-page="auth">/, `${page}: the stage keys off data-page="auth"`);
    assert.match(html, /<link rel="stylesheet" href="\/css\/auth\.css" \/>/, `${page}: stage stylesheet`);
    assert.match(html, /<script src="\/js\/auth-stage\.js" defer><\/script>/, `${page}: stage script, deferred`);

    // One shell wrapping the lockup, the rotating line and the card, so all
    // three move together between the screens.
    assert.match(html, /<div class="auth-shell">/, `${page}: the form column is one object`);
    assert.match(html, /class="auth-mark"/, `${page}: brand lockup`);
    assert.match(html, /data-auth-rotator/, `${page}: rotating study line`);

    // The first line is server-rendered inside the element, so the page
    // reads correctly with JavaScript disabled or still loading.
    const rotator = html.match(/<p\s[\s\S]*?data-auth-rotator[\s\S]*?<\/p>/);
    assert.ok(rotator, `${page}: rotator markup`);
    assert.match(rotator[0], /<span>[^<]+<\/span>/, `${page}: the first line is in the HTML, not injected`);
    const lines = JSON.parse(rotator[0].match(/data-lines='([\s\S]*?)'/)[1]);
    assert.ok(lines.length >= 3, `${page}: enough lines to be worth rotating`);
    assert.ok(lines.includes(rotator[0].match(/<span>([^<]+)<\/span>/)[1]), `${page}: the rendered line is one of the rotation`);
  }
});

test('the auth stage is decoration that can never block the form', () => {
  const css = read('public/css/auth.css');
  const js = read('public/js/auth-stage.js');

  // Inert: no pointer events, no text selection, hidden from assistive tech.
  assert.match(css, /\.auth-stage\s*\{[\s\S]*?pointer-events: none/);
  assert.match(css, /\.auth-stage\s*\{[\s\S]*?user-select: none/);
  assert.match(js, /stage\.setAttribute\('aria-hidden', 'true'\)/);

  // Behind the content, and the content is explicitly above it. The stage
  // sits at z-index:-1, which only stays inside the page because <body> is
  // made a stacking context — without that it paints behind body's own
  // background and disappears entirely.
  assert.match(css, /\.auth-stage\s*\{[\s\S]*?z-index: -1/);
  assert.match(css, /body\[data-page='auth'\]\s*\{[\s\S]*?isolation: isolate/);
  assert.match(css, /body\[data-page='auth'\] main\s*\{[\s\S]*?z-index: 1/);

  // The card must not clip: the focus ring on the first and last field is a
  // box-shadow, and `overflow: hidden` here would shave it off. Comments are
  // stripped first — the note next to the rule quotes the very pattern it is
  // warning against, the same way the grid-track check above has to.
  const cardRule = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .match(/body\[data-page='auth'\] \.auth-card \{[^}]*\}/)[0];
  assert.doesNotMatch(cardRule, /overflow:\s*hidden/, 'clipping the card cuts off the input focus rings');
});

test('the auth stage backs off for slow phones and reduced motion', () => {
  const js = read('public/js/auth-stage.js');
  const css = read('public/css/auth.css');

  // The same data-plan test the hero slideshow uses, plus a memory check.
  assert.match(js, /saveData/);
  assert.match(js, /'slow-2g', '2g'/);
  assert.match(js, /deviceMemory/);
  assert.match(js, /prefers-reduced-motion/);

  // The expensive layers (the sweep and the glyph field) are the ones that
  // get dropped, and the calm stage keeps the gradient + ruling.
  assert.match(js, /if \(!calm\) \{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.auth-beam, \.auth-glyphs \{ display: none/);

  // A backgrounded tab must not keep animating.
  assert.match(js, /visibilitychange/);
  assert.match(css, /\.auth-stage\.is-paused \* \{ animation-play-state: paused; \}/);
});

test('the auth stage only animates compositor-friendly properties', () => {
  const css = read('public/css/auth.css');
  // Anything animating width/height/top/left/background/box-shadow forces
  // layout or paint on every frame — behind a form a student is typing in,
  // that is a stutter they will feel.
  const keyframes = [...css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)\n\}/g)];
  assert.ok(keyframes.length >= 5, 'expected the stage keyframes');
  for (const [block] of keyframes) {
    const properties = [...block.matchAll(/^\s*(?:[\w%,\s.]+\{)?\s*([a-z-]+)\s*:/gm)].map((m) => m[1]);
    for (const property of properties) {
      assert.ok(
        ['transform', 'opacity'].includes(property),
        `auth.css keyframes may only animate transform/opacity, found "${property}"`
      );
    }
  }
});

test('the glyph field is parked outside the form column', () => {
  const js = read('public/js/auth-stage.js');
  // Positions are anchored to the margin beside the 440px column, not to
  // the viewport, so no glyph can drift under the inputs on any width...
  assert.match(js, /const COLUMN_PX = 440/);
  assert.match(js, /\(100vw - \$\{COLUMN_PX \+ COLUMN_GUTTER_PX \* 2\}px\) \/ 2/);
  for (const glyph of js.match(/const GLYPHS = \[([\s\S]*?)\n  \];/)[1].split('\n').filter((l) => l.includes('icon:'))) {
    assert.match(glyph, /side: '(left|right)'/, `each glyph picks a margin: ${glyph.trim()}`);
  }
  // ...and below the width where a margin exists at all, they stand down.
  assert.match(js, /const GLYPH_MIN_WIDTH = 1024/);
  assert.match(js, /if \(hasRoomForGlyphs\(\)\)/);
});

test('moving between the auth screens keeps one continuous background', () => {
  const css = read('public/css/auth.css');
  const js = read('public/js/auth-stage.js');

  // The flat navy is on <html> as well, so it is already painted during the
  // navigation itself — that is what removes the white flash between pages.
  assert.match(js, /document\.documentElement\.style\.backgroundColor/);
  assert.match(css, /body\[data-page='auth'\]\s*\{[\s\S]*?background: #07131f/);

  // Arriving from the other auth screen, the stage appears instantly
  // instead of fading up a second time.
  assert.match(js, /CONTINUITY_KEY/);
  assert.match(css, /\.auth-stage\.is-instant > \* \{ transition: none; \}/);

  // The shared body-level page transition would drag the whole desk with
  // it (and a transform on <body> would re-parent the fixed stage), so on
  // these pages the shell alone animates.
  assert.match(css, /body\[data-page='auth'\]\.sc-page-leave,[\s\S]*?\{\s*animation: none;/);
  assert.match(css, /body\[data-page='auth'\]\.sc-page-leave \.auth-shell/);
  // Chromium's native cross-document view transition needs standing down
  // for the same reason.
  assert.match(css, /::view-transition-old\(root\),[\s\S]*?::view-transition-new\(root\)\s*\{\s*animation: none/);
});

test('the auth stage costs no extra bytes on the wire', () => {
  const js = read('public/js/auth-stage.js');
  const css = read('public/css/auth.css');
  // No images, fonts, or canvas: the whole backdrop is CSS gradients plus
  // inline SVG from the icon system already on the page.
  assert.doesNotMatch(css, /url\((?!["']?data:)/, 'the stage must not fetch any asset');
  assert.doesNotMatch(js, /new Image\(|fetch\(|XMLHttpRequest|createElement\('canvas'\)/);
  // The glyphs come from the one shared icon family, not a second set.
  assert.match(js, /global\.SC\.icon\(g\.icon/);
  assert.match(js, /if \(!global\.SC \|\| typeof global\.SC\.icon !== 'function'\) return null;/);
});

test('the site chrome is re-tinted for the dark auth stage', () => {
  const css = read('public/css/auth.css');
  // The navbar and mobile dock are light glass built for the pale --bg. On
  // the navy desk they need re-tinting or the labels go grey-on-grey. Dark
  // theme already ships correct glass, so the overrides must exclude it.
  for (const selector of ['.navbar', '.mob-tabs', '.nav-item a.nav-link', '.icon-btn']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      css,
      new RegExp(`body\\[data-page='auth'\\]:not\\(\\[data-theme='dark'\\]\\) ${escaped}`),
      `${selector} needs a light-theme re-tint on the dark stage`
    );
  }
});
