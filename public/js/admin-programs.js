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
          ${courses.length ? courses.map((c) => `
            <div class="program-course-line">
              <span><strong>${escapeHtml(c.code)}</strong> — ${escapeHtml(c.name)}</span>
              <span style="display:inline-flex;gap:4px;flex-shrink:0;">
                <button class="icon-btn" data-detach-course="${p.code}|${c.id}" title="Remove from this program" style="width:28px;height:28px;color:var(--red-600);">${SC.icon('x', { size: 14 })}</button>
              </span>
            </div>`).join('') : '<p style="font-size:0.84rem;color:var(--muted);margin:6px 0;">No courses yet — add one below.</p>'}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          <button class="btn btn-outline btn-sm" data-add-course-to="${p.code}">${SC.icon('plus', { size: 13 })} Add course</button>
          <button class="btn btn-ghost btn-sm" data-delete-program="${p.code}" style="color:var(--red-600);">${SC.icon('trash', { size: 13 })} Delete</button>
        </div>
      </div>`;
    }).join('');

    grid.querySelectorAll('[data-add-course-to]').forEach((btn) => btn.addEventListener('click', () => promptAddCourse(btn.getAttribute('data-add-course-to'))));
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

  // Add a course: choose "new" (code + name) or attach an existing one.
  async function promptAddCourse(programCode) {
    const allCourses = globalCourses;
    const existingCodes = new Set((programs.find((p) => p.code === programCode)?.courses || []).map((c) => c.id));
    const attachable = allCourses.filter((c) => !existingCodes.has(c.id));

    const choice = prompt(
      `Add a course to ${programCode}.\n\n` +
      `• Type a NEW course code and name as  CODE | Name  (e.g. BS100 | Introduction to Business) to create it.\n` +
      `• Or type an EXISTING course code to attach it: ${attachable.map((c) => c.code).join(', ') || '(none available)'}`
    );
    if (!choice || !choice.trim()) return;
    const input = choice.trim();

    try {
      if (input.includes('|')) {
        const [code, ...rest] = input.split('|');
        const name = rest.join('|').trim();
        if (!code.trim() || !name) { showToast('Use the format CODE | Name.', 'error'); return; }
        const data = await StudyCoreAPI.adminCreateCourse({ code: code.trim(), name, programCode });
        if (data.attachedTo) showToast(`Course ${code.trim()} created and added.`, 'success');
        else showToast('Course created (not attached — please try again).', 'info');
      } else {
        const course = attachable.find((c) => c.code.toUpperCase() === input.toUpperCase()) ||
                       globalCourses.find((c) => c.code.toUpperCase() === input.toUpperCase());
        if (!course) { showToast(`No existing course with code "${input}". Create one with CODE | Name.`, 'error'); return; }
        await StudyCoreAPI.adminAttachCourse(programCode, course.id);
        showToast(`${course.code} added to ${programCode}.`, 'success');
      }
      await renderProgramCards();
      notifyChange();
    } catch (err) { showToast(err.message, 'error'); }
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
