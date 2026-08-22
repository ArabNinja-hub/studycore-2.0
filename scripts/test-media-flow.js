// End-to-end media flow test: upload → storage → API → auth → stream.
// Exercises real PDFs and videos already written to data/fixtures.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';
const FIX = path.join(__dirname, '..', 'data', 'fixtures');

function cookieJar() {
  const jar = new Map();
  return {
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      const list = raw.length ? raw : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
      for (const c of list) {
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
  const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
  if (jar) jar.absorb(res);
  return res;
}

async function json(jar, url, opts = {}) {
  const res = await req(jar, url, opts);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { res, data };
}

function assert(cond, msg, extra) {
  if (!cond) {
    const err = new Error(msg);
    err.extra = extra;
    throw err;
  }
}

async function login(email, password) {
  const jar = cookieJar();
  const { res, data } = await json(jar, `${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert(res.ok, `login failed for ${email}`, { status: res.status, data });
  return { jar, user: data.user };
}

async function register(payload) {
  const jar = cookieJar();
  const { res, data } = await json(jar, `${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert(res.ok, `register failed for ${payload.email}`, { status: res.status, data });
  return { jar, user: data.user };
}

async function upload(adminJar, filePath, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  fd.append('file', new Blob([buf]), name);
  const { res, data } = await json(adminJar, `${BASE}/api/admin/resources`, {
    method: 'POST',
    body: fd
  });
  assert(res.status === 201 && data.resource, `upload failed ${name}`, { status: res.status, data });
  return data.resource;
}

async function inspectStream(jar, id, { range, method = 'GET', expectStatus } = {}) {
  const headers = {};
  if (range) headers.Range = range;
  const started = Date.now();
  const res = await req(jar, `${BASE}/api/resources/${id}/stream`, { method, headers });
  const ms = Date.now() - started;
  const ctype = res.headers.get('content-type') || '';
  const disp = res.headers.get('content-disposition') || '';
  const accept = res.headers.get('accept-ranges') || '';
  const cr = res.headers.get('content-range') || '';
  const cl = res.headers.get('content-length');
  let preview = Buffer.alloc(0);
  if (method !== 'HEAD' && res.body) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    while (got < 32) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      got += value.length;
      if (range || got >= 32) {
        try { await res.body.cancel(); } catch { /* ok */ }
        break;
      }
    }
    preview = Buffer.concat(chunks);
  }
  if (expectStatus) {
    assert(res.status === expectStatus, `stream ${id} expected ${expectStatus} got ${res.status}`, {
      ctype, disp, accept, cr, cl, ms
    });
  }
  return { res, ms, ctype, disp, accept, cr, cl, preview };
}

async function main() {
  const results = [];
  const pass = (name, detail) => { results.push({ name, ok: true, detail }); console.log('PASS', name, detail || ''); };
  const fail = (name, err) => { results.push({ name, ok: false, detail: err.message }); console.error('FAIL', name, err.message, err.extra || ''); };

  const admin = await login('admin@studycore.com', 'ChangeMe123!');
  pass('admin login');

  const trial = await register({
    name: 'Trial Student',
    email: `trial.${Date.now()}@studycore.test`,
    password: 'password1'
  });
  pass('trial register');

  const expired = await register({
    name: 'Expired Student',
    email: `expired.${Date.now()}@studycore.test`,
    password: 'password1'
  });
  // Expire trial via sqlite
  const dbPath = path.join(__dirname, '..', 'data', 'studycore.sqlite');
  const sql = `UPDATE users SET trial_end = '2000-01-01T00:00:00.000Z' WHERE email = '${expired.user.email}';`;
  spawnSync('python3', ['-c', `
import sqlite3
c=sqlite3.connect(${JSON.stringify(dbPath)})
c.execute(${JSON.stringify(sql)})
c.commit()
`], { stdio: 'inherit' });
  pass('expired student prepared');

  const premium = await register({
    name: 'Premium Student',
    email: `premium.${Date.now()}@studycore.test`,
    password: 'password1'
  });
  spawnSync('python3', ['-c', `
import sqlite3
c=sqlite3.connect(${JSON.stringify(dbPath)})
c.execute("UPDATE users SET subscription='premium', subscription_end='2099-01-01T00:00:00.000Z' WHERE email=?", (${JSON.stringify(premium.user.email)},))
c.commit()
`], { stdio: 'inherit' });
  const premiumLogin = await login(premium.user.email, 'password1');
  pass('premium student prepared');

  const smallPdf = await upload(admin.jar, path.join(FIX, 'small.pdf'), {
    title: 'Small Calculus Notes',
    category: 'document',
    subject: 'Mathematics',
    topic: 'Calculus',
    isPremium: 'false'
  });
  const multiPdf = await upload(admin.jar, path.join(FIX, 'multipage.pdf'), {
    title: 'Multi-page Tutorial Sheet',
    category: 'tutorial',
    subject: 'Mathematics',
    topic: 'Calculus'
  });
  const largePdf = await upload(admin.jar, path.join(FIX, 'large.pdf'), {
    title: 'Large Past Paper',
    category: 'past_paper',
    subject: 'Mathematics',
    topic: 'Calculus'
  });
  // Videos must carry a term (Term 1/2/3) — enforced by the admin API so
  // the course home's "Learn term by term" sections always have a bucket.
  const smallVid = await upload(admin.jar, path.join(FIX, 'small.mp4'), {
    title: 'Small Video Lesson',
    category: 'video',
    subject: 'Mathematics',
    topic: 'Calculus',
    semester: 'Term 1'
  });
  const largeVid = await upload(admin.jar, path.join(FIX, 'large.mp4'), {
    title: 'Large Video Lesson',
    category: 'video',
    subject: 'Mathematics',
    topic: 'Calculus',
    semester: 'Term 1'
  });
  const webmVid = await upload(admin.jar, path.join(FIX, 'sample.webm'), {
    title: 'WebM Video Lesson',
    category: 'video',
    subject: 'Mathematics',
    topic: 'Calculus',
    semester: 'Term 2'
  });
  pass('uploads', `${smallPdf.id} ${multiPdf.id} ${largePdf.id} ${smallVid.id} ${largeVid.id} ${webmVid.id}`);

  // Unauthenticated
  try {
    const anon = await inspectStream(null, smallPdf.id, { expectStatus: 401 });
    pass('unauth document blocked', `status=${anon.res.status}`);
  } catch (err) { fail('unauth document blocked', err); }

  try {
    const anon = await inspectStream(null, smallVid.id, { expectStatus: 401 });
    pass('unauth video blocked', `status=${anon.res.status}`);
  } catch (err) { fail('unauth video blocked', err); }

  // Trial can open free document
  try {
    const s = await inspectStream(trial.jar, smallPdf.id, { expectStatus: 200 });
    assert(s.ctype.includes('pdf'), 'free pdf content-type', s);
    assert(s.disp.startsWith('inline'), 'pdf should be inline', s);
    assert(s.accept === 'bytes', 'accept-ranges', s);
    assert(s.preview.slice(0, 4).toString() === '%PDF', 'pdf magic', s);
    pass('trial opens free PDF progressively', `ctype=${s.ctype} firstBytes=${s.preview.slice(0,4)} ${s.ms}ms`);
  } catch (err) { fail('trial opens free PDF progressively', err); }

  // Trial cannot watch video
  try {
    const s = await inspectStream(trial.jar, smallVid.id, { expectStatus: 403 });
    pass('trial video locked', `status=${s.res.status}`);
  } catch (err) { fail('trial video locked', err); }

  // Expired cannot open premium document
  try {
    const s = await inspectStream(expired.jar, multiPdf.id, { expectStatus: 403 });
    pass('expired premium document locked', `status=${s.res.status}`);
  } catch (err) { fail('expired premium document locked', err); }

  // Premium / admin video + range
  for (const [label, jar] of [['admin', admin.jar], ['premium', premiumLogin.jar]]) {
    try {
      const head = await inspectStream(jar, smallVid.id, { method: 'HEAD', expectStatus: 200 });
      assert(head.ctype.startsWith('video/'), `${label} video mime`, head);
      assert(head.disp.startsWith('inline'), `${label} video inline`, head);
      pass(`${label} HEAD video`, `ctype=${head.ctype} cl=${head.cl}`);
    } catch (err) { fail(`${label} HEAD video`, err); }

    try {
      const ranged = await inspectStream(jar, largeVid.id, { range: 'bytes=0-15', expectStatus: 206 });
      assert(ranged.preview.length <= 32, 'range body is small', ranged);
      assert(ranged.cr.includes('bytes 0-15/'), 'content-range', ranged);
      assert(ranged.ctype.startsWith('video/'), 'ranged mime', ranged);
      pass(`${label} range video`, `cr=${ranged.cr} bytes=${ranged.preview.length} ${ranged.ms}ms`);
    } catch (err) { fail(`${label} range video`, err); }
  }

  // Large PDF range — first bytes only, not the whole 200KB
  try {
    const s = await inspectStream(admin.jar, largePdf.id, { range: 'bytes=0-7', expectStatus: 206 });
    assert(s.preview.slice(0, 4).toString() === '%PDF', 'large pdf magic', s);
    assert(Number(s.cl) === 8, 'range length 8', s);
    pass('large PDF range request', `cr=${s.cr} cl=${s.cl} ${s.ms}ms`);
  } catch (err) { fail('large PDF range request', err); }

  try {
    const s = await inspectStream(admin.jar, multiPdf.id, { range: 'bytes=0-15', expectStatus: 206 });
    pass('multipage PDF range request', `cr=${s.cr} ${s.ms}ms`);
  } catch (err) { fail('multipage PDF range request', err); }

  try {
    const s = await inspectStream(admin.jar, webmVid.id, { method: 'HEAD', expectStatus: 200 });
    assert(s.ctype.includes('webm') || s.ctype.includes('video/'), 'webm mime', s);
    pass('webm HEAD', `ctype=${s.ctype}`);
  } catch (err) { fail('webm HEAD', err); }

  // Seeking into the large video (not just the start)
  try {
    const s = await inspectStream(premiumLogin.jar, largeVid.id, { range: 'bytes=400000-400015', expectStatus: 206 });
    assert(Number(s.cl) === 16, 'seek range length', s);
    pass('seek into large video', `cr=${s.cr} ${s.ms}ms`);
  } catch (err) { fail('seek into large video', err); }

  const failed = results.filter((r) => !r.ok);
  console.log('\n---');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    process.exitCode = 1;
    for (const f of failed) console.log('  x', f.name, '-', f.detail);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
