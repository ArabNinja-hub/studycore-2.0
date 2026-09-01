const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole, attachUser } = require('../middleware/auth');
const { ROLES, isAdmin, isStudent } = require('../lib/roles');
const {
  serializeProgram,
  serializeCourse,
  courseCodeToSlug
} = require('../lib/programs');
const {
  resourceVisibilityClause,
  programIncludesCourse,
  coursesForProgram,
  resolveCourse
} = require('../lib/program-access');

const router = express.Router();
const requireStudentLearningAccount = requireRole(ROLES.STUDENT, ROLES.ADMIN);

// Course content always reflects the latest admin uploads.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const LEARN_CATEGORIES = ['video', 'document', 'tutorial', 'past_paper'];
const CATEGORY_ORDER = { video: 0, document: 1, tutorial: 2, past_paper: 3 };

function accessFor(user) {
  const now = Date.now();
  const subEnd = new Date(user.subscription_end || 0).getTime();
  const trialEnd = new Date(user.trial_end || 0).getTime();
  const premium = isAdmin(user) || (isStudent(user) && user.subscription === 'premium' && now < subEnd);
  const trial = !premium && isStudent(user) && now < trialEnd;
  return { premium, trial };
}

function canAccess(row, access) {
  if (row.category === 'announcement') return true;
  if (!row.is_premium) return true;
  if (row.category === 'video') return access.premium;
  return access.premium || access.trial;
}

function lockReason(row, access) {
  if (row.category === 'video' && !access.premium) return 'video';
  if (!access.premium && !access.trial) return 'premium';
  return null;
}

// Published, program-visible resources for a course — the core query used by
// the student course home. The visibility clause is enforced in SQL.
function publishedCourseResources(user, courseId) {
  const { clause, params } = resourceVisibilityClause(user, 'r', 'pcProgram');
  const sql = `
    SELECT r.* FROM resources r
    WHERE r.publish_status = 'published' AND r.course_id = @courseId
    ${clause ? `AND ${clause}` : ''}
    ORDER BY r.created_at ASC
  `;
  return db.prepare(sql).all({ courseId, ...params });
}

// ---- Public: program directory ------------------------------------------
// Shown on the signup page and (for anonymous visitors) on the courses page.
router.get('/', attachUser, (req, res) => {
  const rows = db.prepare('SELECT * FROM programs ORDER BY rowid ASC').all();
  const includeCounts = req.query.counts === '1';
  const includeStudentCounts = includeCounts && isAdmin(req.user);
  const programs = rows.map((p) => {
    const extra = {};
    if (includeCounts) {
      // Course counts support the public program directory. Enrollment counts
      // are operational data and remain visible only to the Main Admin.
      extra.courseCount = db.prepare(
        'SELECT COUNT(*) c FROM program_courses WHERE program_code = ?'
      ).get(p.code).c;
      if (includeStudentCounts) {
        extra.studentCount = db.prepare(
          "SELECT COUNT(*) c FROM users WHERE role = 'student' AND program_code = ?"
        ).get(p.code).c;
      }
    }
    return serializeProgram(p, extra);
  });
  res.json({ programs });
});

// ---- Student: their own program + courses -------------------------------
// This is the endpoint the student dashboard uses: it returns ONLY the
// courses belonging to the logged-in student's program, with content counts.
router.get('/mine', requireAuth, requireStudentLearningAccount, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (isAdmin(user)) return res.json({ program: null, courses: [] });

  const program = user.program_code
    ? db.prepare('SELECT * FROM programs WHERE code = ?').get(user.program_code)
    : null;

  if (!program) return res.json({ program: null, courses: [] });

  const courseRows = coursesForProgram(program.code);
  const { clause, params } = resourceVisibilityClause(user, 'r', 'mineProgram');
  const courses = courseRows.map((c) => {
    const countRow = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN r.category = 'video' THEN 1 ELSE 0 END) AS videos,
        SUM(CASE WHEN r.category = 'document' THEN 1 ELSE 0 END) AS documents,
        SUM(CASE WHEN r.category = 'tutorial' THEN 1 ELSE 0 END) AS tutorials,
        SUM(CASE WHEN r.category = 'past_paper' THEN 1 ELSE 0 END) AS past_papers
      FROM resources r
      WHERE r.publish_status = 'published' AND r.course_id = @courseId
      ${clause ? `AND ${clause}` : ''}
    `).get({ courseId: c.id, ...params });

    const completed = db.prepare(`
      SELECT COUNT(*) c FROM lesson_progress lp
      JOIN resources r ON r.id = lp.resource_id
      WHERE lp.user_id = ? AND r.course_id = ?
    `).get(user.id, c.id).c;

    const totalLearned = countRow.total || 0;
    return serializeCourse(c, {
      counts: {
        lessons: LEARN_CATEGORIES.reduce((n, cat) => n + (countRow[cat] || 0), 0),
        videos: countRow.videos || 0,
        documents: countRow.documents || 0,
        tutorials: countRow.tutorials || 0,
        pastPapers: countRow.past_papers || 0
      },
      progress: {
        completed,
        total: totalLearned,
        percent: totalLearned ? Math.round((completed / totalLearned) * 100) : 0
      }
    });
  });

  res.json({ program: serializeProgram(program), courses });
});

// ---- Student: one course home -------------------------------------------
// :key accepts course id, slug (ma110) or code (MA110). Access is enforced:
// the student's program must include the course, and every resource returned
// is filtered by program visibility in SQL.
router.get('/course/:key', requireAuth, requireStudentLearningAccount, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });

  const course = resolveCourse(req.params.key);
  if (!course) return res.status(404).json({ message: 'Course not found.' });

  if (!isAdmin(user)) {
    if (!user.program_code || !programIncludesCourse(user.program_code, course.id)) {
      // Program-based access enforced server-side — a Law student requesting
      // an E.D/Mines course id gets a hard 403, not just hidden UI.
      return res.status(403).json({ message: 'This course is not part of your program.' });
    }
  }

  const program = user.program_code
    ? db.prepare('SELECT * FROM programs WHERE code = ?').get(user.program_code)
    : null;

  const access = accessFor(user);
  const rows = publishedCourseResources(user, course.id);

  const completedById = new Map(
    db.prepare('SELECT resource_id, completed_at FROM lesson_progress WHERE user_id = ?')
      .all(user.id).map((r) => [r.resource_id, r.completed_at])
  );
  const videoPositions = new Map(
    db.prepare('SELECT resource_id, position, duration FROM video_progress WHERE user_id = ?')
      .all(user.id).map((r) => [r.resource_id, r])
  );

  const serialize = (row) => {
    const item = {
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      topic: row.topic || null,
      term: row.semester || null,
      yearLevel: row.year_level || null,
      tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      fileName: row.file_name,
      isPremium: Boolean(row.is_premium),
      createdAt: row.created_at,
      completed: completedById.has(row.id),
      completedAt: completedById.get(row.id) || null
    };
    const reason = canAccess(row, access) ? null : lockReason(row, access);
    if (reason) item.locked = reason;
    if (row.category === 'video' && videoPositions.has(row.id)) {
      item.videoPosition = videoPositions.get(row.id).position;
      item.videoDuration = videoPositions.get(row.id).duration;
    }
    return item;
  };

  const learn = rows.filter((r) => LEARN_CATEGORIES.includes(r.category));
  const announcements = rows
    .filter((r) => r.category === 'announcement')
    .sort((a, b) => {
      if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
      return a.created_at < b.created_at ? 1 : -1;
    })
    .map(serialize);

  // Topics group the learning set, just like the legacy course home.
  const topicMap = new Map();
  for (const row of learn) {
    const name = (row.topic || 'General').trim() || 'General';
    if (!topicMap.has(name)) topicMap.set(name, []);
    topicMap.get(name).push(row);
  }
  const topics = [...topicMap.entries()].map(([name, items]) => {
    const ordered = [...items].sort(
      (a, b) => (CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]) ||
                (a.created_at < b.created_at ? -1 : 1)
    );
    const doneCount = ordered.filter((r) => completedById.has(r.id)).length;
    return {
      name,
      lessons: ordered.map(serialize),
      total: ordered.length,
      completed: doneCount,
      percent: ordered.length ? Math.round((doneCount / ordered.length) * 100) : 0
    };
  });
  topics.sort((a, b) => a.name.localeCompare(b.name));

  const flatLessons = topics.flatMap((t) => t.lessons.map((l) => ({ ...l, topic: t.name })));
  const lectures = flatLessons.filter((l) => l.category === 'video');
  const videoTerms = ['Term 1', 'Term 2', 'Term 3'].map((term) => ({
    term,
    lessons: lectures.filter((l) => l.term === term)
  }));

  const completedCount = learn.filter((r) => completedById.has(r.id)).length;
  const totalCount = learn.length;

  // Continue learning: most recently touched lesson, else first incomplete.
  let continueItem = null;
  if (flatLessons.length) {
    const vpStamps = new Map(
      db.prepare('SELECT resource_id, updated_at FROM video_progress WHERE user_id = ?')
        .all(user.id).map((r) => [r.resource_id, r.updated_at])
    );
    const touched = flatLessons
      .map((l) => {
        const stamps = [vpStamps.get(l.id), completedById.get(l.id)].filter(Boolean);
        return stamps.length ? { l, stamp: stamps.sort().pop() } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.stamp.localeCompare(a.stamp));
    continueItem = touched.length
      ? { ...touched[0].l, via: 'recent' }
      : { ...(flatLessons.find((l) => !l.completed) || flatLessons[flatLessons.length - 1]), via: 'next' };
  }

  // Study streak (whole-platform habit).
  const streak = (() => {
    const completions = db.prepare('SELECT completed_at as t FROM lesson_progress WHERE user_id = ?').all(user.id);
    const quizzes = db.prepare('SELECT created_at as t FROM quiz_attempts WHERE user_id = ?').all(user.id);
    const days = new Set(
      [...completions, ...quizzes].map((r) => new Date(r.t).toISOString().slice(0, 10))
    );
    if (days.size === 0) return 0;
    const oneDayMs = 24 * 60 * 60 * 1000;
    let cursor = new Date();
    cursor.setUTCHours(0, 0, 0, 0);
    const todayKey = cursor.toISOString().slice(0, 10);
    if (!days.has(todayKey)) cursor = new Date(cursor.getTime() - oneDayMs);
    let s = 0;
    while (days.has(cursor.toISOString().slice(0, 10))) {
      s += 1;
      cursor = new Date(cursor.getTime() - oneDayMs);
    }
    return s;
  })();

  res.json({
    course: serializeCourse(course, { subject: course.subject }),
    program: program ? serializeProgram(program) : null,
    progress: {
      percent: totalCount ? Math.round((completedCount / totalCount) * 100) : 0,
      completedCount,
      totalCount,
      courseComplete: totalCount > 0 && completedCount === totalCount,
      topics: topics.map((t) => ({ name: t.name, total: t.total, completed: t.completed, percent: t.percent }))
    },
    streak,
    continueLearning: continueItem,
    topics,
    lessons: flatLessons,
    lectures,
    videoTerms,
    notes: flatLessons.filter((l) => l.category === 'document'),
    tutorials: flatLessons.filter((l) => l.category === 'tutorial'),
    pastPapers: flatLessons.filter((l) => l.category === 'past_paper'),
    announcements,
    access: { premium: access.premium, trial: access.trial }
  });
});

// ---- Student: lesson flow within a program course ------------------------
// Previous/next lesson and the enclosing course, for the lesson experience
// page. The lesson must belong to a course the student's program includes —
// the program course home data is re-derived here and filtered identically.
router.get('/lesson/:id', requireAuth, requireStudentLearningAccount, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });

  const row = db.prepare(`SELECT * FROM resources WHERE id = ? AND publish_status = 'published'`).get(req.params.id);
  if (!row || !row.course_id) return res.status(404).json({ message: 'Lesson not found.' });

  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(row.course_id);
  if (!course) return res.status(404).json({ message: 'Course not found.' });

  if (!isAdmin(user)) {
    if (!user.program_code || !programIncludesCourse(user.program_code, course.id)) {
      return res.status(403).json({ message: 'This lesson is not part of your program.' });
    }
  }

  const access = accessFor(user);
  const rows = publishedCourseResources(user, course.id)
    .filter((r) => LEARN_CATEGORIES.includes(r.category));

  const completedById = new Set(
    db.prepare('SELECT resource_id FROM lesson_progress WHERE user_id = ?').all(user.id).map((r) => r.resource_id)
  );

  const topicMap = new Map();
  for (const r of rows) {
    const name = (r.topic || 'General').trim() || 'General';
    if (!topicMap.has(name)) topicMap.set(name, []);
    topicMap.get(name).push(r);
  }
  const flat = [...topicMap.entries()].flatMap(([name, items]) =>
    [...items]
      .sort((a, b) => (CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]) || (a.created_at < b.created_at ? -1 : 1))
      .map((l) => {
        const item = {
          id: l.id, title: l.title, description: l.description, category: l.category,
          topic: name, term: l.semester || null, subject: course.name, courseCode: course.code,
          fileName: l.file_name, yearLevel: l.year_level, createdAt: l.created_at,
          completed: completedById.has(l.id)
        };
        const reason = canAccess(l, access) ? null : lockReason(l, access);
        if (reason) item.locked = reason;
        return item;
      })
  );

  const idx = flat.findIndex((l) => l.id === row.id);
  if (idx === -1) return res.status(403).json({ message: 'This lesson is not available for your program.' });

  const current = flat[idx];
  res.json({
    course: serializeCourse(course),
    lesson: current,
    previous: idx > 0 ? flat[idx - 1] : null,
    next: idx < flat.length - 1 ? flat[idx + 1] : null,
    index: idx,
    total: flat.length
  });
});

// ===========================================================================
// ADMIN — program & course management
// ===========================================================================
router.use('/admin', requireAuth, requireRole(ROLES.ADMIN));

// All programs with their courses (for the admin dashboard).
router.get('/admin', (req, res) => {
  const programs = db.prepare('SELECT * FROM programs ORDER BY rowid ASC').all().map((p) => {
    const courses = db.prepare(`
      SELECT c.*, pc.sort_order
      FROM program_courses pc
      JOIN courses c ON c.id = pc.course_id
      WHERE pc.program_code = ?
      ORDER BY pc.sort_order ASC, c.code ASC
    `).all(p.code).map((c) => {
      const resourceCount = db.prepare(
        "SELECT COUNT(*) c FROM resources WHERE course_id = ? AND publish_status = 'published'"
      ).get(c.id).c;
      return serializeCourse(c, { resourceCount });
    });
    const studentCount = db.prepare(
      "SELECT COUNT(*) c FROM users WHERE role = 'student' AND program_code = ?"
    ).get(p.code).c;
    return serializeProgram(p, { courses, studentCount });
  });
  res.json({ programs });
});

// Create a program.
router.post('/admin', (req, res) => {
  const { name, shortName, groupName, icon, description } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ message: 'Program name is required.' });
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code || !/^[A-Z0-9]{2,12}$/.test(code)) {
    return res.status(400).json({ message: 'A short program code (2–12 letters/numbers, e.g. MED) is required.' });
  }
  const existing = db.prepare('SELECT code FROM programs WHERE code = ?').get(code);
  if (existing) return res.status(409).json({ message: `A program with code ${code} already exists.` });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO programs (code, name, short_name, group_name, icon, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(code, String(name).trim(), shortName || String(name).trim(), groupName || null, icon || 'book-open', description || null, now);
  const row = db.prepare('SELECT * FROM programs WHERE code = ?').get(code);
  res.status(201).json({ program: serializeProgram(row) });
});

// Update a program.
router.put('/admin/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const program = db.prepare('SELECT * FROM programs WHERE code = ?').get(code);
  if (!program) return res.status(404).json({ message: 'Program not found.' });
  const { name, shortName, groupName, icon, description } = req.body || {};
  db.prepare(`
    UPDATE programs SET name = ?, short_name = ?, group_name = ?, icon = ?, description = ? WHERE code = ?
  `).run(
    name ? String(name).trim() : program.name,
    shortName !== undefined ? (shortName || null) : program.short_name,
    groupName !== undefined ? (groupName || null) : program.group_name,
    icon || program.icon,
    description !== undefined ? (description || null) : program.description,
    code
  );
  const row = db.prepare('SELECT * FROM programs WHERE code = ?').get(code);
  res.json({ program: serializeProgram(row) });
});

// Delete a program. Students in it keep their rows but become unassigned
// (program_code is set NULL by the FK) and can re-pick; course links are
// removed, courses themselves remain (they may belong to other programs).
router.delete('/admin/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const program = db.prepare('SELECT code FROM programs WHERE code = ?').get(code);
  if (!program) return res.status(404).json({ message: 'Program not found.' });
  db.prepare("UPDATE users SET program_code = NULL WHERE program_code = ?").run(code);
  db.prepare('DELETE FROM resource_programs WHERE program_code = ?').run(code);
  db.prepare('DELETE FROM program_courses WHERE program_code = ?').run(code);
  db.prepare('DELETE FROM programs WHERE code = ?').run(code);
  res.json({ message: 'Program deleted.' });
});

// Create a course (globally) and optionally attach it to a program.
router.post('/admin/courses', (req, res) => {
  const { code, name, icon, subject, programCode } = req.body || {};
  if (!code || !String(code).trim()) return res.status(400).json({ message: 'Course code is required (e.g. LS170).' });
  if (!name || !String(name).trim()) return res.status(400).json({ message: 'Course name/title is required.' });
  const normCode = String(code).trim().toUpperCase();
  const slug = courseCodeToSlug(normCode);
  const existing = db.prepare('SELECT id FROM courses WHERE code = ? OR slug = ?').get(normCode, slug);
  if (existing) return res.status(409).json({ message: `Course ${normCode} already exists. Attach it to the program instead of recreating it.` });

  const id = `course-${uuidv4()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO courses (id, code, slug, name, icon, subject, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, normCode, slug, String(name).trim(), icon || 'book-open', subject || null, now);

  let attachedTo = null;
  if (programCode) {
    const pc = String(programCode).trim().toUpperCase();
    if (db.prepare('SELECT code FROM programs WHERE code = ?').get(pc)) {
      const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM program_courses WHERE program_code = ?').get(pc).m;
      db.prepare('INSERT OR IGNORE INTO program_courses (program_code, course_id, sort_order) VALUES (?, ?, ?)')
        .run(pc, id, maxOrder + 1);
      attachedTo = pc;
    }
  }

  const row = db.prepare('SELECT * FROM courses WHERE id = ?').get(id);
  res.status(201).json({ course: serializeCourse(row), attachedTo });
});

// Update a course's details.
router.put('/admin/courses/:id', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ message: 'Course not found.' });
  const { name, icon, subject } = req.body || {};
  db.prepare('UPDATE courses SET name = ?, icon = ?, subject = ? WHERE id = ?')
    .run(name ? String(name).trim() : course.name, icon || course.icon, subject !== undefined ? (subject || null) : course.subject, course.id);
  const row = db.prepare('SELECT * FROM courses WHERE id = ?').get(course.id);
  res.json({ course: serializeCourse(row) });
});

// Attach an existing course to a program.
router.post('/admin/:code/courses', (req, res) => {
  const code = req.params.code.toUpperCase();
  const program = db.prepare('SELECT code FROM programs WHERE code = ?').get(code);
  if (!program) return res.status(404).json({ message: 'Program not found.' });
  const courseId = String((req.body && req.body.courseId) || '').trim();
  const course = resolveCourse(courseId);
  if (!course) return res.status(404).json({ message: 'Course not found.' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM program_courses WHERE program_code = ?').get(code).m;
  db.prepare('INSERT OR IGNORE INTO program_courses (program_code, course_id, sort_order) VALUES (?, ?, ?)')
    .run(code, course.id, maxOrder + 1);
  res.json({ message: `${course.code} added to ${code}.` });
});

// Remove a course from a program (does not delete the course itself or any
// uploaded content — course-bound resources just stop targeting that
// program's students).
router.delete('/admin/:code/courses/:courseId', (req, res) => {
  const code = req.params.code.toUpperCase();
  const course = resolveCourse(req.params.courseId);
  if (!course) return res.status(404).json({ message: 'Course not found.' });
  db.prepare('DELETE FROM program_courses WHERE program_code = ? AND course_id = ?').run(code, course.id);
  res.json({ message: `${course.code} removed from ${code}.` });
});

// Delete a course entirely — refused if published content still references
// it, so resources are never orphaned silently.
router.delete('/admin/courses/:id', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ message: 'Course not found.' });
  const inUse = db.prepare("SELECT COUNT(*) c FROM resources WHERE course_id = ?").get(course.id).c;
  if (inUse > 0) {
    return res.status(400).json({ message: `Cannot delete ${course.code}: ${inUse} resource(s) still belong to it. Reassign or delete that content first.` });
  }
  db.prepare('DELETE FROM program_courses WHERE course_id = ?').run(course.id);
  db.prepare('DELETE FROM courses WHERE id = ?').run(course.id);
  res.json({ message: 'Course deleted.' });
});

module.exports = router;
