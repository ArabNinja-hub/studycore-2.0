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

test('hero section contains decorative animated background logo behind content', () => {
  const indexHtml = read('public/index.html');
  const css = read('public/css/style.css');
  const layout = read('public/js/layout.js');

  // Decorative element in hero background with aria-hidden
  assert.match(indexHtml, /<div class="hero-bg-visual" aria-hidden="true">/);
  assert.match(indexHtml, /hero-floating-logo-stage/);
  assert.match(indexHtml, /hero-floating-logo-track/);
  assert.match(indexHtml, /hero-floating-logo-element/);
  assert.match(indexHtml, /src="\/assets\/studycore-emblem\.png"/);

  // Main StudyCore navbar branding remains intact and not replaced
  assert.match(layout, /<a href="\/" class="nav-brand" aria-label="StudyCore home">/);

  // Asset exists
  assert.equal(fs.existsSync(path.join(ROOT, 'public', 'assets', 'studycore-emblem.png')), true);

  // CSS Z-index layering: background visual is behind container foreground content
  assert.match(css, /\.hero-bg-visual\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.hero-bg-visual\s*\{[^}]*z-index:\s*1/);
  assert.match(css, /\.hero \.container\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.hero \.container\s*\{[^}]*z-index:\s*2/);

  // Entrance and continuous float animations
  assert.match(css, /@keyframes heroLogoEntrance/);
  assert.match(css, /@keyframes heroLogoFloat/);
  assert.match(css, /animation:\s*heroLogoEntrance/);
  assert.match(css, /animation:\s*heroLogoFloat/);

  // Mobile scaling and repositioning
  assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*?\.hero-floating-logo-stage/);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*?\.hero-floating-logo-stage/);

  // Prefers-reduced-motion accessibility
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.hero-floating-logo-track/);
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
