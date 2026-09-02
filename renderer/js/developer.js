(function () {
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) return;
  // Developer section is developer-only.
  if (session.role !== 'developer') { window.location.assign('dashboard.html'); return; }
  document.body.classList.add('is-developer');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  // ---------- Shared custom dropdown ----------
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

  // ---------- Backup & restore ----------
  function fmtSize(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(1) + ' ' + u[i];
  }
  function timeAgo(ts) {
    if (!ts) return 'never';
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

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

    const enabledEl = $('auto-backup-enabled');
    const intervalEl = $('auto-backup-interval');
    const keepEl = $('auto-backup-keep');
    const dirEl = $('auto-backup-dir');
    const listEl = $('auto-backup-list');
    const countEl = $('auto-backup-count');

    function renderList(backups) {
      if (!backups || !backups.length) {
        listEl.innerHTML = '<p class="text-muted hint">Nothing saved yet — enable automatic backups or click “Back up now”.</p>';
        countEl.textContent = '';
        return;
      }
      countEl.textContent = backups.length + (backups.length === 1 ? ' backup' : ' backups');
      const down = (window.pvhIcons && window.pvhIcons.icon) ? window.pvhIcons.icon('download', 14) : 'Restore';
      listEl.innerHTML = backups.map((b) => `
        <div class="ab-row" data-path="${esc(b.path)}">
          <div class="ab-row-info">
            <span class="ab-row-name">${esc(b.name)}</span>
            <span class="text-muted ab-row-meta">${fmtSize(b.size)} · ${timeAgo(b.mtime)}</span>
          </div>
          <button type="button" class="btn btn-danger btn-sm ab-restore" title="Verify and restore this backup">${down}</button>
        </div>`).join('');
    }

    async function refresh() {
      const res = await window.pvh.backupAutoGet();
      if (!res || !res.ok) {
        msg.textContent = (res && res.error) || 'Could not load backup settings.';
        msg.className = 'auth-error';
        return;
      }
      const s = res.settings;
      enabledEl.checked = !!s.enabled;
      intervalEl.value = s.intervalMin;
      keepEl.value = s.keep;
      dirEl.value = s.dir || '';
      renderList(s.backups);
    }

    async function save() {
      const settings = {
        enabled: enabledEl.checked,
        intervalMin: Number(intervalEl.value) || 30,
        keep: Number(keepEl.value) || 10,
        dir: dirEl.value.trim(),
      };
      await window.pvhUI.busy($('auto-backup-save-btn'), 'Saving…', async () => {
        const res = await window.pvh.backupAutoSave(settings);
        if (!res || !res.ok) {
          msg.textContent = (res && res.error) || 'Could not save settings.';
          msg.className = 'auth-error';
          return;
        }
        const s = res.settings;
        renderList(s.backups);
        msg.textContent = s.enabled ? 'Automatic backups enabled.' : 'Automatic backups disabled.';
        msg.className = 'notice-ok';
        window.pvhUI.toast('Backup settings saved.', 'success');
      });
    }

    async function now() {
      await window.pvhUI.busy($('auto-backup-now-btn'), 'Backing up…', async () => {
        const res = await window.pvh.backupAutoNow();
        if (!res || !res.ok) {
          msg.textContent = (res && res.error) || 'Backup failed.';
          msg.className = 'auth-error';
          window.pvhUI.toast((res && res.error) || 'Backup failed.', 'error');
          return;
        }
        if (res.settings) renderList(res.settings.backups);
        msg.textContent = 'Backup saved to ' + res.path;
        msg.className = 'notice-ok';
        window.pvhUI.toast('Backup created.', 'success');
      });
    }

    async function pick() {
      const res = await window.pvh.backupAutoPickDir();
      if (!res || !res.ok) {
        if (res && res.error && res.error !== 'Pick cancelled') {
          msg.textContent = res.error;
          msg.className = 'auth-error';
        }
        return;
      }
      dirEl.value = res.path;
    }

    $('auto-backup-save-btn').addEventListener('click', save);
    $('auto-backup-now-btn').addEventListener('click', now);
    $('auto-backup-pick-btn').addEventListener('click', pick);
    listEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.ab-restore');
      if (!btn) return;
      const row = btn.closest('.ab-row');
      if (!row) return;
      const p = row.dataset.path;
      const nameEl = row.querySelector('.ab-row-name');
      const name = nameEl ? nameEl.textContent : 'this backup';
      if (!confirm(`Restore the database from "${name}"?\n\nThis replaces the current database and signs you out. The backup is fully verified first, and nothing changes if it fails the check. Continue?`)) return;
      msg.textContent = 'Restoring…';
      msg.className = '';
      await window.pvhUI.busy(btn, 'Restoring…', async () => {
        const res = await window.pvh.backupAutoRestore(p);
        if (!res || !res.ok) {
          msg.textContent = (res && res.error) || 'Restore failed.';
          msg.className = 'auth-error';
          window.pvhUI.toast((res && res.error) || 'Restore failed.', 'error');
          return;
        }
        msg.textContent = 'Database restored successfully.';
        msg.className = 'notice-ok';
        window.pvhUI.toast('Database restored. Signing you back in…', 'success');
        setTimeout(() => { window.location.assign('index.html'); }, 1200);
      });
    });

    refresh();
  }

  // ---------- Export / delete election ----------
  function bindElectionData() {
    const msg = $('dev-data-msg');
    const statusLabel = (s) => s === 'active' ? 'Active' : s === 'closed' ? 'Closed' : 'Draft';
    const elecMap = {};
    const dd = buildSelectDropdown($('dev-election'), () => { msg.textContent = ''; });

    async function loadElections() {
      const list = await window.pvh.listElections();
      for (const k in elecMap) delete elecMap[k];
      const opts = [{ value: '', label: '— Select an election —' }].concat(list.map((e) => {
        const label = `${e.title} — ${statusLabel(e.status)}`;
        elecMap[e.id] = label;
        return { value: e.id, label };
      }));
      dd.setOptions(opts);
    }

    $('export-election-btn').addEventListener('click', async () => {
      msg.textContent = '';
      const id = dd.get();
      if (!id) { msg.textContent = 'Select an election to export.'; msg.className = 'auth-error'; return; }
      await window.pvhUI.busy($('export-election-btn'), 'Exporting…', async () => {
        const res = await window.pvh.exportElection(id);
        msg.textContent = res.ok ? `Exported to ${res.path}` : (res.error || 'Export failed');
        msg.className = res.ok ? 'notice-ok' : 'auth-error';
        window.pvhUI.toast(res.ok ? 'Election exported.' : (res.error || 'Export failed'), res.ok ? 'success' : 'error');
      });
    });

    $('delete-election-btn').addEventListener('click', async () => {
      const id = dd.get();
      if (!id) { msg.textContent = 'Select an election to delete.'; msg.className = 'auth-error'; return; }
      const label = elecMap[id] || 'this election';
      if (!confirm(`Delete "${label}" and all its categories, candidates, voters and votes? This cannot be undone.`)) return;
      msg.textContent = 'Deleting…';
      const res = await window.pvh.deleteElection(id);
      if (res.ok) {
        msg.textContent = 'Election deleted.';
        msg.className = 'notice-ok';
        loadElections();
      } else {
        msg.textContent = res.error || 'Delete failed';
        msg.className = 'auth-error';
      }
    });

    loadElections();
  }

  // ---------- Officer accounts ----------
  function rolePill(role) {
    if (role === 'developer') return '<span class="pill pill-info">Developer</span>';
    if (role === 'admin') return '<span class="pill pill-info">Admin</span>';
    if (role === 'coordinator') return '<span class="pill pill-success">Coordinator</span>';
    return '<span class="pill">Assistant</span>';
  }
  let allOfficers = [];

  function renderOfficers() {
    const body = $('officers-body');
    const query = ($('officer-search').value || '').toLowerCase().trim();
    const list = allOfficers
      .filter((o) => !query || o.name.toLowerCase().includes(query) || o.officer_id.toLowerCase().includes(query));
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="5" class="text-muted">' + (allOfficers.length ? 'No matching officers.' : 'No accounts yet. Add one above.') + '</td></tr>';
      return;
    }
    body.innerHTML = list.map((o) => `
      <tr class="${o.suspended ? 'officer-suspended' : ''}">
        <td>
          <div class="officer-cell">
            <span class="officer-avatar">${initials(o.name)}</span>
            <span class="officer-name">${esc(o.name)}${o.id === session.id ? ' <em class="text-muted">(you)</em>' : ''}</span>
          </div>
        </td>
        <td><span class="mono">${esc(o.officer_id)}</span></td>
        <td>${rolePill(o.role)}</td>
        <td>${o.suspended ? '<span class="pill pill-danger">Suspended</span>' : '<span class="pill pill-success">Active</span>'}</td>
        <td>
          <div class="td-actions">
            ${o.id !== session.id && o.role !== 'admin' && o.role !== 'developer' ? `
              ${o.suspended
                ? `<button class="btn btn-secondary btn-sm activate" data-id="${o.id}">Activate</button>`
                : `<button class="btn btn-danger btn-sm suspend" data-id="${o.id}">Suspend</button>`}
              <button class="btn btn-secondary btn-sm setpass" data-id="${o.id}">Password</button>
              <button class="btn btn-danger btn-sm remove" data-id="${o.id}">Remove</button>
            ` : (o.role === 'admin' || o.role === 'developer' ? '<span class="pill pill-info">Superuser</span>' : '<span class="text-muted">—</span>')}
          </div>
        </td>
      </tr>`).join('');

    body.querySelectorAll('.suspend').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Suspend this officer? They will be unable to sign in.')) return;
        await window.pvh.setOfficerSuspended(b.dataset.id, true);
        window.pvhUI.toast('Officer suspended.', 'success');
        refreshOfficers();
      }));
    body.querySelectorAll('.activate').forEach((b) =>
      b.addEventListener('click', async () => {
        await window.pvh.setOfficerSuspended(b.dataset.id, false);
        window.pvhUI.toast('Officer activated.', 'success');
        refreshOfficers();
      }));
    body.querySelectorAll('.setpass').forEach((b) => {
      b.addEventListener('click', () => {
        const target = $('pw-target');
        target.value = b.dataset.id;
        target.dispatchEvent(new Event('change'));
        $('pw-new').focus();
      });
    });
    body.querySelectorAll('.remove').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Remove this officer account entirely?')) return;
        const res = await window.pvh.removeOfficer(b.dataset.id, session.id);
        if (!res.ok) window.pvhUI.toast(res.error || 'Failed to remove', 'error');
        else window.pvhUI.toast('Officer removed.', 'success');
        refreshOfficers();
      }));
  }

  async function refreshOfficers() {
    allOfficers = (await window.pvh.listOfficers()) || [];
    renderOfficers();
  }

  function bindAddOfficer() {
    const form = $('add-officer-form');
    const err = $('ao-error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      await window.pvhUI.busy($('ao-submit'), 'Creating…', async () => {
        const res = await window.pvh.addOfficer({
          name: $('ao-name').value,
          officerId: $('ao-id').value,
          password: $('ao-pass').value,
          role: $('ao-role').value || 'assistant',
        });
        if (res.ok) {
          form.reset();
          $('ao-name').focus();
          window.pvhUI.toast('Officer account created.', 'success');
          refreshOfficers();
          loadPasswordTargets();
        } else {
          err.textContent = res.error || 'Failed to create officer';
          window.pvhUI.toast(res.error || 'Failed to create officer', 'error');
        }
      });
    });
  }

  async function loadPasswordTargets() {
    const officers = (await window.pvh.listOfficers()) || [];
    const sel = $('pw-target');
    const keep = sel.value;
    const options = officers
      .filter((o) => o.id !== session.id)
      .map((o) => `<option value="${esc(o.id)}">${esc(o.name)} (${esc(o.officer_id)})</option>`).join('');
    sel.innerHTML = '<option value="">— Select an officer —</option>' + options;
    if (options && keep) sel.value = officers.some((o) => o.id === keep) ? keep : '';
  }

  function bindPassword() {
    $('password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('pw-error');
      err.textContent = '';
      const id = $('pw-target').value;
      const pw = $('pw-new').value;
      if (!id) { err.textContent = 'Select an officer first.'; return; }
      await window.pvhUI.busy($('pw-submit'), 'Updating…', async () => {
        const res = await window.pvh.changePassword(id, pw);
        err.textContent = res.ok ? '' : (res.error || 'Failed to update password');
        err.className = res.ok ? 'notice-ok' : 'auth-error';
        if (res.ok) {
          $('pw-new').value = '';
          window.pvhUI.toast('Password updated.', 'success');
        } else {
          window.pvhUI.toast(res.error || 'Failed to update password', 'error');
        }
      });
    });
  }

  // ---------- Access codes ----------
  function bindAccessCodes() {
    const msg = $('access-codes-msg');
    const listEl = $('access-codes-list');
    const countEl = $('access-codes-count');
    const out = $('issued-code-output');
    const outText = $('issued-code-text');
    const privDD = buildSelectDropdown($('issue-code-privilege'));
    const roleLabel = (r) => r === 'admin' ? 'Administrator' : r === 'coordinator' ? 'Coordinator' : 'Station officer';

    function render(codes) {
      if (!codes || !codes.length) {
        listEl.innerHTML = '<p class="text-muted hint">No codes issued yet.</p>';
        countEl.textContent = '';
        return;
      }
      countEl.textContent = codes.length + (codes.length === 1 ? ' code' : ' codes') + ' total';
      listEl.innerHTML = codes.map((c) => {
        const done = !!c.redeemed_at;
        const d = new Date(c.created_at);
        const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        return `
          <div class="ab-row">
            <div class="ab-row-info">
              <span class="ab-row-name">${roleLabel(c.privilege)}</span>
              <span class="text-muted ab-row-meta">${date}</span>
            </div>
            <span class="lan-pill"><span class="lan-dot ${done ? '' : 'lan-dot-active'}"></span>${done ? 'Used' : 'Active'}</span>
          </div>`;
      }).join('');
    }

    async function refresh() {
      const res = await window.pvh.listSetupCodes();
      if (!res || res instanceof Error || res.error) {
        msg.textContent = (res && res.error) || 'Could not load access codes.';
        msg.className = 'auth-error';
        return;
      }
      render(Array.isArray(res) ? res : []);
    }

    $('issue-code-btn').addEventListener('click', async () => {
      msg.textContent = '';
      out.hidden = true;
      const priv = privDD.get();
      await window.pvhUI.busy($('issue-code-btn'), 'Generating…', async () => {
        const res = await window.pvh.issueSetupCode(priv);
        if (!res || !res.ok) {
          msg.textContent = (res && res.error) || 'Could not generate a code.';
          msg.className = 'auth-error';
          return;
        }
        outText.textContent = res.code;
        out.hidden = false;
        msg.textContent = '';
        refresh();
        window.pvhUI.toast('Access code generated.', 'success');
      });
    });

    $('copy-code-btn').addEventListener('click', async () => {
      const code = outText.textContent.trim();
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        window.pvhUI.toast('Code copied.', 'success');
      } catch (e) {
        msg.textContent = code;
        msg.className = 'notice-ok';
      }
    });

    refresh();
  }

  // ---------- Developer short codes ----------
  function bindDevCodes() {
    const msg = $('dev-codes-msg');
    const listEl = $('dev-codes-list');
    const countEl = $('dev-codes-count');
    const out = $('issued-dev-code-output');
    const outText = $('issued-dev-code-text');

    function render(codes) {
      if (!codes || !codes.length) {
        listEl.innerHTML = '<p class="text-muted hint">No developer codes issued yet.</p>';
        countEl.textContent = '';
        return;
      }
      countEl.textContent = codes.length + (codes.length === 1 ? ' code' : ' codes') + ' total';
      listEl.innerHTML = codes.map((c) => {
        const active = c.status === 'active';
        const when = new Date(c.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        const status = c.status === 'revoked'
          ? '<span class="pill pill-danger">Revoked</span>'
          : c.status === 'used'
            ? '<span class="pill">Used</span>'
            : '<span class="pill pill-success">Active</span>';
        return `
          <div class="ab-row">
            <div class="ab-row-info">
              <span class="ab-row-name">${esc(c.name)}</span>
              <span class="text-muted ab-row-meta">Issued ${when}</span>
            </div>
            <div class="td-actions">
              ${status}
              ${active ? `<button class="btn btn-danger btn-sm revoke-dc" data-id="${esc(c.id)}">Revoke</button>` : ''}
            </div>
          </div>`;
      }).join('');

      listEl.querySelectorAll('.revoke-dc').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('Revoke this developer code? It can no longer be redeemed.')) return;
          const res = await window.pvh.revokeDeveloperCode(b.dataset.id);
          if (!res || !res.ok) {
            msg.textContent = (res && res.error) || 'Could not revoke the code.';
            msg.className = 'auth-error';
            return;
          }
          msg.textContent = '';
          window.pvhUI.toast('Developer code revoked.', 'success');
          refresh();
        }));
    }

    async function refresh() {
      const res = await window.pvh.listDeveloperCodes();
      if (!res || res instanceof Error || res.error) {
        msg.textContent = (res && res.error) || 'Could not load developer codes.';
        msg.className = 'auth-error';
        return;
      }
      msg.textContent = '';
      render(Array.isArray(res) ? res : []);
    }

    $('issue-dev-code-btn').addEventListener('click', async () => {
      msg.textContent = '';
      out.hidden = true;
      const name = $('dev-code-name').value.trim();
      await window.pvhUI.busy($('issue-dev-code-btn'), 'Generating…', async () => {
        const res = await window.pvh.issueDeveloperCode(name);
        if (!res || !res.ok) {
          msg.textContent = (res && res.error) || 'Could not issue a code.';
          msg.className = 'auth-error';
          return;
        }
        outText.textContent = res.code;
        out.hidden = false;
        msg.textContent = '';
        $('dev-code-name').value = '';
        refresh();
        window.pvhUI.toast('Developer code issued.', 'success');
      });
    });

    $('copy-dev-code-btn').addEventListener('click', async () => {
      const code = outText.textContent.trim();
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        window.pvhUI.toast('Code copied.', 'success');
      } catch (e) {
        msg.textContent = code;
        msg.className = 'notice-ok';
      }
    });

    refresh();
  }

  // ---------- License activation (per-site activation codes) ----------
  function bindLicense() {
    const msg = $('lic-msg');
    const listEl = $('lic-list');
    const countEl = $('lic-count');
    const out = $('lic-code-output');
    const outText = $('lic-code-text');

    function render(codes) {
      if (!codes || !codes.length) {
        listEl.innerHTML = '<p class="text-muted hint">No activation codes issued yet.</p>';
        countEl.textContent = '';
        return;
      }
      countEl.textContent = codes.length + (codes.length === 1 ? ' code' : ' codes') + ' total';
      listEl.innerHTML = codes.map((c) => {
        const when = new Date(c.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        const status = c.status === 'revoked'
          ? '<span class="pill pill-danger">Revoked</span>'
          : c.status === 'used'
            ? '<span class="pill pill-success">Used</span>'
            : '<span class="pill">Active</span>';
        return `
          <div class="ab-row">
            <div class="ab-row-info">
              <span class="ab-row-name">${esc(c.site_name)}</span>
              <span class="text-muted ab-row-meta">
                Issued ${when}${c.redeemed_machine ? ` · Redeemed on ${esc(c.redeemed_machine)}` : ''}
              </span>
            </div>
            <div class="td-actions">
              ${status}
              ${c.status === 'active' ? `<button class="btn btn-danger btn-sm revoke-lic" data-id="${esc(c.id)}">Revoke</button>` : ''}
            </div>
          </div>`;
      }).join('');

      listEl.querySelectorAll('.revoke-lic').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('Delete this activation code? It is removed permanently and can no longer be redeemed.')) return;
          const res = await window.pvh.revokeLicense(b.dataset.id);
          if (!res || !res.ok) {
            msg.textContent = (res && res.error) || 'Could not revoke the code.';
            msg.className = 'auth-error';
            return;
          }
          msg.textContent = '';
          msg.className = 'auth-error';
          window.pvhUI.toast('Activation code revoked and removed.', 'success');
          refresh();
        }));
    }

    async function refresh() {
      const res = await window.pvh.listLicenses();
      if (!res || res instanceof Error || res.error) {
        msg.textContent = (res && res.error) || 'Could not load activation codes.';
        msg.className = 'auth-error';
        return;
      }
      msg.textContent = '';
      render(Array.isArray(res.codes) ? res.codes : []);
    }

    $('lic-issue-btn').addEventListener('click', async () => {
      msg.textContent = '';
      out.hidden = true;
      const site = $('lic-site').value.trim();
      if (!site) { msg.textContent = 'Enter the customer / site name.'; msg.className = 'auth-error'; $('lic-site').focus(); return; }
      await window.pvhUI.busy($('lic-issue-btn'), 'Generating…', async () => {
        const res = await window.pvh.issueLicense(site);
        if (!res || !res.ok) {
          msg.textContent = (res && res.error) || 'Could not issue a code.';
          msg.className = 'auth-error';
          return;
        }
        outText.textContent = res.code;
        out.hidden = false;
        msg.textContent = '';
        $('lic-site').value = '';
        refresh();
        window.pvhUI.toast(`Activation code issued for ${res.site_name}.`, 'success');
      });
    });

    $('lic-copy-btn').addEventListener('click', async () => {
      const code = outText.textContent.trim();
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        window.pvhUI.toast('Code copied.', 'success');
      } catch (e) {
        msg.textContent = code;
        msg.className = 'notice-ok';
      }
    });

    refresh();
  }

  // ---------- Login activity (audit log) ----------
  function bindLoginAudit() {
    const body = $('audit-body');
    const msg = $('audit-msg');
    const roleLabel = (r) => r === 'developer' ? 'Developer' : r === 'admin' ? 'Administrator' : r === 'coordinator' ? 'Coordinator' : 'Station officer';

    function render(rows) {
      if (!rows || !rows.length) {
        body.innerHTML = '<tr><td colspan="5" class="text-muted">No login activity recorded yet.</td></tr>';
        return;
      }
      body.innerHTML = rows.map((a) => {
        const when = new Date(a.created_at).toLocaleString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const ok = !!a.success;
        return `<tr>
          <td class="mono">${esc(when)}</td>
          <td>${esc(a.officer_name || 'Unknown')} <em class="text-muted">${esc(a.officer_id ? '(' + a.officer_id + ')' : '')}</em></td>
          <td>${a.role ? roleLabel(a.role) : '<span class="text-muted">—</span>'}</td>
          <td>${esc(a.device || 'This computer')}</td>
          <td>${ok ? '<span class="pill pill-success">Success</span>' : '<span class="pill pill-danger">Failed</span>'}</td>
        </tr>`;
      }).join('');
    }

    async function refresh() {
      const res = await window.pvh.listLoginAudit();
      if (!res || res instanceof Error || res.error) {
        msg.textContent = (res && res.error) || 'Could not load login activity.';
        msg.className = 'auth-error';
        return;
      }
      msg.textContent = '';
      render(Array.isArray(res) ? res : []);
    }

    $('audit-refresh-btn').addEventListener('click', refresh);
    $('audit-clear-btn').addEventListener('click', async () => {
      if (!confirm('Clear the entire login activity log?')) return;
      const res = await window.pvh.clearLoginAudit();
      if (res && res.ok) {
        window.pvhUI.toast('Login activity cleared.', 'success');
        body.innerHTML = '<tr><td colspan="5" class="text-muted">No login activity recorded yet.</td></tr>';
      } else {
        msg.textContent = (res && res.error) || 'Could not clear the log.';
        msg.className = 'auth-error';
      }
    });

    refresh();
  }

  // ---------- Safety kill-switch (terminate the app on suspicious activity) ----
  function bindSafety() {
    const confirmInput = $('safety-confirm');
    const btn = $('terminate-app-btn');
    const msg = $('safety-msg');
    const sync = () => { btn.disabled = (confirmInput.value || '').trim().toUpperCase() !== 'TERMINATE'; };
    if (confirmInput) confirmInput.addEventListener('input', sync);
    sync();
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if ((confirmInput.value || '').trim().toUpperCase() !== 'TERMINATE') { msg.textContent = 'Type TERMINATE to confirm.'; return; }
      msg.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Shutting down…';
      const res = await window.pvh.terminateApp();
      if (!res || !res.ok) {
        msg.textContent = (res && res.error) || 'Shutdown failed';
        btn.disabled = false;
        btn.textContent = 'Terminate application';
      } else {
        msg.textContent = res.message || 'Application is shutting down…';
      }
    });
  }

  // ---------- Init ----------
  bindBackup();
  bindElectionData();
  bindAddOfficer();
  bindPassword();
  bindAccessCodes();
  bindLicense();
  bindDevCodes();
  bindLoginAudit();
  bindSafety();
  refreshOfficers();
  loadPasswordTargets();
  $('officer-search').addEventListener('input', renderOfficers);
  window.addEventListener('focus', () => { refreshOfficers(); loadPasswordTargets(); });
})();