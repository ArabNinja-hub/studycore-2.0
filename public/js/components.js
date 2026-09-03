// =============================================
// STUDYCORE — Shared UI components
// -----------------------------------------------
// One implementation of the pieces that appear on
// more than one page, so the homepage, the Courses
// page, the dashboard and the course hub can never
// drift into three different course cards again.
//
// Everything renders from the same design tokens in
// css/style.css and the same icon set in js/icons.js.
// No emoji: every glyph is an inline SVG.
//
// Usage:
//   SCUi.courseCard(course)        -> course card HTML
//   SCUi.ring(72)                  -> circular progress
//   SCUi.state({ icon, title })    -> empty/error panel
//   SCUi.skeletons('card', 6)      -> loading placeholders
// =============================================

(function (global) {
  'use strict';

  function esc(value) {
    if (typeof global.escapeHtml === 'function') return global.escapeHtml(value);
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function icon(name, size) {
    return global.SC && SC.icon ? SC.icon(name, { size: size || 18 }) : '';
  }

  // The progress ring references one shared <linearGradient>. Injected once so
  // a page can render forty rings without forty duplicate gradient definitions.
  function ensureSprite() {
    if (document.getElementById('scUiSprite')) return;
    const host = document.createElement('div');
    host.id = 'scUiSprite';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
    host.innerHTML = `
      <svg width="0" height="0" focusable="false">
        <defs>
          <linearGradient id="scRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#2bb3a3" />
            <stop offset="100%" stop-color="#0d5f55" />
          </linearGradient>
        </defs>
      </svg>`;
    (document.body || document.documentElement).appendChild(host);
  }

  /* ── Circular progress ──────────────────── */
  function ring(percent, opts) {
    const o = opts || {};
    const size = o.size || 54;
    const stroke = o.stroke || 5;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    const offset = c - (pct / 100) * c;
    const complete = pct >= 100;
    const label = o.label === false ? '' : (complete
      ? icon('check', { size: 15 })
      : `${Math.round(pct)}`);
    ensureSprite();
    return `
      <span class="sc-ring" role="img" aria-label="${pct}% complete">
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
          <circle class="sc-ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" />
          <circle class="sc-ring-fill${complete ? ' is-complete' : ''}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
            stroke-width="${stroke}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" />
        </svg>
        <span class="sc-ring-label">${label}${o.suffix && !complete ? `<i style="font-style:normal;font-size:0.6em;">${esc(o.suffix)}</i>` : ''}</span>
      </span>`;
  }

  /* ── Course card ──────────────────────────
     The one card a first-year ever sees, on both the
     dashboard and the Courses page:

       CH110 — Chemistry
       Atomic structure, bonding, gases…
       ▓▓▓▓▓▓░░░░  61%   (17 of 28 lessons)
       Continue →

     Deliberately five things and nothing else: code,
     name, one-line description, progress, continue.
     Topic / note / video counts used to live here;
     they are now only shown inside a course, where a
     student is actually choosing what to study.
                                                        */
  function courseCard(course, opts) {
    const o = opts || {};
    const counts = course.counts || {};
    const progress = course.progress || {};
    const percent = Number(progress.percent) || 0;
    const href = course.href || (global.SCPrograms ? SCPrograms.courseHref(course) : '#');
    // Short description first; fall back to the owning programme so a course
    // shared across schools still says something useful.
    const description = o.subtitle || course.description || course.subtitle
      || (course.programName ? `${esc(course.programName)} course` : '');
    const hasLessons = (progress.total || 0) > 0 || (counts.lessons || 0) > 0;
    const complete = hasLessons && (progress.completed || 0) >= (progress.total || 0);
    const ctaLabel = o.cta || (complete
      ? 'Review course'
      : ((progress.completed || 0) > 0 ? 'Continue' : 'Start'));
    const total = progress.total || counts.lessons || 0;
    const barLabel = !hasLessons ? 'Content coming soon'
      : complete ? 'Course complete'
        : `${progress.completed || 0} of ${total} lessons`;

    return `
      <a class="sc-course${hasLessons ? '' : ' is-empty'}" href="${esc(href)}"
         aria-label="${esc(course.code)} — ${esc(course.name)}, ${Math.round(percent)}% complete">
        <span class="sc-course-top">
          <span class="sc-course-ic">${icon(course.icon || 'book-open', { size: 20 })}</span>
          <span class="sc-course-id">
            <span class="sc-course-code">${esc(course.code)}</span>
            <strong class="sc-course-name">${esc(course.name)}</strong>
          </span>
        </span>

        ${description ? `<span class="sc-course-sub">${description}</span>` : ''}

        <span class="sc-course-bar">
          <span class="progress-labels">
            <span>${esc(barLabel)}</span>
            <strong>${Math.round(percent)}%</strong>
          </span>
          <span class="progress progress-thin"><span style="width:${percent}%"></span></span>
        </span>

        <span class="sc-course-cta">
          <span class="sc-cta-text">${esc(ctaLabel)} ${icon('arrow-right', { size: 15 })}</span>
          ${o.lockLabel ? `<span class="sc-course-lock">${icon('lock', { size: 11 })} ${esc(o.lockLabel)}</span>` : ''}
        </span>
      </a>`;
  }

  /* ── States ─────────────────────────────── */
  function state(opts) {
    const o = opts || {};
    const kind = o.kind === 'error' ? ' is-error' : '';
    const fallbackIcon = o.kind === 'error' ? 'alert-triangle' : 'library';
    return `
      <div class="sc-state${kind}" role="${o.kind === 'error' ? 'alert' : 'status'}">
        <span class="sc-state-ic">${icon(o.icon || fallbackIcon, { size: 24 })}</span>
        <h3>${esc(o.title || 'Nothing here yet')}</h3>
        ${o.body ? `<p>${o.body}</p>` : ''}
        ${o.actions ? `<div class="sc-state-actions">${o.actions}</div>` : ''}
      </div>`;
  }

  function skeletons(kind, count) {
    const n = Math.max(1, Number(count) || 3);
    const cls = kind === 'card' ? 'sc-skeleton-row sc-skeleton-card' : 'sc-skeleton-row';
    return Array.from({ length: n }, () => `<div class="${cls}" aria-hidden="true"></div>`).join('');
  }

  // Grid wrapper so a page can swap skeletons → content → state in one place.
  function grid(inner, opts) {
    const o = opts || {};
    return `<div class="${o.cls || 'sc-course-grid'}" aria-busy="${o.busy ? 'true' : 'false'}" aria-live="polite">${inner}</div>`;
  }

  /* ── Breadcrumb trail ───────────────────── */
  function trail(items) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return '';
    return `
      <nav class="sc-trail" aria-label="Breadcrumb">
        ${list.map((it, i) => {
          const last = i === list.length - 1;
          const sep = i > 0 ? `<span class="sc-trail-sep" aria-hidden="true">${icon('chevron-right', { size: 13 })}</span>` : '';
          return last
            ? `${sep}<span class="sc-trail-current" aria-current="page">${esc(it.label)}</span>`
            : `${sep}<a href="${esc(it.href)}">${esc(it.label)}</a>`;
        }).join('')}
      </nav>`;
  }

  /* ── Stat tile ──────────────────────────── */
  function tile(opts) {
    const o = opts || {};
    return `
      <div class="sc-tile${o.tone ? ` is-${o.tone}` : ''}">
        <span class="sc-tile-ic">${icon(o.icon || 'activity', { size: 20 })}</span>
        <span>
          <b>${esc(o.value)}</b>
          <span>${esc(o.label)}</span>
        </span>
      </div>`;
  }

  /* ── Compact list row ───────────────────── */
  function listItem(opts) {
    const o = opts || {};
    return `
      <a class="sc-list-item" href="${esc(o.href || '#')}">
        <span class="sc-list-ic">${icon(o.icon || 'file-text', { size: 17 })}</span>
        <span class="sc-list-main">
          <span class="sc-list-title">${esc(o.title)}</span>
          <span class="sc-list-sub">${o.meta || ''}</span>
        </span>
        ${o.trailing || `<span style="color:var(--faint);display:inline-flex;">${icon('chevron-right', { size: 17 })}</span>`}
      </a>`;
  }

  function formatCount(n) {
    const v = Number(n) || 0;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
    return String(v);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureSprite);
  } else {
    ensureSprite();
  }

  global.SCUi = {
    esc,
    icon,
    ring,
    courseCard,
    state,
    skeletons,
    grid,
    trail,
    tile,
    listItem,
    formatCount,
    ensureSprite
  };
})(window);
