// =============================================
// STUDYCORE — Student Dashboard Module (js/dashboard.js)
// By Dr. Relentless | Stay Curious & Winning
// -----------------------------------------------
// Runs only on views/dashboard.html, which the server refuses to send to
// anyone who isn't logged in (see middleware/auth.js - requirePageAuth).
// =============================================

function renderProfileHeader(user) {
  const initials = (user.name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
  document.getElementById('profileAvatar').textContent = initials || '?';
  document.getElementById('profileHeaderName').textContent = user.name || 'Student Dashboard';
  document.getElementById('profileHeaderEmail').textContent = user.email || '';
}

function renderAccessNotice(user) {
  const target = document.getElementById('accessNotice');
  if (!target) return;
  const status = user.subscriptionStatus || {};
  if (status.active && user.subscription === 'premium') {
    target.innerHTML = `<div class="access-banner premium">⭐ Premium active - all resources are unlocked.</div>`;
  } else if (!status.active && !status.inTrial) {
    target.innerHTML = `<div class="access-banner locked">Your free trial has ended. Subscribe below to keep learning.</div>`;
  } else {
    const daysLeft = status.trialEnd ? Math.max(0, Math.ceil((new Date(status.trialEnd).getTime() - Date.now()) / 86400000)) : 0;
    target.innerHTML = `<div class="access-banner info">Your free trial is active. ${daysLeft} day${daysLeft === 1 ? '' : 's'} left.</div>`;
  }
}

function renderSummary(user) {
  const target = document.getElementById('studentSummary');
  target.innerHTML = `
    <div class="info-card"><h3>Welcome</h3><p>${escapeHtml(user.name.split(' ')[0])}</p></div>
    <div class="info-card"><h3>Subscription</h3><p>${user.subscription === 'premium' ? 'Premium' : 'Free trial'}</p></div>
    <div class="info-card"><h3>Trial ends</h3><p>${user.trial_end ? new Date(user.trial_end).toLocaleDateString() : '-'}</p></div>
  `;
}

function fillProfileForm(user) {
  document.getElementById('profileName').value = user.name || '';
  document.getElementById('profileSchool').value = user.school || '';
  document.getElementById('profileGrade').value = user.grade || '';
  document.getElementById('profileLevel').value = user.learning_level || 'secondary';
}

async function renderSubscriptionArea(user) {
  const target = document.getElementById('subscriptionArea');
  if (user.subscription === 'premium') {
    target.innerHTML = `
      <h3>Subscription</h3>
      <p>⭐ You have an active Premium subscription${user.subscription_end ? ` until ${new Date(user.subscription_end).toLocaleDateString()}` : ''}.</p>
    `;
    return;
  }

  target.innerHTML = `<h3>Subscribe</h3><p class="loading-text">Loading payment details...</p>`;
  let payTo = { numbers: [{ method: 'MTN MoMo', phone: 'unavailable', name: 'StudyCore' }, { method: 'Airtel Money', phone: 'unavailable', name: 'StudyCore' }] };
  let amount = 50;
  try {
    const info = await StudyCoreAPI.paymentInfo();
    payTo = info.payTo;
    amount = info.amount;
  } catch { /* fall back to defaults above */ }

  const numbersHtml = payTo.numbers.map((n) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border,#ccc);border-radius:8px;margin-bottom:6px;">
      <span>${escapeHtml(n.method)}<br><span style="font-size:0.8rem;opacity:0.7;">${escapeHtml(n.name)}</span></span>
      <strong style="font-size:1.05rem;">${escapeHtml(n.phone)}</strong>
    </div>
  `).join('');

  target.innerHTML = `
    <h3>Subscribe</h3>
    <p>Send <strong>K${amount}</strong> via mobile money to whichever of these matches your network:</p>
    ${numbersHtml}
    <p style="font-size:0.85rem;opacity:0.8;margin-top:10px;">After sending, fill this in so the admin can confirm it and activate your account - this is a manual check, not automatic, so it may take a little while.</p>
    <div class="form-group"><label for="phone">Your phone number (the one you paid from)</label><input id="phone" placeholder="e.g. 0977 123 456" /></div>
    <div class="form-group">
      <label for="method">Payment method used</label>
      <select id="method">
        <option value="MTN MoMo">MTN Mobile Money</option>
        <option value="Airtel Money">Airtel Money</option>
      </select>
    </div>
    <div class="form-group"><label for="reference">Transaction reference / confirmation SMS code (optional but helps)</label><input id="reference" placeholder="e.g. MP240613.1234.A56789" /></div>
    <button class="btn btn-primary" id="subscribeBtn">I've sent the payment</button>
    <div id="pendingNotice"></div>
  `;
  document.getElementById('subscribeBtn').addEventListener('click', async () => {
    const phone = document.getElementById('phone').value.trim();
    const method = document.getElementById('method').value;
    const reference = document.getElementById('reference').value.trim();
    if (!phone) return showToast('Enter your phone number first.', 'error');
    const btn = document.getElementById('subscribeBtn');
    btn.disabled = true;
    try {
      const data = await StudyCoreAPI.subscribe({ phone, method, reference });
      showToast(data.message, 'success');
      document.getElementById('pendingNotice').innerHTML = `<p style="margin-top:10px;font-size:0.85rem;">✅ Submitted - waiting for admin confirmation.</p>`;
      btn.textContent = 'Request submitted';
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

let cachedReferralCode = null;
async function getReferralCode() {
  if (cachedReferralCode) return cachedReferralCode;
  try {
    const ref = await StudyCoreAPI.myReferral();
    cachedReferralCode = ref.code;
  } catch { /* Share buttons just won't render without it */ }
  return cachedReferralCode;
}

async function loadBookmarks() {
  const grid = document.getElementById('bookmarkCards');
  try {
    const { resources } = await StudyCoreAPI.myBookmarks();
    if (!resources.length) {
      grid.innerHTML = '<div class="info-card"><p>No bookmarks yet - star a resource to save it here.</p></div>';
      return;
    }
    const bookmarkedIds = new Set(resources.map((r) => r.id));
    const referralCode = await getReferralCode();
    grid.innerHTML = resources.map((r) => resourceCard(r, bookmarkedIds, referralCode)).join('');
    bindCardInteractions(grid);
  } catch (err) {
    grid.innerHTML = `<p>${err.message}</p>`;
  }
}

async function loadDownloads() {
  const grid = document.getElementById('downloadCards');
  try {
    const { resources } = await StudyCoreAPI.myDownloads();
    if (!resources.length) {
      grid.innerHTML = '<div class="info-card"><p>Nothing downloaded yet - anything you download will show up here so you can find it again.</p></div>';
      return;
    }
    let bookmarkedIds = new Set();
    try {
      const bm = await StudyCoreAPI.myBookmarks();
      bookmarkedIds = new Set(bm.resources.map((r) => r.id));
    } catch { /* ignore */ }
    const referralCode = await getReferralCode();
    grid.innerHTML = resources.map((r) => resourceCard(r, bookmarkedIds, referralCode)).join('');
    bindCardInteractions(grid);
  } catch (err) {
    grid.innerHTML = `<p>${err.message}</p>`;
  }
}

async function loadAnnouncements() {
  const grid = document.getElementById('announcementCards');
  try {
    const { resources } = await StudyCoreAPI.listResources({ category: 'announcement', sort: 'newest', pageSize: 6 });
    if (!resources.length) {
      grid.innerHTML = '<div class="info-card"><p>No announcements right now - check back soon.</p></div>';
      return;
    }
    let bookmarkedIds = new Set();
    try {
      const bm = await StudyCoreAPI.myBookmarks();
      bookmarkedIds = new Set(bm.resources.map((r) => r.id));
    } catch { /* ignore */ }
    const referralCode = await getReferralCode();
    grid.innerHTML = resources.map((r) => resourceCard(r, bookmarkedIds, referralCode)).join('');
    bindCardInteractions(grid);
  } catch (err) {
    grid.innerHTML = `<p>${err.message}</p>`;
  }
}

async function renderReferralArea() {
  const target = document.getElementById('referralArea');
  try {
    const { code, referredCount, bonusDaysPerReferral, rewardCap, rewardedReferrals, capReached } = await StudyCoreAPI.myReferral();
    const link = `${window.location.origin}/signup.html?ref=${code}`;
    const shareMessage = `Hey! I've been using StudyCore for revision - notes, past papers, videos, and quizzes all in one place. Sign up with my link and we both get ${bonusDaysPerReferral} bonus days free: ${link}`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareMessage)}`;

    const progressText = capReached
      ? `You've already used your one-time referral bonus. Friends can still join with your link and get their own bonus - you just won't earn further extra days yourself.`
      : `You'll earn ${bonusDaysPerReferral} bonus days the first time a friend joins with your link - this bonus is one-time only.`;

    target.innerHTML = `
      <h3>Invite friends</h3>
      <p>Share your link - the first friend who joins earns you both <strong>${bonusDaysPerReferral} bonus days</strong> of full access (one-time bonus for you; every friend still gets their own).</p>
      <div style="display:flex;gap:8px;margin:10px 0;flex-wrap:wrap;">
        <input id="referralLinkInput" type="text" readonly value="${escapeHtml(link)}" style="flex:1;min-width:200px;padding:8px 10px;border-radius:8px;border:1px solid var(--border,#ccc);font-size:0.85rem;" />
        <button class="btn btn-outline btn-sm" id="copyReferralBtn">Copy</button>
      </div>
      <a class="btn btn-primary btn-sm" href="${whatsappUrl}" target="_blank" rel="noopener">📱 Share on WhatsApp</a>
      <p class="resource-meta" style="margin-top:10px;">${referredCount} friend${referredCount === 1 ? '' : 's'} joined through your link so far.</p>
      <p class="resource-meta">${progressText}</p>
    `;

    document.getElementById('copyReferralBtn').addEventListener('click', async () => {
      const input = document.getElementById('referralLinkInput');
      input.select();
      try {
        await navigator.clipboard.writeText(link);
        showToast('Link copied.', 'success');
      } catch {
        // Clipboard API can be blocked in some contexts - the input is
        // already selected above so the person can still Ctrl+C manually.
        showToast('Select the link above and copy it manually.', 'info');
      }
    });
  } catch (err) {
    target.innerHTML = `<h3>Invite friends</h3><p>${escapeHtml(err.message)}</p>`;
  }
}

async function initDashboard() {
  const user = await StudyCoreAuth.fetchSession();
  StudyCoreAuth.updateAuthUI();
  if (!user) { window.location.href = '/login.html'; return; }

  // Only plays once, immediately after a real login/signup redirect - the
  // flag is consumed (removed) on read, so refreshing this page or
  // navigating here normally from the nav bar never shows it again.
  const welcomeInfo = StudyCoreAuth.consumeWelcomeFlag();
  if (welcomeInfo !== null) {
    StudyCoreAuth.showWelcomeTransition(welcomeInfo.name || user.name, welcomeInfo.type);
  }

  renderProfileHeader(user);
  renderAccessNotice(user);
  renderSummary(user);
  fillProfileForm(user);
  renderSubscriptionArea(user);
  renderReferralArea();
  loadAnnouncements();
  loadBookmarks();
  loadDownloads();

  document.getElementById('logoutBtn').addEventListener('click', StudyCoreAuth.logoutUser);

  document.getElementById('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
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

  document.getElementById('passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    try {
      await StudyCoreAPI.changePassword({ currentPassword, newPassword });
      showToast('Password updated.', 'success');
      e.target.reset();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', initDashboard);
