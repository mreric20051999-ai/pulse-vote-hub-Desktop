(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const content = $('kiosk-content');
  const titleEl = $('election-title');

  // Station ballots are opened for one physical station (?station= code/id/name).
  let ballotStation = (new URLSearchParams(window.location.search).get('station') || '').trim();

  // App state for the current voting session (reset per voter).
  let election = null;      // selected election obj
  let voter = null;         // verified voter public info
  let positions = [];       // ballot data
  let candidates = [];
  let selections = new Map(); // positionId -> { candidate, position } (max per position)

  // Category wizard state: which category is on screen and whether a step
  // transition is mid-flight.
  let wizIndex = 0;
  let inBallot = false;
  let animating = false;

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

    const voting = elections.filter((e) => e.status === 'active');
    const cards = (voting.length ? voting : elections).map((e) => `
      <div class="picker-card" data-id="${esc(e.id)}" role="button" tabindex="0">
        <div class="pk-icon" aria-hidden="true">🗳️</div>
        <div class="pk-body">
          <div class="pk-top">
            ${e.type ? `<span class="pk-type">${esc(e.type)}</span>` : ''}
            <span class="pk-status ${e.status === 'active' ? 'is-open' : 'is-closed'}">
              ${e.status === 'active' ? 'Open' : 'Not open'}
            </span>
          </div>
          <div class="pk-title">${esc(e.title)}</div>
          <div class="pk-meta">
            ${e.election_date ? `<span>${esc(fmtDate(e.election_date))}</span>` : ''}
            ${e.candidate_count != null ? `<span>${e.candidate_count} candidate${e.candidate_count === 1 ? '' : 's'}</span>` : ''}
          </div>
        </div>
        <div class="pk-arrow" aria-hidden="true">
          <span class="pk-go">${e.status === 'active' ? 'Cast vote' : 'View'}</span>
          <span class="pk-chev">→</span>
        </div>
      </div>`).join('');

    content.innerHTML = `
      <div class="picker-msg">
        <div class="pick-icon">🗳️</div>
        <h2>Select an election</h2>
        <p>Choose the election you were registered to vote in.</p>
      </div>
      <div class="picker-grid">${cards}</div>`;

    content.querySelectorAll('.picker-card').forEach((card) => {
      const open = async () => {
        const id = card.dataset.id;
        const e = elections.find((x) => x.id === id);
        if (!e) return;
        if (e.status !== 'active') return showBlocked('This election is not open for voting yet.', true);
        election = e;
        showAccess();
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
    });
  }

  // ------------------------------------------------------------
  // Screen 2: Voter access
  // ------------------------------------------------------------
  function showAccess() {
    inBallot = false;
    setTitle(election.title);
    setBackVisible(true);
    if (election.type === 'station' && !ballotStation) {
      const stations = (election.stations || []).filter((s) => s && s.code);
      const list = stations.length
        ? `<div class="station-pick">
            ${stations.map((st) => `
              <button type="button" class="btn btn-outline station-pick-btn" data-code="${esc(st.code)}">
                <span class="sp-name">${esc(st.name)}</span>
                <span class="sp-code">${esc(st.code)}</span>
              </button>`).join('')}
          </div>`
        : '';
      content.innerHTML = `
        <div class="kiosk-panel">
          <div class="icon auth-icon">📍</div>
          <h2>Station ballot</h2>
          <p class="subtitle">This election is run polling-station by polling-station. Pick your station to open its ballot, then sign in as a voter registered there.</p>
          ${list}
          <button class="btn btn-ghost btn-xl" style="margin-top:16px;" onclick="window.location.assign(window.location.pathname)">Back to elections</button>
        </div>`;
      if (list) {
        content.querySelectorAll('.station-pick-btn').forEach((b) => {
          b.addEventListener('click', () => {
            ballotStation = b.dataset.code;
            showAccess();
          });
        });
      }
      return;
    }
    content.innerHTML = `
      <div class="kiosk-panel">
        <div class="icon auth-icon">🔐</div>
        <h2>Voter sign in</h2>
        <p class="subtitle">Enter the voter ID and password you were issued for this election.</p>
        <div class="vk-field">
          <label for="vk-voter-id">Voter ID</label>
          <input class="input" id="vk-voter-id" type="text" placeholder="e.g. STUDENT2026" autocomplete="off" spellcheck="false">
        </div>
        <div class="vk-field">
          <label for="vk-password">Password</label>
          <input class="input" id="vk-password" type="password" placeholder="Your password" autocomplete="off">
        </div>
        <button class="btn btn-primary btn-xl" id="vk-submit"><span>Continue</span></button>
        <p class="kiosk-form-error" id="vk-error" style="display:none;color:var(--danger);margin-top:14px;"></p>
        <button class="link-btn" id="vk-forgot" type="button" style="margin-top:16px;">Forgot your password?</button>
        <p class="auth-secure"><span>🔒</span> Your vote is private and never linked to who you are.</p>
      </div>`;

    const idInput = $('vk-voter-id');
    const passInput = $('vk-password');
    const err = $('vk-error');

    async function submit() {
      const vid = idInput.value.trim();
      const pwd = passInput.value;
      if (!vid || !pwd) {
        if (window.pvhAudio) window.pvhAudio.playError();
        err.textContent = 'Please enter both your voter ID and password.';
        err.style.display = '';
        return;
      }
      const res = await window.pvh.verifyVoter(election.id, vid, pwd);
      if (!res.ok) {
        if (res.code === 'already-voted') { showBlocked('You have already voted in this election.', true); return; }
        if (window.pvhAudio) window.pvhAudio.playError();
        err.textContent = res.error || 'Sign in failed. Try again.';
        err.style.display = '';
        return;
      }
      voter = res.voter;
      if (election.type === 'station' && !voter.checked_in) {
        if (window.pvhAudio) window.pvhAudio.playError();
        showBlocked('This voter must be checked in before casting a ballot — please see the station officer.', false);
        return;
      }
      if (election.type === 'station' && ballotStation && voter.assigned_station) {
        const a = String(voter.assigned_station).trim().toLowerCase();
        const b = String(ballotStation).trim().toLowerCase();
        if (a !== b) {
          if (window.pvhAudio) window.pvhAudio.playError();
          showBlocked(`This voter is registered at "${voter.assigned_station}", but this ballot is for the station you selected. Please use the ballot for the voter's own station.`, false);
          return;
        }
      }
      await loadBallot();
    }

    $('vk-submit').addEventListener('click', submit);
    [idInput, passInput].forEach((i) => i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    }));
    $('vk-forgot').addEventListener('click', showVerify);
    idInput.focus();
  }

  // ------------------------------------------------------------
  // Screen 2b: Voter self-service password recovery
  // ------------------------------------------------------------
  function showVerify() {
    const scheme = election.voter_scheme || 'name-index';
    setTitle(election.title);
    setBackVisible(true);

    const fieldFor = (scheme === 'index-phone')
      ? `<div class="vk-field">
          <label for="vk-verify-phone">Phone number</label>
          <input class="input" id="vk-verify-phone" type="tel" placeholder="e.g. 0712345678" autocomplete="off" spellcheck="false">
        </div>`
      : `<div class="vk-field">
          <label for="vk-verify-name">Full name</label>
          <input class="input" id="vk-verify-name" type="text" placeholder="The name on the voter list" autocomplete="off" spellcheck="false">
        </div>`;

    content.innerHTML = `
      <div class="kiosk-panel">
        <div class="icon auth-icon">🔑</div>
        <h2>Retrieve your password</h2>
        <p class="subtitle">Enter your details below to receive the password issued for your voter ID.</p>
        <div class="vk-field">
          <label for="vk-verify-id">Voter ID</label>
          <input class="input" id="vk-verify-id" type="text" placeholder="e.g. STUDENT2026" autocomplete="off" spellcheck="false">
        </div>
        ${fieldFor}
        <button class="btn btn-primary btn-xl" id="vk-verify-submit"><span>Retrieve password</span></button>
        <p class="kiosk-form-error" id="vk-verify-error" style="display:none;color:var(--danger);margin-top:14px;"></p>
        <button class="link-btn" id="vk-verify-cancel" type="button" style="margin-top:16px;">← Back to sign in</button>
      </div>`;

    const idInput = $('vk-verify-id');
    const extra = scheme === 'index-phone' ? $('vk-verify-phone') : $('vk-verify-name');
    const err = $('vk-verify-error');

    async function submit() {
      err.style.display = 'none';
      const details = { voterId: idInput.value.trim() };
      if (scheme === 'index-phone') details.phone = extra.value.trim();
      else if (scheme !== 'index-only' && scheme !== 'range') details.name = extra.value.trim();
      const res = await window.pvh.verifyVoterDetails(election.id, details);
      if (!res.ok) {
        if (window.pvhAudio) window.pvhAudio.playError();
        err.textContent = res.error || 'Could not verify those details.';
        err.style.display = '';
        return;
      }
      renderRecovered(res);
    }

    $('vk-verify-submit').addEventListener('click', submit);
    [idInput, extra].forEach((i) => i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    }));
    $('vk-verify-cancel').addEventListener('click', showAccess);
    idInput.focus();
  }

  function renderRecovered(res) {
    const v = res.voter;
    const st = res.station;
    if (v.has_voted) { showBlocked('This voter has already cast a ballot in this election.', true); return; }
    setTitle(election.title);
    setBackVisible(true);
    content.innerHTML = `
      <div class="kiosk-panel">
        <div class="icon auth-icon">🔑</div>
        <h2>Voter found</h2>
        <p class="subtitle">Use the password below to sign in and cast your ballot.</p>
        <div class="vk-field">
          <label>Voter ID</label>
          <div class="vk-recovered-value">${esc(v.voter_id)}</div>
        </div>
        ${v.name ? `<div class="vk-field"><label>Name</label><div class="vk-recovered-value">${esc(v.name)}</div></div>` : ''}
        ${v.phone ? `<div class="vk-field"><label>Phone</label><div class="vk-recovered-value">${esc(v.phone)}</div></div>` : ''}
        ${st ? `<div class="vk-field"><label>Polling station</label>
          <div class="vk-recovered-value">${esc(st.name)}${st.location ? ` <span class="vk-station-loc">(${esc(st.location)})</span>` : ''}
            <span class="vk-station-status ${st.status}">${st.status === 'queuing' ? 'Grace window — polls closing' : 'Polls open'}</span>
          </div></div>` : ''}
        <div class="vk-field">
          <label>Password</label>
          <div class="vk-recovered-value vk-recovered-password">${esc(v.password || '—')}</div>
        </div>
        <button class="btn btn-primary btn-xl" id="vk-recovered-back"><span>Back to sign in</span></button>
      </div>`;
    $('vk-recovered-back').addEventListener('click', showAccess);
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

  function currentPosition() {
    return positions[wizIndex] || null;
  }

  function selectedFor(positionId) {
    return selections.get(positionId) || [];
  }

  // Wizard UI: progress bar, step label, in-category chip and the action bar.
  function updateWizard() {
    const p = currentPosition();
    if (!p) return;
    const max = Math.max(1, Number(p.max_votes) || 1);
    const selCount = selectedFor(p.id).length;
    const last = wizIndex === positions.length - 1;
    const multi = Number(p.max_votes) > 1;

    const bar = $('wiz-bar');
    if (bar) bar.style.width = (positions.length <= 1 ? 100 : Math.round((wizIndex / (positions.length - 1)) * 100)) + '%';
    const stepEl = $('wiz-step');
    if (stepEl) stepEl.innerHTML = `Category ${wizIndex + 1}<span class="wiz-of"> of </span>${positions.length}`;
    const selEl = $('wiz-sel');
    if (selEl) selEl.textContent = multi ? `${selCount}/${max} selected` : (selCount ? '1 selected' : 'Choose one');

    const chip = content.querySelector(`.ballot-cat[data-pos="${p.id}"] .ballot-cat-max`);
    if (chip) chip.textContent = multi ? `${selCount}/${max} selected` : (selCount ? 'Selected' : 'Vote for 1');

    const nav = $('wiz-nav');
    if (!nav) return;
    nav.innerHTML = `
      <button type="button" class="btn btn-ghost" id="wiz-back-btn" ${wizIndex === 0 ? 'disabled' : ''}>Back</button>
      <button type="button" class="btn btn-primary btn-lg btn-cast" id="wiz-next-btn">${last ? 'Review &amp; Cast' : 'Continue'}</button>`;
    $('wiz-back-btn').addEventListener('click', () => goToStep(-1));
    $('wiz-next-btn').addEventListener('click', () => {
      if (last) showConfirm();
      else goToStep(1);
    });

    updateCount();
  }

  // Render the current category's candidates into the step panel.
  function renderStep() {
    const p = currentPosition();
    const wrap = $('wiz-cat-wrap');
    if (!p || !wrap) return;
    const max = Math.max(1, Number(p.max_votes) || 1);

    const cards = candsFor(p.id).length
      ? candsFor(p.id).map((c) => {
          const isSel = selectedFor(p.id).some((s) => s.candidate.id === c.id);
          return `
            <div class="ballot-card${isSel ? ' selected' : ''}" data-pos="${esc(p.id)}" data-cand="${esc(c.id)}">
              <div class="ballot-media">
                ${avatarHtml(c)}
                <div class="ballot-bn">
                  <span class="ballot-bn-num">${esc(c.ballot_number != null ? c.ballot_number : 1)}</span>
                  <span class="ballot-bn-label">BALLOT</span>
                </div>
              </div>
              <div class="ballot-card-info">
                <div class="ballot-card-name">${esc(c.name)}</div>
                <div class="ballot-card-tagline">Candidate</div>
              </div>
              <div class="ballot-check"></div>
            </div>`;
        }).join('')
      : '<div class="ballot-cat-empty">No candidates have been nominated in this category yet.</div>';

    wrap.innerHTML = `
      <div class="ballot-cat wiz-cat" data-pos="${esc(p.id)}">
        <div class="ballot-cat-head">
          <span class="ballot-cat-title">${esc(p.title)}</span>
          <span class="ballot-cat-max"></span>
        </div>
        <div class="ballot-grid">${cards}</div>
      </div>`;

    wrap.querySelectorAll('.ballot-card').forEach((card) => {
      card.addEventListener('click', () => toggleSelection(card));
    });
    resolvePhotos(wrap, '.ballot-avatar');
    updateWizard();
  }

  // Mount the wizard shell once; only the category step is swapped per step.
  function mountWizard() {
    setTitle(election.title);
    setBackVisible(true);
    inBallot = true;
    wizIndex = 0;
    content.innerHTML = `
      <div class="ballot-scroll wiz-panel" id="ballot-wizard">
        <div class="ballot-head">
          <div class="ballot-mast">
            <span class="ballot-mast-line"></span>
            <span class="ballot-kicker">Official Ballot</span>
            <span class="ballot-mast-line"></span>
          </div>
          <h1>${esc(election.title)}</h1>
          <div class="ballot-meta">
            <span class="ballot-type">${esc(election.type === 'station' ? 'Station election' : 'School election')}</span>
            <span class="ballot-dot">•</span>
            <span class="ballot-secret">🔒 Your vote is private</span>
            <span class="ballot-dot">•</span>
            <span class="voter-chip">Voting as <strong>${esc(voter.name || voter.voter_id)}</strong></span>
          </div>
        </div>
        <div class="wiz-progress">
          <div class="wiz-track"><div class="wiz-progress-fill" id="wiz-bar"></div></div>
          <div class="wiz-meta">
            <span class="wiz-step" id="wiz-step"></span>
            <span class="wiz-sel" id="wiz-sel"></span>
          </div>
        </div>
        <div class="wiz-cat-wrap" id="wiz-cat-wrap"></div>
        <div class="ballot-actions" id="ballot-actions">
          <div class="cast-count" id="cast-count"></div>
          <div class="wiz-nav" id="wiz-nav"></div>
        </div>
      </div>`;
    renderStep();
  }

  // Direction-aware step change: out toward the direction of travel, in from
  // the opposite side. Selections are preserved between steps.
  function goToStep(dir) {
    if (animating) return;
    const next = wizIndex + dir;
    if (next < 0 || next >= positions.length) return;
    animating = true;
    const wrap = $('wiz-cat-wrap');
    if (wrap) wrap.classList.add(dir > 0 ? 'wiz-out-left' : 'wiz-out-right');
    setTimeout(() => {
      wizIndex = next;
      renderStep();
      const w = $('wiz-cat-wrap');
      if (w) {
        w.classList.remove('wiz-out-left', 'wiz-out-right');
        w.classList.add(dir > 0 ? 'wiz-in-right' : 'wiz-in-left');
      }
      setTimeout(() => {
        animating = false;
        const w2 = $('wiz-cat-wrap');
        if (w2) w2.classList.remove('wiz-in-right', 'wiz-in-left');
      }, 340);
    }, 170);
  }

  function renderBallot() {
    mountWizard();
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

    card.classList.toggle('selected', idx < 0);
    updateWizard();

    // The race is now full (1-of-1, or the last required vote per category) —
    // ease on to the next category shortly after the tap.
    if (idx < 0 && current.length >= max && currentPosition() && currentPosition().id === posId) {
      setTimeout(() => {
        if (!animating
            && currentPosition() && currentPosition().id === posId
            && selectedFor(posId).length
            && wizIndex < positions.length - 1) {
          goToStep(1);
        }
      }, 300);
    }
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
    if (window.pvhAudio) window.pvhAudio.playConfirm();
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
      const res = await window.pvh.castVote(election.id, voter.voter_id, selection, ballotStation || undefined);
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
  // Screen 4: Thank you + celebration
  // ------------------------------------------------------------
  function showThanks() {
    inBallot = false;
    setTitle(election.title);
    setBackVisible(true);
    content.innerHTML = `
      <div class="thankyou">
        <div class="check-circle"><i>✓</i></div>
        <h2>Thank you!</h2>
        <p>Your vote has been recorded securely.</p>
        <button class="btn btn-primary btn-lg" id="done-btn" style="margin-top:var(--space-8);">Next voter</button>
      </div>`;

    playSuccess();
    celebrate();

    let done = false;
    const nextSignIn = () => { if (done) return; done = true; $('done-btn').disabled = true; toSignIn(); };
    // auto-advance once the beep + confetti have played
    setTimeout(nextSignIn, 3200);
    $('done-btn').addEventListener('click', nextSignIn);
  }

  // Back to the voter sign-in for the next voter (same election stays selected).
  function toSignIn() {
    voter = null; positions = []; candidates = []; selections = new Map();
    showAccess();
  }

  // Short, pleasant two-tone chime via Web Audio (no asset file needed).
  function playSuccess() {
    if (window.pvhAudio) window.pvhAudio.playSuccess();
    else {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const now = ctx.currentTime;
        [660, 880].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          const t = now + i * 0.15;
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.5);
        });
        setTimeout(() => ctx.close().catch(() => {}), 1200);
      } catch (e) { /* audio unavailable */ }
    }
  }

  // Dependency-free canvas confetti celebration.
  function celebrate() {
    try {
      const canvas = document.createElement('canvas');
      canvas.className = 'confetti-canvas';
      content.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      const W = (canvas.width = canvas.offsetWidth || 900);
      const H = (canvas.height = canvas.offsetHeight || 600);
      const colors = ['#ef4444', '#f87171', '#fbbf24', '#34d399', '#38bdf8', '#a78bfa', '#ffffff'];
      const pieces = Array.from({ length: 160 }, () => ({
        x: Math.random() * W,
        y: -20 - Math.random() * H * 0.4,
        w: 6 + Math.random() * 7,
        h: 10 + Math.random() * 10,
        color: colors[(Math.random() * colors.length) | 0],
        vy: 2.2 + Math.random() * 3,
        vx: (Math.random() - 0.5) * 1.6,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.25,
      }));
      const started = performance.now();
      const DURATION = 2400;
      let raf;
      const frame = (t) => {
        const elapsed = t - started;
        const ease = Math.max(0, 1 - elapsed / DURATION);
        ctx.clearRect(0, 0, W, H);
        for (const p of pieces) {
          p.y += p.vy;
          p.x += p.vx + Math.sin((elapsed + p.rot * 50) / 260) * 0.5;
          p.rot += p.vr;
          const alpha = Math.min(1, ease * 2.2);
          if (alpha <= 0) continue;
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          ctx.restore();
        }
        if (elapsed < DURATION) raf = requestAnimationFrame(frame);
        else { cancelAnimationFrame(raf); canvas.remove(); }
      };
      raf = requestAnimationFrame(frame);
    } catch (e) { /* confetti unavailable */ }
  }

  // ------------------------------------------------------------
  // Blocked / info states
  // ------------------------------------------------------------
  function showBlocked(msg, withBack) {
    inBallot = false;
    if (window.pvhAudio) window.pvhAudio.playError();
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

  const backBtn = $('kiosk-back');

  // Back returns to the election picker (hidden while already there).
  function setBackVisible(visible) {
    if (backBtn) backBtn.style.display = visible ? '' : 'none';
  }

  // Back: inside the wizard it steps back through the categories (first step
  // returns to voter sign-in); at any other screen it returns to the picker.
  backBtn.addEventListener('click', () => {
    if (inBallot) {
      if (wizIndex > 0) { goToStep(-1); return; }
      inBallot = false;
      voter = null; positions = []; candidates = []; selections = new Map(); wizIndex = 0;
      showAccess();
      return;
    }
    election = null; voter = null; positions = []; candidates = []; selections = new Map(); wizIndex = 0;
    showPicker();
  });

  // Exit to Dashboard returns to the officer app — but on the LAN-served
  // kiosk there is no dashboard, so it restarts the ballot for the next voter.
  $('kiosk-dashboard').addEventListener('click', () => {
    if (window.pvhKiosk) window.pvhKiosk.exit();
    if (window.pvh && window.pvh.serverMode) window.location.assign(window.location.pathname + window.location.search);
    else window.location.assign('dashboard.html');
  });

  // Inline SVG-free check glyphs: replace ✓ with an icon if icons available.
  if (window.pvhIcons) window.pvhIcons.inject('.icon, .pick-icon');

  // Deep-link support: ?election=<id> skips the picker and opens that election
  // directly (used by the dashboard's active-election "Run voting" buttons).
  async function deepLink() {
    const deepId = new URLSearchParams(window.location.search).get('election');
    if (!deepId) return;
    let elections = [];
    try { elections = await window.pvh.listElections(); } catch (e) { elections = []; }
    const e = elections.find((x) => x.id === deepId);
    if (!e) return;
    if (e.status !== 'active') { showBlocked('This election is not open for voting yet.', true); return; }
    election = e;
    showAccess();
  }

  (async () => { await showPicker(); deepLink(); })();
})();
