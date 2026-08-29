(function () {
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // A station officer must be signed in and assigned to a station.
  if (!session || session.role !== 'assistant' || !session.assigned_station_id) {
    $('station-dash').hidden = true;
    $('station-unassigned').hidden = false;
    if (session) $('unassigned-msg').textContent =
      session.role !== 'assistant'
        ? 'Only station officers (assistant accounts assigned to a station) can use this portal.'
        : $('unassigned-msg').textContent;
    return;
  }

  const STATION_ID = session.assigned_station_id;
  const $el = {};

  let election = null;      // election object
  let station = null;       // station object (with effStatus)
  let voters = [];          // voters for this station
  let stats = {};
  let incidents = [];       // in-memory (session transient)
  let logs = [];            // in-memory activity log
  let searchTerm = '';
  let refreshTimer = null;
  let clockTimer = null;

  function fmtTime(t) {
    if (!t) return '—';
    return new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function effectiveStatus() {
    return station ? station.effStatus : 'not_opened';
  }
  function isOpen() { const s = effectiveStatus(); return s === 'open' || s === 'queuing'; }
  function logEvent(action, detail) {
    logs = [{ id: 'L' + Date.now(), at: new Date().toISOString(), action, detail, byName: session.name }, ...logs];
  }
  function statusPillClass(s) { return 'st-' + (s || 'not_opened'); }
  function statusDot(s) {
    return { not_opened: 'gray', open: 'green', queuing: 'amber', counted: 'blue', submitted: 'red' }[s] || 'gray';
  }
  function statusLabel(s) { return s === 'queuing' ? 'Grace Period' : String(s || 'not_opened').replace(/_/g, ' '); }

  // modal helper
  function openModal(html) {
    $('modal-box').innerHTML = html;
    $('modal-overlay').hidden = false;
  }
  function closeModal() { $('modal-overlay').hidden = true; }
  window.stationCloseModal = closeModal;
  $('modal-overlay').addEventListener('click', (e) => { if (e.target === $('modal-overlay')) closeModal(); });

  // countdown
  function fmtCountdown(ms) {
    if (ms <= 0) return '00:00:00';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return p(h) + ':' + p(m) + ':' + p(sec);
  }

  async function loadDashboard() {
    const assigned = session.assigned_election_id;
    if (!assigned) { $('station-dash').hidden = true; $('station-unassigned').hidden = false; return; }
    const res = await window.pvh.stationDashboard(assigned, STATION_ID);
    if (!res.ok) {
      $('station-dash').hidden = true;
      $('station-unassigned').hidden = false;
      $('unassigned-msg').textContent = res.error || 'Could not load your station.';
      return;
    }
    election = res.election;
    station = res.station;
    voters = res.voters || [];
    stats = res.stats || {};
    renderAll();
  }

  function renderAll() {
    $('station-dash').hidden = false;
    $('election-tag').textContent = election.title || 'Station Election';
    $('station-name').textContent = station.name || 'Unnamed Station';
    $('station-code').textContent = station.code || station.id || '';
    const s = effectiveStatus();
    const pill = $('statusPill');
    pill.className = 'status-pill ' + statusPillClass(s);
    pill.querySelector('.status-dot').className = 'status-dot ' + statusDot(s);
    $('statusText').textContent = statusLabel(s);

    $('statRegistered').textContent = stats.registered;
    $('statCheckedIn').textContent = stats.checkedIn;
    $('statInQueue').textContent = stats.inQueue;
    $('statBallots').textContent = stats.ballots;
    $('statGrace').textContent = stats.grace;

    renderPollsControl();
    renderQueue();
    renderPollbook();
    renderIncidents();
    renderLogs();
  }

  // ---- Polls control ----
  function canClose() {
    return election && election.end_date && Date.now() >= Number(election.end_date);
  }
  function renderPollsControl() {
    const body = $('pollsBody');
    const s = effectiveStatus();
    const endTime = election && election.end_date ? Number(election.end_date) : null;

    if (s === 'submitted') {
      body.innerHTML = '<div class="poll-actions"><div class="action-btn" style="cursor:default;"><div><strong>Results Submitted</strong><span class="ab-sub">Packet sealed — only an administrator can override.</span></div></div></div>';
      return;
    }
    if (s === 'counted') {
      body.innerHTML = '<div class="poll-actions"><button class="action-btn" onclick="stationOpenSubmit()"><div><strong>Submit Results</strong><span class="ab-sub">Station counted — review figures and submit the final packet.</span></div></button></div>';
      return;
    }
    if (s === 'queuing') {
      body.innerHTML = '<div class="poll-actions"><div class="action-btn" style="cursor:default;"><div><strong>Grace Period Active</strong><span class="ab-sub">Checked-in voters may finish casting until the window ends.</span></div></div>' +
        '<button class="btn btn-block btn-amber" onclick="stationCloseQueueNow()"><i class="fa-solid fa-flag-checkered"></i> Close Queue Now</button></div>';
      return;
    }
    if (s === 'open') {
      body.innerHTML = '<div class="poll-actions">' +
        (canClose()
          ? '<button class="action-btn" onclick="stationOpenClose(false)"><div><strong>Close Polls</strong><span class="ab-sub">Set the grace period and close the queue.</span></div></button>'
          : '<div class="countdown"><div><div class="cd-num cd-live" id="cdEnd">—</div><div class="cd-lbl">until polls close</div></div></div>') +
        '</div>';
      return;
    }
    // not_opened
    const cb = canClose() ? '' :
      '<div class="countdown" style="margin-bottom:10px;"><div><div class="cd-num cd-live" id="cdStart">—</div><div class="cd-lbl">until polls open</div></div></div>';
    body.innerHTML = '<div class="poll-actions">' + cb +
      '<button class="btn btn-block btn-green" onclick="stationOpenPolls()"><i class="fa-solid fa-door-open"></i> Open Polls</button></div>';
  }

  function renderQueue() {
    const body = $('queueBody');
    const s = effectiveStatus();
    const inQueue = Math.max(0, stats.checkedIn - stats.ballots);
    body.innerHTML =
      '<div class="countdown" style="margin-bottom:10px;"><div><div class="cd-num cd-live" id="cdQueueCount">' + inQueue + '</div><div class="cd-lbl">in queue (checked in, not yet voted)</div></div></div>' +
      (s === 'queuing'
        ? '<div class="countdown"><div><div class="cd-num cd-warn" id="cdGrace">—</div><div class="cd-lbl">grace period remaining</div></div></div>'
        : (s === 'open'
          ? '<div class="hint"><i class="fa-solid fa-circle-info"></i> Voters are checked in as they arrive and marked as voted once they cast on the ballot page.</div>'
          : '<div class="hint"><i class="fa-solid fa-circle-info"></i> Queue statistics appear here once polls are open.</div>'));
  }

  function renderCountdowns() {
    const now = Date.now();
    const cdStart = $('cdStart');
    if (cdStart && election.start_date) cdStart.textContent = fmtCountdown(Number(election.start_date) - now);
    const cdEnd = $('cdEnd');
    if (cdEnd && election.end_date) cdEnd.textContent = fmtCountdown(Number(election.end_date) - now);
    const cdGrace = $('cdGrace');
    if (cdGrace && station.grace_ends_at) {
      const g = Number(station.grace_ends_at);
      cdGrace.textContent = fmtCountdown(g - now);
      cdGrace.className = 'cd-num ' + ((g - now) < 300000 ? 'cd-end' : 'cd-warn');
    }
  }

  // ---- E-pollbook ----
  function renderPollbook() {
    const body = $('pollbookBody');
    let list = voters;
    if (searchTerm) {
      list = list.filter((v) =>
        String(v.voter_id || '').toLowerCase().indexOf(searchTerm) >= 0 ||
        String(v.name || '').toLowerCase().indexOf(searchTerm) >= 0 ||
        String(v.assigned_station || '').toLowerCase().indexOf(searchTerm) >= 0);
    }
    const s = effectiveStatus();
    const canCheckIn = isOpen();
    if (!list.length) {
      body.innerHTML = '<div class="empty">' + (voters.length ? 'No voters match your search.' : 'No voters are registered at this station yet.') + '</div>';
      return;
    }
    body.innerHTML = list.map((v) => {
      const done = v.ballot_cast === 1;
      const inQ = v.checked_in === 1 && !done;
      const badge = done ? '<span class="voter-badge vb-done">Voted</span>'
        : inQ ? '<span class="voter-badge vb-in">In Queue</span>'
        : '<span class="voter-badge vb-none">Not Voted</span>';
      let btn = '';
      if (!done) {
        if (inQ) btn = '<button class="btn-checkin" disabled style="opacity:.5;">Checked In</button>';
        else if (canCheckIn) btn = '<button class="btn-checkin" onclick="stationCheckIn(\'' + esc(v.id) + '\',\'' + esc(v.name || 'Unnamed') + '\')">Check In</button>';
        else btn = '<button class="btn-checkin" disabled style="opacity:.4;">Locked</button>';
      }
      return '<div class="voter-row">' +
        '<div class="voter-avatar">' + esc(String(v.name || '?').charAt(0).toUpperCase()) + '</div>' +
        '<div class="voter-info"><div class="v-name">' + esc(v.name || 'Unnamed Voter') + '</div>' +
        '<div class="v-sub"><code>' + esc(v.voter_id || '') + '</code>' + (v.assigned_station ? ' · ' + esc(v.assigned_station) : '') + '</div></div>' +
        badge + btn + '</div>';
    }).join('');
  }

  window.stationCheckIn = function (id, name) {
    openModal('<h3>Check In Voter</h3>' +
      '<p class="m-sub">Confirm you have verified the identity of <strong>' + esc(name) + '</strong> in person. Checking them in consumes their ballot entitlement.</p>' +
      '<div class="modal-actions"><button class="btn btn-ghost" onclick="stationCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="mCiBtn" onclick="stationConfirmCheckIn(\'' + id + '\')">Confirm Check In</button></div>');
  };
  window.stationConfirmCheckIn = async function (id) {
    const b = $('mCiBtn'); b.disabled = true; b.textContent = 'Checking in…';
    const res = await window.pvh.stationCheckin(id, { officerName: session.name });
    if (res.ok) { closeModal(); logEvent('checkin', 'Voter checked in.'); if (window.pvhAudio) window.pvhAudio.playSuccess(); await loadDashboard(); showToast('Voter checked in — send them to the ballot page.'); }
    else { b.disabled = false; b.textContent = 'Confirm Check In'; if (window.pvhAudio) window.pvhAudio.playError(); showToast(res.error || 'Check-in failed', true); }
  };

  // ---- Actions ----
  window.stationOpenPolls = async function () {
    if (!confirm('Open polls at this station and record a zero report? Voters can then be checked in.')) return;
    const res = await window.pvh.openStationPolls(STATION_ID, { officerName: session.name });
    if (res.ok) { logEvent('open', 'Polls opened — zero report recorded.'); await loadDashboard(); showToast('Polls opened.'); }
    else showToast(res.error || 'Could not open polls', true);
  };

  window.stationOpenClose = function () {
    const defGrace = election.close_grace_minutes || 30;
    const maxGrace = election.max_close_grace_minutes || 120;
    openModal('<h3>Close Polls</h3>' +
      '<p class="m-sub">Set a grace period so voters already in line can finish casting. Zero ends the queue immediately.</p>' +
      '<div class="field"><label class="label" for="grace-min">Grace period (minutes)</label>' +
      '<input class="input" id="grace-min" type="number" min="0" max="' + maxGrace + '" value="' + defGrace + '"></div>' +
      '<p class="text-muted" style="font-size:var(--fs-xs);">Max allowed on this election: ' + maxGrace + ' minutes.</p>' +
      '<div class="modal-actions"><button class="btn btn-ghost" onclick="stationCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="mCloseBtn" onclick="stationConfirmClose()">Close Polls</button></div>');
  };
  window.stationConfirmClose = async function () {
    const grace = Math.max(0, parseInt($('grace-min').value, 10) || 0);
    const maxGrace = election.max_close_grace_minutes || 120;
    if (grace > maxGrace) { showToast('Grace period exceeds the maximum of ' + maxGrace + ' minutes.', true); return; }
    const b = $('mCloseBtn'); b.disabled = true; b.textContent = 'Closing…';
    const res = await window.pvh.closeStationPolls(STATION_ID, { graceMinutes: grace, officerName: session.name });
    if (res.ok) { closeModal(); logEvent('close', 'Polls closed with ' + grace + 'm grace.'); await loadDashboard(); showToast(grace > 0 ? 'Polls closed — grace period active.' : 'Polls closed — station counted.'); }
    else { b.disabled = false; b.textContent = 'Close Polls'; showToast(res.error || 'Could not close polls', true); }
  };

  window.stationCloseQueueNow = async function () {
    if (!confirm('Close the queue now? Any voter still queued but not yet cast will be unable to vote.')) return;
    const res = await window.pvh.closeStationQueue(STATION_ID, { officerName: session.name });
    if (res.ok) { logEvent('close', 'Queue closed immediately.'); await loadDashboard(); showToast('Queue closed — station counted.'); }
    else showToast(res.error || 'Could not close queue', true);
  };

  window.stationOpenSubmit = function () {
    const checkedIn = stats.checkedIn, ballots = stats.ballots, grace = stats.grace;
    const papers = ballots; // best-effort: papers used == ballots cast
    const spoilt = 0, rejected = 0;
    const checks = [];
    const pushCheck = (ok, label) => checks.push({ ok, label });
    pushCheck(grace <= ballots, 'Grace-period votes (' + grace + ') do not exceed votes cast (' + ballots + ').');
    pushCheck(checkedIn >= ballots, 'Votes cast (' + ballots + ') do not exceed voters checked in (' + checkedIn + ').');
    const figures = { verifiedVoters: checkedIn, votesCast: ballots, graceVotes: grace, ballotPapersUsed: papers, spoiltBallots: spoilt, rejectedBallots: rejected };
    openModal('<h3>Submit Results</h3><p class="m-sub">Review the figures below and seal the final packet. This is locked afterwards.</p>' +
      '<div class="figure-grid">' +
      '<div class="figure-card"><div class="f-num">' + checkedIn + '</div><div class="f-lbl">Verified voters</div></div>' +
      '<div class="figure-card"><div class="f-num">' + ballots + '</div><div class="f-lbl">Votes cast</div></div>' +
      '<div class="figure-card"><div class="f-num">' + grace + '</div><div class="f-lbl">Grace votes</div></div>' +
      '<div class="figure-card"><div class="f-num">' + papers + '</div><div class="f-lbl">Papers used</div></div>' +
      '</div>' +
      '<div class="checks-list">' + checks.map((c) =>
        '<div class="check-row"><span class="' + (c.ok ? 'ck-ok' : 'ck-bad') + '">' + (c.ok ? 'PASS' : 'FAIL') + '</span><span>' + esc(c.label) + '</span></div>').join('') + '</div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" onclick="stationCloseModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="mSubBtn" onclick="stationConfirmSubmit()">Seal &amp; Submit</button></div>');
    window.__figures = figures;
    window.__checks = checks;
  };
  window.stationConfirmSubmit = async function () {
    const b = $('mSubBtn'); b.disabled = true; b.textContent = 'Submitting…';
    const res = await window.pvh.submitStationPacket(STATION_ID, {
      figures: window.__figures,
      checks: window.__checks,
      officerName: session.name,
    });
    if (res.ok) {
      closeModal(); logEvent('submit', 'Results submitted — packet sealed.');
      await loadDashboard(); showToast('Results submitted successfully.');
    } else { b.disabled = false; b.textContent = 'Seal & Submit'; showToast(res.error || 'Could not submit', true); }
  };

  // ---- Incidents + logs ----
  $('incSubmit').addEventListener('click', () => {
    const message = $('incMessage').value.trim();
    const type = $('incType').value;
    if (!message) { showToast('Describe the incident first.', true); return; }
    incidents = [{ type, message, at: new Date().toISOString(), byName: session.name }, ...incidents];
    $('incMessage').value = '';
    renderIncidents();
    showToast('Incident logged.');
  });
  function renderIncidents() {
    const body = $('incidentsList');
    if (!incidents.length) { body.innerHTML = '<div class="empty">No incidents logged.</div>'; return; }
    body.innerHTML = incidents.slice(0, 20).map((i) =>
      '<div class="inc-item"><div class="inc-top"><span class="inc-type">' + esc(i.type) + '</span><span class="inc-time">' + fmtTime(i.at) + '</span></div>' +
      '<div class="inc-msg">' + esc(i.message) + '</div></div>').join('');
  }
  function renderLogs() {
    const body = $('logsList');
    if (!logs.length) { body.innerHTML = '<div class="empty">No activity yet.</div>'; return; }
    body.innerHTML = logs.slice(0, 30).map((l) =>
      '<div class="inc-item"><div class="inc-top"><span class="inc-type" style="color:var(--info);">' + esc(l.action) + '</span><span class="inc-time">' + fmtTime(l.at) + '</span></div>' +
      '<div class="inc-msg">' + esc(l.detail) + ' <span style="color:var(--text-dim);">— ' + esc(l.byName) + '</span></div></div>').join('');
  }

  // toast helper (minimal) — delegates to the shared pvhUI toasts
  function showToast(msg, isError) {
    if (isError && window.pvhAudio) window.pvhAudio.playError();
    if (window.pvhUI) window.pvhUI.toast(msg, isError ? 'error' : 'info');
  }

  // ---- Init ----
  $('pollSearch').addEventListener('input', function () { searchTerm = this.value.toLowerCase(); renderPollbook(); });

  loadDashboard();
  refreshTimer = setInterval(loadDashboard, 10000);
  clockTimer = setInterval(renderCountdowns, 1000);
})();
