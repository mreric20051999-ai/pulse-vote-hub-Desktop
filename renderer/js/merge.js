(function () {
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session || session.role !== 'admin') return;
  document.body.classList.add('is-admin');
  const C = window.MergeCore;
  if (!C) return;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (name, size = 20) =>
    (window.pvhIcons && window.pvhIcons.icon) ? window.pvhIcons.icon(name, size) : '';
  const normKey = C.normKey;
  const fmt = (n) => Number(n || 0).toLocaleString();

  const TYPE_LABEL = { school: 'School', station: 'Station' };

  const state = {
    files: [],          // all picked files
    valid: [],          // valid subset
    groups: [],         // detected election groups
    work: null,         // MergeCore workspace
    resolutions: {},    // vid -> fileIdx | '_exclude'
    report: null,       // MergeCore report
    locations: [],
  };

  const UI = {
    msg: $('merge-msg'),
    pick: $('pick-files-btn'),
    reset: $('merge-reset-btn'),
    filesWrap: $('merge-files-wrap'),
    groupWrap: $('merge-group-wrap'),
    work: $('merge-work'),
    actions: $('merge-actions'),
  };

  function setMsg(text, ok) {
    UI.msg.textContent = text || '';
    UI.msg.className = 'merge-msg' + (ok ? ' notice-ok' : text ? ' auth-error' : '');
  }

  // ---------- File picking ----------
  UI.pick.addEventListener('click', async () => {
    setMsg('');
    const res = await window.pvh.pickMergeFiles();
    if (!res) return setMsg('Could not open the file picker.', false);
    if (res.canceled) return;
    if (!res.ok) return setMsg(res.error || 'Could not read files.', false);
    state.files = res.files || [];
    state.valid = state.files.filter((f) => f.valid);
    renderFiles();
    if (!state.valid.length) return setMsg('None of the picked files are usable election snapshots.', false);
    detectGroups();
    UI.reset.style.display = '';
  });

  UI.reset.addEventListener('click', () => {
    state.files = []; state.valid = []; state.groups = []; state.work = null; state.resolutions = {}; state.report = null; state.locations = [];
    UI.filesWrap.style.display = 'none'; UI.filesWrap.innerHTML = '';
    UI.groupWrap.style.display = 'none'; UI.groupWrap.innerHTML = '';
    UI.work.style.display = 'none'; UI.work.innerHTML = '';
    UI.actions.style.display = 'none';
    UI.reset.style.display = 'none';
    setMsg('Cleared. Pick the location files again to start a fresh merge.');
  });

  function renderFiles() {
    const chips = state.files.map((f) => {
      const head = `
        <div class="file-chip-head"><b>${esc(f.base)}</b><span class="fstatus">${f.valid ? 'Ready' : 'Needs attention'}</span></div>`;
      if (!f.valid) {
        return `
        <div class="file-chip invalid">
          ${head}
          <div class="file-errors">${(f.errors || []).map((e) => esc(e)).join('<br>')}</div>
        </div>`;
      }
      const s = f.summary;
      return `
        <div class="file-chip valid">
          ${head}
          <div class="fmuted">${esc(s.title)} &middot; ${TYPE_LABEL[s.type] || esc(s.type || '—')}${s.status ? ' &middot; ' + esc(s.status) : ''}</div>
          <div class="file-counts">
            <div class="fstat"><span>Registered</span> <b>${fmt(s.registered)}</b></div>
            <div class="fstat"><span>Cast</span> <b>${fmt(s.cast)}</b></div>
            <div class="fstat"><span>Ballots</span> <b>${fmt(s.votes)}</b></div>
          </div>
          ${(f.warns || []).length ? `<div class="file-warns">${(f.warns).map((w) => '&bull; ' + esc(w)).join('<br>')}</div>` : ''}
        </div>`;
    }).join('');
    UI.filesWrap.innerHTML = `<div class="merge-files">${chips}</div>`;
    UI.filesWrap.style.display = '';
  }

  function typeLabel(t) { return TYPE_LABEL[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Election'); }

  function detectGroups() {
    const byKey = new Map();
    state.valid.forEach((f, i) => {
      const key = `${f.summary.type}|${normKey(f.summary.title)}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(i);
    });
    state.groups = [...byKey.entries()].map(([key, idx]) => {
      const first = state.valid[idx[0]].summary;
      return { key, ids: idx, title: first.title, type: first.type };
    });
    if (state.groups.length === 1) {
      startMerge(state.groups[0].ids);
    } else {
      renderGroupBar();
    }
  }

  function renderGroupBar() {
    const options = state.groups.map((g, i) => `
      <option value="${i}">${esc(g.title)} — ${typeLabel(g.type)} (${g.ids.length} file${g.ids.length === 1 ? '' : 's'})</option>`).join('');
    UI.groupWrap.innerHTML = `
      <div class="merge-group-bar">
        <div class="field">
          <label class="label" for="merge-group-select">These files describe different elections. Choose which one to merge:</label>
          <select class="select" id="merge-group-select">${options}</select>
        </div>
        <button class="btn btn-primary" id="merge-go-btn"><span class="icon btn-icon" data-icon="merge"></span>Build merge workspace</button>
      </div>`;
    UI.groupWrap.style.display = '';
    $('merge-go-btn').addEventListener('click', () => {
      const g = state.groups[Number($('merge-group-select').value)];
      if (g) startMerge(g.ids);
    });
  }

  // ---------- Build merge workspace ----------
  function startMerge(ids) {
    UI.groupWrap.style.display = 'none'; UI.groupWrap.innerHTML = '';
    const files = ids.map((i) => state.valid[i]);
    state.work = C.buildWork(files.map((f) => Object.assign({}, f.snapshot, {
      election: f.snapshot.election,
    })));
    state.work.files = files;
    state.resolutions = C.defaultResolutions(state.work);
    state.locations = [];
    renderWork();
    renderTally();
    UI.actions.style.display = '';
  }

  // ---------- Rendering ----------
  function renderWork() {
    const w = state.work;
    const dup = w.duplicates;
    let html = '';
    const dupCount = dup.length;
    html += `<div class="merge-section-title">Merge summary <span class="count-badge">${dupCount} duplicate voter${dupCount === 1 ? '' : 's'}</span></div>`;
    html += `<div id="merge-summary-box"></div>`;

    html += `<div class="merge-section-title">Duplicate detection</div>`;
    if (dup.length) {
      const rows = dup.map((d) => {
        const reg = d.regFiles.map((f) => esc(w.files[f].base)).join(', ') || '<i>from ballot only</i>';
        const voted = d.ballotFiles.map((f) => esc(w.files[f].base)).join(', ');
        const badges = (d.dbl ? '<span class="dup-badge double">Double ballot</span>' : '') +
          (d.regFiles.length > 1 ? '<span class="dup-badge reg">Multiple registrations</span>' : '');
        const options = [
          ...d.ballots.map(({ f }) => `<option value="${f}">Keep ballot from ${esc(w.files[f].base)}</option>`),
          '<option value="_exclude">Exclude voter (kept from tally &amp; registration)</option>',
        ].join('');
        const cur = state.resolutions[d.vid] === '_exclude' ? '_exclude'
          : (typeof state.resolutions[d.vid] === 'number' ? state.resolutions[d.vid]
            : (d.ballots[0] ? d.ballots[0].f : ''));
        return `
          <tr class="${d.dbl ? 'dup-double' : ''}">
            <td class="dup-vid">${esc(d.vid)}</td>
            <td class="dup-name">${esc(d.name || '—')}${d.station ? '<div class="fmuted" style="font-size:12px;">' + esc(d.station) + '</div>' : ''}</td>
            <td>
              ${badges}
              <div class="dup-files"><span class="dup-badge reg" style="margin-right:6px;">Registered in</span> ${reg}</div>
              ${d.ballotFiles.length ? `<div class="dup-files"><span class="dup-badge one" style="margin-right:6px;">Ballot in</span> ${voted}</div>` : '<div class="dup-files"><i>No ballot cast</i></div>'}
            </td>
            <td class="dup-resolve"><select class="select" data-vid="${esc(d.vid)}">${options}</select></td>
          </tr>`;
      }).join('');
      html += `<table class="dup-table">
        <thead><tr><th>Voter ID</th><th>Name</th><th>Detected in</th><th>Resolution</th></tr></thead>
        <tbody>${rows}</tbody></table>
        <p class="dup-hint">Default rule: the earliest-cast ballot is kept. Use the <strong>Resolution</strong> dropdown per voter to keep a specific location's ballot or exclude the voter entirely.</p>`;
    } else {
      html += `<div class="dup-empty">No duplicate voters detected — every voter appears in exactly one location file.</div>`;
    }

    html += `<div class="merge-section-title">Location contributions</div>`;
    html += `<div id="merge-loc-box"></div>`;

    html += `<div class="merge-section-title">Merged results</div>`;
    html += `<div id="merge-report-box"></div>`;

    UI.work.innerHTML = html;
    UI.work.style.display = '';

    UI.work.querySelectorAll('.dup-resolve select').forEach((sel) => {
      sel.addEventListener('change', () => {
        const v = sel.value;
        state.resolutions[sel.dataset.vid] = v === '_exclude' ? '_exclude' : (v === '' ? null : Number(v));
        renderTally();
      });
    });
  }

  function renderLocations() {
    const r = state.report || {};
    const w = state.work;
    const rows = state.locations.map((l) => `
      <tr>
        <td class="loc-name">${esc(l.name)}</td>
        <td>${esc(l.title)}</td>
        <td>${fmt(l.registered)}</td>
        <td>${fmt(l.cast)}</td>
        <td>${fmt(l.votes)}</td>
        <td>${fmt(l.kept)}</td>
      </tr>`).join('');
    const box = $('merge-loc-box');
    if (!box) return;
    box.innerHTML = `
      <table class="merge-loc-tbl">
        <thead><tr><th>File</th><th>Election</th><th>Registered</th><th>Cast</th><th>Ballots exported</th><th>Ballots counted after merge</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6"><i>No locations</i></td></tr>'}</tbody>
      </table>`;
  }

  function renderTally() {
    const r = C.buildReport(state.work, state.resolutions);
    state.report = r;

    state.locations = state.work.files.map((fl, f) => {
      const s = fl.summary;
      return { name: fl.base, title: s.title, registered: s.registered, cast: s.cast, votes: s.votes, kept: r.keptByFile.get(f) || 0, warns: fl.warns || [] };
    });

    const summary = $('merge-summary-box');
    if (summary) {
      summary.innerHTML = `
        <div class="merge-summary">
          <div class="report-stats">
            <div class="report-stat"><div class="rs-value">${fmt(r.filesCount)}</div><div class="rs-label">Location files</div></div>
            <div class="report-stat"><div class="rs-value">${fmt(r.registered)}</div><div class="rs-label">Registered</div></div>
            <div class="report-stat"><div class="rs-value">${fmt(r.cast)}</div><div class="rs-label">Voters cast</div></div>
            <div class="report-stat"><div class="rs-value">${fmt(r.totalVotes)}</div><div class="rs-label">Total votes</div></div>
            <div class="report-stat"><div class="rs-value">${r.turnoutPct}%</div><div class="rs-label">Turnout</div></div>
            <div class="report-stat"><div class="rs-value">${r.duplicatesCount}</div><div class="rs-label">Duplicate voters</div></div>
          </div>
          <div class="turnout-bar"><div class="turnout-fill" style="width:${Math.min(100, r.turnoutPct)}%"></div><span class="turnout-label">${r.turnoutPct}% turnout (${fmt(r.cast)} of ${fmt(r.registered)} registered voters)</span></div>
          ${r.doubleCount > 0 ? `<div class="merge-warn-banner"><b>${r.doubleCount} voter${r.doubleCount === 1 ? '' : 's'} cast ballots at more than one location.</b> The earliest-cast ballot is kept by default — review the resolution dropdowns above before exporting, then it becomes the official result.</div>` : ''}
        </div>`;
    }

    renderLocations();

    const box = $('merge-report-box');
    if (box) box.innerHTML = '<div class="merge-report-slot">' + reportHtml(r) + '</div>';
  }

  function reportHtml(r) {
    const e = r.election;
    let html = `
      <div class="report-head">
        <div>
          <h2>${esc(e.title)}</h2>
          <p class="text-muted" style="font-size:13px;margin-top:4px;">Merged from ${fmt(r.filesCount)} location file${r.filesCount === 1 ? '' : 's'} &middot; ${fmt(r.totalVotes)} votes cast</p>
        </div>
        <span class="rep-status ended">MERGED</span>
      </div>`;

    if (r.winner) {
      html += `
        <div class="winner-card">
          <div class="wc-trophy">${ic('trophy', 40)}</div>
          <div>
            <h2>${esc(r.winner.name)}</h2>
            <p>${fmt(r.winner.votes)} votes (${r.winner.percentage}%) &middot; ${esc(r.winner.catName)}</p>
          </div>
        </div>`;
    } else if (r.tie) {
      html += `
        <div class="winner-card">
          <div class="wc-trophy" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);">${ic('handshake', 40)}</div>
          <div>
            <h2>${esc(r.tie.name)}</h2>
            <p>Co-winners — tied at ${fmt(r.tie.votes)} votes each</p>
          </div>
        </div>`;
    }

    html += `
      <div class="report-stats">
        <div class="report-stat"><div class="rs-value">${fmt(r.stats.votes)}</div><div class="rs-label">Total Votes</div></div>
        <div class="report-stat"><div class="rs-value">${fmt(r.registered)}</div><div class="rs-label">Registered</div></div>
        <div class="report-stat"><div class="rs-value">${fmt(r.cast)}</div><div class="rs-label">Voters Cast</div></div>
        <div class="report-stat"><div class="rs-value">${r.turnoutPct}%</div><div class="rs-label">Turnout</div></div>
        <div class="report-stat"><div class="rs-value">${r.stats.candidates}</div><div class="rs-label">Candidates</div></div>
        <div class="report-stat"><div class="rs-value">${r.stats.categories}</div><div class="rs-label">Categories</div></div>
      </div>
      <div class="turnout-bar">
        <div class="turnout-fill" style="width:${Math.min(100, r.turnoutPct)}%"></div>
        <span class="turnout-label">${r.turnoutPct}% turnout (${fmt(r.cast)} of ${fmt(r.registered)} registered voters)</span>
      </div>`;

    const cwPct = (v) => Math.max(3, Math.min(100, v || 0));
    const winChips = (r.categoryWinners || []).map((cw) => {
      if (cw.mode === 'win') {
        return `
          <div class="cat-winner">
            <div class="cw-top"><span class="cw-cat">${esc(cw.name)}</span><span class="cw-badge" title="Winner">W</span></div>
            <div class="cw-name" title="${esc(cw.winner.name)}">${esc(cw.winner.name)}</div>
            <div class="cw-meta"><span class="cw-votes">${fmt(cw.winner.votes)} votes</span><span class="cw-pct">${cw.winner.percentage}%</span></div>
            <div class="cw-bar"><div class="cw-fill" style="width:${cwPct(cw.winner.percentage)}%"></div></div>
          </div>`;
      }
      if (cw.mode === 'tie') {
        return `
          <div class="cat-winner tie">
            <div class="cw-top"><span class="cw-cat">${esc(cw.name)}</span><span class="cw-badge tie" title="Tie">T</span></div>
            <div class="cw-name" title="${esc(cw.names.join(' & '))}">${esc(cw.names.join(' & '))}</div>
            <div class="cw-meta"><span class="cw-votes">Tied at ${fmt(cw.votes)} each</span></div>
            <div class="cw-bar"><div class="cw-fill tie" style="width:${cwPct(50)}%"></div></div>
          </div>`;
      }
      return `
        <div class="cat-winner empty">
          <div class="cw-top"><span class="cw-cat">${esc(cw.name)}</span></div>
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

    const catRows = r.categories.map((cat) => {
      const rows = cat.candidates.map((c, i) => {
        const rankCls = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-other';
        const barW = Math.max(2, Math.round((c.percentage / 100) * 100));
        return `
          <tr>
            <td><span class="rank-number ${rankCls}">${i + 1}</span></td>
            <td><strong>${esc(c.name)}</strong></td>
            <td><strong>${fmt(c.votes)}</strong></td>
            <td><strong>${c.percentage}%</strong></td>
            <td>
              <div class="rank-bar-row">
                <div class="bar-track"><div class="bar-fill" style="width:${barW}%"></div></div>
                <span class="text-dim rank-bar-pct">${c.percentage}%</span>
              </div>
            </td>
          </tr>`;
      }).join('');
      return `
        <table class="rank-table">
          <thead>
            <tr class="rank-cat-head"><td colspan="5">${esc(cat.name)} <span class="text-dim rank-cat-sub">(${cat.candidates.length} candidate${cat.candidates.length === 1 ? '' : 's'} &bull; ${fmt(cat.votes)} votes)</span></td></tr>
            <tr><th>Rank</th><th>Candidate</th><th>Votes</th><th>Percentage</th><th>Progress</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5"><i>No candidates in this category.</i></td></tr>'}</tbody>
        </table>`;
    }).join('');

    html += `<div class="ranking">${catRows}</div>`;
    return html;
  }

  // ---------- Exports ----------
  function safeBase(title) {
    return (title || 'merged-results').replace(/[^\w\- ]+/g, '_').trim().replace(/\s+/g, '_');
  }

  function handleExportError(res, label) {
    if (res && res.canceled) return;
    alert((res && res.error) || `${label} export failed.`);
  }

  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildMergedCsv(r) {
    const e = r.election;
    const lines = [];
    lines.push(`Election,${csvCell(e.title)}`);
    lines.push(`Type,${csvCell(TYPE_LABEL[e.type] || e.type)}`);
    lines.push('Status,Closed (merged)');
    lines.push(`Locations merged,${r.filesCount}`);
    lines.push(`Total votes,${r.totalVotes}`);
    lines.push(`Registered voters,${r.registered}`);
    lines.push(`Voters cast,${r.cast}`);
    lines.push(`Turnout %,${r.turnoutPct}`);
    lines.push(`Duplicate voters detected,${r.duplicatesCount}`);
    lines.push(`Double ballots detected,${r.doubleCount}`);
    lines.push('');
    lines.push(['Category', 'Candidate', 'Votes', 'Category %', 'Overall %', 'Rank'].join(','));
    r.categories.forEach((cat) => {
      cat.candidates.forEach((c, i) => {
        lines.push([csvCell(cat.name), csvCell(c.name), c.votes, c.percentage, c.overallPct, i + 1].join(','));
      });
    });
    return lines.join('\n');
  }

  function resolutionLabel(d) {
    const res = state.resolutions[d.vid];
    if (res === '_exclude') return 'Excluded';
    const w = state.work;
    const f = typeof res === 'number' ? res : d.ballotFiles[0];
    if (f === undefined) return 'Kept (no ballot cast)';
    return w && w.files[f] ? `Keep ${w.files[f].base}` : 'Kept (first ballot)';
  }

  function buildDuplicatesCsv(r) {
    const w = state.work;
    const lines = [];
    lines.push(`Merged election,${csvCell(r.election.title)}`);
    lines.push(`Generated,${csvCell(new Date().toLocaleString())}`);
    lines.push('');
    lines.push(['Voter ID', 'Name', 'Station', 'Double ballot', 'Registered in', 'Ballot in', 'Resolution'].join(','));
    for (const d of w.duplicates) {
      const reg = d.regFiles.map((f) => w.files[f].base).join('; ');
      const voted = d.ballotFiles.map((f) => w.files[f].base).join('; ');
      lines.push([csvCell(d.vid), csvCell(d.name || ''), csvCell(d.station || ''), d.dbl ? 'Yes' : 'No', csvCell(reg), csvCell(voted), csvCell(resolutionLabel(d))].join(','));
    }
    return lines.join('\n');
  }

  function printCss() {
    return /* css */ `:root{--surface:#ffffff;--surface-2:#f1f5f9;--border:#e2e8f0;--text:#0f172a;--text-muted:#64748b;--accent:#B30202;--radius-md:10px;--radius-lg:16px;}
body.print-body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#0f172a;background:#fff;margin:0;padding:32px;}
.report-render{max-width:900px;margin:0 auto;}
.report-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #B30202;padding-bottom:16px;margin-bottom:20px;}
.report-head h2{font-size:26px;margin:0;color:#0f172a;}
.text-muted{color:#64748b;}
.rep-status{font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;background:#fee2e2;color:#991b1b;}
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
.rank-bar-row{display:flex;align-items:center;gap:10px;}
.rank-bar-pct{font-size:12px;color:#64748b;}
.rank-cat-sub{font-weight:400;font-size:12px;color:#64748b;}
@media print{body.print-body{padding:12px;}}`;
  }

  function buildStandaloneHtml() {
    const r = state.report;
    const body = reportHtml(r);
    const head = `
      <div class="report-head" style="border-top:3px solid #B30202;background:#fff7ed;border-radius:6px;padding:14px 16px;">
        <div>
          <h2 style="margin:0;font-size:14px;color:#B30202;">Merged Multi-Location Results</h2>
          <p style="margin:4px 0 0;font-size:12px;color:#64748b;">${fmt(r.filesCount)} location file${r.filesCount === 1 ? '' : 's'} combined on ${new Date().toLocaleString()} &middot; ${r.duplicatesCount} duplicate voter${r.duplicatesCount === 1 ? '' : 's'} detected, ${r.doubleCount} double ballot${r.doubleCount === 1 ? '' : 's'} resolved</p>
        </div>
      </div>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(r.election.title)} — Merged Results</title>
  <style>${printCss()}</style>
</head>
<body class="print-body">
  <div class="report-render">
    ${head}
    ${body}
  </div>
</body>
</html>`;
  }

  $('merge-csv-btn').addEventListener('click', () => {
    if (!state.report) return;
    window.pvh.exportFile(buildMergedCsv(state.report), `${safeBase(state.report.election.title)}_merged`, 'csv')
      .then((res) => handleExportError(res, 'CSV'));
  });
  $('merge-html-btn').addEventListener('click', () => {
    if (!state.report) return;
    window.pvh.exportFile(buildStandaloneHtml(), `${safeBase(state.report.election.title)}_merged`, 'html')
      .then((res) => handleExportError(res, 'HTML'));
  });
  $('merge-pdf-btn').addEventListener('click', () => {
    if (!state.report) return;
    window.pvh.exportPdf(buildStandaloneHtml(), `${safeBase(state.report.election.title)}_merged`)
      .then((res) => handleExportError(res, 'PDF'));
  });
  $('merge-json-btn').addEventListener('click', () => {
    if (!state.report) return;
    window.pvh.exportJson(
      C.buildSnapshotExport(
        state.work,
        state.resolutions,
        state.work.files.map((f) => f.base),
        state.work.files.map((f) => ({ exported_at: f.snapshot && f.snapshot.exported_at, title: f.summary && f.summary.title, type: f.summary && f.summary.type }))
      ),
      `${safeBase(state.report.election.title)}_merged-snapshot`
    )
      .then((res) => handleExportError(res, 'JSON'));
  });
  $('merge-dup-csv-btn').addEventListener('click', () => {
    if (!state.report) return;
    window.pvh.exportFile(buildDuplicatesCsv(state.report), `${safeBase(state.report.election.title)}_duplicates`, 'csv')
      .then((res) => handleExportError(res, 'CSV'));
  });
})();