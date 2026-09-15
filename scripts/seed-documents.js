'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function pdfEscape(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function makePdf({ pages = 3, title = 'StudyCore Document', subject = 'General', term = 'Term 1' }) {
  const kids = [];
  const objs = [];
  let nextId = 3;

  function add(body) {
    const id = nextId++;
    objs.push({ id, body });
    return id;
  }

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  for (let i = 0; i < pages; i += 1) {
    const lines = [
      `BT /F1 20 Tf 50 750 Td (${pdfEscape(title)}) Tj ET`,
      `BT /F1 12 Tf 50 720 Td (${pdfEscape(`${subject} · ${term} · Page ${i + 1} of ${pages} — StudyCore Revision Material`)}) Tj ET`,
      `BT /F1 10 Tf 50 680 Td (${pdfEscape('1. Core Concepts & Overview')}) Tj ET`,
      `BT /F1 10 Tf 50 660 Td (${pdfEscape('This document contains foundational study notes, tutorial problems, and revision solutions.')}) Tj ET`,
      `BT /F1 10 Tf 50 640 Td (${pdfEscape('Review these sections thoroughly in preparation for your continuous assessments and final exams.')}) Tj ET`,
      `BT /F1 10 Tf 50 600 Td (${pdfEscape('2. Key Formulas and Derivations')}) Tj ET`,
      `BT /F1 10 Tf 50 580 Td (${pdfEscape('Refer to course lecture guidelines and textbook references for extended practice problems.')}) Tj ET`
    ];

    for (let lineNum = 1; lineNum <= 15; lineNum++) {
      const y = 550 - lineNum * 22;
      lines.push(`BT /F1 9 Tf 50 ${y} Td (${pdfEscape(`Section ${lineNum}: Sample problem analysis, worked examples, and exam hints for ${subject}.`)}) Tj ET`);
    }

    const stream = lines.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    kids.push(`${pageId} 0 R`);
  }

  const pagesObj = `2 0 obj << /Type /Pages /Kids [ ${kids.join(' ')} ] /Count ${pages} >> endobj\n`;
  const catalog = `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n`;
  let body = '%PDF-1.4\n';
  const pos = { 1: Buffer.byteLength(body) };
  body += catalog;
  pos[2] = Buffer.byteLength(body);
  body += pagesObj;
  for (const obj of objs) {
    pos[obj.id] = Buffer.byteLength(body);
    body += `${obj.id} 0 obj ${obj.body} endobj\n`;
  }
  const xrefStart = Buffer.byteLength(body);
  const count = nextId;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i += 1) {
    xref += `${String(pos[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer << /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body);
}

function seed() {
  const db = require('../db');

  // Seed standard admin user if none exists
  const existingAdmin = db.prepare(`SELECT * FROM users WHERE role = 'admin' LIMIT 1`).get();
  if (!existingAdmin) {
    const adminId = `user-admin-${randomUUID()}`;
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, program_code, subscription, trial_end, subscription_end, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      adminId,
      'StudyCore Admin',
      'admin@studycore.com',
      bcrypt.hashSync('Admin123!', 8),
      'admin',
      'LAW',
      'premium',
      new Date(Date.now() + 365 * 86400000).toISOString(),
      new Date(Date.now() + 365 * 86400000).toISOString(),
      new Date().toISOString()
    );
    console.log('Seeded admin account: admin@studycore.com / Admin123!');
  }

  // Seed sample demo student if none exists
  const existingStudent = db.prepare(`SELECT * FROM users WHERE email = 'student@studycore.com' LIMIT 1`).get();
  if (!existingStudent) {
    const studentId = `user-student-${randomUUID()}`;
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, program_code, subscription, trial_end, subscription_end, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      studentId,
      'Chileshe Musonda',
      'student@studycore.com',
      bcrypt.hashSync('Student123!', 8),
      'student',
      'LAW',
      'premium',
      new Date(Date.now() + 30 * 86400000).toISOString(),
      new Date(Date.now() + 30 * 86400000).toISOString(),
      new Date().toISOString()
    );
    console.log('Seeded student account: student@studycore.com / Student123!');
  }

  const sampleDocuments = [
    {
      title: 'MA110 Calculus & Linear Algebra Lecture Notes',
      category: 'document',
      subject: 'Mathematics',
      courseCode: 'MA110',
      topic: 'Calculus',
      term: 'Term 1',
      pages: 8,
      isPremium: 0
    },
    {
      title: 'MA110 Term 1 Tutorial Sheet & Solutions',
      category: 'tutorial',
      subject: 'Mathematics',
      courseCode: 'MA110',
      topic: 'Limits and Continuity',
      term: 'Term 1',
      pages: 4,
      isPremium: 0
    },
    {
      title: 'MA110 Final Exam Past Paper 2024',
      category: 'past_paper',
      subject: 'Mathematics',
      courseCode: 'MA110',
      topic: 'Past Papers',
      term: 'Term 1',
      pages: 6,
      isPremium: 0
    },
    {
      title: 'PH110 Mechanics and Wave Motion Comprehensive Notes',
      category: 'document',
      subject: 'Physics',
      courseCode: 'PH110',
      topic: 'Classical Mechanics',
      term: 'Term 1',
      pages: 7,
      isPremium: 0
    },
    {
      title: 'PH110 Tutorial Sheet 1: Kinematics and Dynamics',
      category: 'tutorial',
      subject: 'Physics',
      courseCode: 'PH110',
      topic: 'Kinematics',
      term: 'Term 1',
      pages: 4,
      isPremium: 0
    },
    {
      title: 'CH110 General Chemistry Notes: Chemical Bonding',
      category: 'document',
      subject: 'Chemistry',
      courseCode: 'CH110',
      topic: 'Chemical Bonding',
      term: 'Term 1',
      pages: 6,
      isPremium: 0
    },
    {
      title: 'CH110 Lab Report Sample: Acid-Base Titrations',
      category: 'lab_report',
      subject: 'Chemistry',
      courseCode: 'CH110',
      topic: 'Laboratory Reports',
      term: 'Term 1',
      pages: 5,
      isPremium: 1
    },
    {
      title: 'CS110 Introduction to Programming in C & Python Notes',
      category: 'document',
      subject: 'Programming',
      courseCode: 'CS110',
      topic: 'Algorithms and Data Structures',
      term: 'Term 1',
      pages: 10,
      isPremium: 0
    },
    {
      title: 'LS110 Law of Contract Foundations Notes',
      category: 'document',
      subject: 'Law of Contract',
      courseCode: 'LS110',
      topic: 'Offer and Acceptance',
      term: 'Term 1',
      pages: 8,
      isPremium: 0
    },
    {
      title: 'LS120 Law of Torts Negligence Tutorial Sheet',
      category: 'tutorial',
      subject: 'Law of Torts',
      courseCode: 'LS120',
      topic: 'Duty of Care',
      term: 'Term 1',
      pages: 4,
      isPremium: 0
    },
    {
      title: 'LS100 Constitutional Law Past Paper 2024',
      category: 'past_paper',
      subject: 'Constitutional Law',
      courseCode: 'LS100',
      topic: 'Past Papers',
      term: 'Term 1',
      pages: 6,
      isPremium: 0
    }
  ];

  for (const doc of sampleDocuments) {
    const course = db.prepare(`SELECT id, name, subject FROM courses WHERE code = ? LIMIT 1`).get(doc.courseCode);
    const courseId = course ? course.id : null;
    const subjectName = (course && course.subject) ? course.subject : (course ? course.name : doc.subject);

    const existing = db.prepare(`SELECT id FROM resources WHERE title = ? LIMIT 1`).get(doc.title);
    if (existing) continue;

    const resourceId = `res-${randomUUID()}`;
    const storedFileName = `${resourceId}.pdf`;
    const pdfBuffer = makePdf({
      pages: doc.pages,
      title: doc.title,
      subject: subjectName,
      term: doc.term
    });

    const filePath = path.join(UPLOADS_DIR, storedFileName);
    fs.writeFileSync(filePath, pdfBuffer);

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO resources (
        id, title, description, category, resource_type, subject, course, course_id,
        target_all, topic, year_level, semester, file_name, stored_name, file_size,
        mime_type, is_premium, publish_status, storage_provider, created_at, updated_at
      ) VALUES (
        @id, @title, @description, @category, @resource_type, @subject, @course, @course_id,
        @target_all, @topic, @year_level, @semester, @file_name, @stored_name, @file_size,
        @mime_type, @is_premium, 'published', 'local', @now, @now
      )
    `).run({
      id: resourceId,
      title: doc.title,
      description: `Official StudyCore study material for ${subjectName} (${doc.term}).`,
      category: doc.category,
      resource_type: doc.category === 'past_paper' ? 'Past Paper' : (doc.category === 'tutorial' ? 'Tutorial' : 'Notes'),
      subject: subjectName,
      course: doc.courseCode,
      course_id: courseId,
      target_all: 1,
      topic: doc.topic,
      year_level: 'Year 1',
      semester: doc.term,
      file_name: `${doc.title}.pdf`,
      stored_name: storedFileName,
      file_size: pdfBuffer.length,
      mime_type: 'application/pdf',
      is_premium: doc.isPremium,
      now
    });

    console.log(`Seeded document: ${doc.title} (${doc.category}) -> /viewer/${resourceId}`);
  }

  console.log('Seeding complete! All sample documents are generated and available.');
}

try {
  seed();
} catch (err) {
  console.error('Seeding error:', err);
}
