(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) return;

  const isAdmin = session.role === 'admin' || session.role === 'developer';

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

  // ---------- Browser ballot (LAN kiosk, shared hub) ----------
  const kb = {
    start: $('kb-start'), stop: $('kb-stop'), msg: $('kb-msg'), links: $('kb-links'),
    agentLinks: $('kb-agent-links'),
    publicLinks: $('kb-public-links'),
    stopped: $('kb-stopped'), running: $('kb-running'), port: $('kb-port'), votes: $('kb-votes'),
  };
  const hasLan = kb.start && window.pvh && typeof window.pvh.lanSetMode === 'function';

  function linkList(ul, urls) {
    ul.innerHTML = urls.length
      ? urls.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a><button type="button" class="btn btn-sm btn-ghost kb-copy" data-u="${esc(u)}">Copy</button></li>`).join('')
      : '<li class="text-muted hint">No LAN address detected — check the network connection.</li>';
    ul.querySelectorAll('.kb-copy').forEach((b) => {
      b.addEventListener('click', () => {
        const done = () => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(b.dataset.u).then(done, () => { window.prompt('Copy the link', b.dataset.u); done(); });
        } else { window.prompt('Copy the link', b.dataset.u); done(); }
      });
    });
  }

  function renderKiosk(s) {
    const host = s && s.mode === 'host';
    if (!host) {
      kb.stopped.style.display = '';
      kb.running.style.display = 'none';
      kb.msg.textContent = '';
      return;
    }
    kb.stopped.style.display = 'none';
    kb.running.style.display = '';
    linkList(kb.links, s.kioskUrls || []);
    linkList(kb.agentLinks, s.agentUrls || []);
    linkList(kb.publicLinks, s.publicUrls || []);
    kb.votes.textContent = (s.stats && s.stats.votes) || 0;
    kb.msg.textContent = '';
  }

  if (hasLan) {
    kb.start.addEventListener('click', async () => {
      kb.msg.textContent = '';
      const res = await window.pvh.lanSetMode('host', { port: Number(kb.port.value) || 7380 });
      if (!res || res.ok === false) kb.msg.textContent = (res && res.error) || 'Could not start the ballot server.';
      else if (window.pvh.lanStatus) renderKiosk(await window.pvh.lanStatus());
    });
    kb.stop.addEventListener('click', async () => {
      const res = await window.pvh.lanStop();
      if (res && res.ok && window.pvh.lanStatus) renderKiosk(await window.pvh.lanStatus());
    });
    window.pvh.onLanStatus(renderKiosk);
    if (window.pvh.lanStatus) window.pvh.lanStatus().then(renderKiosk);
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
