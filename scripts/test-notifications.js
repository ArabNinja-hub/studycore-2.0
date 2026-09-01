'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { createToken, COOKIE_NAME } = require('../middleware/auth');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('announcement_reads table exists and has proper schema', () => {
  const table = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='announcement_reads'
  `).get();
  assert.ok(table, 'announcement_reads table should exist in database');

  const indexes = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='announcement_reads'
  `).all().map((i) => i.name);
  assert.ok(indexes.includes('idx_announcement_reads_user'), 'idx_announcement_reads_user index should exist');
  assert.ok(indexes.includes('idx_announcement_reads_announcement'), 'idx_announcement_reads_announcement index should exist');
});

test('announcement notification read/unread flow and persistence across users', async () => {
  // 1. Create two test students and one test admin
  const user1Id = `user-test1-${Date.now()}`;
  const user2Id = `user-test2-${Date.now()}`;
  const adminId = `admin-test-${Date.now()}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, created_at)
    VALUES (?, ?, ?, 'pass123', 'student', ?)
  `).run(user1Id, 'Student One', `student1.${Date.now()}@test.com`, now);

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, created_at)
    VALUES (?, ?, ?, 'pass123', 'student', ?)
  `).run(user2Id, 'Student Two', `student2.${Date.now()}@test.com`, now);

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, created_at)
    VALUES (?, ?, ?, 'pass123', 'admin', ?)
  `).run(adminId, 'Admin Test', `admin.${Date.now()}@test.com`, now);

  // Mark all existing published announcements as read for these fresh test users
  // so we can test the delta cleanly
  const existingPublished = db.prepare(`
    SELECT id FROM resources WHERE category = 'announcement' AND publish_status = 'published'
  `).all();
  for (const row of existingPublished) {
    db.prepare(`
      INSERT INTO announcement_reads (id, user_id, announcement_id, read_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, announcement_id) DO NOTHING
    `).run(`ar-${uuidv4()}`, user1Id, row.id, now);
    db.prepare(`
      INSERT INTO announcement_reads (id, user_id, announcement_id, read_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, announcement_id) DO NOTHING
    `).run(`ar-${uuidv4()}`, user2Id, row.id, now);
  }

  // Helper to query unread count for a user directly from db logic
  const getUnread = (userId) => {
    return db.prepare(`
      SELECT COUNT(*) AS count
      FROM resources r
      WHERE r.category = 'announcement'
        AND r.publish_status = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM announcement_reads ar
          WHERE ar.announcement_id = r.id AND ar.user_id = ?
        )
    `).get(userId).count;
  };

  assert.equal(getUnread(user1Id), 0, 'User 1 starts with 0 unread');
  assert.equal(getUnread(user2Id), 0, 'User 2 starts with 0 unread');

  // 2. Create two new announcements + one draft
  const ann1Id = `res-ann1-${Date.now()}`;
  const ann2Id = `res-ann2-${Date.now()}`;
  const ann3DraftId = `res-ann3-draft-${Date.now()}`;

  db.prepare(`
    INSERT INTO resources (id, title, description, category, is_premium, pinned, publish_status, uploaded_by, created_at, updated_at)
    VALUES (?, ?, ?, 'announcement', 0, 1, 'published', ?, ?, ?)
  `).run(ann1Id, 'Welcome to Semester 2', 'Important dates and syllabus updates.', adminId, now, now);

  db.prepare(`
    INSERT INTO resources (id, title, description, category, is_premium, pinned, publish_status, uploaded_by, created_at, updated_at)
    VALUES (?, ?, ?, 'announcement', 0, 0, 'published', ?, ?, ?)
  `).run(ann2Id, 'Physics Past Papers Uploaded', '2024 Past papers now available.', adminId, now, now);

  db.prepare(`
    INSERT INTO resources (id, title, description, category, is_premium, pinned, publish_status, uploaded_by, created_at, updated_at)
    VALUES (?, ?, ?, 'announcement', 0, 0, 'draft', ?, ?, ?)
  `).run(ann3DraftId, 'Draft Announcement', 'Should not appear as unread.', adminId, now, now);

  // Helper to get announcements with read status
  const getAnnouncements = (userId) => {
    return db.prepare(`
      SELECT r.id, r.title, r.pinned,
             (CASE WHEN ar.id IS NOT NULL THEN 1 ELSE 0 END) AS is_read,
             ar.read_at
      FROM resources r
      LEFT JOIN announcement_reads ar ON ar.announcement_id = r.id AND ar.user_id = ?
      WHERE r.category = 'announcement' AND r.publish_status = 'published'
      ORDER BY r.pinned DESC, r.created_at DESC
    `).all(userId);
  };

  // 3. Verify unread count: exactly 2 new published announcements
  assert.equal(getUnread(user1Id), 2, 'User 1 should have 2 unread announcements');
  assert.equal(getUnread(user2Id), 2, 'User 2 should have 2 unread announcements');

  const listUser1 = getAnnouncements(user1Id);
  const itemAnn1 = listUser1.find((a) => a.id === ann1Id);
  const itemAnn2 = listUser1.find((a) => a.id === ann2Id);
  assert.equal(itemAnn1.is_read, 0, 'First announcement unread');
  assert.equal(itemAnn2.is_read, 0, 'Second announcement unread');
  assert.equal(itemAnn1.pinned, 1, 'Pinned announcement has pinned flag');

  // 4. User 1 marks ann1 as read
  db.prepare(`
    INSERT INTO announcement_reads (id, user_id, announcement_id, read_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, announcement_id) DO NOTHING
  `).run(`ar-${uuidv4()}`, user1Id, ann1Id, new Date().toISOString());

  // Verify User 1 now has 1 unread, User 2 still has 2 unread
  assert.equal(getUnread(user1Id), 1, 'User 1 should now have 1 unread announcement');
  assert.equal(getUnread(user2Id), 2, 'User 2 unread count should be isolated and remain 2');

  const updatedListUser1 = getAnnouncements(user1Id);
  const item1 = updatedListUser1.find((a) => a.id === ann1Id);
  const item2 = updatedListUser1.find((a) => a.id === ann2Id);
  assert.equal(item1.is_read, 1, 'Announcement 1 is marked as read for User 1');
  assert.ok(item1.read_at, 'read_at timestamp is set');
  assert.equal(item2.is_read, 0, 'Announcement 2 remains unread for User 1');

  // 5. Admin publishes a 4th announcement
  const ann4Id = `res-ann4-${Date.now()}`;
  db.prepare(`
    INSERT INTO resources (id, title, description, category, is_premium, pinned, publish_status, uploaded_by, created_at, updated_at)
    VALUES (?, ?, ?, 'announcement', 0, 0, 'published', ?, ?, ?)
  `).run(ann4Id, 'Chemistry Lab Schedule', 'Updated lab groups.', adminId, now, now);

  // Automatically unread for all users without manual notification creation
  assert.equal(getUnread(user1Id), 2, 'User 1 unread count automatically increases to 2');
  assert.equal(getUnread(user2Id), 3, 'User 2 unread count automatically increases to 3');

  // 6. User 1 marks all as read
  const unreadRows = db.prepare(`
    SELECT r.id FROM resources r
    WHERE r.category = 'announcement' AND r.publish_status = 'published'
      AND NOT EXISTS (
        SELECT 1 FROM announcement_reads ar
        WHERE ar.announcement_id = r.id AND ar.user_id = ?
      )
  `).all(user1Id);

  const insertStmt = db.prepare(`
    INSERT INTO announcement_reads (id, user_id, announcement_id, read_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, announcement_id) DO NOTHING
  `);
  for (const row of unreadRows) {
    insertStmt.run(`ar-${uuidv4()}`, user1Id, row.id, new Date().toISOString());
  }

  assert.equal(getUnread(user1Id), 0, 'User 1 unread count should now be 0');
  assert.equal(getUnread(user2Id), 3, 'User 2 unread count remains 3');

  // 7. Cascade on delete: when an announcement is deleted, announcement_reads rows are deleted
  db.prepare(`DELETE FROM resources WHERE id = ?`).run(ann1Id);
  const orphanedReads = db.prepare(`
    SELECT COUNT(*) AS count FROM announcement_reads WHERE announcement_id = ?
  `).get(ann1Id).count;
  assert.equal(orphanedReads, 0, 'Foreign key cascade should remove reads when announcement is deleted');

  // 8. Clean up test users
  db.prepare(`DELETE FROM users WHERE id IN (?, ?, ?)`).run(user1Id, user2Id, adminId);
  db.prepare(`DELETE FROM resources WHERE id IN (?, ?, ?)`).run(ann2Id, ann3DraftId, ann4Id);
});

test('HTTP API: /api/notifications endpoints and session auth', async () => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const notificationRoutes = require('../routes/notifications.routes');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/notifications', notificationRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const studentUser = {
    id: `student-http-${Date.now()}`,
    name: 'HTTP Student',
    email: `student.http.${Date.now()}@test.com`,
    password: 'pass',
    role: 'student',
    created_at: new Date().toISOString()
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, created_at)
    VALUES (@id, @name, @email, @password, @role, @created_at)
  `).run(studentUser);

  const annId = `ann-http-${Date.now()}`;
  db.prepare(`
    INSERT INTO resources (id, title, description, category, is_premium, pinned, publish_status, uploaded_by, created_at, updated_at)
    VALUES (?, 'Test HTTP Announcement', 'Announcement details here.', 'announcement', 0, 0, 'published', ?, ?, ?)
  `).run(annId, studentUser.id, new Date().toISOString(), new Date().toISOString());

  const token = createToken(studentUser);
  const authHeader = `${COOKIE_NAME}=${token}`;

  try {
    // 1. Unauthenticated request -> 401
    const unauthRes = await fetch(`${baseUrl}/api/notifications`);
    assert.equal(unauthRes.status, 401, 'Unauthenticated request should return 401');

    // 2. Authenticated GET /api/notifications
    const listRes = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Cookie: authHeader }
    });
    assert.equal(listRes.status, 200, 'Authenticated request should return 200');
    const listData = await listRes.json();
    assert.ok(typeof listData.unreadCount === 'number');
    assert.ok(Array.isArray(listData.announcements));
    const targetAnn = listData.announcements.find((a) => a.id === annId);
    assert.ok(targetAnn, 'Target announcement should be in list');
    assert.equal(targetAnn.isRead, false, 'Announcement should be unread initially');

    // 3. GET /api/notifications/unread-count
    const countRes = await fetch(`${baseUrl}/api/notifications/unread-count`, {
      headers: { Cookie: authHeader }
    });
    assert.equal(countRes.status, 200);
    const countData = await countRes.json();
    assert.ok(countData.unreadCount >= 1, 'Unread count should be >= 1');

    // 4. POST /api/notifications/:id/read
    const readRes = await fetch(`${baseUrl}/api/notifications/${annId}/read`, {
      method: 'POST',
      headers: { Cookie: authHeader }
    });
    assert.equal(readRes.status, 200);
    const readData = await readRes.json();
    assert.equal(readData.success, true);

    // 5. Verify target is now read in list
    const listAfterRes = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Cookie: authHeader }
    });
    const listAfterData = await listAfterRes.json();
    const targetAfter = listAfterData.announcements.find((a) => a.id === annId);
    assert.equal(targetAfter.isRead, true, 'Announcement should now be marked as read');
    assert.ok(targetAfter.readAt, 'readAt timestamp should be present');

    // 6. POST /api/notifications/read-all
    const readAllRes = await fetch(`${baseUrl}/api/notifications/read-all`, {
      method: 'POST',
      headers: { Cookie: authHeader }
    });
    assert.equal(readAllRes.status, 200);
    const readAllData = await readAllRes.json();
    assert.equal(readAllData.success, true);
    assert.equal(readAllData.unreadCount, 0);

    // 7. Verify unread count is 0
    const finalCountRes = await fetch(`${baseUrl}/api/notifications/unread-count`, {
      headers: { Cookie: authHeader }
    });
    const finalCountData = await finalCountRes.json();
    assert.equal(finalCountData.unreadCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.prepare(`DELETE FROM users WHERE id = ?`).run(studentUser.id);
    db.prepare(`DELETE FROM resources WHERE id = ?`).run(annId);
  }
});

test('UI and layout components for notification bell, dropdown, and modal', () => {
  const layout = read('public/js/layout.js');
  const css = read('public/css/style.css');
  const annHtml = read('public/pages/announcements.html');
  const dashJs = read('public/js/dashboard.js');
  const apiJs = read('public/js/api.js');

  // 1. Navigation bell in layout.js
  assert.match(layout, /id="notifWrapper"/, 'Notification wrapper element in layout.js');
  assert.match(layout, /id="notifBellBtn"/, 'Notification bell button element in layout.js');
  assert.match(layout, /id="notifBadge"/, 'Notification badge element in layout.js');
  assert.match(layout, /id="notifPanel"/, 'Notification panel element in layout.js');
  assert.match(layout, /id="notifMarkAllBtn"/, 'Mark all as read button in notification panel');
  assert.match(layout, /SC\.icon\('bell'/, 'Uses Lucide bell icon');
  assert.match(layout, /openAnnouncementModal/, 'openAnnouncementModal function defined');
  assert.match(layout, /refreshNotifications/, 'refreshNotifications method exposed on SCLayout');

  // 2. Mobile drawer unread indicator
  assert.match(layout, /id="mobileNavNotifBadge"/, 'Mobile nav drawer announcement badge present');

  // 3. CSS styles
  assert.match(css, /\.notif-wrapper/, '.notif-wrapper style present');
  assert.match(css, /\.notif-bell-btn/, '.notif-bell-btn style present');
  assert.match(css, /\.notif-badge/, '.notif-badge style present');
  assert.match(css, /\.notif-panel/, '.notif-panel style present');
  assert.match(css, /\.notif-item/, '.notif-item style present');
  assert.match(css, /\.notif-item\.unread/, '.notif-item.unread style present');
  assert.match(css, /\.notif-unread-dot/, '.notif-unread-dot style present');

  // 4. API methods in api.js
  assert.match(apiJs, /getNotifications:/, 'StudyCoreAPI.getNotifications defined');
  assert.match(apiJs, /getUnreadNotificationCount:/, 'StudyCoreAPI.getUnreadNotificationCount defined');
  assert.match(apiJs, /markNotificationRead:/, 'StudyCoreAPI.markNotificationRead defined');
  assert.match(apiJs, /markAllNotificationsRead:/, 'StudyCoreAPI.markAllNotificationsRead defined');

  // 5. Announcements page has mark all as read and modal triggers
  assert.match(annHtml, /markAllNotificationsRead/, 'announcements.html supports markAllNotificationsRead');
  assert.match(annHtml, /openAnnouncementModal/, 'announcements.html integrates with announcement modal');

  // 6. Dashboard page connects to notifications
  assert.match(dashJs, /getNotifications/, 'dashboard.js uses notification API');
  assert.match(dashJs, /openAnnouncementModal/, 'dashboard.js integrates with announcement modal');
});
