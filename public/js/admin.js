// =============================================
// STUDYCORE - Admin Dashboard Module (js/admin.js)
// By Dr. Relentless | Stay Curious & Winning
// -----------------------------------------------
// Runs only on views/admin.html, which the server already refuses to send
// to anyone whose session isn't role=ADMIN (see middleware/auth.js -
// requirePageAuth). Everything below talks to real endpoints in
// routes/admin.routes.js; there is no localStorage fallback.
// =============================================

let selectedFile = null;
let editingResourceId = null;
let editingAnnouncementId = null;
let currentAdminFilters = { search: '', category: '', sort: 'newest' };

function categoryFieldVisibility() {
  const category = document.getElementById('resCategory').value;
  document.getElementById('resDueDateGroup').style.display = category === 'assignment' ? 'block' : 'none';
  document.getElementById('resQuizGroup').style.display = category === 'quiz' ? 'block' : 'none';
  document.getElementById('resQuizData').required = category === 'quiz';

  const fileInput = document.getElementById('fileInput');
  if (category === 'video') {
    fileInput.setAttribute('accept', '.mp4,.mov,.webm,.mkv,.avi,video/*');
  } else {
    fileInput.setAttribute('accept', '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.csv,.zip,.rar,.jpg,.jpeg,.png,.gif,.webp,.svg');
  }
}

function resetResourceForm() {
  editingResourceId = null;
  selectedFile = null;
  document.getElementById('resourceForm').reset();
  document.getElementById('resourceId').value = '';
  document.getElementById('fileChosenLabel').textContent = '';
  document.getElementById('uploadProgressWrap').style.display = 'none';
  document.getElementById('uploadFormTitle').textContent = 'Upload a new resource';
  document.getElementById('resourceSubmitBtn').textContent = 'Publish Resource';
  document.getElementById('resourceCancelEditBtn').style.display = 'none';
  categoryFieldVisibility();
}

function resetAnnouncementForm() {
  editingAnnouncementId = null;
  document.getElementById('announcementForm').reset();
  document.getElementById('announcementSubmitBtn').textContent = 'Post Announcement';
}

function editAnnouncement(r) {
  editingAnnouncementId = r.id;
  document.getElementById('annTitle').value = r.title;
  document.getElementById('annMessage').value = r.description || '';
  document.getElementById('announcementSubmitBtn').textContent = 'Save Changes';
  document.getElementById('announcementForm').scrollIntoView({ behavior: 'smooth' });
}

async function submitAnnouncementForm(e) {
  e.preventDefault();
  const title = document.getElementById('annTitle').value.trim();
  const message = document.getElementById('annMessage').value.trim();
  if (!title) return showToast('Please add a title for the announcement.', 'error');

  const fd = new FormData();
  fd.append('title', title);
  fd.append('description', message);
  fd.append('category', 'announcement');
  fd.append('publishStatus', 'published');
  fd.append('isPremium', 'false');

  const btn = document.getElementById('announcementSubmitBtn');
  btn.disabled = true;
  try {
    const url = editingAnnouncementId ? `/api/admin/resources/${editingAnnouncementId}` : '/api/admin/resources';
    const method = editingAnnouncementId ? 'PUT' : 'POST';
    const res = await fetch(url, { method, credentials: 'include', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not post announcement.');
    showToast(editingAnnouncementId ? 'Announcement updated.' : 'Announcement posted.', 'success');
    resetAnnouncementForm();
    loadResourceTable();
    loadAnalytics();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function bindDropZone() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const label = document.getElementById('fileChosenLabel');

  function chooseFile(file) {
    selectedFile = file;
    label.textContent = file ? `Selected: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)` : '';
  }

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => chooseFile(e.target.files[0]));

  ['dragenter', 'dragover'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--teal, #1A9E8F)';
      dropZone.style.background = 'rgba(26,158,143,0.08)';
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.style.borderColor = '';
      dropZone.style.background = '';
    });
  });
  dropZone.addEventListener('drop', (e) => {
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
  fd.append('course', document.getElementById('resCourse').value.trim());
  fd.append('yearLevel', document.getElementById('resYear').value.trim());
  fd.append('semester', document.getElementById('resSemester').value.trim());
  fd.append('tags', document.getElementById('resTags').value.trim());
  fd.append('dueDate', document.getElementById('resDueDate').value);
  fd.append('quizData', document.getElementById('resQuizData').value.trim());
  fd.append('publishStatus', document.getElementById('resPublishStatus').value);
  fd.append('isPremium', document.getElementById('resIsFree').checked ? 'false' : 'true');
  if (selectedFile) fd.append('file', selectedFile);
  return fd;
}

async function submitResourceForm(e) {
  e.preventDefault();
  const category = document.getElementById('resCategory').value;
  const quizRaw = document.getElementById('resQuizData').value.trim();
  if (category === 'quiz') {
    try { JSON.parse(quizRaw); } catch { showToast('Quiz questions must be valid JSON.', 'error'); return; }
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
    progressText.textContent = 'Uploading... 0%';
  }

  try {
    const url = editingResourceId ? `/api/admin/resources/${editingResourceId}` : '/api/admin/resources';
    const method = editingResourceId ? 'PUT' : 'POST';
    const result = await StudyCoreAPI.uploadWithProgress(url, method, fd, (pct) => {
      progressBar.style.width = `${pct}%`;
      progressText.textContent = `Uploading... ${pct}%`;
    });
    showToast(editingResourceId ? 'Resource updated.' : 'Resource published.', 'success');
    if (result && result.warning) showToast(result.warning, 'info');
    resetResourceForm();
    loadResourceTable();
    loadAnalytics();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    progressWrap.style.display = 'none';
  }
}

async function loadAnalytics() {
  const target = document.getElementById('adminAnalytics');
  try {
    const a = await StudyCoreAPI.adminAnalytics();
    target.innerHTML = `
      <div class="info-card"><h3>Total uploads</h3><p style="font-size:1.8rem;font-weight:700;">${a.totalResources}</p><span class="resource-meta">${a.publishedResources} published</span></div>
      <div class="info-card"><h3>Total downloads</h3><p style="font-size:1.8rem;font-weight:700;">${a.totalDownloads}</p><span class="resource-meta">${a.totalViews} views</span></div>
      <div class="info-card"><h3>Total users</h3><p style="font-size:1.8rem;font-weight:700;">${a.totalUsers}</p><span class="resource-meta">${a.premiumStudents} premium students</span></div>
      <div class="info-card"><h3>Revenue collected</h3><p style="font-size:1.8rem;font-weight:700;">K${a.revenue}</p><span class="resource-meta">from confirmed subscriptions</span></div>
      <div class="info-card"><h3>Storage used</h3><p style="font-size:1.8rem;font-weight:700;">${formatFileSize(a.storageUsedBytes) || '0 B'}</p><span class="resource-meta">across all uploaded files</span></div>
      <div class="info-card">
        <h3>Most downloaded</h3>
        ${a.popular.length ? a.popular.map((p) => `<div class="resource-meta">${escapeHtml(p.title)} - ${p.download_count} downloads</div>`).join('') : '<p class="resource-meta">No downloads yet.</p>'}
      </div>
      <div class="info-card">
        <h3>Most viewed</h3>
        ${a.mostViewed.length ? a.mostViewed.map((v) => `<div class="resource-meta">${escapeHtml(v.title)} - ${v.view_count} views</div>`).join('') : '<p class="resource-meta">No views yet.</p>'}
      </div>
      <div class="info-card">
        <h3>Uploads by category</h3>
        ${a.byCategory.length ? a.byCategory.map((c) => `<div class="resource-meta">${CATEGORY_LABELS[c.category] || c.category}: ${c.count}</div>`).join('') : ''}
      </div>
      <div class="info-card">
        <h3>Recent download activity</h3>
        ${a.recentActivity.length ? a.recentActivity.map((r) => `<div class="resource-meta">${escapeHtml(r.student_name || 'A student')} downloaded "${escapeHtml(r.title)}" - ${formatDate(r.created_at)}</div>`).join('') : '<p class="resource-meta">No downloads yet.</p>'}
      </div>
    `;
  } catch (err) {
    target.innerHTML = `<p>${escapeHtml(err.message)}</p>`;
  }
}

function renderAdminToolbar() {
  const container = document.getElementById('adminToolbar');
  container.innerHTML = `
    <div class="filter-toolbar" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
      <input type="search" id="adminSearch" placeholder="Search resources..." style="flex:1;min-width:200px;padding:10px 14px;border-radius:8px;border:1px solid var(--border,#ccc);" />
      <select id="adminCategoryFilter" style="padding:10px 14px;border-radius:8px;border:1px solid var(--border,#ccc);">
        <option value="">All categories</option>
        <option value="document">Documents</option>
        <option value="video">Videos</option>
        <option value="tutorial">Tutorials</option>
        <option value="past_paper">Past Papers</option>
        <option value="quiz">Quizzes</option>
        <option value="assignment">Assignments</option>
        <option value="announcement">Announcements</option>
      </select>
      <select id="adminSort" style="padding:10px 14px;border-radius:8px;border:1px solid var(--border,#ccc);">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="popular">Most downloaded</option>
        <option value="title">Title A-Z</option>
      </select>
    </div>
  `;
  let debounceTimer;
  const fire = () => {
    currentAdminFilters = {
      search: document.getElementById('adminSearch').value.trim(),
      category: document.getElementById('adminCategoryFilter').value,
      sort: document.getElementById('adminSort').value
    };
    loadResourceTable();
  };
  document.getElementById('adminSearch').addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fire, 300);
  });
  document.getElementById('adminCategoryFilter').addEventListener('change', fire);
  document.getElementById('adminSort').addEventListener('change', fire);
}

async function loadResourceTable() {
  const tbody = document.getElementById('adminResourceTableBody');
  tbody.innerHTML = '<tr><td colspan="7" style="padding:12px;">Loading...</td></tr>';
  try {
    const { resources } = await StudyCoreAPI.adminListResources(currentAdminFilters);
    if (!resources.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:12px;">No resources match your filters.</td></tr>';
      return;
    }
    tbody.innerHTML = resources.map((r) => `
      <tr style="border-bottom:1px solid var(--border,#eee);">
        <td style="padding:8px;">${escapeHtml(r.title)}</td>
        <td style="padding:8px;">${CATEGORY_LABELS[r.category] || r.category}</td>
        <td style="padding:8px;">${escapeHtml(r.subject || '-')}</td>
        <td style="padding:8px;">
          <button class="btn btn-outline btn-sm" data-toggle-publish="${r.id}" data-current-status="${r.publishStatus}">
            ${r.publishStatus === 'published' ? 'Published' : 'Draft'}
          </button>
          <span class="resource-meta" style="display:block;margin-top:4px;">${r.isPremium ? '🔒 Premium' : '🔓 Free preview'}</span>
        </td>
        <td style="padding:8px;">${r.downloadCount}</td>
        <td style="padding:8px;">${formatDate(r.createdAt)}</td>
        <td style="padding:8px;white-space:nowrap;">
          <button class="btn btn-outline btn-sm" data-edit="${r.id}">Edit</button>
          <button class="btn btn-outline btn-sm" data-delete="${r.id}">Delete</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => editResource(btn.getAttribute('data-edit'), resources)));
    tbody.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', () => deleteResource(btn.getAttribute('data-delete'))));
    tbody.querySelectorAll('[data-toggle-publish]').forEach((btn) => btn.addEventListener('click', () => togglePublish(btn)));
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:12px;">${err.message}</td></tr>`;
  }
}

function editResource(id, resources) {
  const r = resources.find((item) => item.id === id);
  if (!r) return;

  if (r.category === 'announcement') {
    editAnnouncement(r);
    return;
  }

  editingResourceId = id;
  selectedFile = null;
  document.getElementById('resourceId').value = id;
  document.getElementById('resCategory').value = r.category;
  document.getElementById('resTitle').value = r.title;
  document.getElementById('resDescription').value = r.description || '';
  document.getElementById('resSubject').value = r.subject || '';
  document.getElementById('resCourse').value = r.course || '';
  document.getElementById('resYear').value = r.yearLevel || '';
  document.getElementById('resSemester').value = r.semester || '';
  document.getElementById('resTags').value = (r.tags || []).join(', ');
  document.getElementById('resDueDate').value = r.dueDate || '';
  document.getElementById('resQuizData').value = r.quizData ? JSON.stringify(r.quizData) : '';
  document.getElementById('resPublishStatus').value = r.publishStatus;
  document.getElementById('resIsFree').checked = !r.isPremium;
  document.getElementById('fileChosenLabel').textContent = r.hasFile ? `Current file: ${escapeHtml(r.fileName)} (choose a new file only if you want to replace it)` : '';
  categoryFieldVisibility();
  document.getElementById('uploadFormTitle').textContent = `Editing: ${escapeHtml(r.title)}`;
  document.getElementById('resourceSubmitBtn').textContent = 'Save Changes';
  document.getElementById('resourceCancelEditBtn').style.display = 'inline-block';
  document.getElementById('resourceForm').scrollIntoView({ behavior: 'smooth' });
}

async function deleteResource(id) {
  if (!confirm('Delete this resource permanently? This cannot be undone.')) return;
  try {
    await StudyCoreAPI.adminDeleteResource(id);
    showToast('Resource deleted.', 'success');
    loadResourceTable();
    loadAnalytics();
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
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadPayments() {
  const target = document.getElementById('paymentsList');
  try {
    const { payments } = await StudyCoreAPI.adminListPayments();
    const pending = payments.filter((p) => p.status === 'PENDING');
    const reviewed = payments.filter((p) => p.status !== 'PENDING').slice(0, 10);

    if (!payments.length) {
      target.innerHTML = '<p>No subscription payments submitted yet.</p>';
      return;
    }

    const row = (p, showActions) => `
      <div class="resource-meta" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border-color,#2a2a2a);flex-wrap:wrap;">
        <span>
          ${escapeHtml(p.student_name)} (${escapeHtml(p.student_email)}) - K${p.amount} via ${escapeHtml(p.method)} from ${escapeHtml(p.phone)}
          ${p.reference ? ` - ref: ${escapeHtml(p.reference)}` : ''}
          - ${formatDate(p.created_at)}
          ${p.status !== 'PENDING' ? ` - <strong>${p.status === 'SUCCESS' ? 'Approved' : 'Rejected'}</strong>` : ''}
        </span>
        ${showActions ? `
          <span style="display:flex;gap:8px;">
            <button class="btn btn-primary btn-sm" data-approve-payment="${p.id}">Approve</button>
            <button class="btn btn-outline btn-sm" data-reject-payment="${p.id}">Reject</button>
          </span>
        ` : ''}
      </div>
    `;

    target.innerHTML = `
      ${pending.length ? `<h4 style="margin-bottom:8px;">Pending (${pending.length})</h4>${pending.map((p) => row(p, true)).join('')}` : '<p>No pending payments right now.</p>'}
      ${reviewed.length ? `<h4 style="margin:16px 0 8px;">Recently reviewed</h4>${reviewed.map((p) => row(p, false)).join('')}` : ''}
    `;

    target.querySelectorAll('[data-approve-payment]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Confirm you actually received this payment before approving. Continue?')) return;
        try {
          const data = await StudyCoreAPI.adminApprovePayment(btn.getAttribute('data-approve-payment'));
          showToast(data.message, 'success');
          loadPayments();
          loadUsers();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
    target.querySelectorAll('[data-reject-payment]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Reject this payment request?')) return;
        try {
          const data = await StudyCoreAPI.adminRejectPayment(btn.getAttribute('data-reject-payment'));
          showToast(data.message, 'success');
          loadPayments();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  } catch (err) {
    target.innerHTML = `<p>${escapeHtml(err.message)}</p>`;
  }
}

async function loadUsers() {
  const target = document.getElementById('usersList');
  try {
    const { users } = await StudyCoreAPI.adminListUsers();
    const students = users.filter((u) => u.role === 'STUDENT');
    if (!students.length) {
      target.innerHTML = '<p>No students have signed up yet.</p>';
      return;
    }
    target.innerHTML = students.map((u) => `
      <div class="resource-meta" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border-color,#2a2a2a);">
        <span>${escapeHtml(u.name)} - ${escapeHtml(u.email)} - ${escapeHtml(u.subscription)}${u.trial_end ? ` - trial ends ${formatDate(u.trial_end)}` : ''}</span>
        <button class="btn btn-outline btn-sm" data-remove-user="${u.id}">Remove</button>
      </div>
    `).join('');
    target.querySelectorAll('[data-remove-user]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this student account?')) return;
        try {
          await StudyCoreAPI.adminDeleteUser(btn.getAttribute('data-remove-user'));
          showToast('Student account removed.', 'success');
          loadUsers();
          loadAnalytics();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  } catch (err) {
    target.innerHTML = `<p>${err.message}</p>`;
  }
}

async function initAdminPage() {
  const user = await StudyCoreAuth.fetchSession();
  StudyCoreAuth.updateAuthUI();

  const welcomeInfo = StudyCoreAuth.consumeWelcomeFlag();
  if (welcomeInfo !== null) {
    StudyCoreAuth.showWelcomeTransition(welcomeInfo.name || (user && user.name), welcomeInfo.type);
  }

  document.getElementById('logoutBtn').addEventListener('click', StudyCoreAuth.logoutUser);
  document.getElementById('resCategory').addEventListener('change', categoryFieldVisibility);
  document.getElementById('resourceCancelEditBtn').addEventListener('click', resetResourceForm);
  document.getElementById('resourceForm').addEventListener('submit', submitResourceForm);
  document.getElementById('announcementForm').addEventListener('submit', submitAnnouncementForm);
  bindDropZone();
  categoryFieldVisibility();

  StudyCoreAPI.config().then(({ maxUploadMB }) => {
    const label = document.getElementById('uploadSizeLabel');
    if (label) label.textContent = `PDF, Word, PowerPoint, Excel, images, ZIP, video, or audio - up to ${maxUploadMB}MB`;
  }).catch(() => { /* label just stays at its default text if this fails - not fatal */ });

  renderAdminToolbar();

  document.querySelectorAll('[data-quick-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      resetResourceForm();
      document.getElementById('resCategory').value = btn.getAttribute('data-quick-category');
      categoryFieldVisibility();
      document.getElementById('resTitle').focus();
      document.getElementById('resourceForm').scrollIntoView({ behavior: 'smooth' });
    });
  });

  loadAnalytics();
  loadResourceTable();
  loadPayments();
  loadUsers();
}

document.addEventListener('DOMContentLoaded', initAdminPage);
