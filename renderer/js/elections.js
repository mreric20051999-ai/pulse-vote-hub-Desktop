(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  const STATUS = {
    draft: ['pill', 'Draft'],
    upcoming: ['pill-info', 'Upcoming'],
    active: ['pill-success', 'Active'],
    closed: ['pill', 'Closed'],
  };

  const isLocked = (status) => status === 'active' || status === 'closed';

  let currentElection = null;

  function statusPill(status) {
    const [cls, label] = STATUS[status] || ['pill', status];
    return `<span class="pill ${cls}">${label}</span>`;
  }

  // Update the builder's status pill in place (keeps its #builder-status id).
  function renderStatusPill(status) {
    const el = $('builder-status');
    if (!el) return;
    const [cls, label] = STATUS[status] || ['pill', status];
    el.className = `pill ${cls}`;
    el.textContent = label;
  }

  // Lock the ballot configuration when the election is voting or closed, but
  // keep the status control available so an admin can close/reopen it.
  function applyLock() {
    const locked = currentElection ? isLocked(currentElection.status) : false;
    const lockEl = (el, on) => { if (el) { el.disabled = on; el.classList.toggle('is-locked', on); } };
    lockEl($('etitle'), locked);
    lockEl($('start-date'), locked);
    lockEl($('start-time'), locked);
    lockEl($('end-date'), locked);
    lockEl($('end-time'), locked);
    lockEl($('close-grace'), locked);
    lockEl($('max-close-grace'), locked);
    etypeDD.setDisabled(locked);

    const addPosWrap = $('ptitle') ? $('ptitle').closest('.add-position-row') || null : null;
    if (addPosWrap) addPosWrap.classList.toggle('is-locked', locked);
    lockEl($('ptitle'), locked);
    lockEl($('pmax'), locked);
    lockEl($('add-position'), locked);

    const lockBanner = $('builder-lock-note');
    if (lockBanner) lockBanner.hidden = !locked;
  }

  function fmtDT(ts) {
    if (!ts) return 'Not set';
    const d = new Date(ts);
    const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${date} · ${time}`;
  }

  function fmtRange(e) {
    const s = e && e.start_date != null ? new Date(e.start_date) : null;
    const en = e && e.end_date != null ? new Date(e.end_date) : null;
    if (s && en) {
      const sameDay = s.toDateString() === en.toDateString();
      const sd = s.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      const ed = en.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      const st = s.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      const et = en.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      return sameDay ? `${sd} · ${st} – ${et}` : `${sd} ${st} – ${ed} ${et}`;
    }
    if (s) return fmtDT(s.getTime());
    return 'No schedule set';
  }

  // ---- List view ----
  async function loadList() {
    const elections = await window.pvh.listElections();
    const list = $('elections-list');
    $('elections-empty').hidden = elections.length > 0;
    list.innerHTML = elections.map((e) => `
      <div class="card election-card" data-id="${e.id}" data-status="${esc(e.status)}">
        <div class="election-main">
          <div class="election-info">
            <h3>${esc(e.title)}</h3>
            <div class="election-date">
              <span class="icon" data-icon="calendar"></span>
              ${fmtRange(e)}
            </div>
            <div class="election-meta">${esc(e.type === 'school' ? 'School' : 'Station')} election &middot; ${e.position_count} categories &middot; ${e.candidate_count} candidates &middot; ${e.voter_count} voters</div>
          </div>
        </div>
        <div class="election-actions">
          ${statusPill(e.status)}
          <button class="btn btn-secondary btn-sm open" data-id="${e.id}" ${isLocked(e.status) ? 'disabled' : ''} title="${isLocked(e.status) ? 'Editing is disabled while an election is active or closed' : ''}">Edit</button>
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
        if (!confirm('Delete this election? A recovery copy is kept so it can be restored from the Administration screen.')) return;
        const btn = b;
        btn.disabled = true;
        const res = await window.pvh.deleteElection(b.dataset.id);
        btn.disabled = false;
        if (!res || !res.ok) {
          window.pvhUI.toast((res && res.error) || 'Could not delete this election.', 'error');
          if (res && res.code === 'active') loadList();
          return;
        }
        window.pvhUI.toast('Election deleted.', 'success');
        loadList();
      }));
    list.querySelectorAll('.election-card').forEach((card) =>
      card.addEventListener('click', () => {
        // Clicking a card opens its builder, matching the Edit button. Locked
        // (active/closed) elections cannot be opened — the card click mirrors
        // the disabled Edit button so it doesn't silently open a read-only
        // editor for a live/closed ballot.
        if (isLocked(card.dataset.status)) return;
        openBuilder(card.dataset.id);
      }));
  }

  // ---- Builder view ----
  function setFieldValue(dateEl, timeEl, ts) {
    dateEl.value = ts ? ts.toISOString().slice(0, 10) : '';
    timeEl.value = ts
      ? `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`
      : '';
  }

  function setDateFields(election) {
    const start = election && election.start_date != null ? new Date(election.start_date) : null;
    const end = election && election.end_date != null ? new Date(election.end_date) : null;
    setFieldValue($('start-date'), $('start-time'), start);
    setFieldValue($('end-date'), $('end-time'), end);
  }

  function setStationFields(election) {
    const grace = $('close-grace');
    const maxGrace = $('max-close-grace');
    if (grace) grace.value = election && election.close_grace_minutes != null ? election.close_grace_minutes : 30;
    if (maxGrace) maxGrace.value = election && election.max_close_grace_minutes != null ? election.max_close_grace_minutes : 120;
  }

  // Read a single date+time pair; returns null if the date is blank.
  function readDateTime(dateEl, timeEl) {
    const date = dateEl.value;
    const time = timeEl.value;
    if (!date) return null;
    const [y, m, d] = date.split('-').map(Number);
    const [hh = 0, mm = 0] = time ? time.split(':').map(Number) : [0, 0];
    return new Date(y, m - 1, d, hh, mm).getTime();
  }

  function readSchedule() {
    return {
      start_date: readDateTime($('start-date'), $('start-time')),
      end_date: readDateTime($('end-date'), $('end-time')),
      station_mode: etypeDD.get() === 'station' ? 1 : 0,
      close_grace_minutes: $('close-grace') ? (Number($('close-grace').value) || 30) : 30,
      max_close_grace_minutes: $('max-close-grace') ? (Number($('max-close-grace').value) || 120) : 120,
    };
  }

  async function openBuilder(id) {
    const e = id ? await window.pvh.getElection(id) : null;
    currentElection = e || {
      id: null, title: '', type: 'school', status: 'draft',
      positions: [], candidates: [],
    };
    $('list-view').hidden = true;
    $('builder-view').hidden = false;
    $('builder-title').textContent = e ? e.title : 'New Election';
    $('builder-subtitle').textContent = e ? `Editing ${e.type} election` : 'Configure the ballot.';
    $('etitle').value = e ? e.title : '';
    etypeDD.set(e ? e.type : 'school');
    estatusDD.set(e ? e.status : 'draft');
    setDateFields(e);
    setStationFields(e);
    renderStatusPill(e ? e.status : 'draft');
    $('delete-election').hidden = !currentElection.id;
    if (currentElection.id) {
      await refreshBuilderData();
    } else {
      renderPositions();
    }
    applyLock();
  }

  function renderPositions() {
    if (!currentElection) return;
    $('positions').innerHTML = '';

    if (!currentElection.positions.length) {
      $('positions').innerHTML = '<p class="text-muted hint">No categories yet. Add a category above.</p>';
    }

    currentElection.positions.forEach((p) => {
      const cands = currentElection.candidates.filter((c) => c.position_id === p.id);
      const locked = isLocked(currentElection.status);
      const block = document.createElement('div');
      block.className = 'position-block' + (locked ? ' is-locked' : '');
      block.innerHTML = `
        <div class="position-head">
          <div>
            <span class="position-title">${esc(p.title)}</span>
            ${locked
              ? `<span class="position-max">max ${p.max_votes} vote${p.max_votes > 1 ? 's' : ''}</span>`
              : `<label class="pmax-edit" data-id="${p.id}" title="Change how many candidates a voter may select in this category">
                   max
                   <input class="pmax-input" type="number" min="1" value="${p.max_votes}">
                   <button type="button" class="btn btn-secondary btn-sm pmax-save">Save</button>
                 </label>`}
            <span class="position-count">· ${cands.length} candidate${cands.length === 1 ? '' : 's'}</span>
          </div>
          ${locked ? '' : `<button class="btn btn-danger btn-sm rm-pos" data-id="${p.id}">Remove Category</button>`}
        </div>
        <div class="cand-list"></div>
        ${locked ? '' : `
        <div class="cand-add">
          <button class="btn btn-secondary btn-sm cand-photo-btn" title="Add photo">
            <span class="icon" data-icon="camera"></span>
          </button>
          <img class="cand-photo-preview" data-id="preview" alt="" hidden>
          <input class="input cand-name" placeholder="Candidate name (ballot #${(cands.length + 1)} auto-assigned)">
          <button class="btn btn-secondary btn-sm cand-add-btn">Add</button>
        </div>
        `}
      `;
      let selectedPhoto = null;

      const candList = block.querySelector('.cand-list');
      const renderRows = () => {
        candList.innerHTML = cands.length
          ? cands.map((c) => `
              <div class="candidate-row">
                <span class="cand-name-line">
                  <span class="ballot-badge">${c.ballot_number}</span>
                  <span class="cand-photo-thumb">${c.photo_path ? `<img src="#" data-photo="${esc(c.photo_path)}" alt="">` : ''}</span>
                  ${esc(c.name)}
                </span>
                ${locked ? '' : `<button class="btn btn-danger btn-sm rm-cand" data-id="${c.id}" title="Remove candidate">Remove</button>`}
              </div>
            `).join('')
          : '<div class="candidate-row text-dim">No candidates in this category yet.</div>';
        // Resolve stored photo paths to usable file URLs.
        candList.querySelectorAll('img[data-photo]').forEach((img) => {
          window.pvh.candidatePhotoUrl(img.dataset.photo).then((url) => { if (url) img.src = url; });
        });
      };
      renderRows();

      // Photo picker button for the next candidate in this category.
      block.querySelector('.cand-photo-btn').addEventListener('click', async () => {
        const stored = await window.pvh.pickCandidatePhoto();
        if (!stored) return;
        selectedPhoto = stored;
        const prev = block.querySelector('.cand-photo-preview');
        prev.hidden = false;
        const url = await window.pvh.candidatePhotoUrl(stored);
        if (url) prev.src = url;
      });

      const addCandidate = async () => {
        if (!(await ensureElectionSaved())) return;
        const input = block.querySelector('.cand-name');
        const name = input.value.trim();
        if (!name) { alert('Enter a candidate name.'); return; }
        await window.pvhUI.busy(block.querySelector('.cand-add-btn'), 'Adding…', async () => {
          await window.pvh.addCandidate({ electionId: currentElection.id, positionId: p.id, name, photo_path: selectedPhoto });
        });
        input.value = '';
        selectedPhoto = null;
        const prev = block.querySelector('.cand-photo-preview');
        prev.hidden = true;
        prev.removeAttribute('src');
        currentElection.candidates = await window.pvh.listCandidates(currentElection.id);
        renderPositions();
        window.pvhUI.toast(`"${name}" added to ${p.title}.`, 'success');
      };

      candList.querySelectorAll('.rm-cand').forEach((b) =>
        b.addEventListener('click', async () => {
          await window.pvh.removeCandidate(b.dataset.id);
          currentElection.candidates = await window.pvh.listCandidates(currentElection.id);
          renderPositions();
          window.pvhUI.toast('Candidate removed.', 'success');
        }));
      block.querySelector('.rm-pos').addEventListener('click', async () => {
        if (!confirm(`Remove category "${p.title}" and its candidates?`)) return;
        await window.pvh.removePosition(p.id);
        await refreshBuilderData();
        renderPositions();
        window.pvhUI.toast('Category removed.', 'success');
      });

      // Inline "max votes per voter" editor for this category.
      const maxInput = block.querySelector('.pmax-input');
      const maxSaveBtn = block.querySelector('.pmax-save');
      if (maxInput && maxSaveBtn) {
        const saveMax = async () => {
          const v = Number(maxInput.value);
          if (!v || v < 1) { maxInput.classList.add('is-invalid'); return; }
          maxInput.classList.remove('is-invalid');
          if (v === p.max_votes) return;
          const res = await window.pvhUI.busy(maxSaveBtn, 'Saving…', async () => {
            return await window.pvh.updatePositionMax(p.id, v);
          });
          if (!res || res.ok === false) {
            window.pvhUI.toast((res && res.error) || 'Could not save. The election may be locked.', 'error');
            return;
          }
          p.max_votes = res.position.max_votes;
          currentElection.positions = await window.pvh.listPositions(currentElection.id);
          renderPositions();
          window.pvhUI.toast(`Max of ${res.position.max_votes} votes per voter saved for ${p.title}.`, 'success');
        };
        maxInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveMax(); });
        maxInput.addEventListener('input', () => maxInput.classList.remove('is-invalid'));
        maxSaveBtn.addEventListener('click', saveMax);
      }
      block.querySelector('.cand-add-btn').addEventListener('click', addCandidate);
      block.querySelector('.cand-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addCandidate();
      });
      $('positions').appendChild(block);
    });

    // Inject SVG icons into dynamically-rendered buttons (e.g. camera).
    if (window.pvhIcons) window.pvhIcons.inject('.position-block .icon');
  }

  // ---- Actions ----

  // ---- Generic dropdown for native <select>s (opens downward) ----
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
      const prev = value;
      value = o.dataset.value;
      render();
      close();
      if (onChange) onChange(value, prev);
    });
    document.addEventListener('click', (e) => {
      if (!root.contains(e.target)) close();
    });
    function close() {
      root.classList.remove('open');
      menu.hidden = true;
    }

    select.replaceWith(root);
    return {
      get: () => value,
      set: (v) => { value = v; render(); },
      setDisabled: (disable) => { trigger.disabled = !!disable; root.classList.toggle('disabled', !!disable); },
      root,
    };
  }

  function toggleStationFields() {
    const row = $('station-grace-row');
    if (row) row.hidden = etypeDD.get() !== 'station';
  }

  const etypeDD = buildSelectDropdown($('etype'), toggleStationFields);
  const estatusDD = buildSelectDropdown($('estatus'));
  toggleStationFields();

  // ---- Actions ----
  $('new-election-btn').addEventListener('click', () => {
    currentElection = { id: null, title: '', type: 'school', status: 'draft', positions: [], candidates: [] };
    $('list-view').hidden = true;
    $('builder-view').hidden = false;
    $('builder-title').textContent = 'New Election';
    $('builder-subtitle').textContent = 'Configure the ballot.';
    $('etitle').value = '';
    etypeDD.set('school');
    estatusDD.set('draft');
    setDateFields(null);
    setStationFields(null);
    renderStatusPill('draft');
    renderPositions();
    $('delete-election').hidden = true;
    applyLock();
  });

  $('builder-back').addEventListener('click', () => {
    $('list-view').hidden = false;
    $('builder-view').hidden = true;
    loadList();
  });

  // ---- Add category ----
  $('add-position').addEventListener('click', async () => {
    const title = $('ptitle').value.trim();
    const maxVotes = Number($('pmax').value) || 1;
    if (!title) { alert('Enter a category name.'); return; }
    if (!(await ensureElectionSaved())) return;
    await window.pvhUI.busy($('add-position'), 'Adding…', async () => {
      await window.pvh.addPosition(currentElection.id, title, maxVotes);
    });
    $('ptitle').value = '';
    await refreshBuilderData();
    renderPositions();
    const newInput = document.querySelector('.position-block:last-child .cand-name');
    if (newInput) newInput.focus();
    window.pvhUI.toast(`Category "${title}" added.`, 'success');
  });

  // Creates the election from the form if it doesn't exist yet, so the user
  // can set title/type/status then immediately add categories & candidates.
  async function ensureElectionSaved() {
    if (currentElection.id) return true;
    const title = $('etitle').value.trim();
    const type = etypeDD.get();
    const status = estatusDD.get();
    if (!title) { alert('Set an election title first.'); return false; }
    const schedule = readSchedule();
    if (schedule.start_date != null && schedule.end_date != null && schedule.end_date < schedule.start_date) {
      alert('End date/time must be after start date/time.'); return false;
    }
    const res = await window.pvh.createElection({ title, type, ...schedule });
    if (!res.ok) { alert(res.error || 'Failed to create election'); return false; }
    currentElection = res.election;
    await window.pvh.setElectionStatus(currentElection.id, status);
    await refreshBuilderData();
    renderPositions();
    window.pvhUI.toast('Election created.', 'success');
    return true;
  }

  $('save-election').addEventListener('click', async () => {
    const title = $('etitle').value.trim();
    const type = etypeDD.get();
    const status = estatusDD.get();
    if (!title) return alert('Title is required');
    const schedule = readSchedule();
    if (schedule.start_date != null && schedule.end_date != null && schedule.end_date < schedule.start_date) {
      return alert('End date/time must be after start date/time.');
    }
    await window.pvhUI.busy($('save-election'), 'Saving…', async () => {
      if (currentElection.id) {
        await window.pvh.updateElection(currentElection.id, { title, type, ...schedule });
        await window.pvh.setElectionStatus(currentElection.id, status);
      } else {
        const res = await window.pvh.createElection({ title, type, ...schedule });
        if (!res.ok) { window.pvhUI.toast(res.error || 'Failed to create', 'error'); return; }
        currentElection = res.election;
        await window.pvh.setElectionStatus(currentElection.id, status);
      }
      await refreshBuilderData();
      $('builder-title').textContent = currentElection.title;
      renderStatusPill(currentElection.status);
      window.pvhUI.toast('Election saved.', 'success');
    });
  });

  // Publish: compute status from the schedule (web-app model). A school
  // election with no voters is kept in Draft.
  $('publish-election').addEventListener('click', async () => {
    if (!currentElection || !currentElection.id) {
      const saved = await ensureElectionSaved();
      if (!saved) return;
    }
    const schedule = readSchedule();
    if (schedule.start_date == null || schedule.end_date == null) {
      return alert('Set both a Start and End date/time before publishing.');
    }
    if (schedule.end_date < schedule.start_date) return alert('End date/time must be after start date/time.');
    await window.pvhUI.busy($('publish-election'), 'Publishing…', async () => {
      await window.pvh.updateElection(currentElection.id, { ...schedule });
      const voterCount = (currentElection.voters != null) ? currentElection.voters : undefined;
      const res = await window.pvh.publishElection(currentElection.id, voterCount != null ? { schoolVoterCount: voterCount } : {});
      if (!res.ok) { window.pvhUI.toast(res.error || 'Failed to publish', 'error'); return; }
      currentElection = res.election;
      estatusDD.set(currentElection.status);
      await refreshBuilderData();
      const live = currentElection.status === 'active';
      window.pvhUI.toast(live ? 'Election published — voting is live.' : 'Election published.', 'success');
    });
  });

  // Re-apply the config lock whenever the status changes (e.g. admin closes or
  // reopens an election) so the editable state stays in sync.
  estatusDD.root.addEventListener('click', () => {
    currentElection.status = estatusDD.get();
    applyLock();
    renderStatusPill(currentElection.status);
  });

  // Poll the schedule every 30s so status pills auto-transition
  // (upcoming -> active -> closed) without needing a full reload.
  setInterval(async () => {
    const res = await window.pvh.applySchedule();
    if (res && res.changed && res.changed.length && currentElection && currentElection.id
        && res.changed.includes(currentElection.id)) {
      currentElection.status = (await window.pvh.getElection(currentElection.id)).status;
      estatusDD.set(currentElection.status);
      applyLock();
      renderStatusPill(currentElection.status);
    }
    if (res && res.changed && res.changed.length) await loadList();
  }, 30000);

  // Delete an election from the builder. Closed/draft/upcoming can be deleted;
  // an active (live) election is refused by the backend. Deletion keeps a
  // recovery copy available from the Administration screen.
  $('delete-election').addEventListener('click', async () => {
    if (!currentElection || !currentElection.id) return;
    if (!confirm(`Delete "${currentElection.title}"? A recovery copy is kept so it can be restored from the Administration screen. This will not delete a live election.`)) return;
    $('delete-election').disabled = true;
    const res = await window.pvh.deleteElection(currentElection.id);
    $('delete-election').disabled = false;
    if (!res.ok) { alert(res.error || 'Failed to delete election'); return; }
    $('list-view').hidden = false;
    $('builder-view').hidden = true;
    currentElection = null;
    loadList();
  });

  function openPreviewModal() {
    $('preview-modal').hidden = false;
  }
  function closePreviewModal() {
    $('preview-modal').hidden = true;
  }

  function previewBallot() {
    if (!currentElection) return alert('Nothing to preview yet.');
    const candidates = currentElection.candidates || [];
    const positions = currentElection.positions || [];

    const title = currentElection.title || $('etitle').value.trim() || 'Untitled Election';
    $('pb-title').textContent = title;

    const body = $('pb-body');
    if (!positions.length) {
      body.innerHTML = '<div class="ballot-empty">No categories yet. Add a category to preview the ballot.</div>';
      openPreviewModal();
      return;
    }
    body.classList.add('ballot-paper');

    const pad = (n) => String(n).padStart(2, '0');
    const sections = positions.map((p, i) => {
      const cands = candidates.filter((c) => c.position_id === p.id);
      const rows = cands.length
        ? cands.map((c, j) => `
            <div class="bp-cand">
              <span class="bp-num">${esc(c.ballot_number != null ? c.ballot_number : j + 1)}</span>
              <span class="bp-avatar" data-photo="${esc(c.photo_path || '')}">${esc((c.name || '?').charAt(0).toUpperCase())}</span>
              <span class="bp-cand-info">
                <span class="bp-cand-name">${esc(c.name)}</span>
                <span class="bp-cand-tag">${esc(c.tagline || 'Candidate')}</span>
              </span>
              <span class="bp-mark"></span>
            </div>`).join('')
        : '<div class="ballot-empty">No candidates in this category yet.</div>';
      return `
        <section class="bp-cat">
          <div class="bp-cat-head">
            <span class="bp-cat-index">${pad(i + 1)}</span>
            <span class="bp-cat-title">${esc(p.title)}</span>
            <span class="bp-cat-max">Vote for up to ${esc(p.max_votes || 1)}</span>
          </div>
          <div class="bp-cands">${rows}</div>
        </section>`;
    }).join('');

    body.innerHTML = `
      <div class="bp-mast">
        <div class="bp-mast-flag">Pulse Vote Hub &middot; Official Ballot</div>
        <div class="bp-mast-title">${esc(title)}</div>
      </div>
      <div class="bp-sheet">
        <div class="bp-instructions">Mark your choice in the box beside the candidate of your choice.</div>
        ${sections}
      </div>`;

    // Resolve stored photo paths to usable file URLs.
    body.querySelectorAll('.bp-avatar[data-photo]').forEach((el) => {
      if (!el.dataset.photo) return;
      const img = document.createElement('img');
      img.className = 'bp-avatar';
      img.alt = '';
      window.pvh.candidatePhotoUrl(el.dataset.photo).then((url) => { if (url) img.src = url; });
      el.replaceWith(img);
    });

    openPreviewModal();
  }

  $('preview-ballot').addEventListener('click', previewBallot);
  $('pb-close').addEventListener('click', closePreviewModal);
  $('preview-modal').addEventListener('click', (e) => { if (e.target === $('preview-modal')) closePreviewModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePreviewModal(); });

  async function refreshBuilderData() {
    currentElection.positions = await window.pvh.listPositions(currentElection.id);
    currentElection.candidates = await window.pvh.listCandidates(currentElection.id);
    $('builder-title').textContent = currentElection.title;
    renderStatusPill(currentElection.status);
    renderPositions();
    applyLock();
  }

  loadList();

  // Deep-link support: ?election=<id> opens that election's builder directly
  // (used by the dashboard's active-election "Configure" buttons).
  const deepId = new URLSearchParams(window.location.search).get('election');
  if (deepId) openBuilder(deepId);
})();
