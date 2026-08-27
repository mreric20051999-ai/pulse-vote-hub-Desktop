(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const PAGE = 50;
  let elections = [];
  let currentElectionId = null;
  let currentPage = 0;
  let total = 0;

  if (window.pvhIcons) window.pvhIcons.inject('.icon');

  async function loadElections() {
    elections = await window.pvh.listElections();
    const sel = $('election-select');
    sel.innerHTML = '<option value="">— Select an election —</option>' +
      elections.map((e) => `<option value="${e.id}">${esc(e.title)} (${esc(e.type)})</option>`).join('');
  }

  $('election-select').addEventListener('change', async (e) => {
    currentElectionId = e.target.value;
    currentPage = 0;
    $('tools').hidden = !currentElectionId;
    if (currentElectionId) {
      await refresh();
    } else {
      $('voter-rows').innerHTML = '<tr><td colspan="5" class="text-muted center">Select an election.</td></tr>';
      $('picker-summary').textContent = '';
    }
  });

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
    const res = await window.pvh.addVoter({
      electionId: currentElectionId,
      voterId: $('v-voter-id').value,
      name: $('v-name').value,
      assignedStation: $('v-station').value,
    });
    if (!res.ok) { alert(res.error || 'Could not add voter'); return; }
    $('v-voter-id').value = ''; $('v-name').value = ''; $('v-station').value = '';
    alert(`Added ${res.voter.voter_id} — password: ${res.voter.password}`);
    refresh();
  });

  $('import-btn').addEventListener('click', async () => {
    const csv = $('csv-input').value;
    const res = await window.pvh.importVoters(currentElectionId, csv);
    if (!res.ok) { alert(res.error || 'Import failed'); return; }
    $('csv-input').value = '';
    alert(`Imported ${res.added} voter(s), skipped ${res.skipped}`);
    refresh();
  });

  $('autogen-btn').addEventListener('click', async () => {
    const count = Number($('autogen-count').value) || 10;
    if (!confirm(`Auto-generate ${count} voters?`)) return;
    const res = await window.pvh.autoGenerateVoters(currentElectionId, count);
    alert(`Generated ${res.count} voters`);
    refresh();
  });

  $('clear-btn').addEventListener('click', async () => {
    if (!confirm('Remove ALL voters for this election? This cannot be undone.')) return;
    await window.pvh.clearVoters(currentElectionId);
    refresh();
  });

  // Simple client-side search filter over already-loaded rows
  $('voter-search').addEventListener('input', () => {
    const q = $('voter-search').value.toLowerCase();
    document.querySelectorAll('#voter-rows tr').forEach((tr) => {
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  loadElections();
})();
