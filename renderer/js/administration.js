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
      const res = await window.pvh.backupDatabase();
      msg.textContent = res.ok ? `Backup saved to ${res.path}` : (res.error || 'Backup failed');
      msg.className = res.ok ? 'notice-ok' : 'auth-error';
    });
    $('export-election-btn').addEventListener('click', async () => {
      msg.textContent = '';
      const list = await window.pvh.listElections();
      if (!list.length) {
        msg.textContent = 'No elections to export yet.';
        msg.className = 'auth-error';
        return;
      }
      const target = list.find((e) => e.status === 'active') || list[0];
      const res = await window.pvh.exportElection(target.id);
      msg.textContent = res.ok ? `Exported "${target.title}" to ${res.path}` : (res.error || 'Export failed');
      msg.className = res.ok ? 'notice-ok' : 'auth-error';
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
      const res = await window.pvh.changePassword(session.id, pw);
      msg.textContent = res.ok ? 'Password updated.' : (res.error || 'Failed to update password');
      msg.className = res.ok ? 'notice-ok' : 'auth-error';
      if (res.ok) $('my-new-pass').value = '';
    });
  }

  bindBackup();
  bindMyPassword();
})();
