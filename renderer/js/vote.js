(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const content = $('kiosk-content');
  const titleEl = $('election-title');

  // App state for the current voting session (reset per voter).
  let election = null;      // selected election obj
  let voter = null;         // verified voter public info
  let positions = [];       // ballot data
  let candidates = [];
  let selections = new Map(); // positionId -> { candidate, position } (max per position)

  function setTitle(t) { titleEl.textContent = t; }

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function avatarHtml(c) {
    const initial = (c.name || '?').charAt(0).toUpperCase();
    return `<span class="ballot-avatar" data-photo="${esc(c.photo_path || '')}">${esc(initial)}</span>`;
  }

  function resolvePhotos(scope, cls) {
    scope.querySelectorAll(cls + '[data-photo]').forEach((el) => {
      if (!el.dataset.photo) return;
      const img = document.createElement('img');
      img.className = el.className.split(' ')[0];
      img.alt = '';
      window.pvh.candidatePhotoUrl(el.dataset.photo).then((url) => { if (url) img.src = url; });
      el.replaceWith(img);
    });
  }

  // ------------------------------------------------------------
  // Screen 1: Election picker
  // ------------------------------------------------------------
  async function showPicker() {
    setTitle('Select an election');
    setBackVisible(false);
    let elections = [];
    try { elections = await window.pvh.listElections(); } catch (e) { elections = []; }

    if (!elections.length) {
      content.innerHTML = `
        <div class="picker-msg">
          <div class="pick-icon">🗳️</div>
          <h2>No elections yet</h2>
          <p>There are no elections set up on this device. Check back later.</p>
        </div>`;
      return;
    }

    const voting = elections.filter((e) => e.status === 'voting');
    const cards = (voting.length ? voting : elections).map((e) => `
      <div class="picker-card" data-id="${esc(e.id)}">
        <div class="pk-title">${esc(e.title)}</div>
        <div class="pk-meta">
          ${e.type ? `<span>${esc(e.type)}</span>` : ''}
          ${e.election_date ? `<span>${esc(fmtDate(e.election_date))}</span>` : ''}
          ${e.candidate_count != null ? `<span>${e.candidate_count} candidate${e.candidate_count === 1 ? '' : 's'}</span>` : ''}
        </div>
        <div class="pk-go">${e.status === 'voting' ? 'Cast your vote' : 'Not open yet'}</div>
      </div>`).join('');

    content.innerHTML = `
      <div class="picker-msg">
        <div class="pick-icon">🗳️</div>
        <h2>Select an election</h2>
        <p>Choose the election you were registered to vote in.</p>
      </div>
      <div class="picker-grid">${cards}</div>`;

    content.querySelectorAll('.picker-card').forEach((card) => {
      card.addEventListener('click', async () => {
        const id = card.dataset.id;
        const e = elections.find((x) => x.id === id);
        if (!e) return;
        if (e.status !== 'voting') return showBlocked('This election is not open for voting yet.', true);
        election = e;
        showAccess();
      });
    });
  }

  // ------------------------------------------------------------
  // Screen 2: Voter access
  // ------------------------------------------------------------
  function showAccess() {
    setTitle(election.title);
    setBackVisible(true);
    content.innerHTML = `
      <div class="kiosk-panel">
        <div class="icon">🔐</div>
        <h2>Voter sign in</h2>
        <p class="subtitle">Enter the voter ID and password you were issued for this election.</p>
        <input class="input" id="vk-voter-id" type="text" placeholder="Voter ID" autocomplete="off" spellcheck="false">
        <input class="input" id="vk-password" type="password" placeholder="Password">
        <button class="btn btn-primary btn-xl" id="vk-submit">Continue</button>
        <p class="kiosk-form-error" id="vk-error" style="display:none;color:var(--danger);margin-top:16px;"></p>
      </div>`;

    const idInput = $('vk-voter-id');
    const passInput = $('vk-password');
    const err = $('vk-error');

    async function submit() {
      const vid = idInput.value.trim();
      const pwd = passInput.value;
      if (!vid || !pwd) {
        err.textContent = 'Please enter both your voter ID and password.';
        err.style.display = '';
        return;
      }
      const res = await window.pvh.verifyVoter(election.id, vid, pwd);
      if (!res.ok) {
        if (res.code === 'already-voted') { showBlocked('You have already voted in this election.', true); return; }
        err.textContent = res.error || 'Sign in failed. Try again.';
        err.style.display = '';
        return;
      }
      voter = res.voter;
      await loadBallot();
    }

    $('vk-submit').addEventListener('click', submit);
    [idInput, passInput].forEach((i) => i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    }));
    idInput.focus();
  }

  // ------------------------------------------------------------
  // Load ballot data + render
  // ------------------------------------------------------------
  async function loadBallot() {
    try {
      positions = await window.pvh.listPositions(election.id);
      candidates = await window.pvh.listCandidates(election.id);
    } catch (e) {
      positions = []; candidates = [];
    }

    if (!positions.length) {
      showBlocked('This election has no categories set up yet.', true);
      return;
    }

    selections = new Map();
    renderBallot();
  }

  function candsFor(positionId) {
    return candidates.filter((c) => c.position_id === positionId);
  }

  function positionById(id) {
    return positions.find((p) => p.id === id) || null;
  }

  function selectedFor(positionId) {
    return selections.get(positionId) || [];
  }

  function renderBallot() {
    setTitle(election.title);
    setBackVisible(true);

    const sections = positions.map((p) => {
      const cands = candsFor(p.id);
      const max = Math.max(1, Number(p.max_votes) || 1);
      const cards = cands.length
        ? cands.map((c) => {
            const isSel = selectedFor(p.id).some((s) => s.candidate.id === c.id);
            return `
              <div class="ballot-card${isSel ? ' selected' : ''}" data-pos="${esc(p.id)}" data-cand="${esc(c.id)}">
                ${avatarHtml(c)}
                <div class="ballot-card-info">
                  <div class="ballot-bn">
                    <span class="ballot-bn-num">${esc(c.ballot_number != null ? c.ballot_number : 1)}</span>
                    <span class="ballot-bn-label">BALLOT</span>
                  </div>
                  <div class="ballot-card-name">${esc(c.name)}</div>
                  <div class="ballot-card-tagline">Candidate</div>
                </div>
                <div class="ballot-check"></div>
              </div>`;
          }).join('')
        : '<div class="ballot-cat-empty">No candidates in this category.</div>';

      const progress = selectedFor(p.id).length;
      return `
        <div class="ballot-cat" data-pos="${esc(p.id)}">
          <div class="ballot-cat-head">
            <span class="ballot-cat-title">${esc(p.title)}</span>
            <span class="ballot-cat-max">${progress}/${max} selected</span>
          </div>
          <div class="ballot-grid">${cards}</div>
        </div>`;
    }).join('');

    content.innerHTML = `
      <div class="ballot-scroll">
        <div class="ballot-head">
          <h1>${esc(election.title)}</h1>
          <div class="voter-chip">Voting as <strong>${esc(voter.name || voter.voter_id)}</strong></div>
        </div>
        ${sections}
      </div>
      <div class="cast-bar" id="cast-bar">
        <div class="cast-count" id="cast-count"></div>
        <button class="btn btn-primary btn-lg btn-cast" id="cast-btn">Review &amp; Cast</button>
      </div>`;

    // selection handlers
    content.querySelectorAll('.ballot-card').forEach((card) => {
      card.addEventListener('click', () => toggleSelection(card));
    });
    resolvePhotos(content, '.ballot-avatar');
    updateCount();
    $('cast-btn').addEventListener('click', () => showConfirm());
  }

  function toggleSelection(card) {
    const posId = card.dataset.pos;
    const candId = card.dataset.cand;
    const position = positionById(posId);
    if (!position) return;
    const max = Math.max(1, Number(position.max_votes) || 1);
    const cand = candidates.find((c) => c.id === candId);
    if (!cand) return;

    const current = Array.from(selectedFor(posId));
    const idx = current.findIndex((s) => s.candidate.id === candId);

    if (idx >= 0) {
      current.splice(idx, 1);
    } else {
      if (current.length >= max) return; // at cap; require deselect first
      current.push({ candidate: cand, position });
    }

    if (current.length) selections.set(posId, current);
    else selections.delete(posId);

    // update this card + its category chip
    card.classList.toggle('selected', idx < 0);
    const posEl = content.querySelector(`.ballot-cat[data-pos="${posId}"] .ballot-cat-max`);
    if (posEl) posEl.textContent = `${current.length}/${max} selected`;
    updateCount();
  }

  function updateCount() {
    const total = positions.reduce((n, p) => n + selectedFor(p.id).length, 0);
    const chosen = positions.filter((p) => selectedFor(p.id).length).length;
    const el = $('cast-count');
    if (el) el.innerHTML = `<strong>${total}</strong> selection${total === 1 ? '' : 's'} across ${chosen} of ${positions.length} categories`;
  }

  // ------------------------------------------------------------
  // Screen 3: Confirm modal
  // ------------------------------------------------------------
  function showConfirm() {
    setBackVisible(true);
    const total = positions.reduce((n, p) => n + selectedFor(p.id).length, 0);
    // Block empty ballots
    const groups = positions.filter((p) => selectedFor(p.id).length);
    const summary = groups.length
      ? groups.map((p) => {
          const items = selectedFor(p.id).map((s) => {
            const initial = (s.candidate.name || '?').charAt(0).toUpperCase();
            return `
              <div class="confirm-choice">
                <span class="mini-avatar" data-photo="${esc(s.candidate.photo_path || '')}">${esc(initial)}</span>
                <div>
                  <div class="cc-name">${esc(s.candidate.name)}</div>
                  <div class="cc-pos">${esc(p.title)}</div>
                </div>
                <span class="cc-num">#${esc(s.candidate.ballot_number != null ? s.candidate.ballot_number : 1)}</span>
              </div>`;
          }).join('');
          return `<div class="confirm-cat">${esc(p.title)}</div>${items}`;
        }).join('')
      : '<p class="confirm-cat" style="color:var(--text-muted)">You have not selected any candidates. You can still cast, but your ballot will be blank for every category.</p>';

    content.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="confirm-modal">
        <div class="confirm-box">
          <h2>Review your ballot</h2>
          <div class="confirm-summary">${summary}</div>
          <div class="confirm-box-note" style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:var(--space-4);">
            You have <strong style="color:var(--text)">${total}</strong> selection${total === 1 ? '' : 's'}. You cannot change your vote once it is cast.
          </div>
          <div class="actions">
            <button class="btn btn-ghost" id="cancel-btn">Edit</button>
            <button class="btn btn-primary" id="confirm-cast-btn">Confirm &amp; Cast</button>
          </div>
        </div>
      </div>`);

    resolvePhotos($('confirm-modal'), '.mini-avatar');
    $('cancel-btn').addEventListener('click', () => $('confirm-modal').remove());
    $('confirm-modal').addEventListener('click', (e) => { if (e.target === $('confirm-modal')) $('confirm-modal').remove(); });
    $('confirm-cast-btn').addEventListener('click', castVote);
  }

  async function castVote() {
    const btn = $('confirm-cast-btn');
    btn.disabled = true;
    btn.textContent = 'Casting…';
    const selection = [];
    for (const [posId, list] of selections) {
      for (const s of list) selection.push({ positionId: posId, candidateId: s.candidate.id });
    }
    try {
      const res = await window.pvh.castVote(election.id, voter.voter_id, selection);
      if (res.ok) {
        $('confirm-modal').remove();
        showThanks();
      } else {
        btn.disabled = false;
        btn.textContent = 'Confirm & Cast';
        $('confirm-modal').remove();
        if (res.code === 'already-voted') showBlocked('You have already voted in this election.', true);
        else showBlocked(res.error || 'Your vote could not be cast. Please try again.', true);
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Confirm & Cast';
      $('confirm-modal').remove();
      showBlocked('A device error prevented casting your vote. Please try again.', true);
    }
  }

  // ------------------------------------------------------------
  // Screen 4: Thank you
  // ------------------------------------------------------------
  function showThanks() {
    setTitle(election.title);
    setBackVisible(true);
    content.innerHTML = `
      <div class="thankyou">
        <div class="check-circle"><i>✓</i></div>
        <h2>Thank you!</h2>
        <p>Your vote has been recorded securely.</p>
        <button class="btn btn-primary btn-lg" id="done-btn" style="margin-top:var(--space-8);">Finish</button>
      </div>`;
    $('done-btn').addEventListener('click', nextVoter);
  }

  // ------------------------------------------------------------
  // Blocked / info states
  // ------------------------------------------------------------
  function showBlocked(msg, withBack) {
    setTitle('Pulse Vote Hub');
    setBackVisible(true);
    content.innerHTML = `
      <div class="blocked-box">
        <div class="icon"><i>⚠</i></div>
        <h2>${withBack ? 'Cannot continue' : 'Heads up'}</h2>
        <p>${esc(msg)}</p>
        <button class="btn btn-primary btn-lg" id="blocked-back">${withBack ? 'Back to elections' : 'OK'}</button>
      </div>`;
    $('blocked-back').addEventListener('click', () => { election = null; voter = null; showPicker(); });
  }

  function nextVoter() {
    election = null; voter = null; positions = []; candidates = []; selections = new Map();
    showPicker();
  }

  const backBtn = $('kiosk-back');

  // Back returns to the election picker (hidden while already there).
  function setBackVisible(visible) {
    if (backBtn) backBtn.style.display = visible ? '' : 'none';
  }

  backBtn.addEventListener('click', () => {
    election = null; voter = null; positions = []; candidates = []; selections = new Map();
    showPicker();
  });

  // Exit to Dashboard returns to the officer app.
  $('kiosk-dashboard').addEventListener('click', () => {
    window.location.assign('dashboard.html');
  });

  // Inline SVG-free check glyphs: replace ✓ with an icon if icons available.
  if (window.pvhIcons) window.pvhIcons.inject('.icon, .pick-icon');

  showPicker();
})();
