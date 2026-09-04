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
  function sendPackOverInternet(e) {
    ui.openModal({
      title: 'Send result pack over the internet',
      body: `
        <p class="mb">The sealed result pack will be <strong>encrypted on this machine</strong> with a passphrase you set, then pushed to the relay. Share the resulting <strong>transfer code</strong> + <strong>passphrase</strong> with your main coordinator by phone or any private channel. The relay only ever holds the encrypted bytes.</p>
        <label class="field-label">Pack passphrase (min 8 characters)</label>
        <input class="input" type="password" id="relay-pass" autocomplete="new-password" placeholder="Set a strong passphrase">
        <p class="auth-error" id="relay-err"></p>
        <button class="btn btn-primary btn-block" id="relay-send-go" style="margin-top:8px;">Encrypt &amp; push result pack</button>`,
    });
    const go = $('relay-send-go');
    if (go) go.addEventListener('click', async () => {
      const pass = $('relay-pass');
      const err = $('relay-err');
      if (!pass || pass.value.length < 8) { setMsg(err, 'Passphrase must be at least 8 characters.', 'error'); return; }
      setMsg(err, 'Encrypting and pushing…');
      const res = await pvh.sendPackOverInternet(e.id, pass.value);
      if (!res || !res.ok) { setMsg(err, (res && res.error) || 'Send failed', 'error'); return; }
      ui.openModal({
        title: 'Result pack pushed to the relay',
        body: `
          <p class="mb">Give this <strong>transfer code</strong> and the <strong>passphrase</strong> you chose to your main coordinator:</p>
          <div class="receipt-code">${esc(res.code)}</div>
          <p class="text-muted hint">The envelope expires in ${res.ttl_days || 7} day(s) and can be received only once.</p>
          <button class="btn btn-primary btn-block" id="btn-copy-code">Copy transfer code</button>`,
      });
      const cp = $('btn-copy-code');
      if (cp) cp.addEventListener('click', () => {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(res.code).then(() => ui.toast('Transfer code copied', 'success'));
      });
      ui.toast('Result pack pushed to relay', 'success');
    });
  }

  // Main coordinator: claim a sealed result pack from the relay with the
  // transfer code + passphrase sent by the location coordinator.
  function receivePackOverInternet() {
    ui.openModal({
      title: 'Receive result pack over the internet',
      body: `
        <p class="mb">Enter the <strong>transfer code</strong> and <strong>passphrase</strong> your location coordinator sent you. The pack is pulled once, decrypted on this machine, and fully verified before it enters the compile list.</p>
        <label class="field-label">Transfer code</label>
        <input class="input" type="text" id="relay-code" placeholder="PK-XXXX-XXXX-XXXX-XXXX">
        <label class="field-label">Passphrase</label>
        <input class="input" type="password" id="relay-rpass" autocomplete="new-password">
        <p class="auth-error" id="relay-rerr"></p>
        <button class="btn btn-primary btn-block" id="relay-recv-go" style="margin-top:8px;">Claim &amp; verify result pack</button>`,
    });
    const go = $('relay-recv-go');
    if (go) go.addEventListener('click', async () => {
      const code = $('relay-code');
      const pass = $('relay-rpass');
      const err = $('relay-rerr');
      if (!code || !code.value.trim()) { setMsg(err, 'Enter the transfer code.', 'error'); return; }
      if (!pass || pass.value.length < 8) { setMsg(err, 'Passphrase must be at least 8 characters.', 'error'); return; }
      setMsg(err, 'Claiming and verifying…');
      const res = await pvh.receivePackOverInternet(code.value.trim(), pass.value);
      if (!res || res.ok === false) {
        setMsg(err, (res && (res.errors || []).join(' ') || res.error) || 'Receive failed', 'error');
        return;
      }
      incomingPacks.push({ base: res.base, ok: true, report: res.report, pack: res.pack });
      renderPacksPanel();
      ui.openModal({
        title: 'Result pack received &amp; verified',
        body: `<p>Pack from <strong>${esc(res.report.summary.location || '—')}</strong> (<strong>${esc(res.report.summary.election || '—')}</strong>) claimed from the relay and fully verified.</p><p class="text-muted">It is now in the compile list.</p>`,
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
