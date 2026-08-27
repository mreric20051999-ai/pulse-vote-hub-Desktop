(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) return;

  const isAdmin = session.role === 'admin';

  $('status-pill').innerHTML = `<span class="status-dot ${isAdmin ? 'success' : 'info'}"></span>${isAdmin ? 'Administrator' : 'Signed in'}`;
  if (isAdmin) document.body.classList.add('is-admin');
  $('page-subtitle').textContent = isAdmin
    ? 'Admin overview — coordinators, backup and election activity'
    : 'Overview of your elections';

  function fmtDate(ts) {
    if (!ts) return 'No date set';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function renderStats(s) {
    $('stat-total').textContent = s.totalElections;
    $('stat-active').textContent = s.active;
    $('stat-setup').textContent = (s.draft || 0) + (s.upcoming || 0);
    $('stat-closed').textContent = s.closed;
    $('stat-voters').textContent = s.voters;
    $('stat-cast').textContent = s.cast;
    const turn = $('stat-turnout');
    turn.textContent = `${s.turnout}%`;
    turn.className = 'stat-value ' + (s.turnout >= 50 ? 'stat-success' : 'stat-accent');
  }

  function loadStats() {
    window.pvh.dashboardStats().then(renderStats);
  }

  // ---------- Active elections ----------
  async function renderActive() {
    const el = $('active-elections');
    const list = await window.pvh.activeElections();
    $('active-panel').hidden = list.length === 0;
    if (!list.length) return;
    const typeLabel = (t) => (t === 'school' ? 'School' : 'Station');
    el.innerHTML = `<div class="active-list">${list.map((e) => `
      <div class="card active-card">
        <div class="active-card-title">${esc(e.title)}</div>
        <div class="active-meta">
          <span>${typeLabel(e.type)}</span>
          <span>${e.positions} categories</span>
          <span>${e.candidates} candidates</span>
        </div>
        <div class="active-meta">
          <span>${e.cast} / ${e.voters} voted</span>
          <span>${e.voters ? Math.round((e.cast / e.voters) * 100) : 0}% turnout</span>
        </div>
        <div class="active-actions">
          <button class="btn btn-secondary btn-sm configure" data-id="${e.id}">Configure</button>
          <button class="btn btn-secondary btn-sm open-vote" data-id="${e.id}">Run voting</button>
        </div>
      </div>`).join('')}</div>`;
    el.querySelectorAll('.configure').forEach((b) =>
      b.addEventListener('click', () => { window.location.assign(`elections.html?election=${encodeURIComponent(b.dataset.id)}`); }));
    el.querySelectorAll('.open-vote').forEach((b) =>
      b.addEventListener('click', () => { window.location.assign(`vote.html?election=${encodeURIComponent(b.dataset.id)}`); }));
  }

  // ---------- Backup & export ----------
  function bindBackup() {
    const msg = $('backup-msg');
    $('backup-db-btn').addEventListener('click', async () => {
      msg.textContent = '';
      const res = await window.pvh.backupDatabase();
      msg.textContent = res.ok
        ? `Backup saved to ${res.path}`
        : (res.error || 'Backup failed');
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
      msg.textContent = res.ok
        ? `Exported "${target.title}" to ${res.path}`
        : (res.error || 'Export failed');
      msg.className = res.ok ? 'notice-ok' : 'auth-error';
    });
  }

  // ---------- Coordinator management (admin only) ----------
  function rolePill(role) {
    if (role === 'admin') return '<span class="pill pill-info">Admin</span>';
    if (role === 'coordinator') return '<span class="pill pill-success">Coordinator</span>';
    return '<span class="pill">Assistant</span>';
  }

  async function renderOfficers() {
    const officers = await window.pvh.listOfficers();
    const body = $('officers-body');
    if (!officers.length) {
      body.innerHTML = '<tr><td colspan="5" class="text-muted">No accounts yet.</td></tr>';
      return;
    }
    body.innerHTML = officers.map((o) => `
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
            ${o.id !== session.id && o.role !== 'admin' ? `
              ${o.suspended
                ? `<button class="btn btn-secondary btn-sm activate" data-id="${o.id}">Activate</button>`
                : `<button class="btn btn-danger btn-sm suspend" data-id="${o.id}">Suspend</button>`}
              <button class="btn btn-secondary btn-sm resetpass" data-id="${o.id}">Reset password</button>
              <button class="btn btn-danger btn-sm remove" data-id="${o.id}">Remove</button>
            ` : (o.role !== 'admin' ? '<span class="text-muted">—</span>' : '<span class="pill pill-info">Superuser</span>')}
          </div>
        </td>
      </tr>`).join('');

    body.querySelectorAll('.suspend').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Suspend this coordinator? They will be unable to sign in.')) return;
        await window.pvh.setOfficerSuspended(b.dataset.id, true);
        renderOfficers();
      }));
    body.querySelectorAll('.activate').forEach((b) =>
      b.addEventListener('click', async () => {
        await window.pvh.setOfficerSuspended(b.dataset.id, false);
        renderOfficers();
      }));
    body.querySelectorAll('.resetpass').forEach((b) =>
      b.addEventListener('click', () => promptPassword(b.dataset.id)));
    body.querySelectorAll('.remove').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Remove this coordinator account entirely?')) return;
        const res = await window.pvh.removeOfficer(b.dataset.id, session.id);
        if (!res.ok) alert(res.error || 'Failed to remove');
        renderOfficers();
      }));
  }

  function promptPassword(id) {
    const pw = window.prompt('Enter a new password (min. 6 characters):');
    if (!pw) return;
    window.pvh.changePassword(id, pw).then((res) => {
      alert(res.ok ? 'Password updated.' : (res.error || 'Failed to update password'));
    });
  }

  // Add coordinator modal
  function bindAddOfficer() {
    const overlay = $('modal-overlay');
    const form = $('add-officer-form');
    const err = $('ao-error');
    $('add-officer-btn').addEventListener('click', () => { overlay.hidden = false; $('ao-name').focus(); });
    $('ao-cancel').addEventListener('click', () => { overlay.hidden = true; });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const res = await window.pvh.addOfficer({
        name: $('ao-name').value,
        officerId: $('ao-id').value,
        password: $('ao-pass').value,
        role: $('ao-role').value,
      });
      if (res.ok) {
        overlay.hidden = true;
        form.reset();
        renderOfficers();
      } else {
        err.textContent = res.error || 'Failed to add coordinator';
      }
    });
  }

  // My password
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

  // ---------- Init ----------
  loadStats();
  renderActive();
  if (isAdmin) {
    renderOfficers();
    bindAddOfficer();
    bindMyPassword();
    bindBackup();
  }

  // Refresh stats + active elections when returning to this page
  window.addEventListener('focus', () => {
    loadStats();
    renderActive();
    if (isAdmin) renderOfficers();
  });
})();
