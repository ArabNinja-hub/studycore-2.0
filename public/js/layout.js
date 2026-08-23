// =============================================
// STUDYCORE — Shared Layout (js/layout.js)
// -----------------------------------------------
// Renders the top bar, navbar, mobile navigation,
// account menu, global search overlay and footer
// for every public + student page, so the
// navigation philosophy is consistent in exactly
// one place. Pages opt in with <body data-page="…">
// and a placeholder element for the footer.
//
// Navigation model (learning-first, LMS-style):
//   Logo/Home · Courses · Resources · Announcements · About · [Search] · [Dashboard] · [Profile/Login]
// The global navigation stays intentionally small. Video lessons are opened
// from a course home rather than competing with Courses as a second route to
// the same content.
// =============================================

(function (global) {
  'use strict';

  const WHATSAPP_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb6sMBVIiRp0rg5RKQ2k';
  const SITE = 'https://studycore.academy/';

  const NAV_LINKS = [
    { id: 'courses', label: 'Courses', href: '/pages/courses.html', icon: 'library' },
    { id: 'resources', label: 'Resources', href: '/pages/resources.html', icon: 'file-text' },
    { id: 'announcements', label: 'Announcements', href: '/pages/announcements.html', icon: 'bell' },
    { id: 'about', label: 'About', href: '/pages/about.html', icon: 'info' }
  ];

  function currentPage() {
    return document.body.dataset.page || '';
  }

  function isActive(id) {
    const page = currentPage();
    if (id === 'courses') return ['courses', 'course', 'lesson', 'videos'].includes(page);
    return page === id;
  }

  /* ── Top announcement bar ───────────────── */
  function renderTopBar() {
    const host = document.getElementById('topBarHost');
    if (!host) return;
    if (sessionStorage.getItem('sc_topbar_dismissed')) { host.remove(); return; }
    host.className = 'top-bar';
    host.innerHTML = `
      <span>${SC.icon('sparkles', { size: 14 })} StudyCore Premium — video lessons, study notes and past papers, all in one place.</span>
      <a href="/pages/pricing.html">See Premium</a>
      <button class="top-bar-close" aria-label="Dismiss announcement">${SC.icon('x', { size: 15 })}</button>
    `;
    host.querySelector('.top-bar-close').addEventListener('click', () => {
      sessionStorage.setItem('sc_topbar_dismissed', '1');
      host.remove();
    });
  }

  /* ── Navbar ─────────────────────────────── */
  function accountMenuHtml(user) {
    const label = StudyCoreAuth.subscriptionLabel(user);
    const badgeCls = { premium: 'badge-amber', trial: '', pending: 'badge-amber', expired: 'badge-red' }[label.cls] || '';
    const adminLink = StudyCoreAuth.isAdmin(user)
      ? `<a href="/admin.html">${SC.icon('settings', { size: 17 })} Admin Dashboard</a>`
      : '';
    return `
      <div class="account-menu">
        <button class="account-trigger" id="accountTrigger" aria-haspopup="true" aria-expanded="false">
          ${StudyCoreAuth.avatarHtml(user)}
          ${SC.icon('chevron-down', { size: 15 })}
        </button>
        <div class="account-panel" id="accountPanel">
          <div class="account-panel-head">
            ${StudyCoreAuth.avatarHtml(user)}
            <div style="min-width:0;">
              <strong>${escapeHtml(user.name)}</strong>
              <span style="display:flex;align-items:center;gap:6px;margin-top:3px;">
                <span class="badge ${badgeCls}" style="font-size:0.66rem;padding:2px 9px;">${SC.icon(label.icon, { size: 11 })}${label.label}</span>
              </span>
            </div>
          </div>
          <a href="/dashboard.html">${SC.icon('layout-dashboard', { size: 17 })} Dashboard</a>
          <a href="/dashboard.html#profile">${SC.icon('user', { size: 17 })} Profile &amp; photo</a>
          <a href="/dashboard.html#premium">${SC.icon('crown', { size: 17 })} Premium &amp; billing</a>
          <a href="/dashboard.html#community">${SC.icon('message-circle', { size: 17 })} Community</a>
          ${adminLink}
          <button type="button" class="danger" id="accountLogout">${SC.icon('log-out', { size: 17 })} Log Out</button>
        </div>
      </div>
    `;
  }

  function renderNav() {
    const host = document.getElementById('siteNav');
    if (!host) return;
    const linksHtml = NAV_LINKS.map((l) => {
      const active = isActive(l.id);
      return `<li><a href="${l.href}"${active ? ' class="active" aria-current="page"' : ''}>${l.label}</a></li>`;
    }).join('');

    host.className = 'navbar';
    host.innerHTML = `
      <div class="container nav-inner">
        <a href="/" class="nav-brand" aria-label="StudyCore home">
          <img src="/assets/logo-icon.jpg" alt="" width="38" height="38" />
          <span class="nav-brand-text"><em>Study</em>Core</span>
        </a>
        <ul class="nav-links">${linksHtml}</ul>
        <div class="nav-actions" id="navActions">
          <button class="icon-btn nav-search-btn" id="navSearchBtn" aria-label="Search StudyCore">${SC.icon('search', { size: 19 })}</button>
          <span id="navAuthSlot" aria-live="polite"></span>
        </div>
        <button class="icon-btn hamburger" id="hamburgerBtn" aria-label="Open menu" aria-expanded="false">${SC.icon('menu', { size: 22 })}</button>
      </div>
    `;
    bindNavSearch();
  }

  async function renderNavAuth() {
    const slot = document.getElementById('navAuthSlot');
    if (!slot) return;
    const user = await StudyCoreAuth.fetchSession();
    if (user) {
      const dashHref = StudyCoreAuth.getDashboardPage(user);
      slot.innerHTML = `
        <a class="btn btn-outline btn-sm" href="${dashHref}">${SC.icon('layout-dashboard', { size: 15 })} Dashboard</a>
        ${accountMenuHtml(user)}
      `;
      bindAccountMenu();
    } else {
      slot.innerHTML = `
        <a class="btn btn-ghost btn-sm" href="/login.html">Log In</a>
        <a class="btn btn-primary btn-sm" href="/signup.html">Get Started</a>
      `;
    }
  }

  function bindAccountMenu() {
    const trigger = document.getElementById('accountTrigger');
    const panel = document.getElementById('accountPanel');
    if (!trigger || !panel) return;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = panel.classList.toggle('open');
      trigger.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target) && e.target !== trigger) panel.classList.remove('open');
    });
    const logout = document.getElementById('accountLogout');
    if (logout) logout.addEventListener('click', StudyCoreAuth.logoutUser);
  }

  /* ── Mobile navigation ──────────────────── */
  function renderMobileNav() {
    const host = document.getElementById('mobileNavHost');
    if (!host) return;
    const activeAttrs = (id) => isActive(id) ? ' class="active" aria-current="page"' : '';
    host.innerHTML = `
      <div class="nav-backdrop" id="navBackdrop"></div>
      <nav class="mobile-nav" id="mobileNav" aria-label="Main navigation" aria-hidden="true">
        <div class="mobile-nav-label">Study</div>
        <a href="/pages/courses.html"${activeAttrs('courses')}>${SC.icon('library', { size: 20 })} Courses</a>
        <a href="/pages/resources.html"${activeAttrs('resources')}>${SC.icon('file-text', { size: 20 })} Resources</a>
        <button type="button" id="mobileSearchBtn" data-close-mobile>${SC.icon('search', { size: 20 })} Search</button>
        <a href="/dashboard.html" id="mobileDashLink" style="display:none;">${SC.icon('layout-dashboard', { size: 20 })} Dashboard</a>
        <a href="/admin.html" id="mobileAdminLink" style="display:none;">${SC.icon('settings', { size: 20 })} Admin Dashboard</a>
        <div class="mobile-nav-divider"></div>
        <div class="mobile-nav-label">More</div>
        <a href="/pages/announcements.html"${activeAttrs('announcements')}>${SC.icon('bell', { size: 20 })} Announcements</a>
        <a href="/pages/pricing.html">${SC.icon('crown', { size: 20 })} Premium</a>
        <a href="/pages/about.html"${activeAttrs('about')}>${SC.icon('info', { size: 20 })} About StudyCore</a>
        <div class="mobile-nav-divider"></div>
        <div class="mobile-nav-label">Account</div>
        <div id="mobileAuthSlot"></div>
      </nav>
    `;
    const searchBtn = document.getElementById('mobileSearchBtn');
    if (searchBtn) searchBtn.addEventListener('click', () => openSearchOverlay());
  }

  async function renderMobileNavAuth() {
    const slot = document.getElementById('mobileAuthSlot');
    if (!slot) return;
    const user = await StudyCoreAuth.fetchSession();
    if (user) {
      const dashLink = document.getElementById('mobileDashLink');
      if (dashLink) dashLink.style.display = 'flex';
      const adminLink = document.getElementById('mobileAdminLink');
      if (adminLink) adminLink.style.display = StudyCoreAuth.isAdmin(user) ? 'flex' : 'none';
      slot.innerHTML = `
        <a href="/dashboard.html#profile">${SC.icon('user', { size: 20 })} Profile</a>
        <button type="button" id="mobileLogoutBtn" style="color:var(--red-600);">${SC.icon('log-out', { size: 20 })} Log Out</button>
      `;
      const lo = document.getElementById('mobileLogoutBtn');
      if (lo) lo.addEventListener('click', StudyCoreAuth.logoutUser);
    } else {
      slot.innerHTML = `
        <a href="/login.html">${SC.icon('user', { size: 20 })} Log In</a>
        <a href="/signup.html">${SC.icon('user-plus', { size: 20 })} Create Account</a>
      `;
    }
  }

  /* ── Global search overlay ──────────────── */
  const CAT_META = {
    video: { label: 'Video lesson', icon: 'video' },
    document: { label: 'Notes', icon: 'file-text' },
    tutorial: { label: 'Tutorial', icon: 'file-text' },
    past_paper: { label: 'Past paper', icon: 'file' }
  };

  function bindNavSearch() {
    const btn = document.getElementById('navSearchBtn');
    if (btn) btn.addEventListener('click', openSearchOverlay);
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        e.preventDefault();
        openSearchOverlay();
      }
      if (e.key === 'Escape') closeSearchOverlay();
    });
  }

  function openSearchOverlay() {
    let overlay = document.getElementById('searchOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'searchOverlay';
      overlay.className = 'search-overlay';
      overlay.innerHTML = `
        <div class="search-panel" role="dialog" aria-label="Search StudyCore">
          <div class="search-panel-bar">
            ${SC.icon('search', { size: 20 })}
            <input type="search" id="globalSearchInput" placeholder="Search courses, topics, lessons, past papers…" autocomplete="off" />
            <span class="kbd">Esc</span>
            <button class="icon-btn" id="globalSearchClose" aria-label="Close search">${SC.icon('x', { size: 18 })}</button>
          </div>
          <div class="search-results" id="searchResultsBody"></div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSearchOverlay(); });
      document.getElementById('globalSearchClose').addEventListener('click', closeSearchOverlay);
      let t;
      document.getElementById('globalSearchInput').addEventListener('input', (e) => {
        clearTimeout(t);
        t = setTimeout(() => runSearch(e.target.value), 260);
      });
    }
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('globalSearchInput').focus(), 60);
  }

  function closeSearchOverlay() {
    const overlay = document.getElementById('searchOverlay');
    if (overlay) overlay.classList.remove('open');
    if (!document.getElementById('mobileNav')?.classList.contains('open')) document.body.style.overflow = '';
  }

  async function runSearch(q) {
    const body = document.getElementById('searchResultsBody');
    if (!body) return;
    q = q.trim();
    if (!q) { body.innerHTML = `<p style="padding:22px;color:var(--muted);font-size:0.9rem;">Search across all of StudyCore — courses, topics, lessons, notes and past papers.</p>`; return; }
    body.innerHTML = '<div style="padding:20px;"><div class="skeleton skeleton-text w80"></div><div class="skeleton skeleton-text w60"></div><div class="skeleton skeleton-text w80"></div></div>';
    try {
      const data = await fetch(`/api/resources/search?q=${encodeURIComponent(q)}`, { credentials: 'include' }).then((r) => r.json());
      renderSearchResults(data);
    } catch {
      body.innerHTML = '<p style="padding:22px;color:var(--red-600);font-size:0.9rem;">Search is unavailable right now. Please try again.</p>';
    }
  }

  function renderSearchResults(data) {
    const body = document.getElementById('searchResultsBody');
    if (!body) return;
    const parts = [];

    const courseRows = (data.courses || []).map((c) => `
      <a class="search-result" href="/pages/subjects/${c.slug}.html">
        <span class="sr-icon">${SC.icon(SC.courseIcon(c.slug), { size: 18 })}</span>
        <span class="sr-body"><strong>${escapeHtml(c.subject)}</strong><span>Course</span></span>
        <span class="sr-type">Course</span>
      </a>`).join('');
    if (courseRows) parts.push(`<div class="search-result-group"><h4>Courses</h4>${courseRows}</div>`);

    const topicRows = (data.topics || []).map((t) => `
      <a class="search-result" href="/pages/subjects/${t.slug}.html#lesson-topic-${String(t.topic).toLowerCase().replace(/[^a-z0-9]+/g, '-')}">
        <span class="sr-icon">${SC.icon('layers', { size: 18 })}</span>
        <span class="sr-body"><strong>${escapeHtml(t.topic)}</strong><span>${escapeHtml(t.subject || '')} topic</span></span>
        <span class="sr-type">Topic</span>
      </a>`).join('');
    if (topicRows) parts.push(`<div class="search-result-group"><h4>Topics</h4>${topicRows}</div>`);

    const resultRows = (data.results || []).map((r) => {
      const meta = CAT_META[r.category] || { label: 'Resource', icon: 'file-text' };
      const where = [r.subject, r.topic].filter(Boolean).join(' · ');
      const locked = r.locked ? `<span class="sr-type" style="color:var(--amber-600);">${SC.icon('lock', { size: 11 })} Premium</span>` : '';
      return `
      <a class="search-result" href="${SC.resourceHref(r)}">
        <span class="sr-icon">${SC.icon(meta.icon, { size: 18 })}</span>
        <span class="sr-body"><strong>${escapeHtml(r.title)}</strong><span>${escapeHtml(where)}</span></span>
        ${locked}<span class="sr-type">${meta.label}</span>
      </a>`;
    }).join('');
    if (resultRows) parts.push(`<div class="search-result-group"><h4>Lessons &amp; resources</h4>${resultRows}</div>`);

    if (!data.authenticated && (data.results || []).length === 0 && !courseRows && !topicRows) {
      parts.push(`<p style="padding:22px;color:var(--muted);font-size:0.9rem;">No matches for “${escapeHtml(data.query)}”. Try a course name like “Physics” or a topic like “Circular Motion”.</p>`);
    } else if (!data.authenticated) {
      parts.push(`<div class="search-result-group"><a class="search-result" href="/login.html" style="justify-content:center;font-weight:600;color:var(--teal-600);">${SC.icon('user', { size: 17 })} Log in to search lessons and resources</a></div>`);
    } else if (parts.length === 0) {
      parts.push(`<p style="padding:22px;color:var(--muted);font-size:0.9rem;">No results for “${escapeHtml(data.query)}”. Try a different keyword.</p>`);
    }
    body.innerHTML = parts.join('') || '<p style="padding:22px;color:var(--muted);font-size:0.9rem;">No results found.</p>';
  }

  /* ── Footer ─────────────────────────────── */
  function renderFooter() {
    const host = document.getElementById('siteFooter');
    if (!host) return;
    host.className = 'footer';
    host.innerHTML = `
      <div class="container">
        <div class="footer-grid">
          <div>
            <div class="footer-brand-row">
              <img src="/assets/logo-icon.jpg" alt="StudyCore" width="42" height="42" />
              <span><em>Study</em>Core</span>
            </div>
            <p>StudyCore is a modern university learning platform that brings courses, lessons, study notes, video learning, past papers and revision resources together in one place — helping university students learn smarter and stay on track.</p>
            <p style="margin-top:10px;font-size:0.8rem;">${SITE} is the official StudyCore website.</p>
          </div>
          <div>
            <h4>Study</h4>
            <ul class="footer-links">
              <li><a href="/pages/courses.html">Explore Courses</a></li>
              <li><a href="/pages/resources.html">Open Resources</a></li>
              <li><a href="/pages/resources.html?type=past_paper">View Past Papers</a></li>
              <li><a href="/pages/announcements.html">Announcements</a></li>
              <li><a href="/pages/search.html">Search</a></li>
            </ul>
          </div>
          <div>
            <h4>Account</h4>
            <ul class="footer-links">
              <li><a href="/login.html">Log In</a></li>
              <li><a href="/signup.html">Create Account</a></li>
              <li><a href="/pages/pricing.html">StudyCore Premium</a></li>
              <li><a href="/dashboard.html">Student Dashboard</a></li>
            </ul>
          </div>
          <div id="footerCommunity">
            <h4>Stay Connected</h4>
            <p style="margin-bottom:12px;">Follow the official academic channel for tips, mentoring and updates.</p>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <a class="btn whatsapp-btn btn-sm" href="${WHATSAPP_CHANNEL_URL}" target="_blank" rel="noopener">${SC.icon('whatsapp', { size: 16 })} Follow Channel</a>
              <a class="btn btn-outline btn-sm" id="footerGroupBtn" style="display:none;border-color:rgba(255,255,255,0.3);color:#fff;" target="_blank" rel="noopener">Join Group</a>
            </div>
          </div>
        </div>
        <div class="footer-bottom">
          <p>© ${new Date().getFullYear()} StudyCore · studycore.academy</p>
          <div class="footer-legal">
            <a href="/pages/terms.html">Terms &amp; Conditions</a>
            <a href="/pages/privacy.html">Privacy Policy</a>
            <a href="/pages/about.html">About</a>
          </div>
        </div>
      </div>
    `;
  }

  /* ── Official WhatsApp links ─────────────
     Fetched once from GET /api/config (owner-managed in .env). The channel
     URL is the official one; the group URL is the official group invite. */
  let whatsappPromise = null;
  function whatsappLinks() {
    if (!whatsappPromise) {
      whatsappPromise = fetch('/api/config', { credentials: 'include' })
        .then((r) => r.ok ? r.json() : null)
        .then((d) => ({
          channel: (d && d.whatsapp && d.whatsapp.channel) || WHATSAPP_CHANNEL_URL,
          group: (d && d.whatsapp && d.whatsapp.group) || ''
        }))
        .catch(() => ({ channel: WHATSAPP_CHANNEL_URL, group: '' }));
    }
    return whatsappPromise;
  }

  /* ── Community panel (channel + group links) ─ */
  function bindCommunityGroupBtn(host) {
    const groupBtn = host && host.querySelector('#communityGroupBtn');
    if (!groupBtn) return;
    whatsappLinks().then((links) => {
      if (links.group) {
        groupBtn.href = links.group;
        groupBtn.innerHTML = SC.icon('whatsapp', { size: 16 }) + ' Join the WhatsApp Group';
        groupBtn.style.display = '';
      }
    });
  }

  function renderCommunityPanel(host) {
    if (!host) return;
    host.classList.add('community-panel');
    host.innerHTML = `
      <div>
        <span class="badge badge-white" style="margin-bottom:14px;">${SC.icon('whatsapp', { size: 13 })} Official Academic Channel</span>
        <h2>Stay connected with StudyCore</h2>
        <p>Follow the official channel for academic tips, mentoring and updates — or join the student WhatsApp group.</p>
        <div class="community-actions">
          <a class="btn whatsapp-btn" href="${WHATSAPP_CHANNEL_URL}" target="_blank" rel="noopener">
            ${SC.icon('whatsapp', { size: 18 })} Follow on WhatsApp
          </a>
          <a class="btn btn-ghost" id="communityGroupBtn" style="display:none;color:#fff;border:1.5px solid rgba(255,255,255,0.28);" target="_blank" rel="noopener"></a>
        </div>
      </div>
    `;
    bindCommunityGroupBtn(host);
  }

  function ensureMobileMeta() {
    const vp = document.querySelector('meta[name="viewport"]');
    if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
    if (!document.querySelector('meta[name="theme-color"]')) {
      const theme = document.createElement('meta');
      theme.name = 'theme-color';
      theme.content = '#0b2033';
      document.head.appendChild(theme);
    }
  }

  /* ── Boot ──────────────────────────────── */
  function init() {
    ensureMobileMeta();
    renderTopBar();
    renderNav();
    renderMobileNav();
    renderFooter();
    StudyCoreAuth.initMobileNav();
    renderNavAuth();
    renderMobileNavAuth();

    // Footer group button (official invite link from the server)
    whatsappLinks().then((links) => {
      const btn = document.getElementById('footerGroupBtn');
      if (btn && links.group) {
        btn.href = links.group;
        btn.style.display = '';
      }
    });
  }

  global.SCLayout = {
    init,
    openSearchOverlay,
    whatsappLinks,
    renderCommunityPanel,
    bindCommunityGroupBtn,
    WHATSAPP_CHANNEL_URL
  };

  document.addEventListener('DOMContentLoaded', init);
})(window);
