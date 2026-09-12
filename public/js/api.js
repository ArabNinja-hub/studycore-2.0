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
    // Video Lessons page: one subject, one term. Deliberately NOT courseHome —
    // that returns every topic, note, tutorial, past paper and announcement in
    // the course, all of which this page discards. The server builds the same
    // list under the same access rules, just without the payload.
    courseVideos: (subject, term) => request(
      `/api/courses/${encodeURIComponent(subject)}?view=videos${term ? `&term=${encodeURIComponent(term)}` : ''}`
    ),

    // Programs (multi-program platform)
    listPrograms: (counts) => request(`/api/programs${counts ? '?counts=1' : ''}`),
    myProgram: () => request('/api/programs/mine'),
    programCourseHome: (key) => request(`/api/programs/course/${encodeURIComponent(key)}`),
    // Compact program-course equivalent of courseVideos (see above).
    programCourseVideos: (key, term) => request(
      `/api/programs/course/${encodeURIComponent(key)}?view=videos${term ? `&term=${encodeURIComponent(term)}` : ''}`
    ),
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

    // Protected byte access.
    //
    // `streamUrl` above is the plain session-gated URL and still works. This
    // asks the server to mint a SHORT-LIVED, account-bound ticket and returns
    // the URL carrying it, so the address the reader/player actually loads
    // expires within hours and is useless to anyone else — a link copied out
    // of devtools and pasted into a chat is refused for every other account.
    //
    // Tickets are cached per resource for the life of the page (re-minted
    // shortly before expiry) so paging a PDF does not mint one per request.
    // Any failure falls back to the plain session-gated URL: the server is
    // the authority either way, and a ticket service hiccup must never stop
    // a paying student from opening their lesson.
    protectedUrl: (() => {
      const cache = new Map();
      const SAFETY_MS = 5 * 60 * 1000; // re-mint before it actually lapses
      return async (id) => {
        const fallback = `/api/resources/${id}/stream`;
        const hit = cache.get(id);
        if (hit && hit.expiresAt - SAFETY_MS > Date.now()) return hit.url;
        try {
          const data = await request(`/api/resources/${id}/ticket`);
          if (!data || !data.url) return fallback;
          cache.set(id, { url: data.url, expiresAt: Number(data.expiresAt) || (Date.now() + 60000) });
          return data.url;
        } catch {
          return fallback;
        }
      };
    })(),
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
    // NOTE: creating/updating a resource uploads a file, so it goes through
    // StudyCoreAPI.uploadWithProgress (below) rather than request(). That is
    // the only path with a progress bar and upload stall detection — plain
    // fetch() cannot report progress, so no create/update wrapper lives here.
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
    // As above: publishing a resource uploads a file and therefore uses
    // StudyCoreAPI.uploadWithProgress, not request().
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

  /* ── Resumable chunked uploads ──────────────────────────────────────────
     THE PROBLEM THIS SOLVES

     uploadWithProgress (above) sends a whole file in ONE request. On the
     connections our uploaders actually have, that request dies constantly:
     the phone locks its screen and the browser suspends the transfer, the
     signal drops in a corridor, WiFi hands over to mobile data. Every one of
     those threw away 100% of the bytes already sent — a 300MB lecture video
     at 95% went straight back to 0%, over and over.

     Here the file is cut into chunks and each chunk is its own small request.
     The server records every chunk that lands (in SQLite, so it survives a
     restart), which means:

       · A failed chunk costs one chunk, not the whole file.
       · Closing the tab, losing signal or locking the phone pauses the upload
         instead of destroying it — reopening resumes from the last chunk.
       · The session id is remembered in localStorage and keyed by the file's
         name+size+mtime, so picking the same file again silently continues
         where it stopped rather than starting over.

     The final publish request then carries an `uploadSessionId` instead of the
     file bytes, so it is small and fast even for a huge video.
     ──────────────────────────────────────────────────────────────────────── */

  const RESUME_STORE_KEY = 'sc:resumable-uploads';
  const RESUME_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

  function readResumeStore() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(RESUME_STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }

  function writeResumeStore(store) {
    try {
      if (global.localStorage) global.localStorage.setItem(RESUME_STORE_KEY, JSON.stringify(store));
    } catch { /* private mode / quota: resuming is an optimisation, never required */ }
  }

  // Identifies a specific file well enough to match it against a stored
  // session, without reading its contents (which would defeat the point).
  function fileFingerprint(file) {
    return [file.name, file.size, file.lastModified || 0].join(':');
  }

  function rememberSession(file, session) {
    const store = readResumeStore();
    const cutoff = Date.now() - RESUME_ENTRY_TTL_MS;
    for (const key of Object.keys(store)) {
      if (!store[key] || store[key].savedAt < cutoff) delete store[key];
    }
    store[fileFingerprint(file)] = { id: session.id, savedAt: Date.now() };
    writeResumeStore(store);
  }

  function recallSession(file) {
    const entry = readResumeStore()[fileFingerprint(file)];
    if (!entry) return null;
    if (Date.now() - entry.savedAt > RESUME_ENTRY_TTL_MS) return null;
    return entry.id;
  }

  function forgetSession(file) {
    const store = readResumeStore();
    delete store[fileFingerprint(file)];
    writeResumeStore(store);
  }

  // One chunk, as a bare PUT of the raw bytes. Returns a promise; rejects with
  // a network-flavoured error the caller can retry.
  function sendChunk(sessionId, partNumber, blob, onTick, signal) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/uploads/session/${encodeURIComponent(sessionId)}/part/${partNumber}`, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };

      if (signal) {
        if (signal.aborted) return finish(reject, networkError('Upload cancelled.', { cancelled: true }));
        signal.addEventListener('abort', () => {
          try { xhr.abort(); } catch { /* already gone */ }
          finish(reject, networkError('Upload cancelled.', { cancelled: true }));
        }, { once: true });
      }

      xhr.upload.onprogress = (event) => {
        if (onTick && event.lengthComputable) onTick(event.loaded);
      };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { data = null; }
        if (xhr.status >= 200 && xhr.status < 300) return finish(resolve, data);
        const err = new Error((data && data.message) || `Chunk upload failed (${xhr.status})`);
        err.status = xhr.status;
        // 4xx other than the retryable set is a real rejection (bad session,
        // wrong size); 5xx and network faults are worth another attempt.
        if (xhr.status >= 500 || RETRYABLE_STATUS.has(xhr.status)) err.network = true;
        finish(reject, err);
      };
      xhr.onerror = () => finish(reject, networkError('Connection lost while sending part of the file.', {
        offline: navigator.onLine === false
      }));
      xhr.ontimeout = () => finish(reject, networkError('That part of the upload timed out.', { timeout: true }));
      xhr.send(blob);
    });
  }

  // Upload `file` in resumable chunks, resuming a previous session when one
  // exists for this exact file. Resolves with the session id, which the caller
  // attaches to its publish request.
  //
  // onProgress(percent, info) matches uploadWithProgress so the existing
  // dashboards' progress UI needs no changes.
  StudyCoreAPI.uploadResumable = async function (file, onProgress, options = {}) {
    const signal = options.signal;
    const abortCheck = () => {
      if (signal && signal.aborted) throw networkError('Upload cancelled.', { cancelled: true });
    };

    // ── Get or resume a session ───────────────────────────────────────────
    let session = null;
    const remembered = recallSession(file);
    if (remembered) {
      try {
        const data = await request(`/api/uploads/session/${encodeURIComponent(remembered)}`, {
          timeoutMs: 12000, retries: 1
        });
        if (data && data.session && data.session.fileSize === file.size) {
          session = data.session;
        }
      } catch {
        // Expired or gone: fall through and start a fresh session.
        forgetSession(file);
      }
    }

    if (!session) {
      const created = await request('/api/uploads/session', {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || 'application/octet-stream',
          chunkSize: options.chunkSize
        })
      });
      session = created.session;
      rememberSession(file, session);
    }

    const { id, chunkSize, totalChunks } = session;
    const have = new Set(session.receivedParts || []);

    // Bytes already on the server do not need to be sent, and must still be
    // counted in the progress bar — otherwise a resumed upload looks like it
    // restarted, which is exactly the anxiety this feature removes.
    let baseBytes = 0;
    have.forEach((part) => {
      baseBytes += part === totalChunks - 1 ? file.size - (chunkSize * part) : chunkSize;
    });

    const startedAt = Date.now();
    let speedBps = 0;
    let lastTick = startedAt;
    let lastBytes = baseBytes;

    const report = (sentBytes) => {
      if (!onProgress) return;
      const loaded = Math.min(file.size, sentBytes);
      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      if (dt >= 0.25) {
        const instant = (loaded - lastBytes) / dt;
        speedBps = speedBps ? (speedBps * 0.7) + (instant * 0.3) : instant;
        lastBytes = loaded;
        lastTick = now;
      }
      const remaining = file.size - loaded;
      onProgress(Math.round((loaded / file.size) * 100), {
        loaded,
        total: file.size,
        bytesPerSecond: Math.max(0, Math.round(speedBps)),
        etaSeconds: speedBps > 0 ? Math.round(remaining / speedBps) : null,
        elapsedSeconds: Math.round((now - startedAt) / 1000),
        resumed: baseBytes > 0,
        chunk: null
      });
    };

    report(baseBytes);

    // ── Send the missing chunks, one at a time ────────────────────────────
    // Sequential on purpose: parallel chunks compete for a thin uplink, make
    // the ETA meaningless and multiply the damage of a dropout.
    let sentBytes = baseBytes;
    for (let part = 0; part < totalChunks; part += 1) {
      if (have.has(part)) continue;
      abortCheck();

      const start = part * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const blob = file.slice(start, end);
      const chunkBytes = end - start;

      // Per-chunk retry with backoff. Because a chunk is small, retrying it is
      // cheap — this is what turns a flaky connection into a slow one rather
      // than a failed one.
      let attempt = 0;
      const maxChunkAttempts = 5;
      for (;;) {
        try {
          await sendChunk(id, part, blob, (loadedInChunk) => {
            report(sentBytes + Math.min(loadedInChunk, chunkBytes));
          }, signal);
          break;
        } catch (err) {
          if (err.cancelled) throw err;
          attempt += 1;
          const fatal = !err.network && err.status && err.status < 500;
          if (fatal || attempt >= maxChunkAttempts) {
            // The session and its landed chunks stay on the server, so trying
            // again later resumes instead of restarting. Say so.
            err.resumable = true;
            err.sessionId = id;
            if (!err.status) {
              err.message = navigator.onLine === false
                ? 'Upload paused — you are offline. It will continue from where it stopped when you reconnect.'
                : 'Upload paused. Your progress is saved — try again and it will continue from where it stopped.';
            }
            throw err;
          }
          setDegraded(true);
          if (navigator.onLine === false) await waitForConnection(NET.OFFLINE_GRACE_MS * 2);
          else await sleep(NET.BACKOFF_MS * Math.pow(2, attempt - 1) + Math.random() * 400);
        }
      }

      setDegraded(false);
      sentBytes += chunkBytes;
      report(sentBytes);
    }

    report(file.size);
    return { sessionId: id, fileName: file.name, fileSize: file.size, resumed: baseBytes > 0 };
  };

  // Publish (or update) a resource whose bytes are already on the server as a
  // finished resumable session. The form data carries the session id instead
  // of the file, so this request is tiny no matter how big the video was.
  StudyCoreAPI.completeResumableUpload = function (url, method, formData, sessionId) {
    formData.delete('file');
    formData.append('uploadSessionId', sessionId);
    // Assembling chunks into the final object (and, on R2, re-uploading it)
    // happens inside this request, so it gets the generous finalize window
    // rather than the ordinary JSON timeout.
    return StudyCoreAPI.uploadWithProgress(url, method, formData, null, {
      stallMs: NET.UPLOAD_FINALIZE_MS
    });
  };

  StudyCoreAPI.forgetResumableSession = function (file) {
    if (file) forgetSession(file);
  };

  StudyCoreAPI.cancelResumableSession = function (sessionId, file) {
    if (file) forgetSession(file);
    if (!sessionId) return Promise.resolve();
    return request(`/api/uploads/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      .catch(() => { /* the sweeper reclaims it anyway */ });
  };

  // Files at or above this size take the chunked path. Below it, a single
  // request is simpler and usually finishes inside one screen-on window.
  StudyCoreAPI.RESUMABLE_THRESHOLD_BYTES = 8 * 1024 * 1024;

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
