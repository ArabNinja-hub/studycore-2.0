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
  const targets = ['topics', 'video-lessons', 'lessons', 'resources', 'past-papers', 'progress'];

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

test('course homes do not render the shared search controls', () => {
  const layout = read('public/js/layout.js');
  const courseCss = read('public/css/course.css');

  assert.match(layout, /function globalSearchEnabled\(\)/);
  assert.match(layout, /return currentPage\(\) !== 'course'/);
  assert.match(layout, /const searchButtonHtml = globalSearchEnabled\(\)/);
  assert.match(layout, /const mobileSearchHtml = globalSearchEnabled\(\)/);
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

test('global navigation keeps videos within the course hierarchy', () => {
  const layout = read('public/js/layout.js');
  const navBlock = layout.match(/const NAV_LINKS = \[(.*?)\n  \];/s)?.[1] || '';
  assert.match(navBlock, /label: 'Courses'/);
  assert.match(navBlock, /label: 'Resources'/);
  assert.doesNotMatch(navBlock, /label: 'Home'/);
  assert.doesNotMatch(navBlock, /label: 'Video Lessons'/);
  assert.doesNotMatch(layout.match(/function renderMobileNav\(\).*?\n  }/s)?.[0] || '', /> Video Lessons</);
});

test('mobile course controls and drawer styles are present', () => {
  const css = read('public/css/style.css');
  assert.match(css, /\.mobile-nav\.open \{ transform: translateX\(0\)/);
  assert.match(css, /body\[data-page='course'\] \.course-subnav \.subnav-links \{ display: none; \}/);
  assert.match(css, /\.course-jump \{ display: flex;/);
  assert.match(css, /body\[data-page='courses'\] \.course-card/);
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
