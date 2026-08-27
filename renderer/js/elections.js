(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const STATUS = { setup: ['pill-info', 'Setup'], voting: ['pill-success', 'Voting'], closed: ['pill', 'Closed'] };

  let currentElection = null;

  function statusPill(status) {
    const [cls, label] = STATUS[status] || ['pill', status];
    return `<span class="pill ${cls}">${label}</span>`;
  }

  function fmtDate(ts) {
    if (!ts) return 'No date set';
    const d = new Date(ts);
    const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${date} · ${time}`;
  }

  // ---- List view ----
  async function loadList() {
    const elections = await window.pvh.listElections();
    const list = $('elections-list');
    $('elections-empty').hidden = elections.length > 0;
    list.innerHTML = elections.map((e) => `
      <div class="card election-card" data-id="${e.id}">
        <div class="election-main">
          <div class="election-info">
            <h3>${esc(e.title)}</h3>
            <div class="election-date">
              <span class="icon" data-icon="calendar"></span>
              ${fmtDate(e.election_date)}
            </div>
            <div class="election-meta">${esc(e.type === 'school' ? 'School' : 'Station')} election &middot; ${e.position_count} categories &middot; ${e.candidate_count} candidates &middot; ${e.voter_count} voters</div>
          </div>
        </div>
        <div class="election-actions">
          ${statusPill(e.status)}
          <button class="btn btn-secondary btn-sm open" data-id="${e.id}">Configure</button>
          <button class="btn btn-danger btn-sm del" data-id="${e.id}">Delete</button>
        </div>
      </div>
    `).join('');
    if (window.pvhIcons) window.pvhIcons.inject('.election-card .icon');

    list.querySelectorAll('.open').forEach((b) =>
      b.addEventListener('click', (ev) => { ev.stopPropagation(); openBuilder(b.dataset.id); }));
    list.querySelectorAll('.del').forEach((b) =>
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm('Delete this election and all its data?')) return;
        await window.pvh.deleteElection(b.dataset.id);
        loadList();
      }));
    list.querySelectorAll('.election-card').forEach((card) =>
      card.addEventListener('click', () => openBuilder(card.dataset.id)));
  }

  // ---- Builder view ----
  function setDateFields(election) {
    const ts = election && election.election_date ? new Date(election.election_date) : null;
    $('edate').value = ts ? ts.toISOString().slice(0, 10) : '';
    $('etime').value = ts
      ? `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`
      : '';
  }

  function readDateValue() {
    const date = $('edate').value;
    const time = $('etime').value;
    if (!date) return null;
    const [y, m, d] = date.split('-').map(Number);
    const [hh = 0, mm = 0] = time ? time.split(':').map(Number) : [0, 0];
    return new Date(y, m - 1, d, hh, mm).getTime();
  }

  async function openBuilder(id) {
    const e = id ? await window.pvh.getElection(id) : null;
    currentElection = e || {
      id: null, title: '', type: 'school', status: 'setup',
      positions: [], candidates: [],
    };
    $('list-view').hidden = true;
    $('builder-view').hidden = false;
    $('builder-title').textContent = e ? e.title : 'New Election';
    $('builder-subtitle').textContent = e ? `Editing ${e.type} election` : 'Configure the ballot.';
    $('etitle').value = e ? e.title : '';
    $('etype').value = e ? e.type : 'school';
    $('estatus').value = e ? e.status : 'setup';
    setDateFields(e);
    $('builder-status').outerHTML = statusPill(e ? e.status : 'setup');
    renderPositions();
  }

  function renderPositions() {
    if (!currentElection) return;
    $('positions').innerHTML = '';

    // Reveal Step 3 (add candidates) once categories exist
    $('candidates-card').hidden = currentElection.positions.length === 0;

    if (!currentElection.positions.length) {
      $('positions').innerHTML = '<p class="text-muted hint">No categories yet. Add a category above.</p>';
    }

    // Populate the candidate position dropdown
    populateCandidatePositionSelect();

    currentElection.positions.forEach((p) => {
      const cands = currentElection.candidates.filter((c) => c.position_id === p.id);
      const block = document.createElement('div');
      block.className = 'position-block';
      block.innerHTML = `
        <div class="position-head">
          <div>
            <span class="position-title">${esc(p.title)}</span>
            <span class="position-max">max ${p.max_votes} vote${p.max_votes > 1 ? 's' : ''}</span>
            <span class="position-count">· ${cands.length} candidate${cands.length === 1 ? '' : 's'}</span>
          </div>
          <button class="btn btn-danger btn-sm rm-pos" data-id="${p.id}">Remove</button>
        </div>
        <div class="cand-list"></div>
      `;
      const candList = block.querySelector('.cand-list');
      candList.innerHTML = cands.length
        ? cands.map((c) => `
            <div class="candidate-row">
              <span>${esc(c.name)}</span>
              <button class="btn btn-danger btn-sm rm-cand" data-id="${c.id}" title="Remove candidate">Remove</button>
            </div>
          `).join('')
        : '<div class="candidate-row text-dim">No candidates yet.</div>';

      candList.querySelectorAll('.rm-cand').forEach((b) =>
        b.addEventListener('click', async () => {
          await window.pvh.removeCandidate(b.dataset.id);
          currentElection.candidates = await window.pvh.listCandidates(currentElection.id);
          renderPositions();
        }));
      block.querySelector('.rm-pos').addEventListener('click', async () => {
        await window.pvh.removePosition(p.id);
        await refreshBuilderData();
        renderPositions();
      });
      $('positions').appendChild(block);
    });
  }

  function populateCandidatePositionSelect() {
    const sel = $('candidate-position');
    const current = sel.value;
    // Only rebuild if the set of positions changed, so the user's selection
    // isn't wiped on every candidate add/remove.
    const ids = currentElection.positions.map((p) => p.id).join(',');
    if (sel.dataset.posIds !== ids || ids === '') {
      sel.innerHTML = '<option value="">— Select a position —</option>' +
        currentElection.positions.map((p) =>
          `<option value="${p.id}">${esc(p.title)}</option>`).join('');
      sel.dataset.posIds = ids;
      if (ids !== '' && currentElection.positions.some((p) => p.id === current)) {
        sel.value = current;
      }
    }
    sel.disabled = currentElection.positions.length === 0;
  }

  // ---- Actions ----
  $('new-election-btn').addEventListener('click', () => {
    currentElection = { id: null, title: '', type: 'school', status: 'setup', positions: [], candidates: [] };
    $('list-view').hidden = true;
    $('builder-view').hidden = false;
    $('builder-title').textContent = 'New Election';
    $('builder-subtitle').textContent = 'Configure the ballot.';
    $('etitle').value = '';
    $('etype').value = 'school';
    $('estatus').value = 'setup';
    setDateFields(null);
    $('builder-status').outerHTML = statusPill('setup');
    renderPositions();
  });

  $('builder-back').addEventListener('click', () => {
    $('list-view').hidden = false;
    $('builder-view').hidden = true;
    loadList();
  });

  // ---- Single candidate input (position auto-assigned from dropdown) ----
  $('add-candidate').addEventListener('click', () => submitCandidate());
  $('candidate-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitCandidate();
  });

  async function submitCandidate() {
    const name = $('candidate-name').value.trim();
    const positionId = $('candidate-position').value;
    if (!(await ensureElectionSaved())) return;
    if (!positionId) return alert('Select a category for this candidate.');
    if (!name) return alert('Enter the candidate name.');
    await window.pvh.addCandidate({ electionId: currentElection.id, positionId, name });
    $('candidate-name').value = '';
    currentElection.candidates = await window.pvh.listCandidates(currentElection.id);
    renderPositions();
  }

  $('add-position').addEventListener('click', async () => {
    const title = $('ptitle').value.trim();
    const maxVotes = Number($('pmax').value) || 1;
    if (!title) { alert('Enter a category name.'); return; }
    if (!(await ensureElectionSaved())) return;
    await window.pvh.addPosition(currentElection.id, title, maxVotes);
    $('ptitle').value = '';
    await refreshBuilderData();
    renderPositions();
  });

  // Creates the election from the form if it doesn't exist yet, so the user
  // can set title/type/status then immediately add categories & candidates.
  async function ensureElectionSaved() {
    if (currentElection.id) return true;
    const title = $('etitle').value.trim();
    const type = $('etype').value;
    const status = $('estatus').value;
    if (!title) { alert('Set an election title first.'); return false; }
    const res = await window.pvh.createElection({ title, type, election_date: readDateValue() });
    if (!res.ok) { alert(res.error || 'Failed to create election'); return false; }
    currentElection = res.election;
    await window.pvh.setElectionStatus(currentElection.id, status);
    await refreshBuilderData();
    renderPositions();
    return true;
  }

  $('save-election').addEventListener('click', async () => {
    const title = $('etitle').value.trim();
    const type = $('etype').value;
    const status = $('estatus').value;
    if (!title) return alert('Title is required');
    const election_date = readDateValue();
    if (currentElection.id) {
      await window.pvh.updateElection(currentElection.id, { title, type, election_date });
      await window.pvh.setElectionStatus(currentElection.id, status);
    } else {
      const res = await window.pvh.createElection({ title, type, election_date });
      if (!res.ok) return alert(res.error || 'Failed to create');
      currentElection = res.election;
      await window.pvh.setElectionStatus(currentElection.id, status);
    }
    await refreshBuilderData();
    $('builder-title').textContent = currentElection.title;
    $('builder-status').outerHTML = statusPill(currentElection.status);
  });

  async function refreshBuilderData() {
    currentElection.positions = await window.pvh.listPositions(currentElection.id);
    currentElection.candidates = await window.pvh.listCandidates(currentElection.id);
    $('builder-title').textContent = currentElection.title;
    $('builder-status').outerHTML = statusPill(currentElection.status);
  }

  loadList();
})();
