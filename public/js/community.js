// =============================================
// STUDYCORE — Community room (js/community.js)
// -----------------------------------------------
// Drives /pages/community.html: one live group room where students ask
// questions freely and the StudyCore admin answers like any other member.
//
// Everything a member typed arrives as raw text and is escaped on the way
// into the DOM (esc() below) — there is no innerHTML anywhere that receives
// unescaped member content. The only markup this file builds from member
// input is a linkified, already-escaped message body.
//
// Live updates come from GET /api/community/stream (SSE). SSE is treated as
// an optimisation: a slow catch-up poll runs alongside it, so a dropped
// stream costs a few seconds of latency rather than a dead room.
// =============================================

(function (global) {
  'use strict';

  const GROUP_WINDOW_MS = 5 * 60 * 1000;
  const TYPING_CLIENT_THROTTLE_MS = 2500;
  const TYPING_SHOW_MS = 6000;
  const SAFETY_POLL_MS = 25000;
  const MARK_READ_MS = 30000;
  const PAGE_SIZE = 40;

  const state = {
    user: null,          // full session user (from /api/auth/me)
    me: null,            // { id, name, role, isAdmin } from the community API
    messages: [],        // chronological, newest last
    byId: new Map(),
    pinned: [],
    members: [],
    online: new Map(),
    onlineCount: 0,
    totalMembers: 0,
    lastSeq: 0,
    firstSeq: 0,
    hasMore: false,
    limits: { maxBodyLength: 2000, maxPinned: 3 },
    replyTo: null,
    editingId: null,
    stream: null,
    pollTimer: null,
    readTimer: null,
    typing: new Map(),
    typingTimer: null,
    lastTypingSentAt: 0,
    lastReadAt: null,
    unreadDividerDrawn: false,
    stuckToBottom: true,
    pendingNew: 0,
    sending: false,
    booted: false
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ── Escaping & text formatting ───────────── */

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // Runs over ALREADY-escaped text, so the only entities it can see are the
  // ones esc() produced. It requires an http(s) scheme, which means a
  // javascript:/data: URL can never become a clickable link, and the
  // attribute value can never contain a raw quote.
  const URL_RE = /https?:\/\/(?:[A-Za-z0-9\-._~:/?#[\]@!$*+,;=%]|&amp;|&#39;)+/g;

  function linkify(escapedText) {
    return escapedText.replace(URL_RE, (match) => {
      // Sentence punctuation that trails a link belongs to the sentence.
      const trailing = /[.,;:!?)\]]+$/.exec(match);
      const url = trailing ? match.slice(0, match.length - trailing[0].length) : match;
      const rest = trailing ? trailing[0] : '';
      return `<a class="msg-link" href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>${rest}`;
    });
  }

  function bodyHtml(text) {
    return linkify(esc(text)).replace(/\n/g, '<br>');
  }

  function clockTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function dayKey(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (dayKey(d.toISOString()) === dayKey(today.toISOString())) return 'Today';
    if (dayKey(d.toISOString()) === dayKey(yesterday.toISOString())) return 'Yesterday';
    try {
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return '';
    }
  }

  function initials(name) {
    return String(name || '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('') || '?';
  }

  // Profile pictures stay private to their owner (GET /api/auth/avatar only
  // ever serves the caller's own row), so other members are shown as
  // initials — same fallback the rest of StudyCore uses.
  function avatarHtml(name, cls) {
    return `<span class="chat-avatar ${cls || ''}" aria-hidden="true">${esc(initials(name))}</span>`;
  }

  /* ── Message markup ───────────────────────── */

  function replyQuoteHtml(m) {
    if (!m.replyTo) return '';
    return `
      <button type="button" class="msg-reply" data-action="jump" data-target="${esc(m.replyTo.id)}">
        ${SC.icon('corner-up-left', { size: 13 })}
        <span class="msg-reply-inner">
          <strong>${esc(m.replyTo.authorName)}</strong>
          <span>${esc(m.replyTo.bodyPreview)}</span>
        </span>
      </button>
    `;
  }

  function reactionsHtml(m) {
    if (!m.reactions || !m.reactions.heart) return '';
    return `
      <div class="msg-reactions">
        <button type="button" class="reaction-pill ${m.reactions.mine ? 'active' : ''}" data-action="react"
                aria-label="${m.reactions.mine ? 'Remove your heart' : 'React with a heart'} (${m.reactions.heart})">
          ${SC.icon('heart', { size: 12 })} <span>${m.reactions.heart}</span>
        </button>
      </div>
    `;
  }

  function actionsHtml(m) {
    if (m.deleted) return '';
    const isAdmin = Boolean(state.me && state.me.isAdmin);
    const canEdit = m.mine;
    const canDelete = m.mine || isAdmin;
    const buttons = [
      `<button type="button" class="msg-act" data-action="reply" aria-label="Reply to this message" title="Reply">${SC.icon('corner-up-left', { size: 15 })}</button>`,
      `<button type="button" class="msg-act ${m.reactions && m.reactions.mine ? 'on' : ''}" data-action="react" aria-label="React with a heart" title="Heart">${SC.icon('heart', { size: 15 })}</button>`
    ];
    if (canEdit) {
      buttons.push(`<button type="button" class="msg-act" data-action="edit" aria-label="Edit your message" title="Edit">${SC.icon('edit', { size: 15 })}</button>`);
    }
    if (isAdmin) {
      buttons.push(`<button type="button" class="msg-act" data-action="pin" aria-label="${m.pinned ? 'Unpin this message' : 'Pin this message'}" title="${m.pinned ? 'Unpin' : 'Pin for everyone'}">${SC.icon('pin', { size: 15 })}</button>`);
    }
    if (canDelete) {
      buttons.push(`<button type="button" class="msg-act msg-act-danger" data-action="delete" aria-label="Delete message" title="Delete">${SC.icon('trash', { size: 15 })}</button>`);
    }
    return `<div class="msg-actions">${buttons.join('')}</div>`;
  }

  function messageHtml(m, prev, options) {
    const dayDivider = (!prev || dayKey(prev.createdAt) !== dayKey(m.createdAt))
      ? `<div class="day-divider" role="separator"><span>${esc(dayLabel(m.createdAt))}</span></div>`
      : '';
    // Inserted after the day divider so a "Today" label never lands below
    // the "New messages" marker it belongs to.
    const unreadDivider = options && options.unreadDivider
      ? '<div class="unread-divider" data-unread-divider><span>New messages</span></div>'
      : '';
    const divider = `${dayDivider}${unreadDivider}`;

    const grouped = Boolean(prev)
      && !prev.deleted
      && prev.author.id === m.author.id
      && dayKey(prev.createdAt) === dayKey(m.createdAt)
      && (new Date(m.createdAt) - new Date(prev.createdAt)) < GROUP_WINDOW_MS;

    if (m.deleted) {
      return `${divider}
        <article class="msg ${m.mine ? 'mine' : 'other'} deleted" data-msg-id="${esc(m.id)}" data-seq="${m.seq}">
          <div class="msg-bubble msg-bubble-deleted">
            ${SC.icon('alert-triangle', { size: 13 })}
            <span>${m.mine ? 'You deleted this message' : 'This message was deleted'}</span>
          </div>
        </article>`;
    }

    const adminBadge = m.author.isAdmin
      ? `<span class="msg-role" title="StudyCore admin">${SC.icon('shield', { size: 11 })} Admin</span>`
      : '';

    const head = grouped ? '' : `
      <div class="msg-head">
        <span class="msg-author ${m.author.isAdmin ? 'is-admin' : ''}">${esc(m.author.name)}</span>
        ${adminBadge}
        ${m.mine ? '<span class="msg-you">You</span>' : ''}
      </div>`;

    const edited = m.editedAt ? '<span class="msg-edited">edited</span>' : '';

    return `${divider}
      <article class="msg ${m.mine ? 'mine' : 'other'} ${grouped ? 'grouped' : ''} ${m.pinned ? 'is-pinned' : ''}"
               data-msg-id="${esc(m.id)}" data-seq="${m.seq}">
        ${grouped ? '<span class="msg-gutter" aria-hidden="true"></span>' : avatarHtml(m.author.name, m.author.isAdmin ? 'is-admin' : '')}
        <div class="msg-main">
          ${head}
          <div class="msg-bubble">
            ${replyQuoteHtml(m)}
            <div class="msg-body">${bodyHtml(m.body)}</div>
            <div class="msg-foot">
              ${edited}
              <time class="msg-time" datetime="${esc(m.createdAt)}">${esc(clockTime(m.createdAt))}</time>
            </div>
          </div>
          ${reactionsHtml(m)}
          ${actionsHtml(m)}
        </div>
      </article>`;
  }

  /* ── List rendering ───────────────────────── */

  function listEl() { return $('#chatList'); }
  function scrollEl() { return $('#chatScroll'); }

  // Message ids are server-generated uuids, but we never interpolate one into
  // a selector without escaping. CSS.escape is used when present and we fall
  // back to an attribute scan on old WebViews that lack it.
  function byMsgId(id) {
    const el = listEl();
    if (!el) return null;
    if (global.CSS && typeof global.CSS.escape === 'function') {
      return el.querySelector(`[data-msg-id="${global.CSS.escape(id)}"]`);
    }
    return Array.prototype.find.call(
      el.querySelectorAll('[data-msg-id]'),
      (node) => node.getAttribute('data-msg-id') === id
    ) || null;
  }

  function nearBottom(threshold = 120) {
    const el = scrollEl();
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }

  function scrollToBottom(behavior = 'auto') {
    const el = scrollEl();
    if (!el) return;
    // Element.scrollTo(options) is missing on a few old mobile WebViews.
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior });
    else el.scrollTop = el.scrollHeight;
    state.stuckToBottom = true;
    state.pendingNew = 0;
    updateJumpButton();
  }

  function updateJumpButton() {
    const btn = $('#chatToBottom');
    if (!btn) return;
    const show = !state.stuckToBottom || state.pendingNew > 0;
    btn.hidden = !show;
    btn.innerHTML = state.pendingNew > 0
      ? `${SC.icon('arrow-left', { size: 15 })}<span class="jump-count">${state.pendingNew}</span>`
      : SC.icon('arrow-left', { size: 16 });
    btn.classList.toggle('has-count', state.pendingNew > 0);
    btn.setAttribute('aria-label', state.pendingNew > 0 ? `${state.pendingNew} new messages` : 'Jump to latest messages');
  }

  function renderAll({ keepScroll = false, showUnreadDivider = false } = {}) {
    const el = listEl();
    if (!el) return;
    const scroller = scrollEl();
    const prevHeight = scroller ? scroller.scrollHeight : 0;
    const prevTop = scroller ? scroller.scrollTop : 0;

    if (!state.messages.length) {
      el.innerHTML = `
        <div class="chat-empty">
          <span class="chat-empty-icon">${SC.icon('message-circle', { size: 30 })}</span>
          <h3>No messages yet</h3>
          <p>Be the first to say something — ask a question about a lesson, a past paper, or anything you are stuck on.</p>
        </div>`;
      return;
    }

    // "New messages" is drawn once, on the very first paint of the room, and
    // disappears as soon as the room is marked read.
    const unreadFrom = showUnreadDivider && !state.unreadDividerDrawn && state.lastReadAt
      ? new Date(state.lastReadAt)
      : null;

    let html = '';
    let prev = null;
    for (const m of state.messages) {
      const markUnread = Boolean(unreadFrom) && !m.mine && new Date(m.createdAt) > unreadFrom;
      if (markUnread) state.unreadDividerDrawn = true;
      html += messageHtml(m, prev, { unreadDivider: markUnread });
      prev = m;
    }
    el.innerHTML = html;

    if (keepScroll && scroller) {
      scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
    }
  }

  function appendMessage(m) {
    const el = listEl();
    if (!el) return;
    const prev = state.messages[state.messages.length - 2] || null;
    const wrap = document.createElement('div');
    wrap.innerHTML = messageHtml(m, prev);
    while (wrap.firstChild) el.appendChild(wrap.firstChild);
    const empty = el.querySelector('.chat-empty');
    if (empty) empty.remove();
  }

  function replaceMessage(m) {
    const existing = byMsgId(m.id);
    if (!existing) return false;
    const idx = state.messages.findIndex((x) => x.id === m.id);
    const prev = idx > 0 ? state.messages[idx - 1] : null;
    const wrap = document.createElement('div');
    wrap.innerHTML = messageHtml(m, prev);
    // messageHtml may prepend a day divider; only swap the <article> itself.
    const article = wrap.querySelector('article');
    if (!article) return false;
    existing.replaceWith(article);
    return true;
  }

  /* ── Data ─────────────────────────────────── */

  // `mine` is a per-viewer fact, so it is never trusted from the wire: the
  // live stream carries one payload for everyone. Derive it, and keep our own
  // heart flag when only a count is being broadcast.
  function fromWire(m) {
    const previous = state.byId.get(m.id);
    m.mine = Boolean(state.me && m.author && m.author.id === state.me.id);
    if (m.reactions && previous && previous.reactions) {
      m.reactions = { heart: m.reactions.heart, mine: previous.reactions.mine };
    }
    return m;
  }

  function ingest(messages, { atTop = false } = {}) {
    let added = false;
    for (const raw of messages) {
      const m = fromWire(raw);
      if (state.byId.has(m.id)) {
        const idx = state.messages.findIndex((x) => x.id === m.id);
        if (idx >= 0) state.messages[idx] = m;
        state.byId.set(m.id, m);
        replaceMessage(m);
        continue;
      }
      state.byId.set(m.id, m);
      added = true;
      if (atTop) state.messages.unshift(m);
      else state.messages.push(m);
    }
    if (messages.length) {
      const seqs = messages.map((m) => m.seq).filter((s) => typeof s === 'number');
      if (seqs.length) {
        state.lastSeq = Math.max(state.lastSeq || 0, ...seqs);
        state.firstSeq = state.firstSeq ? Math.min(state.firstSeq, ...seqs) : Math.min(...seqs);
      }
    }
    return added;
  }

  async function loadRoom() {
    const data = await StudyCoreAPI.communityRoom({ limit: PAGE_SIZE });
    state.me = data.me;
    state.pinned = data.pinned || [];
    state.members = data.members || [];
    state.onlineCount = data.onlineCount || 0;
    state.totalMembers = data.totalMembers || 0;
    state.limits = data.limits || state.limits;
    state.lastReadAt = data.lastReadAt || null;
    state.hasMore = Boolean(data.hasMore);
    state.messages = (data.messages || []).map(fromWire);
    state.byId = new Map(state.messages.map((m) => [m.id, m]));
    state.lastSeq = state.messages.length ? state.messages[state.messages.length - 1].seq : 0;
    state.firstSeq = state.messages.length ? state.messages[0].seq : 0;

    applyLimits();
    renderHead();
    renderPinned();
    renderMembers();
    renderAll({ showUnreadDivider: true });
    requestAnimationFrame(() => scrollToBottom());
    markRead();
    startSafetyPoll();
    startReadTicker();
  }

  async function loadOlder() {
    if (!state.hasMore || !state.firstSeq) return;
    const data = await StudyCoreAPI.communityRoom({ before: state.firstSeq, limit: PAGE_SIZE });
    state.hasMore = Boolean(data.hasMore);
    ingest(data.messages || [], { atTop: true });
    renderAll({ keepScroll: true });
    renderLoadMore();
  }

  function renderLoadMore() {
    const el = listEl();
    if (!el) return;
    const existing = el.querySelector('.load-more');
    if (existing) existing.remove();
    if (!state.hasMore) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="load-more"><button type="button" class="btn btn-ghost btn-sm" id="loadOlderBtn">${SC.icon('refresh', { size: 14 })} Load earlier messages</button></div>`;
    el.prepend(wrap.firstElementChild);
  }

  async function catchUp() {
    if (!state.lastSeq) return;
    try {
      const data = await StudyCoreAPI.communityRoom({ after: state.lastSeq });
      const fresh = (data.messages || []).filter((m) => !state.byId.has(m.id));
      if (!fresh.length) return;
      const stick = nearBottom();
      ingest(data.messages || []);
      for (const m of fresh) appendMessage(m);
      renderLoadMore();
      if (stick) scrollToBottom();
      else {
        state.pendingNew += fresh.length;
        updateJumpButton();
      }
      if (stick) markRead();
    } catch {
      // offline — the next tick will try again
    }
  }

  /* ── Chrome around the list ───────────────── */

  function renderHead() {
    const meta = $('#chatHeadMeta');
    const avatar = $('#chatHeadAvatar');
    if (avatar) avatar.innerHTML = SC.icon('users', { size: 20 });
    if (!meta) return;
    const parts = [];
    if (state.totalMembers) parts.push(`${state.totalMembers} ${state.totalMembers === 1 ? 'student' : 'students'}`);
    if (state.onlineCount) parts.push(`${state.onlineCount} online now`);
    meta.textContent = parts.length ? parts.join(' · ') : 'Live group room';
    meta.classList.toggle('is-live', state.onlineCount > 0);
  }

  function renderPinned() {
    const host = $('#chatPinned');
    if (!host) return;
    state.pinned = (state.pinned || []).filter((m) => !m.deleted);
    if (!state.pinned.length) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    const latest = state.pinned[0];
    const preview = latest.body.length > 110 ? `${latest.body.slice(0, 107)}…` : latest.body;
    host.hidden = false;
    host.innerHTML = `
      <button type="button" class="pinned-strip" data-action="jump" data-target="${esc(latest.id)}">
        ${SC.icon('pin', { size: 14 })}
        <span class="pinned-text">
          <strong>Pinned${state.pinned.length > 1 ? ` · ${state.pinned.length} messages` : ''} — ${esc(latest.author.name)}</strong>
          <span>${esc(preview)}</span>
        </span>
        ${SC.icon('chevron-right', { size: 15 })}
      </button>`;
  }

  function renderMembers() {
    const list = $('#memberList');
    const online = $('#sideOnlineCount');
    if (online) online.textContent = `${state.onlineCount} online`;
    if (!list) return;
    if (!state.members.length) {
      list.innerHTML = '<p class="side-empty">Nobody has posted yet.</p>';
      return;
    }
    list.innerHTML = state.members.slice(0, 24).map((member) => `
      <div class="member-row ${member.isOnline ? 'is-online' : ''}">
        ${avatarHtml(member.name, member.isAdmin ? 'is-admin' : '')}
        <span class="member-name">${esc(member.name)}${member.id === (state.me && state.me.id) ? ' <em>(you)</em>' : ''}</span>
        ${member.isAdmin ? `<span class="member-role">${SC.icon('shield', { size: 11 })} Admin</span>` : ''}
        ${member.isOnline ? '<span class="online-dot" title="Online now"></span>' : ''}
      </div>
    `).join('');
  }

  /* ── Composer ─────────────────────────────── */

  function applyLimits() {
    const input = $('#composerInput');
    const count = $('#composerCount');
    if (input && state.limits.maxBodyLength) input.maxLength = state.limits.maxBodyLength;
    if (count) count.textContent = `0 / ${state.limits.maxBodyLength}`;
  }

  function autoGrow(input) {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  }

  function updateCounter() {
    const input = $('#composerInput');
    const count = $('#composerCount');
    if (!input || !count) return;
    count.textContent = `${input.value.length} / ${state.limits.maxBodyLength}`;
    count.classList.toggle('over', input.value.length > state.limits.maxBodyLength - 100);
  }

  function setReply(message) {
    state.replyTo = message;
    state.editingId = null;
    const bar = $('#composerReply');
    if (!bar) return;
    bar.hidden = false;
    bar.innerHTML = `
      <div class="composer-reply-inner">
        ${SC.icon('corner-up-left', { size: 14 })}
        <span>
          <strong>Replying to ${esc(message.author.name)}</strong>
          <em>${esc(message.body.length > 90 ? `${message.body.slice(0, 87)}…` : message.body)}</em>
        </span>
      </div>
      <button type="button" class="icon-btn" data-action="cancel-reply" aria-label="Cancel reply">${SC.icon('x', { size: 15 })}</button>`;
    $('#composerInput').focus();
  }

  function setEditing(message) {
    state.editingId = message.id;
    state.replyTo = null;
    const bar = $('#composerReply');
    const input = $('#composerInput');
    if (!bar || !input) return;
    bar.hidden = false;
    bar.classList.add('editing');
    bar.innerHTML = `
      <div class="composer-reply-inner">
        ${SC.icon('edit', { size: 14 })}
        <span><strong>Editing your message</strong><em>Changes are marked as edited.</em></span>
      </div>
      <button type="button" class="icon-btn" data-action="cancel-reply" aria-label="Cancel editing">${SC.icon('x', { size: 15 })}</button>`;
    input.value = message.body;
    autoGrow(input);
    updateCounter();
    input.focus();
  }

  function clearComposerBar() {
    state.replyTo = null;
    state.editingId = null;
    const bar = $('#composerReply');
    if (bar) {
      bar.hidden = true;
      bar.classList.remove('editing');
      bar.innerHTML = '';
    }
  }

  async function sendMessage() {
    const input = $('#composerInput');
    if (!input || state.sending) return;
    const body = input.value.replace(/\s+$/g, '');
    if (!body.trim()) return;

    state.sending = true;
    const sendBtn = $('#composerSend');
    if (sendBtn) sendBtn.disabled = true;

    try {
      if (state.editingId) {
        const { message } = await StudyCoreAPI.communityEdit(state.editingId, body.trim());
        if (message) {
          state.byId.set(message.id, message);
          const idx = state.messages.findIndex((m) => m.id === message.id);
          if (idx >= 0) state.messages[idx] = message;
          replaceMessage(message);
        }
        showToast('Message updated.', 'success');
      } else {
        const { message } = await StudyCoreAPI.communitySend(body.trim(), state.replyTo ? state.replyTo.id : null);
        if (message && !state.byId.has(message.id)) {
          ingest([message]);
          appendMessage(message);
          renderLoadMore();
        }
        state.pendingNew = 0;
        scrollToBottom();
        markRead();
      }
      input.value = '';
      autoGrow(input);
      updateCounter();
      clearComposerBar();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message || 'Could not send that message.', 'error');
    } finally {
      state.sending = false;
      if (sendBtn) sendBtn.disabled = false;
      input.focus();
    }
  }

  /* ── Reactions, pinning, deleting ─────────── */

  async function toggleReaction(id) {
    try {
      const res = await StudyCoreAPI.communityReact(id);
      const m = state.byId.get(id);
      if (m && res.reactions) {
        m.reactions = res.reactions;
        replaceMessage(m);
      }
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message || 'Could not react.', 'error');
    }
  }

  async function togglePin(m) {
    try {
      const res = m.pinned ? await StudyCoreAPI.communityUnpin(m.id) : await StudyCoreAPI.communityPin(m.id);
      state.pinned = res.pinned || [];
      const pinnedIds = new Set(state.pinned.map((p) => p.id));
      for (const msg of state.messages) {
        if (msg.pinned !== pinnedIds.has(msg.id)) {
          msg.pinned = pinnedIds.has(msg.id);
          replaceMessage(msg);
        }
      }
      renderPinned();
      if (typeof showToast === 'function') showToast(m.pinned ? 'Message unpinned.' : 'Pinned for everyone.', 'success');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message || 'Could not change the pin.', 'error');
    }
  }

  async function deleteMessage(m) {
    const label = m.mine ? 'Delete your message?' : `Remove ${m.author.name}'s message for everyone?`;
    if (!global.confirm(`${label}\n\nThis cannot be undone.`)) return;
    try {
      await StudyCoreAPI.communityDelete(m.id);
      if (m.mine) {
        m.deleted = true;
        m.body = '';
        m.pinned = false;
        m.reactions = { heart: 0, mine: false };
        replaceMessage(m);
      } else {
        state.messages = state.messages.filter((x) => x.id !== m.id);
        state.byId.delete(m.id);
        renderAll();
        renderLoadMore();
      }
      state.pinned = state.pinned.filter((p) => p.id !== m.id);
      renderPinned();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message || 'Could not delete that message.', 'error');
    }
  }

  /* ── Read state ───────────────────────────── */

  async function markRead() {
    try {
      await StudyCoreAPI.communityMarkRead();
      state.lastReadAt = new Date().toISOString();
      const divider = document.querySelector('[data-unread-divider]');
      if (divider) divider.remove();
      if (global.SCLayout && SCLayout.setCommunityUnread) SCLayout.setCommunityUnread(0);
    } catch { /* ignore */ }
  }

  function startReadTicker() {
    if (state.readTimer) clearInterval(state.readTimer);
    state.readTimer = setInterval(() => {
      if (!document.hidden && nearBottom()) markRead();
    }, MARK_READ_MS);
  }

  /* ── Typing indicator ─────────────────────── */

  async function pingTyping() {
    const now = Date.now();
    if (now - state.lastTypingSentAt < TYPING_CLIENT_THROTTLE_MS) return;
    state.lastTypingSentAt = now;
    try { await StudyCoreAPI.communityTyping(); } catch { /* ignore */ }
  }

  function renderTyping() {
    const host = $('#chatTyping');
    if (!host) return;
    const now = Date.now();
    for (const [id, info] of state.typing) {
      if (info.expiresAt <= now) state.typing.delete(id);
    }
    const names = Array.from(state.typing.values()).map((t) => t.name);
    if (!names.length) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    let label;
    if (names.length === 1) label = `${names[0]} is typing`;
    else if (names.length === 2) label = `${names[0]} and ${names[1]} are typing`;
    else label = `${names.length} people are typing`;
    host.hidden = false;
    host.innerHTML = `<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span> ${esc(label)}…`;
    if (state.stuckToBottom) scrollToBottom();
  }

  function noteTyping(payload) {
    if (!payload || !payload.userId) return;
    if (state.me && payload.userId === state.me.id) return;
    state.typing.set(payload.userId, {
      name: payload.name || 'Someone',
      expiresAt: Date.now() + (payload.ttlMs || TYPING_SHOW_MS)
    });
    renderTyping();
  }

  /* ── Live stream ──────────────────────────── */

  function setStatus(text, tone) {
    const el = $('#chatStatus');
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.className = `chat-status ${tone || ''}`;
    el.innerHTML = text;
  }

  function connectStream() {
    if (typeof global.EventSource !== 'function') {
      setStatus(`${SC.icon('info', { size: 13 })} Live updates unavailable — refreshing every ${SAFETY_POLL_MS / 1000}s.`, 'warn');
      return;
    }
    try {
      state.stream = new EventSource(StudyCoreAPI.communityStreamUrl(), { withCredentials: true });
    } catch {
      return;
    }

    state.stream.addEventListener('open', () => {
      setStatus('');
      catchUp();
    });

    state.stream.addEventListener('error', () => {
      // EventSource reconnects on its own (retry hint from the server); tell
      // the truth in the meantime and keep polling so nothing is missed.
      setStatus(`${SC.icon('refresh', { size: 13 })} Reconnecting to the live room…`, 'warn');
    });

    state.stream.addEventListener('message', (event) => {
      try {
        const { message } = JSON.parse(event.data);
        if (!message || state.byId.has(message.id)) return;
        const stick = nearBottom();
        ingest([message]);
        appendMessage(message);
        renderLoadMore();
        if (stick) {
          scrollToBottom('smooth');
          markRead();
        } else {
          state.pendingNew += 1;
          updateJumpButton();
        }
      } catch { /* ignore malformed frame */ }
    });

    state.stream.addEventListener('edit', (event) => {
      try {
        const { message } = JSON.parse(event.data);
        if (!message) return;
        ingest([message]);
      } catch { /* ignore */ }
    });

    state.stream.addEventListener('delete', (event) => {
      try {
        const { id, mine } = JSON.parse(event.data);
        const m = state.byId.get(id);
        if (!m) return;
        if (mine) {
          m.deleted = true;
          m.body = '';
          m.reactions = { heart: 0, mine: false };
          state.byId.set(id, m);
          replaceMessage(m);
        } else {
          state.messages = state.messages.filter((x) => x.id !== id);
          state.byId.delete(id);
          renderAll();
          renderLoadMore();
        }
        state.pinned = state.pinned.filter((p) => p.id !== id);
        renderPinned();
      } catch { /* ignore */ }
    });

    state.stream.addEventListener('react', (event) => {
      try {
        const { id, reactions } = JSON.parse(event.data);
        const m = state.byId.get(id);
        if (!m || !reactions) return;
        // Keep our own heart state; only the total is shared.
        m.reactions = { heart: reactions.heart, mine: Boolean(m.reactions && m.reactions.mine) };
        replaceMessage(m);
      } catch { /* ignore */ }
    });

    state.stream.addEventListener('pin', (event) => {
      try {
        const { pinned } = JSON.parse(event.data);
        state.pinned = pinned || [];
        const ids = new Set(state.pinned.map((p) => p.id));
        for (const msg of state.messages) {
          if (msg.pinned !== ids.has(msg.id)) {
            msg.pinned = ids.has(msg.id);
            replaceMessage(msg);
          }
        }
        renderPinned();
      } catch { /* ignore */ }
    });

    state.stream.addEventListener('typing', (event) => {
      try { noteTyping(JSON.parse(event.data)); } catch { /* ignore */ }
    });

    state.stream.addEventListener('presence', (event) => {
      try {
        const { online, onlineCount } = JSON.parse(event.data);
        state.onlineCount = typeof onlineCount === 'number' ? onlineCount : (online || []).length;
        state.members = state.members.map((member) => ({
          ...member,
          isOnline: (online || []).some((o) => o.id === member.id)
        }));
        for (const o of online || []) {
          if (!state.members.some((m) => m.id === o.id)) {
            state.members.push({ ...o, posts: 0, lastPostedAt: null });
          }
        }
        state.members.sort((a, b) => (b.isOnline - a.isOnline));
        renderHead();
        renderMembers();
      } catch { /* ignore */ }
    });
  }

  function startSafetyPoll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (!document.hidden) catchUp();
    }, SAFETY_POLL_MS);
  }

  /* ── Wiring ───────────────────────────────── */

  function bindComposer() {
    const form = $('#chatComposer');
    const input = $('#composerInput');
    if (!form || !input) return;

    const sendIcon = $('#composerSend');
    if (sendIcon) sendIcon.innerHTML = SC.icon('send', { size: 17 });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      sendMessage();
    });

    input.addEventListener('input', () => {
      autoGrow(input);
      updateCounter();
      if (input.value.trim()) pingTyping();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  function bindListActions() {
    const el = listEl();
    if (!el) return;

    el.addEventListener('click', (event) => {
      // "Load earlier messages" lives inside the list too.
      if (event.target.closest('#loadOlderBtn')) {
        loadOlder().catch((err) => {
          if (typeof showToast === 'function') showToast(err.message || 'Could not load older messages.', 'error');
        });
        return;
      }

      const btn = event.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');

      if (action === 'jump') {
        const target = btn.getAttribute('data-target');
        const node = byMsgId(target);
        if (node) {
          node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          node.classList.add('flash');
          setTimeout(() => node.classList.remove('flash'), 1600);
        }
        return;
      }

      const host = btn.closest('[data-msg-id]');
      if (!host) return;
      const message = state.byId.get(host.getAttribute('data-msg-id'));
      if (!message) return;

      if (action === 'reply') {
        if (message.deleted) return;
        setReply(message);
      } else if (action === 'react') {
        toggleReaction(message.id);
      } else if (action === 'edit') {
        setEditing(message);
      } else if (action === 'pin') {
        togglePin(message);
      } else if (action === 'delete') {
        deleteMessage(message);
      }
    });


  }

  function bindScrollBehaviour() {
    const scroller = scrollEl();
    const jump = $('#chatToBottom');
    if (scroller) {
      scroller.addEventListener('scroll', () => {
        state.stuckToBottom = nearBottom();
        if (state.stuckToBottom && state.pendingNew) {
          state.pendingNew = 0;
          markRead();
        }
        updateJumpButton();
      }, { passive: true });
    }
    if (jump) {
      jump.innerHTML = SC.icon('arrow-left', { size: 16 });
      jump.addEventListener('click', () => scrollToBottom('smooth'));
    }
  }

  function bindShell() {
    const toggle = $('#chatMembersToggle');
    if (toggle) {
      toggle.innerHTML = SC.icon('users', { size: 18 });
      toggle.addEventListener('click', () => {
        const side = $('#communitySide');
        if (!side) return;
        const open = side.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
      });

      // The rail is a sheet on small screens: tapping anywhere else closes it.
      document.addEventListener('click', (event) => {
        const side = $('#communitySide');
        if (!side || !side.classList.contains('open')) return;
        if (side.contains(event.target) || toggle.contains(event.target)) return;
        side.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    }

    const pinned = $('#chatPinned');
    if (pinned) {
      pinned.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-action="jump"]');
        if (!btn) return;
        const node = byMsgId(btn.getAttribute('data-target'));
        if (node) {
          node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          node.classList.add('flash');
          setTimeout(() => node.classList.remove('flash'), 1600);
        }
      });
    }

    const bar = $('#composerReply');
    if (bar) {
      bar.addEventListener('click', (event) => {
        if (event.target.closest('[data-action="cancel-reply"]')) clearComposerBar();
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        catchUp();
        if (nearBottom()) markRead();
      }
    });
  }

  function renderGuest() {
    const guest = $('#communityGuest');
    const shell = $('#communityShell');
    if (guest) guest.hidden = false;
    if (shell) shell.hidden = true;

    const icon = $('#guestIcon');
    if (icon) icon.innerHTML = SC.icon('users', { size: 14 });

    const list = $('#communityGuestList');
    if (list) {
      list.innerHTML = [
        { icon: 'circle-help', text: 'Ask a question any time — someone (often the admin) is usually around.' },
        { icon: 'message-circle', text: 'Reply to a specific message so threads do not get lost.' },
        { icon: 'heart', text: 'Heart an answer that helped you.' },
        { icon: 'pin', text: 'Important answers get pinned to the top of the room.' }
      ].map((item) => `<li>${SC.icon(item.icon, { size: 17 })}<span>${item.text}</span></li>`).join('');
    }

    if (global.SCLayout && SCLayout.renderCommunityPanel) {
      SCLayout.renderCommunityPanel($('#communityPanel'));
    }
  }

  async function init() {
    if (state.booted) return;
    const user = await StudyCoreAuth.fetchSession();
    if (!user) {
      renderGuest();
      return;
    }
    state.booted = true;
    state.user = user;

    const guest = $('#communityGuest');
    const shell = $('#communityShell');
    if (guest) guest.hidden = true;
    if (shell) shell.hidden = false;

    bindComposer();
    bindListActions();
    bindScrollBehaviour();
    bindShell();

    try {
      await loadRoom();
    } catch (err) {
      const el = listEl();
      if (el) {
        el.innerHTML = `
          <div class="chat-empty">
            <span class="chat-empty-icon">${SC.icon('alert-triangle', { size: 28 })}</span>
            <h3>Could not open the room</h3>
            <p>${esc(err.message || 'Something went wrong. Please refresh the page.')}</p>
            <button type="button" class="btn btn-outline btn-sm" onclick="location.reload()">Try again</button>
          </div>`;
      }
      return;
    }

    renderLoadMore();
    connectStream();

    if (global.SCLayout && SCLayout.setCommunityUnread) SCLayout.setCommunityUnread(0);
  }

  global.StudyCoreCommunity = {
    init,
    state,
    // Exposed so scripts/test-community.js can run the real escaping and
    // bubble-markup functions instead of a re-implementation of them.
    _internals: { esc, linkify, bodyHtml, messageHtml, dayLabel, initials }
  };
  document.addEventListener('DOMContentLoaded', init);
})(window);
