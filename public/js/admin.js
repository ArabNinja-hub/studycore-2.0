// =============================================
// STUDYCORE — Admin Dashboard (js/admin.js)
// -----------------------------------------------
// Runs only on views/admin.html, which the server
// already refuses to send to anyone whose session
// isn't role=ADMIN (middleware/auth.js
// requirePageAuth). Everything below talks to the
// real endpoints in routes/admin.routes.js.
// =============================================

(function () {
  'use strict';

  let selectedFile = null;
  // A file chosen through "Select from Google Drive". Google Drive is the
  // admin's SOURCE LIBRARY: the server copies the picked file into StudyCore
  // storage at publish time using `accessToken`, and students then read it
  // from StudyCore like any other document. Nothing is ever written back to
  // Drive, and an ordinary upload (`selectedFile`) never touches Drive.
  let selectedDriveFile = null; // { id, name, url, mimeType, sizeBytes, accessToken }
  let editingResourceId = null;
  let editingAnnouncementId = null;
  let currentFilters = { search: '', category: '', sort: 'newest', program: '' };
  let resourceFormControls = null;
  let announcementTargetControls = null;

  const $ = (sel) => document.querySelector(sel);
  const CATEGORY_LABELS = { document: 'Notes', video: 'Video', tutorial: 'Tutorial', past_paper: 'Past paper', lab_report: 'Lab report', quiz: 'Quiz', assignment: 'Assignment', announcement: 'Announcement' };
  const CATEGORY_ICONS = { document: 'file-text', video: 'video', tutorial: 'file-text', past_paper: 'file', lab_report: 'flask', quiz: 'circle-help', assignment: 'edit', announcement: 'bell' };

  function setResourceFormStatus(message, kind) {
    const status = document.getElementById('resourceFormStatus');
    if (!status) return;
    status.textContent = message || '';
    status.style.color = kind === 'error' ? 'var(--red-600)' : kind === 'success' ? 'var(--green-600)' : 'var(--muted)';
  }

  function categoryFieldVisibility() {
    const category = document.getElementById('resCategory').value;
    document.getElementById('resDueDateGroup').style.display = category === 'assignment' ? 'block' : 'none';
    document.getElementById('resQuizGroup').style.display = category === 'quiz' ? 'block' : 'none';
    document.getElementById('resQuizData').required = category === 'quiz';
    document.getElementById('resPinned').parentElement.style.display = category === 'announcement' ? 'flex' : 'none';

    const isVideo = category === 'video';
    // Notes, tutorial sheets and videos are shelved by term on the course
    // page, so the term is required for those. Past papers (filed by year),
    // lab reports, quizzes, assignments and announcements are term-exempt.
    const needsTerm = termAppliesTo(category);
    const termSelect = document.getElementById('resSemester');
    termSelect.required = needsTerm;
    const termGroup = document.getElementById('resSemesterGroup');
    if (termGroup) termGroup.style.display = needsTerm ? 'block' : 'none';
    if (!needsTerm) termSelect.value = '';
    document.getElementById('resSemesterRequired').textContent = needsTerm ? '*' : '';
    const termHelp = document.getElementById('resSemesterHelp');
    termHelp.style.display = needsTerm ? 'block' : 'none';
    termHelp.textContent = isVideo
      ? 'Students browse video lessons term by term, so every video needs a term.'
      : `Students open ${(CATEGORY_LABELS[category] || 'this resource').toLowerCase()}s under Term 1, Term 2 or Term 3 on the course page.`;

    // Past papers, notes and tutorial sheets are free for everyone; lab
    // reports are the premium study material. Show the admin which rule
    // applies instead of offering a toggle the server will overrule.
    const freeToggle = document.getElementById('resIsFree');
    const freeRow = document.getElementById('resIsFreeRow');
    const policyNote = document.getElementById('resAccessPolicyNote');
    const policyManaged = isAlwaysFreeCategory(category) || isTrialPremiumCategory(category);
    if (freeRow) freeRow.style.display = policyManaged ? 'none' : 'flex';
    if (freeToggle && policyManaged) freeToggle.checked = isAlwaysFreeCategory(category);
    if (policyNote) {
      policyNote.style.display = policyManaged ? 'block' : 'none';
      policyNote.textContent = isAlwaysFreeCategory(category)
        ? `${CATEGORY_LABELS[category] || 'This resource'} is always free — students keep it after a trial or subscription ends.`
        : isTrialPremiumCategory(category)
          ? 'Lab reports are Premium study material — open during a trial and for Premium members.'
          : '';
    }

    const courseLabel = document.querySelector('label[for="resCourseSelect"]');
    if (courseLabel) courseLabel.innerHTML = isVideo
      ? 'Course (required for videos)'
      : 'Course (attach to a program course)';
    const courseSelect = document.getElementById('resCourseSelect');
    // Do not make this a native required control: doing so would prevent the
    // submit handler from running and the admin would not get the reason a
    // video is missing from the course library. validateResourceForm() below
    // gives an actionable message instead.
    courseSelect.setAttribute('aria-required', isVideo ? 'true' : 'false');

    const fileInput = document.getElementById('fileInput');
    if (category === 'video') fileInput.setAttribute('accept', '.mp4,.m4v,.mov,.webm,.mkv,.avi,video/*');
    else fileInput.setAttribute('accept', '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.csv,.zip,.rar,.jpg,.jpeg,.png,.gif,.webp');
  }

  function resetResourceForm() {
    editingResourceId = null;
    selectedFile = null;
    clearDriveSelection();
    document.getElementById('resourceForm').reset();
    // The file input lives in the drop zone rather than inside the metadata
    // form, so form.reset() does not clear it. Clearing it also lets an admin
    // select the same video again after a failed or completed upload.
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
    document.getElementById('resourceId').value = '';
    document.getElementById('fileChosenLabel').textContent = '';
    document.getElementById('uploadProgressWrap').style.display = 'none';
    document.getElementById('uploadFormTitle').textContent = 'Upload a new resource';
    document.getElementById('resourceSubmitBtn').textContent = 'Publish Resource';
    document.getElementById('resourceCancelEditBtn').style.display = 'none';
    setResourceFormStatus('');
    // Reset program/course selects and targeting to "All Programs".
    if (resourceFormControls) {
      resourceFormControls.setProgram('');
      resourceFormControls.setCourse('');
    }
    const targetingSlot = document.getElementById('resTargetPrograms');
    if (targetingSlot && window.SCAdminPrograms) {
      targetingSlot.innerHTML = SCAdminPrograms.targetingCheckboxesHtml('resTargetChecks', [], true);
      SCAdminPrograms.wireTargetingBehavior(targetingSlot);
    }
    categoryFieldVisibility();
  }

  function validateResourceForm(category) {
    const title = document.getElementById('resTitle').value.trim();
    if (!title) return 'Add a title before publishing this resource.';

    // A video without a course can be written to the database, but it has no
    // route into the program course/video pages. The old subject field is
    // retained for legacy uploads; new Main Admin video uploads must use the
    // current Program → Course path so a successful upload is actually
    // visible to students.
    if (category === 'video' && !editingResourceId) {
      const courseId = resourceFormControls ? resourceFormControls.getCourseId() : '';
      if (!courseId) return 'Select a program course for this video. Videos without a course are not shown in Video Lessons.';
      if (selectedDriveFile) return 'Video lessons are published to Bunny Stream. Upload the video file directly instead of selecting it from Google Drive.';
      if (!selectedFile) return 'Choose the video file before publishing.';
    }

    // Anything shelved by term on the course page needs a term, but only once
    // it is attached to a course — a general, library-wide upload has no term
    // shelf to land on. This mirrors termRequiredFor() on the server.
    if (termAppliesTo(category)) {
      const courseId = resourceFormControls ? resourceFormControls.getCourseId() : '';
      if (courseId && !document.getElementById('resSemester').value) {
        const label = (CATEGORY_LABELS[category] || 'this resource').toLowerCase();
        return `Choose Term 1, Term 2, or Term 3 so students find this ${label} under the right term.`;
      }
    }
    return null;
  }

  function notifyAnnouncementChange() {
    if (window.SCLayout && window.SCLayout.refreshNotifications) {
      window.SCLayout.refreshNotifications();
    }
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        const bc = new BroadcastChannel('studycore_notifications');
        bc.postMessage({ type: 'NOTIFICATIONS_UPDATED', timestamp: Date.now() });
        bc.close();
      }
    } catch {}
    try { localStorage.setItem('sc_notifs_synced_at', String(Date.now())); } catch {}
  }

  function resetAnnouncementForm() {
    editingAnnouncementId = null;
    document.getElementById('announcementForm').reset();
    document.getElementById('annId').value = '';
    document.getElementById('announcementSubmitBtn').textContent = 'Post Announcement';
  }

  function editAnnouncement(r) {
    editingAnnouncementId = r.id;
    document.getElementById('annId').value = r.id;
    document.getElementById('annTitle').value = r.title;
    document.getElementById('annMessage').value = r.description || '';
    document.getElementById('annPinned').checked = Boolean(r.pinned);
    if (announcementTargetControls && window.SCAdminPrograms) {
      announcementTargetControls.set(r.targetAll, r.targetPrograms || []);
    }
    document.getElementById('announcementSubmitBtn').textContent = 'Save Changes';
    document.getElementById('announcementForm').scrollIntoView({ behavior: 'smooth' });
  }

  async function submitAnnouncementForm(e) {
    e.preventDefault();
    const title = document.getElementById('annTitle').value.trim();
    const message = document.getElementById('annMessage').value.trim();
    const pinned = document.getElementById('annPinned').checked;
    if (!title) { showToast('Please add a title for the announcement.', 'error'); return; }

    const fd = new FormData();
    fd.append('title', title);
    fd.append('description', message);
    fd.append('category', 'announcement');
    fd.append('publishStatus', 'published');
    fd.append('isPremium', 'false');
    fd.append('pinned', pinned ? 'true' : 'false');
    // Program targeting: All Students or specific program(s).
    const annSlot = document.getElementById('annTargetPrograms');
    if (annSlot && window.SCAdminPrograms) {
      const t = SCAdminPrograms.readTargeting(annSlot);
      fd.append('targetAll', t.targetAll ? 'true' : 'false');
      fd.append('programs', t.programs.join(','));
    } else {
      fd.append('targetAll', 'true');
    }

    const btn = document.getElementById('announcementSubmitBtn');
    btn.disabled = true;
    try {
      const url = editingAnnouncementId ? `/api/admin/resources/${editingAnnouncementId}` : '/api/admin/resources';
      const method = editingAnnouncementId ? 'PUT' : 'POST';
      const res = await fetch(url, { method, credentials: 'include', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Could not save announcement.');
      showToast(editingAnnouncementId ? 'Announcement updated.' : 'Announcement posted.', 'success');
      resetAnnouncementForm();
      loadResourceTable();
      loadAnalytics();
      notifyAnnouncementChange();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /* ── "Select from Google Drive" ───────────
     Google Drive is the SOURCE LIBRARY for documents, never StudyCore's
     storage. Picking a file here records its id + the Picker's short-lived
     OAuth token; on publish the server copies the bytes into StudyCore
     storage and the resource is served by the normal, access-gated
     StudyCore document viewer. The admin's Drive file is left untouched and
     students are never shown Drive. */

  function driveSelectionLabel() {
    return document.getElementById('fileChosenLabel');
  }

  function clearDriveSelection() {
    selectedDriveFile = null;
    const btn = document.getElementById('caSelectDriveBtn');
    if (btn) btn.textContent = 'Select from Google Drive';
  }

  // Called by /js/google-picker.js once the admin picks a file in the Picker.
  window.onGoogleDriveFilePicked = function (doc, auth) {
    if (!doc || !doc.id) return;
    // A Drive pick and a direct upload are mutually exclusive: the last one
    // chosen wins, so the admin always publishes the file they just selected.
    selectedFile = null;
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';

    selectedDriveFile = {
      id: doc.id,
      name: doc.name || 'Google Drive Document',
      url: doc.url || ('https://drive.google.com/file/d/' + doc.id + '/view'),
      mimeType: doc.mimeType || '',
      sizeBytes: Number(doc.sizeBytes) || 0,
      accessToken: (auth && auth.accessToken) || null
    };

    const label = driveSelectionLabel();
    if (label) {
      const size = selectedDriveFile.sizeBytes
        ? ' (' + (selectedDriveFile.sizeBytes / (1024 * 1024)).toFixed(2) + ' MB)'
        : '';
      label.textContent = 'From Google Drive: ' + selectedDriveFile.name + size;
    }
    const btn = document.getElementById('caSelectDriveBtn');
    if (btn) btn.textContent = 'Change Google Drive file';
    setResourceFormStatus(
      String(selectedDriveFile.mimeType).indexOf('application/vnd.google-apps.') === 0
        ? 'This Google Doc stays in your Google Drive. When you publish, StudyCore registers it and serves students the PDF through its protected viewer.'
        : 'This file stays in your Google Drive. When you publish, StudyCore registers it and streams it to students through its protected viewer — your Drive copy is not moved or changed.'
    );
  };

  /* ── Upload dropzone ────────────────────── */
  function bindDropZone() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const label = document.getElementById('fileChosenLabel');

    function chooseFile(file) {
      // A direct upload is a plain StudyCore upload — it is never sent to
      // Google Drive — and it supersedes any earlier Drive selection.
      if (file) clearDriveSelection();
      selectedFile = file;
      label.textContent = file ? `Selected: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)` : '';
    }

    // The dashed border is on the shell, so that is what highlights while a
    // file is dragged over it. Binding the drag events to the shell too means
    // the whole padded box is a drop target, not just the inner column.
    const shell = document.getElementById('dropZoneShell') || dropZone;

    dropZone.addEventListener('click', (event) => {
      // The hidden input is inside the clickable drop zone. Stop its
      // programmatic click from bubbling back to this handler, which can
      // otherwise reopen the picker recursively in some browsers.
      if (event.target !== fileInput) fileInput.click();
    });
    fileInput.addEventListener('click', (event) => event.stopPropagation());
    fileInput.addEventListener('change', (e) => chooseFile(e.target.files[0]));

    ['dragenter', 'dragover'].forEach((evt) => shell.addEventListener(evt, (e) => {
      e.preventDefault();
      shell.classList.add('is-dragging');
    }));
    ['dragleave', 'drop'].forEach((evt) => shell.addEventListener(evt, (e) => {
      e.preventDefault();
      shell.classList.remove('is-dragging');
    }));
    shell.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files[0];
      if (file) chooseFile(file);
    });
  }

  function buildFormData() {
    const fd = new FormData();
    fd.append('title', document.getElementById('resTitle').value.trim());
    fd.append('description', document.getElementById('resDescription').value.trim());
    fd.append('category', document.getElementById('resCategory').value);
    fd.append('subject', document.getElementById('resSubject').value);
    const courseEl = document.getElementById('resCourse');
    if (courseEl) fd.append('course', courseEl.value.trim());
    // Dynamic program course (Program → Course content targeting).
    if (resourceFormControls) {
      fd.append('courseId', resourceFormControls.getCourseId() || '');
    }
    // Program targeting (one / several / all programs).
    const targetingSlot = document.getElementById('resTargetPrograms');
    if (targetingSlot && window.SCAdminPrograms) {
      const t = SCAdminPrograms.readTargeting(targetingSlot);
      fd.append('targetAll', t.targetAll ? 'true' : 'false');
      fd.append('programs', t.programs.join(','));
    } else {
      fd.append('targetAll', 'true');
    }
    fd.append('topic', document.getElementById('resTopic').value.trim());
    fd.append('yearLevel', document.getElementById('resYear').value.trim());
    fd.append('semester', document.getElementById('resSemester').value.trim());
    fd.append('tags', document.getElementById('resTags').value.trim());
    fd.append('dueDate', document.getElementById('resDueDate').value);
    fd.append('quizData', document.getElementById('resQuizData').value.trim());
    fd.append('publishStatus', document.getElementById('resPublishStatus').value);
    fd.append('isPremium', document.getElementById('resIsFree').checked ? 'false' : 'true');
    fd.append('pinned', document.getElementById('resPinned').checked ? 'true' : 'false');
    if (selectedFile) fd.append('file', selectedFile);
    else if (selectedDriveFile) {
      // The server imports the bytes from Drive once, with this short-lived
      // token, and stores them in StudyCore. The token is never persisted.
      fd.append('google_drive_file_id', selectedDriveFile.id);
      fd.append('google_drive_url', selectedDriveFile.url || '');
      fd.append('file_name', selectedDriveFile.name || '');
      fd.append('mime_type', selectedDriveFile.mimeType || '');
      if (selectedDriveFile.accessToken) {
        fd.append('google_drive_access_token', selectedDriveFile.accessToken);
      }
    }
    return fd;
  }

  // A bare percentage stalls visibly on a slow uplink and reads as "frozen".
  // Showing live speed and a time estimate is what tells an admin on mobile
  // data that the upload is working and roughly how long to keep the tab open.
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

  async function submitResourceForm(e) {
    e.preventDefault();
    const category = document.getElementById('resCategory').value;
    const validationError = validateResourceForm(category);
    if (validationError) {
      setResourceFormStatus(validationError, 'error');
      showToast(validationError, 'error');
      return;
    }
    const quizRaw = document.getElementById('resQuizData').value.trim();
    if (category === 'quiz') {
      try { JSON.parse(quizRaw); } catch {
        const message = 'Quiz questions must be valid JSON.';
        setResourceFormStatus(message, 'error');
        showToast(message, 'error');
        return;
      }
    }

    const fd = buildFormData();
    const progressWrap = document.getElementById('uploadProgressWrap');
    const progressBar = document.getElementById('uploadProgressBar');
    const progressText = document.getElementById('uploadProgressText');
    const submitBtn = document.getElementById('resourceSubmitBtn');
    submitBtn.disabled = true;

    if (selectedFile) {
      progressWrap.style.display = 'block';
      progressBar.style.width = '0%';
      progressText.textContent = 'Uploading… 0%';
      setResourceFormStatus('Uploading file…');
    } else if (selectedDriveFile) {
      setResourceFormStatus('Registering "' + selectedDriveFile.name + '" from your Google Drive…');
    } else {
      setResourceFormStatus(editingResourceId ? 'Saving changes…' : 'Publishing resource…');
    }

    const chosenFile = selectedFile;
    try {
      const url = editingResourceId ? `/api/admin/resources/${editingResourceId}` : '/api/admin/resources';
      const method = editingResourceId ? 'PUT' : 'POST';
      const onTick = (pct, info) => {
        progressBar.style.width = `${pct}%`;
        const label = info && info.resumed ? 'Resuming upload' : 'Uploading';
        progressText.textContent = `${label}… ${pct}%${formatUploadDetail(info)}`;
      };

      let result;
      // Large files use resumable chunks: a dropped connection or a phone
      // that sleeps then pauses the upload instead of discarding every byte
      // already sent. See StudyCoreAPI.uploadResumable in js/api.js.
      if (chosenFile && chosenFile.size >= StudyCoreAPI.RESUMABLE_THRESHOLD_BYTES) {
        const { sessionId } = await StudyCoreAPI.uploadResumable(chosenFile, onTick);
        progressBar.style.width = '100%';
        progressText.textContent = 'Finishing up — saving the resource…';
        result = await StudyCoreAPI.completeResumableUpload(url, method, fd, sessionId);
        StudyCoreAPI.forgetResumableSession(chosenFile);
      } else {
        result = await StudyCoreAPI.uploadWithProgress(url, method, fd, onTick);
      }
      const successMessage = editingResourceId ? 'Resource updated.' : 'Resource published.';
      showToast(successMessage, 'success');
      if (result && result.warning) showToast(result.warning, 'info');
      resetResourceForm();
      setResourceFormStatus(`${successMessage} It is now listed in Manage resources.`, 'success');
      // A category/program/search filter can otherwise make a successful new
      // upload appear to vanish. Clear the table filters and wait for the
      // fresh response so the just-published resource is visible immediately.
      currentFilters = { search: '', category: '', sort: 'newest', program: '' };
      const search = document.getElementById('adminSearch');
      const categoryFilter = document.getElementById('adminCategoryFilter');
      const sort = document.getElementById('adminSort');
      if (search) search.value = '';
      if (categoryFilter) categoryFilter.value = '';
      if (sort) sort.value = 'newest';
      renderProgramFilterChips();
      await loadResourceTable();
      loadAnalytics();
      loadTopicSuggest();
      if (window.SCAdminPrograms) SCAdminPrograms.loadPrograms();
      notifyAnnouncementChange();
    } catch (err) {
      // A paused chunked upload keeps everything it already sent, so the
      // message has to invite a retry rather than imply the work is lost.
      const message = err && err.resumable
        ? `${err.message} Choose the same file again to continue from where it stopped.`
        : err.message;
      setResourceFormStatus(message, 'error');
      showToast(message, 'error');
    } finally {
      submitBtn.disabled = false;
      progressWrap.style.display = 'none';
    }
  }

  function editResource(r) {
    editingResourceId = r.id;
    selectedFile = null;
    // Editing shows the CURRENT file. Any previous Drive pick is dropped so a
    // metadata-only save never re-imports from Drive (the token is gone too).
    clearDriveSelection();
    document.getElementById('resourceId').value = r.id;
    document.getElementById('resCategory').value = r.category;
    document.getElementById('resTitle').value = r.title;
    document.getElementById('resDescription').value = r.description || '';
    document.getElementById('resSubject').value = r.subject || '';
    document.getElementById('resCourse').value = r.course || '';
    document.getElementById('resTopic').value = r.topic || '';
    document.getElementById('resYear').value = r.yearLevel || '';
    document.getElementById('resSemester').value = r.semester || '';
    document.getElementById('resTags').value = (r.tags || []).join(', ');
    document.getElementById('resDueDate').value = (r.dueDate || '').slice(0, 10);
    document.getElementById('resQuizData').value = r.quizData ? JSON.stringify(r.quizData) : '';
    document.getElementById('resPublishStatus').value = r.publishStatus;
    document.getElementById('resIsFree').checked = !r.isPremium;
    document.getElementById('resPinned').checked = Boolean(r.pinned);
    document.getElementById('fileChosenLabel').textContent = r.hasFile ? `Current file: ${r.fileName} (${formatFileSize(r.fileSize)}) — choose a new file to replace it` : '';

    // Program/course placement + targeting.
    if (window.SCAdminPrograms && resourceFormControls) {
      // Find the course's owning program from the flattened catalog.
      if (r.courseId) {
        const owner = SCAdminPrograms.globalCourses.find((c) => c.id === r.courseId);
        if (owner) resourceFormControls.setProgram(owner.programCode || '');
        resourceFormControls.setCourse(r.courseId);
      } else {
        resourceFormControls.setProgram('');
        resourceFormControls.setCourse('');
      }
      const targetingSlot = document.getElementById('resTargetPrograms');
      if (targetingSlot) {
        targetingSlot.innerHTML = SCAdminPrograms.targetingCheckboxesHtml('resTargetChecks', r.targetPrograms || [], r.targetAll);
        SCAdminPrograms.wireTargetingBehavior(targetingSlot);
      }
    }

    document.getElementById('uploadFormTitle').textContent = 'Edit resource';
    document.getElementById('resourceSubmitBtn').textContent = 'Save Changes';
    document.getElementById('resourceCancelEditBtn').style.display = '';
    categoryFieldVisibility();
    document.getElementById('resourceForm').scrollIntoView({ behavior: 'smooth' });
  }

  async function deleteResource(id) {
    if (!confirm('Delete this resource permanently? This cannot be undone.')) return;
    try {
      await StudyCoreAPI.adminDeleteResource(id);
      showToast('Resource deleted.', 'success');
      loadResourceTable();
      loadAnalytics();
      notifyAnnouncementChange();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function togglePublish(btn) {
    const id = btn.getAttribute('data-toggle-publish');
    const current = btn.getAttribute('data-current-status');
    const next = current === 'published' ? 'draft' : 'published';
    const fd = new FormData();
    fd.append('publishStatus', next);
    try {
      const res = await fetch(`/api/admin/resources/${id}`, { method: 'PUT', credentials: 'include', body: fd });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Update failed.');
      }
      showToast(`Marked as ${next}.`, 'success');
      loadResourceTable();
      notifyAnnouncementChange();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  /* ── Analytics ──────────────────────────── */
  async function loadAnalytics() {
    const target = document.getElementById('adminAnalytics');
    try {
      const a = await StudyCoreAPI.adminAnalytics();
      const stat = (icon, label, value, sub) => `
        <div class="card dash-stat span-3">
          <span class="card-icon" style="width:46px;height:46px;">${SC.icon(icon, { size: 21 })}</span>
          <div><div class="stat-value">${value}</div><div class="stat-label">${label}</div>${sub ? `<div style="font-size:0.72rem;color:var(--muted);">${sub}</div>` : ''}</div>
        </div>`;
      const topList = (items, field, label) => items.length
        ? items.map((p) => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:0.85rem;padding:5px 0;border-bottom:1px solid var(--border);"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.title)}</span><strong style="flex-shrink:0;">${p[field]}</strong></div>`).join('')
        : `<p style="font-size:0.85rem;">None yet.</p>`;
      target.innerHTML = `
        ${stat('library', 'Total uploads', a.totalResources, `${a.publishedResources} published`)}
        ${stat('download', 'Downloads', a.totalDownloads, `${a.totalViews} views`)}
        ${stat('users', 'Users', a.totalUsers, `${a.premiumStudents} premium students`)}
        ${stat('shield', 'Content Admins', a.totalContentAdmins || 0, `${a.activeContentAdmins || 0} active · ${a.contentAdminResources || 0} uploads`)}
        ${stat('wallet', 'Revenue', `K${a.revenue}`, 'confirmed subscriptions')}
        <div class="card dash-section span-4">
          <div class="dash-section-head"><h3 style="font-size:1rem;">Most downloaded</h3></div>
          ${topList(a.popular, 'download_count', 'dl')}
        </div>
        <div class="card dash-section span-4">
          <div class="dash-section-head"><h3 style="font-size:1rem;">Most viewed</h3></div>
          ${topList(a.mostViewed, 'view_count', 'views')}
        </div>
        <div class="card dash-section span-4">
          <div class="dash-section-head"><h3 style="font-size:1rem;">Recent activity</h3></div>
          ${a.recentActivity.length ? a.recentActivity.map((r) => `<div style="font-size:0.82rem;padding:5px 0;border-bottom:1px solid var(--border);"><strong>${escapeHtml(r.student_name || 'Anonymous')}</strong> · ${escapeHtml(r.title)} · ${timeAgo(r.created_at)}</div>`).join('') : '<p style="font-size:0.85rem;">No activity yet.</p>'}
        </div>`;
    } catch (err) {
      target.innerHTML = `<p style="color:var(--red-600);grid-column:1/-1;">${escapeHtml(err.message)}</p>`;
    }
  }

  /* ── Program filter chips (ALL | LAW | BUSINESS | SNR | MINES | NON-QUOTA | SICT | BUILT ENVIRONMENT) ── */
  function renderProgramFilterChips() {
    if (!window.SCAdminPrograms) return;
    SCAdminPrograms.renderFilterChips(currentFilters.program || '', (code) => {
      currentFilters.program = code;
      renderProgramFilterChips();
      loadResourceTable();
      loadUsers();
    });
  }

  /* ── Resource table ─────────────────────── */
  function renderAdminToolbar() {
    const t = document.getElementById('adminToolbar');
    t.innerHTML = `
      <input type="search" id="adminSearch" placeholder="Search by title or keyword…" style="flex:1;min-width:200px;padding:10px 14px;border-radius:10px;border:1.5px solid var(--border-strong);background:var(--card);" />
      <select id="adminCategoryFilter" style="padding:10px 14px;border-radius:10px;border:1.5px solid var(--border-strong);background:var(--card);">
        <option value="">All categories</option>
        <option value="document">Notes</option>
        <option value="video">Video</option>
        <option value="tutorial">Tutorial</option>
        <option value="past_paper">Past paper</option>
        <option value="lab_report">Lab report</option>
        <option value="announcement">Announcement</option>
        <option value="quiz">Quiz</option>
        <option value="assignment">Assignment</option>
      </select>
      <select id="adminSort" style="padding:10px 14px;border-radius:10px;border:1.5px solid var(--border-strong);background:var(--card);">
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="popular">Most viewed</option>
        <option value="title">Title A-Z</option>
      </select>`;
    let debounce;
    document.getElementById('adminSearch').addEventListener('input', (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { currentFilters.search = e.target.value; loadResourceTable(); }, 300);
    });
    document.getElementById('adminCategoryFilter').addEventListener('change', (e) => { currentFilters.category = e.target.value; loadResourceTable(); });
    document.getElementById('adminSort').addEventListener('change', (e) => { currentFilters.sort = e.target.value; loadResourceTable(); });
  }

  function courseCellLabel(r) {
    // Prefer the dynamic program course; fall back to legacy subject.
    if (window.SCAdminPrograms && r.courseId) {
      const c = SCAdminPrograms.globalCourses.find((x) => x.id === r.courseId);
      if (c) return { text: `${c.code} — ${c.name}`, title: c.name };
    }
    return { text: r.subject || '—', title: r.subject || '' };
  }

  async function loadResourceTable() {
    const tbody = document.getElementById('adminResourceTbody');
    tbody.innerHTML = '<tr><td colspan="10" style="color:var(--muted);">Loading…</td></tr>';
    try {
      const { resources } = await StudyCoreAPI.adminListResources({
        search: currentFilters.search || undefined,
        category: currentFilters.category || undefined,
        program: currentFilters.program || undefined,
        sort: currentFilters.sort
      });
      if (!resources.length) {
        tbody.innerHTML = '<tr><td colspan="10" style="color:var(--muted);padding:24px;text-align:center;">No resources match.</td></tr>';
        return;
      }
      tbody.innerHTML = resources.map((r) => {
        const cc = courseCellLabel(r);
        return `
        <tr>
          <td data-label="Title">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="color:var(--teal-600);display:inline-flex;">${SC.icon(CATEGORY_ICONS[r.category] || 'file', { size: 17 })}</span>
              <div style="min-width:0;">
                <strong style="color:var(--ink);display:block;overflow:hidden;text-overflow:ellipsis;max-width:min(260px, 100%);">${escapeHtml(r.title)}</strong>
                <span style="font-size:0.72rem;color:var(--muted);">${r.hasFile ? `${escapeHtml(r.fileName || '')} · ${formatFileSize(r.fileSize)}` : 'no file'}</span>
                ${r.visibilityWarning ? `<span style="display:block;font-size:0.72rem;color:var(--amber-600);margin-top:3px;">${SC.icon('alert-triangle', { size: 12 })} ${escapeHtml(r.visibilityWarning)}</span>` : ''}
              </div>
            </div>
          </td>
          <td data-label="Category">${escapeHtml(r.resourceType || CATEGORY_LABELS[r.category] || r.category)}</td>
          <td data-label="Uploader">
            <strong style="font-size:0.8rem;color:var(--ink);">${escapeHtml(r.uploaderName || 'Unattributed')}</strong>
            <span style="display:block;font-size:0.7rem;color:var(--muted);">${escapeHtml(r.uploaderRole === 'content_admin' ? 'Content Admin' : (r.uploaderRole === 'admin' ? 'Main Admin' : 'Legacy upload'))}</span>
          </td>
          <td data-label="Course / Subject">${escapeHtml(cc.text)}</td>
          <td data-label="Target">${window.SCAdminPrograms ? SCAdminPrograms.targetBadge(r) : ''}</td>
          <td data-label="Topic / Term">${escapeHtml(r.topic || '—')}${r.semester ? `<br><span style="font-size:0.72rem;color:var(--muted);">${escapeHtml(r.semester)}</span>` : ''}</td>
          <td data-label="Status">
            <button class="btn btn-ghost btn-sm" data-toggle-publish="${r.id}" data-current-status="${r.publishStatus}" style="color:${r.publishStatus === 'published' ? 'var(--green-600)' : 'var(--amber-600)'};">
              ${SC.icon(r.publishStatus === 'published' ? 'check-circle' : 'clock', { size: 14 })} ${r.publishStatus === 'published' ? 'Published' : 'Draft'}
            </button>
          </td>
          <td data-label="Access">${r.isPremium ? '<span class="badge badge-amber">Premium</span>' : '<span class="badge badge-green">Free</span>'}${r.pinned ? ' <span class="badge badge-neutral">Pinned</span>' : ''}</td>
          <td data-label="Views">${r.viewCount}</td>
          <td data-label="Actions">
            <div class="table-actions">
              ${['announcement', 'quiz'].includes(r.category) ? '' : `<button class="btn btn-outline btn-sm" data-edit="${r.id}">${SC.icon('edit', { size: 13 })} Edit</button>`}
              ${r.storageProvider === 'google_drive' || r.googleDriveFileId ? `<button class="btn btn-outline btn-sm" data-diagnose-drive="${r.id}">${SC.icon('search', { size: 13 })} Diagnose Drive</button>` : ''}
              ${r.category === 'announcement' ? `<button class="btn btn-ghost btn-sm" data-edit-ann="${r.id}">${SC.icon('bell', { size: 13 })}</button>` : ''}
              <button class="btn btn-ghost btn-sm" data-delete="${r.id}" style="color:var(--red-600);">${SC.icon('trash', { size: 13 })}</button>
            </div>
          </td>
        </tr>`;
      }).join('');

      tbody.querySelectorAll('[data-toggle-publish]').forEach((btn) => btn.addEventListener('click', () => togglePublish(btn)));
      tbody.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => editResource(resources.find((r) => r.id === btn.getAttribute('data-edit')))));
      tbody.querySelectorAll('[data-diagnose-drive]').forEach((btn) => btn.addEventListener('click', () => diagnoseDriveResource(btn)));
      tbody.querySelectorAll('[data-edit-ann]').forEach((btn) => btn.addEventListener('click', () => editAnnouncement(resources.find((r) => r.id === btn.getAttribute('data-edit-ann')))));
      tbody.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', () => deleteResource(btn.getAttribute('data-delete'))));
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="10" style="color:var(--red-600);">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  // Existing topic names feed the upload form's datalist
  let topicSuggestLoaded = false;
  async function loadTopicSuggest() {
    if (topicSuggestLoaded) return;
    topicSuggestLoaded = true;
    try {
      const { resources } = await StudyCoreAPI.adminListResources({});
      const topics = [...new Set(resources.map((r) => r.topic).filter(Boolean))].sort();
      document.getElementById('topicSuggest').innerHTML = topics.map((t) => `<option value="${escapeHtml(t)}">`).join('');
    } catch { /* non-fatal */ }
  }

  /* ── Google Drive (Integrations) ─────────── */
  function diagnosticValue(value) {
    if (value === null || value === undefined || value === '') return 'NOT REPORTED';
    if (value === true) return 'YES';
    if (value === false) return 'NO';
    return String(value);
  }

  function formatDriveDiagnostic(report) {
    const database = report.database || {};
    const viewer = report.viewer || {};
    const google = report.google || {};
    const connection = google.connection || {};
    const token = google.tokenInspection || {};
    const refresh = google.tokenRefresh || {};
    const metadata = google.metadataFilesGet || {};
    const media = google.mediaFilesGet || {};
    const ownership = google.ownership || {};
    const decisive = media.ok === false ? media : (metadata.ok === false ? metadata : media);
    const scopes = Array.isArray(token.scopes) ? token.scopes.join(' ') : '';

    return [
      'Google Drive production diagnostic (Main Admin only)',
      '',
      `HTTP STATUS: ${diagnosticValue(decisive && decisive.httpStatus)}`,
      `ERROR CODE: ${diagnosticValue(decisive && (decisive.errorReason || decisive.errorStatus || decisive.errorCode))}`,
      `ERROR MESSAGE: ${diagnosticValue(decisive && decisive.errorMessage)}`,
      `FILE ID: ${diagnosticValue(viewer.resolvedDriveFileId)}`,
      `AUTH ACCOUNT: ${diagnosticValue(token.authAccount || (google.accountInspection && google.accountInspection.authAccount) || connection.configuredAccount)}`,
      `TOKEN REFRESH: ${diagnosticValue(refresh.status)}`,
      '',
      `DATABASE FILE ID: ${diagnosticValue(database.storedDriveFileId)}`,
      `VIEWER PASSES DATABASE ID: ${diagnosticValue(viewer.passesStoredDriveFileId)}`,
      `STORAGE PROVIDER: ${diagnosticValue(database.storageProvider)}`,
      `ACCESS TOKEN VALID: ${diagnosticValue(token.valid)}`,
      `REFRESH TOKEN EXISTS: ${diagnosticValue(connection.refreshToken && connection.refreshToken.exists)}`,
      `REFRESH TOKEN SOURCE: ${diagnosticValue(connection.refreshToken && connection.refreshToken.selectedSource)}`,
      `REFRESH TOKEN DECRYPTABLE: ${diagnosticValue(connection.refreshToken && connection.refreshToken.databaseTokenDecryptable)}`,
      `REFRESH TOKEN PERSISTS AFTER RESTART: ${diagnosticValue(connection.persistence && connection.persistence.refreshTokenAvailableAfterProcessRestart)}`,
      `OAUTH SCOPE PERMITS DRIVE READ: ${diagnosticValue(token.scopePermitsDriveRead)}`,
      `OAUTH SCOPES: ${diagnosticValue(scopes)}`,
      `FILE OWNED BY AUTH ACCOUNT: ${diagnosticValue(ownership.ownedByAuthAccount)}`,
      `AUTH ACCOUNT CAN DOWNLOAD: ${diagnosticValue(ownership.downloadableByAuthAccount)}`,
      `METADATA files.get STATUS: ${diagnosticValue(metadata.httpStatus)}`,
      `MEDIA files.get STATUS: ${diagnosticValue(media.httpStatus)}`,
      `BACKEND USED PICKER TOKEN: ${diagnosticValue(connection.pickerTokenUsedByBackend)}`,
      `GOOGLE_CLIENT_ID SET: ${diagnosticValue(connection.oauthEnvironment && connection.oauthEnvironment.GOOGLE_CLIENT_ID)}`,
      `GOOGLE_CLIENT_SECRET SET: ${diagnosticValue(connection.oauthEnvironment && connection.oauthEnvironment.GOOGLE_CLIENT_SECRET)}`,
      `GOOGLE_API_KEY SET: ${diagnosticValue(connection.oauthEnvironment && connection.oauthEnvironment.GOOGLE_API_KEY)}`,
      `GOOGLE_CLOUD_PROJECT_NUMBER SET: ${diagnosticValue(connection.oauthEnvironment && connection.oauthEnvironment.GOOGLE_CLOUD_PROJECT_NUMBER)}`,
      `DATA_DIR SET: ${diagnosticValue(connection.persistence && connection.persistence.DATA_DIRConfigured)}`,
      '',
      'Full credential-safe report:',
      JSON.stringify(report, null, 2)
    ].join('\n');
  }

  async function diagnoseDriveResource(button) {
    const resourceId = button.getAttribute('data-diagnose-drive');
    const output = document.getElementById('driveDiagnosticOutput');
    if (!resourceId || !output) return;
    const oldLabel = button.innerHTML;
    button.disabled = true;
    output.hidden = false;
    output.textContent = 'Running the real server OAuth refresh, files.get metadata, and files.get media request…';
    document.getElementById('integrations').scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const data = await StudyCoreAPI.adminGoogleDriveDiagnose(resourceId);
      output.textContent = formatDriveDiagnostic(data.diagnostic || {});
    } catch (err) {
      output.textContent = `Google Drive diagnostic could not run:\n${err.message || 'Unknown error'}`;
    } finally {
      button.disabled = false;
      button.innerHTML = oldLabel;
    }
  }

  // This is the SAME Google OAuth client the "Select from Google Drive"
  // Picker uses. Connecting an account here simply lets the StudyCore server
  // talk to Drive on its own (server-to-server), which is what keeps older
  // Drive-referenced resources readable and lets StudyCore verify a picked
  // file. It is NOT a storage backend: StudyCore never writes uploads into
  // anybody's Drive. Every new document — uploaded directly or imported from
  // the Picker — is stored in StudyCore's own storage.
  async function loadDriveIntegration() {
    const target = document.getElementById('driveIntegrationStatus');
    if (!target) return;
    try {
      const data = await StudyCoreAPI.adminGoogleDriveStatus();
      if (data.connected) {
        target.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <span style="font-size:0.9rem;">
              <strong style="color:var(--green-600);">Connected</strong> —
              StudyCore can read documents from <strong>${escapeHtml(data.email || 'the connected Google account')}</strong>'s Google Drive library.
            </span>
            <button class="btn btn-outline btn-sm" id="driveDisconnectBtn" type="button">Disconnect</button>
          </div>
          <p style="margin-top:10px;color:var(--muted);font-size:0.82rem;">
            Documents you publish with "Select from Google Drive" stay in your Drive and are streamed
            to students by the StudyCore backend through this connection. Keep it connected so those
            documents keep opening; disconnecting never deletes or changes anything in your Google Drive.
          </p>`;
        document.getElementById('driveDisconnectBtn').addEventListener('click', async () => {
          if (!confirm('Disconnect this Google Drive account? Students will be unable to open documents published from Google Drive until an account is reconnected. Nothing in your Google Drive is deleted.')) return;
          try {
            await StudyCoreAPI.adminGoogleDriveDisconnect();
            showToast('Google Drive disconnected.', 'success');
            loadDriveIntegration();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      } else {
        target.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <span style="font-size:0.9rem;color:var(--muted);">Not connected — you can still use "Select from Google Drive" on the upload form, which authorises per file.</span>
            <a class="btn btn-primary btn-sm" href="/api/admin/google-drive/connect">Connect Google Drive</a>
          </div>`;
      }
    } catch (err) {
      target.innerHTML = `<p style="color:var(--red-600);">${escapeHtml(err.message)}</p>`;
    }
  }

  // The connect/disconnect round trip finishes with a full-page redirect
  // back here (see routes/admin.routes.js's /google-drive/callback), so the
  // result arrives as a query param rather than a fetch response.
  function reportDriveCallbackResult() {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('drive_connected');
    const error = params.get('drive_error');
    if (!connected && !error) return;
    if (connected) showToast('Google Drive connected.', 'success');
    else if (error) showToast(error, 'error');
    params.delete('drive_connected');
    params.delete('drive_error');
    const qs = params.toString();
    const hash = window.location.hash || '#integrations';
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${hash}`);
  }

  /* ── Payments ───────────────────────────── */
  async function loadPayments() {
    const target = document.getElementById('paymentsList');
    try {
      const { payments } = await StudyCoreAPI.adminListPayments();
      const pending = payments.filter((p) => p.status === 'PENDING');
      const reviewed = payments.filter((p) => p.status !== 'PENDING').slice(0, 10);

      if (!payments.length) { target.innerHTML = '<p style="color:var(--muted);">No subscription payments submitted yet.</p>'; return; }

      const row = (p, showActions) => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;font-size:0.88rem;">
          <span>
            <strong style="color:var(--ink);">${escapeHtml(p.student_name)}</strong> (${escapeHtml(p.student_email)}) · K${p.amount} via ${escapeHtml(p.method)} from ${escapeHtml(p.phone)}
            ${p.reference ? ` · ref: ${escapeHtml(p.reference)}` : ''} · ${timeAgo(p.created_at)}
            ${p.status !== 'PENDING' ? ` · <strong style="color:${p.status === 'SUCCESS' ? 'var(--green-600)' : 'var(--red-600)'}">${p.status === 'SUCCESS' ? 'Approved' : 'Rejected'}</strong>` : ''}
          </span>
          ${showActions ? `
            <span style="display:flex;gap:8px;">
              <button class="btn btn-primary btn-sm" data-approve-payment="${p.id}">Approve</button>
              <button class="btn btn-outline btn-sm" data-reject-payment="${p.id}">Reject</button>
            </span>` : ''}
        </div>`;

      target.innerHTML = `
        ${pending.length ? `<h4 style="margin-bottom:8px;font-size:0.9rem;">Pending (${pending.length})</h4>${pending.map((p) => row(p, true)).join('')}` : '<p style="color:var(--muted);">No pending payments right now.</p>'}
        ${reviewed.length ? `<h4 style="margin:16px 0 8px;font-size:0.9rem;">Recently reviewed</h4>${reviewed.map((p) => row(p, false)).join('')}` : ''}`;

      target.querySelectorAll('[data-approve-payment]').forEach((btn) => btn.addEventListener('click', async () => {
        if (!confirm('Confirm you actually received this payment before approving. Continue?')) return;
        try {
          const data = await StudyCoreAPI.adminApprovePayment(btn.getAttribute('data-approve-payment'));
          showToast(data.message, 'success');
          loadPayments();
          loadUsers();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }));
      target.querySelectorAll('[data-reject-payment]').forEach((btn) => btn.addEventListener('click', async () => {
        if (!confirm('Reject this payment request?')) return;
        try {
          const data = await StudyCoreAPI.adminRejectPayment(btn.getAttribute('data-reject-payment'));
          showToast(data.message, 'success');
          loadPayments();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }));
    } catch (err) {
      target.innerHTML = `<p style="color:var(--red-600);">${escapeHtml(err.message)}</p>`;
    }
  }

  /* ── Content Admin accounts ─────────────── */
  async function loadContentAdmins() {
    const target = document.getElementById('contentAdminsList');
    if (!target) return;
    try {
      const { contentAdmins } = await StudyCoreAPI.adminListContentAdmins();
      if (!contentAdmins.length) {
        target.innerHTML = '<p style="color:var(--muted);">No Content Admin accounts have been created yet.</p>';
        return;
      }
      target.innerHTML = contentAdmins.map((account) => {
        const active = Boolean(account.isActive);
        const counts = `${account.resourceCount || 0} upload${account.resourceCount === 1 ? '' : 's'} · ${account.publishedCount || 0} published${account.draftCount ? ` · ${account.draftCount} draft${account.draftCount === 1 ? '' : 's'}` : ''}`;
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;">
            <span style="min-width:0;">
              <strong style="color:var(--ink);">${escapeHtml(account.name)}</strong>
              <span class="badge ${active ? 'badge-green' : 'badge-red'}" style="margin-left:8px;">${active ? 'Active' : 'Revoked'}</span>
              <span style="display:block;font-size:0.83rem;color:var(--muted);margin-top:3px;">${escapeHtml(account.email)} · ${counts}${account.lastUploadAt ? ` · last upload ${timeAgo(account.lastUploadAt)}` : ''}</span>
            </span>
            <span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <button class="btn btn-outline btn-sm" data-content-admin-status="${escapeHtml(account.id)}" data-next-active="${active ? 'false' : 'true'}">${active ? 'Revoke access' : 'Restore access'}</button>
              <button class="btn btn-ghost btn-sm" data-delete-content-admin="${escapeHtml(account.id)}" data-content-admin-name="${escapeHtml(account.name)}" style="color:var(--red-600);">${SC.icon('trash', { size: 13 })} Delete</button>
            </span>
          </div>`;
      }).join('');

      target.querySelectorAll('[data-content-admin-status]').forEach((button) => button.addEventListener('click', async () => {
        const id = button.getAttribute('data-content-admin-status');
        const nextActive = button.getAttribute('data-next-active') === 'true';
        const action = nextActive ? 'restore' : 'revoke';
        if (!confirm(`${action[0].toUpperCase()}${action.slice(1)} this Content Admin's access?`)) return;
        button.disabled = true;
        try {
          const result = await StudyCoreAPI.adminSetContentAdminStatus(id, nextActive);
          showToast(result.message, 'success');
          loadContentAdmins();
          loadAnalytics();
        } catch (err) {
          showToast(err.message, 'error');
          button.disabled = false;
        }
      }));

      target.querySelectorAll('[data-delete-content-admin]').forEach((button) => button.addEventListener('click', async () => {
        const id = button.getAttribute('data-delete-content-admin');
        const name = button.getAttribute('data-content-admin-name') || 'this account';
        if (!confirm(`Delete the Content Admin account for ${name}? Their existing uploads will remain for Main Admin review.`)) return;
        button.disabled = true;
        try {
          const result = await StudyCoreAPI.adminDeleteContentAdmin(id);
          showToast(result.message, 'success');
          loadContentAdmins();
          loadResourceTable();
          loadAnalytics();
        } catch (err) {
          showToast(err.message, 'error');
          button.disabled = false;
        }
      }));
    } catch (err) {
      target.innerHTML = `<p style="color:var(--red-600);">${escapeHtml(err.message)}</p>`;
    }
  }

  /* ── Students ───────────────────────────── */
  function renderUserProgramFilter() {
    const sel = document.getElementById('userProgramFilter');
    if (!sel || !window.SCAdminPrograms) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">All programs</option>' +
      SCAdminPrograms.programs.map((p) => `<option value="${p.code}">${escapeHtml(p.name)}</option>`).join('') +
      '<option value="none">Unassigned</option>';
    sel.value = current;
    sel.onchange = () => loadUsers();
  }

  async function loadUsers() {
    const target = document.getElementById('usersList');
    const filterSel = document.getElementById('userProgramFilter');
    const programFilter = filterSel ? filterSel.value : '';
    try {
      const { users } = await StudyCoreAPI.adminListUsers(programFilter ? { program: programFilter } : {});
      const students = users.filter((u) => String(u.role || '').toLowerCase() === 'student');
      renderUserProgramFilter();
      if (!students.length) { target.innerHTML = '<p style="color:var(--muted);">No students match.</p>'; return; }

      const programChoices = window.SCAdminPrograms
        ? SCAdminPrograms.programs.map((p) => `<option value="${p.code}">${escapeHtml(p.name)}</option>`).join('')
        : '';

      target.innerHTML = students.map((u) => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;font-size:0.88rem;">
          <span style="min-width:0;">
            <strong style="color:var(--ink);">${escapeHtml(u.name)}</strong> · ${escapeHtml(u.email)}
            <span class="badge ${u.subscription === 'premium' ? 'badge-amber' : 'badge-neutral'}" style="margin-left:8px;">${u.subscription === 'premium' ? 'Premium' : 'Trial'}</span>
            <span class="program-pill" style="margin-left:6px;background:var(--teal-50,#e6f7f4);">${SC.icon(SCPrograms.programIcon(u.program), { size: 12 })} ${escapeHtml(u.programName || 'Unassigned')}</span>
            ${u.trial_end ? `<br><span style="color:var(--muted);font-size:0.78rem;">Trial ends ${formatDate(u.trial_end)}</span>` : ''}
          </span>
          <span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <select data-set-program="${u.id}" style="padding:6px 10px;border-radius:8px;border:1.5px solid var(--border-strong);background:var(--card);font-size:0.82rem;">
              <option value="">Change program…</option>
              ${programChoices}
            </select>
            <button class="btn btn-outline btn-sm" data-remove-user="${u.id}" style="color:var(--red-600);">Remove</button>
          </span>
        </div>`).join('');

      target.querySelectorAll('[data-remove-user]').forEach((btn) => btn.addEventListener('click', async () => {
        if (!confirm('Remove this student account?')) return;
        try {
          await StudyCoreAPI.adminDeleteUser(btn.getAttribute('data-remove-user'));
          showToast('Student account removed.', 'success');
          loadUsers();
          loadAnalytics();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }));
      target.querySelectorAll('[data-set-program]').forEach((sel2) => sel2.addEventListener('change', async () => {
        const userId = sel2.getAttribute('data-set-program');
        const code = sel2.value;
        if (!code) return;
        try {
          const data = await StudyCoreAPI.adminSetStudentProgram(userId, code);
          showToast(data.message || 'Program updated.', 'success');
          loadUsers();
          loadAnalytics();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }));
    } catch (err) {
      target.innerHTML = `<p style="color:var(--red-600);">${escapeHtml(err.message)}</p>`;
    }
  }

  /* ── Boot ──────────────────────────────── */

  /* ── Quiz management (Main Admin) ──────── */
  function mountQuizAdmin() {
    const mount = document.getElementById('quizAdminMount');
    if (!mount || !window.StudyCoreQuizAdmin) return;
    const flatten = (programs) => {
      const out = [];
      (programs || []).forEach((p) => (p.courses || []).forEach((c) => out.push({ id: c.id, code: c.code, name: c.name })));
      return out;
    };
    StudyCoreQuizAdmin.mount(mount, {
      role: 'admin',
      getPrograms: () => StudyCoreAPI.adminPrograms().then((d) => (d.programs || []).map((p) => ({ code: p.code, name: p.name }))),
      loadCourses: () => StudyCoreAPI.adminPrograms().then((d) => flatten(d.programs))
    }).catch(() => {});
  }
  async function initAdminPage() {
    const user = await StudyCoreAuth.fetchSession();
    if (!user || !StudyCoreAuth.isAdmin(user)) { window.location.href = '/login.html'; return; }

    // One-time welcome transition after login
    const welcomeInfo = StudyCoreAuth.consumeWelcomeFlag();
    if (welcomeInfo !== null) StudyCoreAuth.showWelcomeTransition(welcomeInfo.name || user.name, welcomeInfo.type);

    // Multi-program platform: load programs, set up the program/course
    // selectors and content targeting controls.
    try {
      await SCAdminPrograms.loadPrograms();
      resourceFormControls = SCAdminPrograms.setupResourceForm();
      const resTargetSlot = document.getElementById('resTargetPrograms');
      if (resTargetSlot) {
        resTargetSlot.innerHTML = SCAdminPrograms.targetingCheckboxesHtml('resTargetChecks', [], true);
        SCAdminPrograms.wireTargetingBehavior(resTargetSlot);
      }
      announcementTargetControls = SCAdminPrograms.setupAnnouncementForm();
      const programsHeadingIcon = document.getElementById('programsHeadingIcon');
      if (programsHeadingIcon) programsHeadingIcon.innerHTML = SC.icon('library', { size: 19 });
      await SCAdminPrograms.renderProgramCards();
      document.getElementById('addProgramBtn').addEventListener('click', SCAdminPrograms.promptCreateProgram);
      document.getElementById('addCourseBtn').addEventListener('click', () => {
        const code = prompt('Which program code do you want to add a course to? (LAW, BS, SNR, SMMS, SMNS, SICT, SBE)');
        if (code) SCAdminPrograms.promptAddCourse(code.trim().toUpperCase());
      });
      // Refresh dependent UI when programs/courses change.
      window.__adminProgramsChanged = () => {
        resourceFormControls = SCAdminPrograms.setupResourceForm();
        renderProgramFilterChips();
        renderUserProgramFilter();
      };
    } catch (err) {
      console.warn('Program controls failed to load:', err);
    }

    document.getElementById('resCategory').addEventListener('change', categoryFieldVisibility);
    document.getElementById('resourceCancelEditBtn').addEventListener('click', resetResourceForm);
    document.getElementById('resourceForm').addEventListener('submit', submitResourceForm);
    document.getElementById('announcementForm').addEventListener('submit', submitAnnouncementForm);
    bindDropZone();
    categoryFieldVisibility();
    document.getElementById('dropZoneIcon').innerHTML = SC.icon('upload', { size: 34 });
    document.getElementById('annTitleHeading').querySelector('[data-ann-icon]').innerHTML = SC.icon('bell', { size: 19 });

    StudyCoreAPI.config().then(({ maxUploadMB }) => {
      const label = document.getElementById('uploadSizeLabel');
      if (label) label.textContent = `PDF, Word, PowerPoint, Excel, images, ZIP, video or audio — up to ${maxUploadMB}MB`;
    }).catch(() => {});

    document.querySelectorAll('[data-quick-category]').forEach((btn) => btn.addEventListener('click', () => {
      resetResourceForm();
      document.getElementById('resCategory').value = btn.getAttribute('data-quick-category');
      categoryFieldVisibility();
      document.getElementById('resTitle').focus();
      document.getElementById('resourceForm').scrollIntoView({ behavior: 'smooth' });
    }));

    const quizzesHeadingIcon = document.getElementById('quizzesHeadingIcon');
    if (quizzesHeadingIcon) quizzesHeadingIcon.innerHTML = SC.icon('circle-help', { size: 19 });

    renderAdminToolbar();
    renderProgramFilterChips();
    loadAnalytics();
    mountQuizAdmin();
    loadResourceTable();
    loadPayments();
    loadContentAdmins();
    loadUsers();
    loadTopicSuggest();
    reportDriveCallbackResult();
    loadDriveIntegration();
  }

  document.addEventListener('DOMContentLoaded', initAdminPage);
})();
