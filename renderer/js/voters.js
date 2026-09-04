(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const PAGE = 50;
  let elections = [];
  let currentElectionId = null;
  let currentPage = 0;
  let total = 0;

  const STATUS = {
    draft: ['pill', 'Draft'],
    upcoming: ['pill-info', 'Upcoming'],
    active: ['pill-success', 'Active'],
    closed: ['pill', 'Closed'],
  };
  const statusPill = (status) => {
    const [cls, label] = STATUS[status] || ['pill', status];
    return `<span class="pill ${cls}">${label}</span>`;
  };
  // The voter roll can only be edited while the election is a Draft. Once it is
  // published (Upcoming/Active/Closed) additions are frozen server-side.
  const isDraftOnly = (e) => !e || (e.status || 'draft') === 'draft';

  if (window.pvhIcons) window.pvhIcons.inject('.icon');

  // ---- Reusable custom dropdown (opens downward, beneath the box) ----
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

  const electionDD = buildSelectDropdown($('election-select'), async (value) => {
    currentElectionId = value;
    currentPage = 0;
    $('tools').hidden = !currentElectionId;
    if (currentElectionId) {
      await Promise.all([refresh(), loadStations()]);
      updateElectionStatus();
    } else {
      $('voter-rows').innerHTML = '<tr><td colspan="5" class="text-muted center">Select an election.</td></tr>';
      $('picker-summary').textContent = '';
      $('picker-status').hidden = true;
      $('verify-link').value = '';
      vStationDD.setOptions([{ value: '', label: '— No station —' }]);
      autogenStationDD.setOptions([{ value: '', label: '— No station —' }]);
    }
  });

  // Auto-generate scheme selector (custom dropdown)
  const autogenSchemeDD = buildSelectDropdown($('autogen-scheme'), () => updateAutogenUI());
  // Station selectors (custom dropdowns), populated by loadStations()
  const vStationDD = buildSelectDropdown($('v-station'));
  const autogenStationDD = buildSelectDropdown($('autogen-station'));

  async function loadElections() {
    elections = await window.pvh.listElections();
    electionDD.setOptions(
      [{ value: '', label: '— Select an election —' }].concat(
        elections.map((e) => ({ value: e.id, label: `${e.title} (${e.type})` }))
      )
    );
  }

  async function loadStations() {
    let stations = [];
    try { stations = await window.pvh.listStations(currentElectionId) || []; } catch (e) { stations = []; }
    const opts = [{ value: '', label: '— No station —' }].concat(
      stations.map((s) => ({
        value: s.code || s.id,
        label: (s.name || s.code || s.id) + (s.code ? ' (' + s.code + ')' : ''),
      }))
    );
    vStationDD.setOptions(opts);
    autogenStationDD.setOptions(opts);
  }

  function updateElectionStatus() {
    const e = elections.find((x) => x.id === currentElectionId) || null;
    const statusEl = $('picker-status');
    if (!e) { statusEl.hidden = true; return; }

    const canEdit = isDraftOnly(e);
    let html = `<span class="election-status-label">Election status:</span> ${statusPill(e.status)}`;
    if (!canEdit) {
      html += `<span class="lock-note" style="margin:0;">
        <span class="icon" data-icon="lock"></span>
        This election is <strong>${(STATUS[e.status] || ['', e.status])[1]}</strong> — the voter roll is frozen. You can no longer add, import, or generate voters. Reset to <strong>Draft</strong> (Elections page) to change the roll.
      </span>`;
    }
    statusEl.innerHTML = html;
    statusEl.hidden = false;

    // Disable voter-add tools when the roll is frozen (server also enforces this).
    const editable = canEdit;
    ['add-voter-btn', 'import-btn', 'autogen-btn', 'clear-btn'].forEach((id) => {
      const b = $(id);
      if (b) b.disabled = !editable;
    });
    ['v-name', 'v-voter-id', 'csv-input', 'autogen-list', 'autogen-count', 'autogen-from', 'autogen-to'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !editable;
    });
    // Custom station dropdowns use the .disabled state (dashboard.css).
    [vStationDD, autogenStationDD].forEach((dd) => {
      dd.root.classList.toggle('disabled', !editable);
    });

    // Voter verification link (opens straight on the recovery screen).
    const linkVal = currentElectionId ? `vote.html?election=${encodeURIComponent(currentElectionId)}&recover=1` : '';
    $('verify-link').value = linkVal;
  }

  async function refresh() {
    const data = await window.pvh.listVoters(currentElectionId, { limit: PAGE, offset: currentPage * PAGE });
    total = data.total;
    $('picker-summary').textContent = `${total} voter${total === 1 ? '' : 's'}`;

    const rows = $('voter-rows');
    if (!data.voters.length) {
      rows.innerHTML = '<tr><td colspan="5" class="text-muted center">No voters yet.</td></tr>';
    } else {
      rows.innerHTML = data.voters.map((v) => {
        const status = v.has_voted
          ? '<span class="pill pill-success"><span class="status-dot success"></span>Voted</span>'
          : '<span class="pill pill-info"><span class="status-dot info"></span>Ready</span>';
        return `
          <tr>
            <td><strong>${esc(v.voter_id)}</strong></td>
            <td>${esc(v.name || '—')}</td>
            <td>${esc(v.assigned_station || '—')}</td>
            <td>${status}</td>
            <td>
              <div class="cell-actions">
                ${v.has_voted ? '<button class="btn btn-secondary btn-sm unvote" data-id="' + esc(v.voter_id) + '" title="Reset vote">Reset</button>' : ''}
                <button class="btn btn-danger btn-sm del" data-id="${esc(v.voter_id)}">Remove</button>
              </div>
            </td>
          </tr>`;
      }).join('');
    }

    rows.querySelectorAll('.del').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Remove voter ${b.dataset.id}?`)) return;
      await window.pvh.deleteVoter(currentElectionId, b.dataset.id);
      refresh();
    }));
    rows.querySelectorAll('.unvote').forEach((b) => b.addEventListener('click', async () => {
      await window.pvh.unvoteVoter(currentElectionId, b.dataset.id);
      refresh();
    }));

    renderPagination();
  }

  function renderPagination() {
    const pages = Math.ceil(total / PAGE) || 1;
    const el = $('pagination');
    if (pages <= 1) { el.innerHTML = ''; return; }
    let html = `<button class="btn btn-secondary btn-sm" id="pg-prev" ${currentPage === 0 ? 'disabled' : ''}>Prev</button>`;
    html += `<span class="text-muted pg-label">Page ${currentPage + 1} of ${pages}</span>`;
    html += `<button class="btn btn-secondary btn-sm" id="pg-next" ${currentPage >= pages - 1 ? 'disabled' : ''}>Next</button>`;
    el.innerHTML = html;
    el.querySelector('#pg-prev').addEventListener('click', () => { currentPage--; refresh(); });
    el.querySelector('#pg-next').addEventListener('click', () => { currentPage++; refresh(); });
  }

  // ---- Actions ----
  $('add-voter-btn').addEventListener('click', async () => {
    await window.pvhUI.busy($('add-voter-btn'), 'Adding…', async () => {
      const res = await window.pvh.addVoter({
        electionId: currentElectionId,
        voterId: $('v-voter-id').value,
        name: $('v-name').value,
        assignedStation: vStationDD.get(),
      });
      if (!res.ok) { window.pvhUI.toast(res.error || 'Could not add voter', 'error'); return; }
      $('v-voter-id').value = ''; $('v-name').value = ''; vStationDD.set('');
      window.pvhUI.toast(`Added ${res.voter.voter_id} — password: ${res.voter.password}`, 'success');
      refresh();
    });
  });

  $('import-btn').addEventListener('click', async () => {
    await window.pvhUI.busy($('import-btn'), 'Importing…', async () => {
      const csv = $('csv-input').value;
      const res = await window.pvh.importVoters(currentElectionId, csv);
      if (!res.ok) { window.pvhUI.toast(res.error || 'Import failed', 'error'); return; }
      $('csv-input').value = '';
      window.pvhUI.toast(`Imported ${res.added} voter(s), skipped ${res.skipped}`, 'success');
      refresh();
    });
  });

  // Auto-generate scheme label updates
  const schemeLabels = {
    'name-index': 'Paste names — one per line (or CSV: name,index)',
    'index-only': 'Paste index numbers — one per line (or CSV: index)',
    'index-phone': 'Paste rows — one per line: name,index,phone',
    'range': 'Generate sequential Voter IDs over a numeric range (V0001 → V00nn).',
  };
  function updateAutogenUI() {
    const scheme = autogenSchemeDD.get();
    const isRange = scheme === 'range';
    $('autogen-list-label').textContent = schemeLabels[scheme] || schemeLabels['name-index'];
    $('autogen-range').hidden = !isRange;
    $('autogen-count').style.display = isRange ? 'none' : '';
    $('autogen-list').style.display = isRange ? 'none' : '';
    $('autogen-list-label').style.display = isRange ? 'none' : '';
  }
  updateAutogenUI();

  // Auto-generate button
  $('autogen-btn').addEventListener('click', async () => {
    const scheme = autogenSchemeDD.get();
    if (!confirm(`Auto-generate voters with the selected scheme?`)) return;
    const btn = $('autogen-btn');
    btn.disabled = true;
    btn.textContent = 'Generating...';
    const opts = {
      count: Number($('autogen-count').value) || 10,
      scheme,
      list: $('autogen-list').value,
      from: Number($('autogen-from').value),
      to: Number($('autogen-to').value),
      assignedStation: autogenStationDD.get(),
    };
    const res = await window.pvh.autoGenerateVoters(currentElectionId, opts);
    btn.disabled = false;
    btn.textContent = 'Auto-generate';
    if (!res.ok) {
      window.pvhUI.toast(res.error || 'Generation failed', 'error');
      return;
    }
    const creds = res.created && res.created.length
      ? '\n\n' + res.created.slice(0, 10)
          .map((c) => `${c.voter_id}\t·\t${c.password}${c.name ? ` (${c.name})` : ''}`).join('\n')
        + (res.created.length > 10 ? `\n… and ${res.created.length - 10} more` : '')
      : '';
    alert(`Generated ${res.count} voter(s)${res.from != null ? ` (V-range ${res.from} → ${res.to})` : ''}${res.assignedStation ? ` — assigned to ${res.assignedStation}` : ''}. Passwords are required for ballot access:${creds}`);
    window.pvhUI.toast(`Generated ${res.count} voter(s).`, 'success');
    $('autogen-list').value = '';
    refresh();
  });

  // Export voter roll (CSV / PDF / HTML / Print)
  async function doExport(format) {
    if (!currentElectionId) return;
    try {
      const res = await window.pvh.exportVoters(currentElectionId, format);
      if (res.ok) {
        if (format === 'print') { window.pvhUI.toast('Sent to printer.', 'success'); }
        else { window.pvhUI.toast(`Exported to ${format.toUpperCase()}: ${res.path}`, 'success'); }
      } else if (res.error && res.error !== 'Export cancelled') {
        window.pvhUI.toast(`Export failed: ${res.error}`, 'error');
      }
    } catch (err) {
      window.pvhUI.toast(`Export failed: ${err.message}`, 'error');
    }
  }
  const exportBtnMap = { csv: 'export-csv', pdf: 'export-pdf', html: 'export-html', print: 'export-print' };
  const exportLabelMap = { csv: 'Exporting CSV…', pdf: 'Exporting PDF…', html: 'Exporting HTML…', print: 'Preparing…' };
  Object.keys(exportBtnMap).forEach((fmt) => {
    $(exportBtnMap[fmt]).addEventListener('click', async (e) => {
      await window.pvhUI.busy(e.currentTarget, exportLabelMap[fmt], () => doExport(fmt));
    });
  });

  $('export-creds').addEventListener('click', async (e) => {
    if (!currentElectionId) return;
    await window.pvhUI.busy(e.currentTarget, 'Exporting…', async () => {
      const res = await window.pvh.exportVoterCredentials(currentElectionId);
      if (res.ok) {
        window.pvhUI.toast(`Exported ${res.count} credential(s): ${res.path}`, 'success');
      } else if (res.error && res.error !== 'Export cancelled') {
        window.pvhUI.toast(`Export failed: ${res.error}`, 'error');
      }
    });
  });

  $('clear-btn').addEventListener('click', async () => {
    if (!confirm('Remove ALL voters for this election? This cannot be undone.')) return;
    await window.pvh.clearVoters(currentElectionId);
    window.pvhUI.toast('All voters removed.', 'success');
    refresh();
  });

  // Simple client-side search filter over already-loaded rows
  $('voter-search').addEventListener('input', () => {
    const q = $('voter-search').value.toLowerCase();
    document.querySelectorAll('#voter-rows tr').forEach((tr) => {
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  // Copy the voter verification link to the clipboard
  $('copy-verify-link').addEventListener('click', async () => {
    const linkVal = $('verify-link').value;
    if (!linkVal) { window.pvhUI.toast('Select an election first.', 'error'); return; }
    try {
      await navigator.clipboard.writeText(linkVal);
      window.pvhUI.toast('Verification link copied.', 'success');
    } catch (err) {
      window.pvhUI.toast(`Copy failed: ${err.message}`, 'error');
    }
  });

  // Keep the status pill fresh if a schedule transition happens while the page
// is open (upcoming -> active, active -> closed).
setInterval(async () => {
  if (!currentElectionId) return;
  try {
    const fresh = await window.pvh.listElections();
    if (fresh) {
      elections = fresh;
      updateElectionStatus();
    }
  } catch (e) { /* ignore */ }
}, 30000);

updateAutogenUI();
  loadElections();
})();
