const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ROLES } = require('../lib/roles');
const { resourceVisibilityClause, programCanSeeResource } = require('../lib/program-access');

const router = express.Router();
router.use(requireAuth, requireRole(ROLES.STUDENT, ROLES.ADMIN));

// Announcements obey the SAME program targeting as every other resource:
// a Law announcement only reaches Law students; "All Students" reaches
// everyone. The bell unread count and the list both filter server-side.
function getUnreadCount(user) {
  const vis = resourceVisibilityClause(user, 'r', 'notifProgram');
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM resources r
    WHERE r.category = 'announcement'
      AND r.publish_status = 'published'
      ${vis.clause ? `AND ${vis.clause}` : ''}
      AND NOT EXISTS (
        SELECT 1 FROM announcement_reads ar
        WHERE ar.announcement_id = r.id AND ar.user_id = @userId
      )
  `).get({ userId: user.id, ...vis.params });
  return row ? row.count : 0;
}

// GET /api/notifications?limit=20
// Returns published announcements ordered by pinned DESC, created_at DESC
// along with the current user's read/unread status and total unread count.
router.get('/', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  const vis = resourceVisibilityClause(user, 'r', 'notifProgram');

  const rows = db.prepare(`
    SELECT r.id, r.title, r.description, r.category, r.subject, r.course, r.topic,
           r.pinned, r.created_at, r.updated_at,
           (CASE WHEN ar.id IS NOT NULL THEN 1 ELSE 0 END) AS is_read,
           ar.read_at
    FROM resources r
    LEFT JOIN announcement_reads ar ON ar.announcement_id = r.id AND ar.user_id = @userId
    WHERE r.category = 'announcement' AND r.publish_status = 'published'
      ${vis.clause ? `AND ${vis.clause}` : ''}
    ORDER BY r.pinned DESC, r.created_at DESC
    LIMIT @limit
  `).all({ userId: user.id, limit, ...vis.params });

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM resources r
    WHERE r.category = 'announcement' AND r.publish_status = 'published'
      ${vis.clause ? `AND ${vis.clause}` : ''}
  `).get({ ...vis.params });

  const unreadCount = getUnreadCount(user);

  res.json({
    unreadCount,
    total: totalRow ? totalRow.count : 0,
    announcements: rows.map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      category: a.category,
      subject: a.subject,
      course: a.course,
      topic: a.topic || null,
      pinned: Boolean(a.pinned),
      isRead: Boolean(a.is_read),
      readAt: a.read_at || null,
      createdAt: a.created_at,
      updatedAt: a.updated_at
    }))
  });
});

// GET /api/notifications/unread-count
// Lightweight endpoint for periodic polling.
router.get('/unread-count', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  const unreadCount = getUnreadCount(user);
  res.json({ unreadCount });
});

// POST /api/notifications/:id/read
// Marks a specific published announcement as read for the current user.
router.post('/:id/read', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const announcement = db.prepare(`
    SELECT * FROM resources
    WHERE id = ? AND category = 'announcement' AND publish_status = 'published'
  `).get(req.params.id);

  if (!announcement) {
    return res.status(404).json({ message: 'Announcement not found.' });
  }
  // Program permission applies to read-state too.
  if (user && !programCanSeeResource(user, announcement)) {
    return res.status(403).json({ message: 'This announcement is not for your program.' });
  }

  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO announcement_reads (id, user_id, announcement_id, read_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, announcement_id) DO NOTHING
    `).run(`ar-${uuidv4()}`, user.id, announcement.id, now);
  } catch (err) {
    console.error('Error recording announcement read:', err.message);
  }

  const unreadCount = getUnreadCount(user);
  res.json({ success: true, unreadCount });
});

// POST /api/notifications/read-all
// Marks all published (and program-visible) announcements as read.
router.post('/read-all', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  const vis = resourceVisibilityClause(user, 'r', 'notifProgram');
  const unreadRows = db.prepare(`
    SELECT r.id
    FROM resources r
    WHERE r.category = 'announcement'
      AND r.publish_status = 'published'
      ${vis.clause ? `AND ${vis.clause}` : ''}
      AND NOT EXISTS (
        SELECT 1 FROM announcement_reads ar
        WHERE ar.announcement_id = r.id AND ar.user_id = @userId
      )
  `).all({ userId: user.id, ...vis.params });

  const now = new Date().toISOString();
  const insertStmt = db.prepare(`
    INSERT INTO announcement_reads (id, user_id, announcement_id, read_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, announcement_id) DO NOTHING
  `);

  for (const item of unreadRows) {
    try {
      insertStmt.run(`ar-${uuidv4()}`, user.id, item.id, now);
    } catch {
      // ignore
    }
  }

  res.json({ success: true, unreadCount: getUnreadCount(user) });
});

module.exports = router;
