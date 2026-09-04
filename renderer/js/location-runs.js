(function () {
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isAdmin = session && (session.role === 'admin' || session.role === 'developer');
  const isLocCoord = session && session.role === 'location_coordinator';
  // The main coordinator owns/oversees the whole election: they author run
  // packs, import the sealed result packs back, and compile the aggregate.
  // Admin/developer/coordinator all qualify; ownership is enforced backend-side.
  const isMainCoordinator = isAdmin || (session && session.role === 'coordinator');
  const pvh = window.pvh;
  const ui = window.pvhUI;

  let elections = [];
  let selectedElection = null;
  let selectedLocations = [];
  let incomingPacks = [];
  let compiledResult = null;

  // ---------- helpers ----------

  function timeFmt(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch (e) { return '—'; }
  }
  function statusPill(s) {
    const map = { draft: ['Draft', 'info'], open: ['Open', 'success'], closed: ['Closed', 'muted'], submitted: ['Sealed', 'success'] };
    const [label, tone] = map[s] || [s || 'Unknown', 'muted'];
    return `<span class="pill pill-${tone}">${esc(label)}</span>`;
  }

  function setMsg(el, text, tone) {
    el.classList.remove('ok', 'error');
    if (tone) el.classList.add(tone);
    el.textContent = text || '';
  }

  // ---------- election loading ----------

  async function loadElections() {
    const res = await pvh.listElections();
    elections = (res && res.ok && res.elections) || res && res.elections || (Array.isArray(res) ? res : []);
    renderElectionSelect();
  }

  // Shared custom dropdown (opens downward, matches the rest of the app).
  let electionDD = null;
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
      labelEl.textContent = cur ? cur.label : '— Select an election —';
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
      root,
    };
  }

  function renderElectionSelect() {
    const wrap = $('election-select-wrap');
    const hint = $('election-hint');
    if (!elections.length) {
      hint.textContent = isLocCoord
        ? 'You have no imported election yet. Import a run pack below to begin.'
        : 'Create an election first, then hand each location a run pack.';
      wrap.innerHTML = '';
      electionDD = null;
      return;
    }
    hint.textContent = 'Select the election you want to run across locations.';
    const sel = document.createElement('select');
    sel.className = 'input';
    sel.style.display = 'none';
    sel.innerHTML = '<option value="">— Select an election —</option>' + elections.map((e) =>
      `<option value="${esc(e.id)}">${esc(e.title)}</option>`).join('');
    wrap.innerHTML = '';
    wrap.appendChild(sel);
    electionDD = buildSelectDropdown(sel, (value) => selectElection(value));
    if (elections.length === 1) {
      electionDD.set(elections[0].id);
      selectElection(elections[0].id);
    }
  }

  async function selectElection(id) {
    const e = elections.find((x) => x.id === id) || null;
    selectedElection = e;
    selectedLocations = [];
    incomingPacks = [];
    compiledResult = null;
    const detail = $('election-detail');
    const actions = $('actions-panel');
    const compile = $('compile-panel');
    const packs = $('packs-panel');
    if (!e) { detail.innerHTML = ''; actions.hidden = true; compile.hidden = true; packs.hidden = true; return; }
    detail.innerHTML = `
      <div class="election-summary">
        <div><strong>${esc(e.title)}</strong> ${statusPill(e.status)}</div>
        <div class="text-muted">Type: ${esc(e.type || 'station')} &middot; ${e.voter_count != null ? e.voter_count + ' registered voters' : ''}</div>
      </div>`;
    // Role-specific actions
    if (isMainCoordinator) {
      await loadLocations(e.id);
      actions.hidden = true;
      compile.hidden = incomingPacks.length ? false : true;
      packs.hidden = false;
    } else {
      renderLocCoordActions(e);
      actions.hidden = false;
      compile.hidden = true;
      packs.hidden = true;
    }
    $('page-actions').innerHTML = isMainCoordinator
      ? `<button class="btn btn-primary" id="btn-new-runpack"><span class="icon btn-icon" data-icon="plus"></span>Create run pack</button>
         <button class="btn btn-primary" id="btn-import-results"><span class="icon btn-icon" data-icon="download"></span>Import result packs</button>`
      : `<button class="btn btn-primary" id="btn-import-run"><span class="icon btn-icon" data-icon="download"></span>Import run pack</button>`;
    bindPageActions();
    const nb = $('btn-new-runpack');
    if (nb) nb.addEventListener('click', createRunPackForLocation);
  }

  async function loadLocations(electionId) {
    const res = await pvh.listLocations(electionId);
    selectedLocations = (res && res.ok && res.locations) || [];
    renderPacksPanel();
  }

  function renderPacksPanel() {
    const packs = $('packs-panel');
    const body = incomingPacks.length
      ? incomingPacks.map((p, i) => `
          <div class="pack-row ${p.ok ? '' : 'pack-bad'}">
            <div class="pack-meta">
              <strong>${esc(p.base)}</strong>
              <span class="text-muted">${p.report && p.report.summary ? esc(p.report.summary.location) + ' &middot; ' + p.report.summary.votes + ' votes' : (p.ok ? 'Valid' : 'Invalid')}</span>
            </div>
            <span class="pill pill-${p.ok ? 'success' : 'danger'}">${p.ok ? 'Verified' : 'Failed'}</span>
            <button class="btn btn-ghost" data-remove-pack="${i}">Remove</button>
          </div>`).join('')
      : `<p class="text-muted hint">No result packs imported yet. Use <strong>Import result packs</strong> above to load sealed packs from your locations.</p>`;
    packs.innerHTML = `
      <div class="card-title">Result packs from locations</div>
      <div class="pack-list">${body}</div>
      ${incomingPacks.length ? `<button class="btn btn-primary" id="btn-compile"><span class="icon btn-icon" data-icon="merge"></span>Verify &amp; compile results</button>` : ''}`;
    packs.querySelectorAll('[data-remove-pack]').forEach((b) => {
      b.addEventListener('click', () => { incomingPacks.splice(Number(b.dataset.removePack), 1); renderPacksPanel(); });
    });
    const c = $('btn-compile');
    if (c) c.addEventListener('click', compileResults);
    const compile = $('compile-panel');
    compile.hidden = true;
    compiledResult = null;
  }

  async function importResultPacks() {
    const res = await pvh.pickResultPacks();
    if (!res || !res.ok) { ui.toast((res && res.error) || 'No packs imported', 'error'); return; }
    const good = res.results.filter((r) => r.ok);
    const bad = res.results.filter((r) => !r.ok);
    incomingPacks = incomingPacks.concat(res.results);
    renderPacksPanel();
    if (bad.length) {
      openModal({
        title: 'Invalid result pack',
        body: `<p>One or more packs failed verification:</p><ul class="mb">${bad.map((b) => `<li><strong>${esc(b.base)}</strong>${b.report && b.report.errors ? ': ' + esc(b.report.errors.join('; ')) : ''}</li>`).join('')}</ul><p>The valid packs were kept. You can compile only the verified ones.</p>`,
      });
    } else if (good.length) {
      ui.toast(`${good.length} verified result pack(s) imported`, 'success');
    }
    const compile = $('compile-panel');
    if (incomingPacks.some((p) => p.ok)) {
      compile.hidden = false;
    }
  }

  async function compileResults() {
    const btn = $('btn-compile');
    const valid = incomingPacks.filter((p) => p.ok).map((p) => ({ pack: p.pack }));
    if (!valid.length) { ui.toast('No verified packs to compile', 'error'); return; }
    const res = await pvh.compileResultPacks(valid);
    if (!res || !res.ok) { ui.toast((res && res.error) || 'Could not compile results', 'error'); return; }
    compiledResult = res;
    renderCompile(res);
  }

  function renderCompile(res) {
    const compile = $('compile-panel');
    const tallyRows = (res.tally || []).map((t) =>
      `<tr><td>${esc(t.position)}</td><td>${esc(t.candidate)}</td><td class="num">${t.count}</td></tr>`).join('');
    const locTotals = (res.locations || []).map((l) => `<span class="pill pill-info">${esc(l)}</span>`).join(' ');
    compile.hidden = false;
    compile.innerHTML = `
      <div class="card-title">Compiled result</div>
      <div class="text-muted mb">Locations: ${locTotals || '—'} &middot; Total votes: <strong>${res.votes}</strong></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Position</th><th>Candidate</th><th class="num">Votes</th></tr></thead>
          <tbody>${tallyRows}</tbody>
        </table>
      </div>
      <p class="text-muted hint">Orders and tie-breaks are deterministic, so re-importing the same packs reproduces this tally. The main coordinator is the only role that can compile.</p>`;
  }

  // ---------- Location coordinator: import run + seal/export ----------

  function renderLocCoordActions(e) {
    const actions = $('actions-panel');
    actions.innerHTML = `
      <div class="card-title">Your run — ${statusPill(e.status)}</div>
      <p class="text-muted hint">This machine is running the election imported from your main coordinator.</p>
      <div class="loc-tools">
        <a class="btn btn-secondary" href="stations.html"><span class="icon btn-icon" data-icon="officers"></span>Open stations</a>
        <a class="btn btn-secondary" href="results.html"><span class="icon btn-icon" data-icon="results"></span>View live results</a>
        <button class="btn btn-primary" id="btn-export-result"><span class="icon btn-icon" data-icon="upload"></span>Seal &amp; export result pack</button>
      </div>
      <p class="auth-error" id="export-msg"></p>`;
    $('btn-export-result').addEventListener('click', () => exportResultPack(e));
  }

  async function exportResultPack(e) {
    const msg = $('export-msg');
    setMsg(msg, 'Sealing stations and exporting…');
    const res = await pvh.createResultPack(e.id);
    if (!res || !res.ok) {
      setMsg(msg, (res && res.error) || 'Could not export result pack. Make sure every station is sealed first.', 'error');
      return;
    }
    setMsg(msg, `Result pack exported to ${res.path}`, 'ok');
    ui.toast('Result pack exported — send it to your main coordinator', 'success');
  }

  // ---------- Import run pack (shared) ----------

  async function importRunPack() {
    if (!pvh || !pvh.importRunPack) { ui.toast('Import is not available in this build', 'error'); return; }
    openModal({
      title: 'Import a Run Pack',
      width: '520px',
      body: `
        <p class="text-muted mb">Click import, choose the run pack file your main coordinator gave you, then enter its passphrase. On a fresh machine, also enter the setup code to create your location coordinator account.</p>
        <p class="auth-error" id="import-err"></p>
        <div class="field">
          <label class="label" for="import-pass">Passphrase</label>
          <input class="input" type="password" id="import-pass" autocomplete="new-password" placeholder="Set by the main coordinator">
        </div>
        <div class="field">
          <label class="label" for="import-setup">Setup code <span class="text-muted">(optional, for fresh machines)</span></label>
          <input class="input" type="text" id="import-setup" placeholder="e.g. AB12CD34EF56">
        </div>
        <button class="btn btn-primary btn-block" id="import-go" style="margin-top:8px;">Choose file &amp; import</button>
      `,
      onMount(bodyEl, close) {
        const err = bodyEl.querySelector('#import-err');
        bodyEl.querySelector('#import-go').addEventListener('click', async () => {
          const pass = bodyEl.querySelector('#import-pass').value.trim();
          const setup = bodyEl.querySelector('#import-setup').value.trim();
          const res = await pvh.importRunPack({ passphrase: pass, setupCode: setup });
          if (res && res.canceled) return;
          if (!res || !res.ok) {
            setMsg(err, (res && res.error) || 'Import failed', 'error');
            return;
          }
          ui.toast(`Imported ${res.election.title} for ${res.location.name}`, 'success');
          close();
          await loadElections();
        });
      },
    });
  }

  // ---------- page-action wiring ----------

  function bindPageActions() {
    const ir = $('btn-import-results');
    if (ir) ir.addEventListener('click', importResultPacks);
    const ip = $('btn-import-run');
    if (ip) ip.addEventListener('click', importRunPack);
  }

  // ---------- kick off ----------

  (async function init() {
    const rolePanel = $('role-panel');
    rolePanel.innerHTML = isMainCoordinator
      ? `<div class="card-title">Main coordinator</div>
         <p class="text-muted hint">You own the overall election. Hand each location a run pack, then import their sealed result packs and compile the aggregate tally.</p>`
      : `<div class="card-title">Location coordinator</div>
         <p class="text-muted hint">Import the run pack from your main coordinator to load this location's election, ballot, and voters. When every station is sealed, export the result pack and send it back.</p>`;
    const paw = $('page-actions');
    if (!pvh || !pvh.listElections) {
      rolePanel.insertAdjacentHTML('beforeend', `<p class="auth-error">This feature is not available in this build.</p>`);
      paw.innerHTML = '';
      return;
    }
    if (isMainCoordinator) {
      paw.innerHTML = `
        <button class="btn btn-primary" id="btn-new-runpack"><span class="icon btn-icon" data-icon="plus"></span>Create run pack</button>
        <button class="btn btn-primary" id="btn-import-results"><span class="icon btn-icon" data-icon="download"></span>Import result packs</button>`;
      $('btn-new-runpack').addEventListener('click', createRunPackForLocation);
      $('btn-import-results').addEventListener('click', importResultPacks);
    } else if (isLocCoord && elections.length === 0) {
      paw.innerHTML = `<button class="btn btn-primary" id="btn-import-run"><span class="icon btn-icon" data-icon="download"></span>Import run pack</button>`;
      bindPageActions();
    }
    await loadElections();
  })();

  // ---------- Create run pack (admin) ----------

  async function createRunPackForLocation() {
    if (!elections.length) { ui.toast('Create an election first', 'error'); return; }
    openModal({
      title: 'Create a run pack for a location',
      width: '520px',
      body: `
        <p class="text-muted mb">This pack carries the full election (ballot, stations, and the whole voter registry) so a location can run it with zero reconfiguration. Set a passphrase to encrypt it.</p>
        <p class="auth-error" id="run-err"></p>
        <div class="field">
          <label class="label" for="run-elec">Election</label>
          <select class="input" id="run-elec">${elections.map((e) => `<option value="${esc(e.id)}">${esc(e.title)}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label class="label" for="run-loc">Location name</label>
          <input class="input" id="run-loc" placeholder="e.g. West Campus">
        </div>
        <div class="field">
          <label class="label" for="run-code">Location code <span class="text-muted">(optional)</span></label>
          <input class="input" id="run-code" placeholder="e.g. WEST">
        </div>
        <div class="field">
          <label class="label" for="run-pass">Pack passphrase</label>
          <input class="input" type="password" id="run-pass" placeholder="Enter a passphrase to encrypt (recommended)">
        </div>
        <button class="btn btn-primary btn-block" id="run-go" style="margin-top:8px;">Create &amp; export run pack</button>
      `,
      onMount(bodyEl, close) {
        const err = bodyEl.querySelector('#run-err');
        // Wrap the election select in the shared custom dropdown for consistency.
        const runElecDD = buildSelectDropdown(bodyEl.querySelector('#run-elec'), () => {});
        bodyEl.querySelector('#run-go').addEventListener('click', async () => {
          const electionId = runElecDD.get();
          const name = bodyEl.querySelector('#run-loc').value.trim();
          const code = bodyEl.querySelector('#run-code').value.trim();
          const pass = bodyEl.querySelector('#run-pass').value;
          if (!electionId) { setMsg(err, 'Choose an election', 'error'); return; }
          if (!name) { setMsg(err, 'Enter a location name', 'error'); return; }
          const res = await pvh.createRunPack({ electionId, locationName: name, locationCode: code, passphrase: pass });
          if (!res || !res.ok) { setMsg(err, (res && res.error) || 'Could not create pack', 'error'); return; }
          setMsg(err, `Run pack saved to ${res.path}. Share this file and the passphrase with the ${name} coordinator.`, 'ok');
          ui.toast('Run pack exported', 'success');
          setTimeout(close, 1400);
        });
      },
    });
  }
})();
