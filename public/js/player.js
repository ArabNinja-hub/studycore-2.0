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

    /* ── Build the player shell ───────────── */
    container.innerHTML = `
      <div class="player-shell" id="scPlayerShell">
        <video id="scPlayerVideo" preload="metadata" playsinline webkit-playsinline
               controlslist="nodownload noremoteplayback" disablepictureinpicture></video>
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

    const streamUrl = StudyCoreAPI.streamUrl(resourceId);

    async function attachStream() {
      try {
        const probe = await fetch(streamUrl, {
          credentials: 'include',
          headers: { Range: 'bytes=0-1' }
        });
        if (probe.status === 401) {
          showStreamError('Please log in again to watch this video.');
          return;
        }
        if (probe.status === 403) {
          renderLock(container, o);
          return;
        }
        if (!probe.ok && probe.status !== 206) {
          let message = 'This video could not be loaded. Check your connection and try again.';
          try {
            const data = await probe.json();
            if (data && data.message) message = data.message;
          } catch { /* not JSON */ }
          showStreamError(message);
          return;
        }
        // Drop the probe body so a full-file 200 doesn't download twice.
        if (probe.body && typeof probe.body.cancel === 'function') {
          try { await probe.body.cancel(); } catch { /* already closed */ }
        }
      } catch {
        showStreamError('Could not connect to the video stream. Please try again.');
        return;
      }
      video.src = streamUrl;
      video.load();
    }

    function showStreamError(message) {
      loading.hidden = true;
      errorBox.hidden = false;
      const msg = container.querySelector('#scPlayerErrorMsg');
      if (msg) msg.textContent = message;
    }

    /* ── Load resume position (server-stored) ── */
    StudyCoreAPI.getVideoProgress(resourceId).then((p) => {
      resumePos = Number(p.position) || 0;
      resumeLoaded = true;
    }).catch(() => { resumeLoaded = true; });

    function setPlayIcon(playing) {
      const ic = playing ? SC.icon('pause', { size: 30 }) : SC.icon('play', { size: 30 });
      const icSm = playing ? SC.icon('pause', { size: 19 }) : SC.icon('play', { size: 19 });
      bigPlay.innerHTML = ic;
      playBtn.innerHTML = icSm;
      bigPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }

    function showUiTransient() {
      ui.style.opacity = '1';
      center.style.opacity = playing() ? '0' : '1';
      center.style.pointerEvents = playing() ? 'none' : 'auto';
      clearTimeout(uiTimer);
      if (playing()) uiTimer = setTimeout(hideUi, 2600);
    }
    function hideUi() {
      if (playing()) { ui.style.opacity = '0'; center.style.opacity = '0'; center.style.pointerEvents = 'none'; }
    }
    const playing = () => !video.paused && !video.ended;

    /* ── Progress reporting ───────────────── */
    function reportPosition(force) {
      if (!resourceId || video.ended && !force) return;
      const pos = video.currentTime;
      const dur = video.duration || 0;
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
      loading.hidden = true;
      // Resume where the student left off (30s+ into the video only,
      // so a fresh lesson isn't dropped near its end).
      if (resumeLoaded && resumePos > 30 && video.duration - resumePos > 30) {
        video.currentTime = resumePos;
      }
      video.playbackRate = SPEEDS[speedIdx];
      tick();
    });
    video.addEventListener('play', () => {
      shell.classList.add('playing');
      shell.classList.remove('paused');
      setPlayIcon(true);
      loading.hidden = true;
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
    video.addEventListener('waiting', () => { if (playing()) loading.hidden = false; });
    video.addEventListener('playing', () => { loading.hidden = true; });
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
      loading.hidden = true;
      errorBox.hidden = false;
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
    video.addEventListener('click', togglePlay);
    container.querySelector('#scSkipBack').addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
    container.querySelector('#scSkipFwd').addEventListener('click', () => { video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); });
    container.querySelector('#scPlayerRetry').addEventListener('click', () => {
      errorBox.hidden = true;
      loading.hidden = false;
      attachStream();
    });

    // Seek bar: click + drag
    let seeking = false;
    function seekFromEvent(e) {
      const rect = seek.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      if (video.duration) video.currentTime = pct * video.duration;
    }
    seek.addEventListener('mousedown', (e) => { seeking = true; seekFromEvent(e); });
    window.addEventListener('mousemove', (e) => { if (seeking) seekFromEvent(e); });
    window.addEventListener('mouseup', () => { seeking = false; });
    seek.addEventListener('touchstart', (e) => { seeking = true; seekFromEvent(e); }, { passive: true });
    seek.addEventListener('touchmove', (e) => { if (seeking) seekFromEvent(e); }, { passive: true });
    seek.addEventListener('touchend', () => { seeking = false; });

    muteBtn.addEventListener('click', () => { video.muted = !video.muted; });
    volume.addEventListener('input', () => { video.volume = Number(volume.value); video.muted = video.volume === 0; });
    speedBtn.addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % SPEEDS.length;
      video.playbackRate = SPEEDS[speedIdx];
      speedBtn.textContent = `${SPEEDS[speedIdx]}×`;
    });
    function toggleFullscreen() {
      const docFs = document.fullscreenElement || document.webkitFullscreenElement;
      if (docFs) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
        return;
      }
      const req = shell.requestFullscreen || shell.webkitRequestFullscreen;
      if (req) req.call(shell);
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    }
    fsBtn.addEventListener('click', toggleFullscreen);
    function syncFsIcon() {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      fsBtn.innerHTML = fs
        ? SC.icon('minimize', { size: 18 })
        : SC.icon('maximize', { size: 18 });
    }
    document.addEventListener('fullscreenchange', syncFsIcon);
    document.addEventListener('webkitfullscreenchange', syncFsIcon);

    // Keyboard shortcuts (only when the player is in view)
    document.addEventListener('keydown', (e) => {
      if (!shell.isConnected) return;
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      const rect = shell.getBoundingClientRect();
      const inView = rect.top < window.innerHeight && rect.bottom > 0;
      if (!inView) return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': video.currentTime = Math.max(0, video.currentTime - 5); break;
        case 'ArrowRight': video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); break;
        case 'f': toggleFullscreen(); break;
        case 'm': video.muted = !video.muted; break;
        case 'ArrowUp': e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); video.muted = false; break;
        case 'ArrowDown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); break;
      }
    });

    shell.addEventListener('mousemove', showUiTransient);
    shell.addEventListener('touchstart', showUiTransient, { passive: true });

    // Periodic position saving while playing (store the handle so destroy()
    // can stop it instead of leaving a timer running after teardown).
    reportTimer = setInterval(() => { if (playing()) reportPosition(); }, 5000);
    const onBeforeUnload = () => reportPosition();
    window.addEventListener('beforeunload', onBeforeUnload);

    // Start
    video.src = streamUrl;
    loading.hidden = false;
    setPlayIcon(false);
    // play() returns a Promise in modern browsers (autoplay may reject);
    // guard for engines where it doesn't, so autoplay issues can never
    // take down the rest of the lesson page.
    try {
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* no-op */ }

    return {
      destroy() {
        clearInterval(reportTimer);
        window.removeEventListener('beforeunload', onBeforeUnload);
        video.pause();
        video.removeAttribute('src');
        container.innerHTML = '';
      }
    };
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
