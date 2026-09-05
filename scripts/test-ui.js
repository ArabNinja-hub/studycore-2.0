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

test('marketing pages answer buying questions with the shared FAQ component', () => {
  const css = read('public/css/style.css');
  const home = read('public/index.html');
  const pricing = read('public/pages/pricing.html');

  // One FAQ component, styled from the shared tokens, driven by native
  // <details> so it works with the keyboard and with JavaScript disabled.
  assert.match(css, /\.faq-list \{/);
  assert.match(css, /\.faq-item > summary \{/);
  assert.match(css, /\.faq-item\[open\] \.faq-mark \{/);

  for (const [name, html] of [['home', home], ['pricing', pricing]]) {
    const items = occurrences(html, /<details class="faq-item">/g);
    assert.ok(items >= 5, `${name}: expected a real FAQ, found ${items} entries`);
    assert.equal(items, occurrences(html, /<\/details>/g), `${name}: every FAQ entry closes`);
    assert.equal(items, occurrences(html, /class="faq-mark"/g), `${name}: every FAQ entry has its marker`);
    assert.equal(items, occurrences(html, /<div class="faq-answer">/g), `${name}: every FAQ entry has an answer`);
    // Visible answers must also be exposed to search engines as FAQPage data.
    assert.match(html, /"@type": "FAQPage"/, `${name}: FAQ structured data`);
  }

  // Structured data has to stay parseable, not just present.
  for (const [name, html] of [['home', home], ['pricing', pricing]]) {
    for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => JSON.parse(block[1]), `${name}: JSON-LD parses`);
    }
  }
});

test('call-to-action banners use the shared class instead of inline styling', () => {
  const css = read('public/css/style.css');
  const home = read('public/index.html');

  assert.match(css, /\.cta-banner \{/);
  assert.match(css, /\.cta-banner-center \{/);
  assert.match(css, /\.trust-row \{/);
  assert.match(css, /\.hero \.trust-item \{/);

  assert.ok(occurrences(home, /class="cta-banner/g) >= 2, 'home reuses the banner component');
  // The old hand-rolled gradient panel must not come back.
  assert.doesNotMatch(home, /style="background:linear-gradient\(135deg,#0e7568/);

  // Signed-in students are never shown trial-only reassurance or a
  // "create account" closing CTA.
  assert.match(home, /id="homeTrustRow"/);
  assert.match(home, /if \(trustRow\) trustRow\.remove\(\);/);
  assert.match(home, /id="homeClosingCta"/);

  const ids = [...home.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'home page ids stay unique');
});
