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
  // Home IS a top-level destination now — the brief fixes the bar at
  // Home | Courses | Past Papers | Resources | Dashboard | Profile.
  assert.match(navBlock, /label: 'Home'/);
  // Videos and quizzes stay inside a course / behind Resources, never as
  // their own top-level destination.
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

test('homepage is course-first and never ships the obsolete subject cards', () => {
  const indexHtml = read('public/index.html');
  const homeJs = read('public/js/home.js');
  const componentsJs = read('public/js/components.js');
  const revealJs = read('public/js/scroll-reveal.js');

  // The homepage renders its cards through the shared component library and
  // the student's real programme, so it can never fall back to the six
  // hardcoded legacy subject cards again.
  assert.match(indexHtml, /id="homeCatalog"/);
  assert.match(indexHtml, /\/js\/components\.js/);
  assert.match(indexHtml, /\/js\/home\.js/);
  assert.match(homeJs, /StudyCoreAPI\.myProgram\(\)/);
  assert.match(homeJs, /SCUi\.courseCard\(/);
  assert.match(homeJs, /\/api\/universities\?courses=1/);
  assert.doesNotMatch(indexHtml, /data-course="(mathematics|physics|chemistry|biology|programming|communication)"/);
  assert.doesNotMatch(homeJs, /\/pages\/subjects\//);
  assert.match(componentsJs, /function courseCard\(/);
  assert.match(revealJs, /closest\('\[data-no-scroll-reveal\]'\)/);

  // No duplicated ids on the homepage.
  const ids = [...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate HTML id on the homepage');
});

test('homepage hero states the platform promise and offers the three core CTAs', () => {
  const indexHtml = read('public/index.html');
  const css = read('public/css/style.css');
  const layout = read('public/js/layout.js');

  // The headline the platform is built around.
  assert.match(indexHtml, /Your University\./);
  assert.match(indexHtml, /Your Courses\./);
  assert.match(indexHtml, /<em>Your Success\.<\/em>/);
  assert.match(indexHtml, /<title>StudyCore — Your University\. Your Courses\. Your Success\.<\/title>/);

  // The three required actions, each pointing somewhere real.
  assert.match(indexHtml, /href="\/pages\/courses\.html"[^>]*>[\s\S]{0,120}Explore Courses/);
  assert.match(indexHtml, /href="\/pages\/past-papers\.html"[^>]*>[\s\S]{0,120}Browse Past Papers/);
  assert.match(indexHtml, /id="heroStartCta" href="\/signup\.html"/);

  // Past papers are a headline feature on the homepage, not a footer link.
  assert.match(indexHtml, /id="homePapers"/);

  // No emoji anywhere in the markup or the shared components.
  assert.doesNotMatch(indexHtml, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  assert.doesNotMatch(read('public/js/components.js'), /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);

  // No autoplaying video background: the hero is CSS only.
  assert.doesNotMatch(indexHtml, /<video/i);
  assert.doesNotMatch(indexHtml, /<iframe/i);

  // Main StudyCore navbar branding remains intact and not replaced.
  assert.match(layout, /<a href="\/" class="nav-brand" aria-label="StudyCore home">/);

  // Hero styling is layered behind the content and honours reduced motion.
  assert.match(css, /\.sc-hero::before\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.sc-hero-inner\s*\{[^}]*position:\s*relative/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test('global navigation follows the course-first model', () => {
  const layout = read('public/js/layout.js');
  // Scope strictly to the NAV_LINKS array — a slice that ran to
  // `function currentPage()` would also swallow BNAV_LINKS below it.
  const navBlock = layout.match(/const NAV_LINKS = \[(.*?)\n  \];/s)?.[1] || '';
  assert.ok(navBlock.length > 0, 'NAV_LINKS array was located');

  // The brief fixes the bar at exactly six destinations:
  //   Home | Courses | Past Papers | Resources | Dashboard | Profile
  // The first four are declared statically; Dashboard and Profile are injected
  // by renderNavAuth() once the session resolves (which also hides Profile for
  // admins). Declaring them in NAV_LINKS as well would show them to signed-out
  // visitors and render them twice for students.
  for (const [id, href] of [
    ['home', '/'],
    ['courses', '/pages/courses.html'],
    ['past-papers', '/pages/past-papers.html'],
    ['resources', '/pages/resources.html']
  ]) {
    assert.match(navBlock, new RegExp(`id: '${id}'[^}]*href: '${href.replace(/\//g, '\\/')}'`), `${id} is in the main navigation`);
  }

  // NAV_LINKS must hold ONLY those four — nothing else crowds the bar.
  const navIds = [...navBlock.matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(navIds, ['home', 'courses', 'past-papers', 'resources'],
    `NAV_LINKS holds exactly the four public destinations (got: ${navIds.join(', ')})`);

  // Announcements and About moved to the footer; they are still reachable.
  assert.doesNotMatch(navBlock, /id: 'announcements'/, 'announcements is not a top-level destination');
  assert.doesNotMatch(navBlock, /id: 'about'/, 'about is not a top-level destination');
  assert.match(layout, /\/pages\/announcements\.html/, 'announcements still reachable');
  assert.match(layout, /\/pages\/about\.html/, 'about still reachable');

  // Quizzes stay reachable (nothing is removed) but no longer compete with
  // Courses as a top-level destination.
  assert.doesNotMatch(navBlock, /\/quiz\.html/);
  assert.match(layout, /href: '\/quiz\.html'/, 'quizzes remain reachable from Resources');

  // Search, Dashboard and Profile are in the bar for signed-in users.
  assert.match(layout, /id="navSearchBtn"/);
  assert.match(layout, /nav-link-account/);
  assert.match(layout, /\$\{dashboard\}#profile/);
  assert.doesNotMatch(navBlock, /id: 'dashboard'/, 'dashboard is injected by renderNavAuth, not declared here');

  // Mobile gets a persistent bottom navigation with five destinations.
  assert.match(layout, /const BNAV_LINKS = \[/);
  // The bar is created imperatively, so the class lands on `className`, not in
  // a class="" attribute string.
  assert.match(layout, /className = 'sc-bnav'/);
  assert.match(layout, /class="sc-bnav-inner"/);
  assert.equal(occurrences(layout, /id: 'home', label: 'Home', href: '\/'/g) >= 1, true);

  // The obsolete per-page dock markup is gone from the stylesheet.
  assert.doesNotMatch(read('public/css/style.css'), /\.mob-dock\s*\{/);
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
