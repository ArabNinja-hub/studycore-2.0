// =============================================
// STUDYCORE — Program helpers (js/programs.js)
// -----------------------------------------------
// Shared client-side helpers for the multi-program
// platform: program labels/icons, course links and
// formatting. The AUTHORITATIVE program/course data
// always comes from the API (/api/programs); the
// constants here are just labels/fallbacks so the UI
// can render a program name/icon before or without a
// fetch. The backend enforces every permission.
// =============================================

(function (global) {
  'use strict';

  // Display metadata keyed by program code (mirrors the seeded catalog).
  const PROGRAM_META = {
    LAW:  { name: 'Law', shortName: 'Law', icon: 'shield' },
    BS:   { name: 'Business Studies', shortName: 'Business', icon: 'wallet' },
    SNR:  { name: 'School of Natural Resources', shortName: 'SNR', icon: 'leaf' },
    SMMS: { name: 'School of Mines', shortName: 'Mines', icon: 'shapes', groupName: 'School of Mines / Non-Quota' },
    SMNS: { name: 'Non-Quota', shortName: 'Non-Quota', icon: 'shapes', groupName: 'School of Mines / Non-Quota' },
    SICT: { name: 'Computer Science / SICT', shortName: 'SICT', icon: 'code' },
    SBE:  { name: 'School of the Built Environment', shortName: 'Built Environment', icon: 'home' }
  };

  // The admin program filter order:
  // ALL | LAW | BUSINESS | SNR | MINES | NON-QUOTA | SICT | BUILT ENVIRONMENT
  const FILTER_ORDER = ['LAW', 'BS', 'SNR', 'SMMS', 'SMNS', 'SICT', 'SBE'];

  function programName(code) {
    if (!code) return 'Unassigned';
    const p = PROGRAM_META[code];
    return p ? p.name : code;
  }

  function programShortName(code) {
    if (!code) return '';
    const p = PROGRAM_META[code];
    return p ? (p.shortName || p.name) : code;
  }

  function programIcon(code) {
    const p = PROGRAM_META[code];
    return (p && p.icon) || 'book-open';
  }

  // Course URL inside the single site: /course/<slug>
  function courseHref(course) {
    const key = (course && (course.slug || course.code || course.id)) || '';
    return `/course/${encodeURIComponent(String(key).toLowerCase())}`;
  }

  // "MA110 — Mathematics"
  function courseLabel(course) {
    if (!course) return '';
    return `${course.code} — ${course.name}`;
  }

  global.SCPrograms = {
    PROGRAM_META,
    FILTER_ORDER,
    programName,
    programShortName,
    programIcon,
    courseHref,
    courseLabel
  };
})(window);
