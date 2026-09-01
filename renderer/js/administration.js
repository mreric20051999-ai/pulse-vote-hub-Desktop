(function () {
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) return;
  // Administration is admin-only (developer inherits admin access); a non-admin shouldn't be here.
  if (session.role !== 'admin' && session.role !== 'developer') { window.location.assign('dashboard.html'); return; }
  document.body.classList.add('is-admin');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Shared custom dropdown (replaces a native <select> with a .pdd widget).
  function buildSelectDropdown(select, onChange) {
    const opts = [...select.options].map((o) => ({ value: o.value, label: o.textContent.trim() }));
    let value = select.value;
    const root = document.createElement('div');
    root.className = 'pdd';
    root.innerHTML = `
      <button type="button" class="pdd-trigger">
        <span class="pdd-label"></span>
        <span class="pdd-arrow"></span>
      </button>
      <div class="pdd-menu" hidden></div>
    `;
    const labelEl = root.querySelector('.pdd-label');
    const menu = root.querySelector('.pdd-menu');
    const trigger = root.querySelector('.pdd-trigger');
    function render() {
      menu.innerHTML = opts.map((o) =>
        `<div class="pdd-option${o.value === value ? ' selected' : ''}" data-value="${esc(o.value)}">${esc(o.label)}</div>`
      ).join('');
      const cur = opts.find((o) => o.value === value);
      labelEl.textContent = cur ? cur.label : '— Select —';
      labelEl.classList.toggle('placeholder', value === '');
    }
    function close() { root.classList.remove('open'); menu.hidden = true; }
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (root.classList.contains('open')) { close(); return; }
      render(); menu.hidden = false; root.classList.add('open');
    });
    menu.addEventListener('click', (e) => {
      const o = e.target.closest('.pdd-option');
      if (!o) return;
      value = o.dataset.value; render(); close();
      if (onChange) onChange(value);
    });
    document.addEventListener('click', (e) => { if (!root.contains(e.target)) close(); });
    select.replaceWith(root);
    render();
    return {
      get: () => value,
      set: (v) => { value = v; render(); },
      setOptions: (l) => { opts.length = 0; opts.push(...l); value = ''; render(); },
      root,
    };
  }

  // ---------- Section sub-menu ----------
  const links = [...document.querySelectorAll('.section-links .sub-link')];
  function setActive(name) {
    links.forEach((l) => l.classList.toggle('active', l.dataset.target === name));
  }
  links.forEach((l) => {
    l.addEventListener('click', (e) => {
      e.preventDefault();
      const el = document.getElementById(l.dataset.target);
      if (!el) return;
      el.scrollIntoView({ behavior: 'auto', block: 'start' });
      setActive(l.dataset.target);
      history.replaceState(null, '', '#' + l.dataset.target);
    });
  });
  if ('IntersectionObserver' in window) {
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) setActive(en.target.id); });
    }, { rootMargin: '-20% 0px -70% 0px' });
    document.querySelectorAll('.ofc-section').forEach((s) => spy.observe(s));
  }
  const initial = location.hash.replace('#', '');
  if (initial) setActive(initial);
  // ---------- My account ----------
  function bindMyPassword() {
    $('my-password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('my-password-msg');
      const pw = $('my-new-pass').value;
      if (pw.length < 6) {
        msg.textContent = 'Password must be at least 6 characters';
        msg.className = 'auth-error';
        return;
      }
      await window.pvhUI.busy($('my-password-submit'), 'Updating…', async () => {
        const res = await window.pvh.changePassword(session.id, pw);
        msg.textContent = res.ok ? 'Password updated.' : (res.error || 'Failed to update password');
        msg.className = res.ok ? 'notice-ok' : 'auth-error';
        if (res.ok) {
          $('my-new-pass').value = '';
          window.pvhUI.toast('Password updated.', 'success');
        } else {
          window.pvhUI.toast(res.error || 'Failed to update password', 'error');
        }
      });
    });
  }

  // ---------- Inbox ("Speak to admin") ----------
  function timeAgo(ts) {
    const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const day = Math.floor(hr / 24);
    return day === 1 ? 'yesterday' : day + 'd ago';
  }

  function bindInbox() {
    const listEl = $('inbox-list');
    const pillText = $('inbox-pill-text');
    const dot = $('inbox-dot');
    const markAll = $('inbox-mark-all-btn');
    const clearAll = $('inbox-clear-btn');
    let items = [];

    function refreshBadge() {
      const unread = items.filter((m) => !m.read && !m.to_officer).length;
      pillText.textContent = unread ? unread + ' unread' : 'Inbox';
      dot.classList.toggle('lan-dot-active', unread > 0);
      markAll.style.display = unread > 0 ? '' : 'none';
      clearAll.style.display = items.length > 0 ? '' : 'none';
      if (window.pvhUI && window.pvhUI.refreshInboxBadge) window.pvhUI.refreshInboxBadge();
    }

    // Group into threads: officer notes are roots; admin replies attach beneath
    // them via reply_to_id.
    function threadItems(list) {
      const roots = [];
      const byId = new Map(list.map((m) => [m.id, m]));
      list.forEach((m) => {
        m._replies = [];
        if (m.reply_to_id && byId.has(m.reply_to_id)) byId.get(m.reply_to_id)._replies.push(m);
      });
      list.forEach((m) => {
        if (!m.reply_to_id) roots.push(m);
      });
      roots.forEach((r) => r._replies.sort((a, b) => a.created_at - b.created_at));
      roots.sort((a, b) => b.created_at - a.created_at);
      return roots;
    }

    const replyIcons = (window.pvhIcons && window.pvhIcons.icon) ? window.pvhIcons.icon : () => 'Reply';

    function replyHtml(m) {
      return `
        <div class="msg-reply-box" data-reply-of="${esc(m.id)}" hidden>
          <textarea data-reply-body rows="2" maxlength="2000" placeholder="Reply to ${esc(m.from_name)}…"></textarea>
          <div class="msg-reply-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-reply-cancel>Cancel</button>
            <button type="button" class="btn btn-primary btn-sm" data-reply-send="true">Send reply</button>
          </div>
        </div>`;
    }

    function renderList() {
      const roots = threadItems(items);
      if (!roots.length) {
        listEl.innerHTML = '<div class="inbox-empty">No messages yet. Officers can write to you from "Speak to admin" in their Profile menu.</div>';
        refreshBadge();
        return;
      }
      const delIcon = (window.pvhIcons && window.pvhIcons.icon) ? window.pvhIcons.icon('trash', 15) : 'Delete';
      listEl.innerHTML = roots.map((r) => `
        <article class="msg${r.read ? '' : ' msg-unread'}" data-id="${esc(r.id)}" role="button" tabindex="0" aria-label="${r.read ? 'Read' : 'Unread'} message from ${esc(r.from_name)}">
          <div class="msg-head">
            <span class="msg-from">${esc(r.from_name)}</span>
            ${r.read ? '' : '<span class="msg-unread-tag">New</span>'}
            <span class="msg-time">${timeAgo(r.created_at)}</span>
          </div>
          <p class="msg-body">${esc(r.body)}</p>
          <div class="msg-actions">
            <button type="button" class="btn btn-ghost btn-sm msg-reply-btn" data-reply="${esc(r.id)}">${replyIcons('reply', 14)}Reply</button>
            <button type="button" class="msg-del" data-del="${esc(r.id)}" title="Delete message" aria-label="Delete message from ${esc(r.from_name)}">${delIcon}</button>
          </div>
          ${replyHtml(r)}
          ${r._replies.map((re) => `
            <article class="msg msg-reply" data-id="${esc(re.id)}" data-reply-of="${esc(r.id)}">
              <div class="msg-head">
                <span class="msg-from msg-from-admin"><span class="msg-reply-mark">↩</span> ${esc(re.from_name)} (Admin)</span>
                <span class="msg-time">${timeAgo(re.created_at)}</span>
              </div>
              <p class="msg-body">${esc(re.body)}</p>
              <div class="msg-actions">
                <button type="button" class="msg-del" data-del="${esc(re.id)}" title="Delete reply" aria-label="Delete reply">${delIcon}</button>
              </div>
            </article>`).join('')}
        </article>`).join('');
    }

    function refresh() {
      window.pvh.listMessages().then((res) => {
        if (!res || !res.ok) return;
        items = res.messages;
        renderList();
        refreshBadge();
      });
    }

    function markOne(article) {
      const item = items.find((m) => m.id === article.dataset.id);
      if (!item || item.read) return;
      window.pvh.markMessageRead(item.id).then((res) => {
        if (!res || !res.ok) return;
        item.read = 1;
        article.classList.remove('msg-unread');
        const tag = article.querySelector('.msg-unread-tag');
        if (tag) tag.remove();
        refreshBadge();
      });
    }

    function removeOne(id) {
      window.pvh.deleteMessage(id).then((res) => {
        if (!res || !res.ok) {
          window.pvhUI.toast((res && res.error) || 'Could not delete the message.', 'error');
          return;
        }
        items = items.filter((m) => m.id !== id);
        renderList();
        refreshBadge();
        window.pvhUI.toast('Message deleted.', 'success');
      });
    }

    listEl.addEventListener('click', (e) => {
      const sendBtn = e.target.closest('[data-reply-send]');
      if (sendBtn) {
        const box = sendBtn.closest('.msg-reply-box');
        const rootId = box.dataset.replyOf;
        const body = (box.querySelector('[data-reply-body]') || {}).value;
        if (!body || !body.trim()) { window.pvhUI.toast('Write a reply first.', 'error'); return; }
        const btn = sendBtn;
        btn.disabled = true;
        window.pvh.replyMessage(rootId, body).then((res) => {
          btn.disabled = false;
          if (!res || !res.ok) {
            window.pvhUI.toast((res && res.error) || 'Could not send the reply.', 'error');
            return;
          }
          items.push(res.message);
          const root = items.find((m) => m.id === rootId);
          if (root) root.read = 1;
          renderList();
          refreshBadge();
          window.pvhUI.toast('Reply sent to ' + res.message.to_officer_name + '.', 'success');
        });
        return;
      }
      const cancelBtn = e.target.closest('[data-reply-cancel]');
      if (cancelBtn) {
        const box = cancelBtn.closest('.msg-reply-box');
        box.hidden = true;
        const ta = box.querySelector('[data-reply-body]');
        if (ta) ta.value = '';
        return;
      }
      const replyBtn = e.target.closest('.msg-reply-btn');
      if (replyBtn) {
        const rootArticle = e.target.closest('.msg');
        if (!rootArticle) return;
        const before = rootArticle.querySelector('.msg-reply-box');
        const wasHidden = before.hidden;
        rootArticle.querySelectorAll('.msg-reply-box').forEach((b) => (b.hidden = true));
        if (wasHidden) { before.hidden = false; before.querySelector('[data-reply-body]').focus(); }
        return;
      }
      const del = e.target.closest('.msg-del');
      if (del) {
        const item = items.find((m) => m.id === del.dataset.del);
        if (!item) return;
        if (!confirm(`Delete the ${item.reply_to_id ? 'reply' : 'message'} from ${item.from_name}? This cannot be undone.`)) return;
        removeOne(item.id);
        return;
      }
      const replyArticle = e.target.closest('.msg-reply');
      if (replyArticle) { replyArticle.focus(); return; }
      const article = e.target.closest('.msg');
      if (article) markOne(article);
    });
    listEl.addEventListener('keydown', (e) => {
      if (e.target.closest('textarea, input, [contenteditable="true"]')) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const del = e.target.closest('.msg-del');
      if (del) { e.preventDefault(); del.click(); return; }
      const sendBtn = e.target.closest('[data-reply-send]');
      const cancelBtn = e.target.closest('[data-reply-cancel]');
      const replyBtn = e.target.closest('.msg-reply-btn');
      if (sendBtn) { e.preventDefault(); sendBtn.click(); return; }
      if (cancelBtn) { e.preventDefault(); cancelBtn.click(); return; }
      if (replyBtn) { e.preventDefault(); replyBtn.click(); return; }
      const article = e.target.closest('.msg');
      if (article && !article.closest('.msg-reply')) { e.preventDefault(); markOne(article); }
    });
    markAll.addEventListener('click', () => {
      window.pvh.markMessageRead('all').then((res) => {
        if (!res || !res.ok) {
          window.pvhUI.toast((res && res.error) || 'Could not update the inbox.', 'error');
          return;
        }
        items.forEach((m) => (m.read = 1));
        renderList();
        refreshBadge();
        window.pvhUI.toast('Inbox marked as read.', 'success');
      });
    });
    clearAll.addEventListener('click', () => {
      if (!items.length) return;
      if (!confirm('Delete ALL messages in the inbox? This cannot be undone.')) return;
      window.pvh.clearMessages().then((res) => {
        if (!res || !res.ok) {
          window.pvhUI.toast((res && res.error) || 'Could not clear the inbox.', 'error');
          return;
        }
        items = [];
        renderList();
        refreshBadge();
        window.pvhUI.toast('Inbox cleared.', 'success');
      });
    });

    refresh();
  }

  bindMyPassword();
  bindInbox();
})();
