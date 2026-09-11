'use strict';

// Regression tests for the content privacy guard (public/js/privacy-guard.js,
// public/css/privacy-guard.css and the display-capture Permissions-Policy).
//
// Two things are being protected here:
//   1. The protection is ACTUALLY ON the learning pages, and actually OFF the
//      marketing/auth/admin pages. A future page added to the site without
//      the guard is the realistic way this silently regresses.
//   2. The guard does not break ordinary use — typing in the reader's search
//      box, and every non-protected page keeping normal copy/paste.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// Learning content: everything a student reads or watches.
const PROTECTED_PAGES = [
  'public/pages/lesson.html',
  'public/pages/videos.html',
  'public/pages/courses.html',
  'public/pages/resources.html',
  'public/pages/search.html',
  'views/viewer.html',
  'views/course.html',
  ...fs.readdirSync(path.join(ROOT, 'public', 'pages', 'subjects'))
    .filter((name) => name.endsWith('.html'))
    .map((name) => `public/pages/subjects/${name}`)
];

// Publishers need normal copy/paste to do their job, and the marketing site
// must stay ordinary (and indexable).
const UNPROTECTED_PAGES = [
  'public/index.html',
  'public/login.html',
  'public/signup.html',
  'public/content-admin-signup.html',
  'public/404.html',
  'public/pages/about.html',
  'public/pages/pricing.html',
  'public/pages/privacy.html',
  'public/pages/terms.html',
  'public/pages/announcements.html',
  'views/admin.html',
  'views/content-admin.html',
  'views/dashboard.html',
  'views/quiz.html'
];

test('every learning page loads the privacy guard, and loads it in the right order', () => {
  for (const page of PROTECTED_PAGES) {
    const html = read(page);
    assert.match(html, /<link rel="stylesheet" href="\/css\/privacy-guard\.css" \/>/, `${page}: guard stylesheet`);
    assert.match(html, /<script src="\/js\/privacy-guard\.js"><\/script>/, `${page}: guard script`);

    // The stylesheet must be in <head>: the print blackout and the selection
    // lock have to be in force before first paint, otherwise there is a
    // window in which the content is copyable.
    const headEnd = html.indexOf('</head>');
    assert.ok(headEnd > 0 && html.indexOf('/css/privacy-guard.css') < headEnd, `${page}: guard css belongs in <head>`);

    // It must come before the scripts that build the player and the document
    // reader so their surfaces are tagged as they appear.
    const guardAt = html.indexOf('/js/privacy-guard.js');
    assert.ok(guardAt > 0, `${page}: guard loads`);

    for (const later of ['/js/player.js', '/js/doc-reader.js', '/js/lesson.js', '/js/viewer.js']) {
      const at = html.indexOf(later);
      if (at > 0) assert.ok(guardAt < at, `${page}: guard loads before ${later}`);
    }
  }
});

test('marketing, auth and publisher pages are deliberately left alone', () => {
  for (const page of UNPROTECTED_PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /privacy-guard/, `${page}: must keep normal copy/paste and printing`);
  }
});

test('the guard only arms itself on learning pages', () => {
  const js = read('public/js/privacy-guard.js');
  // Every protected page's data-page value must appear in the policy map,
  // and the guard must bail out early on anything else.
  for (const key of ['lesson', 'viewer', 'course', 'videos', 'courses', 'resources', 'search']) {
    assert.match(js, new RegExp(`\\b${key}:\\s*'(strict|basic)'`), `policy entry for ${key}`);
  }
  assert.match(js, /if \(!policy\) return;/, 'unprotected pages exit before any listener is bound');

  // data-page values used by the pages must match the policy map keys.
  for (const page of PROTECTED_PAGES) {
    const html = read(page);
    const match = html.match(/<body data-page="([^"]+)"/);
    assert.ok(match, `${page}: has a data-page`);
    assert.match(js, new RegExp(`\\b${match[1]}:\\s*'(strict|basic)'`), `${page}: data-page="${match[1]}" is in the policy map`);
  }
});

test('the reader and player surfaces are the ones tagged for the scoped guards', () => {
  const js = read('public/js/privacy-guard.js');
  // These selectors must keep matching the real markup the player and reader
  // build, otherwise the scoped capture guards silently stop applying.
  assert.match(js, /'\.player-shell'/);
  assert.match(js, /'\.doc-reader-stage'/);

  const player = read('public/js/player.js');
  const reader = read('public/js/doc-reader.js');
  assert.match(player, /class="player-shell"/, 'player still builds .player-shell');
  assert.match(player, /class="player-shell stream-shell"/, 'Stream player still builds .player-shell');
  assert.match(reader, /class="doc-reader-stage"/, 'reader still builds .doc-reader-stage');

  // In embedded (lesson) mode the reader nests .doc-reader-stage INSIDE the
  // .doc-reader card. Tagging both would mark that page twice.
  const cardAt = reader.indexOf('class="card doc-reader"');
  const stageAt = reader.indexOf('class="doc-reader-stage"');
  assert.ok(cardAt > 0 && stageAt > cardAt, 'the reader still nests the stage inside the card');
  assert.doesNotMatch(js, /'\.doc-reader'/, 'the wrapping card must not be a tagged surface too');
  assert.match(js, /parentElement\.closest\('\.sc-protected-surface'\)/, 'nested surfaces are skipped at runtime');
});

test('typing still works: inputs are exempt from the selection and copy locks', () => {
  const js = read('public/js/privacy-guard.js');
  const css = read('public/css/privacy-guard.css');

  // The document reader has a real search field (#scDocSearchInput) and the
  // site has a global search overlay. Locking those would break study.
  assert.match(js, /function isEditable/);
  assert.match(js, /tag === 'INPUT' \|\| tag === 'TEXTAREA' \|\| tag === 'SELECT' \|\| el\.isContentEditable/);
  assert.match(css, /body\[data-sc-privacy\] input,/);
  assert.match(css, /user-select: text;/);

  // Each blocking listener must consult isEditable before preventing.
  for (const handler of ['contextmenu', 'selectstart', 'dragstart']) {
    const at = js.indexOf(`'${handler}'`);
    assert.ok(at > 0, `${handler} handler exists`);
    const window = js.slice(at, at + 260);
    assert.match(window, /isEditable\(e\.target\)/, `${handler} respects form fields`);
  }
});

test('printing and "Save as PDF" are blanked', () => {
  const css = read('public/css/privacy-guard.css');
  assert.match(css, /@media print/);
  assert.match(css, /body\[data-sc-privacy\] > \* \{\s*display: none !important;/);
  assert.match(read('public/js/privacy-guard.js'), /global\.print = function blockedPrint/);
});

test('display-capture and picture-in-picture are blocked by the Permissions-Policy header', () => {
  const security = read('middleware/security.js');
  assert.match(security, /display-capture=\(\)/, 'no script in the page may record the tab');
  // PiP floats the video in an OS window no in-page guard can cover, and the
  // header (unlike the <video> attribute) also reaches the cross-origin
  // Cloudflare Stream iframe's own PiP button.
  assert.match(security, /picture-in-picture=\(\)/, 'PiP is a hole straight through the in-page guards');
  // Fullscreen must survive: fullscreen watching and fullscreen document
  // reading are core features.
  assert.ok(security.includes('fullscreen=(self)'), 'fullscreen stays available');
  // The existing hardening must survive the edit.
  for (const directive of ['geolocation=()', 'microphone=()', 'camera=()']) {
    assert.ok(security.includes(directive), `kept ${directive}`);
  }
});

test('the in-page routes that copy the content itself are closed on protected surfaces only', () => {
  const js = read('public/js/privacy-guard.js');

  // The reader renders every PDF page to a <canvas>, so toDataURL() in the
  // console is a full-resolution copy of the page being read, and
  // captureStream() feeds a MediaRecorder without any permission prompt.
  assert.match(js, /toDataURL/, 'canvas image extraction is guarded');
  assert.match(js, /captureStream/, 'canvas/media recording is guarded');
  assert.match(js, /insideProtectedContent/, 'the guard is scoped, not global');

  // Scoping matters: a chart, an avatar cropper or anything added later must
  // keep working. The guard checks the element is inside a protected surface
  // before refusing, and calls through otherwise.
  assert.match(js, /if \(!insideProtectedContent\(this\)\) return original\.apply\(this, args\)/);

  // Picture-in-picture is closed in JS as well as in the header, including
  // the browsers that open it automatically when a tab is hidden.
  assert.match(js, /requestPictureInPicture/);
  assert.match(js, /enterpictureinpicture/);
});

test('the browser is never handed a permanent URL for protected bytes', () => {
  // Documents and videos load through a short-lived, account-bound ticket
  // rather than the permanent /stream path.
  const api = read('public/js/api.js');
  assert.match(api, /protectedUrl/, 'the API layer can mint a ticketed URL');
  assert.match(api, /\/ticket`/, 'it calls the server-side ticket endpoint');

  for (const [file, label] of [['public/js/viewer.js', 'document viewer'], ['public/js/lesson.js', 'lesson page'], ['public/js/player.js', 'video player']]) {
    assert.match(read(file), /protectedUrl/, `${label} uses the ticketed URL`);
  }

  // Every consumer must degrade to the session-gated URL rather than failing:
  // the server is the authority either way, and a ticket hiccup must never
  // stop a paying student opening their lesson.
  assert.match(api, /return fallback;/, 'a failed mint falls back to the session-gated URL');

  // And the server must actually check it — after, never instead of, the real
  // authorization.
  const route = read('routes/resources.routes.js');
  assert.match(route, /verifyTicket\(presented, \{ resourceId: row\.id, userId: req\.user\.id \}\)/);
  const gateAt = route.indexOf('if (!canAccess(row, req.access)) return lockedResponse');
  const ticketAt = route.indexOf('const presented = req.query && req.query.t;');
  assert.ok(gateAt > 0 && ticketAt > gateAt, 'the ticket check runs AFTER the program/Premium gates');
});

test('there is no download route or download UI for protected resources', () => {
  const route = read('routes/resources.routes.js');
  // The old download URL stays present as an explicit refusal, so a saved
  // link cannot quietly bypass the reader.
  assert.match(route, /router\.get\('\/:id\/download'/);
  assert.match(route, /Downloads are disabled/);

  // No download control anywhere in the student-facing reader or player.
  for (const file of ['public/js/doc-reader.js', 'public/js/viewer.js', 'public/js/player.js', 'views/viewer.html', 'public/pages/lesson.html']) {
    const src = read(file);
    const offenders = src.split('\n').filter((line) => /download/i.test(line)
      && !/nodownload/i.test(line)
      && !/download_count|downloadCount/i.test(line)
      && !/^\s*(\/\/|\*|<!--)/.test(line.trim()));
    assert.deepEqual(offenders, [], `${file} exposes a download control`);
  }

  // The native <video> download/remote-playback/PiP controls are off too.
  const player = read('public/js/player.js');
  assert.match(player, /controlslist="nodownload noremoteplayback noplaybackrate"/);
  assert.match(player, /disablepictureinpicture disableremoteplayback/);
  // ...and the Cloudflare Stream iframe must not be granted PiP either.
  assert.doesNotMatch(player, /allow="[^"]*picture-in-picture/, 'the Stream iframe must not be allowed PiP');
});

// ── Behavioural checks ─────────────────────
// Run the guard against a minimal DOM to prove the wiring works, rather than
// only asserting on its source text.
function runGuard({ page }) {
  const listeners = new Map();
  const body = {
    dataset: { page },
    appendChild() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    classList: { contains: () => false, add() {}, remove() {} }
  };
  const doc = {
    body,
    readyState: 'complete',
    hidden: false,
    activeElement: null,
    fullscreenElement: null,
    hasFocus: () => true,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({
      className: '', style: {}, dataset: {}, innerHTML: '', textContent: '',
      setAttribute() {}, appendChild() {}, querySelector: () => null,
      classList: { add() {}, remove() {} }, remove() {}
    })
  };

  const win = {
    document: doc,
    navigator: { mediaDevices: {}, clipboard: { writeText: () => Promise.resolve() } },
    matchMedia: () => ({ matches: false }),
    outerWidth: 1440, innerWidth: 1440, outerHeight: 900, innerHeight: 820,
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame() {}, getComputedStyle: () => ({ position: 'relative' }),
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    MutationObserver: class { observe() {} disconnect() {} },
    DOMException: class extends Error {},
    Promise,
    print() { throw new Error('the real print must be replaced'); },
    toasts: []
  };
  win.window = win;
  win.showToast = (message) => win.toasts.push(message);

  const context = vm.createContext(win);
  vm.runInContext(read('public/js/privacy-guard.js'), context);
  return { win, listeners, fire(type, event) { (listeners.get(type) || []).forEach((fn) => fn(event)); } };
}

function fakeEvent(props) {
  return Object.assign({
    prevented: false,
    preventDefault() { this.prevented = true; },
    target: { nodeType: 1, tagName: 'DIV', isContentEditable: false }
  }, props);
}

test('on a lesson page the guard blocks copy routes and scrubs the clipboard', () => {
  const { win, fire } = runGuard({ page: 'lesson' });
  assert.equal(win.SCPrivacy.policy, 'strict');

  const menu = fakeEvent({});
  fire('contextmenu', menu);
  assert.equal(menu.prevented, true, 'right-click is blocked');

  let copied = null;
  const copy = fakeEvent({ clipboardData: { setData: (_t, v) => { copied = v; } } });
  fire('copy', copy);
  assert.equal(copy.prevented, true, 'copy is blocked');
  assert.match(copied, /protected content/i, 'the clipboard gets a notice, not the lesson');

  const drag = fakeEvent({});
  fire('dragstart', drag);
  assert.equal(drag.prevented, true, 'drag-out is blocked');

  // window.print must have been replaced with the no-op.
  assert.doesNotThrow(() => win.print(), 'window.print() no longer opens a dialog');
});

test('typing into the document search box is never intercepted', () => {
  const { fire } = runGuard({ page: 'viewer' });
  const inInput = { nodeType: 1, tagName: 'INPUT', isContentEditable: false };

  for (const type of ['contextmenu', 'copy', 'selectstart', 'dragstart']) {
    const event = fakeEvent({ target: inInput, clipboardData: { setData() {} } });
    fire(type, event);
    assert.equal(event.prevented, false, `${type} stays available inside a form field`);
  }

  // Ctrl+A inside a field must still select that field's text.
  const selectAll = fakeEvent({ key: 'a', ctrlKey: true, target: inInput });
  fire('keydown', selectAll);
  assert.equal(selectAll.prevented, false, 'Ctrl+A works inside an input');
});

test('save, print and devtools shortcuts are intercepted on protected pages', () => {
  const { fire } = runGuard({ page: 'lesson' });
  const combos = [
    { key: 's', ctrlKey: true },
    { key: 'p', ctrlKey: true },
    { key: 'u', ctrlKey: true },
    { key: 'F12' },
    { key: 'i', ctrlKey: true, shiftKey: true }
  ];
  for (const combo of combos) {
    const event = fakeEvent(combo);
    fire('keydown', event);
    assert.equal(event.prevented, true, `blocked ${JSON.stringify(combo)}`);
  }
});

test('the page cannot record itself with getDisplayMedia', async () => {
  const { win } = runGuard({ page: 'lesson' });
  await assert.rejects(
    () => win.navigator.mediaDevices.getDisplayMedia(),
    /disabled/i,
    'getDisplayMedia is refused in-page as well as by the header'
  );
});

test('listing pages get the deterrents without the in-page guards', () => {
  const { win, fire } = runGuard({ page: 'resources' });
  assert.equal(win.SCPrivacy.policy, 'basic');

  const menu = fakeEvent({});
  fire('contextmenu', menu);
  assert.equal(menu.prevented, true, 'right-click is still blocked on a listing page');
});

test('unprotected pages are untouched: no listeners, no patched print', () => {
  const { win, listeners } = runGuard({ page: 'dashboard' });
  // The guard returns before it binds anything at all, so an admin's
  // dashboard behaves exactly as it did before this feature existed.
  assert.equal(win.SCPrivacy, undefined, 'guard leaves no footprint whatsoever');
  assert.equal(listeners.size, 0, 'not a single document listener is bound');
  assert.throws(() => win.print(), 'window.print() is left alone');
  assert.equal(win.document.body.dataset.scPrivacy, undefined, 'no privacy attribute, so the CSS never applies');
  assert.equal(typeof win.navigator.mediaDevices.getDisplayMedia, 'undefined', 'screen sharing is not touched off protected pages');
});
