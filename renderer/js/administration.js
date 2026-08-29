(function () {
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) return;
  // Administration is admin-only; a non-admin shouldn't be here.
  if (session.role !== 'admin') { window.location.assign('dashboard.html'); return; }
  document.body.classList.add('is-admin');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

  // ---------- Backup & export ----------
  function bindBackup() {
    const msg = $('backup-msg');
    $('backup-db-btn').addEventListener('click', async () => {
      msg.textContent = '';
      await window.pvhUI.busy($('backup-db-btn'), 'Backing up…', async () => {
        const res = await window.pvh.backupDatabase();
        msg.textContent = res.ok ? `Backup saved to ${res.path}` : (res.error || 'Backup failed');
        msg.className = res.ok ? 'notice-ok' : 'auth-error';
        window.pvhUI.toast(res.ok ? 'Backup created.' : (res.error || 'Backup failed'), res.ok ? 'success' : 'error');
      });
    });
    $('export-election-btn').addEventListener('click', async () => {
      msg.textContent = '';
      await window.pvhUI.busy($('export-election-btn'), 'Exporting…', async () => {
        const list = await window.pvh.listElections();
        if (!list.length) {
          msg.textContent = 'No elections to export yet.';
          msg.className = 'auth-error';
          window.pvhUI.toast('No elections to export yet.', 'error');
          return;
        }
        const target = list.find((e) => e.status === 'active') || list[0];
        const res = await window.pvh.exportElection(target.id);
        msg.textContent = res.ok ? `Exported "${target.title}" to ${res.path}` : (res.error || 'Export failed');
        msg.className = res.ok ? 'notice-ok' : 'auth-error';
        window.pvhUI.toast(res.ok ? `Exported "${target.title}".` : (res.error || 'Export failed'), res.ok ? 'success' : 'error');
      });
    });

    // ---------- Delete election ----------
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
      return {
        get: () => value,
        set: (v) => { value = v; render(); },
        setOptions: (l) => { opts.length = 0; opts.push(...l); value = ''; render(); },
        root,
      };
    }

    const delBtn = $('delete-election-btn');
    const delMsg = $('delete-msg');
    const statusLabel = (s) => s === 'active' ? 'Active' : s === 'closed' ? 'Closed' : 'Draft';
    const elecMap = {};
    const delDD = buildSelectDropdown($('delete-election'), () => { delMsg.textContent = ''; });

    async function loadDeleteElections() {
      const list = await window.pvh.listElections();
      for (const k in elecMap) delete elecMap[k];
      const opts = [{ value: '', label: '— Select an election —' }].concat(list.map((e) => {
        const label = `${e.title} — ${statusLabel(e.status)}`;
        elecMap[e.id] = label;
        return { value: e.id, label };
      }));
      delDD.setOptions(opts);
    }

    delBtn.addEventListener('click', async () => {
      const id = delDD.get();
      if (!id) {
        delMsg.textContent = 'Select an election to delete.';
        delMsg.className = 'auth-error';
        return;
      }
      const label = elecMap[id] || 'this election';
      if (!confirm(`Delete "${label}" and all its categories, candidates, voters and votes? This cannot be undone.`)) return;
      delMsg.textContent = 'Deleting…';
      const res = await window.pvh.deleteElection(id);
      if (res.ok) {
        delMsg.textContent = 'Election deleted.';
        delMsg.className = 'notice-ok';
        loadDeleteElections();
      } else {
        delMsg.textContent = res.error || 'Delete failed';
        delMsg.className = 'auth-error';
      }
    });
    loadDeleteElections();
  }

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
      const unread = items.filter((m) => !m.read).length;
      pillText.textContent = unread ? unread + ' unread' : 'Inbox';
      dot.classList.toggle('lan-dot-active', unread > 0);
      markAll.style.display = unread > 0 ? '' : 'none';
      clearAll.style.display = items.length > 0 ? '' : 'none';
      if (window.pvhUI && window.pvhUI.refreshInboxBadge) window.pvhUI.refreshInboxBadge();
    }

    function renderList() {
      if (!items.length) {
        listEl.innerHTML = '<div class="inbox-empty">No messages yet. Officers can write to you from “Speak to admin” in their Profile menu.</div>';
        refreshBadge();
        return;
      }
      const delIcon = (window.pvhIcons && window.pvhIcons.icon) ? window.pvhIcons.icon('trash', 15) : 'Delete';
      listEl.innerHTML = items.map((m) => `
        <article class="msg${m.read ? '' : ' msg-unread'}" data-id="${esc(m.id)}" role="button" tabindex="0" aria-label="${m.read ? 'Read' : 'Unread'} message from ${esc(m.from_name)}">
          <div class="msg-head">
            <span class="msg-from">${esc(m.from_name)}</span>
            ${m.read ? '' : '<span class="msg-unread-tag">New</span>'}
            <span class="msg-time">${timeAgo(m.created_at)}</span>
          </div>
          <p class="msg-body">${esc(m.body)}</p>
          <div class="msg-actions">
            <button type="button" class="msg-del" data-del="${esc(m.id)}" title="Delete message" aria-label="Delete message from ${esc(m.from_name)}">${delIcon}</button>
          </div>
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
      const del = e.target.closest('.msg-del');
      if (del) {
        const item = items.find((m) => m.id === del.dataset.del);
        if (!item) return;
        if (!confirm(`Delete the message from ${item.from_name}? This cannot be undone.`)) return;
        removeOne(item.id);
        return;
      }
      const article = e.target.closest('.msg');
      if (article) markOne(article);
    });
    listEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const del = e.target.closest('.msg-del');
      if (del) { e.preventDefault(); del.click(); return; }
      const article = e.target.closest('.msg');
      if (article) { e.preventDefault(); markOne(article); }
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

  bindBackup();
  bindMyPassword();
  bindInbox();
})();
