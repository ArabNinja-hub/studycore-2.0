// Live end-to-end check of the content-protection changes against a RUNNING
// server. Not part of `npm test` (it needs a real server + fixtures); this is
// the script used to verify the ticket flow and the no-permanent-URL rules
// behave in the real stack rather than only in unit tests.
//
//   node scripts/live-protection-check.js
//
// Env: TEST_BASE (default http://127.0.0.1:3000), ADMIN_EMAIL, ADMIN_PASSWORD

const fs = require('fs');
const path = require('path');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@studycore.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const FIX = path.join(__dirname, '..', 'data', 'fixtures');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log('  PASS', name); }
  else { failed += 1; console.error('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

function cookieJar() {
  const jar = new Map();
  return {
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of raw) {
        const part = String(c).split(';')[0];
        const eq = part.indexOf('=');
        if (eq > 0) jar.set(part.slice(0, eq), part.slice(eq + 1));
      }
    }
  };
}

async function req(jar, url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (jar) headers.Cookie = jar.header();
  const res = await fetch(url.startsWith('http') ? url : BASE + url, { ...opts, headers, redirect: 'manual' });
  if (jar) jar.absorb(res);
  return res;
}

async function json(jar, url, opts) {
  const res = await req(jar, url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { res, data };
}

async function main() {
  if (!ADMIN_PASSWORD) throw new Error('Set ADMIN_PASSWORD to the admin account password.');

  console.log('\n1. Admin can still log in and upload (admin functionality untouched)');
  const admin = cookieJar();
  const login = await json(admin, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });
  check('admin login', login.res.ok, { status: login.res.status, data: login.data });

  const fd = new FormData();
  fd.append('title', 'Protection check note');
  fd.append('category', 'notes');
  fd.append('subject', 'Mathematics');
  fd.append('publishStatus', 'published');
  fd.append('file', new Blob([fs.readFileSync(path.join(FIX, 'small.pdf'))]), 'small.pdf');
  const up = await json(admin, '/api/admin/resources', { method: 'POST', body: fd });
  check('admin upload still works', up.res.status === 201 && up.data && up.data.resource, { status: up.res.status, data: up.data });
  const resourceId = up.data && up.data.resource && up.data.resource.id;
  if (!resourceId) throw new Error('no resource created; cannot continue');

  console.log('\n2. Two separate students');
  const alice = cookieJar();
  const a = await json(alice, '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice Banda', email: `alice.${Date.now()}@studycore.test`, password: 'password1', program: 'SMMS' })
  });
  check('student A registered', a.res.ok, { status: a.res.status, data: a.data });

  const bob = cookieJar();
  const b = await json(bob, '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bob Phiri', email: `bob.${Date.now()}@studycore.test`, password: 'password1', program: 'SMMS' })
  });
  check('student B registered', b.res.ok, { status: b.res.status, data: b.data });

  console.log('\n3. Anonymous access is refused (no guessing a URL)');
  const anonStream = await req(null, `/api/resources/${resourceId}/stream`);
  check('anonymous stream refused', anonStream.status === 401, { status: anonStream.status });
  const anonTicket = await req(null, `/api/resources/${resourceId}/ticket`);
  check('anonymous ticket refused', anonTicket.status === 401, { status: anonTicket.status });

  console.log('\n4. Ticket flow');
  const tk = await json(alice, `/api/resources/${resourceId}/ticket`);
  check('student can mint a ticket', tk.res.ok && tk.data && tk.data.url, { status: tk.res.status, data: tk.data });
  check('ticket response is never cached', /no-store/.test(tk.res.headers.get('cache-control') || ''), tk.res.headers.get('cache-control'));
  const ticketUrl = tk.data.url;
  check('ticket URL points at the gated stream route', ticketUrl.startsWith(`/api/resources/${resourceId}/stream?t=`), ticketUrl);
  check('ticket expires within a day', tk.data.expiresAt > Date.now() && tk.data.expiresAt < Date.now() + 25 * 3600 * 1000);

  const viaTicket = await req(alice, ticketUrl);
  check('owner can read the bytes with the ticket', viaTicket.status === 200, { status: viaTicket.status });
  check('served as a PDF', (viaTicket.headers.get('content-type') || '').includes('pdf'), viaTicket.headers.get('content-type'));
  check('served inline, not as a download', (viaTicket.headers.get('content-disposition') || '').startsWith('inline'), viaTicket.headers.get('content-disposition'));
  check('range requests still supported (PDF paging / video seeking)', viaTicket.headers.get('accept-ranges') === 'bytes');
  try { await viaTicket.body.cancel(); } catch { /* ok */ }

  console.log('\n5. A shared ticket is worthless to another account');
  const stolen = await req(bob, ticketUrl);
  check('student B refused with student A\'s ticket', stolen.status === 403, { status: stolen.status });
  const stolenBody = await stolen.json().catch(() => null);
  check('refusal is a clean message, not a crash', Boolean(stolenBody && stolenBody.message), stolenBody);

  console.log('\n6. Tampering with the ticket is detected');
  const forged = ticketUrl.replace(/t=(.{6})/, 't=AAAAAA');
  const forgedRes = await req(alice, forged);
  check('edited ticket refused', forgedRes.status === 403, { status: forgedRes.status });

  console.log('\n7. Range requests work with a ticket (video seeking / PDF paging)');
  const ranged = await req(alice, ticketUrl, { headers: { Range: 'bytes=0-99' } });
  check('partial content returned', ranged.status === 206, { status: ranged.status });
  check('content-range present', Boolean(ranged.headers.get('content-range')), ranged.headers.get('content-range'));
  try { await ranged.body.cancel(); } catch { /* ok */ }

  // The ticket is defence in depth by default (the session gate still
  // applies), and mandatory when CONTENT_TICKET_ENFORCE=true. Both modes are
  // valid; assert whichever one this server is running.
  const enforced = String(process.env.CONTENT_TICKET_ENFORCE || '').toLowerCase() === 'true';
  console.log(`\n8. Ticketless request behaviour (CONTENT_TICKET_ENFORCE=${enforced})`);
  const plain = await req(alice, `/api/resources/${resourceId}/stream`);
  if (enforced) {
    check('enforced mode refuses a ticketless request', plain.status === 403, { status: plain.status });
  } else {
    check('default mode: session-gated stream still serves (no hard cutover)', plain.status === 200, { status: plain.status });
  }
  try { if (plain.body) await plain.body.cancel(); } catch { /* ok */ }

  console.log('\n9. Downloads stay closed');
  const dl = await req(alice, `/api/resources/${resourceId}/download`);
  check('download endpoint refuses', dl.status === 403, { status: dl.status });

  console.log('\n10. No permanent public media URL is published to the browser');
  const detail = await json(alice, `/api/resources/${resourceId}`);
  const body = JSON.stringify(detail.data || {});
  check('no HLS manifest URL in the payload', !/manifest\/video\.m3u8/.test(body));
  check('no R2 / cloudflarestorage URL in the payload', !/r2\.cloudflarestorage\.com/.test(body));
  check('no storage credentials in the payload', !/(secret|access[-_]?key)/i.test(body));

  console.log('\n11. Security headers');
  const page = await req(alice, '/pages/lesson.html');
  const pp = page.headers.get('permissions-policy') || '';
  check('display-capture blocked', pp.includes('display-capture=()'), pp);
  check('picture-in-picture blocked', pp.includes('picture-in-picture=()'), pp);
  check('fullscreen still allowed for the player/reader', pp.includes('fullscreen=(self)'), pp);

  console.log('\n12. Normal browsing is untouched');
  for (const [name, url, expect] of [
    ['home page', '/', 200],
    ['pricing', '/pages/pricing.html', 200],
    // A signed-in student is redirected away from the login page — that is
    // the pre-existing (correct) behaviour, not a protection regression.
    ['login redirects a signed-in student', '/login.html', 302],
    ['resources listing', '/pages/resources.html', 200],
    ['lesson page', '/pages/lesson.html', 200]
  ]) {
    const r = await req(alice, url);
    check(`${name} loads`, r.status === expect, { status: r.status });
  }

  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nFATAL', err.message, err.extra || '');
  process.exit(1);
});
