'use strict';

// =============================================
// STUDYCORE — Community room tests
// -----------------------------------------------
// Covers the on-site student group room end to end against the real routes:
// schema, posting/replying/editing, moderation permissions (student vs
// admin), reactions, pinning + its cap, unread tracking, the live SSE stream
// and the front-end wiring.
// =============================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const db = require('../db');
const { createToken, COOKIE_NAME } = require('../middleware/auth');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const suiteId = Date.now();
const nowIso = () => new Date().toISOString();

function makeUser(role, label) {
  const id = `${role.toLowerCase()}-${label}-${suiteId}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, created_at)
    VALUES (?, ?, ?, 'pass123', ?, ?)
  `).run(id, `${label} ${role === 'ADMIN' ? 'Admin' : 'Student'}`, `${id}@test.studycore`, role, nowIso());
  return { id, role, email: `${id}@test.studycore` };
}

function cookieFor(user) {
  return `${COOKIE_NAME}=${createToken(user)}`;
}

function cleanupUsers(...users) {
  for (const user of users) {
    // community_messages / community_reactions / community_read_state all
    // cascade from users(id), so this leaves nothing behind.
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  }
}

/* ── Schema ─────────────────────────────────── */

test('community tables and indexes exist', () => {
  for (const table of ['community_messages', 'community_reactions', 'community_read_state']) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    assert.ok(row, `${table} table should exist`);
  }

  const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((i) => i.name);
  for (const index of [
    'idx_community_messages_user',
    'idx_community_messages_pinned',
    'idx_community_reactions_message',
    'idx_community_reactions_user'
  ]) {
    assert.ok(indexes.includes(index), `${index} index should exist`);
  }

  const columns = db.prepare(`PRAGMA table_info(community_messages)`).all().map((c) => c.name);
  for (const column of ['id', 'user_id', 'body', 'reply_to_id', 'pinned', 'deleted', 'edited_at', 'created_at']) {
    assert.ok(columns.includes(column), `community_messages.${column} should exist`);
  }
});

/* ── HTTP behaviour ─────────────────────────── */

test('community API: posting, replies, editing, reactions and moderation', { timeout: 30000 }, async () => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const communityRoutes = require('../routes/community.routes');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/community', communityRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const studentA = makeUser('STUDENT', 'Amara');
  const studentB = makeUser('STUDENT', 'Bwalya');
  const admin = makeUser('ADMIN', 'Relentless');

  const call = async (method, url, user, body) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(user ? { Cookie: cookieFor(user) } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data, headers: res.headers };
  };

  try {
    // 1. The room is closed to anonymous visitors.
    const anon = await call('GET', '/api/community', null);
    assert.equal(anon.status, 401, 'anonymous request must be rejected');

    // 2. A student posts; the payload carries everything the bubble needs.
    const unique = `Why does ${suiteId} matter in circular motion?`;
    const posted = await call('POST', '/api/community', studentA, { body: unique });
    assert.equal(posted.status, 201);
    const first = posted.data.message;
    assert.equal(first.body, unique);
    assert.equal(first.author.id, studentA.id);
    assert.equal(first.author.isAdmin, false);
    assert.equal(first.mine, true);
    assert.equal(first.deleted, false);
    assert.equal(first.pinned, false);
    assert.deepEqual(first.reactions, { heart: 0, mine: false });
    assert.ok(first.seq > 0, 'message should carry an ordering sequence');

    // 3. Validation: empty and over-long bodies are refused.
    assert.equal((await call('POST', '/api/community', studentA, { body: '   ' })).status, 400);
    assert.equal((await call('POST', '/api/community', studentA, { body: 'x'.repeat(2001) })).status, 400);

    // 4. Another student replies — the quote travels with the message.
    const replied = await call('POST', '/api/community', studentB, { body: 'Because the net force points inward.', replyToId: first.id });
    assert.equal(replied.status, 201);
    assert.equal(replied.data.message.replyTo.id, first.id);
    assert.equal(replied.data.message.replyTo.authorName.includes('Amara'), true);
    assert.equal(replied.data.message.mine, true, 'the reply belongs to the replier');

    // 5. Replying to something that does not exist is a 400, not a crash.
    const badReply = await call('POST', '/api/community', studentB, { body: 'orphan', replyToId: 'cm-does-not-exist' });
    assert.equal(badReply.status, 400);

    // 6. Listing: chronological, newest last, with per-viewer flags.
    const list = await call('GET', '/api/community?limit=50', studentA);
    assert.equal(list.status, 200);
    const ids = list.data.messages.map((m) => m.id);
    assert.ok(ids.indexOf(first.id) < ids.indexOf(replied.data.message.id), 'messages are chronological');
    const firstAsSeenByA = list.data.messages.find((m) => m.id === first.id);
    const replyAsSeenByA = list.data.messages.find((m) => m.id === replied.data.message.id);
    assert.equal(firstAsSeenByA.mine, true);
    assert.equal(replyAsSeenByA.mine, false, 'another student\'s message is not "mine"');
    assert.equal(list.data.me.isAdmin, false);
    assert.equal(typeof list.data.unreadCount, 'number');
    assert.ok(Array.isArray(list.data.members));
    assert.ok(Array.isArray(list.data.pinned));
    assert.equal(list.data.limits.maxBodyLength, 2000);

    // 7. Reactions toggle both ways.
    const reactOn = await call('POST', `/api/community/${first.id}/react`, studentB);
    assert.equal(reactOn.status, 200);
    assert.deepEqual(reactOn.data.reactions, { heart: 1, mine: true });
    const reactOff = await call('POST', `/api/community/${first.id}/react`, studentB);
    assert.deepEqual(reactOff.data.reactions, { heart: 0, mine: false });

    // 8. Editing: your own yes, somebody else's no.
    const edited = await call('PATCH', `/api/community/${first.id}`, studentA, { body: `${unique} (adding the formula too)` });
    assert.equal(edited.status, 200);
    assert.ok(edited.data.message.editedAt, 'an edit must be marked as edited');
    const foreignEdit = await call('PATCH', `/api/community/${first.id}`, studentB, { body: 'hijacked' });
    assert.equal(foreignEdit.status, 403, 'students cannot edit other people\'s messages');

    // 9. Deleting: students only touch their own, and their own is soft-deleted.
    const foreignDelete = await call('DELETE', `/api/community/${replied.data.message.id}`, studentA);
    assert.equal(foreignDelete.status, 403, 'students cannot delete other people\'s messages');

    const ownDelete = await call('DELETE', `/api/community/${replied.data.message.id}`, studentB);
    assert.equal(ownDelete.status, 200);
    assert.equal(ownDelete.data.hardDeleted, false, 'a student delete is a soft delete');
    const afterSoft = await call('GET', '/api/community?limit=50', studentA);
    const softGone = afterSoft.data.messages.find((m) => m.id === replied.data.message.id);
    assert.ok(softGone, 'a soft-deleted message keeps its place in the thread');
    assert.equal(softGone.deleted, true);
    assert.equal(softGone.body, '', 'a soft-deleted message keeps no text');

    // 10. An admin removing somebody else's message is a hard delete.
    const adminDelete = await call('DELETE', `/api/community/${first.id}`, admin);
    assert.equal(adminDelete.status, 200);
    assert.equal(adminDelete.data.hardDeleted, true, 'admin moderation removes the row entirely');
    const afterHard = await call('GET', '/api/community?limit=50', studentA);
    assert.equal(afterHard.data.messages.some((m) => m.id === first.id), false, 'hard-deleted message is gone');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM community_messages WHERE id = ?').get(first.id).c,
      0,
      'hard delete really removed the row'
    );

    // 11. Pinning is admin-only and capped. The cap is global, so start from
    // a known-empty pin set rather than assuming a fresh database.
    const preState = await call('GET', '/api/community?limit=1', admin);
    for (const alreadyPinned of preState.data.pinned) {
      await call('DELETE', `/api/community/${alreadyPinned.id}/pin`, admin);
    }
    assert.equal((await call('GET', '/api/community?limit=1', admin)).data.pinned.length, 0);

    const posts = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await call('POST', '/api/community', admin, { body: `Pinned candidate ${i} (${suiteId})` });
      posts.push(res.data.message);
    }
    const studentPin = await call('POST', `/api/community/${posts[0].id}/pin`, studentA);
    assert.equal(studentPin.status, 403, 'students cannot pin messages');

    const pin1 = await call('POST', `/api/community/${posts[0].id}/pin`, admin);
    assert.equal(pin1.status, 200);
    assert.equal(pin1.data.pinned.length, 1);
    assert.equal(pin1.data.pinned[0].id, posts[0].id);
    await call('POST', `/api/community/${posts[1].id}/pin`, admin);
    await call('POST', `/api/community/${posts[2].id}/pin`, admin);
    const pinOverflow = await call('POST', `/api/community/${posts[3].id}/pin`, admin);
    assert.equal(pinOverflow.status, 400, 'the pin cap is enforced');

    const unpin = await call('DELETE', `/api/community/${posts[2].id}/pin`, admin);
    assert.equal(unpin.data.pinned.length, 2, 'unpinning frees a slot');
    const studentUnpin = await call('DELETE', `/api/community/${posts[0].id}/pin`, studentA);
    assert.equal(studentUnpin.status, 403);

    // A pinned message is flagged in the timeline too.
    const withPins = await call('GET', '/api/community?limit=50', studentA);
    const pinnedInTimeline = withPins.data.messages.find((m) => m.id === posts[0].id);
    assert.equal(pinnedInTimeline.pinned, true, 'pinned state is visible in the timeline');
    assert.equal(withPins.data.pinned.length, 2);

    // 12. Unread tracking is per student and clears on read.
    const bUnread = await call('GET', '/api/community/unread-count', studentB);
    assert.equal(bUnread.status, 200);
    assert.ok(bUnread.data.unreadCount >= 1, 'another student\'s posts count as unread');
    const markedRead = await call('POST', '/api/community/read', studentB);
    assert.equal(markedRead.data.unreadCount, 0);
    const afterRead = await call('GET', '/api/community/unread-count', studentB);
    assert.equal(afterRead.data.unreadCount, 0, 'read marker persists');
    assert.ok(
      db.prepare('SELECT last_read_at FROM community_read_state WHERE user_id = ?').get(studentB.id),
      'read state is stored per user'
    );

    // 13. Members list marks the admin and reports activity.
    const members = await call('GET', '/api/community/members', studentA);
    assert.equal(members.status, 200);
    const adminRow = members.data.members.find((m) => m.id === admin.id);
    assert.ok(adminRow, 'the admin shows up as a member');
    assert.equal(adminRow.isAdmin, true);
    assert.ok(members.data.stats.totalMessages >= 1);

    // 14. Deleting a user cascades their messages away.
    db.prepare('DELETE FROM users WHERE id = ?').run(studentB.id);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM community_reactions WHERE user_id = ?').get(studentB.id).c,
      0,
      'reactions cascade with the user'
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM community_read_state WHERE user_id = ?').get(studentB.id).c,
      0,
      'read state cascades with the user'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupUsers(studentA, studentB, admin);
  }
});

/* ── Live stream ────────────────────────────── */

test('community API: SSE stream pushes new messages and typing to other members', { timeout: 30000 }, async () => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const communityRoutes = require('../routes/community.routes');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/community', communityRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listener = makeUser('STUDENT', 'Chisanga');
  const speaker = makeUser('STUDENT', 'Mulenga');

  const streamRes = await fetch(`${baseUrl}/api/community/stream`, { headers: { Cookie: cookieFor(listener) } });
  assert.equal(streamRes.status, 200);
  assert.match(String(streamRes.headers.get('content-type')), /text\/event-stream/, 'stream must be an event stream');

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const readUntil = async (needle, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) return buffer;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(needle)) return buffer;
    }
    return buffer;
  };

  try {
    // Presence arrives immediately so the client knows who is in the room.
    await readUntil('event: presence', 5000);
    assert.match(buffer, /event: presence/, 'presence is announced on connect');

    // Somebody else speaks -> the listener hears it live.
    const text = `Live check ${suiteId}`;
    const posted = await fetch(`${baseUrl}/api/community`, {
      method: 'POST',
      headers: { Cookie: cookieFor(speaker), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text })
    });
    assert.equal(posted.status, 201);

    await readUntil('event: message', 8000);
    assert.match(buffer, /event: message/, 'new messages are pushed over the stream');
    assert.ok(buffer.includes(text), 'the pushed frame carries the message text');

    // The same frame reaches every member, so it must not claim to belong to
    // the receiver: `mine` is derived per viewer on the client instead.
    const frame = JSON.parse(buffer.slice(buffer.indexOf('data: {', buffer.indexOf('event: message')) + 6).split('\n')[0]);
    assert.equal(frame.message.mine, false, 'a broadcast frame is never marked as the receiver\'s own');
    assert.equal(frame.message.author.id, speaker.id, 'the broadcast names the real author');
    assert.equal(frame.message.reactions.mine, false, 'a broadcast never claims the receiver hearted it');

    // Typing indicator (throttled server-side, so this is the first one).
    await fetch(`${baseUrl}/api/community/typing`, { method: 'POST', headers: { Cookie: cookieFor(speaker) } });
    await readUntil('event: typing', 8000);
    assert.match(buffer, /event: typing/, 'typing events reach other members');
    assert.ok(!/"userId":"[^"]*","name":"[^"]*"[^}]*"userId"/.test(buffer.slice(buffer.indexOf('event: typing'))));
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve));
    cleanupUsers(listener, speaker);
  }
});

/* ── Front-end wiring ───────────────────────── */

test('community page, script and styles are wired up', () => {
  const page = read('public/pages/community.html');
  const js = read('public/js/community.js');
  const css = read('public/css/community.css');
  const api = read('public/js/api.js');
  const layout = read('public/js/layout.js');
  const icons = read('public/js/icons.js');
  const adminPage = read('views/admin.html');
  const adminJs = read('public/js/admin.js');
  const server = read('server.js');

  // Server wiring
  assert.match(server, /require\('\.\/routes\/community\.routes'\)/);
  assert.match(server, /app\.use\('\/api\/community', communityRoutes\)/);

  // Page shell
  assert.match(page, /<body data-page="community">/);
  for (const id of [
    'communityGuest', 'communityShell', 'chatScroll', 'chatList', 'chatComposer',
    'composerInput', 'composerSend', 'chatPinned', 'chatTyping', 'memberList',
    'chatToBottom', 'composerReply', 'chatStatus'
  ]) {
    assert.match(page, new RegExp(`id="${id}"`), `community.html needs #${id}`);
  }
  const htmlIds = [...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'no duplicate ids in community.html');
  assert.match(page, /\/css\/community\.css/);
  for (const script of ['/js/icons.js', '/js/api.js', '/js/auth.js', '/js/layout.js', '/js/main.js', '/js/community.js']) {
    assert.match(page, new RegExp(script.replace(/[/.]/g, '\\$&')), `community.html loads ${script}`);
  }

  // API client
  for (const method of [
    'communityRoom', 'communitySend', 'communityEdit', 'communityDelete',
    'communityReact', 'communityPin', 'communityUnpin', 'communityMarkRead',
    'communityUnreadCount', 'communityMembers', 'communityTyping', 'communityStreamUrl'
  ]) {
    assert.match(api, new RegExp(`${method}:`), `api.js exposes ${method}`);
  }

  // Room logic: escaping is not optional.
  assert.match(js, /function esc\(value\)/);
  assert.match(js, /function bodyHtml\(text\)/);
  assert.match(js, /linkify\(esc\(text\)\)/, 'member text is escaped before it is linkified');
  assert.doesNotMatch(js, /innerHTML\s*=\s*[a-zA-Z]+\.body\b/, 'never inject a raw message body');
  assert.doesNotMatch(js, /eval\(|new Function\(/, 'no dynamic code');
  assert.match(js, /new EventSource\(StudyCoreAPI\.communityStreamUrl\(\)/);
  assert.match(js, /addEventListener\('message'/);
  assert.match(js, /communityMarkRead\(\)/);

  // Shared chrome
  assert.match(layout, /id: 'community', label: 'Community', href: '\/pages\/community\.html'/);
  assert.match(layout, /navBadge_\$\{l\.badge\}/);
  assert.match(layout, /id="mobileNavCommunityBadge"/);
  assert.match(layout, /CommunityBadge\.init\(user\)/);
  assert.match(layout, /setCommunityUnread:/);
  assert.match(layout, /Open the Student Community/);
  assert.match(layout, /<li><a href="\/pages\/community\.html">Student Community<\/a><\/li>/);
  assert.match(icons, /'send':/);
  assert.match(icons, /'heart':/);
  assert.match(icons, /'pin':/);
  assert.match(icons, /'corner-up-left':/);

  // Admin moderation entry point
  assert.match(adminPage, /id="communityStats"/);
  assert.match(adminPage, /href="\/pages\/community\.html"/);
  assert.match(adminJs, /async function loadCommunityStats\(\)/);
  assert.match(adminJs, /loadCommunityStats\(\);/);

  // Styles
  for (const selector of ['.community-shell', '.chat-panel', '.msg-bubble', '.chat-composer', '.typing-dots', '.day-divider']) {
    assert.ok(css.includes(selector), `community.css defines ${selector}`);
  }
  assert.match(css, /prefers-reduced-motion/);
});

/* ── Client-side escaping (runs the real shipped functions) ───────────── */

test('community.js escapes member content and only links http(s) URLs', () => {
  const vm = require('node:vm');

  // Load the actual browser file in a bare context: enough of window/document
  // for the module to boot, and a stub icon renderer for the bubble markup.
  const context = vm.createContext({
    document: { addEventListener() {} },
    SC: { icon: (name) => `<svg data-icon="${name}"></svg>` },
    console
  });
  context.window = context;
  vm.runInContext(read('public/js/community.js'), context, { filename: 'public/js/community.js' });

  const internals = context.StudyCoreCommunity._internals;
  assert.ok(internals, 'community.js exposes its internals for testing');
  const { esc, bodyHtml, messageHtml } = internals;

  // 1. Raw HTML from a member is never passed through.
  const xss = '<img src=x onerror=alert(1)>';
  assert.equal(esc(xss).includes('<img'), false);
  const rendered = bodyHtml(xss);
  assert.equal(rendered.includes('<img'), false, 'no live tag may survive');
  assert.ok(rendered.includes('&lt;img'), 'it is rendered as escaped text');

  const scriptTag = bodyHtml('<script>alert(document.cookie)</script>');
  assert.equal(scriptTag.includes('<script'), false);

  // 2. Quotes cannot break out of an attribute.
  const quoteAttempt = bodyHtml('" onmouseover="alert(1)');
  assert.equal(quoteAttempt.includes('" onmouseover'), false);

  // 3. http(s) links become anchors; everything else stays plain text.
  const linked = bodyHtml('Notes: https://studycore.academy/pages/courses.html?a=1&b=2 ok');
  assert.match(linked, /<a class="msg-link" href="https:\/\/studycore\.academy\/pages\/courses\.html\?a=1&amp;b=2"/);
  assert.equal(bodyHtml('javascript:alert(1)').includes('<a '), false, 'javascript: is not linkified');
  assert.equal(bodyHtml('data:text/html,<script>').includes('<a '), false, 'data: is not linkified');
  assert.equal(bodyHtml('mail me at someone@example.com').includes('<a '), false, 'bare addresses stay text');

  // 4. Newlines survive as line breaks (multi-line questions stay readable).
  assert.ok(bodyHtml('line one\nline two').includes('<br>'));

  // 5. The bubble itself: a hostile author name and body both come out inert.
  const hostile = {
    id: 'cm-1',
    seq: 1,
    body: `${xss} and https://ok.example/x`,
    deleted: false,
    editedAt: null,
    pinned: false,
    createdAt: new Date().toISOString(),
    mine: false,
    author: { id: 'u-1', name: `<svg onload=alert(1)>`, role: 'STUDENT', isAdmin: false },
    replyTo: { id: 'cm-0', authorName: `<b onmouseover=alert(2)>Admin</b>`, bodyPreview: xss },
    reactions: { heart: 0, mine: false }
  };
  const html = messageHtml(hostile, null);
  assert.equal(html.includes('<svg onload'), false, 'author name must be escaped');
  assert.equal(html.includes('<img'), false, 'message body must be escaped');
  assert.equal(html.includes('<b onmouseover'), false, 'reply author must be escaped');
  assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'), 'the name is shown as text');
  assert.ok(html.includes('<a class="msg-link"'), 'a real link inside the body still works');
  assert.match(html, /data-msg-id="cm-1"/);

  // 6. Deleted messages carry no text at all.
  const deletedHtml = messageHtml({ ...hostile, deleted: true, body: '' }, null);
  assert.match(deletedHtml, /This message was deleted/);
  assert.equal(deletedHtml.includes('onerror'), false);
});

test('community JS parses successfully', () => {
  const vm = require('node:vm');
  for (const file of ['public/js/community.js', 'public/js/layout.js', 'public/js/api.js', 'public/js/icons.js', 'public/js/admin.js']) {
    const source = read(file);
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }), `${file} should parse`);
  }
  assert.doesNotThrow(() => require('../routes/community.routes'), 'community routes should load');
});
