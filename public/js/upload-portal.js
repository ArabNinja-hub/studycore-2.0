// =============================================
// STUDYCORE — Upload Portal (js/upload-portal.js)
// -----------------------------------------------
// The client half of the code-gated, upload-only admin surface.
//
// It is intentionally standalone: it does not load layout.js, auth.js or the
// admin bundles, because this page has no nav, no session user and no admin
// features beyond "publish a resource". Access is decided entirely by the
// server (POST /api/upload-portal/unlock sets an httpOnly cookie) — nothing
// here is a client-side gate, and the access code never lives in this file.
// =============================================

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let options = { programs: [], courses: [], topics: [], maxUploadMB: 2000 };
  let selectedFile = null;

  // ---- Small helpers ------------------------------------------------------

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function message(el, text, kind) {
    el.textContent = text || '';
    el.className = `portal-msg ${kind || ''}`;
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }

  async function api(path, options = {}) {
    const isFormData = options.body instanceof FormData;
    const res = await fetch(path, {
      ...options,
      credentials: 'include',
      headers: isFormData ? {} : { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---- Lock screen --------------------------------------------------------

  function showPortal() {
    $('lockScreen').classList.add('portal-hidden');
    $('portalContent').classList.remove('portal-hidden');
  }

  function showLock() {
    $('portalContent').classList.add('portal-hidden');
    $('lockScreen').classList.remove('portal-hidden');
    $('accessCode').value = '';
    $('accessCode').focus();
  }

  async function unlock(e) {
    e.preventDefault();
    const code = $('accessCode').value;
    const btn = $('unlockBtn');
    btn.disabled = true;
    message($('lockMsg'), '', '');
    try {
      await api('/api/upload-portal/unlock', { method: 'POST', body: JSON.stringify({ code }) });
      showPortal();
      await loadOptions();
      loadRecent();
    } catch (err) {
      message($('lockMsg'), err.message, 'err');
      $('accessCode').select();
    } finally {
      btn.disabled = false;
    }
  }

  async function lock() {
    try { await api('/api/upload-portal/lock', { method: 'POST' }); } catch { /* locking is best-effort */ }
    showLock();
  }

  // ---- Form data ----------------------------------------------------------

  async function loadOptions() {
    options = await api('/api/upload-portal/form-options');

    // Program targeting checkboxes ("All Programs" is mutually exclusive
    // with the specific ones, exactly like the main dashboard).
    const slot = $('resTargetPrograms');
    slot.innerHTML = [
      '<label><input type="checkbox" data-target-all checked> All Programs</label>',
      ...options.programs.map((p) => (
        `<label><input type="checkbox" data-target-program="${escapeHtml(p.code)}"> ${escapeHtml(p.shortName || p.name)}</label>`
      ))
    ].join('');
    const allBox = slot.querySelector('[data-target-all]');
    const progBoxes = [...slot.querySelectorAll('[data-target-program]')];
    allBox.addEventListener('change', () => {
      if (allBox.checked) progBoxes.forEach((b) => { b.checked = false; });
    });
    progBoxes.forEach((b) => b.addEventListener('change', () => { if (b.checked) allBox.checked = false; }));

    // Courses
    const courseSel = $('resCourseSelect');
    courseSel.innerHTML = '<option value="">No specific course (general resource)</option>' +
      options.courses.map((c) => {
        const where = c.programs && c.programs.length ? ` — ${c.programs.join(', ')}` : '';
        return `<option value="${escapeHtml(c.id)}">${escapeHtml(c.code)} · ${escapeHtml(c.name)}${escapeHtml(where)}</option>`;
      }).join('');

    // Topic suggestions
    $('topicSuggest').innerHTML = options.topics.map((t) => `<option value="${escapeHtml(t)}"></option>`).join('');

    $('uploadSizeLabel').textContent =
      `PDF, Word, PowerPoint, Excel, images, ZIP, video or audio — up to ${options.maxUploadMB}MB`;
  }

  function readTargeting() {
    const slot = $('resTargetPrograms');
    const allBox = slot.querySelector('[data-target-all]');
    if (!allBox || allBox.checked) return { targetAll: true, programs: [] };
    const codes = [...slot.querySelectorAll('[data-target-program]')]
      .filter((b) => b.checked)
      .map((b) => b.getAttribute('data-target-program'));
    if (!codes.length) return { targetAll: true, programs: [] };
    return { targetAll: false, programs: codes };
  }

  // ---- File picking -------------------------------------------------------

  function setFile(file) {
    selectedFile = file || null;
    $('fileChosenLabel').textContent = selectedFile
      ? `${selectedFile.name} (${formatSize(selectedFile.size)})`
      : '';
  }

  function bindDropZone() {
    const zone = $('dropZone');
    const input = $('fileInput');
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => setFile(input.files[0]));
    ['dragenter', 'dragover'].forEach((evt) => zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.style.opacity = '0.7';
    }));
    ['dragleave', 'drop'].forEach((evt) => zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.style.opacity = '1';
    }));
    zone.addEventListener('drop', (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) {
        // Keep the real <input> in sync so a later manual browse behaves.
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          $('fileInput').files = dt.files;
        } catch { /* older browsers: the File object below is enough */ }
        setFile(file);
      }
    });
  }

  // Videos must declare a term; everything else may leave it blank.
  function categoryFieldVisibility() {
    const isVideo = $('resCategory').value === 'video';
    $('resSemesterRequired').textContent = isVideo ? '*' : '';
    $('resSemesterHelp').style.display = isVideo ? 'block' : 'none';
  }

  // ---- Submit -------------------------------------------------------------

  function resetForm() {
    $('uploadForm').reset();
    setFile(null);
    $('fileInput').value = '';
    const allBox = $('resTargetPrograms').querySelector('[data-target-all]');
    if (allBox) allBox.checked = true;
    $('resTargetPrograms').querySelectorAll('[data-target-program]').forEach((b) => { b.checked = false; });
    categoryFieldVisibility();
    $('uploadProgressWrap').style.display = 'none';
    $('uploadProgressBar').style.width = '0%';
    $('uploadProgressText').textContent = '';
  }

  function uploadWithProgress(url, formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { data = null; }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const err = new Error((data && data.message) || `Upload failed (${xhr.status})`);
        err.status = xhr.status;
        reject(err);
      };
      xhr.onerror = () => reject(new Error('Network error during upload.'));
      xhr.send(formData);
    });
  }

  async function submitUpload(e) {
    e.preventDefault();
    const msg = $('uploadMsg');
    message(msg, '', '');

    const title = $('resTitle').value.trim();
    if (!title) return message(msg, 'Please give the resource a title.', 'err');
    const category = $('resCategory').value;
    if (!selectedFile) return message(msg, 'Please choose a file to upload.', 'err');

    const fd = new FormData();
    fd.append('file', selectedFile);
    fd.append('title', title);
    fd.append('category', category);
    fd.append('description', $('resDescription').value.trim());
    fd.append('courseId', $('resCourseSelect').value);
    fd.append('subject', $('resSubject').value);
    fd.append('topic', $('resTopic').value.trim());
    fd.append('yearLevel', $('resYear').value.trim());
    fd.append('semester', $('resSemester').value);
    fd.append('tags', $('resTags').value.trim());
    fd.append('publishStatus', $('resPublishStatus').value);
    fd.append('isPremium', $('resIsFree').checked ? 'false' : 'true');
    const targeting = readTargeting();
    fd.append('targetAll', targeting.targetAll ? 'true' : 'false');
    fd.append('programs', targeting.programs.join(','));

    const btn = $('uploadSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    $('uploadProgressWrap').style.display = 'block';

    try {
      const data = await uploadWithProgress('/api/upload-portal/resources', fd, (pct) => {
        $('uploadProgressBar').style.width = `${pct}%`;
        $('uploadProgressText').textContent = pct < 100 ? `Uploading… ${pct}%` : 'Finishing up…';
      });
      const warning = data && data.warning ? ` ${data.warning}` : '';
      resetForm();
      message(msg, `Uploaded. “${title}” is now on StudyCore.${warning}`, 'ok');
      loadRecent();
    } catch (err) {
      if (err.status === 401) {
        showLock();
        message($('lockMsg'), 'Your portal session expired. Enter the access code again.', 'err');
        return;
      }
      message(msg, err.message, 'err');
      $('uploadProgressWrap').style.display = 'none';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Publish Resource';
    }
  }

  // ---- Recent uploads (read-only confirmation list) -----------------------

  async function loadRecent() {
    const host = $('recentList');
    try {
      const { resources } = await api('/api/upload-portal/recent');
      if (!resources.length) {
        host.innerHTML = '<p class="portal-note">Nothing uploaded yet.</p>';
        return;
      }
      host.innerHTML = resources.map((r) => `
        <div class="recent-item">
          <div>
            <strong>${escapeHtml(r.title)}</strong>
            <div class="portal-note">${escapeHtml(r.category)}${r.subject ? ` · ${escapeHtml(r.subject)}` : ''}${r.publishStatus === 'draft' ? ' · draft' : ''}</div>
          </div>
          <span>${new Date(r.createdAt).toLocaleDateString()}</span>
        </div>
      `).join('');
    } catch {
      host.innerHTML = '<p class="portal-note">Could not load recent uploads.</p>';
    }
  }

  // ---- Boot ---------------------------------------------------------------

  async function init() {
    $('unlockForm').addEventListener('submit', unlock);
    $('lockBtn').addEventListener('click', lock);
    $('uploadForm').addEventListener('submit', submitUpload);
    $('uploadResetBtn').addEventListener('click', () => { resetForm(); message($('uploadMsg'), '', ''); });
    $('resCategory').addEventListener('change', categoryFieldVisibility);
    document.querySelectorAll('[data-quick-category]').forEach((btn) => btn.addEventListener('click', () => {
      $('resCategory').value = btn.getAttribute('data-quick-category');
      categoryFieldVisibility();
      $('resTitle').focus();
    }));
    bindDropZone();
    categoryFieldVisibility();

    // Already unlocked (cookie still valid, or a logged-in admin opened it)?
    try {
      const { unlocked } = await api('/api/upload-portal/session');
      if (unlocked) {
        showPortal();
        await loadOptions();
        loadRecent();
        return;
      }
    } catch { /* fall through to the lock screen */ }
    showLock();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
