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

  // ---------- Backup & recovery (admin/developer) ----------
  const backupPanel = $('backup-panel');
  if (backupPanel && isAdmin && window.pvh && typeof window.pvh.backupAutoGet === 'function') {
    backupPanel.hidden = false;

    const bk = {
      msg: $('dbk-msg'), enabled: $('dbk-auto-enabled'), interval: $('dbk-interval'),
      keep: $('dbk-keep'), dir: $('dbk-dir'), count: $('dbk-count'), list: $('dbk-list'),
      saveBtn: $('dbk-save-btn'), nowBtn: $('dbk-now-btn'), pickBtn: $('dbk-pick-btn'),
    };

    function fmtSize(n) {
      if (!n && n !== 0) return '';
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0;
      let v = Number(n);
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
      return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
    }
    function timeAgo(ts) {
      if (!ts) return '';
      const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (s < 60) return 'just now';
      const m = Math.floor(s / 60);
      if (m < 60) return `${m} min ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
      const d = Math.floor(h / 24);
      return `${d} day${d === 1 ? '' : 's'} ago`;
    }

    function renderList(backupsList) {
      if (!backupsList || !backupsList.length) {
        bk.list.innerHTML = '<p class="text-muted hint">Nothing saved yet — enable automatic backups or click "Back up now".</p>';
        bk.count.textContent = '';
        return;
      }
      bk.count.textContent = backupsList.length + (backupsList.length === 1 ? ' backup' : ' backups');
      bk.list.innerHTML = backupsList.map((b) => `
        <div class="ab-row" data-path="${esc(b.path)}">
          <div class="ab-row-info">
            <span class="ab-row-name">${esc(b.name)}</span>
            <span class="text-muted ab-row-meta">${fmtSize(b.size)} · ${timeAgo(b.mtime)}</span>
          </div>
          <button type="button" class="btn btn-danger btn-sm ab-restore" title="Verify and restore this backup">Restore</button>
        </div>`).join('');
    }

    async function refreshBackups() {
      const res = await window.pvh.backupAutoGet();
      if (!res || !res.ok) {
        bk.msg.textContent = (res && res.error) || 'Could not load backup settings.';
        bk.msg.className = 'auth-error';
        return;
      }
      const s = res.settings;
      bk.enabled.checked = !!s.enabled;
      bk.interval.value = s.intervalMin;
      bk.keep.value = s.keep;
      bk.dir.value = s.dir || '';
      renderList(s.backups);
    }

    const saveBackups = async () => {
      bk.msg.textContent = '';
      const settings = {
        enabled: bk.enabled.checked,
        intervalMin: Number(bk.interval.value) || 30,
        keep: Number(bk.keep.value) || 10,
        dir: bk.dir.value.trim(),
      };
      await window.pvhUI.busy(bk.saveBtn, 'Saving…', async () => {
        const res = await window.pvh.backupAutoSave(settings);
        if (!res || !res.ok) {
          bk.msg.textContent = (res && res.error) || 'Could not save backup settings.';
          bk.msg.className = 'auth-error';
          return;
        }
        const s = res.settings;
        renderList(s.backups);
        bk.msg.textContent = s.enabled ? 'Automatic backups enabled.' : 'Automatic backups disabled.';
        bk.msg.className = 'notice-ok';
        window.pvhUI.toast('Backup settings saved.', 'success');
      });
    };

    async function backupNow() {
      bk.msg.textContent = '';
      await window.pvhUI.busy(bk.nowBtn, 'Backing up…', async () => {
        const res = await window.pvh.backupAutoNow();
        if (!res || !res.ok) {
          bk.msg.textContent = (res && res.error) || 'Backup failed.';
          bk.msg.className = 'auth-error';
          window.pvhUI.toast((res && res.error) || 'Backup failed.', 'error');
          return;
        }
        if (res.settings) renderList(res.settings.backups);
        bk.msg.textContent = 'Backup saved to ' + res.path;
        bk.msg.className = 'notice-ok';
        window.pvhUI.toast('Backup created.', 'success');
      });
    }

    bk.saveBtn.addEventListener('click', saveBackups);
    bk.nowBtn.addEventListener('click', backupNow);
    bk.pickBtn.addEventListener('click', async () => {
      const res = await window.pvh.backupAutoPickDir();
      if (!res || !res.ok) {
        if (res && res.error && res.error !== 'Pick cancelled') {
          bk.msg.textContent = res.error;
          bk.msg.className = 'auth-error';
        }
        return;
      }
      bk.dir.value = res.path;
    });

    bk.list.addEventListener('click', async (e) => {
      const btn = e.target.closest('.ab-restore');
      if (!btn) return;
      const row = btn.closest('.ab-row');
      if (!row) return;
      const p = row.dataset.path;
      const nameEl = row.querySelector('.ab-row-name');
      const name = nameEl ? nameEl.textContent : 'this backup';
      if (!confirm(`Restore the database from "${name}"?\n\nThis replaces the current database and signs you out. The backup is fully verified first, and nothing changes if it fails the check. Continue?`)) return;
      bk.msg.textContent = 'Restoring…';
      bk.msg.className = '';
      await window.pvhUI.busy(btn, 'Restoring…', async () => {
        const res = await window.pvh.backupAutoRestore(p);
        if (!res || !res.ok) {
          bk.msg.textContent = (res && res.error) || 'Restore failed.';
          bk.msg.className = 'auth-error';
          window.pvhUI.toast((res && res.error) || 'Restore failed.', 'error');
          return;
        }
        bk.msg.textContent = 'Database restored successfully.';
        bk.msg.className = 'notice-ok';
        window.pvhUI.toast('Database restored. Signing you back in…', 'success');
        setTimeout(() => { window.location.assign('index.html'); }, 1200);
      });
    });

    refreshBackups();
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
