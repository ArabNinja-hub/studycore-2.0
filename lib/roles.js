// =============================================
// StudyCore role helpers
// ---------------------------------------------
// Roles are persisted in lowercase. normalizeRole() also understands the
// legacy uppercase values used by databases created before role names were
// standardised, so upgrading an existing StudyCore installation never grants
// or removes access by accident.
// =============================================

const ROLES = Object.freeze({
  STUDENT: 'student',
  CONTENT_ADMIN: 'content_admin',
  ADMIN: 'admin'
});

const VALID_ROLES = new Set(Object.values(ROLES));

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return VALID_ROLES.has(role) ? role : null;
}

function hasRole(user, role) {
  return Boolean(user) && normalizeRole(user.role) === normalizeRole(role);
}

function isStudent(user) {
  return hasRole(user, ROLES.STUDENT);
}

function isContentAdmin(user) {
  return hasRole(user, ROLES.CONTENT_ADMIN);
}

function isAdmin(user) {
  return hasRole(user, ROLES.ADMIN);
}

function roleLabel(role) {
  switch (normalizeRole(role)) {
    case ROLES.ADMIN:
      return 'Main Admin';
    case ROLES.CONTENT_ADMIN:
      return 'Content Admin';
    case ROLES.STUDENT:
    default:
      return 'Student';
  }
}

function dashboardPathForRole(role) {
  switch (normalizeRole(role)) {
    case ROLES.ADMIN:
      return '/admin.html';
    case ROLES.CONTENT_ADMIN:
      return '/content-admin.html';
    case ROLES.STUDENT:
    default:
      return '/dashboard.html';
  }
}

module.exports = {
  ROLES,
  normalizeRole,
  hasRole,
  isStudent,
  isContentAdmin,
  isAdmin,
  roleLabel,
  dashboardPathForRole
};
