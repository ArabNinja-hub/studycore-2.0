// Resource type labels used by the limited Content Admin workflow.
// The existing resources table still uses `category` for student-facing
// placement and viewers; `resource_type` preserves the more helpful label an
// uploader selected (for example, "Study Guide" vs a generic document).

const CONTENT_RESOURCE_TYPES = Object.freeze({
  notes: { key: 'notes', label: 'Notes', category: 'document' },
  past_paper: { key: 'past_paper', label: 'Past Paper', category: 'past_paper' },
  lab_report: { key: 'lab_report', label: 'Lab Report', category: 'lab_report' },
  // Tutorial sheets and study guides share the `tutorial` storage category,
  // which is the one rendered by the "Notes & tutorial sheets" slot on the
  // course/study pages. Keeping two labels lets an uploader say which of the
  // two it really is without changing where students find it.
  tutorial_sheet: { key: 'tutorial_sheet', label: 'Tutorial Sheet', category: 'tutorial' },
  study_guide: { key: 'study_guide', label: 'Study Guide', category: 'tutorial' },
  lecture_material: { key: 'lecture_material', label: 'Lecture Material', category: 'document' },
  document: { key: 'document', label: 'Document', category: 'document' },
  video: { key: 'video', label: 'Video', category: 'video' },
  other: { key: 'other', label: 'Other', category: 'document' }
});

const TYPE_ALIASES = Object.freeze({
  note: 'notes',
  notes: 'notes',
  pastpaper: 'past_paper',
  past_paper: 'past_paper',
  'past-paper': 'past_paper',
  labreport: 'lab_report',
  lab_report: 'lab_report',
  'lab-report': 'lab_report',
  tutorial: 'tutorial_sheet',
  tutorials: 'tutorial_sheet',
  tutorialsheet: 'tutorial_sheet',
  tutorial_sheet: 'tutorial_sheet',
  'tutorial-sheet': 'tutorial_sheet',
  sheet: 'tutorial_sheet',
  studyguide: 'study_guide',
  study_guide: 'study_guide',
  'study-guide': 'study_guide',
  lecture: 'lecture_material',
  lecture_material: 'lecture_material',
  'lecture-material': 'lecture_material',
  material: 'lecture_material',
  document: 'document',
  video: 'video',
  other: 'other'
});

function normalizeResourceType(value) {
  const key = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  const canonical = TYPE_ALIASES[key] || key;
  return CONTENT_RESOURCE_TYPES[canonical] || null;
}

function resourceTypeForCategory(category) {
  switch (String(category || '').trim().toLowerCase()) {
    case 'video':
      return CONTENT_RESOURCE_TYPES.video;
    case 'past_paper':
      return CONTENT_RESOURCE_TYPES.past_paper;
    case 'lab_report':
      return CONTENT_RESOURCE_TYPES.lab_report;
    case 'tutorial':
      // Legacy rows only carry the category, so fall back to the broader of
      // the two labels that live in this category.
      return CONTENT_RESOURCE_TYPES.tutorial_sheet;
    case 'announcement':
      return { key: 'announcement', label: 'Announcement', category: 'announcement' };
    case 'quiz':
      return { key: 'quiz', label: 'Quiz', category: 'quiz' };
    case 'assignment':
      return { key: 'assignment', label: 'Assignment', category: 'assignment' };
    case 'document':
    default:
      return CONTENT_RESOURCE_TYPES.document;
  }
}

function resourceTypeLabel(rowOrCategory) {
  if (rowOrCategory && typeof rowOrCategory === 'object') {
    if (rowOrCategory.resource_type && String(rowOrCategory.resource_type).trim()) {
      return String(rowOrCategory.resource_type).trim();
    }
    return resourceTypeForCategory(rowOrCategory.category).label;
  }
  return resourceTypeForCategory(rowOrCategory).label;
}

module.exports = {
  CONTENT_RESOURCE_TYPES,
  normalizeResourceType,
  resourceTypeForCategory,
  resourceTypeLabel
};
