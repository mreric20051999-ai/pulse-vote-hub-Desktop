// Live agent display: a focused, glanceable "counting card" wall view that
// polling agents watch to see their candidate's number tick up the moment a
// ballot lands on the hub. Each candidate is a card with a big live count; a
// new vote pops the number, fires a small celebration burst and a soft "peep".
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const REFRESH_MS = 3000;
  let currentElection = new URLSearchParams(location.search).get('election') || null;
  let timer = null;
  let prevCounts = {};      // candId -> last seen count
  let soundEnabled = true;  // on by default, user can mute
  let audioCtx = null;

  async function json(url) {
    const res = await fetch(url);
    let body = {};
    try { body = await res.json(); } catch (e) { body = {}; }
    return body;
  }

  function showError(msg, fatal) {
    const el = $('agent-error');
    el.hidden = false;
    el.textContent = msg || 'Could not load the live tally.';
    if (fatal) {
      clearInterval(timer);
      $('agent-main').hidden = true;
      $('agent-mast').hidden = true;
      $('agent-live').style.display = 'none';
    }
  }
  function hideError() { $('agent-error').hidden = true; }

  function fmt(n) { return Number(n || 0).toLocaleString(); }

  // ----- Audio (soft "peep" on each new vote) -----
  function ensureAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }
  function peep() {
    if (!soundEnabled) return;
    ensureAudio();
    if (!audioCtx) return;
    try {
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.setValueAtTime(1318, t + 0.08);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.36);
    } catch (e) { /* ignore */ }
  }

  // ----- Mute toggle -----
  const muteBtn = $('agent-mute');
  const DO = () => (window.pvhIcons && window.pvhIcons.icon) ? window.pvhIcons : null;
  const setMuteBtn = (enabled) => {
    const ic = DO();
    if (ic) muteBtn.innerHTML = ic.icon(enabled ? 'volume' : 'volumeX', 20);
    else muteBtn.innerHTML = '';
  };
  muteBtn.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    muteBtn.setAttribute('aria-pressed', String(soundEnabled));
    setMuteBtn(soundEnabled);
    ensureAudio();
  });

  // ----- Celebration burst -----
  function burst(cardEl) {
    const burstEl = $('agent-burst');
    const r = cardEl.getBoundingClientRect();
    burstEl.hidden = false;
    burstEl.style.left = (r.left + r.width / 2 - 24) + 'px';
    burstEl.style.top = (r.top + r.height / 2 - 24) + 'px';
    burstEl.classList.remove('go');
    void burstEl.offsetWidth; // restart animation
    burstEl.classList.add('go');
  }

  function onNewVote(cardEl) {
    burst(cardEl);
    peep();
  }

  // ----- Renderers -----

  function renderMast(d) {
    const e = d.election || {};
    $('agent-pick').hidden = true;
    $('agent-mast').hidden = false;
    $('agent-main').hidden = false;
    $('agent-title').textContent = e.title || '';
    $('agent-sub').textContent = (e.type === 'station' ? 'Station election' : 'School election') +
      ' · ' + (regimeText(d));
  }
  function regimeText(d) {
    return d.regime === 'sealed' ? 'Polling closed — final count' : 'Polling in progress — live';
  }

  function renderRecon(d) {
    const st = d.registered ? Math.min(100, Math.round(d.turnoutPct)) : 0;
    $('agent-recon').innerHTML = `
      <div class="agent-recon-card primary">
        <div class="agent-recon-num">${fmt(d.totalValid)}</div>
        <div class="agent-recon-label">Valid votes cast</div>
      </div>
      <div class="agent-recon-card">
        <div class="agent-recon-num">${fmt(d.castVoters)}</div>
        <div class="agent-recon-label">Voters who voted</div>
      </div>
      <div class="agent-recon-card">
        <div class="agent-recon-num">${fmt(d.registered)}</div>
        <div class="agent-recon-label">Registered voters</div>
      </div>
      <div class="agent-recon-card">
        <div class="agent-recon-num">${st}%</div>
        <div class="agent-recon-label">Turnout</div>
      </div>`;
  }

  // Counting-card wall: each candidate is a card with a big live number.
  function renderCards(d) {
    const cats = (d.categories || []).map((cat) => (cat.candidates || []).map((c) => {
      const prev = prevCounts[c.id] || 0;
      const inc = c.votes > prev;
      prevCounts[c.id] = c.votes;
      return `
        <div class="agent-card${inc ? ' pop' : ''}${c.votes > 0 && c.percentage >= 50 ? ' lead' : ''}" data-cand="${esc(c.id)}">
          <div class="agent-card-name">${esc(c.name)}</div>
          <div class="agent-card-num">${fmt(c.votes)}</div>
          <div class="agent-card-meta">${cat.name}</div>
        </div>`;
    }).join('')).join('');

    $('agent-cats').innerHTML = cats;
    // Fire celebration/sound for every card that just incremented.
    document.querySelectorAll('.agent-card.pop').forEach((cardEl) => onNewVote(cardEl));
  }

  function renderPicker(elections) {
    $('agent-main').hidden = true;
    $('agent-mast').hidden = true;
    $('agent-pick').hidden = false;
    const list = $('agent-pick-list');
    list.innerHTML = (elections || []).map((e) => `
      <button type="button" class="agent-pick-item" data-id="${esc(e.id)}">
        <span>${esc(e.title)}</span>
        <span class="ap-status">${esc(e.status || '')}</span>
      </button>`).join('') || '<p class="agent-hint">No elections available on this hub yet.</p>';
    list.querySelectorAll('.agent-pick-item').forEach((b) =>
      b.addEventListener('click', () => {
        currentElection = b.dataset.id;
        history.replaceState(null, '', '?election=' + encodeURIComponent(currentElection));
        prevCounts = {};
        load();
      }));
  }

  // ----- Load -----
  async function load() {
    try {
      if (!currentElection) {
        const resp = await json('/api/kiosk/elections');
        if (!resp.ok) { showError((resp && resp.error) || 'Could not load elections', true); return; }
        renderPicker(resp.elections);
        hideError();
        renderClock();
        return;
      }

      const resp = await json('/api/kiosk/agent-tally?election=' + encodeURIComponent(currentElection));
      if (!resp.ok) { showError((resp && resp.error) || 'Could not load the live tally', true); return; }

      renderMast(resp);
      renderRecon(resp);
      renderCards(resp);
      $('agent-refresh').textContent = resp.regime === 'sealed' ? 'final count' : 'auto-refreshes every 3s';
      document.title = 'Agent Live Tally · ' + esc((resp.election || {}).title || '');
      hideError();
      renderClock();
    } catch (err) {
      showError('Connection lost — retrying…', false);
    }
  }

  function renderClock() {
    const d = new Date();
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('agent-clock').textContent = 'Updated ' + t;
  }

  function start() {
    if (window.pvhIcons) window.pvhIcons.inject('.icon');
    setMuteBtn(soundEnabled);
    renderClock();
    load();
    clearInterval(timer);
    timer = setInterval(load, REFRESH_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
