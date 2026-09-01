// =============================================
// STUDYCORE — Community (routes/community.routes.js)
// -----------------------------------------------
// The on-site student group room: one shared, WhatsApp-style conversation
// where students ask questions freely, answer each other, and the admin
// joins in like any other member (with moderator powers).
//
//   GET    /api/community                 latest page of messages (+ members, pinned, unread)
//   GET    /api/community?before=<seq>    older page (scroll up)
//   GET    /api/community?after=<seq>     only messages newer than <seq> (poll fallback)
//   POST   /api/community                 send a message { body, replyToId? }
//   PATCH  /api/community/:id             edit your own message
//   DELETE /api/community/:id             delete your own message (admin: remove anyone's)
//   POST   /api/community/:id/react       toggle the heart on a message
//   POST   /api/community/:id/pin         admin: pin to the top of the room
//   DELETE /api/community/:id/pin         admin: unpin
//   POST   /api/community/read            mark the room read
//   GET    /api/community/unread-count    lightweight badge polling
//   GET    /api/community/members         participants + who is online now
//   GET    /api/community/stream          Server-Sent Events: live messages/typing/presence
//   POST   /api/community/typing          "Someone is typing…" (never stored)
//
// Every route sits behind requireAuth, and requireAuth re-reads the role from
// the users table on each call - so moderator powers come from the database,
// never from the token or the client.
//
// Live updates use SSE (built into Node/Express - no new dependency). SSE is
// one-directional and this deployment is a single process, so the fan-out is a
// plain in-process EventEmitter; the browser also polls `?after=` on a slow
// timer, so a dropped stream degrades to "slightly delayed" rather than dead.
// =============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { EventEmitter } = require('node:events');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ROLES, isAdmin, normalizeRole } = require('../lib/roles');
const { rateLimit } = require('../middleware/security');

const router = express.Router();
// The community remains a student + Main Admin feature. Content Admins have
// a separate restricted publishing surface and cannot post/read this room.
router.use(requireAuth, requireRole(ROLES.STUDENT, ROLES.ADMIN));

// A group chat is chatty, but not 500-messages-a-minute chatty. 30 posts per
// minute per IP is far more than any real student needs and still stops a
// script from flooding the room for everyone else.
const postLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

const MAX_BODY_LENGTH = 2000;
const PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 80;
const MAX_PINNED = 3;
const TYPING_THROTTLE_MS = 2000;
const TYPING_TTL_MS = 6000;
const MEMBER_WINDOW_DAYS = 30;

/* ── Live fan-out ───────────────────────────── */

// One emitter per process; every SSE response subscribes to it. setMaxListeners(0)
// because a busy room can legitimately have hundreds of open streams.
const bus = new EventEmitter();
bus.setMaxListeners(0);

/** userId -> Set<res>. Drives "online now" and the typing indicator. */
const clients = new Map();
/** userId -> timestamp of the last typing broadcast (server-side throttle). */
const lastTypingAt = new Map();

function broadcast(type, payload) {
  bus.emit('event', { type, payload });
}

function presenceList() {
  const out = [];
  for (const userId of clients.keys()) {
    const user = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(userId);
    if (user) out.push(publicMember(user, true));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function publicMember(user, isOnline) {
  return {
    id: user.id,
    name: user.name,
    role: normalizeRole(user.role) || ROLES.STUDENT,
    isAdmin: isAdmin(user),
    isOnline: Boolean(isOnline)
  };
}

/* ── Shared read helpers ────────────────────── */

function isAdminRequest(req) {
  return isAdmin(req.user);
}

// Seeds the read marker the first time this user touches the community, so the
// badge starts at zero instead of counting the entire history as unread.
function ensureReadState(userId) {
  const existing = db.prepare('SELECT last_read_at FROM community_read_state WHERE user_id = ?').get(userId);
  if (existing) return existing.last_read_at;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO community_read_state (user_id, last_read_at) VALUES (?, ?)').run(userId, now);
  return now;
}

function unreadCount(userId) {
  const since = ensureReadState(userId);
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM community_messages
    WHERE created_at > ? AND deleted = 0 AND user_id <> ?
  `).get(since, userId);
  return row ? row.count : 0;
}

const MESSAGE_SELECT = `
  SELECT m.rowid AS seq, m.id, m.body, m.reply_to_id, m.pinned, m.deleted, m.edited_at,
         m.created_at, m.user_id,
         u.name AS author_name, u.role AS author_role,
         rp.id AS reply_id, rp.body AS reply_body, rp.deleted AS reply_deleted,
         ru.name AS reply_author_name
  FROM community_messages m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN community_messages rp ON rp.id = m.reply_to_id
  LEFT JOIN users ru ON ru.id = rp.user_id
`;

function shapeMessage(row, viewerId, reactionMap) {
  const deleted = Boolean(row.deleted);
  const reactions = (reactionMap && reactionMap.get(row.id)) || { total: 0, mine: false };
  const replyVisible = row.reply_id && !row.reply_deleted;
  return {
    id: row.id,
    seq: row.seq,
    body: deleted ? '' : row.body,
    deleted,
    editedAt: row.edited_at || null,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    mine: row.user_id === viewerId,
    author: {
      id: row.user_id,
      name: row.author_name,
      role: normalizeRole(row.author_role) || ROLES.STUDENT,
      isAdmin: normalizeRole(row.author_role) === ROLES.ADMIN
    },
    replyTo: replyVisible
      ? {
        id: row.reply_id,
        authorName: row.reply_author_name || 'Member',
        bodyPreview: String(row.reply_body || '').slice(0, 140)
      }
      : null,
    reactions: { heart: deleted ? 0 : reactions.total, mine: Boolean(reactions.mine) }
  };
}

// Reactions are aggregated in one query instead of one-per-message.
function reactionMapFor(ids, viewerId) {
  const map = new Map();
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT message_id,
           COUNT(*) AS total,
           SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
    FROM community_reactions
    WHERE message_id IN (${placeholders})
    GROUP BY message_id
  `).all(viewerId, ...ids);
  for (const r of rows) map.set(r.message_id, { total: r.total, mine: r.mine > 0 });
  return map;
}

function messageById(id, viewerId) {
  const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id);
  if (!row) return null;
  return shapeMessage(row, viewerId, reactionMapFor([row.id], viewerId));
}

/* ── Room state ─────────────────────────────── */

function pinnedMessages(viewerId) {
  const rows = db.prepare(`${MESSAGE_SELECT} WHERE m.pinned = 1 AND m.deleted = 0 ORDER BY m.rowid DESC LIMIT ?`).all(MAX_PINNED);
  const map = reactionMapFor(rows.map((r) => r.id), viewerId);
  return rows.map((r) => shapeMessage(r, viewerId, map));
}

function membersAndPresence() {
  const since = new Date(Date.now() - MEMBER_WINDOW_DAYS * 86400000).toISOString();
  const recent = db.prepare(`
    SELECT u.id, u.name, u.role, COUNT(*) AS posts, MAX(m.created_at) AS last_posted_at
    FROM community_messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.deleted = 0 AND m.created_at >= ?
    GROUP BY u.id
    ORDER BY last_posted_at DESC
    LIMIT 40
  `).all(since);

  const onlineIds = new Set(clients.keys());
  const members = recent.map((r) => ({
    ...publicMember(r, onlineIds.has(r.id)),
    posts: r.posts,
    lastPostedAt: r.last_posted_at
  }));
  const listed = new Set(members.map((m) => m.id));

  // Anyone online right now belongs in the list even if their last post is
  // older than the window (or they have never posted at all).
  for (const userId of onlineIds) {
    if (listed.has(userId)) continue;
    const user = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(userId);
    if (user) members.push({ ...publicMember(user, true), posts: 0, lastPostedAt: null });
  }

  members.sort((a, b) => (b.isOnline - a.isOnline) || new Date(b.lastPostedAt || 0) - new Date(a.lastPostedAt || 0));
  return {
    members,
    onlineCount: onlineIds.size,
    totalMembers: db.prepare('SELECT COUNT(*) AS c FROM users').get().c
  };
}

function roomStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return {
    totalMessages: db.prepare('SELECT COUNT(*) AS c FROM community_messages WHERE deleted = 0').get().c,
    messagesToday: db.prepare('SELECT COUNT(*) AS c FROM community_messages WHERE deleted = 0 AND created_at >= ?')
      .get(today.toISOString()).c,
    participants: db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM community_messages WHERE deleted = 0').get().c
  };
}

/* ── Message body sanitising ────────────────── */

// Stored raw and escaped on render (see public/js/community.js). Only truly
// dangerous control characters are stripped here; newlines are kept so
// multi-line questions stay readable.
function cleanBody(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function validReplyTarget(replyToId) {
  if (!replyToId) return { ok: true, target: null };
  const target = db.prepare('SELECT id, deleted FROM community_messages WHERE id = ?').get(replyToId);
  if (!target || target.deleted) return { ok: false, message: 'That message is no longer available to reply to.' };
  return { ok: true, target };
}

/* ── Routes ─────────────────────────────────── */

// Latest page (or an older/newer window) of the conversation.
router.get('/', (req, res) => {
  const viewerId = req.user.id;
  ensureReadState(viewerId);
  const limit = Math.min(Math.max(Number(req.query.limit) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const beforeSeq = Number(req.query.before);
  const afterSeq = Number(req.query.after);

  let rows = [];
  let hasMore = false;

  if (Number.isFinite(afterSeq) && afterSeq > 0) {
    // Incremental catch-up used by the polling fallback.
    rows = db.prepare(`${MESSAGE_SELECT} WHERE m.rowid > ? ORDER BY m.rowid ASC LIMIT ?`).all(afterSeq, MAX_PAGE_SIZE);
  } else {
    const useBefore = Number.isFinite(beforeSeq) && beforeSeq > 0;
    const where = useBefore ? 'WHERE m.rowid < ?' : '';
    const params = useBefore ? [beforeSeq, limit + 1] : [limit + 1];
    const fetched = db.prepare(`${MESSAGE_SELECT} ${where} ORDER BY m.rowid DESC LIMIT ?`).all(...params);
    hasMore = fetched.length > limit;
    rows = fetched.slice(0, limit).reverse();
  }

  const map = reactionMapFor(rows.map((r) => r.id), viewerId);
  const { members, onlineCount, totalMembers } = membersAndPresence();

  res.json({
    messages: rows.map((r) => shapeMessage(r, viewerId, map)),
    hasMore,
    pinned: pinnedMessages(viewerId),
    members,
    onlineCount,
    totalMembers,
    stats: roomStats(),
    unreadCount: unreadCount(viewerId),
    lastReadAt: db.prepare('SELECT last_read_at FROM community_read_state WHERE user_id = ?').get(viewerId)?.last_read_at || null,
    serverTime: new Date().toISOString(),
    // The JWT only carries id/email/role, so the display name comes from the
    // users table (same reason the role is re-read on every request).
    me: {
      id: viewerId,
      name: db.prepare('SELECT name FROM users WHERE id = ?').get(viewerId)?.name || null,
      role: req.user.role,
      isAdmin: isAdminRequest(req)
    },
    limits: { maxBodyLength: MAX_BODY_LENGTH, maxPinned: MAX_PINNED }
  });
});

// Send a message to the room.
router.post('/', postLimiter, (req, res) => {
  const body = cleanBody(req.body && req.body.body);
  if (!body) return res.status(400).json({ message: 'Write something before sending.' });
  if (body.length > MAX_BODY_LENGTH) {
    return res.status(400).json({ message: `Messages are limited to ${MAX_BODY_LENGTH} characters.` });
  }

  const replyToId = typeof req.body.replyToId === 'string' && req.body.replyToId.trim() ? req.body.replyToId.trim() : null;
  const reply = validReplyTarget(replyToId);
  if (!reply.ok) return res.status(400).json({ message: reply.message });

  const id = `cm-${uuidv4()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO community_messages (id, user_id, body, reply_to_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, req.user.id, body, reply.target ? reply.target.id : null, now);

  // The response is shaped for the sender (mine: true); the fan-out is shaped
  // for nobody in particular, because `mine` and `reactions.mine` are
  // per-viewer facts and the stream reaches everyone at once.
  const message = messageById(id, req.user.id);
  broadcast('message', { message: messageById(id, null) });
  res.status(201).json({ message, unreadCount: unreadCount(req.user.id) });
});

// Edit your own message (WhatsApp-style "edited" marker, no silent rewrites).
router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM community_messages WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Message not found.' });
  if (row.user_id !== req.user.id && !isAdminRequest(req)) {
    return res.status(403).json({ message: 'You can only edit your own messages.' });
  }
  if (row.deleted) return res.status(400).json({ message: 'That message has been deleted.' });

  const body = cleanBody(req.body && req.body.body);
  if (!body) return res.status(400).json({ message: 'Write something before saving.' });
  if (body.length > MAX_BODY_LENGTH) {
    return res.status(400).json({ message: `Messages are limited to ${MAX_BODY_LENGTH} characters.` });
  }
  if (body === row.body) return res.json({ message: messageById(row.id, req.user.id) });

  const now = new Date().toISOString();
  db.prepare('UPDATE community_messages SET body = ?, edited_at = ? WHERE id = ?').run(body, now, row.id);

  const message = messageById(row.id, req.user.id);
  broadcast('edit', { message: messageById(row.id, null) });
  res.json({ message });
});

// Students soft-delete their own message; an admin moderating somebody else's
// message removes it entirely.
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM community_messages WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Message not found.' });

  const admin = isAdminRequest(req);
  if (row.user_id !== req.user.id && !admin) {
    return res.status(403).json({ message: 'You can only delete your own messages.' });
  }

  if (row.user_id === req.user.id) {
    if (row.deleted) return res.json({ success: true, id: row.id, hardDeleted: false });
    db.prepare('UPDATE community_messages SET deleted = 1, body = \'\', pinned = 0, edited_at = NULL WHERE id = ?').run(row.id);
    broadcast('delete', { id: row.id, mine: true });
    return res.json({ success: true, id: row.id, hardDeleted: false });
  }

  // Admin moderation of another member's message.
  db.prepare('DELETE FROM community_messages WHERE id = ?').run(row.id);
  broadcast('delete', { id: row.id, mine: false, removedByAdmin: true });
  res.json({ success: true, id: row.id, hardDeleted: true });
});

// Toggle the heart on a message (idempotent: post again to remove it).
router.post('/:id/react', (req, res) => {
  const row = db.prepare('SELECT id, deleted FROM community_messages WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Message not found.' });
  if (row.deleted) return res.status(400).json({ message: 'That message has been deleted.' });

  const existing = db.prepare('SELECT id FROM community_reactions WHERE message_id = ? AND user_id = ?').get(row.id, req.user.id);
  if (existing) {
    db.prepare('DELETE FROM community_reactions WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO community_reactions (id, message_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(`cr-${uuidv4()}`, row.id, req.user.id, new Date().toISOString());
  }

  const counts = db.prepare(`
    SELECT COUNT(*) AS total FROM community_reactions WHERE message_id = ?
  `).get(row.id);
  const liked = !existing;
  // Broadcast the new count only — whether *you* hearted it is a per-viewer
  // fact that each client already knows.
  broadcast('react', { id: row.id, reactions: { heart: counts.total } });
  res.json({ success: true, id: row.id, reactions: { heart: counts.total, mine: liked } });
});

// Pin / unpin — admin only, capped so the top of the room stays readable.
router.post('/:id/pin', (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ message: 'Only the StudyCore admin can pin messages.' });
  const row = db.prepare('SELECT id, deleted, pinned FROM community_messages WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Message not found.' });
  if (row.deleted) return res.status(400).json({ message: 'That message has been deleted.' });

  if (!row.pinned) {
    const pinnedCount = db.prepare('SELECT COUNT(*) AS c FROM community_messages WHERE pinned = 1 AND deleted = 0').get().c;
    if (pinnedCount >= MAX_PINNED) {
      return res.status(400).json({ message: `Only ${MAX_PINNED} messages can be pinned at once. Unpin one first.` });
    }
    db.prepare('UPDATE community_messages SET pinned = 1, pinned_by = ? WHERE id = ?').run(req.user.id, row.id);
  }

  const pinned = pinnedMessages(req.user.id);
  broadcast('pin', { pinned });
  res.json({ success: true, pinned });
});

router.delete('/:id/pin', (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ message: 'Only the StudyCore admin can unpin messages.' });
  const row = db.prepare('SELECT id FROM community_messages WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Message not found.' });
  db.prepare('UPDATE community_messages SET pinned = 0, pinned_by = NULL WHERE id = ?').run(row.id);

  const pinned = pinnedMessages(req.user.id);
  broadcast('pin', { pinned });
  res.json({ success: true, pinned });
});

// Called by the room page while it is open, so the nav badge clears.
router.post('/read', (req, res) => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO community_read_state (user_id, last_read_at) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_read_at = excluded.last_read_at
  `).run(req.user.id, now);
  res.json({ success: true, unreadCount: 0 });
});

router.get('/unread-count', (req, res) => {
  res.json({ unreadCount: unreadCount(req.user.id) });
});

router.get('/members', (req, res) => {
  const { members, onlineCount, totalMembers } = membersAndPresence();
  res.json({ members, onlineCount, totalMembers, stats: roomStats() });
});

// "Chisanga is typing…" — transient, never written to the database.
router.post('/typing', (req, res) => {
  const now = Date.now();
  const last = lastTypingAt.get(req.user.id) || 0;
  if (now - last < TYPING_THROTTLE_MS) return res.json({ success: true, throttled: true });
  lastTypingAt.set(req.user.id, now);

  broadcast('typing', {
    userId: req.user.id,
    name: db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id)?.name || 'Someone',
    isAdmin: isAdminRequest(req),
    at: new Date().toISOString(),
    ttlMs: TYPING_TTL_MS
  });
  res.json({ success: true });
});

// Live stream. Kept deliberately small: message / edit / delete / react / pin /
// typing / presence. The client treats the stream as an optimisation, not a
// requirement — if it drops, polling picks up within a few seconds.
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Proxies (nginx, some CDNs) buffer event streams by default.
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 4000\n\n');

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client already gone */ }
  };

  // Keep-alive so idle connections are not reaped by a proxy.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25000);
  heartbeat.unref?.();

  const userId = req.user.id;
  let bucket = clients.get(userId);
  const isNewBucket = !bucket;
  if (!bucket) {
    bucket = new Set();
    clients.set(userId, bucket);
  }
  bucket.add(res);

  // The newcomer gets the current room state straight away, then everyone
  // (including them) hears about the presence change.
  send('presence', { online: presenceList(), onlineCount: clients.size });
  if (isNewBucket) broadcast('presence', { online: presenceList(), onlineCount: clients.size });

  const onEvent = ({ type, payload }) => {
    // Nobody needs their own typing indicator echoed back.
    if (type === 'typing' && payload.userId === userId) return;
    send(type, payload);
  };
  bus.on('event', onEvent);

  const cleanup = () => {
    clearInterval(heartbeat);
    bus.off('event', onEvent);
    const current = clients.get(userId);
    if (current) {
      current.delete(res);
      if (current.size === 0) {
        clients.delete(userId);
        broadcast('presence', { online: presenceList(), onlineCount: clients.size });
      }
    }
    try { res.end(); } catch { /* ignore */ }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
});

module.exports = router;
// Exported for tests: lets a test assert the fan-out really is wired without
// having to open a socket.
module.exports.__internals = { broadcast, bus, clients, cleanBody, unreadCount, MAX_BODY_LENGTH, MAX_PINNED };
