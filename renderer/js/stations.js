(function () {
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let currentElectionId = null;
  let stations = [];
  let officers = [];

  async function loadElectionOptions() {
    const all = await window.pvh.listElections();
    const stationElecs = all.filter((e) => e.type === 'station');
    const sel = $('station-election-select');
    sel.innerHTML = '<option value="">-- Select a station election --</option>' +
      stationElecs.map((e) => '<option value="' + esc(e.id) + '">' + esc(e.title) + '</option>').join('');
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
        if (!res.ok) { alert(res.error || 'Could not assign officer'); renderStations(); return; }
        renderStations();
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
        if (!res.ok) alert(res.error || 'Could not remove station');
        renderStations();
      });
    });
  }

  function bindAddStation() {
    const overlay = $('add-overlay');
    const form = $('add-station-form');
    $('add-station-btn').addEventListener('click', () => {
      if (!currentElectionId) { alert('Select a station election first.'); return; }
      overlay.hidden = false;
      $('st-name').focus();
    });
    $('st-cancel').addEventListener('click', () => { overlay.hidden = true; $('st-error').textContent = ''; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      $('st-error').textContent = '';
      const res = await window.pvh.addStation({
        electionId: currentElectionId,
        name: $('st-name').value,
        location: $('st-location').value,
        code: $('st-code').value,
      });
      if (res.ok) {
        overlay.hidden = true;
        form.reset();
        renderStations();
      } else {
        $('st-error').textContent = res.error || 'Failed to add station';
      }
    });
  }

  $('station-election-select').addEventListener('change', () => {
    currentElectionId = $('station-election-select').value;
    renderStations();
  });

  loadElectionOptions();
  bindAddStation();
})();
