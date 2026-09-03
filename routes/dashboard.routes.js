// =============================================
// STUDYCORE — Student dashboard API
// -----------------------------------------------
// One request gives the dashboard everything it
// needs: overall progress, per-course progress,
// continue-learning, recently viewed, streak,
// achievements, completed topics and upcoming
// deadlines.
//
// Previously the dashboard fetched the full course
// home once per course (N requests, each of which
// re-derived topics, streaks and completion). This
// endpoint computes the same numbers in one pass
// over the student's own program courses.
//
// Every figure comes from the database. Program
// visibility and subscription gating are enforced
// in SQL exactly as they are everywhere else.
// =============================================

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ROLES, isAdmin, isStudent } = require('../lib/roles');
const { resourceVisibilityClause, coursesForProgram } = require('../lib/program-access');
const { serializeProgram, serializeCourse } = require('../lib/programs');
const {
  LEARN_CATEGORIES,
  CATEGORY_ORDER,
  accessFor,
  canAccess,
  lockReason,
  computeStreak,
  computeAchievements,
  courseCounts,
  courseProgress,
  topicsForCourse
} = require('../lib/learning');

const router = express.Router();
const requireStudent = requireRole(ROLES.STUDENT, ROLES.ADMIN);

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/', requireAuth, requireStudent, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (isAdmin(user)) return res.json({ admin: true });

  const access = accessFor(user);
  const vis = resourceVisibilityClause(user, 'r', 'dashProgram');

  const program = user.program_code
    ? db.prepare(`
        SELECT p.*, f.name AS faculty_name, f.short_name AS faculty_short_name,
               u.name AS university_name, u.code AS university_code, u.short_name AS university_short_name
        FROM programs p
        LEFT JOIN faculties f ON f.id = p.faculty_id
        LEFT JOIN universities u ON u.id = COALESCE(p.university_id, f.university_id)
        WHERE p.code = ?
      `).get(user.program_code)
    : null;

  const completedRows = db.prepare('SELECT resource_id, completed_at FROM lesson_progress WHERE user_id = ?').all(user.id);
  const completedAt = new Map(completedRows.map((r) => [r.resource_id, r.completed_at]));
  const completedIds = [...completedAt.keys()];
  const videoRows = db.prepare('SELECT resource_id, position, duration, updated_at FROM video_progress WHERE user_id = ?').all(user.id);
  const videoByResource = new Map(videoRows.map((r) => [r.resource_id, r]));

  const courseRows = program ? coursesForProgram(program.code) : [];

  const lessonHref = (item, course) => {
    const key = course.slug || course.code;
    if (['document', 'tutorial', 'past_paper'].includes(item.category)) return `/viewer/${item.id}`;
    return `/pages/lesson.html?id=${item.id}&course=${encodeURIComponent(key)}`;
  };

  const serializeLesson = (row, course) => {
    const item = {
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      topic: row.topic || null,
      term: row.semester || null,
      examYear: row.exam_year || null,
      examType: row.exam_type || null,
      isPremium: Boolean(row.is_premium),
      createdAt: row.created_at,
      completed: completedIds.includes(row.id),
      completedAt: completedAt.get(row.id) || null,
      href: lessonHref(row, course)
    };
    const reason = canAccess(row, access) ? null : lockReason(row, access);
    if (reason) item.locked = reason;
    if (row.category === 'video' && videoByResource.has(row.id)) {
      item.videoPosition = videoByResource.get(row.id).position;
      item.videoDuration = videoByResource.get(row.id).duration;
      item.percentWatched = item.videoDuration
        ? Math.max(0, Math.min(100, Math.round((item.videoPosition / item.videoDuration) * 100)))
        : 0;
    }
    return item;
  };

  const courses = courseRows.map((courseRow) => {
    const rows = db.prepare(`
      SELECT r.* FROM resources r
      WHERE r.publish_status = 'published' AND r.course_id = @courseId
      ${vis.clause ? `AND ${vis.clause}` : ''}
      ORDER BY r.created_at ASC
    `).all({ courseId: courseRow.id, ...vis.params });

    const learn = rows.filter((r) => LEARN_CATEGORIES.includes(r.category));
    const progress = courseProgress(user.id, rows, completedIds);
    const topics = topicsForCourse(rows, completedIds);

    // Continue learning: the most recently touched lesson in this course,
    // otherwise the first one the student has not finished.
    let continueItem = null;
    const touched = learn
      .map((r) => {
        const stamps = [videoByResource.get(r.id)?.updated_at, completedAt.get(r.id)].filter(Boolean);
        return stamps.length ? { row: r, stamp: stamps.sort().pop() } : null;
      })
      .filter(Boolean)
      .sort((a, b) => String(b.stamp).localeCompare(String(a.stamp)));
    const chosen = touched[0]
      ? { row: touched[0].row, via: 'recent' }
      : (learn.find((r) => !completedAt.has(r.id)) || learn[learn.length - 1]);
    if (chosen) continueItem = { ...serializeLesson(chosen.row, courseRow), via: chosen.via };

    return {
      course: serializeCourse(courseRow, {
        yearLevel: courseRow.year_level || null,
        counts: courseCounts(rows),
        progress: { percent: progress.percent, completed: progress.completedCount, total: progress.totalCount },
        href: `/course/${encodeURIComponent(courseRow.slug)}`
      }),
      continueLearning: continueItem,
      topicsCompleted: topics.filter((t) => t.completedAll).length,
      topicsTotal: topics.length,
      nextLesson: (() => {
        const next = learn.find((r) => !completedAt.has(r.id));
        return next ? { id: next.id, title: next.title, category: next.category, topic: next.topic || null, href: lessonHref(next, courseRow) } : null;
      })()
    };
  });

  // Overall academic progress across the student's whole program.
  const totalLessons = courses.reduce((n, c) => n + c.course.counts.lessons, 0);
  const totalCompleted = courses.reduce((n, c) => n + c.course.progress.completed, 0);
  const topicsTotal = courses.reduce((n, c) => n + c.topicsTotal, 0);
  const topicsCompleted = courses.reduce((n, c) => n + c.topicsCompleted, 0);

  // Continue learning across courses: prefer something recently touched.
  const recentContinue = courses.find((c) => c.continueLearning && c.continueLearning.via === 'recent');
  const mostAdvanced = courses
    .filter((c) => c.course.progress.total > 0)
    .sort((a, b) => b.course.progress.percent - a.course.progress.percent)[0];
  const continueLearning = recentContinue
    ? { course: recentContinue.course, ...recentContinue.continueLearning }
    : (mostAdvanced && mostAdvanced.continueLearning ? { course: mostAdvanced.course, ...mostAdvanced.continueLearning } : null);

  // Recently viewed (documents, videos, past papers) with resume position.
  const recentRows = db.prepare(`
    SELECT rv.viewed_at, resources.*, c.code AS course_code, c.slug AS course_slug
    FROM resource_views rv
    JOIN resources ON resources.id = rv.resource_id
    LEFT JOIN courses c ON c.id = resources.course_id
    WHERE rv.user_id = ? AND resources.publish_status = 'published'
    ORDER BY rv.viewed_at DESC
    LIMIT 8
  `).all(user.id);
  const recentlyViewed = recentRows.map((row) => {
    const course = { slug: row.course_slug || '', code: row.course_code || '' };
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      topic: row.topic || null,
      courseCode: row.course_code || null,
      viewedAt: row.viewed_at,
      completed: completedAt.has(row.id),
      videoPosition: videoByResource.get(row.id)?.position,
      videoDuration: videoByResource.get(row.id)?.duration,
      href: lessonHref(row, course),
      locked: canAccess(row, access) ? null : lockReason(row, access)
    };
  });

  // Completed topics, most recent first (derived from real completions).
  const completedTopics = (() => {
    const rows = db.prepare(`
      SELECT r.id, r.topic, r.course_id, c.code AS course_code, c.name AS course_name, c.slug AS course_slug
      FROM resources r
      JOIN lesson_progress lp ON lp.resource_id = r.id AND lp.user_id = ?
      LEFT JOIN courses c ON c.id = r.course_id
      WHERE r.topic IS NOT NULL AND r.topic != ''
    `).all(user.id);
    const byTopic = new Map();
    for (const r of rows) {
      const key = `${r.course_id}::${String(r.topic).trim().toLowerCase()}`;
      const entry = byTopic.get(key) || { name: r.topic, courseId: r.course_id, courseCode: r.course_code, courseName: r.course_name, courseSlug: r.course_slug, completed: 0, total: 0, lastAt: '' };
      entry.completed += 1;
      byTopic.set(key, entry);
    }
    for (const entry of byTopic.values()) {
      entry.total = db.prepare(`
        SELECT COUNT(*) c FROM resources
        WHERE course_id = ? AND publish_status = 'published' AND LOWER(TRIM(topic)) = LOWER(?)
          AND category IN ('video','document','tutorial','past_paper')
      `).get(entry.courseId, entry.name).c;
    }
    return [...byTopic.values()]
      .filter((t) => t.total > 0 && t.completed >= t.total)
      .map((t) => ({ name: t.name, courseCode: t.courseCode, courseName: t.courseName, href: t.courseSlug ? `/course/${t.courseSlug}` : null }));
  })();

  // Upcoming deadlines: any visible resource with a future due_date.
  const upcoming = db.prepare(`
    SELECT r.*, c.code AS course_code, c.slug AS course_slug
    FROM resources r
    LEFT JOIN courses c ON c.id = r.course_id
    WHERE r.publish_status = 'published' AND r.due_date IS NOT NULL AND r.due_date != ''
      AND r.category != 'announcement'
      ${vis.clause ? `AND ${vis.clause.replace(/\br\./g, 'r.')}` : ''}
    ORDER BY r.due_date ASC
    LIMIT 6
  `).all(vis.params).filter((r) => new Date(r.due_date).getTime() > Date.now() - 864e5)
    .map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      dueDate: row.due_date,
      courseCode: row.course_code || null,
      href: lessonHref(row, { slug: row.course_slug || '', code: row.course_code || '' }),
      locked: canAccess(row, access) ? null : lockReason(row, access)
    }));

  // Announcements: the three newest for the student's program.
  const announcements = db.prepare(`
    SELECT r.*, ar.read_at FROM resources r
    LEFT JOIN announcement_reads ar ON ar.announcement_id = r.id AND ar.user_id = @userId
    WHERE r.publish_status = 'published' AND r.category = 'announcement'
      ${vis.clause ? `AND ${vis.clause}` : ''}
    ORDER BY r.pinned DESC, r.created_at DESC
    LIMIT 3
  `).all({ userId: user.id, ...vis.params }).map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    createdAt: row.created_at,
    pinned: Boolean(row.pinned),
    isRead: Boolean(row.read_at)
  }));

  const streak = computeStreak(user.id);
  const achievementData = computeAchievements(user);

  res.json({
    student: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarKey: user.avatar_key || null,
      program: program ? {
        ...serializeProgram(program),
        university: program.university_name ? { name: program.university_name, shortName: program.university_short_name, code: program.university_code } : null,
        faculty: program.faculty_short_name || program.faculty_name || null
      } : null,
      subscription: user.subscription,
      subscriptionEnd: user.subscription_end,
      trialEnd: user.trial_end
    },
    progress: {
      percent: totalLessons ? Math.round((totalCompleted / totalLessons) * 100) : 0,
      completedCount: totalCompleted,
      totalCount: totalLessons,
      coursesTotal: courses.length,
      coursesCompleted: achievementData.coursesCompleted.length,
      topicsCompleted,
      topicsTotal,
      lessonsCompleted: achievementData.totalLessons,
      videosCompleted: achievementData.videosCompleted,
      pastPapersCompleted: achievementData.pastPapersCompleted
    },
    streak,
    achievements: achievementData.achievements,
    achievementsEarned: achievementData.earnedCount,
    courses: courses.map((c) => ({
      course: c.course,
      continueLearning: c.continueLearning,
      nextLesson: c.nextLesson,
      topicsCompleted: c.topicsCompleted,
      topicsTotal: c.topicsTotal
    })),
    continueLearning,
    recentlyViewed,
    completedTopics: completedTopics.slice(0, 8),
    upcoming,
    announcements,
    access: { premium: access.premium, trial: access.trial }
  });
});

module.exports = router;
