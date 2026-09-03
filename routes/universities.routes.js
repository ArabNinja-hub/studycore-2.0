// =============================================
// STUDYCORE — Universities, faculties and the
// public course directory
// -----------------------------------------------
//   University → School / Faculty → Programme
//   → Year → Course
//
// The directory endpoints are public: they
// expose structure and counts only (never
// notes, videos or past-paper files), so the
// Courses page and the public course hubs can
// be crawled, indexed and shared. Everything
// below /admin is Main Admin only and mirrors
// the existing /api/programs/admin pattern.
// =============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ROLES, isAdmin } = require('../lib/roles');
const { serializeUniversity, serializeFaculty, slugify } = require('../lib/universities');
const { serializeProgram, serializeCourse } = require('../lib/programs');

const router = express.Router();
const adminOnly = requireRole(ROLES.ADMIN);

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function facultiesForUniversity(universityId) {
  return db.prepare('SELECT * FROM faculties WHERE university_id = ? ORDER BY sort_order ASC, name ASC').all(universityId);
}

function programsForFaculty(facultyId) {
  return db.prepare('SELECT * FROM programs WHERE faculty_id = ? ORDER BY rowid ASC').all(facultyId);
}

// Courses for a program, with public content counts and the year of study.
function programCourses(programCode) {
  const rows = db.prepare(`
    SELECT c.*, pc.year_level, pc.sort_order
    FROM program_courses pc
    JOIN courses c ON c.id = pc.course_id
    WHERE pc.program_code = ?
    ORDER BY pc.year_level ASC, pc.sort_order ASC, c.code ASC
  `).all(programCode);

  return rows.map((c) => {
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN category = 'video' THEN 1 ELSE 0 END) AS videos,
        SUM(CASE WHEN category = 'document' THEN 1 ELSE 0 END) AS documents,
        SUM(CASE WHEN category = 'tutorial' THEN 1 ELSE 0 END) AS tutorials,
        SUM(CASE WHEN category = 'past_paper' THEN 1 ELSE 0 END) AS past_papers
      FROM resources
      WHERE publish_status = 'published' AND course_id = @courseId
    `).get({ courseId: c.id });
    const topics = db.prepare(`
      SELECT COUNT(DISTINCT topic) AS c FROM resources
      WHERE publish_status = 'published' AND course_id = @courseId
        AND topic IS NOT NULL AND topic != ''
    `).get({ courseId: c.id }).c;

    return serializeCourse(c, {
      yearLevel: c.year_level || null,
      counts: {
        lessons: (counts.videos || 0) + (counts.documents || 0) + (counts.tutorials || 0) + (counts.past_papers || 0),
        topics,
        videos: counts.videos || 0,
        documents: counts.documents || 0,
        tutorials: counts.tutorials || 0,
        notes: (counts.documents || 0) + (counts.tutorials || 0),
        pastPapers: counts.past_papers || 0
      }
    });
  });
}

function topicNamesForCourse(courseId) {
  return db.prepare(`
    SELECT DISTINCT topic FROM resources
    WHERE publish_status = 'published' AND course_id = ?
      AND topic IS NOT NULL AND topic != ''
    ORDER BY topic ASC
  `).all(courseId).map((r) => r.topic);
}

// ---- Public: the full directory ------------------------------------------
// GET /api/universities → University → Faculty → Programme → Course, with
// counts only. Used by the Courses page and the signup program picker.
router.get('/', (req, res) => {
  const universities = db.prepare('SELECT * FROM universities ORDER BY sort_order ASC, name ASC').all();

  const tree = universities.map((u) => {
    const faculties = facultiesForUniversity(u.id).map((f) => {
      const programs = programsForFaculty(f.id).map((p) => serializeProgram(p, {
        universityCode: u.code,
        facultyCode: f.code,
        yearCount: p.year_count || 1,
        courseCount: db.prepare('SELECT COUNT(*) c FROM program_courses WHERE program_code = ?').get(p.code).c,
        courses: req.query.courses === '1' ? programCourses(p.code) : undefined
      }));
      return serializeFaculty(f, { programs });
    });

    // Programs that exist but have no faculty assigned yet are still shown —
    // they belong to the university and must not disappear from the catalog.
    const orphanPrograms = db
      .prepare('SELECT * FROM programs WHERE university_id = ? AND faculty_id IS NULL ORDER BY rowid ASC')
      .all(u.id)
      .map((p) => serializeProgram(p, {
        universityCode: u.code,
        facultyCode: null,
        yearCount: p.year_count || 1,
        courseCount: db.prepare('SELECT COUNT(*) c FROM program_courses WHERE program_code = ?').get(p.code).c,
        courses: req.query.courses === '1' ? programCourses(p.code) : undefined
      }));

    return serializeUniversity(u, {
      faculties,
      orphanPrograms,
      programCount: db.prepare('SELECT COUNT(*) c FROM programs WHERE university_id = ?').get(u.id).c,
      facultyCount: faculties.length
    });
  });

  res.json({ universities: tree });
});

// ---- Public: one course hub (indexable, SEO) -----------------------------
// GET /api/universities/course/:slug → the course description, its topics and
// public counts. No file data, no resource ids — safe for anonymous visitors
// and search engines. Registered before the admin routes so :slug never
// collides with an admin path.
router.get('/course/:slug', (req, res) => {
  const key = String(req.params.slug || '').trim().toLowerCase();
  const course = db.prepare('SELECT * FROM courses WHERE slug = ?').get(key)
    || db.prepare('SELECT * FROM courses WHERE LOWER(code) = ?').get(key);
  if (!course) return res.status(404).json({ message: 'Course not found.' });

  const programs = db.prepare(`
    SELECT p.*, f.name AS faculty_name, f.short_name AS faculty_short_name,
           u.name AS university_name, u.code AS university_code
    FROM program_courses pc
    JOIN programs p ON p.code = pc.program_code
    LEFT JOIN faculties f ON f.id = p.faculty_id
    LEFT JOIN universities u ON u.id = p.university_id
    WHERE pc.course_id = ?
    ORDER BY u.name ASC, f.name ASC, p.name ASC
  `).all(course.id);

  const [serialized] = programCourses(programs[0] ? programs[0].code : '');
  const counts = serialized && serialized.slug === course.slug
    ? serialized.counts
    : (() => {
      const c = db.prepare(`
        SELECT
          SUM(CASE WHEN category = 'video' THEN 1 ELSE 0 END) AS videos,
          SUM(CASE WHEN category = 'document' THEN 1 ELSE 0 END) AS documents,
          SUM(CASE WHEN category = 'tutorial' THEN 1 ELSE 0 END) AS tutorials,
          SUM(CASE WHEN category = 'past_paper' THEN 1 ELSE 0 END) AS past_papers
        FROM resources WHERE publish_status = 'published' AND course_id = ?
      `).get(course.id);
      const topics = topicNamesForCourse(course.id).length;
      return {
        lessons: (c.videos || 0) + (c.documents || 0) + (c.tutorials || 0) + (c.past_papers || 0),
        topics,
        videos: c.videos || 0,
        documents: c.documents || 0,
        tutorials: c.tutorials || 0,
        notes: (c.documents || 0) + (c.tutorials || 0),
        pastPapers: c.past_papers || 0
      };
    })();

  res.json({
    course: serializeCourse(course, { counts }),
    topics: topicNamesForCourse(course.id),
    examYears: db.prepare(`
      SELECT DISTINCT exam_year FROM resources
      WHERE publish_status = 'published' AND course_id = ? AND category = 'past_paper' AND exam_year IS NOT NULL
      ORDER BY exam_year DESC
    `).all(course.id).map((r) => r.exam_year),
    programs: programs.map((p) => ({
      code: p.code,
      name: p.name,
      shortName: p.short_name || p.name,
      faculty: p.faculty_short_name || p.faculty_name || null,
      university: p.university_name || null,
      universityCode: p.university_code || null
    }))
  });
});

// ---- Admin: universities -------------------------------------------------
router.get('/admin', adminOnly, (req, res) => {
  const universities = db.prepare('SELECT * FROM universities ORDER BY sort_order ASC, name ASC').all()
    .map((u) => serializeUniversity(u, {
      facultyCount: facultiesForUniversity(u.id).length,
      programCount: db.prepare('SELECT COUNT(*) c FROM programs WHERE university_id = ?').get(u.id).c,
      faculties: facultiesForUniversity(u.id).map((f) => serializeFaculty(f, {
        programCount: programsForFaculty(f.id).length,
        programs: programsForFaculty(f.id).map((p) => serializeProgram(p))
      }))
    }));
  res.json({ universities });
});

function cleanText(value, max = 200) {
  const v = String(value === undefined || value === null ? '' : value).trim().slice(0, max);
  return v || null;
}

router.post('/admin', adminOnly, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 16);
  const name = cleanText(req.body.name, 160);
  if (!code) return res.status(400).json({ message: 'A short university code is required (e.g. UNZA).' });
  if (!/^[A-Z0-9-]+$/.test(code)) return res.status(400).json({ message: 'The code may only contain letters, numbers and hyphens.' });
  if (!name) return res.status(400).json({ message: 'A university name is required.' });
  if (db.prepare('SELECT id FROM universities WHERE code = ?').get(code)) {
    return res.status(409).json({ message: 'A university with that code already exists.' });
  }
  const id = `uni-${slugify(code)}`;
  db.prepare(`
    INSERT INTO universities (id, code, name, short_name, country, city, icon, description, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, code, name, cleanText(req.body.shortName, 60) || name, cleanText(req.body.country, 80),
    cleanText(req.body.city, 80), cleanText(req.body.icon, 40) || 'school', cleanText(req.body.description, 400),
    Number(req.body.sortOrder) || 0, new Date().toISOString());
  res.status(201).json({ university: serializeUniversity(db.prepare('SELECT * FROM universities WHERE id = ?').get(id)) });
});

router.put('/admin/:id', adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM universities WHERE id = ? OR code = ?').get(req.params.id, String(req.params.id).toUpperCase());
  if (!row) return res.status(404).json({ message: 'University not found.' });
  const name = cleanText(req.body.name, 160) || row.name;
  db.prepare(`
    UPDATE universities SET name = ?, short_name = ?, country = ?, city = ?, icon = ?, description = ?, sort_order = ?
    WHERE id = ?
  `).run(name, cleanText(req.body.shortName, 60) || name, cleanText(req.body.country, 80), cleanText(req.body.city, 80),
    cleanText(req.body.icon, 40) || 'school', cleanText(req.body.description, 400), Number(req.body.sortOrder) || 0, row.id);
  res.json({ university: serializeUniversity(db.prepare('SELECT * FROM universities WHERE id = ?').get(row.id)) });
});

router.delete('/admin/:id', adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM universities WHERE id = ? OR code = ?').get(req.params.id, String(req.params.id).toUpperCase());
  if (!row) return res.status(404).json({ message: 'University not found.' });
  const used = db.prepare('SELECT COUNT(*) c FROM programs WHERE university_id = ?').get(row.id).c;
  if (used > 0) {
    return res.status(409).json({ message: `${used} programme(s) still belong to this university. Move them first.` });
  }
  db.prepare('DELETE FROM universities WHERE id = ?').run(row.id);
  res.json({ deleted: true });
});

// ---- Admin: faculties ----------------------------------------------------
router.post('/admin/:id/faculties', adminOnly, (req, res) => {
  const university = db.prepare('SELECT * FROM universities WHERE id = ? OR code = ?').get(req.params.id, String(req.params.id).toUpperCase());
  if (!university) return res.status(404).json({ message: 'University not found.' });
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 16);
  const name = cleanText(req.body.name, 160);
  if (!code) return res.status(400).json({ message: 'A short faculty/school code is required.' });
  if (!/^[A-Z0-9-]+$/.test(code)) return res.status(400).json({ message: 'The code may only contain letters, numbers and hyphens.' });
  if (!name) return res.status(400).json({ message: 'A faculty/school name is required.' });
  if (db.prepare('SELECT id FROM faculties WHERE university_id = ? AND code = ?').get(university.id, code)) {
    return res.status(409).json({ message: 'That school/faculty already exists for this university.' });
  }
  const id = `fac-${slugify(university.code)}-${slugify(code)}`;
  db.prepare(`
    INSERT INTO faculties (id, code, university_id, name, short_name, icon, description, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, code, university.id, name, cleanText(req.body.shortName, 60), cleanText(req.body.icon, 40) || 'library',
    cleanText(req.body.description, 400), Number(req.body.sortOrder) || 0, new Date().toISOString());
  res.status(201).json({ faculty: serializeFaculty(db.prepare('SELECT * FROM faculties WHERE id = ?').get(id)) });
});

router.put('/admin/faculties/:facultyId', adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM faculties WHERE id = ?').get(req.params.facultyId);
  if (!row) return res.status(404).json({ message: 'School/faculty not found.' });
  const name = cleanText(req.body.name, 160) || row.name;
  const universityId = req.body.universityId
    ? (db.prepare('SELECT id FROM universities WHERE id = ?').get(req.body.universityId) || {}).id || row.university_id
    : row.university_id;
  db.prepare(`
    UPDATE faculties SET name = ?, short_name = ?, icon = ?, description = ?, sort_order = ?, university_id = ?
    WHERE id = ?
  `).run(name, cleanText(req.body.shortName, 60), cleanText(req.body.icon, 40) || 'library',
    cleanText(req.body.description, 400), Number(req.body.sortOrder) || 0, universityId, row.id);
  res.json({ faculty: serializeFaculty(db.prepare('SELECT * FROM faculties WHERE id = ?').get(row.id)) });
});

router.delete('/admin/faculties/:facultyId', adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM faculties WHERE id = ?').get(req.params.facultyId);
  if (!row) return res.status(404).json({ message: 'School/faculty not found.' });
  const used = db.prepare('SELECT COUNT(*) c FROM programs WHERE faculty_id = ?').get(row.id).c;
  if (used > 0) {
    return res.status(409).json({ message: `${used} programme(s) still belong to this school/faculty. Move them first.` });
  }
  db.prepare('DELETE FROM faculties WHERE id = ?').run(row.id);
  res.json({ deleted: true });
});

module.exports = router;
module.exports.programCourses = programCourses;
module.exports.topicNamesForCourse = topicNamesForCourse;
