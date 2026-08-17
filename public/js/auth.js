// =============================================
// STUDYCORE — Session & Nav Module (js/auth.js)
// By Dr. Relentless | Stay Curious & Winning
// -----------------------------------------------
// Role is decided ONLY by the server (see middleware/auth.js -
// requireAuth always re-reads the role from the users table, never trusts
// the JWT payload alone). This file just asks the server "who am I?" via
// GET /api/auth/me and renders the nav / redirects accordingly. It cannot
// grant anyone admin access - it can only reflect what the server says.
// =============================================

(function (global) {
  'use strict';

  let cachedUser = null;
  let sessionChecked = false;
  let sessionPromise = null;

  function isAdmin(user) {
    return !!user && user.role === 'ADMIN';
  }

  // All app pages live at the site root when served (index.html, login.html,
  // signup.html) or are gated view routes (dashboard.html, admin.html) - both
  // are always reachable at the root path regardless of how deeply nested the
  // current page is (e.g. /pages/subjects/mathematics.html). Absolute paths
  // avoid the class of bug where a relative link resolves against the wrong
  // directory depth.
  function getPageLink(fileName) {
    return fileName === 'index.html' ? '/' : `/${fileName}`;
  }

  function getDashboardPage(user) {
    return isAdmin(user) ? getPageLink('admin.html') : getPageLink('dashboard.html');
  }

  async function fetchSession() {
    // If a check is already in flight (e.g. main.js's initPage kicked one
    // off a moment ago), reuse that same promise instead of firing a second
    // request and risking two different pieces of code reading the result
    // at two different times.
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      try {
        const data = await StudyCoreAPI.me();
        cachedUser = data.user;
      } catch {
        cachedUser = null;
      }
      sessionChecked = true;
      return cachedUser;
    })();
    const result = await sessionPromise;
    sessionPromise = null;
    return result;
  }

  function getCurrentUser() {
    return cachedUser;
  }

  function applyTheme(theme) {
    const resolved = theme || localStorage.getItem('studycore_theme') || 'light';
    document.body.dataset.theme = resolved;
    localStorage.setItem('studycore_theme', resolved);
    const toggle = document.getElementById('themeToggle');
    if (toggle) toggle.textContent = resolved === 'dark' ? '☀️' : '🌙';
  }

  async function logoutUser() {
    try { await StudyCoreAPI.logout(); } catch { /* ignore network errors on logout */ }
    cachedUser = null;
    window.location.href = getPageLink('index.html');
  }

  function updateAuthUI() {
    const navActions = document.querySelector('.nav-actions');
    if (!navActions) return;

    const themeControl = document.createElement('button');
    themeControl.id = 'themeToggle';
    themeControl.className = 'btn btn-outline btn-sm';
    themeControl.type = 'button';
    themeControl.setAttribute('aria-label', 'Toggle theme');
    themeControl.addEventListener('click', () => {
      applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark');
    });

    navActions.innerHTML = '';
    navActions.appendChild(themeControl);

    if (cachedUser) {
      const dashboardLink = isAdmin(cachedUser)
        ? `<a class="btn btn-outline btn-sm" href="${getPageLink('admin.html')}">Admin Dashboard</a>`
        : `<a class="btn btn-outline btn-sm" href="${getPageLink('dashboard.html')}">Dashboard</a>`;
      navActions.insertAdjacentHTML('beforeend', `
        ${dashboardLink}
        <button id="logoutBtn" class="btn btn-primary btn-sm" type="button">Log Out</button>
      `);
      document.getElementById('logoutBtn')?.addEventListener('click', logoutUser);
    } else {
      navActions.insertAdjacentHTML('beforeend', `
        <a class="btn btn-outline btn-sm" href="${getPageLink('login.html')}">Log In</a>
        <a class="btn btn-primary btn-sm" href="${getPageLink('signup.html')}">Get Started</a>
      `);
    }

    applyTheme();
  }

  function showToast(message, type = 'info') {
    let container = document.getElementById('scToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'scToastContainer';
      container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:10px;max-width:340px;';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    const colors = { success: '#1A9E8F', error: '#D64545', info: '#1A3A5C' };
    toast.textContent = message;
    toast.style.cssText = `background:${colors[type] || colors.info};color:#fff;padding:12px 16px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.2);font-size:0.9rem;font-weight:500;animation:sc-toast-in 0.25s ease;`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  if (!document.getElementById('scToastStyle')) {
    const style = document.createElement('style');
    style.id = 'scToastStyle';
    style.textContent = '@keyframes sc-toast-in { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }';
    document.head.appendChild(style);
  }

  // Every page includes this script, so wiring the mobile menu up here once
  // means it works everywhere automatically - no per-page JS needed. If a
  // page's navbar markup doesn't have a hamburger button yet, one is
  // created and inserted automatically so older/uncopied pages still work.
  function initMobileNav() {
    const navbar = document.querySelector('.navbar');
    const navInner = document.querySelector('.nav-inner');
    if (!navbar || !navInner) return;
    if (navbar.dataset.mobileNavReady === 'true') return; // never attach the click listener twice
    navbar.dataset.mobileNavReady = 'true';

    let hamburger = navbar.querySelector('.hamburger');
    if (!hamburger) {
      hamburger = document.createElement('button');
      hamburger.className = 'hamburger';
      hamburger.type = 'button';
      hamburger.setAttribute('aria-label', 'Toggle menu');
      hamburger.innerHTML = '<span></span><span></span><span></span>';
      navInner.appendChild(hamburger);
    }

    hamburger.addEventListener('click', () => {
      navbar.classList.toggle('nav-open');
    });

    // Tapping any link inside the open mobile menu should close it, rather
    // than leaving the panel open over the page the person just navigated
    // to (or leaving it awkwardly open if they tapped a link that reloads
    // the same page, e.g. an anchor).
    navbar.addEventListener('click', (e) => {
      if (e.target.tagName === 'A' && navbar.classList.contains('nav-open')) {
        navbar.classList.remove('nav-open');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', initMobileNav);

  // Shown exactly once, right after a successful login - never on regular
  // page navigation. login.html sets a sessionStorage flag right before
  // redirecting; the destination page (dashboard.html/admin.html) checks
  // for it once on load via consumeWelcomeFlag() below, which immediately
  // removes the flag so refreshing or navigating back never retriggers it.
  const WELCOME_FLAG_KEY = 'sc_show_welcome';

  function setWelcomeFlag(name, type) {
    try { sessionStorage.setItem(WELCOME_FLAG_KEY, JSON.stringify({ name: name || '', type: type || 'login' })); } catch { /* storage unavailable - transition just won't show, not fatal */ }
  }

  function consumeWelcomeFlag() {
    try {
      const raw = sessionStorage.getItem(WELCOME_FLAG_KEY);
      sessionStorage.removeItem(WELCOME_FLAG_KEY);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        // Backward compatible with the old plain-string format, in case a
        // flag was set by an older cached copy of login.html mid-deploy.
        return { name: raw, type: 'login' };
      }
    } catch {
      return null;
    }
  }

  function showWelcomeTransition(name, type) {
    return new Promise((resolve) => {
      const firstName = (name || 'there').split(' ')[0];
      const safeName = typeof escapeHtml === 'function' ? escapeHtml(firstName) : firstName;
      const firstMessage = type === 'signup' ? 'Welcome to StudyCore!' : `Welcome back, ${safeName}`;

      const overlay = document.createElement('div');
      overlay.className = 'welcome-transition-overlay';
      overlay.innerHTML = `
        <img src="/assets/logo.jpg" alt="StudyCore" class="welcome-transition-logo" />
        <div class="welcome-transition-text" id="welcomeTransitionText"><span>${firstMessage}</span></div>
        <div class="welcome-transition-dots"><span></span><span></span><span></span></div>
      `;
      document.body.appendChild(overlay);
      // Added and faded in on the next frame so the CSS transition actually
      // runs, rather than starting at opacity:1 with nothing to animate from.
      requestAnimationFrame(() => overlay.classList.add('visible'));

      setTimeout(() => {
        const textEl = document.getElementById('welcomeTransitionText');
        if (textEl) textEl.innerHTML = '<span>Preparing your learning space…</span>';
      }, 900);

      setTimeout(() => overlay.classList.add('leaving'), 1800);

      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 2300);
    });
  }

  global.StudyCoreAuth = {
    isAdmin,
    getPageLink,
    getDashboardPage,
    fetchSession,
    getCurrentUser,
    updateAuthUI,
    logoutUser,
    applyTheme,
    showToast,
    setWelcomeFlag,
    consumeWelcomeFlag,
    showWelcomeTransition,
    get sessionChecked() { return sessionChecked; }
  };

  global.showToast = showToast; // convenience global used by page scripts
})(window);
