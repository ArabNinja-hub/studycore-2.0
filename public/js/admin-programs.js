// =============================================
// STUDYCORE — Admin: Programs & Courses (js/admin-programs.js)
// -----------------------------------------------
// Program/course management + content targeting
// for the multi-program platform. Talks to
// /api/programs/admin* and the program fields on
// the resource/announcement forms.
// =============================================

(function (global) {
  'use strict';

  let programs = []; // admin overview programs (with courses)
  let globalCourses = []; // flattened course list for selects

  async function loadPrograms() {
    const data = await StudyCoreAPI.adminPrograms();
    programs = data.programs || [];
    globalCourses = programs.flatMap((p) => (p.courses || []).map((c) => ({ ...c, programCode: p.code, programName: p.name })));
    return programs;
  }

  function programOptions(includeAllLabel) {
    return programs.map((p) => {
      const label = p.groupName ? `${p.name} (${p.groupName})` : p.name;
      return `<option value="${p.code}">${escapeHtml(label)}</option>`;
    }).join('');
  }

  // Targeting checkbox set. checkedAll => All Programs ticked; checkedCodes
  // pre-ticks specific programs.
  function targetingCheckboxesHtml(idPrefix, checkedCodes, allChecked) {
    const all = allChecked || !(checkedCodes && checkedCodes.length);
    const specific = checkedCodes || [];
    const boxes = [
      `<label><input type="checkbox" data-target-all="1" ${all ? 'checked' : ''}> ${SC.icon('users', { size: 14 })} All Students / All Programs</label>`
    ];
    programs.forEach((p) => {
      const isC = !all && specific.includes(p.code);
      boxes.push(`<label><input type="checkbox" data-target-program="${p.code}" ${isC ? 'checked' : ''}> ${SC.icon(p.icon || 'book-open', { size: 14 })} ${escapeHtml(p.shortName || p.name)}</label>`);
    });
    return `<div class="target-checkboxes" id="${idPrefix}">${boxes.join('')}</div>`;
  }

  // Read targeting state from a checkbox container. Returns
  // { targetAll: bool, programs: [codes] }.
  function readTargeting(container) {
    const allBox = container.querySelector('[data-target-all]');
    if (allBox && allBox.checked) return { targetAll: true, programs: [] };
    const codes = [...container.querySelectorAll('[data-target-program]')]
      .filter((b) => b.checked)
      .map((b) => b.getAttribute('data-target-program'));
    if (!codes.length) return { targetAll: true, programs: [] };
    return { targetAll: false, programs: codes };
  }

  // Wire the mutual exclusion: ticking "All" clears the others; ticking a
  // specific program un-ticks "All".
  function wireTargetingBehavior(container) {
    const allBox = container.querySelector('[data-target-all]');
    const programBoxes = [...container.querySelectorAll('[data-target-program]')];
    allBox.addEventListener('change', () => {
      if (allBox.checked) programBoxes.forEach((b) => { b.checked = false; });
    });
    programBoxes.forEach((b) => b.addEventListener('change', () => {
      if (b.checked) allBox.checked = false;
    }));
  }

  // ---- Resource form: program selector + course selector + targeting ----
  function setupResourceForm() {
    const programSel = document.getElementById('resProgram');
    const courseSel = document.getElementById('resCourseSelect');
    const targetingSlot = document.getElementById('resTargetPrograms');

    programSel.innerHTML = '<option value="">All Programs (general content)</option>' + programOptions();

    function rebuildCourseSelect(keepCourseId) {
      const programCode = programSel.value;
      let options = '<option value="">No specific course (general resource)</option>';
      const source = programCode
        ? (programs.find((p) => p.code === programCode)?.courses || [])
        : globalCourses;
      source.forEach((c) => {
        const label = `${c.code} — ${c.name}${programCode ? '' : ` (${c.programCode})`}`;
        options += `<option value="${c.id}">${escapeHtml(label)}</option>`;
      });
      courseSel.innerHTML = options;
      if (keepCourseId) courseSel.value = keepCourseId;
    }

    programSel.addEventListener('change', () => {
      // When a specific program is chosen, default targeting to it and list
      // only that program's courses.
      rebuildCourseSelect();
      if (programSel.value) {
        const allBox = targetingSlot.querySelector('[data-target-all]');
        if (allBox) allBox.checked = false;
        const box = targetingSlot.querySelector(`[data-target-program="${programSel.value}"]`);
        if (box) box.checked = true;
      }
    });
    rebuildCourseSelect();

    return {
      getProgram: () => programSel.value,
      getCourseId: () => courseSel.value,
      setProgram(code) { programSel.value = code || ''; rebuildCourseSelect(); },
      setCourse(courseId) {
        // If a course belongs to a program not currently selected, switch.
        if (courseId) {
          const owner = globalCourses.find((c) => c.id === courseId);
          if (owner && owner.programCode && programSel.value !== owner.programCode) {
            programSel.value = owner.programCode;
            rebuildCourseSelect(courseId);
            return;
          }
        }
        rebuildCourseSelect(courseId);
      }
    };
  }

  // ---- Announcement form targeting ----
  function setupAnnouncementForm() {
    const slot = document.getElementById('annTargetPrograms');
    slot.innerHTML = targetingCheckboxesHtml('annTargetChecks', [], true);
    wireTargetingBehavior(slot);
    return {
      get() { return readTargeting(slot); },
      set(targetAll, codes) {
        slot.innerHTML = targetingCheckboxesHtml('annTargetChecks', codes, targetAll);
        wireTargetingBehavior(slot);
      }
    };
  }

  // ---- Programs & Courses management cards ----
  function targetBadge(r) {
    if (r.targetAll) return '<span class="badge badge-green">All programs</span>';
    const codes = (r.targetPrograms || []).map((c) => SCPrograms.programShortName(c) || c);
    return `<span class="badge badge-neutral">${escapeHtml(codes.join(', ') || '—')}</span>`;
  }

  async function renderProgramCards() {
    const grid = document.getElementById('programMgmtGrid');
    await loadPrograms();
    grid.innerHTML = programs.map((p) => {
      const courses = p.courses || [];
      return `
      <div class="program-mgmt-card" data-program-card="${p.code}">
        <h4>${SC.icon(p.icon || 'book-open', { size: 18 })} ${escapeHtml(p.name)}</h4>
        ${p.groupName ? `<div style="font-size:0.75rem;color:var(--muted);margin-bottom:6px;">${escapeHtml(p.groupName)}</div>` : ''}
        <div style="font-size:0.8rem;color:var(--muted);margin-bottom:8px;">${p.studentCount || 0} student(s) · ${courses.length} course(s)</div>
        <div data-course-list>
          ${courses.length ? courses.map((c) => {
            let sharedCourse = globalCourses.find(gc => gc.id === c.shared_with_course_id);
            if (!sharedCourse) sharedCourse = globalCourses.find(gc => gc.shared_with_course_id === c.id);
            const sharedIndicator = sharedCourse ? `<div style="font-size: 0.75rem; color: var(--teal-600); margin-top: 2px;">🔗 Shared with: ${escapeHtml(sharedCourse.code)}</div>` : '';
            return `
            <div class="program-course-line" style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 8px;">
              <div style="display:flex; flex-direction:column;">
                <span><strong>${escapeHtml(c.code)}</strong> — ${escapeHtml(c.name)}</span>
                ${sharedIndicator}
              </div>
              <span style="display:inline-flex;gap:4px;flex-shrink:0;">
                <button class="icon-btn" data-edit-course="${c.id}" title="Edit Course" style="width:28px;height:28px;">${SC.icon('settings', { size: 14 })}</button>
                <button class="icon-btn" data-detach-course="${p.code}|${c.id}" title="Remove from this program" style="width:28px;height:28px;color:var(--red-600);">${SC.icon('x', { size: 14 })}</button>
              </span>
            </div>`;
          }).join('') : '<p style="font-size:0.84rem;color:var(--muted);margin:6px 0;">No courses yet — add one below.</p>'}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          <button class="btn btn-outline btn-sm" data-add-course-to="${p.code}">${SC.icon('plus', { size: 13 })} Add course</button>
          <button class="btn btn-ghost btn-sm" data-delete-program="${p.code}" style="color:var(--red-600);">${SC.icon('trash', { size: 13 })} Delete</button>
        </div>
      </div>`;
    }).join('');

    grid.querySelectorAll('[data-add-course-to]').forEach((btn) => btn.addEventListener('click', () => promptAddCourse(btn.getAttribute('data-add-course-to'))));
    grid.querySelectorAll('[data-edit-course]').forEach((btn) => btn.addEventListener('click', () => promptEditCourse(btn.getAttribute('data-edit-course'))));
    grid.querySelectorAll('[data-delete-program]').forEach((btn) => btn.addEventListener('click', () => deleteProgram(btn.getAttribute('data-delete-program'))));
    grid.querySelectorAll('[data-detach-course]').forEach((btn) => btn.addEventListener('click', async () => {
      const [code, courseId] = btn.getAttribute('data-detach-course').split('|');
      if (!confirm('Remove this course from the program? Uploaded content is kept.')) return;
      try {
        await StudyCoreAPI.adminDetachCourse(code, courseId);
        showToast('Course removed from program.', 'success');
        await renderProgramCards();
        notifyChange();
      } catch (err) { showToast(err.message, 'error'); }
    }));
  }

  async function deleteProgram(code) {
    const p = programs.find((x) => x.code === code);
    if (!confirm(`Delete the "${p ? p.name : code}" program? Students in it will need to re-pick a program.`)) return;
    try {
      await StudyCoreAPI.adminDeleteProgram(code);
      showToast('Program deleted.', 'success');
      await renderProgramCards();
      notifyChange();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function promptEditCourse(courseId) {
    const course = globalCourses.find(c => c.id === courseId);
    if (!course) return;

    let currentSharedId = course.shared_with_course_id;
    if (!currentSharedId) {
      const reverse = globalCourses.find(c => c.shared_with_course_id === course.id);
      if (reverse) currentSharedId = reverse.id;
    }

    const availableToShare = globalCourses.filter(c => c.id !== courseId);
    
    // We create a custom dialog since prompt() is limited.
    const dialog = document.createElement('dialog');
    dialog.className = 'card card-pad';
    dialog.style.maxWidth = '400px';
    dialog.style.border = 'none';
    dialog.style.borderRadius = '8px';
    dialog.style.padding = '24px';
    dialog.innerHTML = `
      <h3 style="margin-top:0;">Edit Course</h3>
      <form id="editCourseForm" method="dialog">
        <div style="margin-bottom: 12px;">
          <label style="display:block; margin-bottom:4px; font-size:0.85rem; font-weight:bold;">Course Name</label>
          <input type="text" id="editCourseName" value="${escapeHtml(course.name)}" required style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;" />
        </div>
        <div style="margin-bottom: 12px;">
          <label style="display:block; margin-bottom:4px; font-size:0.85rem; font-weight:bold;">Legacy Subject</label>
          <input type="text" id="editCourseSubject" value="${escapeHtml(course.subject || '')}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;" placeholder="Optional" />
        </div>
        <div style="margin-bottom: 24px;">
          <label style="display:block; margin-bottom:4px; font-size:0.85rem; font-weight:bold;">Shared Course Counterpart</label>
          <p style="font-size:0.75rem; color:var(--muted); margin-bottom:8px;">If this course is shared with another program's course (e.g. NUN Quota), select it here. Content posted to either course will be available to both.</p>
          <select id="editCourseShared" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
            <option value="">-- No shared counterpart --</option>
            ${availableToShare.map(c => `<option value="${c.id}" ${c.id === currentSharedId ? 'selected' : ''}>${escapeHtml(c.code)} - ${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex; gap:12px; justify-content:flex-end;">
          <button type="button" class="btn btn-outline" id="editCourseCancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);
    dialog.showModal();

    dialog.querySelector('#editCourseCancel').addEventListener('click', () => {
      dialog.close();
      dialog.remove();
    });

    dialog.querySelector('#editCourseForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const newName = dialog.querySelector('#editCourseName').value;
      const newSubject = dialog.querySelector('#editCourseSubject').value;
      const sharedWithCourseId = dialog.querySelector('#editCourseShared').value;
      
      try {
        await StudyCoreAPI.adminUpdateCourse(course.id, {
          name: newName,
          subject: newSubject,
          sharedWithCourseId: sharedWithCourseId || null
        });
        showToast('Course updated.', 'success');
        dialog.close();
        dialog.remove();
        await renderProgramCards();
        notifyChange();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Add a course: choose "new" (code + name) or attach an existing one.
  async function promptAddCourse(programCode) {
    const allCourses = globalCourses;
    const existingCodes = new Set((programs.find((p) => p.code === programCode)?.courses || []).map((c) => c.id));
    const attachable = allCourses.filter((c) => !existingCodes.has(c.id));

    const dialog = document.createElement('dialog');
    dialog.className = 'card card-pad';
    dialog.style.maxWidth = '500px';
    dialog.style.border = 'none';
    dialog.style.borderRadius = '8px';
    dialog.style.padding = '24px';
    dialog.innerHTML = `
      <h3 style="margin-top:0;">Add a course to ${escapeHtml(programCode)}</h3>
      
      <div style="margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--border);">
        <h4 style="margin: 0 0 12px; font-size: 0.95rem;">Option 1: Attach an existing course</h4>
        <form id="attachCourseForm" method="dialog" style="display:flex; gap:8px;">
          <select id="attachCourseId" style="flex:1; padding:8px; border:1px solid #ccc; border-radius:4px;" required>
            <option value="">-- Select an existing course --</option>
            ${attachable.map(c => `<option value="${c.id}">${escapeHtml(c.code)} - ${escapeHtml(c.name)}</option>`).join('')}
          </select>
          <button type="submit" class="btn btn-primary btn-sm">Attach</button>
        </form>
      </div>

      <div>
        <h4 style="margin: 0 0 12px; font-size: 0.95rem;">Option 2: Create a new course</h4>
        <form id="createCourseForm" method="dialog">
          <div style="margin-bottom: 12px; display:flex; gap:12px;">
            <div style="flex: 1;">
              <label style="display:block; margin-bottom:4px; font-size:0.85rem; font-weight:bold;">Course Code</label>
              <input type="text" id="createCourseCode" placeholder="e.g. BS100" required style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;" />
            </div>
            <div style="flex: 2;">
              <label style="display:block; margin-bottom:4px; font-size:0.85rem; font-weight:bold;">Course Name</label>
              <input type="text" id="createCourseName" placeholder="e.g. Introduction to Business" required style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;" />
            </div>
          </div>
          <div style="margin-bottom: 24px;">
            <label style="display:block; margin-bottom:4px; font-size:0.85rem; font-weight:bold;">Shared Course Counterpart (Optional)</label>
            <p style="font-size:0.75rem; color:var(--muted); margin-bottom:8px;">Connect this new course to a counterpart in another program.</p>
            <select id="createCourseShared" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
              <option value="">-- No shared counterpart --</option>
              ${allCourses.map(c => `<option value="${c.id}">${escapeHtml(c.code)} - ${escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:12px;">
            <button type="button" class="btn btn-outline" id="addCourseCancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Create & Add</button>
          </div>
        </form>
      </div>
    `;
    
    document.body.appendChild(dialog);
    dialog.showModal();

    dialog.querySelector('#addCourseCancel').addEventListener('click', () => {
      dialog.close();
      dialog.remove();
    });

    dialog.querySelector('#attachCourseForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const courseId = dialog.querySelector('#attachCourseId').value;
      if (!courseId) return;
      
      try {
        await StudyCoreAPI.adminAttachCourse(programCode, courseId);
        showToast('Course attached successfully.', 'success');
        dialog.close();
        dialog.remove();
        await renderProgramCards();
        notifyChange();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    dialog.querySelector('#createCourseForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = dialog.querySelector('#createCourseCode').value.trim();
      const name = dialog.querySelector('#createCourseName').value.trim();
      const sharedWithCourseId = dialog.querySelector('#createCourseShared').value;
      
      try {
        const data = await StudyCoreAPI.adminCreateCourse({ code, name, programCode });
        if (sharedWithCourseId && data.course && data.course.id) {
           await StudyCoreAPI.adminUpdateCourse(data.course.id, { sharedWithCourseId });
        }
        
        if (data.attachedTo) showToast(`Course ${code} created and added.`, 'success');
        else showToast('Course created (not attached — please try again).', 'info');
        
        dialog.close();
        dialog.remove();
        await renderProgramCards();
        notifyChange();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  async function promptCreateProgram() {
    const code = prompt('Program code (2–12 letters/numbers, e.g. MED, ENG):');
    if (!code) return;
    const name = prompt('Full program name (e.g. School of Medicine):');
    if (!name) return;
    try {
      await StudyCoreAPI.adminCreateProgram({ code: code.trim().toUpperCase(), name: name.trim() });
      showToast('Program created. Now add courses to it.', 'success');
      await renderProgramCards();
      notifyChange();
    } catch (err) { showToast(err.message, 'error'); }
  }

  function notifyChange() {
    if (typeof window.__adminProgramsChanged === 'function') window.__adminProgramsChanged();
  }

  // ---- Program filter chips for the resource table ----
  function renderFilterChips(active, onChange) {
    const container = document.getElementById('adminProgramFilters');
    const chips = [{ code: '', label: 'ALL' }].concat(
      SCPrograms.FILTER_ORDER.map((code) => ({ code, label: SCPrograms.programShortName(code) }))
    );
    container.innerHTML = chips.map((c) =>
      `<button class="program-chip ${active === c.code ? 'active' : ''}" data-filter-program="${c.code}">${escapeHtml(c.label)}</button>`
    ).join('');
    container.querySelectorAll('[data-filter-program]').forEach((btn) =>
      btn.addEventListener('click', () => onChange(btn.getAttribute('data-filter-program'))));
  }

  global.SCAdminPrograms = {
    loadPrograms,
    get programs() { return programs; },
    get globalCourses() { return globalCourses; },
    setupResourceForm,
    setupAnnouncementForm,
    targetingCheckboxesHtml,
    readTargeting,
    wireTargetingBehavior,
    targetBadge,
    renderProgramCards,
    promptCreateProgram,
    renderFilterChips
  };
})(window);
