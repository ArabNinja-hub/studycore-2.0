// =============================================
// STUDYCORE — Session & UI State (js/auth.js)
// -----------------------------------------------
// Role is decided ONLY by the server (see middleware/auth.js -
// requireAuth always re-reads the role from the users table, never trusts
// the JWT payload alone). This file just asks the server "who am I?" via
// GET /api/auth/me and renders the UI accordingly. It cannot grant anyone
// access - it can only reflect what the server says.
// =============================================

(function (global) {
  'use strict';

  let cachedUser = null;
  let sessionChecked = false;
  let sessionPromise = null;
  let sessionUnknown = false; // true when the last check failed on the network

  function normalizedRole(user) {
    return String((user && user.role) || '').trim().toLowerCase();
  }

  function isAdmin(user) {
    return normalizedRole(user) === 'admin';
  }

  function isContentAdmin(user) {
    return normalizedRole(user) === 'content_admin';
  }

  function isStudent(user) {
    return normalizedRole(user) === 'student';
  }

  // All app pages are reachable at fixed root paths (/login.html,
  // /dashboard.html, /pages/...). Absolute paths avoid the class of bug
  // where a relative link resolves against the wrong directory depth.
  function getPageLink(fileName) {
    return `/${fileName}`;
  }

  function getDashboardPage(user) {
    if (isAdmin(user)) return getPageLink('admin.html');
    if (isContentAdmin(user)) return getPageLink('content-admin.html');
    return getPageLink('dashboard.html');
  }

  async function fetchSession(options = {}) {
    // If a check is already in flight, reuse that same promise instead of
    // firing a second request and risking two different pieces of code
    // reading the result at two different times.
    if (sessionPromise) return sessionPromise;
    if (options.force) { sessionChecked = false; sessionUnknown = false; }
    sessionPromise = (async () => {
      try {
        const data = await StudyCoreAPI.me();
        cachedUser = data.user;
        sessionChecked = true;
        sessionUnknown = false;
      } catch (err) {
        // A 401 is a real answer: this visitor is signed out.
        // A dropped connection is NOT — treating it as "signed out" is what
        // makes a site feel unreliable on mobile (the student watches their
        // account disappear in a lift). Keep the last known state, flag the
        // session as unverified, and let the reconnect handler re-check.
        if (err && err.network) {
          sessionUnknown = true;
        } else {
          cachedUser = null;
          sessionChecked = true;
          sessionUnknown = false;
        }
      }
      return cachedUser;
    })();
    const result = await sessionPromise;
    sessionPromise = null;
    return result;
  }

  // True when we could not reach the server, so the rendered auth state is a
  // best guess rather than a fact.
  function isSessionUnverified() {
    return sessionUnknown;
  }

  // The connection came back: confirm who the student is and let the page
  // re-render its account chrome, rather than leaving stale/guessed state.
  if (global.SC && SC.net && typeof SC.net.onReconnect === 'function') {
    SC.net.onReconnect(async () => {
      if (!sessionUnknown && sessionChecked) return;
      await fetchSession({ force: true });
      try {
        global.dispatchEvent(new CustomEvent('sc:session:refreshed', { detail: { user: cachedUser } }));
      } catch { /* events are a nice-to-have */ }
    });
  }

  function getCurrentUser() {
    return cachedUser;
  }

  function applyTheme(theme) {
    const resolved = theme || localStorage.getItem('studycore_theme') || 'light';
    document.body.dataset.theme = resolved;
    localStorage.setItem('studycore_theme', resolved);
  }

  async function logoutUser() {
    try { await StudyCoreAPI.logout(); } catch { /* ignore network errors on logout */ }
    cachedUser = null;
    window.location.href = '/';
  }

  // Human label + icon for the server's subscription state.
  function subscriptionLabel(user) {
    const s = (user && user.subscriptionStatus) || {};
    switch (s.state) {
      case 'premium_active': return { label: 'Premium Active', icon: 'crown', cls: 'premium' };
      case 'trial_active': return { label: `Free Trial · ${s.trialDaysLeft || 0} days left`, icon: 'sparkles', cls: 'trial' };
      case 'payment_pending': return { label: 'Payment Pending', icon: 'clock', cls: 'pending' };
      case 'premium_expired': return { label: 'Premium Expired', icon: 'lock', cls: 'expired' };
      case 'not_applicable': return { label: 'Content Admin', icon: 'shield', cls: 'trial' };
      default: return { label: 'Trial Expired', icon: 'lock', cls: 'expired' };
    }
  }

  // Avatar markup: real picture when one exists, otherwise a professional
  // User-icon circle (never an emoji).
  function avatarHtml(user, sizeCls) {
    const cls = `avatar ${sizeCls || ''}`;
    if (user && user.hasAvatar) {
      return `<img class="${cls}" src="${StudyCoreAPI.avatarUrl()}" alt="" />`;
    }
    const initials = user && user.name
      ? user.name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('')
      : '';
    const inner = SC.icon('user', { size: sizeCls === 'avatar-lg' ? 30 : 17, stroke: 2 });
    return `<span class="${cls} avatar-fallback">${inner}</span>`;
  }

  /* ── Toasts ─────────────────────────────── */
  const TOAST_ICONS = { success: 'check-circle', error: 'alert-triangle', info: 'info' };

  function showToast(message, type = 'info') {
    let container = document.getElementById('scToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'scToastContainer';
      container.setAttribute('role', 'status');
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `sc-toast ${type}`;
    toast.innerHTML = `${SC.icon(TOAST_ICONS[type] || 'info', { size: 18 })}<span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity 0.3s';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 320);
    }, 4200);
  }

  /* ── Body scroll lock (iOS-safe) ─────────────
     `body { overflow: hidden }` alone does NOT stop iOS Safari scrolling
     the page behind a drawer — the classic "I opened the menu and the
     article moved" bug that makes a site feel broken on a phone. Pinning
     the body and restoring the exact scroll position on release does.

     Locks are keyed, so the drawer, the search overlay and a modal can be
     open in any combination without one of them releasing another's lock. */
  const scrollLocks = new Set();
  let lockedScrollY = 0;

  function applyScrollLock() {
    lockedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const body = document.body;
    body.style.position = 'fixed';
    body.style.top = `-${lockedScrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    body.classList.add('is-scroll-locked');
  }

  function releaseScrollLock() {
    const body = document.body;
    body.style.position = '';
    body.style.top = '';
    body.style.left = '';
    body.style.right = '';
    body.style.width = '';
    body.style.overflow = '';
    body.classList.remove('is-scroll-locked');
    // Jump straight back — an animated restore reads as a glitch.
    const behavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, lockedScrollY);
    document.documentElement.style.scrollBehavior = behavior;
  }

  function setScrollLock(key, locked) {
    const was = scrollLocks.size > 0;
    if (locked) scrollLocks.add(key);
    else scrollLocks.delete(key);
    const now = scrollLocks.size > 0;
    if (was === now) return;
    now ? applyScrollLock() : releaseScrollLock();
  }

  global.SC = global.SC || {};
  SC.setScrollLock = setScrollLock;

  /* ── Mobile navigation (wired once, works on every page) ── */
  function initMobileNav() {
    const hamburger = document.getElementById('hamburgerBtn');
    const menu = document.getElementById('mobileNav');
    const backdrop = document.getElementById('navBackdrop');
    if (!hamburger || !menu) return;

    let lastFocused = null;
    const setOpen = (open, { restoreFocus = true } = {}) => {
      if (open) lastFocused = document.activeElement;
      menu.classList.toggle('open', open);
      menu.setAttribute('aria-hidden', String(!open));
      if ('inert' in menu) menu.inert = !open;
      if (backdrop) backdrop.classList.toggle('open', open);
      setScrollLock('mobile-nav', open);
      hamburger.setAttribute('aria-expanded', String(open));
      hamburger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      if (typeof SC !== 'undefined') hamburger.innerHTML = SC.icon(open ? 'x' : 'menu', { size: 22 });

      if (open) {
        setTimeout(() => menu.querySelector('a, button')?.focus(), 40);
      } else if (restoreFocus && lastFocused && document.contains(lastFocused)) {
        lastFocused.focus();
      }
    };

    setOpen(false, { restoreFocus: false });
    hamburger.addEventListener('click', () => setOpen(!menu.classList.contains('open')));
    if (backdrop) backdrop.addEventListener('click', () => setOpen(false));
    menu.addEventListener('click', (event) => {
      if (event.target.closest('a, button[data-close-mobile]')) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.classList.contains('open')) setOpen(false);
      if (event.key !== 'Tab' || !menu.classList.contains('open')) return;
      const focusable = [...menu.querySelectorAll('a, button:not([disabled])')]
        .filter((el) => !el.hidden && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        hamburger.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        hamburger.focus();
      } else if (document.activeElement === hamburger) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    });
    const desktopMedia = window.matchMedia('(min-width: 901px)');
    const closeAtDesktop = (event) => {
      if (event.matches) setOpen(false, { restoreFocus: false });
    };
    if (desktopMedia.addEventListener) desktopMedia.addEventListener('change', closeAtDesktop);
    else desktopMedia.addListener(closeAtDesktop); // Older iOS Safari.

  }

  /* ── Post-login welcome transition ──────── */
  const WELCOME_FLAG_KEY = 'sc_show_welcome';

  function setWelcomeFlag(name, type) {
    try { sessionStorage.setItem(WELCOME_FLAG_KEY, JSON.stringify({ name: name || '', type: type || 'login' })); } catch { /* not fatal */ }
  }

  function consumeWelcomeFlag() {
    try {
      const raw = sessionStorage.getItem(WELCOME_FLAG_KEY);
      sessionStorage.removeItem(WELCOME_FLAG_KEY);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return { name: raw, type: 'login' }; }
    } catch { return null; }
  }

  function showWelcomeTransition(name, type) {
    return new Promise((resolve) => {
      const firstName = (name || 'there').split(' ')[0];
      const safeName = escapeHtml(firstName);
      const firstMessage = type === 'signup' ? 'Welcome to StudyCore' : `Welcome back, ${safeName}`;

      const overlay = document.createElement('div');
      overlay.className = 'welcome-transition-overlay';
      overlay.innerHTML = `
        <img src="/assets/logo.jpg" alt="StudyCore" class="welcome-transition-logo" />
        <div class="welcome-transition-text" id="welcomeTransitionText"><span>${firstMessage}</span></div>
        <div class="welcome-transition-dots"><span></span><span></span><span></span></div>
      `;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('visible'));

      setTimeout(() => {
        const textEl = document.getElementById('welcomeTransitionText');
        if (textEl) textEl.innerHTML = '<span>Preparing your learning space…</span>';
      }, 900);

      setTimeout(() => overlay.classList.add('leaving'), 1800);
      setTimeout(() => { overlay.remove(); resolve(); }, 2300);
    });
  }

  global.StudyCoreAuth = {
    normalizedRole,
    isAdmin,
    isContentAdmin,
    isStudent,
    getPageLink,
    getDashboardPage,
    fetchSession,
    getCurrentUser,
    logoutUser,
    applyTheme,
    subscriptionLabel,
    avatarHtml,
    setWelcomeFlag,
    consumeWelcomeFlag,
    showWelcomeTransition,
    initMobileNav,
    isSessionUnverified,
    get sessionChecked() { return sessionChecked; }
  };

  global.showToast = showToast; // convenience global used by page scripts
})(window);
