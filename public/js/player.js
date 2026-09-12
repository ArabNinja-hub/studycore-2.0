// =============================================
// STUDYCORE — Video Player (js/player.js)
// -----------------------------------------------
// A custom in-platform player: students watch
// StudyCore videos inside StudyCore, never
// redirected to external platforms.
//
//   · Play/pause, seeking, volume, fullscreen,
//     playback speed
//   · Resume position (server-stored, Premium
//     sessions only)
//   · Progress reporting every 5s + on pause;
//     90% watched auto-completes the lesson
//     server-side
//   · Loading and error states, mobile controls
//   · Deliberately NO download, share or
//     external-link controls - the stream URL
//     is only ever reachable through the
//     authorized /api/resources/:id/stream
//     endpoint.
// =============================================

(function (global) {
  'use strict';

  function escapeHtml(s) {
    if (typeof global.escapeHtml === 'function') return global.escapeHtml(s);
    return String(s == null ? '' : s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function fmtTime(s) {
    if (!Number.isFinite(s)) return '0:00';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

  function init(container, opts) {
    const o = opts || {};
    const resourceId = o.resourceId;
    const premium = Boolean(o.premium);

    // Premium-only gate (server enforces it too - this is presentation).
    if (!premium) {
      renderLock(container, o);
      return { destroy() {} };
    }

    // Cloudflare Stream-backed lessons use Cloudflare's adaptive-bitrate
    // player, which ships a native quality selector (Auto / 1080p / 720p / …)
    // and picks the best rendition for the viewer automatically. StudyCore
    // still owns resume position, progress reporting and 90%-completion via
    // the Stream Player SDK. Falls through to the progressive player below
    // when the lesson has no Stream video.
    if (o.streamPlayback && o.streamPlayback.iframe) {
      return initStream(container, o);
    }

    /* ── Build the player shell ───────────── */
    container.innerHTML = `
      <div class="player-shell" id="scPlayerShell">
        <!-- playsinline + webkit-playsinline stop iOS from hijacking playback
             into its own native fullscreen player the moment it starts, which
             would take the student out of StudyCore. x5-playsinline covers
             the Chinese Android browser engines that ignore the standard
             attribute. -->
        <video id="scPlayerVideo" preload="auto" playsinline webkit-playsinline
               x5-playsinline="true" x-webkit-airplay="deny"
               controlslist="nodownload noremoteplayback noplaybackrate"
               disablepictureinpicture disableremoteplayback></video>
        <div class="player-title">${SC.icon('video', { size: 17 })}<span>${escapeHtml(o.title || 'Video lesson')}</span></div>
        <div class="player-state" id="scPlayerLoading" hidden>
          <div class="player-spinner"></div>
          <p>Preparing video…</p>
        </div>
        <div class="player-state" id="scPlayerError" hidden>
          ${SC.icon('alert-triangle', { size: 40 })}
          <h3>Video unavailable</h3>
          <p id="scPlayerErrorMsg">This video could not be loaded. Check your connection and try again.</p>
          <button class="btn btn-teal btn-sm" id="scPlayerRetry">${SC.icon('refresh', { size: 15 })} Try again</button>
        </div>
        <div class="player-ui" id="scPlayerUi">
          <div class="player-center" id="scPlayerCenter">
            <button class="player-skip-btn" id="scSkipBack" aria-label="Back 10 seconds">
              ${SC.icon('refresh', { size: 18 })}<span>10s</span>
            </button>
            <button class="player-big-btn" id="scPlayerBigPlay" aria-label="Play">
              ${SC.icon('play', { size: 30 })}
            </button>
            <button class="player-skip-btn" id="scSkipFwd" aria-label="Forward 10 seconds">
              ${SC.icon('refresh', { size: 18, cls: 'flip' })}<span>10s</span>
            </button>
          </div>
          <div class="player-bar">
            <div class="player-seek" id="scPlayerSeek">
              <div class="player-seek-buffered" id="scSeekBuffered"></div>
              <div class="player-seek-fill" id="scSeekFill"></div>
              <div class="player-seek-thumb" id="scSeekThumb"></div>
            </div>
            <div class="player-controls">
              <button class="player-ctrl" id="scPlayBtn" aria-label="Play/Pause">${SC.icon('play', { size: 19 })}</button>
              <span class="player-time" id="scTime">0:00 / 0:00</span>
              <div class="player-volume">
                <button class="player-ctrl" id="scMuteBtn" aria-label="Mute">${SC.icon('volume', { size: 18 })}</button>
                <input type="range" id="scVolume" min="0" max="1" step="0.05" value="1" aria-label="Volume" />
              </div>
              <span class="player-spacer"></span>
              <button class="player-speed" id="scSpeedBtn" aria-label="Playback speed">1×</button>
              <button class="player-ctrl" id="scFsBtn" aria-label="Fullscreen">${SC.icon('maximize', { size: 18 })}</button>
            </div>
          </div>
        </div>
      </div>
    `;
    const cssFlip = document.createElement('style');
    cssFlip.textContent = '.player-skip-btn .flip{transform:scaleX(-1);}';
    container.appendChild(cssFlip);

    const shell = container.querySelector('#scPlayerShell');
    const video = container.querySelector('#scPlayerVideo');
    const ui = container.querySelector('#scPlayerUi');
    const center = container.querySelector('#scPlayerCenter');
    const loading = container.querySelector('#scPlayerLoading');
    const errorBox = container.querySelector('#scPlayerError');
    const bigPlay = container.querySelector('#scPlayerBigPlay');
    const playBtn = container.querySelector('#scPlayBtn');
    const seek = container.querySelector('#scPlayerSeek');
    const fill = container.querySelector('#scSeekFill');
    const buffered = container.querySelector('#scSeekBuffered');
    const thumb = container.querySelector('#scSeekThumb');
    const timeEl = container.querySelector('#scTime');
    const muteBtn = container.querySelector('#scMuteBtn');
    const volume = container.querySelector('#scVolume');
    const speedBtn = container.querySelector('#scSpeedBtn');
    const fsBtn = container.querySelector('#scFsBtn');

    let uiTimer = null;
    let reportTimer = null;
    let resumePos = 0;
    let resumeLoaded = false;
    let completed = false;
    let speedIdx = SPEEDS.indexOf(1);
    let bufferTimer = null;
    let spinnerTimer = null;
    let destroyed = false;

    // The "Preparing video…" overlay is deliberately LAZY. Showing it the
    // instant anything is pending made it the default state of the player:
    // every start, every seek and every 200 ms network hiccup flashed it.
    // It is now only painted if the wait actually outlasts SPINNER_DELAY,
    // so a normal start (which resolves in a few hundred ms) never shows it.
    const SPINNER_DELAY = 450;
    function showLoading(delay) {
      clearTimeout(spinnerTimer);
      spinnerTimer = setTimeout(() => {
        // readyState >= 3 (HAVE_FUTURE_DATA) means the browser got there first
        // while we were waiting — there is nothing left to "prepare".
        if (!destroyed && video.isConnected && video.readyState < 3) loading.hidden = false;
      }, delay === undefined ? SPINNER_DELAY : delay);
    }
    function hideLoading() {
      clearTimeout(spinnerTimer);
      spinnerTimer = null;
      loading.hidden = true;
    }

    // Lesson-flow responses piggyback a short-lived, account-bound ticket URL,
    // allowing the media request to start immediately. The API mint below is
    // retained as a compatibility fallback for callers that do not provide it.
    let streamUrl = o.streamUrl || StudyCoreAPI.streamUrl(resourceId);
    let attachedSrc = '';
    let metaTimer = null;

    function clearMetaTimer() {
      if (metaTimer) {
        clearTimeout(metaTimer);
        metaTimer = null;
      }
    }

    async function probeStream() {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        let probe = await fetch(streamUrl, { method: 'HEAD', credentials: 'include', signal: ctrl.signal });
        if (probe.status === 405 || probe.status === 501) {
          probe = await fetch(streamUrl, {
            method: 'GET',
            credentials: 'include',
            headers: { Range: 'bytes=0-0' },
            signal: ctrl.signal
          });
          if (probe.body && typeof probe.body.cancel === 'function') {
            try { await probe.body.cancel(); } catch { /* already closed */ }
          }
        }
        return probe;
      } finally {
        clearTimeout(t);
      }
    }

    // Diagnose a failure AFTER the fact. The player used to run this probe
    // BEFORE attaching the video, which meant every single start paid for a
    // ticket mint + a HEAD round trip (which itself makes the server hit
    // object storage) before the browser was even allowed to ask for the
    // first byte. That serialized handshake — not the video — is what kept
    // the "Preparing video…" card on screen. Now the <video> element starts
    // fetching immediately and this only runs if playback actually fails, so
    // students still get the precise reason (logged out, subscription
    // lapsed, file missing, storage unconfigured) instead of a generic error.
    async function diagnoseFailure(fallbackMessage) {
      let probe;
      try {
        probe = await probeStream();
      } catch (err) {
        console.error('[StudyCore player] probe failed', err);
        showStreamError(err.name === 'AbortError'
          ? 'The video server did not respond in time.'
          : fallbackMessage);
        return;
      }
      if (probe.status === 401) {
        showStreamError('Please log in again to watch this video.');
        return;
      }
      if (probe.status === 403) {
        // Access lapsed mid-session (subscription expired). Swap in the
        // lock wall and stop the player's own timers/listeners first,
        // otherwise they keep running against the removed <video>.
        destroyed = true;
        clearInterval(reportTimer);
        clearMetaTimer();
        clearTimeout(bufferTimer);
        clearTimeout(spinnerTimer);
        renderLock(container, o);
        return;
      }
      if (!probe.ok && probe.status !== 206) {
        let message = fallbackMessage;
        if (probe.status === 404) message = 'This video is missing from storage.';
        if (probe.status === 503) message = 'File storage is not configured yet, so this video cannot be played.';
        try {
          const data = await probe.json();
          if (data && data.message) message = data.message;
        } catch { /* not JSON */ }
        console.error('[StudyCore player] stream probe failed', probe.status, message);
        showStreamError(message);
        return;
      }
      const ctype = (probe.headers.get('content-type') || o.mimeType || '').toLowerCase();
      const name = String(o.fileName || '');
      if (/matroska|x-msvideo|\.mkv$|\.avi$/i.test(ctype + ' ' + name)) {
        showStreamError('This video format is not supported by your browser. Ask your admin to upload MP4 or WebM.');
        return;
      }
      if (ctype && !ctype.startsWith('video/') && !ctype.startsWith('application/octet-stream') && !ctype.startsWith('application/mp4')) {
        console.error('[StudyCore player] unexpected content-type', ctype);
        showStreamError('The server did not return a playable video file.');
        return;
      }
      showStreamError(fallbackMessage);
    }

    async function attachStream() {
      errorBox.hidden = true;
      showLoading();
      // Container formats no browser can play are known from the metadata
      // alone — refuse them up front rather than after a failed download.
      const declared = String(o.mimeType || '').toLowerCase() + ' ' + String(o.fileName || '');
      if (/matroska|x-msvideo|\.mkv$|\.avi$/i.test(declared)) {
        showStreamError('This video format is not supported by your browser. Ask your admin to upload MP4 or WebM.');
        return;
      }
      // Older callers may not have received a ticket with their lesson data.
      // Mint one for those callers only; the normal lesson page skips this
      // await entirely and attaches its supplied URL synchronously.
      if (!o.streamUrl) {
        try {
          if (typeof StudyCoreAPI.protectedUrl === 'function') {
            streamUrl = await StudyCoreAPI.protectedUrl(resourceId);
          }
        } catch { /* fall back to the plain session-gated URL */ }
        if (destroyed || !video.isConnected) return;
      }

      if (attachedSrc !== streamUrl) {
        attachedSrc = streamUrl;
        video.src = streamUrl;
        video.load();
      }
      clearMetaTimer();
      metaTimer = setTimeout(() => {
        if (destroyed || !video.isConnected) return;
        if (video.readyState < 1) {
          console.error('[StudyCore player] metadata timeout', { src: video.currentSrc, readyState: video.readyState });
          diagnoseFailure('The video is taking too long to start. Check your connection and try again.');
        }
      }, 15000);
    }

    function showStreamError(message) {
      clearMetaTimer();
      hideLoading();
      errorBox.hidden = false;
      const msg = container.querySelector('#scPlayerErrorMsg');
      if (msg) msg.textContent = message;
    }

    /* ── Load resume position (server-stored) ── */
    // Fetched in PARALLEL with the video itself — blocking the <video> src on
    // this round trip is what used to hold the "Preparing video…" card on
    // screen. The seek is applied by applyResume(), which runs on whichever
    // finishes last (metadata or this fetch), so "continue watching" still
    // works even when the progress endpoint is the slow one.
    // Safety net: if the progress endpoint hangs, stop waiting on it after 4s
    // and treat the lesson as starting from the beginning.
    const resumeTimer = setTimeout(() => { resumeLoaded = true; applyResume(); }, 4000);
    StudyCoreAPI.getVideoProgress(resourceId).then((p) => {
      resumePos = Number(p.position) || 0;
    }).catch(() => { /* start from 0 */ }).finally(() => {
      resumeLoaded = true;
      clearTimeout(resumeTimer);
      applyResume();
    });

    // Seek to the stored position once BOTH the metadata and the progress
    // fetch are in. Runs at most once, and never once the student has already
    // moved or watched past the stored point.
    let resumeApplied = false;
    function applyResume() {
      if (resumeApplied || destroyed || !resumeLoaded) return;
      if (!video.isConnected || video.readyState < 1) return;
      resumeApplied = true;
      if (resumePos > 30 && video.duration - resumePos > 30 && video.currentTime < 5) {
        try { video.currentTime = resumePos; } catch { /* seek refused */ }
      }
    }

    function setPlayIcon(playing) {
      const ic = playing ? SC.icon('pause', { size: 30 }) : SC.icon('play', { size: 30 });
      const icSm = playing ? SC.icon('pause', { size: 19 }) : SC.icon('play', { size: 19 });
      bigPlay.innerHTML = ic;
      playBtn.innerHTML = icSm;
      bigPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }

    // Touch devices have no hover, so the CSS `:hover` rule that reveals the
    // control bar never fires there — the controls existed but stayed at
    // opacity 0, which is why the player looked dead on a phone. Adding
    // `.show-ui` to the shell drives visibility from JS instead of hover, and
    // the shell also carries `.is-touch` so CSS can keep the controls
    // permanently legible on touch hardware.
    // A device is treated as touch only when it actually reports touch
    // hardware (coarse pointer / touch points). Testing `(hover: none)`
    // alone misfires — some desktop browsers and headless environments
    // report it while still driving a real mouse.
    const isTouch = (navigator.maxTouchPoints || 0) > 0
      || (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
      || (('ontouchstart' in window) && typeof window.orientation !== 'undefined');
    if (isTouch) shell.classList.add('is-touch');

    function showUiTransient() {
      shell.classList.add('show-ui');
      ui.style.opacity = '1';
      center.style.opacity = playing() ? '0' : '1';
      center.style.pointerEvents = playing() ? 'none' : 'auto';
      clearTimeout(uiTimer);
      // Touch users need longer than a mouse user who can just wiggle to
      // bring the bar back.
      if (playing()) uiTimer = setTimeout(hideUi, isTouch ? 4200 : 2600);
    }
    function hideUi() {
      if (playing()) {
        shell.classList.remove('show-ui');
        ui.style.opacity = '0';
        center.style.opacity = '0';
        center.style.pointerEvents = 'none';
      }
    }
    const playing = () => !video.paused && !video.ended;

    // Controls are visible from the moment the player is built, on every
    // device — never gated behind a hover that a phone cannot produce.
    showUiTransient();

    /* ── Progress reporting ───────────────── */
    function reportPosition(force) {
      if (!resourceId || (video.ended && !force)) return;
      const dur = video.duration || 0;
      const pos = Math.min(video.currentTime || 0, dur || Infinity);
      if (!dur || !Number.isFinite(pos)) return;
      StudyCoreAPI.saveVideoProgress(resourceId, pos, dur).then((r) => {
        // Server auto-completes at >=90%; reflect that in the UI callback.
        if (typeof o.onProgress === 'function') o.onProgress(pos, dur);
      }).catch(() => { /* non-fatal: position just won't resume */ });
    }

    function tick() {
      const dur = video.duration || 0;
      const pos = video.currentTime || 0;
      const pct = dur ? (pos / dur) * 100 : 0;
      fill.style.width = pct + '%';
      thumb.style.left = pct + '%';
      timeEl.textContent = `${fmtTime(pos)} / ${fmtTime(dur)}`;
      if (video.buffered.length) {
        const b = video.buffered.end(video.buffered.length - 1);
        buffered.style.width = dur ? (b / dur) * 100 + '%' : '0%';
      }
    }

    /* ── Video events ─────────────────────── */
    video.addEventListener('loadedmetadata', () => {
      clearMetaTimer();
      hideLoading();
      // Resume where the student left off (30s+ into the video only, so a
      // fresh lesson isn't dropped near its end). If the progress fetch is
      // still in flight, its .finally() calls applyResume() instead.
      applyResume();
      video.playbackRate = SPEEDS[speedIdx];
      tick();
    });
    // Enough data buffered to play through — nothing left to "prepare".
    video.addEventListener('loadeddata', hideLoading);
    video.addEventListener('canplay', hideLoading);
    video.addEventListener('play', () => {
      shell.classList.add('playing');
      shell.classList.remove('paused');
      setPlayIcon(true);
      hideLoading();
      showUiTransient();
    });
    video.addEventListener('pause', () => {
      shell.classList.remove('playing');
      shell.classList.add('paused');
      setPlayIcon(false);
      ui.style.opacity = '1';
      center.style.opacity = '1';
      center.style.pointerEvents = 'auto';
      clearTimeout(uiTimer);
      reportPosition();
    });
    video.addEventListener('waiting', () => {
      if (!playing()) return;
      // Debounced: 1.2s, not the old 400ms. Short rebuffers resolve on their
      // own and the overlay appearing for each of them is a big part of why
      // the player looked like it was permanently preparing something.
      clearTimeout(bufferTimer);
      bufferTimer = setTimeout(() => {
        if (playing() && video.readyState < 3) loading.hidden = false;
      }, 1200);
    });
    video.addEventListener('playing', () => {
      clearTimeout(bufferTimer);
      hideLoading();
    });
    // A seek that lands in already-buffered data resolves instantly; make
    // sure any spinner armed by the preceding 'waiting' is stood down.
    video.addEventListener('seeked', () => {
      clearTimeout(bufferTimer);
      if (video.readyState >= 3) hideLoading();
    });
    video.addEventListener('timeupdate', tick);
    video.addEventListener('progress', tick);
    video.addEventListener('volumechange', () => {
      muteBtn.innerHTML = video.muted || video.volume === 0
        ? SC.icon('volume-x', { size: 18 })
        : SC.icon('volume', { size: 18 });
      volume.value = video.muted ? 0 : video.volume;
    });
    video.addEventListener('ended', () => {
      reportPosition(true);
      if (typeof o.onEnded === 'function') o.onEnded();
      if (!completed) {
        try {
          StudyCoreAPI.markComplete(resourceId).then(() => {
            completed = true;
            if (typeof o.onComplete === 'function') o.onComplete();
          }).catch(() => {});
        } catch { /* non-fatal */ }
      }
    });
    video.addEventListener('error', () => {
      if (!video.currentSrc && video.src === '') return; // never started
      const err = video.error;
      const codes = {
        1: 'Playback was aborted.',
        2: 'A network error stopped the video from loading.',
        3: 'The video could not be decoded. The file may be damaged or use an unsupported codec.',
        4: 'This video format is not supported by your browser. MP4 (H.264) or WebM works best.'
      };
      const message = (err && codes[err.code]) || 'This video could not be loaded. Check your connection and try again.';
      console.error('[StudyCore player] media error', {
        code: err && err.code,
        message: err && err.message,
        src: video.currentSrc
      });
      // Show the media-level reason immediately, then refine it with the
      // server's answer (expired session, lapsed subscription, missing file)
      // now that we are only paying for that round trip on the failure path.
      showStreamError(message);
      diagnoseFailure(message);
    });

    // Block the context menu on the video itself (right-click "save video").
    video.addEventListener('contextmenu', (e) => e.preventDefault());

    /* ── Controls ────────────────────────── */
    function togglePlay() {
      if (video.paused) {
        try {
          const p = video.play();
          if (p && typeof p.catch === 'function') p.catch(() => { errorBox.hidden = false; });
        } catch { /* no-op */ }
      } else video.pause();
    }
    bigPlay.addEventListener('click', togglePlay);
    playBtn.addEventListener('click', togglePlay);
    // On a mouse device, clicking the picture toggles playback (expected
    // desktop behaviour). On touch, the first tap must REVEAL the controls
    // instead — otherwise a student trying to reach the seek bar pauses the
    // lesson by accident, and the hidden bar is unreachable.
    video.addEventListener('click', () => {
      if (!isTouch) { togglePlay(); return; }
      if (shell.classList.contains('show-ui')) hideUi();
      else showUiTransient();
    });
    container.querySelector('#scSkipBack').addEventListener('click', () => { video.currentTime = Math.max(0, (video.currentTime || 0) - 10); });
    container.querySelector('#scSkipFwd').addEventListener('click', () => {
      const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
      video.currentTime = Math.min(dur, (video.currentTime || 0) + 10);
    });
    container.querySelector('#scPlayerRetry').addEventListener('click', () => {
      errorBox.hidden = true;
      attachedSrc = '';
      video.removeAttribute('src');
      attachStream();
    });

    // Seek bar: click + drag. Handlers are named references on window so
    // destroy() can remove them — otherwise every player init leaks a pair
    // of window listeners that keep touching a detached video.
    let seeking = false;
    function seekFromEvent(e) {
      const rect = seek.getBoundingClientRect();
      if (!rect.width || rect.width <= 0) return;
      const clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX;
      if (!Number.isFinite(clientX)) return;
      const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const dur = video.duration;
      if (Number.isFinite(dur) && dur > 0) video.currentTime = pct * dur;
    }
    const onSeekMouseDown = (e) => { seeking = true; seekFromEvent(e); };
    const onWindowMouseMove = (e) => { if (seeking) seekFromEvent(e); };
    const onWindowMouseUp = () => { seeking = false; };
    const onSeekTouchStart = (e) => { seeking = true; seekFromEvent(e); };
    const onSeekTouchMove = (e) => { if (seeking) seekFromEvent(e); };
    const onSeekTouchEnd = () => { seeking = false; };
    seek.addEventListener('mousedown', onSeekMouseDown);
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
    seek.addEventListener('touchstart', onSeekTouchStart, { passive: true });
    seek.addEventListener('touchmove', onSeekTouchMove, { passive: true });
    seek.addEventListener('touchend', onSeekTouchEnd);
    seek.addEventListener('touchcancel', onSeekTouchEnd);

    muteBtn.addEventListener('click', () => { video.muted = !video.muted; });
    volume.addEventListener('input', () => { video.volume = Number(volume.value); video.muted = video.volume === 0; });
    speedBtn.addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % SPEEDS.length;
      video.playbackRate = SPEEDS[speedIdx];
      speedBtn.textContent = `${SPEEDS[speedIdx]}×`;
    });
    function lockLandscape() {
      // On mobile, lock the screen to landscape when entering fullscreen so
      // the video fills the width. The Screen Orientation API is supported on
      // Android Chrome 37+ and iOS Safari 16.4+.  Silently ignored where
      // unsupported or denied (e.g. iOS <16.4, system rotation lock on).
      if (isTouch && typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.lock === 'function') {
        screen.orientation.lock('landscape').catch(() => {});
      }
    }
    function unlockOrientation() {
      if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.unlock === 'function') {
        screen.orientation.unlock();
      }
    }
    function toggleFullscreen() {
      const docFs = document.fullscreenElement || document.webkitFullscreenElement;
      if (docFs) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
        return;
      }
      // iOS Safari implements NONE of the Element fullscreen API — only the
      // video element's own webkitEnterFullscreen. Try that first on iOS so
      // the button actually does something there instead of silently failing.
      if (typeof video.webkitEnterFullscreen === 'function'
        && !(shell.requestFullscreen || shell.webkitRequestFullscreen)) {
        try { video.webkitEnterFullscreen(); lockLandscape(); return; } catch { /* fall through */ }
      }
      const req = shell.requestFullscreen || shell.webkitRequestFullscreen;
      if (req) {
        const result = req.call(shell);
        if (result && typeof result.catch === 'function') {
          result.then(lockLandscape).catch(() => {
            if (typeof video.webkitEnterFullscreen === 'function') {
              try { video.webkitEnterFullscreen(); lockLandscape(); } catch { /* nothing else to try */ }
            }
          });
        } else {
          lockLandscape();
        }
        return;
      }
      if (typeof video.webkitEnterFullscreen === 'function') { video.webkitEnterFullscreen(); lockLandscape(); }
    }
    fsBtn.addEventListener('click', toggleFullscreen);
    function syncFsIcon() {
      if (!shell.isConnected) return;
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      fsBtn.innerHTML = fs
        ? SC.icon('minimize', { size: 18 })
        : SC.icon('maximize', { size: 18 });
      if (!fs) unlockOrientation();
    }
    document.addEventListener('fullscreenchange', syncFsIcon);
    document.addEventListener('webkitfullscreenchange', syncFsIcon);

    // Keyboard shortcuts (only when the player is in view)
    const onKeydown = (e) => {
      if (!shell.isConnected) return;
      if (/INPUT|TEXTAREA|SELECT/.test((document.activeElement && document.activeElement.tagName) || '')) return;
      const rect = shell.getBoundingClientRect();
      const inView = rect.top < window.innerHeight && rect.bottom > 0;
      if (!inView) return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': video.currentTime = Math.max(0, (video.currentTime || 0) - 5); break;
        case 'ArrowRight': {
          const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
          video.currentTime = Math.min(dur, (video.currentTime || 0) + 5);
          break;
        }
        case 'f': toggleFullscreen(); break;
        case 'm': video.muted = !video.muted; break;
        case 'ArrowUp': e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); video.muted = false; break;
        case 'ArrowDown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); break;
      }
    };
    document.addEventListener('keydown', onKeydown);

    shell.addEventListener('mousemove', showUiTransient);
    shell.addEventListener('touchstart', showUiTransient, { passive: true });

    // Periodic position saving while playing (store the handle so destroy()
    // can stop it instead of leaving a timer running after teardown).
    reportTimer = setInterval(() => { if (!destroyed && playing()) reportPosition(); }, 5000);
    const onBeforeUnload = () => { if (!destroyed) reportPosition(); };
    window.addEventListener('beforeunload', onBeforeUnload);

    // Start — attach the stream straight away and let the browser begin
    // fetching. No blocking HEAD probe, no blocking progress fetch: those ran
    // before the <video> was allowed to load a single byte and were the real
    // reason the "Preparing video…" card lingered. Errors are diagnosed after
    // the fact by diagnoseFailure().
    //
    // Autoplay is NOT attempted on touch devices. iOS and Android block
    // unmuted programmatic play() outright, and the rejected promise used to
    // leave the player sitting behind a spinner with no visible affordance.
    // On phones we present a ready, tappable player and let the student start
    // it — the one gesture mobile browsers always honour.
    showLoading();
    setPlayIcon(false);
    attachStream().then(() => {
      // attachStream bailed out with an error card (or the player was torn
      // down) — don't call play() on an element with no source.
      if (destroyed || !attachedSrc || !errorBox.hidden) return;
      if (isTouch) {
        shell.classList.add('paused');
        showUiTransient();
        return;
      }
      try {
        const p = video.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            // Desktop autoplay policy also refuses sometimes; show controls.
            shell.classList.add('paused');
            showUiTransient();
          });
        }
      } catch {
        shell.classList.add('paused');
        showUiTransient();
      }
    });

    return {
      destroy() {
        destroyed = true;
        clearInterval(reportTimer);
        clearMetaTimer();
        clearTimeout(bufferTimer);
        clearTimeout(spinnerTimer);
        clearTimeout(resumeTimer);
        clearTimeout(uiTimer);
        unlockOrientation();
        window.removeEventListener('beforeunload', onBeforeUnload);
        window.removeEventListener('mousemove', onWindowMouseMove);
        window.removeEventListener('mouseup', onWindowMouseUp);
        document.removeEventListener('fullscreenchange', syncFsIcon);
        document.removeEventListener('webkitfullscreenchange', syncFsIcon);
        document.removeEventListener('keydown', onKeydown);
        try { video.pause(); } catch { /* already detached */ }
        video.removeAttribute('src');
        try { video.load(); } catch { /* nothing loaded */ }
        attachedSrc = '';
        container.innerHTML = '';
      }
    };
  }

  /* ── Cloudflare Stream player (adaptive HD + quality selector) ────────── */

  // Load the Cloudflare Stream Player SDK once, so we can drive play/seek and
  // read time updates for resume + progress reporting. Resolves with the
  // global `Stream` factory. If the script cannot load (offline / blocked),
  // it rejects and the caller falls back to a plain iframe embed.
  let streamSdkPromise = null;
  function loadStreamSdk() {
    if (global.Stream) return Promise.resolve(global.Stream);
    if (streamSdkPromise) return streamSdkPromise;
    streamSdkPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-sc-stream-sdk]');
      if (existing) {
        existing.addEventListener('load', () => resolve(global.Stream));
        existing.addEventListener('error', reject);
        if (global.Stream) resolve(global.Stream);
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://embed.cloudflarestream.com/embed/sdk.latest.js';
      s.async = true;
      s.setAttribute('data-sc-stream-sdk', 'true');
      s.onload = () => resolve(global.Stream);
      s.onerror = () => reject(new Error('Cloudflare Stream SDK failed to load'));
      document.head.appendChild(s);
    });
    return streamSdkPromise;
  }

  function initStream(container, o) {
    const resourceId = o.resourceId;
    const sp = o.streamPlayback;
    let destroyed = false;
    let reportTimer = null;
    let completed = false;
    let player = null;

    // The iframe's `allow` list deliberately omits picture-in-picture. PiP
    // floats the video in an OS-level window that lives outside this page, so
    // none of the in-page guards can cover it and a student could keep the
    // lesson visible while switching to a recorder. Fullscreen, autoplay and
    // encrypted-media (needed for HLS/DRM playback) are kept — dropping those
    // would break normal watching.
    container.innerHTML = `
      <div class="player-shell stream-shell" id="scStreamShell">
        <div class="player-title">${SC.icon('video', { size: 17 })}<span>${escapeHtml(o.title || 'Video lesson')}</span></div>
        <iframe id="scStreamFrame"
          src="${escapeAttr(sp.iframe)}"
          title="${escapeAttr(o.title || 'Video lesson')}"
          loading="eager"
          allow="accelerated-2d-canvas; autoplay; encrypted-media; fullscreen;"
          allowfullscreen></iframe>
      </div>
    `;

    const frame = container.querySelector('#scStreamFrame');

    // Fetch the server-stored resume position (Premium sessions only) so the
    // Stream player can pick up where the student left off.
    let resumePos = 0;
    const resumeReady = StudyCoreAPI.getVideoProgress(resourceId)
      .then((p) => { resumePos = Number(p && p.position) || 0; })
      .catch(() => { /* start from 0 */ });

    function startReporting() {
      clearInterval(reportTimer);
      // Report every 5s while playing, matching the progressive player.
      reportTimer = setInterval(() => {
        if (!player || destroyed) return;
        Promise.all([Promise.resolve(player.currentTime), Promise.resolve(player.duration)]).then(([cur, d]) => {
          if (destroyed) return;
          const dur = Number(d) || sp.duration || 0;
          const pos = Math.min(Number(cur) || 0, dur || Infinity);
          if (!dur || !Number.isFinite(pos)) return;
          StudyCoreAPI.saveVideoProgress(resourceId, pos, dur)
            .then(() => {
              if (typeof o.onProgress === 'function') o.onProgress(pos, dur);
              if (!completed && dur && pos / dur >= 0.9) {
                completed = true;
                if (typeof o.onComplete === 'function') o.onComplete();
              }
            })
            .catch(() => { /* non-fatal */ });
        });
      }, 5000);
    }

    loadStreamSdk().then((Stream) => {
      if (destroyed || !Stream) return;
      player = Stream(frame);

      player.addEventListener('loadedmetadata', () => {
        resumeReady.then(() => {
          if (destroyed || !player) return;
          Promise.resolve(player.duration).then((d) => {
            const dur = Number(d) || sp.duration || 0;
            // Resume only when meaningfully into the video and not at the end.
            if (resumePos > 3 && (!dur || resumePos < dur - 5)) {
              try { player.currentTime = resumePos; } catch { /* ignore */ }
            }
          });
        });
      });

      player.addEventListener('play', startReporting);
      player.addEventListener('pause', () => {
        clearInterval(reportTimer);
        // Capture the exact pause position immediately.
        Promise.all([Promise.resolve(player.currentTime), Promise.resolve(player.duration)]).then(([cur, d]) => {
          const dur = Number(d) || sp.duration || 0;
          const pos = Math.min(Number(cur) || 0, dur || Infinity);
          if (dur && Number.isFinite(pos)) StudyCoreAPI.saveVideoProgress(resourceId, pos, dur).catch(() => {});
        });
      });
      player.addEventListener('ended', () => {
        clearInterval(reportTimer);
        if (!completed) {
          completed = true;
          Promise.resolve(player.duration).then((d) => {
            const dur = Number(d) || sp.duration || 0;
            if (dur) StudyCoreAPI.saveVideoProgress(resourceId, dur, dur).catch(() => {});
            if (typeof o.onEnded === 'function') o.onEnded();
            if (typeof o.onComplete === 'function') o.onComplete();
          });
        }
      });
    }).catch(() => {
      // SDK blocked/offline: the iframe still plays with Cloudflare's own
      // controls and quality selector; we just can't sync resume/progress.
    });

    return {
      destroy() {
        destroyed = true;
        clearInterval(reportTimer);
        player = null;
        container.innerHTML = '';
      }
    };
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  /* ── Premium lock wall ──────────────────── */
  function renderLock(container, o) {
    const premiumUrl = '/pages/pricing.html';
    const dashPremium = '/dashboard.html#premium';
    container.innerHTML = `
      <div class="player-shell lock-wall">
        <div class="player-premium-lock">
          <div class="lock-ring">${SC.icon('lock', { size: 32 })}</div>
          <h3>Premium Video</h3>
          <p>${o.lockText || 'This video is available exclusively to StudyCore Premium students.'}</p>
          <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;">
            <a class="btn btn-amber" href="${premiumUrl}">${SC.icon('crown', { size: 17 })} Upgrade to Premium</a>
            <a class="btn btn-outline" style="background:rgba(255,255,255,0.08);border-color:rgba(255,255,255,0.3);color:#fff;" href="${dashPremium}">Open Premium Section</a>
          </div>
        </div>
      </div>
    `;
  }

  global.StudyCorePlayer = { init, fmtTime };
})(window);
