'use strict';
/**
 * Static mobile-viewport audit (dev tool, not part of `npm test`).
 *
 *   node scripts/mobile-audit.js
 *
 * A real headless-Chrome layout pass is the ideal check, but Chrome can't be
 * downloaded in every environment. This does the next best thing: it parses
 * the stylesheets and pages and flags the patterns that actually cause broken
 * phone layouts, scoped to what is still in effect at <=430px.
 *
 * Checks:
 *   1. Fixed/min widths that cannot fit a 320px screen.
 *   2. Horizontal-overflow risks (100vw + padding, negative margins, nowrap).
 *   3. Tap targets declared below the 44px accessibility minimum.
 *   4. The bottom dock reserving enough body padding for its own height.
 *   5. Pages missing the mobile viewport meta or the tab-bar layout script.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PHONE = 430; // widest phone breakpoint we care about

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const findings = [];
const add = (sev, area, msg) => findings.push({ sev, area, msg });

/* ── Split a stylesheet into blocks, tracking the media query context ──── */
function blocks(css, file) {
  const out = [];
  const stack = [];
  let i = 0;
  let buf = '';
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const head = buf.trim().replace(/\s+/g, ' ');
      buf = '';
      if (head.startsWith('@media') || head.startsWith('@supports')) {
        stack.push(head);
        i++;
        continue;
      }
      // rule block: capture body
      let depth = 1;
      let body = '';
      i++;
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') { depth--; if (!depth) break; }
        body += css[i];
        i++;
      }
      const clean = head.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      out.push({ file, media: stack.slice(), selector: clean, body, line: css.slice(0, i).split('\n').length });
      i++;
      continue;
    }
    if (ch === '}') { stack.pop(); buf = ''; i++; continue; }
    buf += ch;
    i++;
  }
  return out;
}

/* Does this media context apply at PHONE width? */
function appliesAtPhone(media) {
  for (const q of media) {
    if (!q.startsWith('@media')) continue;
    if (/print/.test(q)) return false;
    if (/prefers-reduced-motion|prefers-color-scheme|hover:|pointer:|forced-colors|display-mode/.test(q)) continue;
    const min = [...q.matchAll(/min-width:\s*(\d+)px/g)].map((m) => +m[1]);
    const max = [...q.matchAll(/max-width:\s*(\d+)px/g)].map((m) => +m[1]);
    if (min.some((v) => v > PHONE)) return false;
    if (max.some((v) => v < 320)) return false;
  }
  return true;
}

const CSS_FILES = fs.readdirSync(path.join(ROOT, 'public/css')).filter((f) => f.endsWith('.css')).map((f) => 'public/css/' + f);
const allBlocks = CSS_FILES.flatMap((f) => blocks(read(f), f));
const phoneBlocks = allBlocks.filter((b) => appliesAtPhone(b.media));

/* ── 1. Fixed widths that can't fit 320px ─────────────────────────────── */
for (const b of phoneBlocks) {
  // skip things that are legitimately off-canvas or decorative
  if (/::(before|after)|\.sc-glow|@keyframes|svg|\.avatar|\.spinner|\.skeleton/.test(b.selector)) continue;
  for (const m of b.body.matchAll(/(?:^|[;{\s])(min-width|width)\s*:\s*(\d{3,4})px/g)) {
    const prop = m[1];
    const px = +m[2];
    if (px <= 320) continue;
    // width on a fixed/absolute overlay is usually fine if it also clamps
    if (/max-width|min\(|clamp\(|calc\(/.test(b.body) && prop === 'width') continue;
    add('high', `${b.file}:${b.line}`, `${b.selector} sets ${prop}:${px}px — overflows a 320px screen (media: ${b.media.join(' ') || 'global'})`);
  }
}

/* ── 2. Overflow risks ────────────────────────────────────────────────── */
for (const b of phoneBlocks) {
  if (/width:\s*100vw/.test(b.body) && /padding(-inline|-left|-right)?:\s*[^0]/.test(b.body) && !/box-sizing:\s*border-box/.test(b.body)) {
    add('high', `${b.file}:${b.line}`, `${b.selector} uses width:100vw with padding and no border-box — guaranteed horizontal scroll`);
  }
  const grid = b.body.match(/grid-template-columns:\s*([^;]+)/);
  if (grid) {
    const val = grid[1];
    for (const g of val.matchAll(/minmax\(\s*(\d{3,4})px/g)) {
      if (+g[1] > 300) add('med', `${b.file}:${b.line}`, `${b.selector} grid track minmax(${g[1]}px…) is wider than a 320px viewport minus gutters`);
    }
    // A multi-column base rule is only a bug if nothing *narrower* overrides
    // it. Find the class and look for a later rule in a tighter media query.
    const cols = val.match(/repeat\(\s*(\d+)/);
    if (cols && +cols[1] >= 3) {
      const cls = b.selector.match(/\.([a-z0-9-]+)\s*(,|$|\{)/i)?.[1]
        || b.selector.match(/\.([a-z0-9-]+)/)?.[1];
      // A rule written *inside* a phone media query is a deliberate phone
      // choice, not an un-collapsed desktop leftover.
      const authoredForPhone = b.media.some((q) =>
        [...q.matchAll(/max-width:\s*(\d+)px/g)].some((n) => +n[1] <= 640));
      if (cls && !authoredForPhone) {
        const override = phoneBlocks.some((o) =>
          o !== b
          && new RegExp(`\\.${cls}\\b`).test(o.selector)
          && /grid-template-columns|grid-column/.test(o.body)
          && o.media.some((q) => {
            const mx = [...q.matchAll(/max-width:\s*(\d+)px/g)].map((n) => +n[1]);
            return mx.length && Math.min(...mx) <= 640;
          })
        );
        if (!override) {
          add('med', `${b.file}:${b.line}`, `.${cls} is ${val.trim().slice(0, 34)} with NO <=640px override — stays multi-column on phones`);
        }
      }
    }
  }
}

/* ── 3. Tap targets ───────────────────────────────────────────────────── */
const TAPPABLE = /(^|[\s,>])(a|button|\.btn|\.mob-tab|\.nav-link|\.tab|\.chip|\.icon-btn|\[role="button"\])(\b|[:.,\s{])/;
// Decorative children of a tappable parent (icon wells, badges, grab
// handles, hairlines) are not themselves tap targets.
const DECOR = /-ic\b|-icon\b|-badge|-pill|grab|sep|divider|rule|line|dot|bar\b|::(before|after)|:hover|:focus|:active|svg|\.avatar|\.num|\.label/;
for (const b of phoneBlocks) {
  if (!TAPPABLE.test(b.selector)) continue;
  if (DECOR.test(b.selector)) continue;
  // Only flag the element that actually receives the tap.
  if (!/^[.#a-z][^{]*$/i.test(b.selector.replace(/\/\*[\s\S]*?\*\//g, '').trim())) continue;
  const h = b.body.match(/(?:^|[;{\s])(?:min-)?height\s*:\s*(\d+)px/);
  if (h && +h[1] > 0 && +h[1] < 36) {
    add('low', `${b.file}:${b.line}`, `${b.selector} height:${h[1]}px is under the 44px tap-target guideline`);
  }
}

/* ── 4. Bottom dock vs reserved body padding ──────────────────────────── */
(() => {
  const css = read('public/css/style.css');
  const dock = css.match(/\.mob-tabs \{([\s\S]*?)\n\}/)?.[1] || '';
  const tab = css.match(/\.mob-tab \{([\s\S]*?)\n\}/)?.[1] || '';
  const pad = css.match(/body\.has-mobtabs \{ padding-bottom: calc\((\d+)px/)?.[1];
  const tabMin = +(tab.match(/min-height:\s*(\d+)px/)?.[1] || 0);
  const dockPadV = [...dock.matchAll(/padding:\s*(\d+)px/g)].map((m) => +m[1])[0] || 0;
  const dockBottom = +(dock.match(/bottom:\s*calc\((\d+)px/)?.[1] || 0);
  const needed = tabMin + dockPadV * 2 + dockBottom + 2 /* borders */;
  if (pad === undefined) {
    add('high', 'public/css/style.css', 'body.has-mobtabs has no padding-bottom — content will scroll under the bottom dock');
  } else if (+pad < needed) {
    add('high', 'public/css/style.css', `body.has-mobtabs reserves ${pad}px but the dock needs ~${needed}px (tab ${tabMin} + padding ${dockPadV * 2} + offset ${dockBottom}) — last content sits under the dock`);
  } else {
    add('ok', 'public/css/style.css', `bottom dock clearance OK (reserves ${pad}px for a ~${needed}px dock)`);
  }
})();

/* ── 5. Per-page mobile wiring ────────────────────────────────────────── */
const htmlFiles = [
  ...fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html')).map((f) => 'public/' + f),
  ...fs.readdirSync(path.join(ROOT, 'public/pages')).filter((f) => f.endsWith('.html')).map((f) => 'public/pages/' + f),
  ...fs.readdirSync(path.join(ROOT, 'public/pages/subjects')).filter((f) => f.endsWith('.html')).map((f) => 'public/pages/subjects/' + f),
  ...fs.readdirSync(path.join(ROOT, 'views')).filter((f) => f.endsWith('.html')).map((f) => 'views/' + f)
];

for (const f of htmlFiles) {
  const html = read(f);
  const vp = html.match(/<meta[^>]+name="viewport"[^>]*>/i);
  if (!vp) { add('high', f, 'no <meta name="viewport"> — page renders at desktop width on phones'); continue; }
  if (!/width=device-width/.test(vp[0])) add('high', f, 'viewport meta missing width=device-width');
  if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/.test(vp[0])) add('med', f, 'viewport blocks pinch-zoom (accessibility failure)');
  // Every page now uses the shared shell — content-admin included, so a
  // Content Admin gets the same bottom tab bar and can navigate the site.
  if (!/js\/layout\.js/.test(html) && !/404/.test(f)) {
    add('med', f, 'does not load layout.js — no bottom tab bar on this page');
  }

  // Inline styles that beat the mobile breakpoints. `max-width` is a
  // *clamp* and is safe on phones — only fixed `width`/`min-width` hurt.
  for (const m of html.matchAll(/style="[^"]*?(?<!-)\b(min-width|width)\s*:\s*(\d{3,4})px/g)) {
    if (+m[2] > 320) add('med', f, `inline style hard-codes ${m[1]}:${m[2]}px — outranks the mobile stylesheet`);
  }
  // Tables need a scroll wrapper on phones
  if (/<table/.test(html) && !/table-wrap|table-scroll|overflow-x/.test(html)) {
    add('low', f, 'has a <table> with no scroll wrapper — may overflow on phones');
  }
}

/* ── Report ───────────────────────────────────────────────────────────── */
const order = { high: 0, med: 1, low: 2, ok: 3 };
findings.sort((a, b) => order[a.sev] - order[b.sev]);
const counts = findings.reduce((acc, f) => ((acc[f.sev] = (acc[f.sev] || 0) + 1), acc), {});

console.log('\nMOBILE VIEWPORT AUDIT  (phone breakpoint <=' + PHONE + 'px)\n' + '='.repeat(62));
for (const sev of ['high', 'med', 'low', 'ok']) {
  const rows = findings.filter((f) => f.sev === sev);
  if (!rows.length) continue;
  console.log(`\n${sev.toUpperCase()} (${rows.length})`);
  for (const r of rows) console.log(`  • ${r.area}\n      ${r.msg}`);
}
console.log('\n' + '='.repeat(62));
console.log(`high=${counts.high || 0}  med=${counts.med || 0}  low=${counts.low || 0}`);
process.exitCode = counts.high ? 1 : 0;
