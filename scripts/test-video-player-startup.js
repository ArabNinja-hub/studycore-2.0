'use strict';

// Regression tests for: "The video player is still preparing video often."
//
// The progressive player used to serialize THREE network round trips in front
// of the <video> element before the browser was allowed to request a single
// byte of the file:
//
//   1. mint a viewing ticket   (/api/resources/:id/ticket)
//   2. HEAD probe the stream   (which itself makes the server hit R2)
//   3. await the resume position (/api/resources/:id/video-progress)
//
// Only then was `video.src` assigned. The "Preparing video…" overlay was shown
// unconditionally for that whole handshake, so on any normal connection it was
// the first — and longest — thing a student saw, on every lesson, every time.
// The spinner was also re-shown after only 400 ms of buffering, which made it
// flash during ordinary seeks.
//
// These tests pin the new behaviour at the source level (the player is browser
// code with no DOM available in `node --test`):
//
//   · the stream is attached without a blocking HEAD probe
//   · the resume fetch runs in parallel and is applied by applyResume()
//   · the overlay is delayed, not immediate, and every path that reveals it
//     goes through the debounced helper
//   · failures are still diagnosed precisely (401 / 403 / 404 / 503)

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const playerPath = path.join(__dirname, '..', 'public', 'js', 'player.js');
const src = fs.readFileSync(playerPath, 'utf8');

// The progressive player lives above the Cloudflare Stream player; slice it so
// assertions about `attachStream` cannot accidentally match Stream-only code.
const progressive = src.slice(0, src.indexOf('function initStream('));

test('the video element is attached without waiting on a HEAD probe', () => {
  const attach = progressive.slice(
    progressive.indexOf('async function attachStream()'),
    progressive.indexOf('function showStreamError(')
  );
  assert.ok(attach.length > 0, 'attachStream still exists');
  assert.doesNotMatch(attach, /await\s+probeStream\(/,
    'attachStream must not block the <video> src on a HEAD probe');
  assert.match(attach, /video\.src\s*=\s*streamUrl/, 'attachStream still assigns the stream URL');
});

test('the probe survives, but only as a failure diagnosis', () => {
  assert.match(progressive, /async function diagnoseFailure\(/,
    'failures are still explained precisely rather than generically');
  const diag = progressive.slice(
    progressive.indexOf('async function diagnoseFailure('),
    progressive.indexOf('async function attachStream()')
  );
  assert.match(diag, /await\s+probeStream\(/, 'the diagnosis is what probes now');
  // Every student-facing reason the old inline probe produced must survive.
  assert.match(diag, /status === 401/, 'expired session still reported');
  assert.match(diag, /status === 403/, 'lapsed subscription still swaps in the lock wall');
  assert.match(diag, /renderLock\(/);
  assert.match(diag, /status === 404/, 'missing file still reported');
  assert.match(diag, /status === 503/, 'unconfigured storage still reported');
});

test('a media error asks the server why instead of guessing', () => {
  const onError = progressive.slice(progressive.indexOf("video.addEventListener('error'"));
  assert.match(onError.slice(0, 1400), /diagnoseFailure\(/,
    'the error handler refines its message with the server response');
});

test('the resume position is fetched in parallel, not awaited before playback', () => {
  const attach = progressive.slice(
    progressive.indexOf('async function attachStream()'),
    progressive.indexOf('function showStreamError(')
  );
  assert.doesNotMatch(attach, /await\s+resumeReady/,
    'attachStream must not block the <video> src on the progress endpoint');
  assert.match(progressive, /function applyResume\(\)/,
    'the seek is applied by whichever of metadata / progress finishes last');
  // applyResume must be reachable from BOTH sides of that race.
  const fromProgress = progressive.slice(
    progressive.indexOf('StudyCoreAPI.getVideoProgress(resourceId)'),
    progressive.indexOf('function setPlayIcon(')
  );
  assert.match(fromProgress, /applyResume\(\)/, 'the progress fetch applies the seek when it wins');
  const onMeta = progressive.slice(progressive.indexOf("video.addEventListener('loadedmetadata'"));
  assert.match(onMeta.slice(0, 700), /applyResume\(\)/, 'metadata applies the seek when it wins');
  // …and it must only ever fire once, and never yank a student who already
  // started watching back to the stored position.
  assert.match(progressive, /if \(resumeApplied[\s\S]{0,120}return;/,
    'applyResume runs at most once');
});

test('the "Preparing video…" overlay is delayed, never shown eagerly', () => {
  assert.match(progressive, /function showLoading\(/, 'a debounced show helper exists');
  assert.match(progressive, /function hideLoading\(/, 'a matching hide helper exists');
  assert.match(progressive, /const SPINNER_DELAY = (\d+);/, 'the delay is a named constant');
  const delay = Number(/const SPINNER_DELAY = (\d+);/.exec(progressive)[1]);
  assert.ok(delay >= 300 && delay <= 1000,
    `SPINNER_DELAY should absorb a fast start without feeling frozen (got ${delay})`);

  // Nothing outside the two helpers may reveal the overlay directly — that is
  // exactly how it crept back into being the default state before.
  const reveals = progressive.match(/loading\.hidden\s*=\s*false/g) || [];
  assert.equal(reveals.length, 2,
    'only showLoading() and the buffering debounce may reveal the overlay');

  // The startup path in particular must go through the helper.
  const start = progressive.slice(progressive.lastIndexOf('setPlayIcon(false);') - 200);
  assert.match(start.slice(0, 400), /showLoading\(\);/,
    'startup arms the delayed spinner rather than painting it immediately');
});

test('brief rebuffering and in-buffer seeks do not flash the overlay', () => {
  const waiting = progressive.slice(
    progressive.indexOf("video.addEventListener('waiting'"),
    progressive.indexOf("video.addEventListener('timeupdate'")
  );
  const debounce = Number(/}, (\d+)\);/.exec(waiting)[1]);
  assert.ok(debounce >= 1000,
    `a stall must last at least a second before the spinner appears (got ${debounce}ms)`);
  assert.match(waiting, /readyState < 3/,
    'the spinner is suppressed when enough data is already buffered');
  assert.match(waiting, /seeked/, "a completed seek stands down the spinner armed by 'waiting'");
});

test('teardown clears the spinner and resume timers', () => {
  const destroy = progressive.slice(progressive.lastIndexOf('destroy() {'));
  for (const timer of ['spinnerTimer', 'resumeTimer', 'bufferTimer']) {
    assert.match(destroy, new RegExp(`clearTimeout\\(${timer}\\)`),
      `destroy() clears ${timer}`);
  }
});

test('the player preloads eagerly so the first frame is ready sooner', () => {
  assert.match(progressive, /preload="auto"/,
    'metadata-only preloading left the player fetching after the gesture');
});

test('skip forward and seek bar guard against NaN duration and zero rect', () => {
  assert.match(progressive, /const dur = Number\.isFinite\(video\.duration\)/,
    'skip forward checks duration finiteness before clamping');
  assert.match(progressive, /if \(!rect\.width \|\| rect\.width <= 0\) return;/,
    'seekFromEvent guards against zero or invalid width');
  assert.match(src, /function escapeHtml\(/,
    'player.js provides its own escapeHtml helper');
});

test('Cloudflare Stream player resolves duration asynchronously and calls onEnded', () => {
  const streamCode = src.slice(src.indexOf('function initStream('));
  assert.match(streamCode, /Promise\.resolve\(player\.duration\)/,
    'initStream resolves player.duration as a Promise');
  assert.match(streamCode, /typeof o\.onEnded === 'function'/,
    'initStream invokes onEnded when video ends');
});
