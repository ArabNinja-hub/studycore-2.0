// =============================================
// STUDYCORE — Shared Quiz Builder (js/quiz-admin.js)
// ---------------------------------------------
// Used by BOTH the Main Admin and Content Admin dashboards to author
// program-targeted quizzes. A quiz is one or more questions, each a
// multiple-choice (mcq) or free-word (text) answer, optionally carrying an
// image. The whole thing is submitted as structured JSON to /api/quiz; the
// server stores it as a resource (category='quiz') so program visibility is
// inherited for free.
//
// The host page just gives us an empty container and calls
//   StudyCoreQuizAdmin.mount(rootEl, { getPrograms, loadCourses, role })
// and we render the entire management surface inside it.
// =============================================

(function (global) {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function icon(name, size) { return SC.icon(name, { size: size || 18 }); }
  function safe(value) {
    return typeof escapeHtml === 'function'
      ? escapeHtml(value)
      : String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }
  function fileSize(bytes) {
    if (!Number(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = Number(bytes); let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }
  function showToast(message, kind) {
    // Reuse the page-level toast container if it exists (admin / content-admin
    // both render one); otherwise drop a lightweight fallback.
    let host = document.getElementById('qaToastHost') || document.getElementById('caToastContainer') || document.getElementById('siteToastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'qaToastHost';
      host.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;';
      document.body.appendChild(host);
    }
    const toast = document.createElement('div');
    toast.style.cssText = `background:${kind === 'error' ? '#b91c1c' : '#0b2033'};color:#fff;padding:10px 16px;border-radius:10px;font-size:0.9rem;box-shadow:0 6px 20px rgba(0,0,0,.25);`;
    toast.textContent = message;
    host.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity .25s'; setTimeout(() => toast.remove(), 260); }, 3600);
  }

  // Per-instance state.
  const instances = new WeakMap();

  function uid() { return 'q-' + Math.random().toString(36).slice(2, 9); }

  function flattenCourses(programs) {
    const out = [];
    (programs || []).forEach((p) => {
      (p.courses || []).forEach((c) => out.push({
        id: c.id, code: c.code, name: c.name, programCode: p.code, programName: p.name
      }));
    });
    return out;
  }

  function targetBadgeLabel(quiz) {
    if (quiz.targetAll) return 'All Programs';
    if (!quiz.programCodes || !quiz.programCodes.length) return 'No audience';
    return quiz.programCodes.join(', ');
  }

  // Render the list of existing quizzes + the "new" affordance.
  function renderList(root) {
    const st = instances.get(root);
    const listEl = $('#qaList', root);
    if (!st.quizzes.length) {
      listEl.innerHTML = `
        <div class="qa-empty">
          ${icon('circle-help', 30)}
          <h3>No quizzes yet</h3>
          <p>${safe(st.role === 'content_admin' ? 'Create your first quiz for your program’s students.' : 'Create a quiz to start testing your students.')}</p>
          <button class="btn btn-primary btn-sm" id="qaEmptyNew">${icon('plus')} Create your first quiz</button>
        </div>`;
      $('#qaEmptyNew', root).addEventListener('click', () => startEditor(root, null));
      return;
    }
    listEl.innerHTML = st.quizzes.map((quiz) => `
      <article class="qa-card">
        <span class="qa-card-icon">${icon('circle-help', 20)}</span>
        <div class="qa-card-body">
          <strong>${safe(quiz.title)}</strong>
          <span>${quiz.questionCount} question${quiz.questionCount === 1 ? '' : 's'} · ${quiz.totalPoints} pt${quiz.totalPoints === 1 ? '' : 's'} · <span class="qa-target">${safe(targetBadgeLabel(quiz))}</span> · ${quiz.publishStatus === 'draft' ? 'Draft' : 'Published'}</span>
        </div>
        <div class="qa-card-actions">
          <button class="btn btn-outline btn-sm" data-qa-edit="${safe(quiz.id)}">${icon('edit', 14)} Edit</button>
          <button class="btn btn-ghost btn-sm" data-qa-delete="${safe(quiz.id)}" style="color:var(--red-600);">${icon('trash', 15)}</button>
        </div>
      </article>`).join('');

    $$('[data-qa-edit]', root).forEach((btn) => btn.addEventListener('click', () => startEditor(root, btn.getAttribute('data-qa-edit'))));
    $$('[data-qa-delete]', root).forEach((btn) => btn.addEventListener('click', (e) => deleteQuiz(root, e.currentTarget.getAttribute('data-qa-delete'))));
  }

  async function loadQuizzes(root) {
    const st = instances.get(root);
    const listEl = $('#qaList', root);
    listEl.innerHTML = '<p class="qa-loading">Loading quizzes…</p>';
    try {
      const { quizzes } = await StudyCoreAPI.quizListMine();
      st.quizzes = quizzes || [];
    } catch (err) {
      st.quizzes = [];
      showToast(err.message || 'Could not load quizzes.', 'error');
    }
    renderList(root);
  }

  function programCheckboxes(root, selected, targetAll) {
    const st = instances.get(root);
    const opts = (st.programs || []).map((p) => {
      const checked = !targetAll && selected.includes(p.code) ? 'checked' : '';
      return `<label class="qa-prog"><input type="checkbox" class="qa-prog-cb" value="${safe(p.code)}" ${checked}/> ${safe(p.name)}</label>`;
    }).join('');
    return `
      <label class="qa-prog qa-prog-all"><input type="checkbox" id="qaAllPrograms" ${targetAll ? 'checked' : ''}/> All Programs (every student)</label>
      <div class="qa-prog-grid">${opts}</div>`;
  }

  function questionEditorHtml(q, index) {
    const id = q.id || uid();
    const type = q.type === 'text' ? 'text' : 'mcq';
    const points = q.points || 1;
    const imageBlock = q.image
      ? `<div class="qa-q-img"><img src="${StudyCoreAPI.quizImageUrl(q.image)}" alt="Question image" /><button type="button" class="qa-q-img-remove" data-rm-img="${safe(q.image)}">${icon('x', 14)} Remove image</button></div>`
      : `<div class="qa-q-img-none"><button type="button" class="btn btn-outline btn-sm qa-q-img-add">${icon('image', 15)} Add image</button></div>`;

    let answerBlock;
    if (type === 'mcq') {
      const multiple = Boolean(q.multiple);
      const correct = Array.isArray(q.correct) ? q.correct : (typeof q.correct === 'number' ? [q.correct] : []);
      const options = q.options && q.options.length ? q.options : [''];
      answerBlock = `
        <label class="qa-inline"><input type="checkbox" class="qa-mcq-multiple" ${multiple ? 'checked' : ''}/> Allow multiple correct answers</label>
        <div class="qa-options">
          ${options.map((opt, i) => `
            <div class="qa-option-row" data-index="${i}">
              <input type="${multiple ? 'checkbox' : 'radio'}" name="qa-correct-${id}" class="qa-option-correct" value="${i}" ${correct.includes(i) ? 'checked' : ''}/>
              <input type="text" class="qa-option-text" placeholder="Option ${i + 1}" value="${safe(opt)}"/>
              <button type="button" class="qa-option-remove" aria-label="Remove option">${icon('x', 14)}</button>
            </div>`).join('')}
        </div>
        <button type="button" class="btn btn-outline btn-sm qa-option-add">${icon('plus', 14)} Add option</button>`;
    } else {
      const answers = q.answers && q.answers.length ? q.answers : [''];
      const caseSensitive = Boolean(q.caseSensitive);
      answerBlock = `
        <label class="qa-inline"><input type="checkbox" class="qa-text-case" ${caseSensitive ? 'checked' : ''}/> Case-sensitive matching</label>
        <div class="qa-answers">
          ${answers.map((a) => `
            <div class="qa-answer-row">
              <input type="text" class="qa-answer-text" placeholder="Accepted answer" value="${safe(a)}"/>
              <button type="button" class="qa-answer-remove" aria-label="Remove answer">${icon('x', 14)}</button>
            </div>`).join('')}
        </div>
        <button type="button" class="btn btn-outline btn-sm qa-answer-add">${icon('plus', 14)} Add accepted answer</button>
        <p class="qa-hint">Students get it right if their answer matches any accepted answer (ignoring case by default).</p>`;
    }

    const typeLabel = type === 'mcq' ? 'Multiple choice' : 'Word answer';
    return `
      <div class="qa-question" data-qid="${safe(id)}" data-index="${index}">
        <div class="qa-question-head">
          <strong>Question ${index + 1}</strong>
          <div style="display:flex;gap:8px;align-items:center;">
            <select class="qa-q-type" style="padding:6px 10px;border-radius:8px;border:1.5px solid var(--border-strong);background:var(--card);font-size:0.82rem;">
              <option value="mcq" ${type === 'mcq' ? 'selected' : ''}>Multiple choice</option>
              <option value="text" ${type === 'text' ? 'selected' : ''}>Word answer</option>
            </select>
            <button type="button" class="qa-q-remove" aria-label="Remove question" style="color:var(--red-600);">${icon('trash', 15)}</button>
          </div>
        </div>
        <div class="qa-form-row">
          <label>Question / prompt</label>
          <textarea class="qa-q-prompt" rows="2" placeholder="e.g. What gas do plants absorb during photosynthesis?">${safe(q.prompt || '')}</textarea>
        </div>
        ${imageBlock}
        <div class="qa-form-row">
          <label>Answer</label>
          <div class="qa-answer-block" data-type="${type}">${answerBlock}</div>
        </div>
        <div class="qa-form-row qa-points-row">
          <label>Points</label>
          <input type="number" class="qa-q-points" min="1" max="100" value="${points}" style="width:90px;padding:6px 10px;border-radius:8px;border:1.5px solid var(--border-strong);"/>
        </div>
      </div>`;
  }

  function renderQuestions(root) {
    const st = instances.get(root);
    const host = $('#qaQuestions', root);
    host.innerHTML = st.questions.map((q, i) => questionEditorHtml(q, i)).join('');
    wireQuestionEvents(root);
  }

  function readQuestionsFromDom(root) {
    const st = instances.get(root);
    const host = $('#qaQuestions', root);
    st.questions = $$('.qa-question', host).map((el) => {
      const type = $('.qa-q-type', el).value;
      const q = {
        id: el.getAttribute('data-qid'),
        type,
        prompt: $('.qa-q-prompt', el).value.trim(),
        points: Math.max(1, Number($('.qa-q-points', el).value) || 1),
        image: el.getAttribute('data-image') || null
      };
      if (type === 'mcq') {
        q.multiple = $('.qa-mcq-multiple', el).checked;
        q.options = $$('.qa-option-text', el).map((i) => i.value.trim()).filter(Boolean);
        const correct = $$('.qa-option-correct:checked', el).map((i) => Number(i.value));
        q.correct = correct;
      } else {
        q.caseSensitive = $('.qa-text-case', el).checked;
        q.answers = $$('.qa-answer-text', el).map((i) => i.value.trim()).filter(Boolean);
      }
      return q;
    });
  }

  function wireQuestionEvents(root) {
    const host = $('#qaQuestions', root);
    $$('.qa-question', host).forEach((el) => {
      // type switch -> re-render just this question
      $('.qa-q-type', el).addEventListener('change', () => {
        const type = $('.qa-q-type', el).value;
        const q = questionsFromEl(el);
        q.type = type;
        if (type === 'mcq') { q.options = q.options && q.options.length ? q.options : ['']; q.correct = []; q.multiple = false; delete q.answers; delete q.caseSensitive; }
        else { q.answers = q.answers && q.answers.length ? q.answers : ['']; q.caseSensitive = false; delete q.options; delete q.correct; delete q.multiple; }
        const idx = Number(el.getAttribute('data-index'));
        instances.get(root).questions[idx] = q;
        renderQuestions(root);
      });
      $('.qa-q-remove', el).addEventListener('click', () => {
        const idx = Number(el.getAttribute('data-index'));
        const arr = instances.get(root).questions;
        arr.splice(idx, 1);
        renderQuestions(root);
      });
      // image add
      const addImg = $('.qa-q-img-add', el);
      if (addImg) addImg.addEventListener('click', () => uploadQuestionImage(root, el));
      const rmImg = $('.qa-q-img-remove', el);
      if (rmImg) rmImg.addEventListener('click', () => {
        const idx = Number(el.getAttribute('data-index'));
        delete instances.get(root).questions[idx].image;
        renderQuestions(root);
      });
      // mcq options add/remove
      const optAdd = $('.qa-option-add', el);
      if (optAdd) optAdd.addEventListener('click', () => {
        const idx = Number(el.getAttribute('data-index'));
        const q = instances.get(root).questions[idx];
        q.options = q.options || []; q.options.push('');
        renderQuestions(root);
      });
      $$('.qa-option-remove', el).forEach((b) => b.addEventListener('click', () => {
        const idx = Number(el.getAttribute('data-index'));
        const oi = Number(b.closest('.qa-option-row').getAttribute('data-index'));
        const q = instances.get(root).questions[idx];
        q.options.splice(oi, 1);
        if (!q.options.length) q.options = [''];
        renderQuestions(root);
      }));
      // text answers add/remove
      const ansAdd = $('.qa-answer-add', el);
      if (ansAdd) ansAdd.addEventListener('click', () => {
        const idx = Number(el.getAttribute('data-index'));
        const q = instances.get(root).questions[idx];
        q.answers = q.answers || []; q.answers.push('');
        renderQuestions(root);
      });
      $$('.qa-answer-remove', el).forEach((b) => b.addEventListener('click', () => {
        const idx = Number(el.getAttribute('data-index'));
        const q = instances.get(root).questions[idx];
        const ai = b.closest('.qa-answer-row');
        const rows = $$('.qa-answer-row', el);
        const aiIdx = rows.indexOf(ai);
        q.answers.splice(aiIdx, 1);
        if (!q.answers.length) q.answers = [''];
        renderQuestions(root);
      }));
    });
  }

  function questionsFromEl(el) {
    const type = $('.qa-q-type', el).value;
    const q = { id: el.getAttribute('data-qid'), type, prompt: $('.qa-q-prompt', el).value.trim(), points: Number($('.qa-q-points', el).value) || 1, image: el.getAttribute('data-image') || null };
    if (type === 'mcq') {
      q.multiple = $('.qa-mcq-multiple', el).checked;
      q.options = $$('.qa-option-text', el).map((i) => i.value.trim());
      q.correct = $$('.qa-option-correct:checked', el).map((i) => Number(i.value));
    } else {
      q.caseSensitive = $('.qa-text-case', el).checked;
      q.answers = $$('.qa-answer-text', el).map((i) => i.value.trim());
    }
    return q;
  }

  async function uploadQuestionImage(root, el) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const btn = $('.qa-q-img-add', el) || el;
      const orig = btn.innerHTML;
      try {
        if (btn.classList && btn.classList.contains('qa-q-img-add')) btn.innerHTML = 'Uploading…';
        const { key } = await StudyCoreAPI.quizUploadImage(file);
        const idx = Number(el.getAttribute('data-index'));
        instances.get(root).questions[idx].image = key;
        el.setAttribute('data-image', key);
        renderQuestions(root);
        showToast('Image added.', 'success');
      } catch (err) {
        showToast(err.message || 'Image upload failed.', 'error');
        if (btn.classList && btn.classList.contains('qa-q-img-add')) btn.innerHTML = orig;
      }
    });
    input.click();
  }

  function startEditor(root, id) {
    const st = instances.get(root);
    st.editingId = id;
    st.questions = [];
    const editor = $('#qaEditor', root);
    const listWrap = $('#qaListWrap', root);

    if (id) {
      editor.innerHTML = '<p class="qa-loading">Loading quiz…</p>';
      editor.style.display = '';
      if (listWrap) listWrap.style.display = 'none';
      StudyCoreAPI.quizGetForEdit(id).then(({ quiz }) => {
        st.questions = (quiz.questions || []).map((q) => ({ ...q }));
        renderEditorBody(root, quiz);
      }).catch((err) => {
        showToast(err.message || 'Could not load quiz.', 'error');
        editor.style.display = 'none';
        if (listWrap) listWrap.style.display = '';
      });
    } else {
      st.questions = [{ id: uid(), type: 'mcq', prompt: '', options: ['', ''], correct: [], multiple: false, points: 1 }];
      renderEditorBody(root, { title: '', description: '', targetAll: false, programCodes: [], courseId: null, publishStatus: 'published', passingPercent: 50 });
      editor.style.display = '';
      if (listWrap) listWrap.style.display = 'none';
    }
  }

  function renderEditorBody(root, quiz) {
    const st = instances.get(root);
    const editor = $('#qaEditor', root);
    editor.innerHTML = `
      <div class="qa-editor-card">
        <div class="qa-editor-head">
          <h3>${st.editingId ? 'Edit quiz' : 'New quiz'}</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="qaCancel">Cancel</button>
        </div>
        <div class="qa-form-row">
          <label>Quiz title <span class="qa-req">*</span></label>
          <input type="text" id="qaTitle" maxlength="180" placeholder="e.g. Cell Biology Midterm Practice" value="${safe(quiz.title || '')}"/>
        </div>
        <div class="qa-form-row">
          <label>Description <span style="color:var(--muted);font-weight:400;">(optional)</span></label>
          <textarea id="qaDesc" rows="2" maxlength="5000" placeholder="A short note students see before starting">${safe(quiz.description || '')}</textarea>
        </div>
        <div class="qa-form-row">
          <label>Students it's for</label>
          <div id="qaTarget">${programCheckboxes(root, quiz.programCodes || [], Boolean(quiz.targetAll))}</div>
        </div>
        <div class="qa-form-row" id="qaCourseRow"></div>
        <div class="qa-form-row qa-inline-row">
          <label for="qaPassing">Passing score (%)</label>
          <input type="number" id="qaPassing" min="0" max="100" value="${Number(quiz.passingPercent ?? 50)}" style="width:90px;padding:6px 10px;border-radius:8px;border:1.5px solid var(--border-strong);"/>
          <select id="qaStatus" style="margin-left:auto;padding:6px 10px;border-radius:8px;border:1.5px solid var(--border-strong);background:var(--card);">
            <option value="published" ${quiz.publishStatus === 'published' ? 'selected' : ''}>Published</option>
            <option value="draft" ${quiz.publishStatus === 'draft' ? 'selected' : ''}>Draft</option>
          </select>
        </div>
        <div class="qa-questions-head">
          <h4>Questions</h4>
          <button type="button" class="btn btn-outline btn-sm" id="qaAddQuestion">${icon('plus', 14)} Add question</button>
        </div>
        <div id="qaQuestions" class="qa-questions"></div>
        <div id="qaEditorError" class="qa-error" role="alert"></div>
        <div class="qa-editor-actions">
          <button type="button" class="btn btn-primary" id="qaSave">${st.editingId ? 'Save changes' : 'Create quiz'}</button>
        </div>
      </div>`;

    renderQuestions(root);
    renderCourseSelect(root, quiz.courseId || null);
    wireEditorEvents(root);
  }

  function renderCourseSelect(root, selectedId) {
    const st = instances.get(root);
    const row = $('#qaCourseRow', root);
    if (!row || !st.courses || !st.courses.length) { if (row) row.innerHTML = ''; return; }
    const grouped = st.courses.map((c) => `<option value="${safe(c.id)}" ${c.id === selectedId ? 'selected' : ''}>${safe(c.code)} — ${safe(c.name)}</option>`).join('');
    row.innerHTML = `
      <label>Link to a course <span style="color:var(--muted);font-weight:400;">(optional)</span></label>
      <select id="qaCourse" style="width:100%;padding:9px 12px;border-radius:10px;border:1.5px solid var(--border-strong);background:var(--card);">
        <option value="">No specific course (program-wide)</option>
        ${grouped}
      </select>`;
  }

  function wireEditorEvents(root) {
    const st = instances.get(root);
    $('#qaCancel', root).addEventListener('click', () => closeEditor(root));
    $('#qaAddQuestion', root).addEventListener('click', () => {
      st.questions.push({ id: uid(), type: 'mcq', prompt: '', options: ['', ''], correct: [], multiple: false, points: 1 });
      renderQuestions(root);
      const host = $('#qaQuestions', root);
      host.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
    $('#qaSave', root).addEventListener('click', () => saveQuiz(root));

    // "All Programs" toggles the per-program checkboxes.
    const allCb = $('#qaAllPrograms', root);
    if (allCb) allCb.addEventListener('change', () => {
      $$('.qa-prog-cb', root).forEach((cb) => { cb.checked = false; cb.disabled = allCb.checked; });
    });
  }

  async function saveQuiz(root) {
    const st = instances.get(root);
    readQuestionsFromDom(root);
    const errEl = $('#qaEditorError', root);
    errEl.textContent = '';

    const title = $('#qaTitle', root).value.trim();
    if (!title) { errEl.textContent = 'Add a quiz title.'; return; }

    const allPrograms = $('#qaAllPrograms', root) ? $('#qaAllPrograms', root).checked : false;
    const programs = allPrograms ? [] : $$('.qa-prog-cb:checked', root).map((cb) => cb.value);
    if (!allPrograms && !programs.length) { errEl.textContent = 'Choose at least one program (or All Programs).'; return; }

    const questions = st.questions;
    if (!questions.length) { errEl.textContent = 'Add at least one question.'; return; }
    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i];
      if (!q.prompt) { errEl.textContent = `Question ${i + 1} needs a prompt.`; return; }
      if (q.type === 'mcq') {
        if (!q.options || q.options.length < 2) { errEl.textContent = `Question ${i + 1} needs at least two options.`; return; }
        if (!q.correct || !q.correct.length) { errEl.textContent = `Question ${i + 1} needs a marked correct answer.`; return; }
      } else if (!q.answers || !q.answers.length) {
        errEl.textContent = `Question ${i + 1} needs at least one accepted answer.`; return;
      }
    }

    const payload = {
      title,
      description: $('#qaDesc', root).value.trim(),
      targetAll: allPrograms,
      programs,
      courseId: ($('#qaCourse', root) && $('#qaCourse', root).value) || null,
      publishStatus: $('#qaStatus', root).value,
      passingPercent: Number($('#qaPassing', root).value || 50),
      questions
    };

    const btn = $('#qaSave', root);
    btn.disabled = true;
    try {
      if (st.editingId) await StudyCoreAPI.quizUpdate(st.editingId, payload);
      else await StudyCoreAPI.quizCreate(payload);
      showToast(st.editingId ? 'Quiz updated.' : 'Quiz created.', 'success');
      closeEditor(root);
      await loadQuizzes(root);
    } catch (err) {
      errEl.textContent = err.message || 'Could not save the quiz.';
      showToast(err.message || 'Could not save the quiz.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function closeEditor(root) {
    const st = instances.get(root);
    st.editingId = null;
    const editor = $('#qaEditor', root);
    editor.style.display = 'none';
    editor.innerHTML = '';
    const listWrap = $('#qaListWrap', root);
    if (listWrap) listWrap.style.display = '';
  }

  async function deleteQuiz(root, id) {
    const st = instances.get(root);
    const quiz = st.quizzes.find((q) => q.id === id);
    if (!window.confirm(`Delete “${quiz ? quiz.title : 'this quiz'}”? This cannot be undone.`)) return;
    try {
      await StudyCoreAPI.quizDelete(id);
      showToast('Quiz deleted.', 'success');
      await loadQuizzes(root);
    } catch (err) {
      showToast(err.message || 'Could not delete the quiz.', 'error');
    }
  }

  const StudyCoreQuizAdmin = {
    async mount(root, options) {
      if (typeof root === 'string') root = document.querySelector(root);
      if (!root) return;
      const opts = options || {};
      const st = { role: opts.role || 'admin', programs: [], courses: [], quizzes: [], questions: [], editingId: null };
      instances.set(root, st);

      root.classList.add('quiz-admin');
      root.innerHTML = `
        <div id="qaToolbar" class="qa-toolbar">
          <button class="btn btn-primary btn-sm" id="qaNew">${icon('plus', 15)} New Quiz</button>
        </div>
        <div id="qaListWrap">
          <div id="qaList"><p class="qa-loading">Loading quizzes…</p></div>
        </div>
        <div id="qaEditor" style="display:none;"></div>`;

      $('#qaNew', root).addEventListener('click', () => startEditor(root, null));

      try {
        const progs = await opts.getPrograms();
        st.programs = progs || [];
      } catch { st.programs = []; }
      try {
        const courses = opts.loadCourses ? await opts.loadCourses() : [];
        st.courses = courses || [];
      } catch { st.courses = []; }

      await loadQuizzes(root);
    }
  };

  global.StudyCoreQuizAdmin = StudyCoreQuizAdmin;
})(window);
