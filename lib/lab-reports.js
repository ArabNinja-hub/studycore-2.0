'use strict';

// Lab reports are intentionally limited to the first-year laboratory science
// courses requested by the schools that use them. Keep this rule on the
// server as well as in the UI so a crafted upload cannot create a Lab Reports
// section in an unrelated program/course.
const LAB_REPORT_SUBJECTS = Object.freeze({
  SMMS: new Set(['physics', 'chemistry']),
  SMNS: new Set(['physics', 'chemistry']),
  SNR: new Set(['physics', 'chemistry']),
  SICT: new Set(['physics'])
});

function courseSubject(course) {
  if (!course) return '';
  const candidates = [course.subject, course.name];
  for (const value of candidates) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'physics' || normalized === 'chemistry') return normalized;
  }
  return '';
}

function canUseLabReports(programCode, course) {
  const subjects = LAB_REPORT_SUBJECTS[String(programCode || '').trim().toUpperCase()];
  return Boolean(subjects && subjects.has(courseSubject(course)));
}

function validateLabReportPlacement(programCodes, course) {
  const codes = [...new Set((programCodes || []).map((code) => String(code || '').trim().toUpperCase()).filter(Boolean))];
  if (!course) return 'Select a Physics or Chemistry course for every lab report.';
  if (!codes.length) return 'Lab reports must target an eligible school; they cannot target All Programs.';
  const invalid = codes.filter((code) => !canUseLabReports(code, course));
  if (invalid.length) {
    return 'Lab reports are available only for Physics and Chemistry in School of Mines, Non-Quota and School of Natural Resources, and for Physics in SICT.';
  }
  return null;
}

module.exports = { LAB_REPORT_SUBJECTS, courseSubject, canUseLabReports, validateLabReportPlacement };
