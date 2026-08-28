(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) return;

  const isAdmin = session.role === 'admin';

  $('status-pill').innerHTML = `<span class="status-dot ${isAdmin ? 'success' : 'info'}"></span>${isAdmin ? 'Administrator' : 'Signed in'}`;
  if (isAdmin) document.body.classList.add('is-admin');
  $('page-subtitle').textContent = isAdmin
    ? 'Admin overview — election activity'
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
    if (!list.length) {
      $('active-panel').hidden = false;
      el.innerHTML = `
        <div class="active-empty">
          <p class="text-muted hint">No elections are currently running. Create or select an election to configure it and start voting.</p>
          <button class="btn btn-secondary" id="go-to-elections-btn"><span class="icon btn-icon" data-icon="elections"></span>Go to Elections</button>
        </div>`;
      const btn = $('go-to-elections-btn');
      if (btn) btn.addEventListener('click', () => { window.location.assign('elections.html'); });
      return;
    }
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

  // ---------- Init ----------
  loadStats();
  renderActive();

  // Refresh stats + active elections when returning to this page
  window.addEventListener('focus', () => {
    loadStats();
    renderActive();
  });
})();
