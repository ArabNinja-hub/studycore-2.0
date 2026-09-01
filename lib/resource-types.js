// Resource type labels used by the limited Content Admin workflow.
// The existing resources table still uses `category` for student-facing
// placement and viewers; `resource_type` preserves the more helpful label an
// uploader selected (for example, "Study Guide" vs a generic document).

const CONTENT_RESOURCE_TYPES = Object.freeze({
  notes: { key: 'notes', label: 'Notes', category: 'document' },
  past_paper: { key: 'past_paper', label: 'Past Paper', category: 'past_paper' },
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
    case 'tutorial':
      return CONTENT_RESOURCE_TYPES.study_guide;
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
