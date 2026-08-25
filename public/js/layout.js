// =============================================
// STUDYCORE — Shared Layout (js/layout.js)
// -----------------------------------------------
// Renders the navbar, flyout submenus, mobile
// navigation, account menu, global search overlay and
// footer for every public + student page.
//
// The chrome is intentionally quiet: one sticky island,
// no promotional top bar, no scroll progress bars, no
// floating docks. Navigation model (learning-first):
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

  /* ── Rich Flyout Submenus ───────────────── */
  function coursesDropdownHtml() {
    const subjects = [
      { slug: 'mathematics', name: 'Mathematics', icon: 'calculator', desc: 'Calculus, algebra & problem-solving' },
      { slug: 'physics', name: 'Physics', icon: 'atom', desc: 'Mechanics, waves & electricity' },
      { slug: 'chemistry', name: 'Chemistry', icon: 'flask', desc: 'Atoms, bonding & reactions' },
      { slug: 'biology', name: 'Biology', icon: 'dna', desc: 'Genetics, cells & physiology' },
      { slug: 'programming', name: 'Programming', icon: 'code', desc: 'Algorithms, data structures & logic' },
      { slug: 'communication', name: 'Communication Skills', icon: 'message', desc: 'Academic writing, speaking & clarity' }
    ];

    const cards = subjects.map((s) => `
      <a class="nav-dropdown-card" href="/pages/subjects/${s.slug}.html">
        <span class="nd-icon nd-icon-${s.slug}">${SC.icon(s.icon, { size: 18 })}</span>
        <div class="nd-content">
          <strong>${s.name}</strong>
          <span>${s.desc}</span>
        </div>
        <span class="nd-arrow">${SC.icon('chevron-right', { size: 14 })}</span>
      </a>
    `).join('');

    return `
      <div class="nav-dropdown nav-dropdown-courses" id="navDropdown_courses" role="region" aria-label="Courses submenu">
        <div class="nav-dropdown-inner">
          <div class="nav-dropdown-header">
            <span class="eyebrow">${SC.icon('library', { size: 13 })} University Courses</span>
            <p>Structured courses with video lectures, study notes, tutorials and past papers.</p>
          </div>
          <div class="nav-dropdown-grid">
            ${cards}
          </div>
          <div class="nav-dropdown-footer">
            <a href="/pages/courses.html" class="nd-footer-link">
              <span>View all 6 university course syllabus &amp; hubs</span>
              ${SC.icon('arrow-right', { size: 14 })}
            </a>
          </div>
        </div>
      </div>
    `;
  }

  function resourcesDropdownHtml() {
    const items = [
      { href: '/pages/resources.html?type=past_paper', icon: 'file', title: 'Past Papers', desc: 'Real exam papers with solutions & mark schemes' },
      { href: '/pages/resources.html?type=document', icon: 'file-text', title: 'Study Notes', desc: 'Concise lecture summaries & revision sheets' },
      { href: '/pages/courses.html', icon: 'video', title: 'Video Lessons', desc: 'Structured lectures inside course hubs' },
      { href: '/pages/resources.html?type=tutorial', icon: 'book-open', title: 'Tutorial Sheets', desc: 'Step-by-step problem sets & practice sheets' }
    ];

    const cards = items.map((it) => `
      <a class="nav-dropdown-card" href="${it.href}">
        <span class="nd-icon">${SC.icon(it.icon, { size: 18 })}</span>
        <div class="nd-content">
          <strong>${it.title}</strong>
          <span>${it.desc}</span>
        </div>
        <span class="nd-arrow">${SC.icon('chevron-right', { size: 14 })}</span>
      </a>
    `).join('');

    return `
      <div class="nav-dropdown nav-dropdown-resources" id="navDropdown_resources" role="region" aria-label="Resources submenu">
        <div class="nav-dropdown-inner">
          <div class="nav-dropdown-header">
            <span class="eyebrow">${SC.icon('file-text', { size: 13 })} Study Resources</span>
            <p>High-yield materials organized for quick revision and deep learning.</p>
          </div>
          <div class="nav-dropdown-grid nav-dropdown-grid-2">
            ${cards}
          </div>
          <div class="nav-dropdown-footer">
            <a href="/pages/resources.html" class="nd-footer-link">
              <span>Browse &amp; filter complete resource repository</span>
              ${SC.icon('arrow-right', { size: 14 })}
            </a>
          </div>
        </div>
      </div>
    `;
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
    let host = document.getElementById('siteNav');
    if (!host) {
      host = document.createElement('div');
      host.id = 'siteNav';
      document.body.prepend(host);
    }

    const linksHtml = NAV_LINKS.map((l) => {
      const active = isActive(l.id);
      const hasDrop = l.id === 'courses' || l.id === 'resources';
      const dropdownHtml = l.id === 'courses' ? coursesDropdownHtml() : (l.id === 'resources' ? resourcesDropdownHtml() : '');
      const chevronHtml = hasDrop ? `<span class="nav-chevron">${SC.icon('chevron-down', { size: 13 })}</span>` : '';
      return `
        <li class="nav-item ${hasDrop ? 'nav-item-has-dropdown' : ''}" data-nav-id="${l.id}">
          <a href="${l.href}" class="nav-link${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}${hasDrop ? ' aria-haspopup="true" aria-expanded="false"' : ''}>
            <span>${l.label}</span>${chevronHtml}
          </a>
          ${dropdownHtml}
        </li>
      `;
    }).join('');

    host.className = 'navbar';
    host.innerHTML = `
      <div class="container nav-inner">
        <a href="/" class="nav-brand" aria-label="StudyCore home">
          <img src="/assets/logo-icon.jpg" alt="" width="38" height="38" />
          <span class="nav-brand-text"><em>Study</em>Core</span>
        </a>
        <ul class="nav-links" id="navLinksList">
          ${linksHtml}
        </ul>
        <div class="nav-actions" id="navActions">
          <button class="icon-btn nav-search-btn" id="navSearchBtn" aria-label="Search StudyCore">${SC.icon('search', { size: 19 })}</button>
          <span id="navAuthSlot" aria-live="polite"></span>
        </div>
        <button class="icon-btn hamburger" id="hamburgerBtn" aria-label="Open menu" aria-expanded="false">${SC.icon('menu', { size: 22 })}</button>
      </div>
    `;
    bindNavSearch();
    bindNavDropdowns();
    bindScrollMorph();
  }

  /* ── Flyout Dropdown Hover & Focus Logic ─── */
  function bindNavDropdowns() {
    const items = document.querySelectorAll('.nav-item-has-dropdown');

    // The nav is a centred floating island, so a flyout anchored under a link
    // near either edge can spill outside the viewport. The panel is laid out
    // (but hidden) at all times, so we can measure it before it opens and
    // nudge it back inside the screen via --dd-shift (see style.css).
    function clampDropdownToViewport(dropdown) {
      const margin = 10;
      const rect = dropdown.getBoundingClientRect();
      if (rect.width === 0) return;
      let shift = 0;
      if (rect.left < margin) shift += margin - rect.left;
      else if (rect.right > window.innerWidth - margin) shift -= rect.right - (window.innerWidth - margin);
      dropdown.style.setProperty('--dd-shift', `${Math.round(shift)}px`);
    }

    items.forEach((item) => {
      const link = item.querySelector('.nav-link');
      const dropdown = item.querySelector('.nav-dropdown');
      if (!link || !dropdown) return;

      let closeTimer = null;

      const openDropdown = () => {
        clearTimeout(closeTimer);
        items.forEach((other) => {
          if (other !== item) {
            other.classList.remove('is-active-dropdown');
            other.querySelector('.nav-link')?.setAttribute('aria-expanded', 'false');
          }
        });
        clampDropdownToViewport(dropdown);
        item.classList.add('is-active-dropdown');
        link.setAttribute('aria-expanded', 'true');
      };

      const closeDropdown = () => {
        closeTimer = setTimeout(() => {
          item.classList.remove('is-active-dropdown');
          link.setAttribute('aria-expanded', 'false');
        }, 120);
      };

      item.addEventListener('mouseenter', openDropdown);
      item.addEventListener('mouseleave', closeDropdown);
      item.addEventListener('focusin', openDropdown);
      item.addEventListener('focusout', (e) => {
        if (!item.contains(e.relatedTarget)) closeDropdown();
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        items.forEach((it) => {
          it.classList.remove('is-active-dropdown');
          it.querySelector('.nav-link')?.setAttribute('aria-expanded', 'false');
        });
      }
    });

    // Re-clamp any open flyout when the viewport width changes.
    window.addEventListener('resize', () => {
      items.forEach((it) => {
        if (!it.classList.contains('is-active-dropdown')) return;
        const dd = it.querySelector('.nav-dropdown');
        if (dd) clampDropdownToViewport(dd);
      });
    }, { passive: true });
  }

  /* ── Header pinned state ─────────────────── */
  function bindScrollMorph() {
    const nav = document.getElementById('siteNav');
    if (!nav) return;

    let ticking = false;

    function onScroll() {
      const scrollY = window.scrollY || document.documentElement.scrollTop;
      if (scrollY > 16) {
        nav.classList.add('is-scrolled');
      } else {
        nav.classList.remove('is-scrolled');
      }
      ticking = false;
    }

    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(onScroll);
        ticking = true;
      }
    }, { passive: true });

    requestAnimationFrame(onScroll);
  }

  async function renderNavAuth() {
    const slot = document.getElementById('navAuthSlot');
    if (!slot) return;
    const user = await StudyCoreAuth.fetchSession();
    if (user) {
      const dashHref = StudyCoreAuth.getDashboardPage(user);
      slot.innerHTML = `
        <a class="btn btn-outline btn-sm btn-pill" href="${dashHref}">${SC.icon('layout-dashboard', { size: 15 })} Dashboard</a>
        ${accountMenuHtml(user)}
      `;
      bindAccountMenu();
    } else {
      slot.innerHTML = `
        <a class="btn btn-ghost btn-sm" href="/login.html">Log In</a>
        <a class="btn btn-primary btn-sm btn-pill" href="/signup.html">Get Started ${SC.icon('arrow-right', { size: 14 })}</a>
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

  /* ── Mobile navigation (Smooth Staggered Drawer) ─ */
  function renderMobileNav() {
    let host = document.getElementById('mobileNavHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'mobileNavHost';
      document.body.appendChild(host);
    }
    const activeAttrs = (id) => isActive(id) ? ' class="active" aria-current="page"' : '';

    const subjectList = [
      { slug: 'mathematics', name: 'Mathematics', icon: 'calculator' },
      { slug: 'physics', name: 'Physics', icon: 'atom' },
      { slug: 'chemistry', name: 'Chemistry', icon: 'flask' },
      { slug: 'biology', name: 'Biology', icon: 'dna' },
      { slug: 'programming', name: 'Programming', icon: 'code' },
      { slug: 'communication', name: 'Communication Skills', icon: 'message' }
    ];

    const subjectLinks = subjectList.map((s) => `
      <a href="/pages/subjects/${s.slug}.html" class="mobile-sub-link">
        ${SC.icon(s.icon, { size: 16 })} ${s.name}
      </a>
    `).join('');

    host.innerHTML = `
      <div class="nav-backdrop" id="navBackdrop"></div>
      <nav class="mobile-nav" id="mobileNav" aria-label="Main navigation" aria-hidden="true">
        <div class="mobile-nav-header">
          <div class="mobile-nav-brand">
            <img src="/assets/logo-icon.jpg" alt="" width="32" height="32" />
            <span><em>Study</em>Core</span>
          </div>
          <button class="icon-btn mobile-nav-close" id="mobileNavClose" aria-label="Close menu">${SC.icon('x', { size: 20 })}</button>
        </div>

        <div class="mobile-nav-search-wrap" style="--idx:0">
          <button type="button" class="mobile-search-pill" id="mobileSearchBtn" data-close-mobile>
            ${SC.icon('search', { size: 17 })}
            <span>Search courses, notes &amp; papers…</span>
            <span class="kbd">/</span>
          </button>
        </div>

        <div class="mobile-nav-label" style="--idx:1">Study</div>

        <!-- Courses Accordion -->
        <div class="mobile-accordion" style="--idx:2">
          <div class="mobile-accordion-header">
            <a href="/pages/courses.html"${activeAttrs('courses')}>${SC.icon('library', { size: 20 })} Courses</a>
            <button type="button" class="mobile-accordion-toggle" aria-expanded="false" aria-label="Toggle courses submenu">
              ${SC.icon('chevron-down', { size: 16 })}
            </button>
          </div>
          <div class="mobile-accordion-body">
            <div class="mobile-accordion-content">
              ${subjectLinks}
              <a href="/pages/courses.html" class="mobile-sub-link mobile-sub-all">
                ${SC.icon('arrow-right', { size: 15 })} View All Courses
              </a>
            </div>
          </div>
        </div>

        <!-- Resources Accordion -->
        <div class="mobile-accordion" style="--idx:3">
          <div class="mobile-accordion-header">
            <a href="/pages/resources.html"${activeAttrs('resources')}>${SC.icon('file-text', { size: 20 })} Resources</a>
            <button type="button" class="mobile-accordion-toggle" aria-expanded="false" aria-label="Toggle resources submenu">
              ${SC.icon('chevron-down', { size: 16 })}
            </button>
          </div>
          <div class="mobile-accordion-body">
            <div class="mobile-accordion-content">
              <a href="/pages/resources.html?type=past_paper" class="mobile-sub-link">${SC.icon('file', { size: 16 })} Past Papers</a>
              <a href="/pages/resources.html?type=document" class="mobile-sub-link">${SC.icon('file-text', { size: 16 })} Study Notes</a>
              <a href="/pages/resources.html?type=tutorial" class="mobile-sub-link">${SC.icon('book-open', { size: 16 })} Tutorial Sheets</a>
              <a href="/pages/resources.html" class="mobile-sub-link mobile-sub-all">${SC.icon('arrow-right', { size: 15 })} All Resources</a>
            </div>
          </div>
        </div>

        <a href="/dashboard.html" id="mobileDashLink" style="display:none;--idx:4">${SC.icon('layout-dashboard', { size: 20 })} Dashboard</a>
        <a href="/admin.html" id="mobileAdminLink" style="display:none;--idx:5">${SC.icon('settings', { size: 20 })} Admin Dashboard</a>

        <div class="mobile-nav-divider" style="--idx:6"></div>
        <div class="mobile-nav-label" style="--idx:7">More</div>
        <a href="/pages/announcements.html"${activeAttrs('announcements')} style="--idx:8">${SC.icon('bell', { size: 20 })} Announcements</a>
        <a href="/pages/pricing.html" style="--idx:9">${SC.icon('crown', { size: 20 })} Premium</a>
        <a href="/pages/about.html"${activeAttrs('about')} style="--idx:10">${SC.icon('info', { size: 20 })} About StudyCore</a>

        <div class="mobile-nav-divider" style="--idx:11"></div>
        <div class="mobile-nav-label" style="--idx:12">Community</div>
        <a href="${WHATSAPP_CHANNEL_URL}" target="_blank" rel="noopener" class="mobile-whatsapp-link" style="--idx:13">
          ${SC.icon('whatsapp', { size: 20 })} WhatsApp Academic Channel
        </a>

        <div class="mobile-nav-divider" style="--idx:14"></div>
        <div class="mobile-nav-label" style="--idx:15">Account</div>
        <div id="mobileAuthSlot" style="--idx:16"></div>
      </nav>
    `;
    const searchBtn = document.getElementById('mobileSearchBtn');
    if (searchBtn) searchBtn.addEventListener('click', () => openSearchOverlay());

    const closeBtn = document.getElementById('mobileNavClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        const hamburger = document.getElementById('hamburgerBtn');
        if (hamburger) hamburger.click();
      });
    }

    bindMobileAccordions();
  }

  function bindMobileAccordions() {
    const accordions = document.querySelectorAll('.mobile-accordion');
    accordions.forEach((acc) => {
      const toggle = acc.querySelector('.mobile-accordion-toggle');
      if (!toggle) return;
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const open = acc.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
      });
    });
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
              <a class="btn btn-on-dark btn-sm" id="footerGroupBtn" style="display:none;" target="_blank" rel="noopener">Join Group</a>
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
        groupBtn.style.display = '';
      }
    });
  }

  function renderCommunityPanel(host) {
    if (!host) return;
    host.classList.add('community-panel');
    host.innerHTML = `
      <div>
        <span class="eyebrow" style="color:#128c7e;">${SC.icon('whatsapp', { size: 14 })} Community</span>
        <h2>Study together on WhatsApp</h2>
        <p>Follow the official academic channel for tips, mentoring and updates — and join the student group to ask questions and revise with classmates.</p>
        <div class="community-actions">
          <a class="btn whatsapp-btn" href="${WHATSAPP_CHANNEL_URL}" target="_blank" rel="noopener">
            ${SC.icon('whatsapp', { size: 18 })} Follow the Channel
          </a>
          <a class="btn btn-outline" id="communityGroupBtn" style="display:none;" target="_blank" rel="noopener">
            ${SC.icon('users', { size: 18 })} Join the Student Group
          </a>
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
    renderNav();
    renderMobileNav();
    renderFooter();
    // One failing sub-initialiser must not silently kill the rest of the
    // chrome (e.g. the Log In / Get Started buttons in the nav).
    try {
      StudyCoreAuth.initMobileNav();
    } catch (err) {
      console.error('StudyCore: mobile nav init failed', err);
    }
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
