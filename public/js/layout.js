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
//   Logo/Home · Courses · Resources · Announcements · About · [Search] · [Avatar / Log In]
// The global navigation stays intentionally small. Video lessons are opened
// from a course home rather than competing with Courses as a second route to
// the same content. The dashboard is deliberately NOT a top-level nav item on
// desktop/tablet — logged-in users reach it from the avatar menu, and mobile
// users from the Account section of the drawer.
// =============================================

(function (global) {
  'use strict';

  function applyTheme() {
    // Delegate to StudyCoreAuth.applyTheme which reads localStorage and
    // sets document.body.dataset.theme. Falls back to 'light' if auth.js
    // hasn't loaded yet (shouldn't happen in normal page order).
    if (typeof StudyCoreAuth !== 'undefined' && StudyCoreAuth.applyTheme) {
      StudyCoreAuth.applyTheme();
    } else {
      const saved = localStorage.getItem('studycore_theme') || 'light';
      document.body.dataset.theme = saved;
    }
  }

  function toggleTheme() {
    const current = document.body.dataset.theme || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    if (typeof StudyCoreAuth !== 'undefined' && StudyCoreAuth.applyTheme) {
      StudyCoreAuth.applyTheme(next);
    } else {
      document.body.dataset.theme = next;
      localStorage.setItem('studycore_theme', next);
    }
    // Update all toggle buttons to reflect the new state
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      const isDark = next === 'dark';
      btn.innerHTML = SC.icon(isDark ? 'sun' : 'moon', { size: 20 });
      btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    });
    document.querySelectorAll('[data-theme-toggle-desktop]').forEach((btn) => {
      const isDark = next === 'dark';
      btn.innerHTML = SC.icon(isDark ? 'sun' : 'moon', { size: 17 });
      btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    });
  }

  const WHATSAPP_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb6sMBVIiRp0rg5RKQ2k';
  const SITE = 'https://studycore.academy/';

  const NAV_LINKS = [
    { id: 'courses', label: 'Courses', href: '/pages/courses.html', icon: 'library' },
    { id: 'resources', label: 'Resources', href: '/pages/resources.html', icon: 'file-text' },
    { id: 'community', label: 'Community', href: '/pages/community.html', icon: 'users', badge: 'community' },
    { id: 'announcements', label: 'Announcements', href: '/pages/announcements.html', icon: 'bell' },
    { id: 'about', label: 'About', href: '/pages/about.html', icon: 'info' }
  ];

  function currentPage() {
    return document.body.dataset.page || '';
  }

  // Course homes already provide focused topic, lesson, material and progress
  // navigation. Keep the shared global search out of those pages so it does
  // not compete with the course controls; search remains available everywhere
  // else and through the dedicated Search page.
  function globalSearchEnabled() {
    return currentPage() !== 'course';
  }

  function isActive(id) {
    const page = currentPage();
    if (id === 'courses') return ['courses', 'course', 'lesson', 'videos'].includes(page);
    return page === id;
  }

  /* ── Rich Flyout Submenus ───────────────── */
  // Static public catalog (anonymous visitors). Logged-in students get their
  // own program courses injected by updateCoursesDropdownForUser().
  const PUBLIC_SUBJECTS = [
    { slug: 'mathematics', name: 'Mathematics', icon: 'calculator', desc: 'Calculus, algebra & problem-solving', href: '/pages/subjects/mathematics.html' },
    { slug: 'physics', name: 'Physics', icon: 'atom', desc: 'Mechanics, waves & electricity', href: '/pages/subjects/physics.html' },
    { slug: 'chemistry', name: 'Chemistry', icon: 'flask', desc: 'Atoms, bonding & reactions', href: '/pages/subjects/chemistry.html' },
    { slug: 'biology', name: 'Biology', icon: 'dna', desc: 'Genetics, cells & physiology', href: '/pages/subjects/biology.html' },
    { slug: 'programming', name: 'Programming', icon: 'code', desc: 'Algorithms, data structures & logic', href: '/pages/subjects/programming.html' },
    { slug: 'communication', name: 'Communication Skills', icon: 'message', desc: 'Academic writing, speaking & clarity', href: '/pages/subjects/communication.html' }
  ];

  function dropdownCard(card) {
    return `
      <a class="nav-dropdown-card" href="${card.href}">
        <span class="nd-icon nd-icon-${card.slug}">${SC.icon(card.icon, { size: 18 })}</span>
        <div class="nd-content">
          <strong>${card.name}</strong>
          <span>${card.desc}</span>
        </div>
        <span class="nd-arrow">${SC.icon('chevron-right', { size: 14 })}</span>
      </a>`;
  }

  function coursesDropdownHtml(cards) {
    const list = cards || PUBLIC_SUBJECTS;
    const items = list.map(dropdownCard).join('');
    const headerEyebrow = cards ? `${SC.icon('library', { size: 13 })} My Program Courses` : `${SC.icon('library', { size: 13 })} University Courses`;
    const headerCopy = cards
      ? 'The courses available for your program — videos, notes, tutorials and past papers.'
      : 'Structured courses with video lectures, study notes, tutorials and past papers.';
    const footerLabel = cards ? 'View all my courses' : 'View all university course hubs';
    return `
      <div class="nav-dropdown nav-dropdown-courses" id="navDropdown_courses" role="region" aria-label="Courses submenu">
        <div class="nav-dropdown-inner">
          <div class="nav-dropdown-header">
            <span class="eyebrow">${headerEyebrow}</span>
            <p>${headerCopy}</p>
          </div>
          <div class="nav-dropdown-grid">
            ${items}
          </div>
          <div class="nav-dropdown-footer">
            <a href="/pages/courses.html" class="nd-footer-link">
              <span>${footerLabel}</span>
              ${SC.icon('arrow-right', { size: 14 })}
            </a>
          </div>
        </div>
      </div>
    `;
  }

  // For a logged-in student, swap the public subject flyout for their actual
  // program courses (Program → Course). Static fallback remains if the fetch
  // fails, so navigation never breaks.
  async function updateCoursesDropdownForUser(user) {
    if (!user || user.role === 'ADMIN') return;
    try {
      const data = await StudyCoreAPI.myProgram();
      if (!data || !data.program || !(data.courses || []).length) return;
      const hrefFor = (c) => (window.SCPrograms ? SCPrograms.courseHref(c) : `/pages/courses.html`);
      const cards = data.courses.map((c) => ({
        slug: c.slug || c.code,
        name: `${c.code} — ${c.name}`,
        icon: c.icon || 'book-open',
        desc: data.program.shortName || data.program.name,
        href: hrefFor(c)
      }));
      const host = document.getElementById('navDropdown_courses');
      if (host) host.outerHTML = coursesDropdownHtml(cards);
      const mobileHost = document.getElementById('mobileSubjectLinks');
      if (mobileHost) {
        const hrefFor2 = (c) => (window.SCPrograms ? SCPrograms.courseHref(c) : `/pages/courses.html`);
        mobileHost.innerHTML = data.courses.map((c) => `
          <a href="${hrefFor2(c)}" class="mobile-sub-link">
            ${SC.icon(c.icon || 'book-open', { size: 16 })} ${escapeHtml(c.code)} — ${escapeHtml(c.name)}
          </a>`).join('');
      }
    } catch { /* keep the static catalog */ }
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
  function notificationBellHtml() {
    return `
      <div class="notif-wrapper" id="notifWrapper">
        <button class="icon-btn notif-bell-btn" id="notifBellBtn" aria-label="Notifications" aria-haspopup="true" aria-expanded="false" title="Notifications">
          ${SC.icon('bell', { size: 19 })}
          <span class="notif-badge" id="notifBadge" style="display:none;" aria-live="polite"></span>
        </button>
        <div class="notif-panel" id="notifPanel" role="region" aria-label="Notifications panel">
          <div class="notif-panel-head">
            <div class="notif-panel-title-row">
              <h3>Notifications</h3>
              <span class="notif-unread-count-pill" id="notifUnreadCountPill" style="display:none;"></span>
            </div>
            <button type="button" class="notif-mark-all-btn" id="notifMarkAllBtn" style="display:none;">Mark all as read</button>
          </div>
          <div class="notif-panel-body" id="notifList">
            <div class="notif-loading"><div class="skeleton skeleton-row" style="height:56px;"></div><div class="skeleton skeleton-row" style="height:56px;"></div></div>
          </div>
          <div class="notif-panel-foot">
            <a href="/pages/announcements.html" class="notif-view-all-link">
              <span>View all announcements</span>
              ${SC.icon('arrow-right', { size: 14 })}
            </a>
          </div>
        </div>
      </div>
    `;
  }

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
      // Unread pill (currently only the Community room carries one).
      const badgeHtml = l.badge
        ? `<span class="nav-badge-pill" id="navBadge_${l.badge}" style="display:none;" aria-live="polite"></span>`
        : '';
      return `
        <li class="nav-item ${hasDrop ? 'nav-item-has-dropdown' : ''}" data-nav-id="${l.id}">
          <a href="${l.href}" class="nav-link${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}${hasDrop ? ' aria-haspopup="true" aria-expanded="false"' : ''}>
            <span>${l.label}</span>${badgeHtml}${chevronHtml}
          </a>
          ${dropdownHtml}
        </li>
      `;
    }).join('');

    const searchButtonHtml = globalSearchEnabled()
      ? `<button class="icon-btn nav-search-btn" id="navSearchBtn" aria-label="Search StudyCore">${SC.icon('search', { size: 19 })}</button>`
      : '';
    const isDarkInit = (document.body.dataset.theme || 'light') === 'dark';
    const themeToggleHtml = `<button class="icon-btn nav-theme-btn" data-theme-toggle-desktop aria-label="${isDarkInit ? 'Switch to light mode' : 'Switch to dark mode'}">${SC.icon(isDarkInit ? 'sun' : 'moon', { size: 17 })}</button>`;

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
          ${searchButtonHtml}
          ${themeToggleHtml}
          ${notificationBellHtml()}
          <span id="navAuthSlot" aria-live="polite"></span>
        </div>
        <button class="icon-btn hamburger" id="hamburgerBtn" aria-label="Open menu" aria-expanded="false">${SC.icon('menu', { size: 22 })}</button>
      </div>
    `;
    bindNavSearch();
    bindNavDropdowns();
    bindScrollMorph();

    // Desktop theme toggle
    const desktopThemeBtn = host.querySelector('[data-theme-toggle-desktop]');
    if (desktopThemeBtn) {
      desktopThemeBtn.addEventListener('click', toggleTheme);
    }
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
      // No standalone Dashboard button in the bar: the avatar menu is the
      // single desktop entry point (keeps the island compact on PC/tablet).
      slot.innerHTML = accountMenuHtml(user);
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
      NotificationManager.closePanel();
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
    const mobileSearchHtml = globalSearchEnabled()
      ? `<div class="mobile-nav-search-wrap" style="--idx:0">
          <button type="button" class="mobile-search-pill" id="mobileSearchBtn" data-close-mobile>
            ${SC.icon('search', { size: 17 })}
            <span>Search courses, notes &amp; papers…</span>
            <span class="kbd">/</span>
          </button>
        </div>`
      : '';

    // The drawer slides in BELOW the floating island, which stays visible on
    // top with the brand and a hamburger that morphs into a close (X) button.
    // A second brand row + close button here would only repeat both, so the
    // drawer opens straight into its content.
    host.innerHTML = `
      <div class="nav-backdrop" id="navBackdrop"></div>
      <nav class="mobile-nav" id="mobileNav" aria-label="Main navigation" aria-hidden="true">
        ${mobileSearchHtml}

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
            <div class="mobile-accordion-content" id="mobileSubjectLinks">
              ${subjectLinks}
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
            </div>
          </div>
        </div>

        <div class="mobile-nav-divider" style="--idx:4"></div>
        <div class="mobile-nav-label" style="--idx:5">More</div>
        <a href="/pages/announcements.html"${activeAttrs('announcements')} style="--idx:6" id="mobileNavAnnouncementsLink">${SC.icon('bell', { size: 20 })} <span>Announcements</span><span class="notif-badge-inline" id="mobileNavNotifBadge" style="display:none;"></span></a>
        <a href="/pages/pricing.html" style="--idx:7">${SC.icon('crown', { size: 20 })} Premium</a>
        <a href="/pages/about.html"${activeAttrs('about')} style="--idx:8">${SC.icon('info', { size: 20 })} About StudyCore</a>

        <div class="mobile-nav-divider" style="--idx:9"></div>
        <div class="mobile-nav-label" style="--idx:10">Community</div>
        <a href="/pages/community.html"${activeAttrs('community')} style="--idx:11" id="mobileNavCommunityLink">
          ${SC.icon('users', { size: 20 })} <span>Student Community</span><span class="notif-badge-inline" id="mobileNavCommunityBadge" style="display:none;"></span>
        </a>
        <a href="${WHATSAPP_CHANNEL_URL}" target="_blank" rel="noopener" class="mobile-whatsapp-link" style="--idx:12">
          ${SC.icon('whatsapp', { size: 20 })} WhatsApp Academic Channel
        </a>

        <div class="mobile-nav-divider" style="--idx:13"></div>
        <div class="mobile-nav-label" style="--idx:14">Account</div>
        <button type="button" data-theme-toggle style="--idx:15" aria-label="Switch to dark mode">${SC.icon('moon', { size: 20 })} <span>Dark Mode</span></button>
        <div id="mobileAuthSlot" style="--idx:16"></div>
      </nav>
    `;
    const searchBtn = document.getElementById('mobileSearchBtn');
    if (searchBtn) searchBtn.addEventListener('click', () => openSearchOverlay());

    // Theme toggle in mobile sidebar
    const themeBtn = host.querySelector('[data-theme-toggle]');
    if (themeBtn) {
      // Set correct icon/label based on current theme
      const isDark = (document.body.dataset.theme || 'light') === 'dark';
      themeBtn.innerHTML = `${SC.icon(isDark ? 'sun' : 'moon', { size: 20 })} <span>${isDark ? 'Light Mode' : 'Dark Mode'}</span>`;
      themeBtn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
      themeBtn.addEventListener('click', () => {
        toggleTheme();
        // Update the label text too
        const nowDark = (document.body.dataset.theme || 'light') === 'dark';
        themeBtn.querySelector('span').textContent = nowDark ? 'Light Mode' : 'Dark Mode';
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
      // Mirrors the desktop avatar menu: dashboard entry points live in the
      // Account section (not at the top of the Study section).
      const adminLink = StudyCoreAuth.isAdmin(user)
        ? `<a href="/admin.html">${SC.icon('settings', { size: 20 })} Admin Dashboard</a>`
        : '';
      slot.innerHTML = `
        <a href="/dashboard.html">${SC.icon('layout-dashboard', { size: 20 })} Dashboard</a>
        ${adminLink}
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
    if (!globalSearchEnabled()) return;
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
    if (!globalSearchEnabled()) return;
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
              <li><a href="/pages/community.html">Student Community</a></li>
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
        <span class="eyebrow" style="color:#128c7e;">${SC.icon('users', { size: 14 })} Community</span>
        <h2>Ask questions, study together</h2>
        <p>
          The StudyCore community is a live group room right here on the site — post a question,
          answer a classmate, and get replies from the StudyCore admin. You can also follow the
          official academic channel on WhatsApp for tips and updates.
        </p>
        <div class="community-actions">
          <a class="btn btn-primary" href="/pages/community.html">
            ${SC.icon('message-circle', { size: 18 })} Open the Student Community
          </a>
          <a class="btn whatsapp-btn" href="${WHATSAPP_CHANNEL_URL}" target="_blank" rel="noopener">
            ${SC.icon('whatsapp', { size: 18 })} Follow the Channel
          </a>
          <a class="btn btn-outline" id="communityGroupBtn" style="display:none;" target="_blank" rel="noopener">
            ${SC.icon('users', { size: 18 })} Join the WhatsApp Group
          </a>
        </div>
      </div>
    `;
    bindCommunityGroupBtn(host);
  }

  /* ── Announcement Details Modal ──────────── */
  function openAnnouncementModal(announcement) {
    if (!announcement) return;
    let overlay = document.getElementById('announcementModalOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'announcementModalOverlay';
      overlay.className = 'modal-overlay announcement-modal-overlay';
      overlay.innerHTML = `
        <div class="modal announcement-modal" role="dialog" aria-modal="true" aria-labelledby="annModalTitle">
          <button type="button" class="icon-btn modal-close" id="annModalClose" aria-label="Close dialog">
            ${SC.icon('x', { size: 19 })}
          </button>
          <div class="ann-modal-header">
            <span class="eyebrow" id="annModalEyebrow" style="margin-bottom:6px;">
              ${SC.icon('bell', { size: 13 })} Announcement
            </span>
            <h2 id="annModalTitle" style="font-size:1.35rem;line-height:1.25;margin:6px 0 10px;"></h2>
            <div class="ann-modal-meta" id="annModalMeta" style="display:flex;align-items:center;gap:10px;font-size:0.8rem;color:var(--muted);flex-wrap:wrap;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--border);"></div>
          </div>
          <div class="ann-modal-body" id="annModalBody" style="font-size:0.95rem;line-height:1.7;color:var(--ink);white-space:pre-wrap;word-break:break-word;max-height:55vh;overflow-y:auto;padding-right:4px;"></div>
          <div class="ann-modal-actions" style="display:flex;justify-content:space-between;align-items:center;margin-top:24px;padding-top:16px;border-top:1px solid var(--border);flex-wrap:wrap;gap:12px;">
            <a href="/pages/announcements.html" class="btn btn-outline btn-sm">
              <span>Announcement Centre</span>
              ${SC.icon('arrow-right', { size: 14 })}
            </a>
            <button type="button" class="btn btn-primary btn-sm" id="annModalDismissBtn">Done</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const closeDialog = () => {
        overlay.classList.remove('open');
        document.body.style.overflow = '';
      };

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeDialog();
      });
      document.getElementById('annModalClose').addEventListener('click', closeDialog);
      document.getElementById('annModalDismissBtn').addEventListener('click', closeDialog);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) closeDialog();
      });
    }

    const titleEl = document.getElementById('annModalTitle');
    const eyebrowEl = document.getElementById('annModalEyebrow');
    const metaEl = document.getElementById('annModalMeta');
    const bodyEl = document.getElementById('annModalBody');

    titleEl.textContent = announcement.title || 'Announcement';

    const iconHtml = announcement.pinned ? SC.icon('crown', { size: 13 }) : SC.icon('bell', { size: 13 });
    eyebrowEl.innerHTML = `${iconHtml} Official Announcement`;

    const metaParts = [];
    if (announcement.createdAt) {
      metaParts.push(`<span>${SC.icon('calendar', { size: 13 })} ${formatDate(announcement.createdAt)} (${timeAgo(announcement.createdAt)})</span>`);
    }
    if (announcement.subject) {
      metaParts.push(`<span>${SC.icon('library', { size: 13 })} ${escapeHtml(announcement.subject)}</span>`);
    }
    if (announcement.pinned) {
      metaParts.push(`<span class="badge badge-amber" style="font-size:0.68rem;">Pinned</span>`);
    }
    metaEl.innerHTML = metaParts.join(' ');

    bodyEl.textContent = announcement.description || 'No additional details provided.';

    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  /* ── Announcement Notification System ───── */
  const NotificationManager = {
    cachedAnnouncements: [],
    unreadCount: 0,
    isOpen: false,
    currentUser: null,
    pollInterval: null,
    channel: null,

    init(user) {
      this.currentUser = user;
      this.bindUI();
      this.bindSync();
      if (this.currentUser) {
        this.fetchStatus();
        this.startPolling();
      } else {
        this.updateBadge(0);
      }
    },

    bindUI() {
      const bellBtn = document.getElementById('notifBellBtn');
      const panel = document.getElementById('notifPanel');
      const markAllBtn = document.getElementById('notifMarkAllBtn');
      if (!bellBtn || !panel) return;

      bellBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePanel();
      });

      if (markAllBtn) {
        markAllBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.markAllAsRead();
        });
      }

      document.addEventListener('click', (e) => {
        const wrapper = document.getElementById('notifWrapper');
        if (this.isOpen && wrapper && !wrapper.contains(e.target)) {
          this.closePanel();
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isOpen) {
          this.closePanel();
        }
      });

      window.addEventListener('resize', () => {
        if (this.isOpen) this.clampPanelToViewport();
      }, { passive: true });
    },

    bindSync() {
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          this.channel = new BroadcastChannel('studycore_notifications');
          this.channel.onmessage = (event) => {
            if (event.data && event.data.type === 'NOTIFICATIONS_UPDATED') {
              this.fetchStatus(false);
            }
          };
        } catch { /* ignore */ }
      }

      window.addEventListener('storage', (e) => {
        if (e.key === 'sc_notifs_synced_at') {
          this.fetchStatus(false);
        }
      });
    },

    broadcastUpdate() {
      if (this.channel) {
        try { this.channel.postMessage({ type: 'NOTIFICATIONS_UPDATED', timestamp: Date.now() }); } catch {}
      }
      try {
        localStorage.setItem('sc_notifs_synced_at', String(Date.now()));
      } catch {}
    },

    startPolling() {
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.pollInterval = setInterval(() => {
        if (!document.hidden && this.currentUser) {
          this.fetchStatus(false);
        }
      }, 45000);

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.currentUser) {
          this.fetchStatus(false);
        }
      });

      window.addEventListener('focus', () => {
        if (this.currentUser) {
          this.fetchStatus(false);
        }
      });
    },

    async fetchStatus(forceListRefresh = false) {
      if (!this.currentUser) return;
      try {
        if (this.isOpen || forceListRefresh) {
          const data = await StudyCoreAPI.getNotifications({ limit: 15 });
          this.unreadCount = data.unreadCount || 0;
          this.cachedAnnouncements = data.announcements || [];
          this.updateBadge(this.unreadCount);
          this.renderList();
        } else {
          const data = await StudyCoreAPI.getUnreadNotificationCount();
          this.unreadCount = data.unreadCount || 0;
          this.updateBadge(this.unreadCount);
        }
      } catch (err) {
        // network error or unauthorized
      }
    },

    updateBadge(count) {
      this.unreadCount = count;
      const badge = document.getElementById('notifBadge');
      const mobileBadge = document.getElementById('mobileNavNotifBadge');
      const pill = document.getElementById('notifUnreadCountPill');
      const markAllBtn = document.getElementById('notifMarkAllBtn');

      if (badge) {
        if (count > 0) {
          badge.style.display = 'flex';
          badge.textContent = count > 99 ? '99+' : String(count);
          badge.setAttribute('aria-label', `${count} unread notifications`);
        } else {
          badge.style.display = 'none';
          badge.textContent = '';
          badge.removeAttribute('aria-label');
        }
      }

      if (mobileBadge) {
        if (count > 0) {
          mobileBadge.style.display = 'inline-flex';
          mobileBadge.textContent = count > 99 ? '99+' : String(count);
        } else {
          mobileBadge.style.display = 'none';
          mobileBadge.textContent = '';
        }
      }

      if (pill) {
        if (count > 0) {
          pill.style.display = 'inline-flex';
          pill.textContent = `${count} new`;
        } else {
          pill.style.display = 'none';
        }
      }

      if (markAllBtn) {
        markAllBtn.style.display = (count > 0 && this.currentUser) ? 'inline-block' : 'none';
      }
    },

    togglePanel() {
      if (this.isOpen) this.closePanel();
      else this.openPanel();
    },

    openPanel() {
      const panel = document.getElementById('notifPanel');
      const bellBtn = document.getElementById('notifBellBtn');
      const accountPanel = document.getElementById('accountPanel');
      const accountTrigger = document.getElementById('accountTrigger');
      if (accountPanel) accountPanel.classList.remove('open');
      if (accountTrigger) accountTrigger.setAttribute('aria-expanded', 'false');

      if (!panel || !bellBtn) return;
      this.isOpen = true;
      panel.classList.add('open');
      bellBtn.setAttribute('aria-expanded', 'true');
      this.clampPanelToViewport();

      if (!this.currentUser) {
        this.renderGuestState();
        return;
      }

      this.renderLoading();
      this.fetchStatus(true);
    },

    closePanel() {
      const panel = document.getElementById('notifPanel');
      const bellBtn = document.getElementById('notifBellBtn');
      if (panel) panel.classList.remove('open');
      if (bellBtn) bellBtn.setAttribute('aria-expanded', 'false');
      this.isOpen = false;
    },

    clampPanelToViewport() {
      const panel = document.getElementById('notifPanel');
      if (!panel) return;
      const margin = 10;
      const rect = panel.getBoundingClientRect();
      if (rect.width === 0) return;
      let shift = 0;
      if (rect.left < margin) shift += margin - rect.left;
      else if (rect.right > window.innerWidth - margin) shift -= rect.right - (window.innerWidth - margin);
      panel.style.setProperty('--notif-shift', `${Math.round(shift)}px`);
    },

    renderLoading() {
      const list = document.getElementById('notifList');
      if (list) {
        list.innerHTML = `
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px;">
            <div class="skeleton skeleton-row" style="height:54px;"></div>
            <div class="skeleton skeleton-row" style="height:54px;"></div>
          </div>`;
      }
    },

    renderGuestState() {
      const list = document.getElementById('notifList');
      const markAllBtn = document.getElementById('notifMarkAllBtn');
      if (markAllBtn) markAllBtn.style.display = 'none';
      if (!list) return;
      list.innerHTML = `
        <div class="notif-guest-state">
          <div class="notif-guest-icon">${SC.icon('bell', { size: 24 })}</div>
          <h4>Stay updated with StudyCore</h4>
          <p>Log in or create a free account to track notifications and announcements.</p>
          <div class="notif-guest-actions">
            <a href="/login.html" class="btn btn-outline btn-sm">Log In</a>
            <a href="/signup.html" class="btn btn-primary btn-sm">Get Started</a>
          </div>
        </div>
      `;
    },

    renderList() {
      const list = document.getElementById('notifList');
      if (!list) return;
      const items = this.cachedAnnouncements;
      if (!items || !items.length) {
        list.innerHTML = `
          <div class="notif-empty-state">
            <span class="notif-empty-icon">${SC.icon('bell', { size: 24 })}</span>
            <strong>No notifications right now</strong>
            <p>Notices from StudyCore will appear here.</p>
          </div>
        `;
        return;
      }

      list.innerHTML = items.map((a) => {
        const isUnread = !a.isRead;
        const iconName = a.pinned ? 'crown' : 'bell';
        const rawDesc = a.description || '';
        const preview = rawDesc.length > 110 ? rawDesc.slice(0, 107) + '…' : rawDesc;
        const timeStr = timeAgo(a.createdAt);
        const tag = a.subject ? `<span class="notif-tag">${escapeHtml(a.subject)}</span>` : '';
        const pinnedBadge = a.pinned ? `<span class="badge badge-amber" style="font-size:0.6rem;padding:1px 6px;">Pinned</span>` : '';

        return `
          <div class="notif-item ${isUnread ? 'unread' : ''} ${a.pinned ? 'pinned' : ''}" data-notif-id="${a.id}" role="button" tabindex="0" aria-label="${escapeHtml(a.title)}">
            <div class="notif-item-icon">${SC.icon(iconName, { size: 16 })}</div>
            <div class="notif-item-content">
              <div class="notif-item-header">
                <span class="notif-item-title">${escapeHtml(a.title)}</span>
                ${isUnread ? '<span class="notif-unread-dot" title="Unread"></span>' : ''}
              </div>
              ${preview ? `<p class="notif-item-desc">${escapeHtml(preview)}</p>` : ''}
              <div class="notif-item-meta">
                <span>${timeStr}</span>
                ${tag}
                ${pinnedBadge}
              </div>
            </div>
          </div>
        `;
      }).join('');

      list.querySelectorAll('.notif-item').forEach((el) => {
        const id = el.getAttribute('data-notif-id');
        const item = items.find((it) => it.id === id);
        if (!item) return;

        const openHandler = (e) => {
          e.preventDefault();
          this.handleItemClick(item);
        };

        el.addEventListener('click', openHandler);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openHandler(e);
          }
        });
      });
    },

    async handleItemClick(announcement) {
      if (!announcement.isRead) {
        announcement.isRead = true;
        this.unreadCount = Math.max(0, this.unreadCount - 1);
        this.updateBadge(this.unreadCount);
        this.renderList();
        try {
          await StudyCoreAPI.markNotificationRead(announcement.id);
          this.broadcastUpdate();
        } catch (err) {
          console.error('Failed to mark read', err);
        }
      }
      this.closePanel();
      openAnnouncementModal(announcement);
    },

    async markAllAsRead() {
      if (!this.currentUser || this.unreadCount === 0) return;
      this.unreadCount = 0;
      this.cachedAnnouncements.forEach((a) => { a.isRead = true; });
      this.updateBadge(0);
      this.renderList();
      try {
        await StudyCoreAPI.markAllNotificationsRead();
        this.broadcastUpdate();
        showToast('All notifications marked as read.', 'info');
      } catch (err) {
        showToast(err.message || 'Could not mark all as read.', 'error');
      }
    }
  };

  /* ── Community unread badge ────────────────
     The Community nav link carries a small unread pill. It is deliberately
     separate from the announcement bell: the room is a conversation, not a
     notice board, and mixing the two counts would make both meaningless. */
  const CommunityBadge = {
    count: 0,
    currentUser: null,
    timer: null,

    init(user) {
      this.currentUser = user;
      if (!user) {
        this.set(0);
        return;
      }
      this.refresh();
      this.start();
    },

    set(count) {
      this.count = Math.max(0, count || 0);
      const label = this.count > 99 ? '99+' : String(this.count);
      const navPill = document.getElementById('navBadge_community');
      const mobilePill = document.getElementById('mobileNavCommunityBadge');

      if (navPill) {
        navPill.style.display = this.count > 0 ? 'inline-flex' : 'none';
        navPill.textContent = this.count > 0 ? label : '';
        navPill.setAttribute('aria-label', `${this.count} unread community ${this.count === 1 ? 'message' : 'messages'}`);
      }
      if (mobilePill) {
        mobilePill.style.display = this.count > 0 ? 'inline-flex' : 'none';
        mobilePill.textContent = this.count > 0 ? label : '';
      }
    },

    async refresh() {
      if (!this.currentUser) return;
      try {
        const data = await StudyCoreAPI.communityUnreadCount();
        this.set(data.unreadCount || 0);
      } catch {
        // logged out mid-session, or offline - the badge simply stays put
      }
    },

    start() {
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => {
        // The room page keeps its own badge at zero while it is open, so
        // skipping hidden tabs is enough to stay polite to the server.
        if (!document.hidden && this.currentUser) this.refresh();
      }, 45000);

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.currentUser) this.refresh();
      });
      window.addEventListener('focus', () => {
        if (this.currentUser) this.refresh();
      });
    }
  };

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

  /* ── Cross-page transitions ───────────────
     Same-origin <a> clicks fade the current page out, then the next page
     fades in. Chromium also gets the native View Transition cross-fade.
     Hash-only jumps, new tabs, downloads and modifier-clicks stay instant. */
  const PAGE_LEAVE_MS = 240;

  function sameOriginInternal(url) {
    if (!url) return false;
    if (url.origin !== window.location.origin) return false;
    if (url.pathname === window.location.pathname && url.search === window.location.search) return false;
    return true;
  }

  function goTo(href) {
    try { sessionStorage.setItem('sc_page_transition', '1'); } catch { /* private mode */ }
    window.location.href = href;
  }

  function leaveThenGo(href) {
    if (document.body.classList.contains('sc-page-leave')) {
      goTo(href);
      return;
    }
    document.body.classList.add('sc-page-leave');
    window.setTimeout(() => goTo(href), PAGE_LEAVE_MS);
  }

  function bindPageTransitions() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    document.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target.closest && event.target.closest('a[href]');
      if (!anchor) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
      let url;
      try { url = new URL(anchor.href, window.location.href); } catch { return; }
      if (!sameOriginInternal(url)) return;
      event.preventDefault();
      leaveThenGo(url.href);
    }, true);

    window.addEventListener('pageshow', (event) => {
      if (event.persisted) document.body.classList.remove('sc-page-leave');
    });

    try {
      if (sessionStorage.getItem('sc_page_transition') === '1') {
        sessionStorage.removeItem('sc_page_transition');
        document.body.classList.add('sc-page-enter');
        window.setTimeout(() => document.body.classList.remove('sc-page-enter'), 700);
      }
    } catch { /* ignore */ }
  }

  /* ── Boot ──────────────────────────────── */
  async function init() {
    // Apply the saved theme preference BEFORE rendering any chrome so the
    // first paint is already in the correct mode (no flash of wrong theme).
    applyTheme();
    ensureMobileMeta();
    bindPageTransitions();
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
    const user = await StudyCoreAuth.fetchSession();
    renderNavAuth();
    renderMobileNavAuth();
    // Swap the public course flyout/drawer for the student's own program
    // courses once we know who they are.
    updateCoursesDropdownForUser(user).catch(() => {});
    NotificationManager.init(user);
    CommunityBadge.init(user);

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
    openAnnouncementModal,
    refreshNotifications: (force = true) => NotificationManager.fetchStatus(force),
    // The community room page calls these so the nav pill clears the moment a
    // student opens (or catches up in) the room, without waiting for a poll.
    setCommunityUnread: (count) => CommunityBadge.set(count),
    refreshCommunityUnread: () => CommunityBadge.refresh(),
    whatsappLinks,
    renderCommunityPanel,
    bindCommunityGroupBtn,
    WHATSAPP_CHANNEL_URL
  };

  document.addEventListener('DOMContentLoaded', init);
})(window);
