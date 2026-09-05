// =============================================
// STUDYCORE — Student Quizzes (js/quiz.js)
// ---------------------------------------------
// The student-facing quiz experience on /quiz.html.
//   - Lists the quizzes targeted at the signed-in student's program.
//   - Opens a quiz and lets the student answer (MCQ or free-word, with images).
//   - Submits the attempt; the server grades it and returns a full breakdown.
//   - Shows the graded result per question and tracks best score.
// Nothing here writes correct answers to the page — scoring is server-side.
// =============================================

(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  function icon(name, size) { return SC.icon(name, { size: size || 18 }); }
  function safe(v) {
    return typeof escapeHtml === 'function'
      ? escapeHtml(v)
      : String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }
  function timeAgo(iso) {
    if (!iso) return '';
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function showToast(message, kind) {
    let host = document.getElementById('quizToastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'quizToastHost';
      host.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.style.cssText = `background:${kind === 'error' ? '#b91c1c' : '#0b2033'};color:#fff;padding:10px 16px;border-radius:10px;font-size:0.9rem;box-shadow:0 6px 20px rgba(0,0,0,.25);`;
    t.textContent = message;
    host.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; setTimeout(() => t.remove(), 260); }, 3600);
  }

  function targetLabel(quiz) {
    if (quiz.targetAll) return 'All Programs';
    if (quiz.programCodes && quiz.programCodes.length) return quiz.programCodes.join(', ');
    return '—';
  }

  let currentUser = null;

  async function boot() {
    currentUser = await StudyCoreAuth.fetchSession();
    if (!currentUser || !(StudyCoreAuth.isStudent(currentUser) || StudyCoreAuth.isAdmin(currentUser))) {
      window.location.href = '/login.html';
      return;
    }
    loadList();
  }

  function bindBack() {
    const back = $('#quizBack');
    if (back) back.addEventListener('click', loadList);
  }

  async function loadList() {
    const view = $('#quizView');
    view.innerHTML = '<div id="quizList" class="quiz-grid"><p class="loading-text">Loading your quizzes…</p></div>';
    try {
      const { quizzes } = await StudyCoreAPI.quizAvailable();
      if (!quizzes.length) {
        view.innerHTML = emptyState();
        return;
      }
      const grid = $('#quizList', view);
      grid.innerHTML = quizzes.map(cardHtml).join('');
      $$('[data-start]', grid).forEach((b) => b.addEventListener('click', () => startQuiz(b.getAttribute('data-start'))));
    } catch (err) {
      view.innerHTML = `<div id="quizList" class="quiz-grid"><p class="quiz-error">${safe(err.message)}</p><button class="btn btn-outline btn-sm" id="quizBack">Back</button></div>`;
      bindBack();
    }
  }

  function emptyState() {
    return `
      <div class="quiz-empty">
        ${icon('circle-help', 32)}
        <h3>No quizzes for your program yet</h3>
        <p>Your Content Admin or the StudyCore team will post quizzes targeted at your program. Check back soon — they will appear here automatically.</p>
        <button class="btn btn-outline btn-sm" id="quizBack" onclick="location.reload()">Refresh</button>
      </div>`;
  }

  function cardHtml(quiz) {
    // Premium-gated: non-premium students see the card but cannot start it.
    if (quiz.locked) {
      return `
        <article class="quiz-card locked">
          <div class="quiz-card-icon">${icon('lock', 22)}</div>
          <div class="quiz-card-body">
            <h3>${safe(quiz.title)}</h3>
            ${quiz.description ? `<p>${safe(quiz.description)}</p>` : ''}
            <div class="quiz-card-meta">
              <span class="quiz-pill">${quiz.questionCount} Q · ${quiz.totalPoints} pts</span>
              <span class="quiz-pill" style="background:#fdf6e3;color:#a16207;border-color:#fde68a;">Premium</span>
              <span class="quiz-pill">${safe(targetLabel(quiz))}</span>
            </div>
          </div>
          <div class="quiz-card-actions">
            <a class="btn btn-amber btn-sm" href="/pages/pricing.html">${icon('crown', 14)} Upgrade</a>
          </div>
        </article>`;
    }
    const attempted = quiz.attempts > 0;
    const best = Number(quiz.bestPercent) || 0;
    const passing = Number(quiz.passingPercent ?? 50);
    const meta = [];
    if (attempted) meta.push(`<span class="quiz-pill ${best >= passing ? 'passed' : 'failed'}">Best ${best}%</span>`);
    meta.push(`<span class="quiz-pill">${quiz.questionCount} Q · ${quiz.totalPoints} pts</span>`);
    meta.push(`<span class="quiz-pill">${safe(targetLabel(quiz))}</span>`);
    const last = quiz.lastAttemptAt ? `<span style="font-size:0.78rem;color:var(--muted);">Last attempt ${timeAgo(quiz.lastAttemptAt)}</span>` : '';
    return `
      <article class="quiz-card">
        <div class="quiz-card-icon">${icon('circle-help', 22)}</div>
        <div class="quiz-card-body">
          <h3>${safe(quiz.title)}</h3>
          ${quiz.description ? `<p>${safe(quiz.description)}</p>` : ''}
          <div class="quiz-card-meta">${meta.join('')}</div>
          ${last}
        </div>
        <div class="quiz-card-actions">
          <button class="btn btn-primary" data-start="${safe(quiz.id)}">${attempted ? 'Retake quiz' : 'Start quiz'}</button>
        </div>
      </article>`;
  }

  async function startQuiz(id) {
    const view = $('#quizView');
    view.innerHTML = '<p class="loading-text">Loading quiz…</p>';
    try {
      const quiz = await StudyCoreAPI.quizTake(id);
      renderTake(quiz);
    } catch (err) {
      if (err.locked || err.status === 403) return renderLocked(err.message);
      view.innerHTML = `<p class="quiz-error">${safe(err.message)}</p><button class="btn btn-outline btn-sm" id="quizBack">Back to quizzes</button>`;
      bindBack();
    }
  }

  function renderLocked(message) {
    const view = $('#quizView');
    view.innerHTML = `
      <div class="quiz-locked">
        <div class="quiz-locked-icon">${icon('crown', 34)}</div>
        <h2>Premium feature</h2>
        <p>${safe(message || 'Quizzes are a Premium feature. Upgrade your plan to test yourself with program-targeted quizzes.')}</p>
        <div class="quiz-result-actions">
          <a class="btn btn-amber" href="/pages/pricing.html">${icon('crown', 15)} See Premium plans</a>
          <button class="btn btn-outline" id="quizBack">Back to quizzes</button>
        </div>
      </div>`;
    bindBack();
  }

  function renderTake(quiz) {
    const view = $('#quizView');
    const questionsHtml = quiz.questions.map((q, i) => questionTakeHtml(q, i)).join('');
    view.innerHTML = `
      <div class="quiz-take">
        <div class="quiz-take-head">
          <button class="btn btn-ghost btn-sm" id="quizExit">${icon('arrow-left', 15)} Exit</button>
          <div class="quiz-take-title">
            <h2>${safe(quiz.title)}</h2>
            <p>${quiz.questionCount} question${quiz.questionCount === 1 ? '' : 's'} · ${quiz.totalPoints} point${quiz.totalPoints === 1 ? '' : 's'} · pass at ${quiz.passingPercent}%</p>
          </div>
        </div>
        <form id="quizForm" class="quiz-questions">
          ${questionsHtml}
          <div class="quiz-submit-row">
            <button type="submit" class="btn btn-primary" id="quizSubmit">${icon('check-list', 16)} Submit answers</button>
          </div>
        </form>
      </div>`;

    $('#quizExit', view).addEventListener('click', loadList);
    $('#quizForm', view).addEventListener('submit', (e) => {
      e.preventDefault();
      submitAttempt(quiz);
    });
  }

  function questionTakeHtml(q, index) {
    const image = q.image
      ? `<div class="quiz-q-img"><img src="${StudyCoreAPI.quizImageUrl(q.image)}" alt="Question image" /></div>`
      : '';
    let input;
    if (q.type === 'mcq') {
      const inputType = q.multiple ? 'checkbox' : 'radio';
      input = `<div class="quiz-options">${q.options.map((opt, oi) => `
        <label class="quiz-option">
          <input type="${inputType}" name="q_${safe(q.id)}" value="${oi}" />
          <span>${safe(opt)}</span>
        </label>`).join('')}</div>`;
    } else {
      input = `<input type="text" class="quiz-text-input" id="q_${safe(q.id)}" placeholder="Type your answer" autocomplete="off" />`;
    }
    const tag = q.type === 'mcq'
      ? `<span class="quiz-q-tag">${q.multiple ? 'Select all that apply' : 'Choose one'}</span>`
      : `<span class="quiz-q-tag">${icon('edit', 13)} Write your answer</span>`;
    return `
      <div class="quiz-question" data-qid="${safe(q.id)}">
        <div class="quiz-q-head">
          <span class="quiz-q-num">${index + 1}</span>
          <div>
            <strong>${safe(q.prompt)}</strong>
            <span class="quiz-q-points">${q.points} pt${q.points === 1 ? '' : 's'}</span>
          </div>
          ${tag}
        </div>
        ${image}
        ${input}
      </div>`;
  }

  async function submitAttempt(quiz) {
    const btn = $('#quizSubmit');
    btn.disabled = true;
    const answers = quiz.questions.map((q) => {
      if (q.type === 'mcq') {
        const picked = $$(`input[name="q_${q.id}"]:checked`).map((i) => Number(i.value));
        return { questionId: q.id, value: picked };
      }
      const el = document.getElementById(`q_${q.id}`);
      return { questionId: q.id, value: el ? el.value : '' };
    });

    try {
      const result = await StudyCoreAPI.quizSubmitAttempt(quiz.id, { answers });
      renderResult(quiz, result);
    } catch (err) {
      btn.disabled = false;
      if (err.locked || err.status === 403) return renderLocked(err.message);
      showToast(err.message || 'Could not submit the attempt.', 'error');
    }
  }

  function renderResult(quiz, result) {
    const view = $('#quizView');
    const passed = result.passed;
    const resultsHtml = result.results.map((r, i) => resultRowHtml(r, i)).join('');
    view.innerHTML = `
      <div class="quiz-result">
        <div class="quiz-score-card ${passed ? 'passed' : 'failed'}">
          <div class="quiz-score-icon">${icon(passed ? 'trophy' : 'medal', 34)}</div>
          <div class="quiz-score-num">${result.percent}%</div>
          <div class="quiz-score-verdict">${passed ? 'Passed' : 'Keep practising'}</div>
          <div class="quiz-score-sub">You scored ${result.score} / ${result.total} · pass mark ${result.passingPercent}%</div>
        </div>
        <div class="quiz-result-list">
          <h3>Your answers</h3>
          ${resultsHtml}
        </div>
        <div class="quiz-result-actions">
          <button class="btn btn-outline" id="quizRetry">${icon('refresh', 15)} Retake quiz</button>
          <button class="btn btn-primary" id="quizBack">${icon('arrow-left', 15)} Back to quizzes</button>
        </div>
      </div>`;
    $('#quizBack', view).addEventListener('click', loadList);
    $('#quizRetry', view).addEventListener('click', () => startQuiz(quiz.id));
  }

  function resultRowHtml(r, index) {
    const image = r.image
      ? `<div class="quiz-q-img"><img src="${StudyCoreAPI.quizImageUrl(r.image)}" alt="Question image" /></div>`
      : '';
    let yourAnswer, correctAnswer;
    if (r.type === 'mcq') {
      const opts = r.options || [];
      yourAnswer = (r.selected && r.selected.length)
        ? r.selected.map((i) => safe(opts[i])).join(', ')
        : '<em>No answer</em>';
      correctAnswer = (r.correct || []).map((i) => safe(opts[i])).join(', ');
    } else {
      yourAnswer = r.selected ? safe(r.selected) : '<em>No answer</em>';
      correctAnswer = (r.correct || []).map((a) => safe(a)).join(' / ');
    }
    return `
      <div class="quiz-result-row ${r.isCorrect ? 'correct' : 'wrong'}">
        <div class="quiz-result-head">
          <span class="quiz-q-num">${index + 1}</span>
          <strong>${safe(r.prompt)}</strong>
          <span class="quiz-result-badge ${r.isCorrect ? 'ok' : 'no'}">${r.isCorrect ? icon('check', 13) + ' Correct' : icon('x', 13) + ' Incorrect'}</span>
        </div>
        ${image}
        <div class="quiz-result-detail">
          <span><strong>Your answer:</strong> ${yourAnswer}</span>
          <span><strong>Correct answer:</strong> ${correctAnswer}</span>
        </div>
        ${r.explanation ? `<p class="quiz-result-exp">${safe(r.explanation)}</p>` : ''}
      </div>`;
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
