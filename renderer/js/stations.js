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

  // Coordinator (admin/owner) run controls — the coordinator can open, close and
  // submit ANY station, superseding the station officer's console operations.
  function runButtons(s) {
    const id = esc(s.id);
    const btn = (label, cls, action) =>
      '<button class="btn ' + cls + ' btn-sm" data-run="' + action + '" data-id="' + id + '">' + label + '</button>';
    switch (s.status) {
      case 'open':     return btn('Close / Grace', 'btn-amber', 'close') + ' ' + btn('Submit', 'btn-primary', 'submit') + ' ';
      case 'queuing':  return btn('Close Queue Now', 'btn-amber', 'closeq') + ' ' + btn('Submit', 'btn-primary', 'submit') + ' ';
      case 'counted':  return btn('Submit', 'btn-primary', 'submit') + ' ';
      case 'submitted': return '<span class="pill pill-success st-sealed">Sealed</span> ';
      default:         return btn('Open Polls', 'btn-success', 'open') + ' ';
    }
  }

  function officerName() {
    return (session && session.name) || 'Coordinator';
  }

  // ---- Coordinator run controls ----
  async function runOpen(s) {
    if (!confirm('Open polls at "' + s.name + '" and record a zero report? The assigned officer can then check voters in.')) return;
    const res = await window.pvh.openStationPolls(s.id, { officerName: officerName() });
    if (res.ok) { window.pvhUI.toast('Polls opened at ' + s.name + '.', 'success'); renderStations(); }
    else window.pvhUI.toast(res.error || 'Could not open polls', 'error');
  }
  async function runCloseQueueNow(s) {
    if (!confirm('Close the queue at "' + s.name + '" now? Queued voters who have not cast will be unable to vote.')) return;
    const res = await window.pvh.closeStationQueue(s.id, { officerName: officerName() });
    if (res.ok) { window.pvhUI.toast('Queue closed at ' + s.name + '.', 'success'); renderStations(); }
    else window.pvhUI.toast(res.error || 'Could not close queue', 'error');
  }
  function openGraceModal(s) {
    window.__graceStation = s;
    const hint = $('grace-max-hint');
    const input = $('grace-min');
    hint.textContent = '';
    input.max = 120;
    input.value = 30;
    $('grace-overlay').hidden = false;
    window.pvh.stationDashboard(currentElectionId, s.id).then((dash) => {
      if (!dash.ok || !dash.election) return;
      const def = dash.election.close_grace_minutes || 30;
      const max = dash.election.max_close_grace_minutes || 120;
      input.max = max;
      input.value = def;
      hint.textContent = 'Max allowed on this election: ' + max + ' minutes.';
    });
    input.focus();
  }
  async function confirmGrace() {
    const s = window.__graceStation;
    const max = parseInt($('grace-min').max, 10) || 120;
    const grace = Math.max(0, parseInt($('grace-min').value, 10) || 0);
    if (grace > max) { window.pvhUI.toast('Grace period exceeds the maximum of ' + max + ' minutes.', 'error'); return; }
    $('grace-overlay').hidden = true;
    const res = await window.pvh.closeStationPolls(s.id, { graceMinutes: grace, officerName: officerName() });
    if (res.ok) { window.pvhUI.toast('Polls closed at ' + s.name + ' with ' + grace + ' min grace.', 'success'); renderStations(); }
    else window.pvhUI.toast(res.error || 'Could not close polls', 'error');
  }
  async function runSubmit(s) {
    const dash = await window.pvh.stationDashboard(currentElectionId, s.id);
    if (!dash.ok) { window.pvhUI.toast(dash.error || 'Could not load station figures', 'error'); return; }
    const stt = dash.stats || {};
    const checkedIn = stt.checkedIn || 0;
    const ballots = stt.ballots || 0;
    const grace = stt.grace || 0;
    const papers = ballots;
    const checks = [
      { ok: grace <= ballots, label: 'Grace-period votes (' + grace + ') do not exceed votes cast (' + ballots + ').' },
      { ok: checkedIn >= ballots, label: 'Votes cast (' + ballots + ') do not exceed voters checked in (' + checkedIn + ').' },
    ];
    const figures = { verifiedVoters: checkedIn, votesCast: ballots, graceVotes: grace, ballotPapersUsed: papers, spoiltBallots: 0, rejectedBallots: 0 };
    if (checks.some((c) => !c.ok)) {
      window.pvhUI.toast('Figure checks failed for ' + s.name + ' — review before submitting.', 'error');
      return;
    }
    if (!confirm('Seal and submit results for "' + s.name + '"?\n\nVerified voters: ' + checkedIn + '\nVotes cast: ' + ballots + '\nGrace votes: ' + grace + '\nPapers used: ' + papers)) return;
    const res = await window.pvh.submitStationPacket(s.id, { figures: figures, checks: checks, officerName: officerName() });
    if (res.ok) { window.pvhUI.toast('Results submitted for ' + s.name + '.', 'success'); renderStations(); }
    else window.pvhUI.toast(res.error || 'Could not submit results', 'error');
  }
  function runAction(s) { return {
    open: runOpen,
    close: openGraceModal,
    closeq: runCloseQueueNow,
    submit: runSubmit,
  }[s] || null; }

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
          '<td><div class="td-actions">' + runButtons(s) +
          '<button class="btn btn-secondary btn-sm" data-link="' + esc(s.id) + '">Check-in link</button> ' +
          '<button class="btn btn-danger btn-sm st-remove" data-id="' + esc(s.id) + '">Remove</button></div></td>' +
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
    body.querySelectorAll('[data-run]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const st = stations.find((x) => x.id === btn.dataset.id);
        const fn = runAction(btn.dataset.run);
        if (st && fn) fn(st);
      });
    });
    body.querySelectorAll('[data-link]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const st = stations.find((x) => x.id === btn.dataset.link);
        if (st) openLinkModal(st);
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

  function bindGraceModal() {
    const overlay = $('grace-overlay');
    function close() { overlay.hidden = true; window.__graceStation = null; }
    $('grace-close').addEventListener('click', close);
    $('grace-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
    $('grace-confirm').addEventListener('click', confirmGrace);
  }

  // ---- Secure browser check-in links (coordinator) ----
  function fmtLinkTime(t) {
    if (!t) return '—';
    return new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  async function renderLinkList(st) {
    const list = $('link-list');
    const r = await window.pvh.listCheckinLinks(currentElectionId);
    const mine = r.ok ? (r.links || []).filter((l) => l.station_id === st.id) : [];
    if (!mine.length) { list.innerHTML = '<p class="text-muted hint">No active links yet.</p>'; return; }
    list.innerHTML = mine.map((l) =>
      '<div class="check-row" style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;">' +
      '<div style="flex:1;min-width:0;">' +
      '<div style="font-size:12px;"><strong>' + esc(l.officer_name || 'Officer') + '</strong> &middot; ' + esc(l.station_code || '') + '</div>' +
      '<div class="text-muted" style="font-size:11px;">Valid until ' + fmtLinkTime(l.expires_at) + (l.valid ? '' : ' (expired)') + '</div>' +
      '</div>' +
      '<button class="btn btn-danger btn-sm" data-revoke="' + esc(l.id) + '">Revoke</button></div>').join('');
    list.querySelectorAll('[data-revoke]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Revoke this check-in link? The officer will immediately lose access.')) return;
        const rv = await window.pvh.revokeCheckinLink({ electionId: currentElectionId, tokenId: b.dataset.revoke });
        if (rv.ok) { window.pvhUI.toast('Check-in link revoked.', 'success'); renderLinkList(st); }
        else window.pvhUI.toast(rv.error || 'Could not revoke link', 'error');
      });
    });
  }
  async function openLinkModal(st) {
    window.__linkStation = st;
    $('link-station-sub').textContent = st.name + (st.code ? ' (' + st.code + ')' : '') + ' — the officer opens the link on any device.';
    $('link-generated').hidden = true;
    $('link-url').value = '';
    $('link-pin').textContent = '—';
    $('link-overlay').hidden = false;
    renderLinkList(st);
  }
  async function generateLink() {
    const st = window.__linkStation;
    if (!st) return;
    const btn = $('gen-link-btn');
    await window.pvhUI.busy(btn, 'Generating…', async () => {
      const r = await window.pvh.createCheckinLink({ electionId: currentElectionId, stationId: st.id });
      if (!r.ok) { window.pvhUI.toast(r.error || 'Could not generate link', 'error'); return; }
      $('link-url').value = r.url;
      $('link-pin').textContent = r.pin;
      $('link-expiry-note').textContent = 'Valid until polls close · officer on duty: ' + (r.officerName || '—') + '.';
      $('link-generated').hidden = false;
      window.pvhUI.toast('Check-in link generated. Share the PIN separately.', 'success');
      renderLinkList(st);
    });
  }
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through */ }
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    return true;
  }
  function bindLinkModal() {
    const overlay = $('link-overlay');
    function close() { overlay.hidden = true; window.__linkStation = null; }
    $('link-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
    $('gen-link-btn').addEventListener('click', generateLink);
    $('link-copy-url').addEventListener('click', () => { if (copyText($('link-url').value)) window.pvhUI.toast('Link copied.', 'success'); });
    $('link-copy-pin').addEventListener('click', () => { if (copyText($('link-pin').textContent.replace(/\s+/g, ''))) window.pvhUI.toast('PIN copied.', 'success'); });
  }

  const electionDD = buildSelectDropdown($('station-election-select'), (value) => {
    currentElectionId = value;
    renderStations();
  });
  electionDD.root.style.maxWidth = '380px';

  loadElectionOptions();
  bindAddStation();
  bindCreateOfficer();
  bindGraceModal();
  bindLinkModal();
})();
