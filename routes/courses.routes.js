const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function serializeResource(row, extra = {}) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    subject: row.subject,
    course: row.course,
    term: row.semester,
    tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    hasFile: Boolean(row.stored_name),
    fileSize: row.file_size,
    dueDate: row.due_date,
    isPremium: Boolean(row.is_premium),
    downloadCount: row.download_count,
    createdAt: row.created_at,
    ...extra
  };
}

function subscriptionStatusFor(user) {
  const now = Date.now();
  const trialEnd = new Date(user.trial_end || 0).getTime();
  const subEnd = new Date(user.subscription_end || 0).getTime();
  const active = user.role === 'ADMIN' || (user.subscription === 'premium' && now < subEnd);
  const inTrial = user.role !== 'ADMIN' && !active && now < trialEnd;
  return active || inTrial;
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

router.get('/:subject', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  const subscriptionOk = subscriptionStatusFor(user);
  const subject = req.params.subject;

  const rows = db.prepare(`
    SELECT * FROM resources WHERE LOWER(subject) = LOWER(?) AND publish_status = 'published'
    ORDER BY created_at ASC
  `).all(subject);

  const completedIds = new Set(
    db.prepare('SELECT resource_id FROM lesson_progress WHERE user_id = ?').all(user.id).map((r) => r.resource_id)
  );

  const withState = (row) => serializeResource(row, {
    completed: completedIds.has(row.id),
    locked: !subscriptionOk && row.category !== 'announcement' && Boolean(row.is_premium)
  });

  const byCategory = (cat) => rows.filter((r) => r.category === cat).map(withState);

  const lectures = byCategory('video');

  // Group lectures by term (Term 1/2/3) so a student looking for this
  // term's videos doesn't have to scroll past every other term - anything
  // without a term set falls into its own "General" bucket rather than
  // being hidden or mixed in confusingly.
  const TERM_ORDER = ['Term 1', 'Term 2', 'Term 3', 'General'];
  const lecturesByTerm = {};
  for (const lecture of lectures) {
    const term = TERM_ORDER.includes(lecture.term) ? lecture.term : 'General';
    if (!lecturesByTerm[term]) lecturesByTerm[term] = [];
    lecturesByTerm[term].push(lecture);
  }
  const lecturesByTermOrdered = TERM_ORDER
    .filter((term) => lecturesByTerm[term] && lecturesByTerm[term].length)
    .map((term) => ({ term, lectures: lecturesByTerm[term] }));
  const notes = byCategory('document');
  const tutorials = byCategory('tutorial');
  const pastPapers = byCategory('past_paper');
  const quizzes = byCategory('quiz').map((q) => {
    const attempts = db.prepare('SELECT score, total FROM quiz_attempts WHERE user_id = ? AND resource_id = ?').all(user.id, q.id);
    const bestPercent = attempts.length
      ? Math.round(Math.max(...attempts.map((a) => (a.total ? a.score / a.total : 0))) * 100)
      : null;
    return { ...q, bestPercent };
  });
  const assignments = byCategory('assignment');
  const announcements = byCategory('announcement');

  // Progress: across every "completable" item in this subject (everything
  // except announcements, which aren't lessons to complete).
  const completable = rows.filter((r) => r.category !== 'announcement');
  const completedCount = completable.filter((r) => completedIds.has(r.id)).length;
  const percent = completable.length ? Math.round((completedCount / completable.length) * 100) : 0;

  // Continue learning: first not-yet-completed lecture in upload order: if
  // every lecture is done, fall back to the first not-yet-completed item of
  // any completable type.
  const nextLecture = lectures.find((l) => !l.completed);
  const nextAny = completable.map(withState).find((r) => !r.completed && r.category !== 'quiz');
  const continueItem = nextLecture || nextAny || null;

  // Recommended next steps: simple, rule-based (no AI) - suggest the next
  // lecture, and separately surface any quiz sharing the same `course` tag
  // as a just-completed lecture that hasn't been attempted yet.
  const recommended = [];
  if (continueItem) recommended.push({ reason: 'Continue where you left off', ...continueItem });
  const attemptedQuizIds = new Set(
    db.prepare('SELECT DISTINCT resource_id FROM quiz_attempts WHERE user_id = ?').all(user.id).map((r) => r.resource_id)
  );
  const completedCourses = new Set(rows.filter((r) => completedIds.has(r.id) && r.course).map((r) => r.course));
  const suggestedQuiz = quizzes.find((q) => !attemptedQuizIds.has(q.id) && completedCourses.has(q.course));
  if (suggestedQuiz) recommended.push({ reason: 'Test what you just learned', ...suggestedQuiz });

  res.json({
    subject,
    progress: { percent, completedCount, totalCount: completable.length },
    streak: computeStreak(user.id),
    continueLearning: continueItem,
    recommended,
    lectures,
    lecturesByTerm: lecturesByTermOrdered,
    notes,
    tutorials,
    pastPapers,
    quizzes,
    assignments,
    announcements,
    subscriptionOk
  });
});

module.exports = router;
