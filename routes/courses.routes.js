const express = require('express');
const db = require('../db');
const { requireAuth, attachUser } = require('../middleware/auth');

const router = express.Router();

// Course homes must always reflect the latest published admin uploads rather
// than a browser or proxy serving an older API response.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// The six StudyCore courses. Kept in one place so the public API, the course
// pages and the sitemap always agree on slugs/names.
const COURSES = [
  { slug: 'mathematics', subject: 'Mathematics' },
  { slug: 'physics', subject: 'Physics' },
  { slug: 'chemistry', subject: 'Chemistry' },
  { slug: 'biology', subject: 'Biology' },
  { slug: 'programming', subject: 'Programming' },
  { slug: 'communication', subject: 'Communication Skills' }
];
const SUBJECT_TO_COURSE = Object.fromEntries(COURSES.map((c) => [c.subject.toLowerCase(), c.subject]));
const COURSE_TO_SUBJECT = Object.fromEntries(COURSES.map((c) => [c.slug, c.subject]));

function serializeResource(row, extra = {}) {
  let mime = row.mime_type;
  const fName = String(row.file_name || '').trim();
  // If mime is octet-stream and file name is a bare UUID (the bug case),
  // treat it as PDF — the actual Content-Type header will be sniffed as PDF
  // at stream time, and the client-side reader now also handles bare UUIDs.
  if ((mime === 'application/octet-stream' || mime === 'binary/octet-stream' || !mime) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fName)) {
    mime = 'application/pdf';
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    subject: row.subject,
    course: row.course,
    topic: row.topic || null,
    yearLevel: row.year_level,
    semester: row.semester,
    term: row.semester,
    tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    hasFile: Boolean(row.stored_name),
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: mime,
    dueDate: row.due_date,
    isPremium: Boolean(row.is_premium),
    downloadCount: row.download_count,
    createdAt: row.created_at,
    ...extra
  };
}

function accessFor(user) {
  const now = Date.now();
  const subEnd = new Date(user.subscription_end || 0).getTime();
  const trialEnd = new Date(user.trial_end || 0).getTime();
  const premium = user.role === 'ADMIN' || (user.subscription === 'premium' && now < subEnd);
  const trial = !premium && user.role === 'STUDENT' && now < trialEnd;
  return { premium, trial };
}

function canAccess(row, access) {
  if (row.category === 'announcement') return true;
  if (!row.is_premium) return true;
  if (row.category === 'video') return access.premium; // videos are Premium-only, always
  return access.premium || access.trial;
}

function lockReason(row, access) {
  if (row.category === 'video' && !access.premium) return 'video';
  if (!access.premium && !access.trial) return 'premium';
  return null;
}

// Study streak: count consecutive calendar days (ending today or yesterday
// - "yesterday" so a student who studied yesterday but hasn't yet today
// doesn't get unfairly shown a broken streak first thing in the morning)
// with at least one lesson completion or quiz attempt, across ALL subjects
// (a streak is a whole-platform habit, not per-course).
function computeStreak(userId) {
  const completions = db.prepare('SELECT completed_at as t FROM lesson_progress WHERE user_id = ?').all(userId);
  const quizzes = db.prepare('SELECT created_at as t FROM quiz_attempts WHERE user_id = ?').all(userId);
  const days = new Set(
    [...completions, ...quizzes].map((r) => new Date(r.t).toISOString().slice(0, 10))
  );
  if (days.size === 0) return 0;

  const oneDayMs = 24 * 60 * 60 * 1000;
  let cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
  const todayKey = cursor.toISOString().slice(0, 10);
  if (!days.has(todayKey)) {
    cursor = new Date(cursor.getTime() - oneDayMs); // allow starting from yesterday
  }

  let streak = 0;
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - oneDayMs);
  }
  return streak;
}

// Academic achievements, computed from real records - never faked client-side.
// Each achievement is either earned or not, with the number that got the
// student there, so the dashboard can render an honest "2/10" state.
function computeAchievements(user) {
  const totalLessons = db.prepare('SELECT COUNT(*) c FROM lesson_progress WHERE user_id = ?').get(user.id).c;
  const streak = computeStreak(user.id);
  const subjectsCompleted = new Set();
  for (const course of COURSES) {
    const rows = db.prepare(`SELECT * FROM resources WHERE LOWER(subject) = LOWER(?) AND category != 'announcement'`).all(course.subject);
    if (!rows.length) continue;
    const done = rows.filter((r) => db.prepare('SELECT 1 x FROM lesson_progress WHERE user_id = ? AND resource_id = ?').get(user.id, r.id));
    if (done.length === rows.length) subjectsCompleted.add(course.subject);
  }
  const physicsLessons = db.prepare(`
    SELECT COUNT(*) c FROM lesson_progress lp
    JOIN resources r ON r.id = lp.resource_id
    WHERE lp.user_id = ? AND LOWER(r.subject) = 'physics'
  `).get(user.id).c;

  const defs = [
    { id: 'first-lesson', name: 'First Lesson', icon: 'graduation-cap', detail: 'Complete your first lesson', earned: totalLessons >= 1, value: totalLessons, target: 1 },
    { id: 'ten-lessons', name: '10 Lessons Completed', icon: 'check-circle', detail: 'Complete 10 lessons', earned: totalLessons >= 10, value: totalLessons, target: 10 },
    { id: 'fifty-lessons', name: '50 Lessons Completed', icon: 'book-open', detail: 'Complete 50 lessons', earned: totalLessons >= 50, value: totalLessons, target: 50 },
    { id: 'seven-day-streak', name: '7-Day Study Streak', icon: 'flame', detail: 'Study 7 days in a row', earned: streak >= 7, value: streak, target: 7 },
    { id: 'thirty-day-streak', name: '30-Day Study Streak', icon: 'flame', detail: 'Study 30 days in a row', earned: streak >= 30, value: streak, target: 30 },
    { id: 'physics-explorer', name: 'Physics Explorer', icon: 'atom', detail: 'Complete 10 Physics lessons', earned: physicsLessons >= 10, value: physicsLessons, target: 10 },
    { id: 'course-completed', name: 'Course Completed', icon: 'award', detail: 'Complete every lesson in a course', earned: subjectsCompleted.size >= 1, value: subjectsCompleted.size, target: 1, courses: [...subjectsCompleted] }
  ];
  return { achievements: defs, totalLessons, streak, coursesCompleted: [...subjectsCompleted] };
}

// GET /api/courses - public course directory (no auth required, so the
// Courses page can show real, current content counts to every visitor).
router.get('/', (req, res) => {
  const courses = COURSES.map((course) => {
    const rows = db.prepare(`SELECT * FROM resources WHERE LOWER(subject) = LOWER(?) AND publish_status = 'published'`).all(course.subject);
    const byCategory = (cat) => rows.filter((r) => r.category === cat).length;
    const topics = [...new Set(rows.map((r) => (r.topic || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return {
      slug: course.slug,
      subject: course.subject,
      topics,
      counts: {
        lessons: rows.filter((r) => !['announcement', 'quiz', 'assignment'].includes(r.category)).length,
        videos: byCategory('video'),
        documents: byCategory('document'),
        tutorials: byCategory('tutorial'),
        pastPapers: byCategory('past_paper'),
        announcements: byCategory('announcement')
      }
    };
  });
  res.json({ courses });
});

// GET /api/courses/lesson/:id - the ordered lesson flow around one lesson:
// previous lesson, next lesson, and the topic it belongs to. Used by the
// lesson experience page to render breadcrumbs and navigation.
// Registered BEFORE the /:subject route below so "lesson" is never swallowed
// as a subject name.
router.get('/lesson/:id', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  const access = accessFor(user);

  const row = db.prepare(`SELECT * FROM resources WHERE id = ? AND publish_status = 'published'`).get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Lesson not found.' });

  const completedById = new Map(
    db.prepare('SELECT resource_id FROM lesson_progress WHERE user_id = ?').all(user.id).map((r) => [r.resource_id, 1])
  );
  const subjectRows = db.prepare(`
    SELECT * FROM resources WHERE LOWER(subject) = LOWER(?) AND publish_status = 'published'
    ORDER BY created_at ASC
  `).all(row.subject);
  const LEARN_CATEGORIES = ['video', 'document', 'tutorial', 'past_paper'];
  const CATEGORY_ORDER = { video: 0, document: 1, tutorial: 2, past_paper: 3 };
  const topicMap = new Map();
  for (const r of subjectRows.filter((x) => LEARN_CATEGORIES.includes(x.category))) {
    const name = (r.topic || 'General').trim() || 'General';
    if (!topicMap.has(name)) topicMap.set(name, []);
    topicMap.get(name).push(r);
  }
  const flat = [...topicMap.entries()].flatMap(([name, items]) =>
    [...items].sort((a, b) => (CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]) || (a.created_at < b.created_at ? -1 : 1))
      .map((l) => ({ ...serializeResource(l), topic: name, completed: completedById.has(l.id) }))
  );

  const idx = flat.findIndex((l) => l.id === row.id);
  const state = withStateFor(row);
  res.json({
    lesson: { ...state, topic: row.topic || 'General' },
    previous: idx > 0 ? flat[idx - 1] : null,
    next: idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null,
    index: idx,
    total: flat.length
  });

  function withStateFor(r) {
    const s = serializeResource(r, { completed: completedById.has(r.id) });
    const reason = canAccess(r, access) ? null : lockReason(r, access);
    if (reason) s.locked = reason;
    return s;
  }
});

// GET /api/courses/:subject - full course home for a logged-in student.
// :subject accepts either the subject name ("Physics") or the slug ("physics").
router.get('/:subject', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });

  const key = String(req.params.subject).trim().toLowerCase();
  const subject = SUBJECT_TO_COURSE[key] || COURSE_TO_SUBJECT[key] || req.params.subject;
  const access = accessFor(user);

  const rows = db.prepare(`
    SELECT * FROM resources WHERE LOWER(subject) = LOWER(?) AND publish_status = 'published'
    ORDER BY created_at ASC
  `).all(subject);

  const completed = (id) => Boolean(db.prepare('SELECT 1 x FROM lesson_progress WHERE user_id = ? AND resource_id = ?').get(user.id, id));
  const completedById = new Map();
  const completedRows = db.prepare('SELECT resource_id, completed_at FROM lesson_progress WHERE user_id = ?').all(user.id);
  for (const r of completedRows) completedById.set(r.resource_id, r.completed_at);

  const videoPositions = new Map(
    db.prepare('SELECT resource_id, position, duration FROM video_progress WHERE user_id = ?').all(user.id).map((r) => [r.resource_id, r])
  );

  const withState = (row) => {
    const state = serializeResource(row, {
      completed: completedById.has(row.id),
      completedAt: completedById.get(row.id) || null
    });
    const reason = canAccess(row, access) ? null : lockReason(row, access);
    if (reason) state.locked = reason;
    if (row.category === 'video' && videoPositions.has(row.id)) {
      state.videoPosition = videoPositions.get(row.id).position;
      state.videoDuration = videoPositions.get(row.id).duration;
    }
    return state;
  };

  // The learning set: everything a student can actually work through in this
  // course. Quizzes/assignments stay in the database for admin compatibility
  // but are intentionally not part of the student learning flow.
  const LEARN_CATEGORIES = ['video', 'document', 'tutorial', 'past_paper'];
  const learn = rows.filter((r) => LEARN_CATEGORIES.includes(r.category));
  const announcements = rows.filter((r) => r.category === 'announcement')
    .sort((a, b) => {
      // Pinned first, then newest first
      if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
      return a.created_at < b.created_at ? 1 : -1;
    });

  // Topics: group the learning set by topic label. Content without a topic
  // falls into "General" so nothing is ever hidden. Within a topic, videos
  // come first (they lead a lesson), then notes, tutorials, past papers -
  // each in upload order so an admin's sequencing is respected.
  const CATEGORY_ORDER = { video: 0, document: 1, tutorial: 2, past_paper: 3 };
  const topicMap = new Map();
  for (const row of learn) {
    const name = (row.topic || 'General').trim() || 'General';
    if (!topicMap.has(name)) topicMap.set(name, []);
    topicMap.get(name).push(row);
  }
  const topics = [...topicMap.entries()].map(([name, items]) => {
    const ordered = [...items].sort((a, b) => (CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]) || (a.created_at < b.created_at ? -1 : 1));
    const doneCount = ordered.filter((r) => completedById.has(r.id)).length;
    return {
      name,
      lessons: ordered.map(withState),
      total: ordered.length,
      completed: doneCount,
      percent: ordered.length ? Math.round((doneCount / ordered.length) * 100) : 0
    };
  });
  topics.sort((a, b) => a.name.localeCompare(b.name));

  // Flat, ordered list of every lesson in the course (topic order) - this is
  // what powers "Previous / Next Lesson" on the lesson page.
  const flatLessons = topics.flatMap((t) => t.lessons.map((l) => ({ ...l, topic: t.name })));

  const completedCount = learn.filter((r) => completedById.has(r.id)).length;
  const percent = learn.length ? Math.round((completedCount / learn.length) * 100) : 0;
  const courseComplete = learn.length > 0 && completedCount === learn.length;

  // Continue learning: prefer the most recently touched lesson (by video
  // position update or completion time), otherwise the first uncompleted
  // lesson - so a returning student lands exactly where they left off.
  let continueItem = null;
  let continueVia = null;
  if (flatLessons.length) {
    const vpStamps = new Map(
      db.prepare('SELECT resource_id, updated_at FROM video_progress WHERE user_id = ?').all(user.id)
        .map((r) => [r.resource_id, r.updated_at])
    );
    const touched = flatLessons
      .map((l) => {
        const stamps = [vpStamps.get(l.id), completedById.get(l.id)].filter(Boolean);
        return stamps.length ? { l, stamp: stamps.sort().pop() } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.stamp.localeCompare(a.stamp));

    if (touched.length) {
      continueItem = touched[0].l;
      continueVia = 'recent';
    } else {
      continueItem = flatLessons.find((l) => !l.completed) || flatLessons[flatLessons.length - 1];
      continueVia = 'next';
    }
  }

  // Recommended: next uncompleted lesson after the continue item, plus any
  // past paper in the same topic as the continue item (exam practice pairs
  // naturally with the theory a student is currently in).
  const recommended = [];
  if (continueItem) {
    const idx = flatLessons.findIndex((l) => l.id === continueItem.id);
    const next = flatLessons[idx + 1];
    if (next) recommended.push({ reason: 'Continue where you left off', ...next });
    if (continueItem.topic) {
      const paper = flatLessons.find((l) => l.category === 'past_paper' && l.topic === continueItem.topic);
      if (paper) recommended.push({ reason: 'Practice this topic', ...paper });
    }
  }

  const lectures = flatLessons.filter((l) => l.category === 'video');
  const videoTerms = ['Term 1', 'Term 2', 'Term 3'].map((term) => ({
    term,
    lessons: lectures.filter((lesson) => lesson.term === term)
  }));

  res.json({
    subject,
    slug: COURSES.find((c) => c.subject === subject)?.slug || key,
    progress: {
      percent,
      completedCount,
      totalCount: learn.length,
      topics: topics.map((t) => ({ name: t.name, total: t.total, completed: t.completed, percent: t.percent })),
      courseComplete
    },
    streak: computeStreak(user.id),
    continueLearning: continueItem ? { ...continueItem, via: continueVia } : null,
    recommended,
    topics,
    lessons: flatLessons,
    lectures,
    videoTerms,
    notes: flatLessons.filter((l) => l.category === 'document'),
    tutorials: flatLessons.filter((l) => l.category === 'tutorial'),
    pastPapers: flatLessons.filter((l) => l.category === 'past_paper'),
    announcements: announcements.map(withState),
    achievements: computeAchievements(user),
    access: { premium: access.premium, trial: access.trial }
  });
});

module.exports = router;
