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
  let lastReport = null;

  const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899'];

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
    lastReport = r;
    const e = r.election;
    let html = `
      <div class="report-head">
        <div>
          <h2>${esc(e.title)}</h2>
          <p class="text-muted" style="font-size:13px;margin-top:4px;">${e.type === 'station' ? 'Past station-based election' : 'School-wide election'} &middot; ${fmtNum(r.totalVotes)} votes cast</p>
        </div>
        ${statusLabel(r)}
      </div>`;

    // Station breakdown (station-mode elections with stations available)
    if (e.type === 'station' && Array.isArray(r.stations) && r.stations.length) {
      const statusMap = { not_opened: 'Not opened', open: 'Open', queuing: 'Queuing', counted: 'Counted', submitted: 'Submitted' };
      const sRows = r.stations.map((s) => {
        s.turnoutPct = s.turnoutPct || 0;
        return `
          <tr class="${currentStationId === s.id ? 'row-active' : ''}" data-sid="${esc(s.id)}">
            <td><strong>${esc(s.name)}</strong>${s.location ? '<div class="text-muted" style="font-size:12px;">' + esc(s.location) + '</div>' : ''}</td>
            <td><span class="st-status st-${esc(s.status)}">${esc(statusMap[s.status] || s.status)}</span></td>
            <td>${fmtNum(s.registered)}</td>
            <td>${fmtNum(s.cast)}</td>
            <td>
              <div class="mini-bar"><div class="mini-fill" style="width:${Math.min(100, s.turnoutPct)}%"></div></div>
              <span class="text-muted" style="font-size:12px;">${s.turnoutPct}%</span>
            </td>
            <td>${s.submitted ? '<span class="st-submitted">Submitted</span>' : '<span class="st-pending">Pending</span>'}</td>
          </tr>`;
      }).join('');
      html += `
        <div class="station-breakdown">
          <h3 class="section-title">Station Breakdown</h3>
          <div class="station-filter">
            <label class="label" for="station-filter">Candidate results for:</label>
            <select id="station-filter">
              <option value="">All Stations (Combined)</option>
              ${r.stations.map((s) => `<option value="${esc(s.id)}" ${currentStationId === s.id ? 'selected' : ''}>${esc(s.name)}${s.location ? ' — ' + esc(s.location) : ''}</option>`).join('')}
            </select>
          </div>
          <table class="rank-table station-table">
            <thead>
              <tr><th>Station</th><th>Status</th><th>Registered</th><th>Cast</th><th>Turnout</th><th>Submission</th></tr>
            </thead>
            <tbody>${sRows}</tbody>
          </table>
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
    const t = r.turnout || { registered: 0, cast: 0, turnoutPct: 0 };
    html += `
      <div class="report-stats">
        <div class="report-stat"><div class="rs-value">${fmtNum(r.stats.votes)}</div><div class="rs-label">Total Votes</div></div>
        <div class="report-stat"><div class="rs-value">${fmtNum(t.registered)}</div><div class="rs-label">Registered</div></div>
        <div class="report-stat"><div class="rs-value">${fmtNum(t.cast)}</div><div class="rs-label">Voters Cast</div></div>
        <div class="report-stat"><div class="rs-value">${t.turnoutPct}%</div><div class="rs-label">Turnout</div></div>
        <div class="report-stat"><div class="rs-value">${r.stats.candidates}</div><div class="rs-label">Candidates</div></div>
        <div class="report-stat"><div class="rs-value">${r.stats.categories}</div><div class="rs-label">Categories</div></div>
      </div>
      <div class="turnout-bar">
        <div class="turnout-fill" style="width:${Math.min(100, t.turnoutPct)}%"></div>
        <span class="turnout-label">${t.turnoutPct}% turnout (${fmtNum(t.cast)} of ${fmtNum(t.registered)} registered voters)</span>
      </div>`;

    // Per-category winners
    const cwPct = (v) => Math.max(3, Math.min(100, v || 0));
    const winChips = (r.categoryWinners || []).map((cw) => {
      if (cw.mode === 'win') {
        return `
          <div class="cat-winner">
            <div class="cw-top">
              <span class="cw-cat">${esc(cw.name)}</span>
              <span class="cw-badge" title="Winner">W</span>
            </div>
            <div class="cw-name" title="${esc(cw.winner.name)}">${esc(cw.winner.name)}</div>
            <div class="cw-meta">
              <span class="cw-votes">${fmtNum(cw.winner.votes)} votes</span>
              <span class="cw-pct">${cw.winner.percentage}%</span>
            </div>
            <div class="cw-bar"><div class="cw-fill" style="width:${cwPct(cw.winner.percentage)}%"></div></div>
          </div>`;
      }
      if (cw.mode === 'tie') {
        return `
          <div class="cat-winner tie">
            <div class="cw-top">
              <span class="cw-cat">${esc(cw.name)}</span>
              <span class="cw-badge tie" title="Tie">T</span>
            </div>
            <div class="cw-name" title="${esc(cw.names.join(' & '))}">${esc(cw.names.join(' & '))}</div>
            <div class="cw-meta">
              <span class="cw-votes">Tied at ${fmtNum(cw.votes)} each</span>
            </div>
            <div class="cw-bar"><div class="cw-fill tie" style="width:${cwPct(50)}%"></div></div>
          </div>`;
      }
      return `
        <div class="cat-winner empty">
          <div class="cw-top">
            <span class="cw-cat">${esc(cw.name)}</span>
          </div>
          <div class="cw-name">No votes cast</div>
        </div>`;
    }).join('');
    if (winChips) {
      const catCount = (r.categoryWinners || []).length;
      html += `
        <div class="winners-card">
          <div class="winners-head">
            <h3 class="section-title">Winners by Category</h3>
            <span class="winners-count">${catCount} categor${catCount === 1 ? 'y' : 'ies'}</span>
          </div>
          <div class="winners-grid">${winChips}</div>
        </div>`;
    }

    // Charts
    const topCands = [];
    r.categories.forEach((c) => c.candidates.forEach((x) => topCands.push(x)));
    topCands.sort((a, b) => b.votes - a.votes);
    const pieSlice = topCands.slice(0, 8);
    html += `
      <div class="charts-grid">
        <div class="chart-box">
          <h3>Vote Distribution</h3>
          <div class="pie-wrap">
            <canvas id="pieChart" height="200"></canvas>
          </div>
          <div class="chart-legend" id="pieLegend"></div>
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

  // Custom dropdown (mirrors the shared .pdd component used across the app).
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
      labelEl.textContent = cur ? cur.label : '— Select —';
      labelEl.classList.toggle('placeholder', !cur);
    }
    function close() { root.classList.remove('open'); menu.hidden = true; }
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (root.classList.contains('open')) { close(); return; }
      render(); menu.hidden = false; root.classList.add('open');
    });
    menu.addEventListener('click', (e) => {
      const o = e.target.closest('.pdd-option');
      if (!o) return;
      value = o.dataset.value; render(); close();
      if (onChange) onChange(value);
    });
    document.addEventListener('click', (e) => { if (!root.contains(e.target)) close(); });
    select.replaceWith(root);
    return { get: () => value, set: (v) => { value = v; render(); }, setOptions: (l) => { opts.length = 0; opts.push(...l); render(); }, root };
  }

  function bindStationFilter() {
    const sel = $('station-filter');
    if (sel) {
      buildSelectDropdown(sel, (value) => {
        currentStationId = value || null;
        loadReport();
      });
    }
    reportRoot.querySelectorAll('.station-table tbody tr[data-sid]').forEach((row) => {
      row.addEventListener('click', () => {
        currentStationId = row.dataset.sid || null;
        loadReport();
      });
    });
  }

  // ---------- Charts (manual canvas) ----------
  function drawCharts(r, pieSlice) {
    const cssVar = (name, fb) => {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fb;
    };
    const T = {
      text: cssVar('--text', '#f1f5f9'),
      muted: cssVar('--text-muted', '#94a3b8'),
      accent: cssVar('--accent', '#ef4444'),
      soft: cssVar('--surface-2', '#283549'),
      track: cssVar('--surface-3', '#31405a'),
    };
    const pie = $('pieChart');
    if (pie) {
      const ctx = pie.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      pie.width = pie.clientWidth * dpr; pie.height = 220 * dpr;
      ctx.scale(dpr, dpr); ctx.clearRect(0, 0, pie.width / dpr, 220);
      const w = pie.width / dpr, h = 220;
      const cx = w / 2, cy = h / 2, rad = Math.min(w, h) / 2 - 8;
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
      } else {
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.closePath();
        ctx.fillStyle = T.track; ctx.fill();
      }
      ctx.fillStyle = T.soft;
      ctx.beginPath();
      ctx.arc(cx, cy, rad * 0.58, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0)';
      ctx.fillStyle = T.text; ctx.font = '700 17px Poppins, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtNum(total), cx, cy - 8);
      ctx.fillStyle = T.muted; ctx.font = '600 10px Open Sans, sans-serif';
      ctx.fillText('Total votes', cx, cy + 12);
      // Legend (HTML)
      const lg = $('pieLegend');
      if (lg && total > 0) {
        lg.innerHTML = pieSlice.slice(0, 6).map((c, i) => `
          <div class="chart-legend-item">
            <span class="cl-swatch" style="background:${colors[i]}"></span>
            <span class="cl-name" title="${esc(c.name)}">${esc(c.name)}</span>
            <span class="cl-pct">${c.percentageOverall || c.percentage}%</span>
            <span class="cl-votes">${fmtNum(c.votes)}</span>
          </div>`).join('');
      } else if (lg) {
        lg.innerHTML = '<div class="chart-legend-empty">No votes recorded yet</div>';
      }
    }
    const bar = $('barChart');
    if (bar) {
      const ctx = bar.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const cw = bar.clientWidth, ch = bar.clientHeight;
      bar.width = cw * dpr; bar.height = ch * dpr;
      ctx.scale(dpr, dpr); ctx.clearRect(0, 0, cw, ch);
      const cats = r.categories.slice(0, 8);
      const max = Math.max(1, ...cats.map((c) => c.votes));
      const padL = 6, padR = 6, top = 24, bottom = 34;
      const plotW = cw - padL - padR, plotH = ch - top - bottom;
      const slot = plotW / (cats.length || 1);
      const barW = Math.max(6, Math.min(44, slot * 0.55));
      const baseY = ch - bottom;
      const colors = cats.map((_, i) => COLORS[i % COLORS.length]);
      ctx.textAlign = 'center';
      cats.forEach((c, i) => {
        const barH = Math.max(2, (c.votes / max) * plotH);
        const x = padL + i * slot + (slot - barW) / 2;
        ctx.fillStyle = colors[i];
        ctx.beginPath();
        const r = 3, bw = barW, bh = barH;
        ctx.moveTo(x, baseY - bh + r); ctx.arcTo(x, baseY - bh, x + bw, baseY - bh, r);
        ctx.arcTo(x + bw, baseY - bh, x + bw, baseY - bh + r, r);
        ctx.lineTo(x + bw, baseY); ctx.lineTo(x, baseY); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = T.track;
        ctx.fillRect(x, baseY - plotH, barW, plotH - bh);
        ctx.globalAlpha = 1;
        ctx.fillStyle = T.muted; ctx.font = '600 10px Open Sans, sans-serif';
        ctx.fillText(truncate(c.name, 10), x + barW / 2, baseY + 14);
        ctx.fillStyle = T.text; ctx.font = '700 12px Open Sans, sans-serif';
        ctx.fillText(fmtNum(c.votes), x + barW / 2, baseY - bh - 7);
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

  // ---------- Export: CSV / HTML / PDF ----------
  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv(r) {
    const lines = [];
    const e = r.election;
    const t = r.turnout || {};
    lines.push(`Election,${csvCell(e.title)}`);
    lines.push(`Type,${csvCell(e.type)}`);
    lines.push(`Status,${csvCell(r.status)}`);
    lines.push(`Total votes,${r.totalVotes}`);
    lines.push(`Registered voters,${csvCell(t.registered)}`);
    lines.push(`Voters cast,${csvCell(t.cast)}`);
    lines.push(`Turnout %,${csvCell(t.turnoutPct)}`);
    lines.push('');
    lines.push(['Category', 'Candidate', 'Votes', 'Category %', 'Overall %', 'Rank'].join(','));
    r.categories.forEach((cat) => {
      cat.candidates.forEach((c, i) => {
        lines.push([csvCell(cat.name), csvCell(c.name), c.votes, c.percentage, c.overallPct, i + 1].join(','));
      });
    });
    return lines.join('\n');
  }

  function safeBase(title) {
    return (title || 'results').replace(/[^\w\- ]+/g, '_').trim().replace(/\s+/g, '_');
  }

  function exportCsv() {
    if (!lastReport || !lastReport.ok) return;
    const base = safeBase(lastReport.election.title);
    window.pvh.exportFile(buildCsv(lastReport), `${base}_results`, 'csv').then((res) => {
      if (!res || !res.ok) handleExportError(res, 'CSV');
    });
  }

  function exportHtml() {
    if (!lastReport || !lastReport.ok) return;
    const base = safeBase(lastReport.election.title);
    window.pvh.exportFile(buildStandaloneHtml(), `${base}_report`, 'html').then((res) => {
      if (!res || !res.ok) handleExportError(res, 'HTML');
    });
  }

  function exportPdf() {
    if (!lastReport || !lastReport.ok) return;
    const base = safeBase(lastReport.election.title);
    window.pvh.exportPdf(buildStandaloneHtml(), `${base}_report`).then((res) => {
      if (!res || !res.ok) handleExportError(res, 'PDF');
    });
  }

  function handleExportError(res, label) {
    if (res && res.canceled) return;
    alert((res && res.error) || `${label} export failed.`);
  }

  function buildStandaloneHtml() {
    const title = lastReport.election.title;
    const reportBody = reportRoot.innerHTML;
    const css = buildReportCss();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(title)} — Results Report</title>
  <style>${css}</style>
</head>
<body class="print-body">
  <div class="report-render">${reportBody}</div>
</body>
</html>`;
  }

  function buildReportCss() {
    return /* css */ `:root{--surface:#ffffff;--surface-2:#f1f5f9;--border:#e2e8f0;--text:#0f172a;--text-muted:#64748b;--accent:#B30202;--accent-soft:#fee2e2;--radius-md:10px;--radius-lg:16px;}
body.print-body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#0f172a;background:#fff;margin:0;padding:32px;}
.report-render{max-width:900px;margin:0 auto;}
.report-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #B30202;padding-bottom:16px;margin-bottom:20px;}
.report-head h2{font-size:26px;margin:0;color:#0f172a;}
.text-muted{color:#64748b;}
.rep-status{font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;}
.rep-status.live{background:#dcfce7;color:#166534;}
.rep-status.ended{background:#fee2e2;color:#991b1b;}
.winner-card{display:flex;gap:16px;align-items:center;background:linear-gradient(135deg,#fff7ed,#fef3c7);border:1px solid #fcd34d;border-radius:16px;padding:20px;margin-bottom:20px;}
.wc-trophy{font-size:40px;}
.report-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin:20px 0;}
.report-stat{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;text-align:center;}
.rs-value{font-size:24px;font-weight:800;color:#B30202;}
.rs-label{font-size:12px;color:#64748b;margin-top:2px;}
.turnout-bar{position:relative;background:#e2e8f0;border-radius:999px;height:18px;overflow:hidden;margin:4px 0 20px;}
.turnout-fill{height:100%;background:linear-gradient(90deg,#dc2626,#B30202);}
.turnout-label{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;}
 .section-title{font-size:15px;font-weight:800;color:#0f172a;margin:0;}
 .winners-card{border:1px solid #e2e8f0;border-radius:10px;background:#fff;padding:18px;margin:8px 0 24px;}
 .winners-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;}
 .winners-count{font-size:11.5px;font-weight:700;color:#64748b;background:#f1f5f9;padding:3px 10px;border-radius:999px;white-space:nowrap;}
 .winners-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;}
 .cat-winner{position:relative;display:flex;flex-direction:column;gap:6px;min-height:118px;border:1px solid #e2e8f0;border-top:3px solid #B30202;border-radius:10px;padding:14px 16px;background:#f8fafc;}
 .cat-winner.tie{border-top-color:#2563eb;}
 .cat-winner.empty{border-top-color:#cbd5e1;opacity:.65;}
 .cw-top{display:flex;align-items:center;justify-content:space-between;gap:8px;}
 .cw-cat{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
 .cw-badge{flex-shrink:0;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;font-size:12px;font-weight:800;background:#B30202;color:#fff;}
 .cw-badge.tie{background:#2563eb;}
 .cw-name{font-size:16px;font-weight:800;color:#0f172a;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
 .cw-meta{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:auto;}
 .cw-votes{font-size:12px;color:#64748b;}
 .cw-pct{font-size:13.5px;font-weight:800;color:#B30202;}
 .cat-winner.tie .cw-pct,.cat-winner.tie .cw-votes{color:#2563eb;}
 .cw-bar{height:6px;border-radius:999px;background:#e2e8f0;overflow:hidden;}
 .cw-fill{height:100%;background:#B30202;border-radius:999px;}
 .cw-fill.tie{background:#2563eb;}
.station-breakdown{margin:24px 0;}
.station-filter{margin-bottom:10px;}
.label{font-weight:600;font-size:13px;}
.rank-table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px;}
.rank-table th,.rank-table td{border-bottom:1px solid #e2e8f0;padding:10px 10px;text-align:left;}
.rank-table thead th{color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:.05em;}
.rank-cat-head{background:#f8fafc;font-weight:700;}
.rank-number{display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;border-radius:50%;font-weight:700;font-size:12px;}
.rank-1{background:#B30202;color:#fff;}
.rank-2{background:#3b82f6;color:#fff;}
.rank-3{background:#10b981;color:#fff;}
.rank-other{background:#e2e8f0;color:#475569;}
.bar-track{flex:1;min-width:80px;height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;}
.bar-fill{height:100%;background:#B30202;}
.st-status{font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;background:#e2e8f0;color:#475569;}
.st-submitted{font-size:11px;font-weight:700;color:#166534;background:#dcfce7;padding:3px 8px;border-radius:999px;}
.st-pending{font-size:11px;font-weight:700;color:#92400e;background:#fef3c7;padding:3px 8px;border-radius:999px;}
.mini-bar{width:80px;height:6px;background:#e2e8f0;border-radius:999px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:6px;}
 .mini-fill{height:100%;background:#B30202;}
 .charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:8px 0 20px;}
 .chart-box{border:1px solid #e2e8f0;border-radius:10px;padding:16px;background:#f8fafc;}
 .chart-box h3{margin:0 0 12px;font-size:14px;color:#B30202;}
 .pie-wrap{display:flex;justify-content:center;margin:0 auto 12px;max-width:280px;}
 #pieChart{width:100%;max-width:280px;height:auto;display:block;}
 #barChart{width:100%;height:260px;display:block;}
 .chart-legend{display:flex;flex-direction:column;gap:8px;margin-top:4px;}
 .chart-legend-item{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;font-size:13px;color:#0f172a;}
 .cl-swatch{flex-shrink:0;width:11px;height:11px;border-radius:3px;}
 .cl-name{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;}
 .cl-pct{font-weight:800;color:#0f172a;}
 .cl-votes{color:#64748b;font-size:12px;min-width:44px;text-align:right;}
 .chart-legend-empty{padding:14px;text-align:center;color:#64748b;font-size:13px;}
 @media (max-width:680px){.charts-grid{grid-template-columns:1fr;}}
 @media print{body.print-body{padding:12px;}.charts-grid{display:none;}}` + '';
  }

  // ---------- Print ----------
  $('print-btn').addEventListener('click', () => window.print());
  $('export-csv-btn').addEventListener('click', exportCsv);
  $('export-html-btn').addEventListener('click', exportHtml);
  $('export-pdf-btn').addEventListener('click', exportPdf);

  // ---------- Init ----------
  const q = new URLSearchParams(window.location.search);
  const idFromUrl = q.get('id');
  loadElections();
  if (idFromUrl) {
    currentElectionId = idFromUrl;
    loadReport();
  }
})();
