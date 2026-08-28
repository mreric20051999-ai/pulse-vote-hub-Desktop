(function () {
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) return;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const isAdmin = session.role === 'admin';
  if (isAdmin) document.body.classList.add('is-admin');

  const pickerRoot = $('election-picker');
  const reportRoot = $('report-root');
  const reportPanel = $('report-panel');
  const actions = $('results-actions');
  let currentElectionId = null;
  let currentStationId = null;

  const COLORS = ['#B30202', '#dc2626', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];

  function statusLabel(r) {
    const s = r.status;
    if (s === 'active') return '<span class="rep-status live">LIVE</span>';
    if (s === 'upcoming') return '<span class="rep-status live">UPCOMING</span>';
    if (s === 'closed') return '<span class="rep-status ended">ENDED</span>';
    return '<span class="rep-status ended">DRAFT</span>';
  }

  function fmtNum(n) { return Number(n || 0).toLocaleString(); }

  // ---------- Election picker ----------
  async function loadElections() {
    pickerRoot.innerHTML = '<p class="text-muted hint">Loading elections…</p>';
    let list;
    try { list = await window.pvh.listElections(); } catch (e) { list = []; }
    if (!Array.isArray(list) || !list.length) {
      pickerRoot.innerHTML = '<p class="pick-empty">No elections yet. Create one in Elections to view its results report.</p>';
      return;
    }
    const statusMap = { draft: 'Draft', upcoming: 'Upcoming', active: 'Active', closed: 'Closed' };
    pickerRoot.innerHTML = list.map((e) => `
      <div class="pick-card" data-id="${esc(e.id)}" data-title="${esc(e.title)}">
        <div class="pick-card-title">${esc(e.title)}</div>
        <div class="pick-meta">
          <span>${e.type === 'station' ? 'Station' : 'School'}</span>
          <span>${statusMap[e.status] || '—'}</span>
        </div>
      </div>`).join('');
    pickerRoot.querySelectorAll('.pick-card').forEach((card) => {
      card.addEventListener('click', () => {
        currentElectionId = card.dataset.id;
        currentStationId = null;
        const q = new URLSearchParams(window.location.search);
        q.set('id', currentElectionId);
        history.replaceState(null, '', '?' + q.toString());
        loadReport();
      });
    });
  }

  // ---------- Report ----------
  async function loadReport() {
    if (!currentElectionId) return;
    reportPanel.style.display = '';
    reportRoot.innerHTML = '<p class="text-muted hint">Crunching the numbers…</p>';
    actions.style.display = 'inline-flex';
    let r;
    try { r = await window.pvh.resultsReport(currentElectionId, currentStationId); } catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) {
      if (r && r.code === 'forbidden') { reportRoot.innerHTML = '<p class="auth-error">You do not have access to this election.</p>'; return; }
      reportRoot.innerHTML = `<p class="auth-error">${esc((r && r.error) || 'Could not load results')}</p>`;
      return;
    }
    renderReport(r);
  }

  function renderReport(r) {
    const e = r.election;
    let html = `
      <div class="report-head">
        <div>
          <h2>${esc(e.title)}</h2>
          <p class="text-muted" style="font-size:13px;margin-top:4px;">${e.type === 'station' ? 'Past station-based election' : 'School-wide election'} &middot; ${fmtNum(r.totalVotes)} votes cast</p>
        </div>
        ${statusLabel(r)}
      </div>`;

    // Station filter (station-mode elections with stations available)
    if (e.type === 'station' && Array.isArray(r.stations) && r.stations.length) {
      html += `
        <div class="station-filter">
          <label class="label" for="station-filter">Station:</label>
          <select id="station-filter">
            <option value="">All Stations (Combined)</option>
            ${r.stations.map((s) => `<option value="${esc(s.id)}" ${currentStationId === s.id ? 'selected' : ''}>${esc(s.name)}${s.location ? ' — ' + esc(s.location) : ''}</option>`).join('')}
          </select>
        </div>`;
    }

    // Locked (not effectively closed)
    if (!r.effectivelyClosed) {
      const lockMsg =
        r.status === 'upcoming' ? 'This election has not started yet. Results will be published after it closes.'
        : r.status === 'active' ? 'Voting is currently in progress. Official results will be published here when the election closes.'
        : 'This election is a draft and is not open for results yet.';
      reportRoot.innerHTML = html + `
        <div class="locked-card">
          <h2 style="margin:0 0 8px;">Results Locked</h2>
          <p class="text-muted" style="margin:0 0 18px;">${lockMsg}</p>
          <div class="countdown-box" id="countdownBox">--:--:--</div>
        </div>`;
      startCountdown(r.status === 'upcoming' ? e.start_date : e.end_date, 'countdownBox');
      if (html.includes('station-filter')) bindStationFilter();
      return;
    }

    // Winner / tie
    if (r.winner) {
      html += `
        <div class="winner-card">
          <div class="wc-trophy">🏆</div>
          <div>
            <h2>${esc(r.winner.name)}</h2>
            <p>${fmtNum(r.winner.votes)} votes (${r.winner.percentage}%) &middot; ${esc(r.winner.catName)}</p>
          </div>
        </div>`;
    } else if (r.tie) {
      html += `
        <div class="winner-card">
          <div class="wc-trophy" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);">🤝</div>
          <div>
            <h2>${esc(r.tie.name)}</h2>
            <p>Co-winners — tied at ${fmtNum(r.tie.votes)} votes each</p>
          </div>
        </div>`;
    }

    // Stats
    html += `
      <div class="report-stats">
        <div class="report-stat"><div class="rs-value">${fmtNum(r.stats.votes)}</div><div class="rs-label">Total Votes</div></div>
        <div class="report-stat"><div class="rs-value">${r.stats.candidates}</div><div class="rs-label">Candidates</div></div>
        <div class="report-stat"><div class="rs-value">${r.stats.categories}</div><div class="rs-label">Categories</div></div>
      </div>`;

    // Charts
    const topCands = [];
    r.categories.forEach((c) => c.candidates.forEach((x) => topCands.push(x)));
    topCands.sort((a, b) => b.votes - a.votes);
    const pieSlice = topCands.slice(0, 8);
    html += `
      <div class="charts-grid">
        <div class="chart-box">
          <h3>Vote Distribution</h3>
          <canvas id="pieChart" height="200"></canvas>
        </div>
        <div class="chart-box">
          <h3>Votes by Category</h3>
          <canvas id="barChart" height="200"></canvas>
        </div>
      </div>`;

    // Ranking by category
    const catRows = r.categories.map((cat) => {
      const rows = cat.candidates.map((c, i) => {
        const rankCls = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-other';
        const barW = Math.max(2, Math.round((c.percentage / 100) * 100));
        return `
          <tr>
            <td><span class="rank-number ${rankCls}">${i + 1}</span></td>
            <td><strong>${esc(c.name)}</strong></td>
            <td><strong>${fmtNum(c.votes)}</strong></td>
            <td><strong>${c.percentage}%</strong></td>
            <td>
              <div style="display:flex;align-items:center;gap:10px;">
                <div class="bar-track"><div class="bar-fill" style="width:${barW}%"></div></div>
                <span style="font-size:12px;color:#64748b;">${c.percentage}%</span>
              </div>
            </td>
          </tr>`;
      }).join('');
      return `
        <table class="rank-table">
          <thead>
            <tr class="rank-cat-head"><td colspan="5">${esc(cat.name)} <span style="font-weight:400;font-size:12px;color:#64748b;">(${cat.candidates.length} candidate${cat.candidates.length === 1 ? '' : 's'} &bull; ${fmtNum(cat.votes)} votes)</span></td></tr>
            <tr><th>Rank</th><th>Candidate</th><th>Votes</th><th>Percentage</th><th>Progress</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    }).join('');

    html += `<div class="ranking" id="ranking-section">${catRows}</div>`;

    reportRoot.innerHTML = html;
    if (html.includes('station-filter')) bindStationFilter();
    drawCharts(r, pieSlice);
  }

  function bindStationFilter() {
    const sel = $('station-filter');
    if (!sel) return;
    sel.addEventListener('change', () => {
      currentStationId = sel.value || null;
      loadReport();
    });
  }

  // ---------- Charts (manual canvas) ----------
  function drawCharts(r, pieSlice) {
    const pie = $('pieChart');
    if (pie) {
      const ctx = pie.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      pie.width = pie.clientWidth * dpr; pie.height = 200 * dpr;
      ctx.scale(dpr, dpr); ctx.clearRect(0, 0, pie.width / dpr, 200);
      const w = pie.width / dpr, h = 200;
      const cx = w / 2, cy = h / 2, rad = Math.min(w, h) / 2 - 14;
      const total = pieSlice.reduce((s, c) => s + c.votes, 0);
      const colors = pieSlice.map((_, i) => COLORS[i % COLORS.length]);
      let a0 = -Math.PI / 2;
      if (total > 0) {
        pieSlice.forEach((c, i) => {
          const sweep = (c.votes / total) * Math.PI * 2;
          ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, rad, a0, a0 + sweep); ctx.closePath();
          ctx.fillStyle = colors[i]; ctx.fill();
          a0 += sweep;
        });
      }
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, rad * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0f172a'; ctx.font = '700 16px Poppins, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(fmtNum(total), cx, cy + 5);
      // Legend
      const legend = pieSlice.slice(0, 6);
      let ly = h - 2;
      ctx.font = '600 10px Open Sans, sans-serif'; ctx.textAlign = 'left';
      legend.forEach((c, i) => {
        if (ly < 20) return;
        ly -= 14;
        ctx.fillStyle = colors[i]; ctx.fillRect(8, ly - 8, 8, 8);
        ctx.fillStyle = '#475569'; ctx.fillText(truncate(c.name, 26) + ' · ' + (c.percentageOverall || c.percentage) + '%', 20, ly);
      });
    }
    const bar = $('barChart');
    if (bar) {
      const ctx = bar.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      bar.width = bar.clientWidth * dpr; bar.height = 200 * dpr;
      ctx.scale(dpr, dpr); ctx.clearRect(0, 0, bar.width / dpr, 200);
      const w = bar.width / dpr, h = 200;
      const cats = r.categories.slice(0, 8);
      const max = Math.max(1, ...cats.map((c) => c.votes));
      const labelW = Math.min(120, Math.max(40, w / (cats.length || 1) - 16));
      const startX = 30, baseY = h - 24;
      ctx.fillStyle = '#475569'; ctx.font = '600 10px Open Sans, sans-serif'; ctx.textAlign = 'center';
      cats.forEach((c, i) => {
        const barH = (c.votes / max) * (h - 60);
        const x = startX + i * (labelW + 12);
        ctx.fillStyle = 'rgba(179,2,2,0.75)';
        ctx.fillRect(x, baseY - barH, labelW, barH);
        ctx.fillStyle = '#0f172a'; ctx.fillText(fmtNum(c.votes), x + labelW / 2, baseY - barH - 5);
        ctx.fillStyle = '#64748b'; ctx.fillText(truncate(c.name, 8), x + labelW / 2, baseY + 12);
      });
    }
  }

  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // ---------- Countdown ----------
  function startCountdown(target, id) {
    const el = $(id);
    if (!el) return;
    const targetT = Number(target) || 0;
    if (!targetT) { el.textContent = '--:--:--'; return; }
    const tick = () => {
      let diff = targetT - Date.now();
      if (diff < 0) diff = 0;
      const d = Math.floor(diff / 86400000);
      const hh = Math.floor((diff % 86400000) / 3600000);
      const mm = Math.floor((diff % 3600000) / 60000);
      const ss = Math.floor((diff % 60000) / 1000);
      el.textContent = (d > 0 ? String(d).padStart(2, '0') + ':' : '') +
        String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
      if (diff === 0) loadReport(); else setTimeout(tick, 1000);
    };
    tick();
  }

  // ---------- Print ----------
  $('print-btn').addEventListener('click', () => window.print());

  // ---------- Init ----------
  const q = new URLSearchParams(window.location.search);
  const idFromUrl = q.get('id');
  loadElections();
  if (idFromUrl) {
    currentElectionId = idFromUrl;
    loadReport();
  }
})();
