// =============================================
// StudyCore — Content Admin workspace
// ---------------------------------------------
// This client only renders the publisher experience. Every operation below is
// sent to /api/content-admin, whose server-side role and uploader-ownership
// checks remain the authority; this script never decides permissions.
// =============================================

(function () {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const state = {
    profile: null,
    catalog: { programs: [], topics: [] },
    resources: [],
    selectedFile: null,
    editingId: null
  };

  const TYPE_META = {
    notes: { label: 'Notes', category: 'document', icon: 'file-text' },
    past_paper: { label: 'Past Paper', category: 'past_paper', icon: 'file' },
    study_guide: { label: 'Study Guide', category: 'tutorial', icon: 'book-open' },
    lecture_material: { label: 'Lecture Material', category: 'document', icon: 'file-text' },
    document: { label: 'Document', category: 'document', icon: 'file-text' },
    video: { label: 'Video', category: 'video', icon: 'video' },
    other: { label: 'Other', category: 'document', icon: 'library' }
  };

  function icon(name, size) {
    return SC.icon(name, { size: size || 18 });
  }

  function safe(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function initials(name) {
    return String(name || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('') || 'CA';
  }

  function fileSize(bytes) {
    if (!Number(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = Number(bytes);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function relativeTime(iso) {
    if (!iso) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function showToast(message, kind) {
    const container = $('#caToastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `ca-toast ${kind || 'success'}`;
    toast.innerHTML = `${icon(kind === 'error' ? 'alert-triangle' : 'check-circle', 18)}<span>${safe(message)}</span>`;
    container.appendChild(toast);
    window.setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      toast.style.transition = 'opacity .2s, transform .2s';
      window.setTimeout(() => toast.remove(), 220);
    }, 4200);
  }

  function setStatus(element, message, kind) {
    if (!element) return;
    element.className = `ca-form-status${kind ? ` ${kind}` : ''}`;
    element.textContent = message || '';
  }

  function setNavActive(section) {
    document.querySelectorAll('[data-ca-nav]').forEach((link) => {
      link.classList.toggle('active', link.getAttribute('data-ca-nav') === section);
    });
  }

  function closeMobileNav() {
    const menu = $('#caMobileNav');
    const toggle = $('#caMenuToggle');
    if (!menu || !toggle) return;
    menu.classList.remove('open');
    menu.setAttribute('aria-hidden', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open Content Admin navigation');
    toggle.innerHTML = icon('menu', 21);
  }

  function renderProfile(profile) {
    if (!profile) return;
    state.profile = profile;
    $('#caWelcomeName').textContent = `Welcome, ${profile.name}`;
    $('#caNavName').textContent = profile.name;
    $('#caNavAvatar').textContent = initials(profile.name);
    $('#caAccountName').textContent = profile.name;
    $('#caAccountEmail').textContent = profile.email;
    $('#caProfileAvatar').textContent = initials(profile.name);
    $('#caProfileSummaryName').textContent = profile.name;
    $('#caProfileSummaryEmail').textContent = profile.email;
    $('#caProfileName').value = profile.name;
    $('#caProfileEmail').value = profile.email;
    $('#caProfileRole').value = profile.accountType || 'Content Admin';
    $('#caAccountType').innerHTML = `${icon('shield', 14)} ${safe(profile.accountType || 'Content Admin')}`;
  }

  function renderSummary(summary) {
    $('#caTotalCount').textContent = summary.total || 0;
    $('#caPublishedCount').textContent = summary.published || 0;
    $('#caDraftCount').textContent = summary.drafts || 0;
  }

  function typeMeta(resource) {
    return TYPE_META[resource.resourceTypeKey] || TYPE_META[Object.keys(TYPE_META).find((key) => TYPE_META[key].label === resource.resourceType)] || TYPE_META.document;
  }

  function resourceRow(resource) {
    const meta = typeMeta(resource);
    const hierarchy = [resource.schoolFaculty, resource.courseCode || resource.courseName, resource.topic].filter(Boolean).join(' · ');
    return `
      <div class="ca-resource-row">
        <span class="ca-resource-icon">${icon(meta.icon, 17)}</span>
        <div class="ca-resource-main">
          <strong title="${safe(resource.title)}">${safe(resource.title)}</strong>
          <span>${safe(resource.resourceType || meta.label)}${hierarchy ? ` · ${safe(hierarchy)}` : ''}</span>
        </div>
        <span class="ca-resource-time">${safe(relativeTime(resource.uploadedAt))}</span>
      </div>`;
  }

  function renderRecent(resources) {
    const host = $('#caRecentUploads');
    if (!resources || !resources.length) {
      host.innerHTML = `<div class="ca-empty">${icon('upload', 27)}<strong>No uploads yet</strong><p>Your most recent resources will appear here.</p></div>`;
      return;
    }
    host.innerHTML = resources.map(resourceRow).join('');
  }

  function renderUploads(resources) {
    const host = $('#caUploadsList');
    const count = $('#caUploadsCount');
    count.textContent = resources.length === 1 ? '1 resource you uploaded' : `${resources.length} resources you uploaded`;
    if (!resources.length) {
      host.innerHTML = `<div class="ca-empty">${icon('library', 28)}<strong>Your upload library is empty</strong><p>Use Upload Resource to add your first educational resource.</p></div>`;
      return;
    }

    host.innerHTML = resources.map((resource) => {
      const meta = typeMeta(resource);
      const fileMeta = [resource.fileName, fileSize(resource.fileSize)].filter(Boolean).join(' · ') || 'No file attached';
      const placement = [resource.schoolFaculty, resource.courseCode || resource.courseName, resource.topic].filter(Boolean).join(' · ');
      const status = resource.publishStatus === 'draft' ? 'draft' : 'published';
      return `
        <article class="ca-upload-item">
          <span class="ca-resource-icon">${icon(meta.icon, 18)}</span>
          <div class="ca-upload-item-title">
            <strong title="${safe(resource.title)}">${safe(resource.title)}</strong>
            <span>${safe(resource.resourceType || meta.label)} · ${safe(fileMeta)}</span>
          </div>
          <div class="ca-upload-item-place">
            <span>${safe(placement || 'Placement not available')}</span>
            <span><span class="ca-status ${status}">${icon(status === 'published' ? 'check-circle' : 'clock', 12)} ${status === 'published' ? 'Published' : 'Draft'}</span> · ${safe(relativeTime(resource.uploadedAt))}</span>
          </div>
          <div class="ca-upload-actions">
            <button class="btn btn-outline btn-sm" type="button" data-ca-edit="${safe(resource.id)}">${icon('edit', 14)} Edit</button>
            <button class="btn btn-ghost btn-sm" type="button" data-ca-delete="${safe(resource.id)}" style="color:var(--red-600);" aria-label="Delete ${safe(resource.title)}">${icon('trash', 15)}</button>
          </div>
        </article>`;
    }).join('');

    host.querySelectorAll('[data-ca-edit]').forEach((button) => {
      button.addEventListener('click', () => startEdit(button.getAttribute('data-ca-edit')));
    });
    host.querySelectorAll('[data-ca-delete]').forEach((button) => {
      button.addEventListener('click', () => deleteResource(button.getAttribute('data-ca-delete')));
    });
  }

  async function loadDashboard() {
    const data = await StudyCoreAPI.contentAdminDashboard();
    renderProfile(data.profile);
    renderSummary(data.summary || {});
    renderRecent(data.recentUploads || []);
  }

  async function loadResources() {
    const data = await StudyCoreAPI.contentAdminListResources();
    state.resources = data.resources || [];
    renderUploads(state.resources);
  }

  function populateProgramOptions(selectedCode) {
    const select = $('#caSchoolFaculty');
    select.innerHTML = '<option value="">Choose a school / faculty</option>' + state.catalog.programs.map((program) => {
      const label = program.groupName ? `${program.name} (${program.groupName})` : program.name;
      return `<option value="${safe(program.code)}">${safe(label)}</option>`;
    }).join('');
    select.value = selectedCode || '';
  }

  function renderCourses(programCode, selectedCourseId) {
    const courseSelect = $('#caCourse');
    const program = state.catalog.programs.find((item) => item.code === programCode);
    if (!program) {
      courseSelect.disabled = true;
      courseSelect.innerHTML = '<option value="">Choose a school or faculty first</option>';
      renderTopicSuggestions('');
      return;
    }
    const courses = program.courses || [];
    courseSelect.disabled = false;
    courseSelect.innerHTML = '<option value="">Choose a course</option>' + courses.map((course) =>
      `<option value="${safe(course.id)}">${safe(course.code)} — ${safe(course.name)}</option>`
    ).join('');
    courseSelect.value = selectedCourseId || '';
    renderTopicSuggestions(courseSelect.value);
  }

  function renderTopicSuggestions(courseId) {
    const datalist = $('#caTopicSuggestions');
    const uniqueTopics = [...new Set((state.catalog.topics || [])
      .filter((item) => item.courseId === courseId)
      .map((item) => item.topic)
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    datalist.innerHTML = uniqueTopics.map((topic) => `<option value="${safe(topic)}"></option>`).join('');
  }

  async function loadCatalog() {
    const data = await StudyCoreAPI.contentAdminCatalog();
    state.catalog = { programs: data.programs || [], topics: data.topics || [] };
    populateProgramOptions($('#caSchoolFaculty').value);
    renderCourses($('#caSchoolFaculty').value, $('#caCourse').value);
  }

  function setFile(file, options) {
    const opts = options || {};
    state.selectedFile = file || null;
    const label = $('#caFileName');
    if (file) {
      label.textContent = `Selected: ${file.name}${file.size ? ` (${fileSize(file.size)})` : ''}`;
    } else if (opts.currentName) {
      label.textContent = `Current file: ${opts.currentName}${opts.currentSize ? ` (${fileSize(opts.currentSize)})` : ''}. Choose another file only to replace it.`;
    } else {
      label.textContent = '';
    }
  }

  function updateTypeControls() {
    const resourceType = $('#caResourceType').value;
    const isVideo = resourceType === 'video';
    const termField = $('#caTermField');
    const term = $('#caTerm');
    const file = $('#caFile');
    termField.hidden = !isVideo;
    term.required = isVideo;
    file.accept = isVideo
      ? '.mp4,.mov,.webm,.mkv,.avi,video/*'
      : '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.csv,.zip,.rar,.jpg,.jpeg,.png,.gif,.webp,.mp3,.wav';
    $('#caFileDropHint').textContent = isVideo
      ? 'Choose a supported video file: .mp4, .mov, .webm, .mkv, or .avi'
      : 'PDF, office document, image, archive or audio file';
    $('#caFileHelp').textContent = isVideo
      ? 'Video resources must be assigned to Term 1, Term 2, or Term 3.'
      : 'To upload a video, select the Video resource type first.';
  }

  function clearUploadForm() {
    state.editingId = null;
    state.selectedFile = null;
    $('#caUploadForm').reset();
    $('#caEditingResourceId').value = '';
    $('#caGoogleDriveFileId').value = '';
    $('#caGoogleDriveUrl').value = '';
    $('#caGoogleDriveFileName').value = '';
    $('#caGoogleDriveMimeType').value = '';
    $('#caGoogleDriveFileSize').value = '';
    $('#caSchoolFaculty').value = '';
    renderCourses('', '');
    $('#caFile').required = true;
    $('#caFile').value = '';
    $('#caUploadHeading').textContent = 'Upload Resource';
    $('#caUploadSubmitBtn').textContent = 'Publish Resource';
    $('#caCancelEditBtn').hidden = true;
    $('#caFileDropTitle').innerHTML = 'Choose a resource file <span class="ca-required">*</span>';
    setFile(null);
    setStatus($('#caUploadStatus'), '');
    updateTypeControls();
  }

  function formatUploadDetail(info) {
    if (!info || !info.bytesPerSecond) return '';
    const kbps = info.bytesPerSecond / 1024;
    const speed = kbps >= 1024 ? `${(kbps / 1024).toFixed(1)} MB/s` : `${Math.round(kbps)} KB/s`;
    let eta = '';
    if (info.etaSeconds !== null && info.etaSeconds !== undefined && info.etaSeconds < 86400) {
      const s = info.etaSeconds;
      eta = s >= 60 ? ` · about ${Math.ceil(s / 60)} min left` : ` · about ${s}s left`;
    }
    return ` — ${speed}${eta}`;
  }

  function buildFormData() {
    const formData = new FormData();
    formData.append('resourceType', $('#caResourceType').value);
    formData.append('programCode', $('#caSchoolFaculty').value);
    formData.append('courseId', $('#caCourse').value);
    formData.append('topic', $('#caTopic').value.trim());
    formData.append('title', $('#caTitle').value.trim());
    formData.append('description', $('#caDescription').value.trim());
    formData.append('semester', $('#caTerm').value);
    formData.append('yearLevel', $('#caYearLevel').value.trim());
    const driveFileId = $('#caGoogleDriveFileId').value || '';
    if (driveFileId) {
      formData.append('google_drive_file_id', driveFileId);
      formData.append('google_drive_url', $('#caGoogleDriveUrl').value || '');
      formData.append('file_name', $('#caGoogleDriveFileName').value || '');
      formData.append('mime_type', $('#caGoogleDriveMimeType').value || '');
      formData.append('file_size', $('#caGoogleDriveFileSize').value || '');
    }
    formData.append('publishStatus', $('#caPublishStatus').value);
    if (state.selectedFile) formData.append('file', state.selectedFile);
    return formData;
  }

  // ---------------------------------------------------------------
  // Google Drive Picker hand-off.
  // The Picker itself is bootstrapped in /js/google-picker.js (it owns
  // loading api.js + gsi/client, readiness checks and error states). It
  // calls back here with the picked Drive document so this dashboard can
  // populate its hidden form fields.
  // ---------------------------------------------------------------
  window.onGoogleDriveFilePicked = function (doc) {
    if (!doc || !doc.id) return;
    $('#caGoogleDriveFileId').value = doc.id || '';
    $('#caGoogleDriveUrl').value = doc.url || `https://drive.google.com/file/d/${doc.id}/view`;
    $('#caGoogleDriveFileName').value = doc.name || '';
    $('#caGoogleDriveMimeType').value = doc.mimeType || '';
    $('#caGoogleDriveFileSize').value = doc.sizeBytes || 0;
    $('#caFileName').textContent = `Selected: ${doc.name || 'Google Drive Document'}${doc.sizeBytes ? ` (${fileSize(doc.sizeBytes)})` : ''}`;
    $('#caFile').required = false;
    $('#caFile').value = '';
    $('#caFileDropTitle').innerHTML = 'Drive file selected <span style="font-weight:400;color:var(--muted);">(optional — replace with a file upload)</span>';
    state.selectedFile = null;
  };

  function validateUpload() {
    if (!$('#caResourceType').value || !$('#caSchoolFaculty').value || !$('#caCourse').value || !$('#caTopic').value.trim() || !$('#caTitle').value.trim()) {
      return 'Complete every required resource and placement field.';
    }
    if ($('#caResourceType').value === 'video' && !$('#caTerm').value) {
      return 'Choose a term for a video resource.';
    }
    const driveFileId = $('#caGoogleDriveFileId').value || '';
    if (!state.editingId && !state.selectedFile && !driveFileId) {
      return 'Choose a file to upload or select from Google Drive.';
    }
    return null;
  }

  async function submitUpload(event) {
    event.preventDefault();
    const error = validateUpload();
    const status = $('#caUploadStatus');
    if (error) {
      setStatus(status, error, 'error');
      return;
    }

    const editingId = state.editingId;
    const submit = $('#caUploadSubmitBtn');
    const progress = $('#caUploadProgress');
    const progressBar = $('#caUploadProgressBar');
    submit.disabled = true;
    progress.style.display = 'block';
    progress.setAttribute('aria-hidden', 'false');
    progressBar.style.width = '0%';
    setStatus(status, editingId ? 'Saving resource…' : 'Uploading resource…');

    try {
      const formData = buildFormData();
      const endpoint = editingId ? `/api/content-admin/resources/${encodeURIComponent(editingId)}` : '/api/content-admin/resources';
      const result = await StudyCoreAPI.uploadWithProgress(endpoint, editingId ? 'PUT' : 'POST', formData, (percent, info) => {
        progressBar.style.width = `${percent}%`;
        // Percent alone looks frozen on a slow uplink; the live rate and ETA
        // (announced via the existing status line) show it is still moving.
        setStatus(status, `Uploading… ${percent}%${formatUploadDetail(info)}`);
      });
      progressBar.style.width = '100%';
      showToast(editingId ? 'Resource updated.' : 'Resource published.', 'success');
      clearUploadForm();
      await Promise.all([loadDashboard(), loadResources(), loadCatalog()]);
      // Retain a simple local status for keyboard/screen-reader users after
      // the form resets, without relying only on the transient toast.
      setStatus($('#caUploadStatus'), result && result.resource ? 'Saved successfully.' : 'Saved successfully.', 'success');
    } catch (err) {
      setStatus(status, err.message || 'Could not save the resource.', 'error');
      showToast(err.message || 'Could not save the resource.', 'error');
    } finally {
      submit.disabled = false;
      progress.style.display = 'none';
      progress.setAttribute('aria-hidden', 'true');
    }
  }

  function startEdit(id) {
    const resource = state.resources.find((item) => item.id === id);
    if (!resource) return;
    state.editingId = resource.id;
    $('#caEditingResourceId').value = resource.id;
    $('#caResourceType').value = resource.resourceTypeKey || 'document';
    updateTypeControls();
    populateProgramOptions(resource.programCode || '');
    renderCourses(resource.programCode || '', resource.courseId || '');
    $('#caTopic').value = resource.topic || '';
    $('#caTitle').value = resource.title || '';
    $('#caDescription').value = resource.description || '';
    $('#caYearLevel').value = resource.yearLevel || '';
    $('#caTerm').value = resource.semester || '';
    $('#caPublishStatus').value = resource.publishStatus || 'published';
    $('#caFile').required = false;
    $('#caFile').value = '';
    $('#caUploadHeading').textContent = 'Edit Resource';
    $('#caUploadSubmitBtn').textContent = 'Save Changes';
    $('#caCancelEditBtn').hidden = false;
    $('#caFileDropTitle').innerHTML = 'Replace resource file <span style="font-weight:400;color:var(--muted);">(optional)</span>';
    // Restore Drive-backed file info when editing an existing resource.
    const hasDriveFile = Boolean(resource.googleDriveFileId);
    $('#caGoogleDriveFileId').value = resource.googleDriveFileId || '';
    $('#caGoogleDriveUrl').value = resource.googleDriveUrl || '';
    $('#caGoogleDriveFileName').value = resource.fileName || '';
    $('#caGoogleDriveMimeType').value = resource.mimeType || '';
    $('#caGoogleDriveFileSize').value = resource.fileSize || 0;
    if (hasDriveFile) {
      $('#caFileName').textContent = `Current file: ${resource.fileName || 'Google Drive Document'}${resource.fileSize ? ` (${fileSize(resource.fileSize)})` : ''}`;
      $('#caFileDropTitle').innerHTML = 'Drive file selected <span style="font-weight:400;color:var(--muted);">(optional — replace with file upload)</span>';
    }
    setFile(null, { currentName: resource.fileName, currentSize: resource.fileSize });
    setStatus($('#caUploadStatus'), 'Editing your resource. Only choose a file if you want to replace it.');
    setNavActive('upload');
    document.getElementById('upload').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function deleteResource(id) {
    const resource = state.resources.find((item) => item.id === id);
    const name = resource ? resource.title : 'this resource';
    if (!window.confirm(`Delete “${name}”? This cannot be undone.`)) return;
    try {
      await StudyCoreAPI.contentAdminDeleteResource(id);
      if (state.editingId === id) clearUploadForm();
      showToast('Resource deleted.', 'success');
      await Promise.all([loadDashboard(), loadResources(), loadCatalog()]);
    } catch (err) {
      showToast(err.message || 'Could not delete the resource.', 'error');
    }
  }

  async function submitProfile(event) {
    event.preventDefault();
    const name = $('#caProfileName').value.trim();
    const email = $('#caProfileEmail').value.trim();
    const status = $('#caProfileStatus');
    if (!name || !email) {
      setStatus(status, 'Enter your full name and email.', 'error');
      return;
    }
    const button = $('#caProfileSaveBtn');
    button.disabled = true;
    setStatus(status, 'Saving profile…');
    try {
      const data = await StudyCoreAPI.updateProfile({ name, email });
      renderProfile(data.user);
      setStatus(status, 'Profile saved.', 'success');
      showToast('Profile updated.', 'success');
    } catch (err) {
      setStatus(status, err.message || 'Could not save your profile.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  function bindEvents() {
    $('#caLogoutBtn').addEventListener('click', StudyCoreAuth.logoutUser);
    $('#caMobileLogoutBtn').addEventListener('click', StudyCoreAuth.logoutUser);
    $('#caMenuToggle').addEventListener('click', () => {
      const menu = $('#caMobileNav');
      const open = !menu.classList.contains('open');
      menu.classList.toggle('open', open);
      menu.setAttribute('aria-hidden', String(!open));
      $('#caMenuToggle').setAttribute('aria-expanded', String(open));
      $('#caMenuToggle').setAttribute('aria-label', open ? 'Close Content Admin navigation' : 'Open Content Admin navigation');
      $('#caMenuToggle').innerHTML = icon(open ? 'x' : 'menu', 21);
    });

    document.querySelectorAll('[data-ca-nav]').forEach((link) => link.addEventListener('click', () => {
      setNavActive(link.getAttribute('data-ca-nav'));
      closeMobileNav();
    }));
    $('#caHeroUploadBtn').addEventListener('click', () => setNavActive('upload'));
    $('#caUploadsNewBtn').addEventListener('click', () => {
      clearUploadForm();
      setNavActive('upload');
    });

    $('#caProfileForm').addEventListener('submit', submitProfile);
    $('#caUploadForm').addEventListener('submit', submitUpload);
    $('#caCancelEditBtn').addEventListener('click', clearUploadForm);
    $('#caResourceType').addEventListener('change', updateTypeControls);
    $('#caSchoolFaculty').addEventListener('change', () => {
      renderCourses($('#caSchoolFaculty').value, '');
      $('#caTopic').value = '';
    });
    $('#caCourse').addEventListener('change', () => renderTopicSuggestions($('#caCourse').value));

    const fileInput = $('#caFile');
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) {
        // If selecting a regular file upload, clear any previous Drive selection
        // so the server does not treat this as a Drive-backed resource.
        $('#caGoogleDriveFileId').value = '';
        $('#caGoogleDriveUrl').value = '';
        $('#caGoogleDriveFileName').value = '';
        $('#caGoogleDriveMimeType').value = '';
        $('#caGoogleDriveFileSize').value = '';
        $('#caFileDropTitle').innerHTML = 'Choose a resource file <span class="ca-required">*</span>';
      }
      setFile(file);
    });
    const fileDrop = $('#caFileDrop');
    ['dragenter', 'dragover'].forEach((type) => fileDrop.addEventListener(type, (event) => {
      event.preventDefault();
      fileDrop.classList.add('dragging');
    }));
    ['dragleave', 'drop'].forEach((type) => fileDrop.addEventListener(type, (event) => {
      event.preventDefault();
      fileDrop.classList.remove('dragging');
    }));
    fileDrop.addEventListener('drop', (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) setFile(file);
    });

    ['dashboard', 'profile', 'upload', 'uploads', 'quizzes'].forEach((id) => {
      const section = document.getElementById(id);
      if (!section || !('IntersectionObserver' in window)) return;
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setNavActive(id);
        });
      }, { rootMargin: '-22% 0px -68% 0px', threshold: 0 });
      observer.observe(section);
    });
  }

  function mountContentQuiz() {
    const mount = document.getElementById('contentQuizMount');
    if (!mount || !window.StudyCoreQuizAdmin) return;
    const flatten = (programs) => {
      const out = [];
      (programs || []).forEach((p) => (p.courses || []).forEach((c) => out.push({ id: c.id, code: c.code, name: c.name })));
      return out;
    };
    StudyCoreQuizAdmin.mount(mount, {
      role: 'content_admin',
      getPrograms: () => StudyCoreAPI.contentAdminCatalog().then((d) => (d.programs || []).map((p) => ({ code: p.code, name: p.name }))),
      loadCourses: () => StudyCoreAPI.contentAdminCatalog().then((d) => flatten(d.programs))
    }).catch(() => {});
  }

  async function init() {
    const currentUser = await StudyCoreAuth.fetchSession();
    if (!currentUser || !StudyCoreAuth.isContentAdmin(currentUser)) {
      window.location.replace(currentUser ? StudyCoreAuth.getDashboardPage(currentUser) : '/login.html');
      return;
    }

    $('#caLogoutBtn').innerHTML = `${icon('log-out', 17)}<span>Logout</span>`;
    $('#caLogoutBtn').setAttribute('aria-label', 'Log out');
    $('#caMenuToggle').innerHTML = icon('menu', 21);
    $('#caTotalIcon').innerHTML = icon('library', 22);
    $('#caPublishedIcon').innerHTML = icon('check-circle', 22);
    $('#caDraftIcon').innerHTML = icon('clock', 22);
    $('#caAccountUserIcon').innerHTML = icon('user', 18);
    $('#caAccountRoleIcon').innerHTML = icon('shield', 18);
    $('#caAccountScopeIcon').innerHTML = icon('lock', 18);
    $('#caFileIcon').innerHTML = icon('upload', 21);
    bindEvents();
    updateTypeControls();

    try {
      await Promise.all([loadCatalog(), loadDashboard(), loadResources()]);
    } catch (err) {
      showToast(err.message || 'Could not load your Content Admin workspace.', 'error');
      setStatus($('#caUploadStatus'), 'Some dashboard data could not be loaded. Refresh and try again.', 'error');
    }

    mountContentQuiz();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
