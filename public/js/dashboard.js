// =============================================
// STUDYCORE — Student Dashboard (js/dashboard.js)
// -----------------------------------------------
// The student command centre. Runs only on
// views/dashboard.html, which the server refuses
// to send to anyone who isn't a logged-in student
// (middleware/auth.js requirePageAuth).
//
// All data is real: progress, streaks,
// achievements and subscription state come from
// the database - nothing is simulated.
// =============================================

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  let user = null;
  let myProgramData = null; // { program, courses }

  function renderAvatar(slot, lg) {
    if (!slot) return;
    slot.innerHTML = StudyCoreAuth.avatarHtml(user, lg ? 'avatar-lg' : '');
    if (user && user.hasAvatar) {
      const img = slot.querySelector('img');
      if (img) img.setAttribute('style', 'width:' + (lg ? 76 : 34) + 'px;height:' + (lg ? 76 : 34) + 'px;');
    }
  }

  /* ── Welcome hero ───────────────────────── */
  function renderHero() {
    renderAvatar($('#dashAvatarSlot'), true);
    $('#dashName').textContent = `Welcome back, ${(user.name || '').split(' ')[0] || 'there'}`;
    const label = StudyCoreAuth.subscriptionLabel(user);
    const s = user.subscriptionStatus || {};
    let sub = label.label;
    if (s.state === 'premium_active' && s.subscriptionEnd) sub += ` · until ${new Date(s.subscriptionEnd).toLocaleDateString()}`;
    const programName = (myProgramData && myProgramData.program)
      ? myProgramData.program.name
      : (SCPrograms.programName(user.program) !== 'Unassigned' ? SCPrograms.programName(user.program) : null);
    const programPill = programName
      ? ` · <span class="program-pill">${SC.icon((myProgramData && myProgramData.program && myProgramData.program.icon) || SCPrograms.programIcon(user.program), { size: 13 })} ${escapeHtml(programName)}</span>`
      : '';
    $('#dashSub').innerHTML = `${escapeHtml(user.email)} · ${escapeHtml(sub)}${programPill}`;
    $('#dashHeroActions').innerHTML = `
      <a class="btn btn-amber btn-sm" href="#premium">${SC.icon('crown', { size: 15 })} Premium</a>
      <a class="btn btn-on-dark btn-sm" href="/pages/courses.html">My Courses</a>`;
  }

  /* ── Status banner ──────────────────────── */
  function renderStatusBanner() {
    const slot = $('#statusBannerSlot');
    const s = user.subscriptionStatus || {};
    let cls, icon, title, body, cta = '';
    switch (s.state) {
      case 'premium_active':
        cls = 'premium'; icon = 'crown';
        title = 'Premium Active';
        body = `You have full Premium access${s.subscriptionEnd ? ` until ${new Date(s.subscriptionEnd).toLocaleDateString()}` : ''} — all videos, notes and past papers are unlocked.`;
        break;
      case 'trial_active':
        cls = 'trial'; icon = 'sparkles';
        title = `Free Trial Active · ${s.trialDaysLeft} day${s.trialDaysLeft === 1 ? '' : 's'} left`;
        body = 'Study notes and documents are unlocked during your trial. Video lessons are Premium content.';
        cta = `<a class="btn btn-amber btn-sm" href="#premium">Upgrade Now</a>`;
        break;
      case 'payment_pending':
        cls = 'pending'; icon = 'clock';
        title = 'Payment Pending';
        body = 'We have received your payment request. Premium activates as soon as it is confirmed by the StudyCore team.';
        break;
      case 'premium_expired':
        cls = 'expired'; icon = 'crown';
        title = 'Premium Expired';
        body = 'Your Premium period has ended. Renew to keep unlimited video lessons and full access.';
        cta = `<a class="btn btn-amber btn-sm" href="#premium">Renew Premium</a>`;
        break;
      default:
        cls = 'expired'; icon = 'lock';
        title = 'Free Trial Ended';
        body = 'Your free trial has ended. Upgrade to Premium to continue with video lessons and full resource access.';
        cta = `<a class="btn btn-amber btn-sm" href="#premium">Upgrade Now</a>`;
    }
    slot.innerHTML = `
      <div class="status-banner ${cls}">
        <span class="status-icon">${SC.icon(icon, { size: 21 })}</span>
        <div style="flex:1;min-width:200px;"><strong>${title}</strong><span>${body}</span></div>
        ${cta}
      </div>`;
  }

  /* ── Continue learning ──────────────────── */
  function renderContinue(best) {
    const slot = $('#continueSlot');
    if (!best || !best.item) {
      slot.style.display = 'none';
      return;
    }
    const it = best.item;
    const courseLabel = best.course.code ? `${best.course.code} — ${best.course.name || ''}` : best.course.subject;
    const resourceRef = it.courseCode
      ? { id: it.id, category: it.category, courseCode: it.courseCode }
      : { id: it.id, category: it.category, subject: best.course.subject };
    const resume = it.videoPosition && it.videoDuration
      ? `<div class="progress progress-thin" style="margin-top:10px;"><span style="width:${Math.round((it.videoPosition / Math.max(1, it.videoDuration)) * 100)}%"></span></div>`
      : '';
    slot.innerHTML = `
      <div class="continue-card">
        <span class="cc-icon">${SC.icon(it.category === 'video' ? 'play' : 'file-text', { size: 24 })}</span>
        <span class="cc-body">
          <span class="cc-eyebrow">Continue learning · ${escapeHtml(courseLabel)}</span>
          <h4>${escapeHtml(it.title)}${it.topic ? ` <span style="font-weight:500;color:var(--muted);font-size:0.88rem;">— ${escapeHtml(it.topic)}</span>` : ''}</h4>
          ${resume}
        </span>
        <a class="btn btn-primary" href="${SC.resourceHref(resourceRef)}">Continue Lesson ${SC.icon('arrow-right', { size: 16 })}</a>
      </div>`;
  }

  /* ── My courses (driven by the student's program) ── */
  function renderMyCourses() {
    const list = $('#myCoursesList');
    if (!myProgramData) return;
    if (!myProgramData.program) {
      list.innerHTML = `
        <div style="padding:8px 4px;">
          <strong>Select your program</strong>
          <p style="color:var(--muted);font-size:0.9rem;margin:6px 0 12px;">Pick your program to see your courses, notes, videos and announcements.</p>
          <button class="btn btn-primary btn-sm" onclick="document.getElementById('programSelectCard').scrollIntoView({behavior:'smooth'})">Choose program</button>
        </div>`;
      return;
    }
    const courses = myProgramData.courses || [];
    if (!courses.length) {
      list.innerHTML = emptyState({ icon: 'library', title: 'No courses yet', body: 'Courses for your program will appear here once the admin adds them.' });
      return;
    }
    list.innerHTML = courses.map((c) => {
      const p = c.progress || { total: 0, completed: 0, percent: 0 };
      return `
        <a class="course-mini" href="${SCPrograms.courseHref(c)}">
          <span class="cm-icon">${SC.icon(c.icon || 'book-open', { size: 21 })}</span>
          <span class="cm-body">
            <strong>${escapeHtml(c.code)} — ${escapeHtml(c.name)}</strong>
            <span>${p.total} lessons · ${p.completed} complete</span>
          </span>
          <span style="width:120px;flex-shrink:0;">
            <div class="progress-labels"><span></span><strong style="font-size:0.78rem;">${p.percent}%</strong></div>
            <div class="progress progress-thin"><span style="width:${p.percent}%"></span></div>
          </span>
          ${SC.icon('chevron-right', { size: 17 })}
        </a>`;
    }).join('');
  }

  /* ── Stats ──────────────────────────────── */
  function renderStats(totalLessons, streak) {
    $('#streakIcon').innerHTML = SC.icon('flame', { size: 24 });
    $('#streakValue').textContent = streak || 0;
    $('#lessonsIcon').innerHTML = SC.icon('check-circle', { size: 24 });
    $('#lessonsValue').textContent = totalLessons || 0;
  }

  /* ── Achievements ───────────────────────── */
  function renderAchievements(achievements) {
    if (!achievements || !achievements.length) { $('#achievementsGrid').innerHTML = ''; return; }
    $('#achievementsGrid').innerHTML = achievements.map((a) => `
      <div class="achievement ${a.earned ? 'earned' : ''}" title="${escapeHtml(a.detail)}">
        <span class="ach-icon">${SC.icon(a.icon, { size: 21 })}</span>
        <strong>${escapeHtml(a.name)}</strong>
        <span>${a.earned ? 'Earned' : `${a.value}/${a.target}`}</span>
      </div>`).join('');
  }

  /* ── Recent activity ────────────────────── */
  function renderActivity(items) {
    const list = $('#activityList');
    if (!items.length) {
      list.innerHTML = emptyState({ icon: 'clock', title: 'No activity yet', body: 'Complete your first lesson and it will show up here.' });
      return;
    }
    list.innerHTML = items.map((a) => `
      <a class="activity-item" href="${SC.resourceHref(a)}" style="text-decoration:none;color:inherit;">
        <span class="act-icon">${SC.icon(a.category === 'video' ? 'play' : 'check', { size: 16 })}</span>
        <span class="act-body">
          <strong>${a.completed ? 'Completed' : 'Studied'} — ${escapeHtml(a.title)}</strong>
          <span>${escapeHtml(a.subject || '')}${a.topic ? ` · ${escapeHtml(a.topic)}` : ''} · ${timeAgo(a.completedAt || a.updatedAt)}</span>
        </span>
        ${SC.icon('chevron-right', { size: 15 })}
      </a>`).join('');
  }

  /* ── Recommended ───────────────────────── */
  function renderRecommended(items) {
    const list = $('#recommendedList');
    if (!items.length) {
      list.innerHTML = emptyState({ icon: 'sparkles', title: 'Start a course to get recommendations', body: 'Once you begin lessons, we will suggest what to study next.' });
      return;
    }
    list.innerHTML = items.map((r) => `
      <a class="activity-item" href="${SC.resourceHref(r)}" style="text-decoration:none;color:inherit;">
        <span class="act-icon">${SC.icon(SC.courseCategoryIcon(r.category), { size: 16 })}</span>
        <span class="act-body">
          <strong>${escapeHtml(r.title)}</strong>
          <span>${escapeHtml(r.reason || '')} · ${escapeHtml(r.subject || '')}</span>
        </span>
        ${SC.icon('chevron-right', { size: 15 })}
      </a>`).join('');
  }

  /* ── Premium panel ──────────────────────── */
  const PREMIUM_PERKS = [
    'Unlimited video lessons in every course',
    'All study notes, tutorial sheets and past papers',
    'Video resume and completion tracking',
    'Progress across all six courses',
    'Priority access to new content'
  ];

  function renderPremiumPanel() {
    const panel = $('#premiumPanel');
    const s = user.subscriptionStatus || {};
    let statusLine, actionHtml = '';

    const perks = PREMIUM_PERKS.map((p) => `<li>${SC.icon('check', { size: 16 })}${p}</li>`).join('');

    switch (s.state) {
      case 'premium_active':
        statusLine = `<span class="badge badge-amber" style="background:rgba(245,166,35,0.16);color:#ffd080;border-color:rgba(245,166,35,0.4);">${SC.icon('crown', { size: 13 })} Premium Active</span>`;
        actionHtml = `
          <p style="color:rgba(255,255,255,0.75);margin:14px 0 0;">
            Your Premium access runs until <strong style="color:#fff;">${new Date(s.subscriptionEnd).toLocaleDateString()}</strong>
            (${s.subscriptionDaysLeft} day${s.subscriptionDaysLeft === 1 ? '' : 's'} left).
            Renew from here to keep studying without interruption.
          </p>
          <div id="premiumPaymentForm" style="margin-top:18px;"></div>`;
        break;
      case 'payment_pending':
        statusLine = `<span class="badge badge-amber" style="background:rgba(245,166,35,0.16);color:#ffd080;border-color:rgba(245,166,35,0.4);">${SC.icon('clock', { size: 13 })} Payment Pending</span>`;
        actionHtml = `<p style="color:rgba(255,255,255,0.75);margin:14px 0 0;">Your payment request is being confirmed by the StudyCore team. Premium activates automatically once it is approved — usually quickly.</p>`;
        break;
      default:
        statusLine = s.state === 'trial_active'
          ? `<span class="badge badge-white">${SC.icon('sparkles', { size: 13 })} Free Trial · ${s.trialDaysLeft} days left</span>`
          : `<span class="badge badge-white">${SC.icon('lock', { size: 13 })} ${s.state === 'premium_expired' ? 'Premium expired' : 'Trial ended'}</span>`;
        actionHtml = `<div id="premiumPaymentForm" style="margin-top:18px;"></div>`;
    }

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
        <div>
          ${statusLine}
          <h2 style="margin-top:12px;">StudyCore Premium</h2>
          <p style="color:rgba(255,255,255,0.75);">Unlock the full Premium learning experience.</p>
        </div>
        <div style="text-align:right;">
          <div class="premium-price">K50 <small>/ 30 days</small></div>
          <p style="color:rgba(255,255,255,0.55);font-size:0.85rem;">MTN MoMo or Airtel Money</p>
        </div>
      </div>
      <ul class="premium-perks">${perks}</ul>
      ${actionHtml}`;

    const formSlot = document.getElementById('premiumPaymentForm');
    if (formSlot) loadPaymentForm(formSlot);
  }

  async function loadPaymentForm(slot) {
    slot.innerHTML = '<p style="color:rgba(255,255,255,0.6);">Loading payment details…</p>';
    let info = { payTo: { numbers: [{ method: 'MTN MoMo', phone: 'Not configured yet', name: 'StudyCore' }, { method: 'Airtel Money', phone: 'Not configured yet', name: 'StudyCore' }] }, amount: 50 };
    try { info = await StudyCoreAPI.paymentInfo(); } catch { /* defaults above */ }

    const numbers = info.payTo.numbers.map((n) => `
      <div class="pay-method" style="background:rgba(255,255,255,0.07);border-color:rgba(255,255,255,0.2);">
        <div>
          <strong style="color:#fff;">${escapeHtml(n.method)}</strong>
          <small style="color:rgba(255,255,255,0.6);">${escapeHtml(n.name)}</small>
        </div>
        <span class="number" style="margin-left:auto;color:#ffd080;">${escapeHtml(n.phone)}</span>
      </div>`).join('');

    slot.innerHTML = `
      <div style="max-width:560px;">
        <p style="color:rgba(255,255,255,0.75);margin-bottom:12px;">Send <strong style="color:#fff;">K${info.amount}</strong> from your own mobile money account, then submit the details below so the team can confirm and activate your Premium.</p>
        <div class="pay-methods">${numbers}</div>
        <form id="premiumPayForm" style="display:grid;gap:12px;margin-top:14px;">
          <div class="form-row">
            <div class="form-group" style="margin:0;">
              <label for="payPhone" style="color:rgba(255,255,255,0.85);">Your phone number</label>
              <input id="payPhone" class="input" style="background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.25);color:#fff;" placeholder="e.g. 0977 123 456" />
            </div>
            <div class="form-group" style="margin:0;">
              <label for="payMethod" style="color:rgba(255,255,255,0.85);">Method used</label>
              <select id="payMethod" class="input" style="background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.25);color:#fff;">
                ${info.payTo.numbers.map((n) => `<option value="${escapeHtml(n.method)}" style="color:#000;">${escapeHtml(n.method)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group" style="margin:0;">
            <label for="payRef" style="color:rgba(255,255,255,0.85);">Transaction reference (helps confirmation)</label>
            <input id="payRef" class="input" style="background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.25);color:#fff;" placeholder="e.g. MP240613.1234.A56789" />
          </div>
          <button class="btn btn-amber" type="submit">I've Sent the Payment</button>
          <div id="payNotice"></div>
        </form>
        <p style="font-size:0.78rem;color:rgba(255,255,255,0.5);margin-top:10px;">
          This is a manual confirmation — nothing is charged automatically. Premium activates once the payment is verified.
        </p>
      </div>`;

    slot.querySelector('#premiumPayForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const phone = document.getElementById('payPhone').value.trim();
      const method = document.getElementById('payMethod').value;
      const reference = document.getElementById('payRef').value.trim();
      const notice = document.getElementById('payNotice');
      if (!phone) { notice.innerHTML = '<p style="color:#ffd080;font-size:0.85rem;">Enter the phone number you paid from.</p>'; return; }
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const data = await StudyCoreAPI.subscribe({ phone, method, reference });
        notice.innerHTML = `<p style="color:#4ade80;font-size:0.85rem;">${escapeHtml(data.message)}</p>`;
        btn.textContent = 'Request Submitted';
        setTimeout(async () => { await StudyCoreAuth.fetchSession().then(() => {}); location.reload(); }, 1200);
      } catch (err) {
        notice.innerHTML = `<p style="color:#fca5a5;font-size:0.85rem;">${escapeHtml(err.message)}</p>`;
        btn.disabled = false;
      }
    });
  }

  /* ── Announcements + bookmarks ──────────── */
  async function loadAnnouncements() {
    const list = $('#announcementList');
    try {
      const data = await StudyCoreAPI.getNotifications({ limit: 4 });
      const resources = data.announcements || [];
      if (!resources.length) { list.innerHTML = '<p style="color:var(--muted);font-size:0.88rem;">No announcements right now.</p>'; return; }
      list.innerHTML = resources.map((a) => {
        const isUnread = !a.isRead;
        return `
        <div class="activity-item" data-dash-ann="${a.id}" style="border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.15s;padding:8px 6px;border-radius:8px;${isUnread ? 'background:color-mix(in srgb,var(--teal-50) 40%,transparent);' : ''}">
          <span class="act-icon" style="${a.pinned ? 'background:var(--amber-100);color:var(--amber-600);' : (isUnread ? 'background:var(--teal-50);color:var(--teal-600);' : '')}">${a.pinned ? SC.icon('crown', { size: 15 }) : SC.icon('bell', { size: 15 })}</span>
          <span class="act-body">
            <strong style="white-space:normal;display:flex;align-items:center;gap:6px;">
              ${escapeHtml(a.title)}
              ${a.pinned ? '<span class="badge badge-amber" style="font-size:0.62rem;padding:1px 8px;">Pinned</span>' : ''}
              ${isUnread ? '<span class="badge badge-green" style="font-size:0.62rem;padding:1px 7px;">New</span>' : ''}
            </strong>
            <span>${formatDate(a.createdAt)} (${timeAgo(a.createdAt)})</span>
          </span>
        </div>`;
      }).join('');

      list.querySelectorAll('[data-dash-ann]').forEach((el) => {
        const id = el.getAttribute('data-dash-ann');
        const ann = resources.find((r) => r.id === id);
        if (!ann) return;
        el.addEventListener('click', async () => {
          if (!ann.isRead) {
            try {
              await StudyCoreAPI.markNotificationRead(ann.id);
              ann.isRead = true;
              if (window.SCLayout && window.SCLayout.refreshNotifications) {
                window.SCLayout.refreshNotifications();
              }
              loadAnnouncements();
            } catch {}
          }
          if (window.SCLayout && window.SCLayout.openAnnouncementModal) {
            window.SCLayout.openAnnouncementModal(ann);
          }
        });
      });
    } catch (err) {
      list.innerHTML = `<p style="color:var(--muted);">${escapeHtml(err.message)}</p>`;
    }
  }

  async function loadBookmarks() {
    const list = $('#bookmarkList');
    try {
      const { resources } = await StudyCoreAPI.myBookmarks();
      if (!resources.length) { list.innerHTML = '<p>No bookmarks yet — save a resource from any lesson page.</p>'; return; }
      list.innerHTML = resources.slice(0, 6).map((r) => `
        <a class="activity-item" href="${SC.resourceHref(r)}" style="text-decoration:none;color:inherit;">
          <span class="act-icon">${SC.icon(SC.courseCategoryIcon(r.category), { size: 15 })}</span>
          <span class="act-body">
            <strong>${escapeHtml(r.title)}</strong>
            <span>${escapeHtml(r.subject || '')}${r.topic ? ` · ${escapeHtml(r.topic)}` : ''}</span>
          </span>
          ${SC.icon('chevron-right', { size: 15 })}
        </a>`).join('');
    } catch (err) {
      list.innerHTML = `<p style="color:var(--muted);">${escapeHtml(err.message)}</p>`;
    }
  }

  /* ── Referral ───────────────────────────── */
  async function loadReferral() {
    const slot = $('#referralArea');
    try {
      const { code, referredCount, bonusDaysPerReferral, capReached } = await StudyCoreAPI.myReferral();
      const link = `${window.location.origin}/signup.html?ref=${code}`;
      const cap = 1; // reward cap defined in auth.routes.js
      const progressPercent = Math.min(100, (referredCount / cap) * 100);

      slot.innerHTML = `
        <div style="border-radius:16px;overflow:hidden;background:linear-gradient(135deg,#12314e 0%,#0e7568 100%);box-shadow:0 4px 24px rgba(11,32,51,0.22);padding:28px 28px 24px;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;">
            <span style="width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,0.12);display:inline-flex;align-items:center;justify-content:center;">${SC.icon('gift', { size: 22 })}</span>
            <div>
              <h3 style="margin:0;color:#fff;font-size:1.1rem;letter-spacing:0.2px;">Invite a Friend</h3>
              <p style="margin:0;color:rgba(255,255,255,0.75);font-size:0.82rem;">Your first friend to join earns <strong style="color:#ffd080;">you ${bonusDaysPerReferral} bonus days</strong></p>
            </div>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px;">
            <a href="https://wa.me/?text=${encodeURIComponent('Join me on StudyCore! ' + link)}"
               target="_blank" rel="noopener noreferrer"
               class="btn btn-sm"
               style="background:#25D366;color:#fff;border:none;font-weight:600;padding:8px 16px;border-radius:8px;text-decoration:none;display:inline-flex;align-items:center;gap:8px;font-size:0.85rem;">
              ${SC.icon('whatsapp', { size: 18 })} Share on WhatsApp
            </a>
            <button class="btn btn-outline btn-sm" id="copyReferralBtn" style="border-color:rgba(255,255,255,0.3);color:#fff;background:rgba(255,255,255,0.08);padding:8px 14px;border-radius:8px;font-size:0.85rem;display:inline-flex;align-items:center;gap:6px;">
              ${SC.icon('link', { size: 15 })} Copy Link
            </button>
          </div>

          <div style="background:rgba(255,255,255,0.08);border-radius:12px;padding:16px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
              <span style="font-size:0.78rem;color:rgba(255,255,255,0.65);">Your referral link</span>
              <span style="font-family:var(--font-mono);font-size:1.1rem;font-weight:700;color:#ffd080;letter-spacing:0.5px;">${code}</span>
            </div>
            <input id="referralLinkInput" type="text" readonly value="${escapeHtml(link)}"
              style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);font-size:0.82rem;background:rgba(0,0,0,0.15);color:#fff;font-family:var(--font-mono);" />
          </div>

          <div style="margin-top:18px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
              <span style="font-size:0.82rem;color:rgba(255,255,255,0.65);">Friends invited</span>
              <span style="font-size:0.82rem;color:#fff;font-weight:700;">${referredCount} / ${cap}</span>
            </div>
            <div style="height:10px;background:rgba(255,255,255,0.12);border-radius:10px;overflow:hidden;">
              <div style="height:100%;width:${progressPercent}%;background:linear-gradient(90deg,#ffd080,#0e7568);border-radius:10px;transition:width 0.4s ease;"></div>
            </div>
            <p style="margin-top:10px;font-size:0.78rem;color:rgba(255,255,255,0.55);">
              Your first friend to join earns <strong style="color:#ffd080;">you +${bonusDaysPerReferral} days</strong> (one-time reward).
              ${capReached ? '<span style="color:#4ade80;">Reward claimed!</span>' : ''}
            </p>
          </div>
        </div>`;
      document.getElementById('copyReferralBtn').addEventListener('click', async () => {
        const input = document.getElementById('referralLinkInput');
        input.select();
        try {
          await navigator.clipboard.writeText(link);
          showToast('Link copied.', 'success');
        } catch {
          showToast('Select the link and copy it manually.', 'info');
        }
      });
    } catch (err) {
      slot.innerHTML = `<p style="color:var(--muted);">${escapeHtml(err.message)}</p>`;
    }
  }

  /* ── Avatar ─────────────────────────────── */
  function bindAvatar() {
    const input = $('#avatarInput');
    const removeBtn = $('#avatarRemoveBtn');
    const refresh = () => {
      renderAvatar($('#profileAvatarSlot'), true);
      renderAvatar($('#dashAvatarSlot'), true);
      removeBtn.style.display = user.hasAvatar ? '' : 'none';
    };
    refresh();

    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) {
        showToast('Image must be 4MB or smaller.', 'error');
        return;
      }
      try {
        const data = await StudyCoreAPI.uploadAvatar(file);
        user = data.user;
        renderAvatar($('#profileAvatarSlot'), true);
        renderAvatar($('#dashAvatarSlot'), true);
        removeBtn.style.display = user.hasAvatar ? '' : 'none';
        showToast('Profile picture updated.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        input.value = '';
      }
    });

    removeBtn.addEventListener('click', async () => {
      try {
        const data = await StudyCoreAPI.removeAvatar();
        user = data.user;
        renderAvatar($('#profileAvatarSlot'), true);
        renderAvatar($('#dashAvatarSlot'), true);
        removeBtn.style.display = 'none';
        showToast('Profile picture removed.', 'info');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  /* ── Forms ──────────────────────────────── */
  function bindForms() {
    $('#profileForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        await StudyCoreAPI.updateProfile({
          name: document.getElementById('profileName').value.trim(),
          school: document.getElementById('profileSchool').value.trim(),
          grade: document.getElementById('profileGrade').value.trim(),
          learningLevel: document.getElementById('profileLevel').value
        });
        showToast('Profile updated.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.getAttribute('data-toggle-password'));
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        btn.querySelector('.pw-eye-open').style.display = showing ? '' : 'none';
        btn.querySelector('.pw-eye-closed').style.display = showing ? 'none' : '';
        btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      });
    });

    $('#passwordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await StudyCoreAPI.changePassword({
          currentPassword: document.getElementById('currentPassword').value,
          newPassword: document.getElementById('newPassword').value
        });
        showToast('Password updated.', 'success');
        e.target.reset();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Program change (persisted server-side — the backend enforces it).
    const programSaveBtn = document.getElementById('programSaveBtn');
    if (programSaveBtn) {
      programSaveBtn.addEventListener('click', async () => {
        const sel = document.getElementById('programSelect');
        const code = sel && sel.value;
        if (!code) { showToast('Please choose a program.', 'error'); return; }
        programSaveBtn.disabled = true;
        // chooseProgram reloads on success.
        await chooseProgram(code);
        programSaveBtn.disabled = false;
      });
    }
  }

  /* ── Community ──────────────────────────── */
  function renderCommunity() {
    SCLayout.renderCommunityPanel($('#communityPanel'));
  }

  /* ── Program selection (for older accounts / changes) ── */
  async function loadProgramPicker() {
    try {
      const { programs } = await StudyCoreAPI.listPrograms();
      const sel = document.getElementById('programSelect');
      if (sel) {
        sel.innerHTML = '<option value="">Choose your program…</option>' +
          programs.map((p) => `<option value="${p.code}" ${user.program === p.code ? 'selected' : ''}>${escapeHtml(p.groupName ? `${p.name} (${p.groupName})` : p.name)}</option>`).join('');
      }
    } catch { /* non-fatal */ }
  }

  async function chooseProgram(code) {
    try {
      const data = await StudyCoreAPI.setMyProgram(code);
      user = data.user;
      showToast('Program updated.', 'success');
      location.reload();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  /* ── Boot ──────────────────────────────── */
  async function initDashboard() {
    user = await StudyCoreAuth.fetchSession();
    if (!user) { window.location.href = '/login.html'; return; }

    // One-time welcome transition right after login/signup
    const welcomeInfo = StudyCoreAuth.consumeWelcomeFlag();
    if (welcomeInfo !== null) StudyCoreAuth.showWelcomeTransition(welcomeInfo.name || user.name, welcomeInfo.type);

    // Fetch this student's program + courses (the platform now filters
    // everything by program).
    try {
      myProgramData = await StudyCoreAPI.myProgram();
    } catch {
      myProgramData = null;
    }

    renderHero();
    renderStatusBanner();
    renderPremiumPanel();
    bindAvatar();
    bindForms();
    renderCommunity();
    loadAnnouncements();
    loadBookmarks();
    loadReferral();
    loadProgramPicker();

    // Live refresh: smooth real-time updates across the entire dashboard
    setInterval(async () => {
      try { await loadAnnouncements(); } catch {}
    }, 25000);
    setInterval(async () => {
      try { await loadBookmarks(); } catch {}
    }, 30000);
    setInterval(async () => {
      try { await loadReferral(); } catch {}
    }, 30000);

    // Fill profile forms
    document.getElementById('profileName').value = user.name || '';
    document.getElementById('profileSchool').value = user.school || '';
    document.getElementById('profileGrade').value = user.grade || '';
    document.getElementById('profileLevel').value = user.learning_level || 'secondary';

    // Program courses: load each program-course home for progress, continue
    // learning, recent activity and recommendations. Everything is already
    // filtered to the student's program server-side.
    const courseKeys = (myProgramData && myProgramData.courses ? myProgramData.courses : []).map((c) => c.slug || c.code);
    const results = await Promise.allSettled(
      courseKeys.map(async (slug) => {
        const data = await StudyCoreAPI.programCourseHome(slug);
        return { course: data.course, data };
      })
    );
    const courseData = results.filter((r) => r.status === 'fulfilled').map((r) => r.value).filter(Boolean);

    renderMyCourses();

    // Aggregate stats
    let totalLessons = 0, maxStreak = 0;
    for (const c of courseData) {
      totalLessons += c.data.progress ? c.data.progress.completedCount : 0;
      maxStreak = Math.max(maxStreak, c.data.streak || 0);
    }
    renderStats(totalLessons, maxStreak);

    // Continue learning: prefer a course with a recently-touched lesson,
    // otherwise the next uncompleted lesson in the most-advanced course.
    let best = null;
    for (const c of courseData) {
      const cont = c.data.continueLearning;
      if (cont && cont.via === 'recent') { best = { course: c.course, item: cont }; break; }
    }
    if (!best) {
      let mostAdvanced = null;
      for (const c of courseData) {
        if (c.data.progress.totalCount === 0) continue;
        const cont = c.data.continueLearning;
        if (!cont) continue;
        if (!mostAdvanced || c.data.progress.percent > mostAdvanced.data.progress.percent) mostAdvanced = c;
      }
      if (mostAdvanced && mostAdvanced.data.continueLearning) {
        best = { course: mostAdvanced.course, item: mostAdvanced.data.continueLearning };
      }
    }
    renderContinue(best);

    // Recent activity: most recently completed lessons across program courses
    const activity = [];
    for (const c of courseData) {
      for (const l of (c.data.lessons || [])) {
        if (l.completed && l.completedAt) activity.push({ ...l, courseCode: c.course.code });
      }
    }
    activity.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
    renderActivity(activity.slice(0, 6));

    // Recommended: next uncompleted lessons across the program courses.
    const recs = [];
    for (const c of courseData) {
      const lessons = c.data.lessons || [];
      const next = lessons.find((l) => !l.completed);
      if (next) recs.push({ ...next, reason: `${c.course.code} — next lesson`, courseCode: c.course.code });
    }
    renderRecommended(recs.slice(0, 5));
  }

  document.addEventListener('DOMContentLoaded', initDashboard);
})();
