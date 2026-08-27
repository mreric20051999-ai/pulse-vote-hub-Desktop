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
            <div class="election-meta">${esc(e.type)} &middot; ${e.position_count} positions &middot; ${e.candidate_count} candidates &middot; ${e.voter_count} voters</div>
          </div>
        </div>
        <div class="election-actions">
          ${statusPill(e.status)}
          <button class="btn btn-secondary btn-sm open" data-id="${e.id}">Configure</button>
          <button class="btn btn-danger btn-sm del" data-id="${e.id}">Delete</button>
        </div>
      </div>
    `).join('');

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
    $('builder-status').outerHTML = statusPill(e ? e.status : 'setup');
    renderPositions();
  }

  function renderPositions() {
    if (!currentElection) return;
    $('positions').innerHTML = '';
    currentElection.positions.forEach((p) => {
      const block = document.createElement('div');
      block.className = 'position-block';
      const cands = currentElection.candidates.filter((c) => c.position_id === p.id);
      block.innerHTML = `
        <div class="position-head">
          <div>
            <span class="position-title">${esc(p.title)}</span>
            <span class="position-max">max ${p.max_votes} vote${p.max_votes > 1 ? 's' : ''}</span>
          </div>
          <button class="btn btn-danger btn-sm rm-pos" data-id="${p.id}">Remove</button>
        </div>
        <div class="cand-list"></div>
        <div class="candidate-add">
          <input class="input" data-add-name="${p.id}" placeholder="Candidate name">
          <button class="btn btn-primary add-cand" data-id="${p.id}">Add</button>
        </div>
      `;
      const candList = block.querySelector('.cand-list');
      candList.innerHTML = cands.map((c) => `
        <div class="candidate-row">
          <span>${esc(c.name)}</span>
          <button class="btn btn-danger btn-sm rm-cand" data-id="${c.id}">Remove</button>
        </div>
      `).join('');
      candList.querySelectorAll('.rm-cand').forEach((b) =>
        b.addEventListener('click', async () => {
          await window.pvh.removeCandidate(b.dataset.id);
          currentElection.candidates = await window.pvh.listCandidates(currentElection.id);
          renderPositions();
        }));
      block.querySelector('.add-cand').addEventListener('click', async () => {
        const inp = block.querySelector(`[data-add-name="${p.id}"]`);
        const name = inp.value.trim();
        if (!name) return;
        await window.pvh.addCandidate({ electionId: currentElection.id, positionId: p.id, name });
        inp.value = '';
        currentElection.candidates = await window.pvh.listCandidates(currentElection.id);
        renderPositions();
      });
      block.querySelector('.rm-pos').addEventListener('click', async () => {
        await window.pvh.removePosition(p.id);
        await refreshBuilderData();
        renderPositions();
      });
      $('positions').appendChild(block);
    });
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
    $('builder-status').outerHTML = statusPill('setup');
    renderPositions();
  });

  $('builder-back').addEventListener('click', () => {
    $('list-view').hidden = false;
    $('builder-view').hidden = true;
    loadList();
  });

  $('add-position').addEventListener('click', async () => {
    const title = $('ptitle').value.trim();
    const maxVotes = Number($('pmax').value) || 1;
    if (!title) return;
    if (!currentElection.id) return alert('Save the election first.');
    await window.pvh.addPosition(currentElection.id, title, maxVotes);
    $('ptitle').value = '';
    await refreshBuilderData();
    renderPositions();
  });

  $('save-election').addEventListener('click', async () => {
    const title = $('etitle').value.trim();
    const type = $('etype').value;
    const status = $('estatus').value;
    if (!title) return alert('Title is required');
    if (currentElection.id) {
      await window.pvh.updateElection(currentElection.id, { title, type });
      await window.pvh.setElectionStatus(currentElection.id, status);
    } else {
      const res = await window.pvh.createElection({ title, type });
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
