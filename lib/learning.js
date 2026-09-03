// =============================================
// STUDYCORE — Shared learning logic
// -----------------------------------------------
// One implementation of the access model,
// study streaks, achievements and course
// progress, used by every route that reports
// on a student's learning. Previously these
// were duplicated between routes/courses and
// routes/programs and had drifted apart; this
// module is the single source of truth.
//
// Everything here reads real records from the
// database. Nothing is inferred from the
// client and nothing is faked.
// =============================================

const db = require('../db');
const { isAdmin, isStudent } = require('./roles');

const LEARN_CATEGORIES = Object.freeze(['video', 'document', 'tutorial', 'past_paper']);
const CATEGORY_ORDER = Object.freeze({ video: 0, document: 1, tutorial: 2, past_paper: 3 });

/* ── Access model ─────────────────────────── */
// premium = ADMIN, or a STUDENT whose subscription is 'premium' and has not
// expired. trial = a STUDENT who is not premium but whose trial_end is still
// in the future. Both are recomputed from the users table on every request.
function accessFor(user) {
  const now = Date.now();
  const subEnd = new Date(user.subscription_end || 0).getTime();
  const trialEnd = new Date(user.trial_end || 0).getTime();
  const premium = isAdmin(user) || (isStudent(user) && user.subscription === 'premium' && now < subEnd);
  const trial = !premium && isStudent(user) && now < trialEnd;
  return { premium, trial };
}

// Video lessons are Premium-only. Notes, tutorials and past papers are open to
// an active trial as well. Anything an admin marked as a free preview
// (is_premium = 0) and every announcement is open to all.
function canAccess(row, access) {
  if (!row) return false;
  if (row.category === 'announcement') return true;
  if (!row.is_premium) return true;
  if (row.category === 'video') return Boolean(access.premium);
  return Boolean(access.premium || access.trial);
}

// Why a resource is locked: 'video' (needs Premium) or 'premium' (trial ended).
// Returns null when the row is accessible.
function lockReason(row, access) {
  if (!row) return null;
  if (canAccess(row, access)) return null;
  if (row.category === 'video') return 'video';
  if (!access.premium && !access.trial) return 'premium';
  return null;
}

/* ── Study streak ─────────────────────────── */
// Consecutive calendar days (UTC) with at least one lesson completion or quiz
// attempt, counting back from today. A student who studied yesterday but not
// yet today keeps their streak — it is only broken by a fully missed day.
function computeStreak(userId) {
  const completions = db.prepare('SELECT completed_at AS t FROM lesson_progress WHERE user_id = ?').all(userId);
  const quizzes = db.prepare('SELECT created_at AS t FROM quiz_attempts WHERE user_id = ?').all(userId);
  const days = new Set([...completions, ...quizzes].map((r) => String(r.t || '').slice(0, 10)));
  if (days.size === 0) return { streak: 0, best: 0, totalDays: 0, studiedToday: false };

  const oneDayMs = 24 * 60 * 60 * 1000;
  let cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
  const todayKey = cursor.toISOString().slice(0, 10);
  const studiedToday = days.has(todayKey);
  if (!studiedToday) cursor = new Date(cursor.getTime() - oneDayMs);

  let streak = 0;
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - oneDayMs);
  }

  // Longest run ever achieved, for the "best streak" stat.
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let previous = null;
  for (const day of sorted) {
    const isNextDay = previous && (new Date(day) - new Date(previous)) === oneDayMs;
    run = isNextDay ? run + 1 : 1;
    if (run > best) best = run;
    previous = day;
  }

  return { streak, best: Math.max(best, streak), totalDays: days.size, studiedToday };
}

// Numeric streak only — used where the older call sites expect a plain number.
function streakDays(userId) {
  return computeStreak(userId).streak;
}

/* ── Course progress ──────────────────────── */
// Everything a student can "complete" inside one course: the published,
// program-visible learning resources. Announcements, quizzes and assignments
// are deliberately excluded so course completion means "I studied the course".
function courseProgress(userId, courseResourceRows, completedIds) {
  const learn = courseResourceRows.filter((r) => LEARN_CATEGORIES.includes(r.category));
  const done = new Set(completedIds);
  const completedCount = learn.filter((r) => done.has(r.id)).length;
  const totalCount = learn.length;
  return {
    percent: totalCount ? Math.round((completedCount / totalCount) * 100) : 0,
    completedCount,
    totalCount,
    courseComplete: totalCount > 0 && completedCount === totalCount
  };
}

// Topic list with per-topic progress, derived from resources.topic. A resource
// without a topic is grouped under "General" so it is never hidden.
function topicsForCourse(courseResourceRows, completedIds) {
  const learn = courseResourceRows.filter((r) => LEARN_CATEGORIES.includes(r.category));
  const done = new Set(completedIds);
  const map = new Map();
  for (const row of learn) {
    const name = String(row.topic || 'General').trim() || 'General';
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(row);
  }
  const topics = [...map.entries()].map(([name, items]) => {
    const ordered = [...items].sort(
      (a, b) => (CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]) ||
                (String(a.created_at) < String(b.created_at) ? -1 : 1)
    );
    const completed = ordered.filter((r) => done.has(r.id)).length;
    return {
      name,
      total: ordered.length,
      completed,
      percent: ordered.length ? Math.round((completed / ordered.length) * 100) : 0,
      completedAll: ordered.length > 0 && completed === ordered.length,
      rows: ordered
    };
  });
  topics.sort((a, b) => a.name.localeCompare(b.name));
  return topics;
}

// Counts shown on a course card: topics, notes, videos, past papers, total.
function courseCounts(courseResourceRows) {
  const learn = courseResourceRows.filter((r) => LEARN_CATEGORIES.includes(r.category));
  const by = (cat) => learn.filter((r) => r.category === cat).length;
  const topicNames = new Set(learn.map((r) => String(r.topic || '').trim()).filter(Boolean));
  return {
    lessons: learn.length,
    topics: topicNames.size,
    videos: by('video'),
    documents: by('document'),
    tutorials: by('tutorial'),
    notes: by('document') + by('tutorial'),
    pastPapers: by('past_paper')
  };
}

/* ── Achievements ─────────────────────────── */
// Computed from real records only. Each one carries its current value and its
// target so the UI can render an honest "12 / 100" rather than a bare badge.
function computeAchievements(user) {
  const totalLessons = db.prepare('SELECT COUNT(*) c FROM lesson_progress WHERE user_id = ?').get(user.id).c;
  const { streak, best } = computeStreak(user.id);

  // Courses completed = program courses where every learning resource is done.
  const courseRows = db.prepare(`
    SELECT c.id, c.code, c.name
    FROM program_courses pc
    JOIN courses c ON c.id = pc.course_id
    WHERE pc.program_code = @programCode
  `).all({ programCode: user.program_code || '__none__' });

  const completedRows = db.prepare(`
    SELECT lp.resource_id, r.course_id FROM lesson_progress lp
    JOIN resources r ON r.id = lp.resource_id
    WHERE lp.user_id = ?
  `).all(user.id);
  const doneByCourse = new Map();
  for (const r of completedRows) {
    const key = r.course_id || 'none';
    doneByCourse.set(key, (doneByCourse.get(key) || 0) + 1);
  }
  const totalByCourse = new Map();
  for (const c of courseRows) {
    const n = db.prepare(`
      SELECT COUNT(*) c FROM resources
      WHERE course_id = ? AND publish_status = 'published'
        AND category IN ('video','document','tutorial','past_paper')
    `).get(c.id).c;
    totalByCourse.set(c.id, n);
  }
  const completedCourses = courseRows.filter((c) => {
    const total = totalByCourse.get(c.id) || 0;
    return total > 0 && (doneByCourse.get(c.id) || 0) >= total;
  });

  const papersDone = db.prepare(`
    SELECT COUNT(*) c FROM lesson_progress lp
    JOIN resources r ON r.id = lp.resource_id
    WHERE lp.user_id = ? AND r.category = 'past_paper'
  `).get(user.id).c;
  const videosDone = db.prepare(`
    SELECT COUNT(*) c FROM lesson_progress lp
    JOIN resources r ON r.id = lp.resource_id
    WHERE lp.user_id = ? AND r.category = 'video'
  `).get(user.id).c;
  const topicsDone = (() => {
    // A topic counts as complete when every learning resource tagged with it
    // (inside the student's own program courses) has been completed.
    const rows = db.prepare(`
      SELECT r.id, r.topic, r.course_id FROM resources r
      JOIN program_courses pc ON pc.course_id = r.course_id
      WHERE pc.program_code = @programCode AND r.publish_status = 'published'
        AND r.category IN ('video','document','tutorial','past_paper')
        AND r.topic IS NOT NULL AND r.topic != ''
    `).all({ programCode: user.program_code || '__none__' });
    const map = new Map();
    const doneSet = new Set(completedRows.map((r) => r.resource_id));
    for (const r of rows) {
      const key = `${r.course_id}::${String(r.topic).trim().toLowerCase()}`;
      const entry = map.get(key) || { total: 0, done: 0 };
      entry.total += 1;
      if (doneSet.has(r.id)) entry.done += 1;
      map.set(key, entry);
    }
    return [...map.values()].filter((t) => t.total > 0 && t.done === t.total).length;
  })();

  const defs = [
    { id: 'first-lesson', name: 'First Lesson', icon: 'graduation-cap', detail: 'Complete your first lesson', earned: totalLessons >= 1, value: totalLessons, target: 1 },
    { id: 'ten-lessons', name: '10 Lessons', icon: 'check-circle', detail: 'Complete 10 lessons', earned: totalLessons >= 10, value: totalLessons, target: 10 },
    { id: 'fifty-lessons', name: '50 Lessons', icon: 'book-open', detail: 'Complete 50 lessons', earned: totalLessons >= 50, value: totalLessons, target: 50 },
    { id: 'hundred-lessons', name: '100 Lessons Completed', icon: 'list-checks', detail: 'Complete 100 lessons', earned: totalLessons >= 100, value: totalLessons, target: 100 },
    { id: 'first-course', name: 'First Course Completed', icon: 'award', detail: 'Finish every lesson in one course', earned: completedCourses.length >= 1, value: completedCourses.length, target: 1 },
    { id: 'course-champion', name: 'Course Champion', icon: 'trophy', detail: 'Complete every course in your program', earned: courseRows.length > 0 && completedCourses.length >= courseRows.length, value: completedCourses.length, target: Math.max(courseRows.length, 1) },
    { id: 'seven-day-streak', name: '7-Day Study Streak', icon: 'flame', detail: 'Study 7 days in a row', earned: streak >= 7, value: streak, target: 7 },
    { id: 'thirty-day-streak', name: '30-Day Study Streak', icon: 'flame', detail: 'Study 30 days in a row', earned: best >= 30, value: best, target: 30 },
    { id: 'topic-scholar', name: 'Topic Scholar', icon: 'layers', detail: 'Complete 10 topics in full', earned: topicsDone >= 10, value: topicsDone, target: 10 },
    { id: 'video-learner', name: 'Video Learner', icon: 'video', detail: 'Finish 10 video lessons', earned: videosDone >= 10, value: videosDone, target: 10 },
    { id: 'past-paper-master', name: 'Past Paper Master', icon: 'file', detail: 'Work through 20 past papers', earned: papersDone >= 20, value: papersDone, target: 20 }
  ];

  return {
    achievements: defs,
    earnedCount: defs.filter((d) => d.earned).length,
    totalLessons,
    streak,
    bestStreak: best,
    topicsCompleted: topicsDone,
    videosCompleted: videosDone,
    pastPapersCompleted: papersDone,
    coursesCompleted: completedCourses.map((c) => ({ code: c.code, name: c.name }))
  };
}

module.exports = {
  LEARN_CATEGORIES,
  CATEGORY_ORDER,
  accessFor,
  canAccess,
  lockReason,
  computeStreak,
  streakDays,
  courseProgress,
  topicsForCourse,
  courseCounts,
  computeAchievements
};
