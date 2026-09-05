// =============================================
// STUDYCORE — Quiz API (routes/quiz.routes.js)
// ---------------------------------------------
// Quizzes are a first-class, program-targeted learning activity. They live in
// the existing `resources` table as category = 'quiz' (so they inherit the
// exact same program/course visibility rules as every other resource) with
// their structured questions stored in `quiz_data`. Student attempts are
// recorded in `quiz_attempts` so progress and best scores survive.
//
// Three roles interact with quizzes:
//   - CONTENT_ADMIN  creates/edits/deletes only their OWN quizzes.
//   - ADMIN          creates/edits/deletes EVERY quiz (full oversight).
//   - STUDENT        sees the quizzes targeted at their program, takes them,
//                    and reviews their own graded attempts.
//
// A quiz question is one of two answer types, optionally carrying an image
// the admin/Content Admin posted alongside the question:
//   - mcq  : multiple-choice (single or multiple correct answers)
//   - text : a free-word answer (matched case-insensitively against accepted
//            answers, so "O2" and "oxygen" both score)
//
// The grading is always performed SERVER-SIDE here. The student-facing
// "take" payload deliberately omits the correct answers; only the graded
// attempt response reveals them, so scores can never be faked client-side.
// =============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const storage = require('../lib/storage');
const { ROLES, isAdmin, isStudent } = require('../lib/roles');
const { programCanSeeResource, resourceVisibilityClause, resolveCourse, validProgramCode, targetingForResource } = require('../lib/program-access');

const router = express.Router();

// Both Content Admins and the Main Admin may author quizzes.
const AUTHOR_ROLES = [ROLES.CONTENT_ADMIN, ROLES.ADMIN];

const MAX_QUESTIONS = 80;
const MAX_PROMPT_LENGTH = 2000;
const MAX_ANSWER_LENGTH = 500;
const MAX_OPTION_LENGTH = 500;
const MAX_TITLE_LENGTH = 180;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_EXPLANATION_LENGTH = 1000;

// A storage key we issued looks like <uuid>.<ext>. We only ever serve keys
// that match this shape, so a crafted path can never escape the bucket.
const KEY_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-z0-9]+$/i;

function cleanText(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  return maxLength ? text.slice(0, maxLength) : text;
}

function passingPercentFor(data) {
  const value = Number(data.passingPercent ?? 50);
  // Zero is a valid author-selected pass mark, not a missing value.
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 50;
}

function normalizeKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  // Anything that is not a key we issued is rejected (also blocks traversal).
  return KEY_RE.test(key) ? key : null;
}

function serializeOwnQuiz(row) {
  let data = { questions: [] };
  try { data = row.quiz_data ? JSON.parse(row.quiz_data) : data; } catch { /* fall through */ }
  const questions = Array.isArray(data.questions) ? data.questions : [];
  const totalPoints = questions.reduce((sum, q) => sum + (Number(q.points) || 1), 0);
  const targetAll = row.target_all === 1 || row.target_all === true;
  const programs = targetAll
    ? []
    : db.prepare('SELECT program_code FROM resource_programs WHERE resource_id = ?').all(row.id).map((r) => r.program_code);
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    category: row.category,
    questionCount: questions.length,
    totalPoints,
    passingPercent: passingPercentFor(data),
    targetAll,
    programCodes: programs,
    courseId: row.course_id || null,
    publishStatus: row.publish_status,
    isPremium: Boolean(row.is_premium),
    uploadedBy: row.uploaded_by || null,
    uploaderRole: row.uploader_role || null,
    uploaderName: row.uploader_name || null,
    uploaderEmail: row.uploader_email || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Validate + normalise the questions array. Throws with a human message.
function normalizeQuestions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Add at least one question to the quiz.');
  }
  if (raw.length > MAX_QUESTIONS) {
    throw new Error(`A quiz can have at most ${MAX_QUESTIONS} questions.`);
  }

  const seen = new Set();
  return raw.map((q, index) => {
    if (!q || typeof q !== 'object') throw new Error(`Question ${index + 1} is invalid.`);
    const type = q.type === 'text' ? 'text' : 'mcq';
    const prompt = cleanText(q.prompt, MAX_PROMPT_LENGTH);
    if (!prompt) throw new Error(`Question ${index + 1} needs a question / prompt.`);

    const id = cleanText(q.id, 60) || `q-${uuidv4()}`;
    if (seen.has(id)) throw new Error('Each question needs a unique id.');
    seen.add(id);

    const points = Number(q.points);
    const normPoints = Number.isFinite(points) && points >= 1 && points <= 100 ? Math.round(points) : 1;
    const image = normalizeKey(q.image);
    const explanation = cleanText(q.explanation, MAX_EXPLANATION_LENGTH);

    if (type === 'mcq') {
      if (!Array.isArray(q.options) || q.options.length < 2) {
        throw new Error(`Question ${index + 1} needs at least two answer options.`);
      }
      const options = q.options.map((o) => cleanText(String(o), MAX_OPTION_LENGTH));
      if (options.some((o) => !o)) throw new Error(`Question ${index + 1} has an empty answer option.`);

      const multiple = Boolean(q.multiple);
      // Correct may be a single index or an array of indices.
      let correctRaw = q.correct;
      if (!Array.isArray(correctRaw)) {
        if (typeof correctRaw === 'number') correctRaw = [correctRaw];
        else if (typeof correctRaw === 'string' && correctRaw.trim() !== '') correctRaw = [Number(correctRaw)];
        else correctRaw = [];
      }
      const correct = correctRaw
        .map((c) => Number(c))
        .filter((c) => Number.isInteger(c) && c >= 0 && c < options.length);
      const needed = multiple ? 1 : 1;
      if (correct.length < needed) {
        throw new Error(`Question ${index + 1} must mark the correct answer option(s).`);
      }

      return { id, type, prompt, image, options, multiple, correct, explanation, points: normPoints };
    }

    // text (word answer)
    if (!Array.isArray(q.answers) || q.answers.length === 0) {
      throw new Error(`Question ${index + 1} needs at least one accepted answer.`);
    }
    const answers = q.answers.map((a) => cleanText(String(a), MAX_ANSWER_LENGTH)).filter(Boolean);
    if (answers.length === 0) throw new Error(`Question ${index + 1} needs at least one accepted answer.`);
    const caseSensitive = Boolean(q.caseSensitive);
    return { id, type, prompt, image, answers, caseSensitive, explanation, points: normPoints };
  });
}

function parseTargeting(body) {
  const rawPrograms = body.programs !== undefined ? body.programs : body.targetPrograms;
  let provided = [];
  if (Array.isArray(rawPrograms)) provided = rawPrograms;
  else if (typeof rawPrograms === 'string') provided = rawPrograms.split(',').map((s) => s.trim());
  provided = provided.map((c) => String(c).trim().toUpperCase()).filter(Boolean);

  const allFlag = body.targetAll === 'true' || body.targetAll === '1' || body.targetAll === true ||
    body.target === 'all' || body.target === 'ALL' || provided.includes('ALL');
  const codes = [...new Set(provided.map((c) => validProgramCode(c)).filter(Boolean))];
  const targetAll = allFlag || codes.length === 0;
  const programCodes = targetAll ? [] : codes;
  const error = provided.length > 0 && !allFlag && codes.length === 0
    ? 'None of the selected programs exist. Check the program codes and try again.'
    : null;
  return { targetAll, programCodes, error };
}

function syncQuizPrograms(resourceId, targetAll, programCodes) {
  db.prepare('DELETE FROM resource_programs WHERE resource_id = ?').run(resourceId);
  if (!targetAll) {
    const insert = db.prepare('INSERT OR IGNORE INTO resource_programs (resource_id, program_code) VALUES (?, ?)');
    for (const code of programCodes) insert.run(resourceId, code);
  }
}

function resourceWithUploader(resourceId) {  return db.prepare(`
    SELECT r.*, u.name AS current_uploader_name, u.email AS current_uploader_email, u.role AS current_uploader_role
    FROM resources r
    LEFT JOIN users u ON u.id = r.uploaded_by
    WHERE r.id = ?
  `).get(resourceId);
}

// ── Authoring ──────────────────────────────

function parseQuizBody(req) {
  const body = req.body || {};
  const title = cleanText(body.title, MAX_TITLE_LENGTH);
  if (!title) throw new Error('Quiz title is required.');

  const description = cleanText(body.description, MAX_DESCRIPTION_LENGTH);
  const publishStatus = ['published', 'draft'].includes(body.publishStatus) ? body.publishStatus : 'published';

  let courseId = null;
  if (body.courseId) {
    const course = resolveCourse(body.courseId);
    if (!course) throw new Error('The selected course could not be found.');
    courseId = course.id;
  }

  const normPassing = passingPercentFor(body);

  const questions = normalizeQuestions(body.questions);

  const targeting = parseTargeting(body);
  if (targeting.error) throw new Error(targeting.error);

  return {
    title,
    description,
    publishStatus,
    courseId,
    passingPercent: normPassing,
    questions,
    targeting
  };
}

function buildQuizData(parsed) {
  return JSON.stringify({
    version: 1,
    passingPercent: parsed.passingPercent,
    questions: parsed.questions
  });
}

router.post('/', requireAuth, requireRole(...AUTHOR_ROLES), (req, res) => {
  let parsed;
  try {
    parsed = parseQuizBody(req);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }

  const now = new Date().toISOString();
  const uploader = db.prepare('SELECT name, email, role FROM users WHERE id = ?').get(req.user.id);
  const id = `quiz-${uuidv4()}`;

  const row = {
    id,
    title: parsed.title,
    description: parsed.description || null,
    category: 'quiz',
    resource_type: 'Quiz',
    subject: null,
    course: null,
    course_id: parsed.courseId,
    target_all: parsed.targeting.targetAll ? 1 : 0,
    topic: null,
    year_level: null,
    semester: null,
    tags: null,
    file_name: null,
    stored_name: null,
    file_size: null,
    mime_type: null,
    content_hash: null,
    external_url: null,
    quiz_data: buildQuizData(parsed),
    due_date: null,
    is_premium: 1,
    pinned: 0,
    publish_status: parsed.publishStatus,
    uploaded_by: req.user.id,
    uploader_role: uploader ? uploader.role : req.user.role,
    uploader_name: uploader ? uploader.name : null,
    uploader_email: uploader ? uploader.email : null,
    uploaded_at: now,
    created_at: now,
    updated_at: now
  };

  try {
    db.prepare(`
      INSERT INTO resources (id, title, description, category, resource_type, subject, course, course_id, target_all,
        topic, year_level, semester, tags, file_name, stored_name, file_size, mime_type, content_hash,
        external_url, quiz_data, due_date, is_premium, pinned, publish_status, uploaded_by, uploader_role,
        uploader_name, uploader_email, uploaded_at, created_at, updated_at)
      VALUES (@id, @title, @description, @category, @resource_type, @subject, @course, @course_id, @target_all,
        @topic, @year_level, @semester, @tags, @file_name, @stored_name, @file_size, @mime_type, @content_hash,
        @external_url, @quiz_data, @due_date, @is_premium, @pinned, @publish_status, @uploaded_by, @uploader_role,
        @uploader_name, @uploader_email, @uploaded_at, @created_at, @updated_at)
    `).run(row);
    syncQuizPrograms(id, parsed.targeting.targetAll, parsed.targeting.programCodes);
  } catch (err) {
    console.error('Quiz create failed:', err.message);
    return res.status(500).json({ message: 'Could not save the quiz. Please try again.' });
  }

  const saved = resourceWithUploader(id);
  return res.status(201).json({ quiz: serializeOwnQuiz(saved) });
});

// Both Content Admins (own only) and Main Admin (any) may update.
router.put('/:id', requireAuth, requireRole(...AUTHOR_ROLES), (req, res) => {
  const existing = db.prepare('SELECT * FROM resources WHERE id = ? AND category = ?').get(req.params.id, 'quiz');
  if (!existing) return res.status(404).json({ message: 'Quiz not found.' });
  // Content Admins may only edit quizzes they uploaded.
  if (req.user.role !== ROLES.ADMIN && existing.uploaded_by !== req.user.id) {
    return res.status(403).json({ message: 'You can only edit quizzes you created.' });
  }

  let parsed;
  try {
    parsed = parseQuizBody(req);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }

  const now = new Date().toISOString();
  try {
    db.prepare(`
      UPDATE resources SET title = @title, description = @description, course_id = @course_id, target_all = @target_all,
        quiz_data = @quiz_data, publish_status = @publish_status, updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: existing.id,
      title: parsed.title,
      description: parsed.description || null,
      course_id: parsed.courseId,
      target_all: parsed.targeting.targetAll ? 1 : 0,
      quiz_data: buildQuizData(parsed),
      publish_status: parsed.publishStatus,
      updated_at: now
    });
    syncQuizPrograms(existing.id, parsed.targeting.targetAll, parsed.targeting.programCodes);
  } catch (err) {
    console.error('Quiz update failed:', err.message);
    return res.status(500).json({ message: 'Could not save the quiz. Please try again.' });
  }

  const saved = resourceWithUploader(existing.id);
  return res.json({ quiz: serializeOwnQuiz(saved) });
});

router.delete('/:id', requireAuth, requireRole(...AUTHOR_ROLES), (req, res) => {
  const existing = db.prepare('SELECT id, uploaded_by, stored_name FROM resources WHERE id = ? AND category = ?').get(req.params.id, 'quiz');
  if (!existing) return res.status(404).json({ message: 'Quiz not found.' });
  if (req.user.role !== ROLES.ADMIN && existing.uploaded_by !== req.user.id) {
    return res.status(403).json({ message: 'You can only delete quizzes you created.' });
  }

  try {
    db.prepare('DELETE FROM resources WHERE id = ?').run(existing.id);
  } catch (err) {
    console.error('Quiz delete failed:', err.message);
    return res.status(500).json({ message: 'Could not delete the quiz. Please try again.' });
  }
  // Orphaned quiz images are left in storage (cheap, and harmless); a future
  // sweep could reap keys not referenced by any live quiz_data.
  return res.json({ message: 'Quiz deleted.' });
});

// Management list. Main Admin sees every quiz; a Content Admin sees only
// their own. Reuses the program-visibility machinery only for the public list.
router.get('/mine', requireAuth, requireRole(...AUTHOR_ROLES), (req, res) => {
  let rows;
  if (req.user.role === ROLES.ADMIN) {
    rows = db.prepare('SELECT * FROM resources WHERE category = ? ORDER BY updated_at DESC').all('quiz');
  } else {
    rows = db.prepare('SELECT * FROM resources WHERE category = ? AND uploaded_by = ? ORDER BY updated_at DESC')
      .all('quiz', req.user.id);
  }
  res.json({ quizzes: rows.map(serializeOwnQuiz) });
});

// Full quiz (with answers) for editing. Author-only / Main Admin.
router.get('/:id/manage', requireAuth, requireRole(...AUTHOR_ROLES), (req, res) => {
  const row = db.prepare('SELECT * FROM resources WHERE id = ? AND category = ?').get(req.params.id, 'quiz');
  if (!row) return res.status(404).json({ message: 'Quiz not found.' });
  if (req.user.role !== ROLES.ADMIN && row.uploaded_by !== req.user.id) {
    return res.status(403).json({ message: 'You can only view quizzes you created.' });
  }
  let data = {};
  try { data = row.quiz_data ? JSON.parse(row.quiz_data) : data; } catch { /* fall through */ }
  const quiz = serializeOwnQuiz(row);
  quiz.questions = data.questions || [];
  quiz.passingPercent = passingPercentFor(data);
  res.json({ quiz });
});

// ── Image upload (posted by admin / Content Admin) ──
// Images are streamed to the same bucket as every other upload; only the key
// (never a public URL) is stored on the question. Served back via GET /image/:key.
// Only inert raster types are accepted: SVG is deliberately excluded because
// a same-origin image/svg+xml response can carry active content
// (scripts/foreignObject) - a stored XSS vector when rendered in the quiz.
const QUIZ_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

router.post('/image', requireAuth, requireRole(...AUTHOR_ROLES), upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Choose an image to upload.' });
  const mime = String(req.file.mimetype || '').toLowerCase();
  if (!QUIZ_IMAGE_MIMES.has(mime)) {
    storage.deleteObject(req.file.key).catch(() => {});
    return res.status(400).json({ message: 'Quiz images must be PNG, JPEG, WebP or GIF files.' });
  }
  return res.status(201).json({ key: req.file.key });
});

// Serve a quiz image. Session-gated (the quiz surface is for signed-in users
// only); safeKey() rejects any non-issued key, so traversal is impossible.
// Only known-safe raster types are ever rendered: SVG and any other type is
// refused, so a legacy object from before the raster-only upload rule can
// never execute active content on this origin.
router.get('/image/:key', requireAuth, (req, res) => {
  const key = normalizeKey(req.params.key);
  if (!key) return res.status(400).json({ message: 'Invalid image reference.' });
  storage.headObject(key).then(async (meta) => {
    const type = String(meta.contentType || '').trim().toLowerCase().split(';')[0].trim();
    if (!QUIZ_IMAGE_MIMES.has(type)) {
      return res.status(404).json({ message: 'Image not found.' });
    }
    const object = await storage.getObject(key);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.status(200);
    if (object.body && typeof object.body.pipe === 'function') {
      object.body.pipe(res);
    } else if (Buffer.isBuffer(object.body) || typeof object.body === 'string') {
      res.end(object.body);
    } else {
      res.end();
    }
  }).catch(() => res.status(404).json({ message: 'Image not found.' }));
});

// Quizzes are a Premium feature. A student may take them only with an active
// Premium subscription; Main Admin may preview them. Trial and free students
// see the cards but every take/attempt is blocked server-side.
//
// req.user (from the JWT) intentionally carries only id/email/role, so we load
// the full subscription state from SQLite here — the same pattern the rest of
// the platform uses for premium/trial access decisions.
function hasPremiumAccess(userId) {
  if (!userId) return false;
  const user = db.prepare('SELECT id, role, subscription, subscription_end FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (!isStudent(user)) return false;
  const now = Date.now();
  const subEnd = new Date(user.subscription_end || 0).getTime();
  return user.subscription === 'premium' && now < subEnd;
}

// ── Student-facing ─────────────────────────

function attemptSummaryFor(resourceId, userId) {
  const rows = db.prepare('SELECT score, total, created_at FROM quiz_attempts WHERE user_id = ? AND resource_id = ? ORDER BY created_at DESC')
    .all(userId, resourceId);
  const best = rows.reduce((max, r) => Math.max(max, r.total ? r.score / r.total : 0), 0);
  return {
    attempts: rows.length,
    bestPercent: Math.round(best * 100),
    completed: rows.length > 0,
    lastAttemptAt: rows.length ? rows[0].created_at : null
  };
}

// Quizzes targeted at the signed-in student's program (respects the same
// program/course visibility rules as every resource).
router.get('/student', requireAuth, (req, res) => {
  if (req.user.role !== ROLES.STUDENT && req.user.role !== ROLES.ADMIN) {
    return res.status(403).json({ message: 'Only students can list practice quizzes.' });
  }
  const vis = resourceVisibilityClause(req.user, 'resources');
  const where = `resources.category = 'quiz' AND resources.publish_status = 'published'${vis.clause ? ` AND ${vis.clause}` : ''}`;
  const rows = db.prepare(`SELECT resources.* FROM resources WHERE ${where} ORDER BY resources.created_at DESC`)
    .all(vis.params);

  const quizzes = rows.map((row) => {
    let data = { questions: [] };
    try { data = row.quiz_data ? JSON.parse(row.quiz_data) : data; } catch { /* fall through */ }
    const questions = Array.isArray(data.questions) ? data.questions : [];
    const totalPoints = questions.reduce((sum, q) => sum + (Number(q.points) || 1), 0);
    const targeting = targetingForResource(row);
    const base = {
      id: row.id,
      title: row.title,
      description: row.description || '',
      questionCount: questions.length,
      totalPoints,
      passingPercent: passingPercentFor(data),
      targetAll: targeting.targetAll,
      programCodes: targeting.programs,
      createdAt: row.created_at
    };
    if (req.user.role === ROLES.ADMIN) return base;
    return { ...base, ...attemptSummaryFor(row.id, req.user.id), locked: !hasPremiumAccess(req.user.id) };
  });

  res.json({ quizzes });
});

// The quiz a student will take — correct answers are intentionally omitted.
router.get('/:id', requireAuth, (req, res) => {
  if (req.user.role !== ROLES.STUDENT && req.user.role !== ROLES.ADMIN) {
    return res.status(403).json({ message: 'Only students can take quizzes.' });
  }
  const row = db.prepare('SELECT * FROM resources WHERE id = ? AND category = ? AND publish_status = ?')
    .get(req.params.id, 'quiz', 'published');
  if (!row) return res.status(404).json({ message: 'Quiz not found.' });
  // Program/course gating — same rule as any other resource on the platform.
  if (!programCanSeeResource(req.user, row)) {
    return res.status(403).json({ message: 'This quiz is not available for your program.' });
  }

  // Premium-only: non-premium students cannot open the quiz.
  if (isStudent(req.user) && !hasPremiumAccess(req.user.id)) {
    return res.status(403).json({ message: 'Quizzes are a Premium feature. Upgrade your plan to take this quiz.', locked: true });
  }

  let data = { questions: [] };
  try { data = row.quiz_data ? JSON.parse(row.quiz_data) : data; } catch { /* fall through */ }
  const questions = (data.questions || []).map((q) => {
    const safe = {
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      image: q.image || null,
      points: Number(q.points) || 1,
      multiple: Boolean(q.multiple)
    };
    if (q.type === 'mcq') {
      safe.options = q.options;
    }
    // `correct` / `answers` / `explanation` are withheld until after grading.
    return safe;
  });

  res.json({
    id: row.id,
    title: row.title,
    description: row.description || '',
    passingPercent: passingPercentFor(data),
    questionCount: questions.length,
    totalPoints: questions.reduce((sum, q) => sum + q.points, 0),
    questions
  });
});

// Grade a submission. Always server-side; returns per-question results so the
// student can review exactly what they got right and why.
router.post('/:id/attempt', requireAuth, (req, res) => {
  if (req.user.role !== ROLES.STUDENT) {
    return res.status(403).json({ message: 'Only students can submit quiz attempts.' });
  }
  const row = db.prepare('SELECT * FROM resources WHERE id = ? AND category = ? AND publish_status = ?')
    .get(req.params.id, 'quiz', 'published');
  if (!row) return res.status(404).json({ message: 'Quiz not found.' });
  if (!programCanSeeResource(req.user, row)) {
    return res.status(403).json({ message: 'This quiz is not available for your program.' });
  }

  // Premium-only: non-premium students cannot submit attempts.
  if (isStudent(req.user) && !hasPremiumAccess(req.user.id)) {
    return res.status(403).json({ message: 'Quizzes are a Premium feature. Upgrade your plan to take this quiz.', locked: true });
  }

  let data = { questions: [] };
  try { data = row.quiz_data ? JSON.parse(row.quiz_data) : data; } catch { /* fall through */ }
  const questions = Array.isArray(data.questions) ? data.questions : [];
  if (!questions.length) return res.status(400).json({ message: 'This quiz has no questions.' });

  const payload = req.body || {};
  const submitted = Array.isArray(payload.answers) ? payload.answers : [];
  const byId = new Map(submitted.map((a) => [String(a && a.questionId), a]));

  let total = 0;
  let score = 0;
  const results = questions.map((q) => {
    const pts = Number(q.points) || 1;
    total += pts;
    const answer = byId.get(String(q.id)) || {};
    let isCorrect = false;
    let selected = answer.value;

    if (q.type === 'mcq') {
      const picked = Array.isArray(answer.value)
        ? Array.from(new Set(answer.value.map((v) => Number(v)).filter((v) => Number.isInteger(v))))
        : [];
      const correctSet = new Set(q.correct.map(Number));
      const pickedSet = new Set(picked);
      if (q.multiple) {
        isCorrect = correctSet.size === pickedSet.size && [...correctSet].every((c) => pickedSet.has(c));
      } else {
        isCorrect = pickedSet.size === 1 && correctSet.has([...pickedSet][0]);
      }
      selected = picked;
      if (isCorrect) score += pts;
      return {
        questionId: q.id,
        type: 'mcq',
        prompt: q.prompt,
        image: q.image || null,
        options: q.options,
        multiple: Boolean(q.multiple),
        correct: q.correct,
        selected,
        isCorrect,
        earned: isCorrect ? pts : 0,
        points: pts,
        explanation: q.explanation || ''
      };
    }

    // text answer
    const given = typeof answer.value === 'string' ? answer.value.trim() : '';
    const norm = (s) => (q.caseSensitive ? s : s.toLowerCase());
    isCorrect = given !== '' && q.answers.some((a) => norm(String(a).trim()) === norm(given));
    selected = given;
    if (isCorrect) score += pts;
    return {
      questionId: q.id,
      type: 'text',
      prompt: q.prompt,
      image: q.image || null,
      correct: q.answers,
      caseSensitive: Boolean(q.caseSensitive),
      selected,
      isCorrect,
      earned: isCorrect ? pts : 0,
      points: pts,
      explanation: q.explanation || ''
    };
  });

  const percent = total > 0 ? Math.round((score / total) * 100) : 0;
  const passingPercent = passingPercentFor(data);
  const passed = percent >= passingPercent;

  try {
    db.prepare(`
      INSERT INTO quiz_attempts (id, user_id, resource_id, score, total, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`qa-${uuidv4()}`, req.user.id, row.id, Math.round(score), Math.round(total), new Date().toISOString());
    // Taking (and scoring on) a quiz counts as engaging with the topic.
    db.prepare(`
      INSERT INTO lesson_progress (id, user_id, resource_id, completed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, resource_id) DO NOTHING
    `).run(`lp-${uuidv4()}`, req.user.id, row.id, new Date().toISOString());
  } catch (err) {
    console.error('Quiz attempt record failed:', err.message);
    // Grading already succeeded; still return the result to the student.
  }

  res.status(201).json({ score, total, percent, passed, passingPercent, results });
});

router.get('/:id/attempts/mine', requireAuth, (req, res) => {
  if (req.user.role !== ROLES.STUDENT) {
    return res.status(403).json({ message: 'Only students can view their attempts.' });
  }
  const row = db.prepare('SELECT id FROM resources WHERE id = ? AND category = ?').get(req.params.id, 'quiz');
  if (!row) return res.status(404).json({ message: 'Quiz not found.' });

  const rows = db.prepare('SELECT score, total, created_at FROM quiz_attempts WHERE user_id = ? AND resource_id = ? ORDER BY created_at DESC')
    .all(req.user.id, row.id);
  const best = rows.reduce((max, r) => Math.max(max, r.total ? r.score / r.total : 0), 0);
  res.json({
    attempts: rows.map((r) => ({ score: r.score, total: r.total, percent: r.total ? Math.round((r.score / r.total) * 100) : 0, createdAt: r.created_at })),
    bestPercent: Math.round(best * 100)
  });
});

module.exports = router;
