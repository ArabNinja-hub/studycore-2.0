// =============================================
// STUDYCORE — API Client (js/api.js)
// -----------------------------------------------
// Every request goes through here. Auth is a real httpOnly cookie set by
// the server on login/signup (see server.js + middleware/auth.js) - the
// browser sends it automatically on same-origin requests as long as we
// pass `credentials: 'include'`. There is no token in localStorage to
// spoof, and no client-side role logic anywhere in this file.
//
// RELIABILITY (most students are on mobile data):
//   · Every request has a real timeout — a stalled socket on a weak
//     signal fails fast with an honest message instead of spinning
//     forever behind a skeleton.
//   · Safe (GET/HEAD) requests retry automatically with exponential
//     backoff + jitter on network errors, timeouts and 5xx/429. Writes
//     are NEVER auto-retried: a duplicated POST is worse than an error.
//   · When the device is offline we wait briefly for the radio to come
//     back before even attempting, so a two-second tunnel does not turn
//     into a visible failure.
//   · Connection state is published on SC.net so the UI can show one
//     shared, calm status strip instead of a pile of red toasts.
// =============================================

(function (global) {
  'use strict';

  global.SC = global.SC || {};

  /* ── Connection state ─────────────────────── */

  const NET = {
    TIMEOUT_MS: 16000,        // normal JSON call
    // Multipart uploads are NOT bounded by wall-clock time: a large file on
    // a slow uplink is legitimately slow, and aborting a transfer that is
    // still moving bytes just wastes the student's data bundle. Progress-
    // based stall detection (see uploadWithProgress) is the real signal.
    UPLOAD_TIMEOUT_MS: 180000, // fetch-based small uploads (avatar, quiz image)
    UPLOAD_STALL_MS: 45000,    // no upload progress at all -> genuinely dead
    UPLOAD_FINALIZE_MS: 120000, // bytes sent; waiting on R2 + DB commit
    RETRIES: 2,               // extra attempts for safe requests
    BACKOFF_MS: 550,
    OFFLINE_GRACE_MS: 6000,   // how long to wait for the radio before failing
    BUDGET_MS: 26000          // hard ceiling on one request incl. all retries
  };

  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const SAFE_METHODS = new Set(['GET', 'HEAD']);

  const state = {
    online: typeof navigator === 'undefined' || navigator.onLine !== false,
    // True only while a request is actually mid-retry, so the status strip
    // never claims to be doing something it is not.
    degraded: false
  };

  function emit(name, detail) {
    try {
      global.dispatchEvent(new CustomEvent(name, { detail }));
    } catch { /* very old engines: events are a nice-to-have, never required */ }
  }

  // `announce` forces the recovery event even when we already believed we
  // were online. That matters because navigator.onLine only tracks the radio:
  // a captive portal, dead mobile data or an unreachable server all look
  // "online" while every request fails. Recovery from THAT state has to be
  // announced too, or the page never heals itself.
  function setOnline(next, options = {}) {
    const changed = state.online !== next;
    if (!changed && !(next && options.announce)) return;
    state.online = next;
    if (next) state.degraded = false;
    emit(next ? 'sc:net:online' : 'sc:net:offline', { ...state });
    emit('sc:net:change', { ...state });
  }

  function setDegraded(next) {
    if (state.degraded === next) return;
    state.degraded = next;
    emit('sc:net:change', { ...state });
  }

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('online', () => setOnline(true, { announce: true }));
    global.addEventListener('offline', () => setOnline(false));
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Resolves as soon as the device reports a connection again, or after
  // `ms`. Used before the first attempt so a brief dead spot is invisible.
  function waitForConnection(ms) {
    if (typeof navigator === 'undefined' || navigator.onLine !== false) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        global.removeEventListener('online', onBack);
        clearTimeout(timer);
        resolve(ok);
      };
      const onBack = () => finish(true);
      const timer = setTimeout(() => finish(false), ms);
      global.addEventListener('online', onBack);
    });
  }

  function networkError(message, extra) {
    const err = new Error(message);
    err.network = true;
    Object.assign(err, extra || {});
    return err;
  }

  /* ── The single fetch path ────────────────── */

  async function attempt(path, options, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    let res;
    try {
      res = await fetch(path, {
        ...options,
        credentials: 'include',
        signal: controller ? controller.signal : undefined
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (controller && controller.signal.aborted) {
        throw networkError('This is taking too long on your connection. Tap to try again.', { timeout: true });
      }
      throw networkError(
        navigator.onLine === false
          ? 'You appear to be offline. StudyCore will reconnect automatically.'
          : 'Connection problem. Check your data and try again.',
        { offline: navigator.onLine === false }
      );
    }
    if (timer) clearTimeout(timer);
    return res;
  }

  async function request(path, options = {}) {
    const isFormData = options.body instanceof FormData;
    const method = String(options.method || 'GET').toUpperCase();
    const safe = SAFE_METHODS.has(method);
    const timeoutMs = options.timeoutMs || (isFormData ? NET.UPLOAD_TIMEOUT_MS : NET.TIMEOUT_MS);
    const maxAttempts = options.retries === undefined
      ? (safe ? NET.RETRIES + 1 : 1)
      : Number(options.retries) + 1;

    const fetchOptions = {
      ...options,
      method: options.method,
      headers: isFormData
        ? { ...(options.headers || {}) }
        : { 'Content-Type': 'application/json', ...(options.headers || {}) }
    };
    delete fetchOptions.timeoutMs;
    delete fetchOptions.retries;
    delete fetchOptions.budgetMs;

    // Nothing has been sent yet, so waiting here can never duplicate a write.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setOnline(false);
      const back = await waitForConnection(NET.OFFLINE_GRACE_MS);
      if (!back) {
        throw networkError('You are offline. StudyCore will retry as soon as you are back.', { offline: true });
      }
      setOnline(true);
    }

    // A retry loop with no ceiling is its own kind of unreliability: the
    // student stares at a skeleton for a minute. Never exceed this budget.
    const budgetMs = options.budgetMs || (isFormData ? NET.UPLOAD_TIMEOUT_MS : NET.BUDGET_MS);
    const deadline = Date.now() + budgetMs;
    const budgetLeft = () => deadline - Date.now();

    let lastError = null;

    for (let i = 0; i < maxAttempts; i += 1) {
      try {
        const res = await attempt(path, fetchOptions, timeoutMs);

        let data = null;
        try { data = await res.json(); } catch { data = null; }

        if (!res.ok) {
          const error = new Error((data && data.message) || `Request failed (${res.status})`);
          error.status = res.status;
          error.locked = Boolean(data && data.locked);
          error.lockReason = data && data.lockReason ? data.lockReason : null;

          // Server-side hiccups are worth one more shot for safe reads only.
          const backoff = NET.BACKOFF_MS * Math.pow(2, i) + Math.random() * 250;
          if (safe && RETRYABLE_STATUS.has(res.status) && i < maxAttempts - 1 && budgetLeft() > backoff + 1500) {
            lastError = error;
            setDegraded(true);
            await sleep(backoff);
            continue;
          }
          // A real answer from the server means the pipe works.
          setOnline(true, { announce: state.degraded });
          setDegraded(false);
          throw error;
        }

        // Getting through after a rough patch is a reconnection: announce it
        // so pages holding an error state can quietly reload themselves.
        setOnline(true, { announce: state.degraded });
        setDegraded(false);
        return data;
      } catch (err) {
        if (!err.network) throw err;   // an HTTP error already decided above
        lastError = err;

        if (err.offline) setOnline(false);

        const backoff = NET.BACKOFF_MS * Math.pow(2, i) + Math.random() * 250;
        if (i < maxAttempts - 1 && budgetLeft() > backoff + 1500) {
          setDegraded(true);
          // Give the radio a chance to come back before burning the retry.
          if (err.offline) await waitForConnection(Math.min(NET.OFFLINE_GRACE_MS, budgetLeft()));
          else await sleep(backoff);
          continue;
        }
        break;
      }
    }

    // Out of attempts: the caller now owns the failure (error state, toast,
    // retry button). The strip stops claiming to be working on it.
    setDegraded(false);
    throw lastError || networkError('Connection problem. Please try again.');
  }

  /* ── Public connection API ────────────────── */

  SC.net = {
    get online() { return state.online; },
    get degraded() { return state.degraded; },
    state: () => ({ ...state }),
    waitForConnection,
    // Run `fn` now and again every time the connection is restored. Returns
    // an unsubscribe function. Pages use this to self-heal after a dropout.
    onReconnect(fn) {
      const handler = () => { try { fn(); } catch { /* page-level concern */ } };
      global.addEventListener('sc:net:online', handler);
      return () => global.removeEventListener('sc:net:online', handler);
    },
    // Human-friendly text for any error thrown by this client.
    message(err) {
      if (!err) return 'Something went wrong. Please try again.';
      if (err.offline) return 'You are offline. StudyCore will retry when you reconnect.';
      if (err.timeout) return 'That took too long on your connection. Please try again.';
      if (err.network) return 'Connection problem. Check your data and try again.';
      return err.message || 'Something went wrong. Please try again.';
    }
  };

  const StudyCoreAPI = {
    // Auth
    register: (payload) => request('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
    // The access code is supplied only from the registration form and sent
    // directly to the server for validation. It is never persisted in browser
    // storage or returned in an API response.
    registerContentAdmin: (payload) => request('/api/auth/register-content-admin', { method: 'POST', body: JSON.stringify(payload) }),
    login: (payload) => request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    // The whole account UI waits on this one, so it gets a tighter budget
    // than a content fetch: better a fast "not signed in" that self-corrects
    // on reconnect than a nav bar frozen for half a minute.
    me: () => request('/api/auth/me', { timeoutMs: 7000, retries: 1, budgetMs: 12000 }),
    updateProfile: (payload) => request('/api/auth/profile', { method: 'PUT', body: JSON.stringify(payload) }),
    changePassword: (payload) => request('/api/auth/password', { method: 'PUT', body: JSON.stringify(payload) }),
    subscribe: (payload) => request('/api/auth/subscribe', { method: 'POST', body: JSON.stringify(payload) }),
    paymentInfo: () => request('/api/auth/payment-info'),
    config: () => request('/api/auth/config'),
    myReferral: () => request('/api/auth/referral'),

    // Profile picture (server validates type + signature, stores in R2)
    avatarUrl: () => '/api/auth/avatar',
    uploadAvatar: (file) => {
      const fd = new FormData();
      fd.append('avatar', file);
      return request('/api/auth/avatar', { method: 'POST', body: fd });
    },
    removeAvatar: () => request('/api/auth/avatar', { method: 'DELETE' }),

    // Courses (legacy subject model - still served)
    listCourses: () => request('/api/courses'),
    courseHome: (subject) => request(`/api/courses/${encodeURIComponent(subject)}`),
    lessonFlow: (id) => request(`/api/courses/lesson/${encodeURIComponent(id)}`),

    // Programs (multi-program platform)
    listPrograms: (counts) => request(`/api/programs${counts ? '?counts=1' : ''}`),
    myProgram: () => request('/api/programs/mine'),
    programCourseHome: (key) => request(`/api/programs/course/${encodeURIComponent(key)}`),
    programLessonFlow: (id) => request(`/api/programs/lesson/${encodeURIComponent(id)}`),
    setMyProgram: (program) => request('/api/auth/program', { method: 'PUT', body: JSON.stringify({ program }) }),

    // Admin: programs & courses
    adminPrograms: () => request('/api/programs/admin'),
    adminCreateProgram: (payload) => request('/api/programs/admin', { method: 'POST', body: JSON.stringify(payload) }),
    adminUpdateProgram: (code, payload) => request(`/api/programs/admin/${encodeURIComponent(code)}`, { method: 'PUT', body: JSON.stringify(payload) }),
    adminDeleteProgram: (code) => request(`/api/programs/admin/${encodeURIComponent(code)}`, { method: 'DELETE' }),
    adminCreateCourse: (payload) => request('/api/programs/admin/courses', { method: 'POST', body: JSON.stringify(payload) }),
    adminUpdateCourse: (id, payload) => request(`/api/programs/admin/courses/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }),
    adminDeleteCourse: (id) => request(`/api/programs/admin/courses/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    adminAttachCourse: (code, courseId) => request(`/api/programs/admin/${encodeURIComponent(code)}/courses`, { method: 'POST', body: JSON.stringify({ courseId }) }),
    adminDetachCourse: (code, courseId) => request(`/api/programs/admin/${encodeURIComponent(code)}/courses/${encodeURIComponent(courseId)}`, { method: 'DELETE' }),
    adminSetStudentProgram: (userId, program) => request(`/api/admin/users/${encodeURIComponent(userId)}/program`, { method: 'PUT', body: JSON.stringify({ program }) }),

    // Progress
    markComplete: (id) => request(`/api/resources/${id}/complete`, { method: 'POST' }),
    markIncomplete: (id) => request(`/api/resources/${id}/complete`, { method: 'DELETE' }),
    myCompleted: () => request('/api/resources/completed/mine'),
    saveVideoProgress: (id, position, duration) => request(`/api/resources/${id}/video-progress`, {
      method: 'POST', body: JSON.stringify({ position, duration })
    }),
    getVideoProgress: (id) => request(`/api/resources/${id}/video-progress`),

    // Resources
    listResources: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      return request(`/api/resources?${qs.toString()}`);
    },
    getResource: (id) => request(`/api/resources/${id}`),
    streamUrl: (id) => `/api/resources/${id}/stream`,
    myBookmarks: () => request('/api/resources/bookmarks/mine'),
    bookmark: (id) => request(`/api/resources/${id}/bookmark`, { method: 'POST' }),
    unbookmark: (id) => request(`/api/resources/${id}/bookmark`, { method: 'DELETE' }),

    // Notifications & Announcements
    getNotifications: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      const qStr = qs.toString();
      return request(`/api/notifications${qStr ? `?${qStr}` : ''}`);
    },
    getUnreadNotificationCount: () => request('/api/notifications/unread-count'),
    markNotificationRead: (id) => request(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
    markAllNotificationsRead: () => request('/api/notifications/read-all', { method: 'POST' }),

    // Quizzes (program-targeted practice authored by Content Admins / Main Admin)
    quizListMine: () => request('/api/quiz/mine'),
    quizGetForEdit: (id) => request(`/api/quiz/${encodeURIComponent(id)}/manage`),
    quizCreate: (payload) => request('/api/quiz', { method: 'POST', body: JSON.stringify(payload) }),
    quizUpdate: (id, payload) => request(`/api/quiz/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }),
    quizDelete: (id) => request(`/api/quiz/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    quizUploadImage: (file) => {
      const fd = new FormData();
      fd.append('image', file);
      return request('/api/quiz/image', { method: 'POST', body: fd });
    },
    quizImageUrl: (key) => `/api/quiz/image/${encodeURIComponent(key)}`,
    // Student-facing
    quizAvailable: () => request('/api/quiz/student'),
    quizTake: (id) => request(`/api/quiz/${encodeURIComponent(id)}`),
    quizSubmitAttempt: (id, payload) => request(`/api/quiz/${encodeURIComponent(id)}/attempt`, {
      method: 'POST', body: JSON.stringify(payload)
    }),
    quizMyAttempts: (id) => request(`/api/quiz/${encodeURIComponent(id)}/attempts/mine`),

    // Admin
    adminListResources: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      return request(`/api/admin/resources?${qs.toString()}`);
    },
    adminCreateResource: (formData) => request('/api/admin/resources', { method: 'POST', body: formData }),
    adminUpdateResource: (id, formData) => request(`/api/admin/resources/${id}`, { method: 'PUT', body: formData }),
    adminDeleteResource: (id) => request(`/api/admin/resources/${id}`, { method: 'DELETE' }),
    adminListUsers: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      const qStr = qs.toString();
      return request(`/api/admin/users${qStr ? `?${qStr}` : ''}`);
    },
    adminDeleteUser: (id) => request(`/api/admin/users/${id}`, { method: 'DELETE' }),
    adminListContentAdmins: () => request('/api/admin/content-admins'),
    adminSetContentAdminStatus: (id, isActive) => request(`/api/admin/content-admins/${encodeURIComponent(id)}/status`, {
      method: 'PATCH', body: JSON.stringify({ isActive })
    }),
    adminDeleteContentAdmin: (id) => request(`/api/admin/content-admins/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    adminAnalytics: () => request('/api/admin/analytics'),
    adminListPayments: (status) => request(`/api/admin/payments${status ? `?status=${status}` : ''}`),
    adminApprovePayment: (id) => request(`/api/admin/payments/${id}/approve`, { method: 'POST' }),
    adminRejectPayment: (id) => request(`/api/admin/payments/${id}/reject`, { method: 'POST' }),

    // Content Admin: deliberately scoped to the authenticated uploader's own
    // resources. The server independently enforces this ownership boundary.
    contentAdminDashboard: () => request('/api/content-admin/dashboard'),
    contentAdminCatalog: () => request('/api/content-admin/catalog'),
    contentAdminListResources: () => request('/api/content-admin/resources'),
    contentAdminGetResource: (id) => request(`/api/content-admin/resources/${encodeURIComponent(id)}`),
    contentAdminCreateResource: (formData) => request('/api/content-admin/resources', { method: 'POST', body: formData }),
    contentAdminUpdateResource: (id, formData) => request(`/api/content-admin/resources/${encodeURIComponent(id)}`, { method: 'PUT', body: formData }),
    contentAdminDeleteResource: (id) => request(`/api/content-admin/resources/${encodeURIComponent(id)}`, { method: 'DELETE' })
  };

  // XHR wrapper so we can report real upload progress (fetch can't do this yet).
  //
  // SLOW CONNECTIONS: a single wall-clock timeout is wrong for uploads. A
  // 60MB lecture PDF on a 200kbps uplink legitimately takes 40 minutes, and
  // killing it at a fixed deadline throws away work that was progressing
  // fine. What actually indicates a dead upload is *no bytes moving*, so we
  // use a STALL timeout that resets on every progress event instead. The
  // callback also receives live throughput/ETA so the UI can prove to the
  // student that something is still happening.
  StudyCoreAPI.uploadWithProgress = function (url, method, formData, onProgress, options = {}) {
    const stallMs = options.stallMs || NET.UPLOAD_STALL_MS;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.withCredentials = true;

      const startedAt = Date.now();
      let lastLoaded = 0;
      let lastTick = startedAt;
      let speedBps = 0;          // smoothed bytes/second
      let stallTimer = null;
      let finished = false;

      function clearStall() {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      }

      function armStall() {
        clearStall();
        stallTimer = setTimeout(() => {
          if (finished) return;
          finished = true;
          try { xhr.abort(); } catch { /* already gone */ }
          reject(networkError(
            navigator.onLine === false
              ? 'Upload stopped — you are offline. Reconnect and try again.'
              : 'The upload stopped making progress. Check your connection and try again.',
            { timeout: true, offline: navigator.onLine === false }
          ));
        }, stallMs);
      }

      // Let the caller cancel a doomed upload instead of waiting it out.
      if (options.signal) {
        if (options.signal.aborted) {
          reject(networkError('Upload cancelled.', { cancelled: true }));
          return;
        }
        options.signal.addEventListener('abort', () => {
          if (finished) return;
          finished = true;
          clearStall();
          try { xhr.abort(); } catch { /* already gone */ }
          reject(networkError('Upload cancelled.', { cancelled: true }));
        }, { once: true });
      }

      xhr.upload.onprogress = (event) => {
        armStall();
        if (!event.lengthComputable || !onProgress) return;

        const now = Date.now();
        const dt = (now - lastTick) / 1000;
        if (dt >= 0.25) {
          const instant = (event.loaded - lastLoaded) / dt;
          // Exponential smoothing: a raw per-tick rate on mobile data swings
          // wildly and makes the ETA jump around, which reads as "broken".
          speedBps = speedBps ? (speedBps * 0.7) + (instant * 0.3) : instant;
          lastLoaded = event.loaded;
          lastTick = now;
        }

        const percent = Math.round((event.loaded / event.total) * 100);
        const remaining = event.total - event.loaded;
        const etaSeconds = speedBps > 0 ? Math.round(remaining / speedBps) : null;
        onProgress(percent, {
          loaded: event.loaded,
          total: event.total,
          bytesPerSecond: Math.max(0, Math.round(speedBps)),
          etaSeconds,
          elapsedSeconds: Math.round((now - startedAt) / 1000)
        });
      };

      // Bytes are all out; now we are waiting on R2 + the database. Give the
      // server its own generous window rather than the upload stall window.
      xhr.upload.onload = () => {
        clearStall();
        stallTimer = setTimeout(() => {
          if (finished) return;
          finished = true;
          try { xhr.abort(); } catch { /* already gone */ }
          reject(networkError('The server did not confirm the upload in time. Please check the library before re-uploading.', { timeout: true }));
        }, NET.UPLOAD_FINALIZE_MS);
      };

      xhr.onload = () => {
        if (finished) return;
        finished = true;
        clearStall();
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { data = null; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else {
          const err = new Error((data && data.message) || `Upload failed (${xhr.status})`);
          err.status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = () => {
        if (finished) return;
        finished = true;
        clearStall();
        reject(networkError(
          navigator.onLine === false
            ? 'Upload stopped — you are offline. Reconnect and try again.'
            : 'Connection lost during the upload. Please try again.',
          { offline: navigator.onLine === false }
        ));
      };
      xhr.ontimeout = () => {
        if (finished) return;
        finished = true;
        clearStall();
        reject(networkError('The upload timed out on this connection. Please try again.', { timeout: true }));
      };
      // No xhr.timeout: progress-based stalling (above) is the correct
      // failure signal for a big file on a slow uplink.
      armStall();
      xhr.send(formData);
    });
  };

  global.StudyCoreAPI = StudyCoreAPI;

  /* ── Shared connection status strip ─────────
     One calm, non-blocking strip pinned to the bottom of the viewport
     (above the mobile dock). It replaces the "nothing happened / did it
     save?" ambiguity that makes a site feel unreliable on mobile data.
     Pure DOM + inline SVG so it works on every page, even before the
     icon set or the layout script has run. */

  function initNetBanner() {
    if (!global.document || !document.body) return;
    if (document.getElementById('scNetStrip')) return;

    const strip = document.createElement('div');
    strip.id = 'scNetStrip';
    strip.className = 'sc-net-strip';
    strip.setAttribute('role', 'status');
    strip.setAttribute('aria-live', 'polite');
    strip.hidden = true;
    strip.innerHTML = '<span class="sc-net-dot" aria-hidden="true"></span><span class="sc-net-text"></span>';
    document.body.appendChild(strip);

    const text = strip.querySelector('.sc-net-text');
    let restoreTimer = null;

    function render() {
      clearTimeout(restoreTimer);
      if (!state.online) {
        strip.hidden = false;
        strip.dataset.mode = 'offline';
        text.textContent = 'No connection — StudyCore will reconnect automatically.';
      } else if (state.degraded) {
        strip.hidden = false;
        strip.dataset.mode = 'slow';
        text.textContent = 'Slow connection — retrying…';
      } else if (!strip.hidden) {
        strip.dataset.mode = 'back';
        text.textContent = 'Back online.';
        restoreTimer = setTimeout(() => { strip.hidden = true; }, 2200);
      }
      // Let the layout push content (e.g. the mobile dock) out of the way.
      document.body.classList.toggle('has-net-strip', !strip.hidden);
    }

    global.addEventListener('sc:net:change', render);
    global.addEventListener('sc:net:online', render);
    global.addEventListener('sc:net:offline', render);
    if (!state.online) render();
  }

  if (global.document) {
    if (document.readyState === 'loading' || !document.body) {
      document.addEventListener('DOMContentLoaded', initNetBanner, { once: true });
    } else {
      initNetBanner();
    }
  }
})(window);
