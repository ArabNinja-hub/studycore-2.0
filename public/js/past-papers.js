// =============================================
// STUDYCORE — Past Papers browser
// -----------------------------------------------
//   University → Programme → Course → Year
//   → Examination type
//
// Faceted: choosing a year keeps the exam-type
// list honest (and vice versa) because the API
// computes each facet with its own dimension
// removed. Filters live in the URL, so a
// filtered list is shareable and survives a
// refresh.
//
// Mobile-first: the filter panel collapses
// behind one button and the paper rows are
// single-column with a large tap target.
// =============================================

(function () {
  'use strict';

  const FILTER_KEYS = ['university', 'program', 'course', 'year', 'type', 'q'];
  const state = { university: '', program: '', course: '', year: '', type: '', q: '' };
  let facets = { universities: [], programs: [], courses: [], years: [], types: [] };
  let page = 1;
  let pageSize = 24;
  let total = 0;
  let papers = [];
  let authenticated = false;
  let requestSeq = 0;

  function paintIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (el.dataset.iconDone) return;
      el.dataset.iconDone = '1';
      el.innerHTML = SC.icon(el.getAttribute('data-icon'), { size: Number(el.getAttribute('data-icon-size')) || 20 });
      el.style.display = 'inline-flex';
    });
  }

  /* ── URL sync ───────────────────────────── */
  function readUrl() {
    const params = new URLSearchParams(location.search);
    FILTER_KEYS.forEach((k) => { state[k] = params.get(k) || ''; });
  }

  function writeUrl() {
    const params = new URLSearchParams();
    FILTER_KEYS.forEach((k) => { if (state[k]) params.set(k, state[k]); });
    const qs = params.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  function activeFilterCount() {
    return FILTER_KEYS.filter((k) => k !== 'q' && state[k]).length;
  }

  /* ── Chips ──────────────────────────────── */
  function chip(value, label, count, key, icon) {
    const active = state[key] === String(value);
    return `<button type="button" class="sc-chip${active ? ' is-active' : ''}"
        data-key="${key}" data-value="${escapeHtml(String(value))}" aria-pressed="${active}">
        ${icon ? SC.icon(icon, { size: 14 }) : ''}${escapeHtml(label)}
        ${count === undefined || count === null ? '' : `<span class="sc-chip-count">${SCUi.formatCount(count)}</span>`}
      </button>`;
  }

  function renderFacets() {
    const host = (id) => document.getElementById(id);

    const uni = host('universityChips');
    const uniList = facets.universities || [];
    uni.innerHTML = chip('', 'All universities', null, 'university') +
      uniList.map((u) => chip(u.code, u.shortName || u.name, u.count, 'university')).join('');
    uni.hidden = uniList.length < 2;
    uni.closest('.sc-filter-row').hidden = uniList.length < 2;

    const prog = host('programChips');
    const progList = facets.programs || [];
    prog.innerHTML = chip('', 'All programmes', null, 'program') +
      progList.map((p) => chip(p.code, p.shortName || p.name, p.count, 'program')).join('');
    prog.closest('.sc-filter-row').hidden = progList.length < 2;

    const course = host('courseChips');
    const courseList = facets.courses || [];
    course.innerHTML = chip('', 'All courses', null, 'course') +
      courseList.map((c) => chip(c.slug || c.code, `${c.code} — ${c.name}`, c.count, 'course', c.icon || 'book-open')).join('');
    course.closest('.sc-filter-row').hidden = courseList.length < 2;

    const year = host('yearChips');
    const yearList = facets.years || [];
    year.innerHTML = chip('', 'All years', null, 'year') +
      yearList.map((y) => chip(y.value, String(y.value), y.count, 'year', 'calendar')).join('');
    year.closest('.sc-filter-row').hidden = yearList.length < 1;

    const type = host('typeChips');
    const typeList = facets.types || [];
    type.innerHTML = chip('', 'All examinations', null, 'type') +
      typeList.map((t) => chip(t.value, t.value, t.count, 'type', 'list-checks')).join('');
    type.closest('.sc-filter-row').hidden = typeList.length < 1;

    document.getElementById('clearFilters').hidden = activeFilterCount() === 0 && !state.q;
    const badge = document.getElementById('filterCount');
    const n = activeFilterCount();
    badge.hidden = n === 0;
    badge.textContent = String(n);
  }

  /* ── Results ────────────────────────────── */
  function paperRow(paper) {
    const locked = Boolean(paper.locked);
    const meta = [
      paper.courseCode ? `${SC.icon('library', { size: 12 })} ${escapeHtml(paper.courseCode)}${paper.courseName ? ' — ' + escapeHtml(paper.courseName) : ''}` : '',
      paper.examYear ? `${SC.icon('calendar', { size: 12 })} ${escapeHtml(paper.examYear)}` : '',
      paper.examType ? `${SC.icon('list-checks', { size: 12 })} ${escapeHtml(paper.examType)}` : '',
      paper.programName ? `${SC.icon('school', { size: 12 })} ${escapeHtml(paper.programName)}` : '',
      paper.universityName ? `${SC.icon('graduation-cap', { size: 12 })} ${escapeHtml(paper.universityName)}` : '',
      paper.fileSize ? `${SC.icon('download', { size: 12 })} ${escapeHtml(formatFileSize(paper.fileSize))}` : ''
    ].filter(Boolean).join('');

    const label = paper.locked === 'login' ? 'Log in to open'
      : paper.locked === 'video' ? 'Premium only'
      : paper.locked ? 'Premium required'
      : paper.completed ? 'Completed' : 'Open paper';
    const badgeCls = paper.locked ? 'badge-amber' : (paper.completed ? 'badge-green' : 'badge-neutral');
    const iconName = paper.locked ? 'lock' : (paper.completed ? 'check-circle' : 'file');

    return `
      <a class="sc-paper${locked ? ' is-locked' : ''}${paper.completed ? ' is-done' : ''}"
         href="${paper.locked === 'login' ? '/login.html' : `/viewer/${encodeURIComponent(paper.id)}`}"
         aria-label="${escapeHtml(paper.title)}">
        <span class="sc-paper-ic">${SC.icon(iconName, { size: 20 })}</span>
        <span class="sc-paper-main">
          <span class="sc-paper-title">${escapeHtml(paper.title)}</span>
          <span class="sc-paper-meta">${meta}</span>
        </span>
        <span class="sc-paper-side">
          <span class="badge ${badgeCls}">${SC.icon(iconName, { size: 12 })} ${escapeHtml(label)}</span>
          <span style="color:var(--faint);display:inline-flex;">${SC.icon('chevron-right', { size: 18 })}</span>
        </span>
      </a>`;
  }

  function renderResults() {
    const host = document.getElementById('paperList');
    const summary = document.getElementById('resultSummary');
    host.setAttribute('aria-busy', 'false');

    const filterWords = [
      state.course ? (facets.courses || []).find((c) => (c.slug || c.code) === state.course) : null,
      state.year,
      state.type
    ].filter(Boolean).map((c) => (typeof c === 'object' ? `${c.code}` : c));

    summary.textContent = total === 0
      ? 'No past papers match these filters.'
      : `${total} past paper${total === 1 ? '' : 's'}${filterWords.length ? ` · ${filterWords.join(' · ')}` : ''}`;

    if (!papers.length) {
      host.className = '';
      host.innerHTML = SCUi.state({
        icon: 'file',
        title: total === 0 && activeFilterCount() ? 'No past papers match those filters' : 'No past papers published yet',
        body: total === 0 && activeFilterCount()
          ? 'Try widening the year or examination type — or clear the filters to see everything available to you.'
          : (authenticated
            ? 'Examination papers appear here as soon as they are published for your programme’s courses.'
            : 'Create a free account to see the past papers available for your programme.'),
        actions: activeFilterCount()
          ? '<button type="button" class="btn btn-outline btn-sm" data-action="clear">Clear filters</button>'
          : (authenticated ? '' : '<a class="btn btn-primary btn-sm" href="/signup.html">Create free account</a>')
      });
      const clearBtn = host.querySelector('[data-action="clear"]');
      if (clearBtn) clearBtn.addEventListener('click', clearAll);
      document.getElementById('loadMoreWrap').hidden = true;
      return;
    }

    host.className = 'sc-paper-list';
    host.innerHTML = papers.map(paperRow).join('');
    document.getElementById('loadMoreWrap').hidden = papers.length >= total;
  }

  /* ── Fetch ──────────────────────────────── */
  async function load(opts) {
    const o = opts || {};
    if (o.append !== true) {
      page = 1;
      papers = [];
      const host = document.getElementById('paperList');
      host.className = 'sc-paper-list';
      host.setAttribute('aria-busy', 'true');
      host.innerHTML = SCUi.skeletons('row', 5);
    }

    const params = new URLSearchParams();
    FILTER_KEYS.forEach((k) => { if (state[k]) params.set(k, state[k]); });
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));

    const seq = ++requestSeq;
    try {
      const res = await fetch(`/api/resources/past-papers?${params.toString()}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Could not load past papers');
      const data = await res.json();
      if (seq !== requestSeq) return; // a newer request already superseded this one

      facets = data.facets || facets;
      total = data.total || 0;
      authenticated = Boolean(data.authenticated);
      papers = o.append === true ? papers.concat(data.papers || []) : (data.papers || []);
      renderFacets();
      renderResults();
    } catch (err) {
      if (seq !== requestSeq) return;
      const host = document.getElementById('paperList');
      host.className = '';
      host.setAttribute('aria-busy', 'false');
      host.innerHTML = SCUi.state({
        kind: 'error',
        title: 'Could not load past papers',
        body: 'Something went wrong reaching StudyCore. Please try again.',
        actions: '<button type="button" class="btn btn-outline btn-sm" data-action="retry">Try again</button>'
      });
      host.querySelector('[data-action="retry"]').addEventListener('click', () => load());
    }
  }

  function clearAll() {
    FILTER_KEYS.forEach((k) => { state[k] = ''; });
    const search = document.getElementById('paperSearch');
    if (search) search.value = '';
    writeUrl();
    load();
  }

  /* ── Events ─────────────────────────────── */
  function bind() {
    document.addEventListener('click', (e) => {
      const chipEl = e.target.closest('.sc-chip[data-key]');
      if (!chipEl) return;
      const key = chipEl.getAttribute('data-key');
      const value = chipEl.getAttribute('data-value') || '';
      state[key] = state[key] === value ? '' : value;
      // Narrowing to a different course can invalidate a year/type selection.
      writeUrl();
      load();
    });

    document.getElementById('clearFilters').addEventListener('click', clearAll);

    const search = document.getElementById('paperSearch');
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.q = search.value.trim();
        writeUrl();
        load();
      }, 300);
    });

    document.getElementById('loadMoreBtn').addEventListener('click', () => {
      page += 1;
      load({ append: true });
    });

    // Mobile: the filter panel is hidden until asked for, so the paper list
    // is the first thing on screen.
    const toggle = document.getElementById('filterToggle');
    const panel = document.getElementById('paperFilters');
    const isNarrow = () => window.matchMedia('(max-width: 760px)').matches;
    function applyPanelState() {
      const open = !isNarrow() || toggle.getAttribute('aria-expanded') === 'true';
      panel.hidden = !open;
    }
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      applyPanelState();
    });
    window.addEventListener('resize', applyPanelState, { passive: true });
    applyPanelState();
  }

  function init() {
    paintIcons(document);
    SCUi.ensureSprite();
    readUrl();
    const search = document.getElementById('paperSearch');
    if (state.q) search.value = state.q;
    bind();
    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
