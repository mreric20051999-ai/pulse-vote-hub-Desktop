// Secure browser station check-in page. Runs against the LAN hub endpoints
// (/api/kiosk/station/*) — the same station module the desktop portal uses, so
// every check-in obeys poll-open, station-binding and single-check-in rules.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const params = new URLSearchParams(window.location.search);
  const TOKEN = params.get('t') || '';
  const SESSION_KEY = 'pvhs_' + (TOKEN ? TOKEN.slice(0, 16) : 'anon');
  const SESSION_TTL = 8 * 3600 * 1000;

  let state = null; // { session, election, station, officerName, voters, stats }
  let searchTerm = '';
  let refreshTimer = null;
  let countTimer = null;

  async function j(url, body) {
    try {
      const r = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Accept': 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await r.json();
      if (data && data.ok !== undefined) return data;
      return { ok: false, error: r.statusText || 'Server error' };
    } catch (err) {
      return { ok: false, error: 'Could not reach the polling station server.' };
    }
  }

  function setView(v) {
    ['pin-view', 'dash-view', 'err-view'].forEach((id) => { $(id).hidden = id !== v; });
  }
  function showErr(msg) {
    $('err-msg').textContent = msg || 'This check-in link is not valid.';
    setView('err-view');
  }
  function toast(msg, isErr) {
    const t = $('stl-toast');
    t.textContent = msg;
    t.className = isErr ? 'err' : '';
    t.style.display = 'block';
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.style.display = 'none'; }, isErr ? 3800 : 2200);
  }
  function failPin(msg) {
    const el = $('pin-error');
    el.textContent = msg || '';
    if (msg) toast(msg, true);
  }

  // ---- Poll status helpers (mirror the desktop portal) ----
  function statusLabel(s) { return s === 'queuing' ? 'Grace Period' : String(s || 'not_opened').replace(/_/g, ' '); }
  function statusDot(s) {
    return { not_opened: 'gray', open: 'green', queuing: 'amber', counted: 'blue', submitted: 'red' }[s] || 'gray';
  }

  function renderDashHeader() {
    if (!state) return;
    $('station-name').textContent = state.station.name || 'Unnamed Station';
    $('station-code').textContent = (state.station.code || state.station.id || '') + ' ';
    $('station-location').textContent = state.station.location ? ' · ' + state.station.location : '';
    $('officer-name').textContent = state.officerName || 'Officer';
    const s = state.station.effStatus || 'not_opened';
    $('statusText').textContent = statusLabel(s);
    $('statusPill').querySelector('.status-dot').className = 'status-dot ' + statusDot(s);
    $('st-reg').textContent = state.stats.registered || 0;
    $('st-in').textContent = state.stats.checkedIn || 0;
    $('st-q').textContent = state.stats.inQueue || 0;
    $('st-b').textContent = state.stats.ballots || 0;
    updateCountdown();
  }

  // ---- Live countdown: poll close (open) / grace end (queuing) ----
  function fmtRemaining(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function startCountdown(target, label, kind) {
    const box = $('countdown'), time = $('count-time'), lb = $('count-label');
    if (countTimer) { clearInterval(countTimer); countTimer = null; }
    lb.textContent = label || '';
    box.classList.toggle('is-grace', kind === 'grace');
    box.classList.toggle('is-closed', kind === 'closed');
    const targetMs = Number(target) || 0;
    const tick = () => {
      const rem = targetMs - Date.now();
      if (rem <= 0) {
        time.textContent = '00:00:00';
        if (countTimer) { clearInterval(countTimer); countTimer = null; }
        return;
      }
      time.textContent = fmtRemaining(rem);
    };
    if (!targetMs) { time.textContent = '00:00:00'; return; }
    tick();
    countTimer = setInterval(tick, 1000);
  }
  function updateCountdown() {
    if (!state) return;
    const eff = (state.station || {}).effStatus;
    const e = state.election || {}, st = state.station || {};
    if (eff === 'open' && e.end_date) startCountdown(e.end_date, 'Polls close in', 'open');
    else if (eff === 'queuing' && st.grace_ends_at) startCountdown(st.grace_ends_at, 'Grace period ends in', 'grace');
    else startCountdown(0, 'Polls closed', 'closed');
  }

  function voterRow(v) {
    const done = v.ballot_cast === 1;
    const inQ = v.checked_in === 1 && !done;
    const badge = done ? '<span class="voter-badge vb-done">Voted</span>'
      : inQ ? '<span class="voter-badge vb-in">Checked In</span>'
      : '<span class="voter-badge vb-none">Not Voted</span>';
    let btn = '';
    if (done) btn = '';
    else if (inQ) btn = '<button class="btn-checkin" disabled style="opacity:.5;">Checked In</button>';
    else btn = '<button class="btn-checkin btn-ci" data-vid="' + esc(v.id) + '" data-name="' + esc(v.name || '') + '" data-code="' + esc(v.voter_id || '') + '">Check In</button>';
    return '<div class="voter-row">' +
      '<div class="voter-avatar">' + esc(String(v.name || '?').charAt(0).toUpperCase()) + '</div>' +
      '<div class="voter-info"><div class="v-name">' + esc(v.name || 'Unnamed Voter') + '</div>' +
      '<div class="v-sub"><code>' + esc(v.voter_id || '') + '</code>' + (v.assigned_station ? ' · ' + esc(v.assigned_station) : '') + '</div></div>' +
      badge + btn + '</div>';
  }

  function renderPollbook() {
    const body = $('pollbook');
    if (!state) return;
    let list = state.voters || [];
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter((v) =>
        String(v.name || '').toLowerCase().indexOf(q) >= 0 ||
        String(v.voter_id || '').toLowerCase().indexOf(q) >= 0 ||
        String(v.assigned_station || '').toLowerCase().indexOf(q) >= 0);
    }
    body.innerHTML = list.length
      ? list.map(voterRow).join('')
      : '<div class="empty">' + ((state.voters || []).length ? 'No voters match your search.' : 'No voters are registered at this station.') + '</div>';
    body.querySelectorAll('.btn-ci').forEach((b) => {
      b.addEventListener('click', () => tryCheckIn(b.dataset.vid, b.dataset.name, b.dataset.code));
    });
  }

  async function tryCheckIn(vid, name, code) {
    const who = (name || code || 'this voter').trim();
    if (!confirm('Confirm you verified ' + who + ' in person.\nChecking them in consumes their ballot entitlement.')) return;
    const r = await j('/api/kiosk/station/checkin', { session: state.session, voterId: vid });
    if (r.ok) {
      const v = state.voters.find((x) => x.id === vid);
      if (v) { v.checked_in = 1; v.checked_in_by = state.officerName; }
      state.stats.checkedIn = (state.stats.checkedIn || 0) + 1;
      renderDashHeader(); renderPollbook();
      toast('Checked in — send them to the ballot page.');
    } else {
      if (r.code === 'no-session') { expireSession(); return; }
      toast(r.error || 'Check-in failed', true);
      await refreshPollbook();
    }
  }

  async function refreshPollbook() {
    if (!state) return;
    const r = await j('/api/kiosk/station/pollbook', { session: state.session });
    if (r.ok) {
      state.voters = r.voters || [];
      state.stats = r.stats || {};
      state.station = r.station || state.station;
      renderDashHeader(); renderPollbook();
    } else if (r.code === 'no-session') {
      expireSession();
    }
  }

  function expireSession() {
    sessionStorage.removeItem(SESSION_KEY);
    state = null;
    clearInterval(refreshTimer); refreshTimer = null;
    if (countTimer) { clearInterval(countTimer); countTimer = null; }
    setView('pin-view');
    failPin('Your session ended. Enter the PIN again to continue.');
  }

  // ---- Unlock ----
  async function doUnlock() {
    const pin = $('pin-input').value.trim();
    if (pin.length !== 6) { failPin('Enter the 6-digit PIN from your coordinator.'); return; }
    const btn = $('unlock-btn');
    btn.disabled = true; btn.textContent = 'Verifying…';
    const r = await j('/api/kiosk/station/unlock', { token: TOKEN, pin: pin });
    btn.disabled = false; btn.textContent = 'Unlock check-in';
    if (!r.ok) {
      if (r.code === 'bad-link' || r.code === 'revoked' || r.code === 'expired' || r.code === 'session-limit') { showErr(r.error); return; }
      failPin(r.error || 'Could not unlock.');
      return;
    }
    state = {
      session: r.session,
      election: r.election,
      station: r.station,
      officerName: r.officerName || '',
      voters: r.voters || [],
      stats: r.stats || {},
    };
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ session: r.session })); } catch (e) { /* private mode */ }
    $('pin-input').value = '';
    failPin('');
    renderDashHeader(); renderPollbook();
    setView('dash-view');
    refreshTimer = setInterval(refreshPollbook, 8000);
  }

  // ---- Init ----
  $('unlock-btn').addEventListener('click', doUnlock);
  $('pin-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
  $('pin-input').addEventListener('input', () => {
    $('pin-input').value = $('pin-input').value.replace(/[^0-9]/g, '').slice(0, 6);
    failPin('');
  });
  $('search').addEventListener('input', function () { searchTerm = this.value.toLowerCase(); renderPollbook(); });
  $('lock-btn').addEventListener('click', expireSession);
  $('err-again-btn').addEventListener('click', () => { setView('pin-view'); failPin(''); });

  async function init() {
    if (!TOKEN) { showErr('This check-in link is missing its access token.'); return; }

    // Restore a still-valid session on reload.
    try {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (saved && saved.session) {
        state = { session: saved.session };
        const r = await j('/api/kiosk/station/pollbook', { session: saved.session });
        if (r.ok) {
          state.election = r.election; state.station = r.station; state.stats = r.stats || {};
          state.voters = r.voters || []; state.officerName = r.officerName || '';
          renderDashHeader(); renderPollbook();
          setView('dash-view');
          refreshTimer = setInterval(refreshPollbook, 8000);
          return;
        }
        state = null;
      }
    } catch (e) { /* fall through to PIN entry */ }
    setView('pin-view');
    $('pin-input').focus();
  }

  init();
})();