(function () {
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) return;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  const isAdmin = session.role === 'admin' || session.role === 'developer';
  if (isAdmin) document.body.classList.add('is-admin');
  // Coordinators manage station (assistant) officers only; admins manage everyone.
  const canManageRole = (o) => (isAdmin ? true : o.role === 'assistant');

  $('page-subtitle').textContent = isAdmin
    ? 'Manage coordinator and station officer accounts, passwords and assignments.'
    : 'Manage your station officers, passwords and station assignments.';
  $('add-sub').textContent = isAdmin
    ? 'Create a coordinator or station officer account with a name, ID and password.'
    : 'Create a station officer account with a name, ID and password.';
  if (!isAdmin) $('ao-role').closest('.admin-only').hidden = true;

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

  // ---------- Add officer ----------
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
          role: isAdmin ? (roleDD ? roleDD.get() : 'assistant') : 'assistant',
        });
        if (res.ok) {
          form.reset();
          if (roleDD) roleDD.set('assistant');
          $('ao-name').focus();
          window.pvhUI.toast('Officer account created.', 'success');
          loadOfficers();
          loadPasswordTargets();
          renderAssignElections();
        } else {
          err.textContent = res.error || 'Failed to create officer';
          window.pvhUI.toast(res.error || 'Failed to create officer', 'error');
        }
      });
    });
  }

  // ---------- Manage officers ----------
  let allOfficers = [];
  function rolePill(role) {
    if (role === 'admin') return '<span class="pill pill-info">Admin</span>';
    if (role === 'coordinator') return '<span class="pill pill-success">Coordinator</span>';
    return '<span class="pill">Assistant</span>';
  }
  async function loadOfficers() {
    allOfficers = (await window.pvh.listOfficers()) || [];
    renderOfficers();
  }
  function renderOfficers() {
    const body = $('officers-body');
    const query = ($('officer-search').value || '').toLowerCase().trim();
    const list = allOfficers
      .filter(canManageRole)
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
        loadOfficers();
      }));
    body.querySelectorAll('.activate').forEach((b) =>
      b.addEventListener('click', async () => {
        await window.pvh.setOfficerSuspended(b.dataset.id, false);
        window.pvhUI.toast('Officer activated.', 'success');
        loadOfficers();
      }));
    body.querySelectorAll('.setpass').forEach((b) => {
      b.addEventListener('click', () => {
        pwTargetDD.set(b.dataset.id);
        document.getElementById('passwords').scrollIntoView({ behavior: 'auto', block: 'start' });
        $('pw-new').focus();
      });
    });
    body.querySelectorAll('.remove').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Remove this officer account entirely?')) return;
        const res = await window.pvh.removeOfficer(b.dataset.id, session.id);
        if (!res.ok) window.pvhUI.toast(res.error || 'Failed to remove', 'error');
        else window.pvhUI.toast('Officer removed.', 'success');
        loadOfficers();
        loadPasswordTargets();
        renderAssignElections();
      }));
  }
  $('officer-search').addEventListener('input', renderOfficers);

  // ---------- Change / assign password ----------
  async function loadPasswordTargets() {
    const officers = (await window.pvh.listOfficers()) || [];
    const keep = pwTargetDD ? pwTargetDD.get() : '';
    const options = officers
      .filter(canManageRole)
      .filter((o) => o.id !== session.id)
      .map((o) => ({ value: o.id, label: `${o.name} (${o.officer_id})` }));
    pwTargetDD.setOptions([{ value: '', label: '— Select an officer —' }].concat(options));
    if (options.some((o) => o.value === keep)) pwTargetDD.set(keep);
  }
  function bindPassword() {
    $('password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('pw-error');
      err.textContent = '';
      const id = pwTargetDD.get();
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

  // ---------- Custom dropdown (opens downward, matches other pages) ----------
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
      labelEl.textContent = cur ? cur.label : '— Select a station election —';
      labelEl.classList.toggle('placeholder', !cur);
    }
    function close() { root.classList.remove('open'); menu.hidden = true; }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (root.classList.contains('open')) { close(); return; }
      render();
      menu.hidden = false;
      root.classList.add('open');
    });
    menu.addEventListener('click', (e) => {
      const o = e.target.closest('.pdd-option');
      if (!o) return;
      value = o.dataset.value;
      render();
      close();
      if (onChange) onChange(value);
    });
    document.addEventListener('click', (e) => { if (!root.contains(e.target)) close(); });

    select.replaceWith(root);
    return {
      get: () => value,
      set: (v) => { value = v; render(); },
      setOptions: (list) => { opts.length = 0; opts.push(...list); render(); },
      root,
    };
  }

  let assignElectionDD = null;
  async function renderAssignElections() {
    const all = await window.pvh.listElections();
    const stationElecs = all.filter((e) => e.type === 'station');
    const keep = assignElectionDD ? assignElectionDD.get() : '';
    if (!assignElectionDD) {
      assignElectionDD = buildSelectDropdown($('assign-election'), () => renderAssignStations());
      assignElectionDD.root.style.maxWidth = '380px';
    }
    assignElectionDD.setOptions(
      [{ value: '', label: '— Select a station election —' }].concat(
        stationElecs.map((e) => ({ value: e.id, label: e.title }))
      )
    );
    if (stationElecs.some((e) => e.id === keep)) assignElectionDD.set(keep);
    else {
      assignElectionDD.set('');
      $('assign-station-body').innerHTML = '<p class="text-muted hint">Select a station election above to assign its station officers.</p>';
    }
  }
  async function renderAssignStations() {
    const body = $('assign-station-body');
    const electionId = assignElectionDD ? assignElectionDD.get() : '';
    if (!electionId) {
      body.innerHTML = '<p class="text-muted hint">Select a station election above to assign its station officers.</p>';
      return;
    }
    const [stations, officers] = await Promise.all([window.pvh.listStations(electionId), window.pvh.listOfficers()]);
    const eligible = officers.filter((o) => o.role === 'assistant');
    if (!stations.length) {
      body.innerHTML = '<p class="text-muted hint">This election has no stations yet. Add stations on the Stations page first.</p>';
      return;
    }
    body.innerHTML = '<div class="assign-table-wrap table-wrap"><table class="table"><thead><tr><th>Station</th><th>Code</th><th>Status</th><th>Station officer</th></tr></thead><tbody>' +
      stations.map((s) => {
        const officer = eligible.find((o) => o.assigned_station_id === s.id) || null;
        const opts = '<option value="">-- None --</option>' +
          eligible.map((o) => {
            const isTaken = o.assigned_station_id && o.assigned_station_id !== s.id;
            const selected = officer && officer.id === o.id;
            return '<option value="' + esc(o.id) + '"' + (selected ? ' selected' : '') + (isTaken ? ' disabled' : '') + '>' +
              esc(o.name) + ' (' + esc(o.officer_id) + ')' + (isTaken ? ' — assigned' : '') + '</option>';
          }).join('');
        const status = s.status === 'open' ? '<span class="pill pill-success">Open</span>'
          : (s.status === 'submitted' ? '<span class="pill pill-danger">Submitted</span>' : '<span class="pill">Not opened</span>');
        return '<tr>' +
          '<td><strong>' + esc(s.name) + '</strong></td>' +
          '<td><code>' + esc(s.code || '') + '</code></td>' +
          '<td>' + status + '</td>' +
          '<td><select class="input officer-assign" data-station="' + esc(s.id) + '" style="min-width:180px;">' + opts + '</select></td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';

    body.querySelectorAll('.officer-assign').forEach((selEl) => {
      selEl.addEventListener('change', async () => {
        const res = await window.pvh.assignStationOfficer(selEl.value || null, selEl.dataset.station, electionId);
        if (!res.ok) window.pvhUI.toast(res.error || 'Could not assign officer', 'error');
        else window.pvhUI.toast('Officer assigned to station.', 'success');
        renderAssignStations();
      });
    });
  }

  // ---------- Init ----------
  // Build the custom dropdowns for the role and password-target selectors so
  // they match the rest of the app.
  const roleDD = $('ao-role') ? buildSelectDropdown($('ao-role')) : null;
  const pwTargetDD = buildSelectDropdown($('pw-target'));
  loadPasswordTargets();
  loadOfficers();
  bindAddOfficer();
  bindPassword();
  renderAssignElections();
  window.addEventListener('focus', () => { loadOfficers(); loadPasswordTargets(); });
})();
