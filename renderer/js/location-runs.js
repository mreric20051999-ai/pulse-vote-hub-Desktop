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
         <button class="btn btn-primary" id="btn-import-results"><span class="icon btn-icon" data-icon="download"></span>Import result packs</button>
         <button class="btn btn-secondary" id="btn-verify-receipt"><span class="icon btn-icon" data-icon="check"></span>Verify with receipt</button>
         <button class="btn btn-secondary" id="btn-receive-relay"><span class="icon btn-icon" data-icon="download"></span>Receive over the internet</button>`
      : `<button class="btn btn-primary" id="btn-import-run"><span class="icon btn-icon" data-icon="download"></span>Import run pack</button>`;
    bindPageActions();
    const nb = $('btn-new-runpack');
    if (nb) nb.addEventListener('click', createRunPackForLocation);
    const vr = $('btn-verify-receipt');
    if (vr) vr.addEventListener('click', verifyPackWithReceipt);
    const rr = $('btn-receive-relay');
    if (rr) rr.addEventListener('click', receivePackOverInternet);
  }

  async function loadLocations(electionId) {
    const res = await pvh.listLocations(electionId);
    selectedLocations = (res && res.ok && res.locations) || [];
    renderPacksPanel();
  }

  // Verify a result pack (received over any distance) against a slim receipt.
  async function verifyPackWithReceipt() {
    ui.openModal({
      title: 'Verify pack with receipt',
      body: `
        <p class="mb">Paste the <strong>receipt payload</strong> your location coordinator sent (phone/email), then choose the result pack file that travelled to you.</p>
        <label class="field-label">Receipt payload</label>
        <textarea id="receipt-paste" class="input" rows="6" placeholder='{"v":1,"kind":"result","fingerprint":"...","shortcode":"8F31-2AC0-1B7D",...}'></textarea>
        <div class="mt"><button class="btn btn-primary btn-block" id="btn-receipt-go" style="margin-top:8px;">Choose result pack &amp; verify</button></div>`,
    });
    const go = $('btn-receipt-go');
    if (go) go.addEventListener('click', async () => {
      const paste = $('receipt-paste');
      let receipt;
      try { receipt = JSON.parse((paste && paste.value) || '{}'); }
      catch { ui.toast('That receipt is not valid JSON', 'error'); return; }
      if (!receipt.fingerprint) { ui.toast('That receipt has no fingerprint', 'error'); return; }
      try {
        const res = await pvh.verifyPackReceipt(receipt);
        if (!res || res.ok === false) {
          if (res && res.canceled) { return; }
          ui.toast((res && (res.errors || []).join(' ') || res.error) || 'Verification failed', 'error');
          if (res && res.errors && res.errors.length) {
            ui.openModal({ title: 'Receipt verification failed', body: `<ul class="mb">${res.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` });
          }
          return;
        }
        if (res.match) {
          incomingPacks.push({ base: res.base, ok: true, report: res.report, pack: res.pack });
          renderPacksPanel();
          ui.openModal({
            title: 'Pack verified against receipt',
            body: `<p>Pack <strong>${esc(res.base)}</strong> matches the receipt fingerprint and passed full verification.</p><p class="text-muted">It is now in the compile list.</p>`,
          });
        } else {
          ui.toast('Pack does not match the receipt', 'error');
        }
      } catch (e) {
        ui.toast('Verification failed: ' + (e.message || e), 'error');
      }
    });
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
      ${incomingPacks.length ? `<button class="btn btn-primary" id="btn-compile"><span class="icon btn-icon" data-icon="merge"></span>Verify &amp; compile results</button>` : ''}
      <div class="ledger-block">
        <div class="card-title">Distance hand-off ledger</div>
        <div id="ledger-list" class="text-muted hint">Loading…</div>
      </div>`;
    renderLedger();
    packs.querySelectorAll('[data-remove-pack]').forEach((b) => {
      b.addEventListener('click', () => { incomingPacks.splice(Number(b.dataset.removePack), 1); renderPacksPanel(); });
    });
    const c = $('btn-compile');
    if (c) c.addEventListener('click', compileResults);
    const compile = $('compile-panel');
    compile.hidden = true;
    compiledResult = null;
  }

  async function renderLedger() {
    const list = $('ledger-list');
    if (!list || !selectedElection) { if (list) list.textContent = 'Select an election to see its hand-off trail.'; return; }
    const [ex, rc] = await Promise.all([
      pvh.listPackExchanges(selectedElection.id),
      pvh.listPackReceipts(selectedElection.id),
    ]);
    const rows = [];
    for (const r of ((rc && rc.receipts) || [])) {
      rows.push({ created_at: r.created_at, text: `Receipt created — <strong>${esc(r.shortcode)}</strong> (${r.votes == null ? r.summary_json || '' : esc((JSON.parse(r.summary_json || '{}')).votes)} votes, ${esc(r.location_name)})`, status: 'sealed' });
    }
    for (const x of ((ex && ex.exchanges) || [])) {
      const t = x.election_title ? `${esc(x.election_title)}` : '';
      rows.push({
        created_at: x.created_at,
        text: `${esc(x.action || '')} — ${esc(x.details || '')} ${t}`,
        status: x.status,
      });
    }
    rows.sort((a, b) => (b.created_at - a.created_at));
    if (!rows.length) { list.innerHTML = 'No hand-off records yet. Use <strong>Create verification receipt</strong> at the location and <strong>Verify with receipt</strong> here.'; return; }
    list.innerHTML = rows.slice(0, 10).map((r) => `
      <div class="ledger-row">
        <span class="pill pill-${r.status === 'failed' ? 'danger' : (r.status === 'verified' || r.status === 'sealed' ? 'success' : 'info')}">${esc(r.status)}</span>
        <span>${r.text}</span>
        <span class="text-muted">${new Date(r.created_at).toLocaleTimeString()}</span>
      </div>`).join('');
  }

  async function importResultPacks() {
    const res = await pvh.pickResultPacks();
    if (!res || !res.ok) { ui.toast((res && res.error) || 'No packs imported', 'error'); return; }
    const good = res.results.filter((r) => r.ok);
    const bad = res.results.filter((r) => !r.ok);
    incomingPacks = incomingPacks.concat(res.results);
    renderPacksPanel();
    if (bad.length) {
      ui.openModal({
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
        <button class="btn btn-secondary" id="btn-create-receipt"><span class="icon btn-icon" data-icon="check"></span>Create verification receipt</button>
        <button class="btn btn-secondary" id="btn-send-relay"><span class="icon btn-icon" data-icon="upload"></span>Send over the internet</button>
      </div>
      <p class="auth-error" id="export-msg"></p>`;
    $('btn-export-result').addEventListener('click', () => exportResultPack(e));
    $('btn-create-receipt').addEventListener('click', () => createPackReceipt(e));
    $('btn-send-relay').addEventListener('click', () => sendPackOverInternet(e));
  }

  // Over-the-internet hand-off: push the sealed result pack (E2E-encrypted with
  // the passphrase you set) to the relay, then share the transfer code +
  // passphrase with the main coordinator over the phone. One-time + expiring.
  const EYE_SVG =
    '<svg class="eye-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
    '<svg class="eye-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  function wirePassToggle(inputId, btnId) {
    const input = $(inputId);
    const toggle = $(btnId);
    if (!input || !toggle) return;
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(show));
      toggle.setAttribute('aria-label', show ? 'Hide passphrase' : 'Show passphrase');
    });
  }
  function wireCodeInputNorm(inputId) {
    const input = $(inputId);
    if (!input) return;
    input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''); });
  }

  // Location coordinator: push the sealed result pack to the internet relay.
  function sendPackOverInternet(e) {
    ui.openModal({
      title: 'Send result pack over the internet',
      width: '26rem',
      body: `
        <p class="modal-lead">Encrypt your sealed result pack on this machine, push it to the relay, then share the code + passphrase with your main coordinator.</p>
        <div class="relay-steps">
          <div class="relay-step"><span class="relay-step-n">1</span><span>Encrypted on this machine</span></div>
          <div class="relay-step"><span class="relay-step-n">2</span><span>Pushed to the relay</span></div>
          <div class="relay-step"><span class="relay-step-n">3</span><span>Share code &amp; passphrase</span></div>
        </div>
        <label class="field-label" for="relay-pass">Pack passphrase</label>
        <div class="password-wrap">
          <input class="input" type="password" id="relay-pass" autocomplete="new-password" placeholder="e.g. 7 blue cables tonight" minlength="8">
          ${EYE_SVG ? '<button type="button" class="password-toggle" id="relay-pass-toggle" aria-label="Show passphrase" aria-pressed="false">' + EYE_SVG + '</button>' : ''}
        </div>
        <p class="field-hint">Min 8 characters. The relay never stores it — only the encrypted pack.</p>
        <p class="auth-error" id="relay-err"></p>
        <button class="btn btn-primary btn-block" id="relay-send-go">Encrypt &amp; push result pack</button>`,
    });
    wirePassToggle('relay-pass', 'relay-pass-toggle');
    const go = $('relay-send-go');
    if (go) go.addEventListener('click', async () => {
      const pass = $('relay-pass');
      const err = $('relay-err');
      if (!pass || pass.value.length < 8) { setMsg(err, 'Passphrase must be at least 8 characters.', 'error'); return; }
      setMsg(err, '');
      await ui.busy(go, 'Encrypting &amp; pushing…', async () => {
        const res = await pvh.sendPackOverInternet(e.id, pass.value);
        if (!res || !res.ok) { setMsg(err, (res && res.error) || 'Send failed', 'error'); return; }
        const modal = ui.openModal({
          title: 'Result pack pushed to the relay',
          width: '26rem',
          body: `
            <div class="verify-badge ok"><span class="status-dot success"></span>Result pack pushed</div>
            <p class="mb">Give this <strong>transfer code</strong> and the <strong>passphrase</strong> you chose to your main coordinator:</p>
            <div class="receipt-code">${esc(res.code)}</div>
            <p class="field-hint">The relay holds only encrypted bytes and forgets this envelope once received or after ${res.ttl_days || 7} days.</p>
            <div class="modal-actions">
              <button class="btn btn-primary" id="btn-copy-code">Copy transfer code</button>
              <button class="btn btn-secondary" id="btn-done-send">Done</button>
            </div>`,
        });
        const cp = $('btn-copy-code');
        if (cp) cp.addEventListener('click', () => {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(res.code).then(() => ui.toast('Transfer code copied', 'success'));
        });
        const done = $('btn-done-send');
        if (done) done.addEventListener('click', modal.close);
        ui.toast('Result pack pushed to relay', 'success');
      });
    });
  }

  // Main coordinator: claim a sealed result pack from the relay with the
  // transfer code + passphrase sent by the location coordinator.
  function receivePackOverInternet() {
    ui.openModal({
      title: 'Receive result pack over the internet',
      width: '26rem',
      body: `
        <p class="modal-lead">Claim the sealed result pack your location coordinator sent. It is decrypted and fully verified on this machine before it enters the compile list.</p>
        <div class="relay-steps">
          <div class="relay-step"><span class="relay-step-n">1</span><span>Enter code &amp; passphrase</span></div>
          <div class="relay-step"><span class="relay-step-n">2</span><span>Decrypted on this machine</span></div>
          <div class="relay-step"><span class="relay-step-n">3</span><span>Verified, then compiled</span></div>
        </div>
        <label class="field-label" for="relay-code">Transfer code</label>
        <input class="input input-code" type="text" id="relay-code" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="PK-XXXX-XXXX-XXXX-XXXX">
        <p class="field-hint">Sent to you by your location coordinator over a private channel.</p>
        <label class="field-label" for="relay-rpass">Passphrase</label>
        <div class="password-wrap">
          <input class="input" type="password" id="relay-rpass" autocomplete="new-password" placeholder="Passphrase from your coordinator" minlength="8">
          <button type="button" class="password-toggle" id="relay-rpass-toggle" aria-label="Show passphrase" aria-pressed="false">${EYE_SVG}</button>
        </div>
        <p class="field-hint">Exactly as your coordinator chose it — it cannot be recovered if mistyped.</p>
        <p class="auth-error" id="relay-rerr"></p>
        <button class="btn btn-primary btn-block" id="relay-recv-go">Claim &amp; verify result pack</button>`,
    });
    wirePassToggle('relay-rpass', 'relay-rpass-toggle');
    wireCodeInputNorm('relay-code');
    const go = $('relay-recv-go');
    if (go) go.addEventListener('click', async () => {
      const code = $('relay-code');
      const pass = $('relay-rpass');
      const err = $('relay-rerr');
      if (!code || !code.value.trim()) { setMsg(err, 'Enter the transfer code.', 'error'); return; }
      if (!pass || pass.value.length < 8) { setMsg(err, 'Passphrase must be at least 8 characters.', 'error'); return; }
      setMsg(err, '');
      await ui.busy(go, 'Claiming &amp; verifying…', async () => {
        const res = await pvh.receivePackOverInternet(code.value.trim(), pass.value);
        if (!res || res.ok === false) {
          setMsg(err, (res && (res.errors || []).join(' ') || res.error) || 'Receive failed', 'error');
          return;
        }
        incomingPacks.push({ base: res.base, ok: true, report: res.report, pack: res.pack });
        renderPacksPanel();
        const fp = (res.meta && res.meta.fingerprint) || '';
        const fpShort = fp.replace(/[^a-f0-9]/gi, '').slice(0, 12).toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
        const modal = ui.openModal({
          title: 'Result pack received &amp; verified',
          width: '26rem',
          body: `
            <div class="verify-badge ok"><span class="status-dot success"></span>Received &amp; verified</div>
            <p class="mb">Pack from <strong>${esc(res.report.summary.location || '—')}</strong> — <strong>${esc(res.report.summary.election || '—')}</strong> claimed from the relay and fully verified. It is now in the compile list.</p>
            ${fpShort ? `<div class="receipt-code" style="font-size:16px;margin-bottom:4px">${esc(fpShort)}</div>` : ''}
            <div class="modal-actions">
              <button class="btn btn-primary" id="btn-done-recv">Done</button>
            </div>`,
        });
        const done = $('btn-done-recv');
        if (done) done.addEventListener('click', modal.close);
        ui.toast('Result pack received & verified', 'success');
      });
    });
  }

  // Distance hand-off: share a slim receipt (fingerprint + headline counts) by
  // phone/email so the main coordinator can verify the sealed pack that arrives
  // through any WAN path. The full pack stays encrypted on the way.
  async function createPackReceipt(e) {
    const res = await pvh.createPackReceipt(e.id);
    if (!res || !res.ok) { ui.toast((res && res.error) || 'Could not create receipt', 'error'); return; }
    ui.openModal({
      title: 'Verification receipt',
      body: `
        <p class="mb">Share this receipt with your main coordinator by phone, email or any channel. When they receive the exported <strong>result pack</strong>, they can verify it against this receipt before compiling.</p>
        <div class="receipt-code">${esc(res.receipt.shortcode)}</div>
        <label class="field-label">Receipt payload (copy &amp; send)</label>
        <textarea id="receipt-payload" class="input" rows="7" readonly></textarea>
        <div class="mt"><button class="btn btn-primary" id="btn-copy-receipt"><span class="icon btn-icon" data-icon="copy"></span>Copy payload</button></div>`,
    });
    const ta = $('receipt-payload');
    if (ta) ta.value = res.qr;
    const cp = $('btn-copy-receipt');
    if (cp) cp.addEventListener('click', () => { pick(ta); });
    function pick(el) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(el.value).then(() => ui.toast('Receipt copied', 'success'));
      } else {
        el.select(); document.execCommand('copy'); ui.toast('Receipt copied', 'success');
      }
    }
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
    ui.openModal({
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
        <button class="btn btn-primary" id="btn-import-results"><span class="icon btn-icon" data-icon="download"></span>Import result packs</button>
        <button class="btn btn-secondary" id="btn-verify-receipt"><span class="icon btn-icon" data-icon="check"></span>Verify with receipt</button>
        <button class="btn btn-secondary" id="btn-receive-relay"><span class="icon btn-icon" data-icon="download"></span>Receive over the internet</button>`;
      $('btn-new-runpack').addEventListener('click', createRunPackForLocation);
      $('btn-import-results').addEventListener('click', importResultPacks);
      $('btn-verify-receipt').addEventListener('click', verifyPackWithReceipt);
      $('btn-receive-relay').addEventListener('click', receivePackOverInternet);
    } else if (isLocCoord && elections.length === 0) {
      paw.innerHTML = `<button class="btn btn-primary" id="btn-import-run"><span class="icon btn-icon" data-icon="download"></span>Import run pack</button>`;
      bindPageActions();
    }
    await loadElections();
  })();

  // ---------- Create run pack (admin) ----------

  async function createRunPackForLocation() {
    if (!elections.length) { ui.toast('Create an election first', 'error'); return; }
    ui.openModal({
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
