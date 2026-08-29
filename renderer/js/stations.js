(function () {
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let currentElectionId = null;
  let stations = [];
  let officers = [];

  // ---- Shared custom dropdown (opens downward, matches other pages) ----
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

  async function loadElectionOptions() {
    const all = await window.pvh.listElections();
    const stationElecs = all.filter((e) => e.type === 'station');
    electionDD.setOptions(
      [{ value: '', label: '— Select a station election —' }].concat(
        stationElecs.map((e) => ({ value: e.id, label: e.title }))
      )
    );
  }

  function statusPill(s) {
    if (s === 'submitted') return '<span class="pill pill-danger">Submitted</span>';
    if (s === 'counted') return '<span class="pill pill-info">Counted</span>';
    if (s === 'queuing') return '<span class="pill" style="background:var(--warning-soft);color:var(--warning);">Grace Period</span>';
    if (s === 'open') return '<span class="pill pill-success">Open</span>';
    return '<span class="pill">Not opened</span>';
  }

  async function renderStations() {
    const body = $('station-body');
    if (!currentElectionId) { body.innerHTML = '<p class="text-muted hint">Select a station election to configure its stations.</p>'; return; }
    const [st, off] = await Promise.all([
      window.pvh.listStations(currentElectionId),
      window.pvh.listOfficers(),
    ]);
    stations = st;
    officers = off.filter((o) => o.role !== 'admin');
    if (!stations.length) {
      body.innerHTML = '<div class="empty" style="text-align:center;padding:24px;">No stations configured yet. Use “Add station” to create one.</div>';
      return;
    }
    body.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>Station</th><th>Code</th><th>Location</th><th>Status</th><th>Station officer</th><th class="th-actions">Actions</th></tr></thead><tbody>' +
      stations.map((s) => {
        const officer = officers.find((o) => o.assigned_station_id === s.id) || null;
        const opts = '<option value="">-- None --</option>' +
          officers.map((o) => {
            const isTaken = o.assigned_station_id && o.assigned_station_id !== s.id;
            const selected = officer && officer.id === o.id;
            return '<option value="' + esc(o.id) + '"' + (selected ? ' selected' : '') + (isTaken ? ' disabled' : '') + '>' +
              esc(o.name) + ' (' + esc(o.officer_id) + ')' + (isTaken ? ' — assigned' : '') + '</option>';
          }).join('');
        return '<tr>' +
          '<td><strong>' + esc(s.name) + '</strong></td>' +
          '<td><code>' + esc(s.code || '') + '</code></td>' +
          '<td>' + esc(s.location || '—') + '</td>' +
          '<td>' + statusPill(s.status) + '</td>' +
          '<td><select class="input officer-assign" data-station="' + esc(s.id) + '" style="min-width:180px;">' + opts + '</select></td>' +
          '<td><div class="td-actions"><button class="btn btn-danger btn-sm st-remove" data-id="' + esc(s.id) + '">Remove</button></div></td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';

    body.querySelectorAll('.officer-assign').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const stationId = sel.dataset.station;
        const officerId = sel.value || null;
        const res = await window.pvh.assignStationOfficer(officerId, stationId, currentElectionId);
        if (!res.ok) {
          window.pvhUI.toast(res.error || 'Could not assign officer', 'error');
          renderStations();
          return;
        }
        renderStations();
        window.pvhUI.toast('Officer assigned to station.', 'success');
      });
    });
    body.querySelectorAll('.st-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this station and unassign its officer?')) return;
        const s = stations.find((x) => x.id === btn.dataset.id);
        if (s) {
          const off = officers.find((o) => o.assigned_station_id === s.id);
          if (off) await window.pvh.assignStationOfficer(off.id, null, null);
        }
        const res = await window.pvh.removeStation(btn.dataset.id);
        if (!res.ok) window.pvhUI.toast(res.error || 'Could not remove station', 'error');
        else window.pvhUI.toast('Station removed.', 'success');
        renderStations();
      });
    });
  }

  function bindAddStation() {
    const overlay = $('add-overlay');
    const form = $('add-station-form');
    function closeModal() { overlay.hidden = true; $('st-error').textContent = ''; }
    $('add-station-btn').addEventListener('click', () => {
      if (!currentElectionId) { alert('Select a station election first.'); return; }
      overlay.hidden = false;
      $('st-name').focus();
    });
    $('st-cancel').addEventListener('click', closeModal);
    $('st-close').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeModal(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      $('st-error').textContent = '';
      const submitBtn = $('st-submit');
      await window.pvhUI.busy(submitBtn, 'Adding…', async () => {
        const res = await window.pvh.addStation({
          electionId: currentElectionId,
          name: $('st-name').value,
          location: $('st-location').value,
          code: $('st-code').value,
        });
        if (res.ok) {
          overlay.hidden = true;
          form.reset();
          window.pvhUI.toast(`Station "${res.station ? res.station.name : ''}" added.`, 'success');
          renderStations();
        } else {
          $('st-error').textContent = res.error || 'Failed to add station';
          window.pvhUI.toast(res.error || 'Failed to add station', 'error');
        }
      });
    });
  }

  function bindCreateOfficer() {
    const overlay = $('officer-overlay');
    const form = $('create-officer-form');
    function closeModal() { overlay.hidden = true; form.reset(); $('of-error').textContent = ''; }
    $('create-officer-btn').addEventListener('click', () => { overlay.hidden = false; $('of-name').focus(); });
    $('of-cancel').addEventListener('click', closeModal);
    $('of-close').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeModal(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      $('of-error').textContent = '';
      await window.pvhUI.busy($('of-submit'), 'Creating…', async () => {
        const res = await window.pvh.addOfficer({
          name: $('of-name').value,
          officerId: $('of-id').value,
          password: $('of-pass').value,
          role: 'assistant',
        });
        if (res.ok) {
          closeModal();
          window.pvhUI.toast('Officer account created.', 'success');
          if (currentElectionId) renderStations();
        } else {
          $('of-error').textContent = res.error || 'Failed to create officer';
          window.pvhUI.toast(res.error || 'Failed to create officer', 'error');
        }
      });
    });
  }

  const electionDD = buildSelectDropdown($('station-election-select'), (value) => {
    currentElectionId = value;
    renderStations();
  });
  electionDD.root.style.maxWidth = '380px';

  loadElectionOptions();
  bindAddStation();
  bindCreateOfficer();
})();
