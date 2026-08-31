// Live-browser test for the Location Runs page via CDP against the running app.
const { CDP } = require('./test-cdp-helper');

const ADMIN_ID = 'a5b039d1-e91b-4eb8-bb9a-e8024af0410e';
const LIVE_EID = 'db5a631b-608d-4220-b6de-95019aa05391';

let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n); } }

(async () => {
  const cdp = await CDP.connect(9223);
  // Pick a page target (main window / dashboard)
  const pages = await cdp.pages();
  const page = pages.find((p) => p.type === 'page');
  if (!page) { console.log('FAIL: no page target'); process.exit(1); }
  console.log('page url:', page.url);

  // Attach to this page
  const ws = new (require('ws'))(page.webSocketDebuggerUrl);
  let id = 0; const pend = {};
  ws.on('message', (m) => { const o = JSON.parse(m.toString()); if (o.id && pend[o.id]) { pend[o.id](o); delete pend[o.id]; } });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend[i] = res; ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((res) => ws.on('open', res));
  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');

  // 1. Inject an admin session so the app treats us as BOSS (admin)
  await evalJs(`localStorage.setItem('pvh_session', JSON.stringify({ id: '${ADMIN_ID}', role: 'admin', officer_id: 'BOSS', name: 'Eric Adjei' })); true`);

  // 2. Navigate to the Location Runs page
  await send('Page.enable');
  await send('Page.navigate', { url: 'file://' + __dirname + '/renderer/location-runs.html' });
  await new Promise((r) => setTimeout(r, 1500));

  // 3. Check the page loaded and bridge exists
  const title = await evalJs(`document.title`);
  ok(/Location Runs/.test(title), `page title: ${title}`);

  const hasBridge = await evalJs(`!!window.pvh`);
  ok(hasBridge, 'window.pvh bridge present');

  // 4. Verify the location bridge methods exist
  const methods = await evalJs(`['listLocations','createRunPack','importRunPack','createResultPack','pickResultPacks','compileResultPacks'].map(m => !!window.pvh[m])`);
  ok(methods.every(Boolean), `location bridge methods present: ${JSON.stringify({ listLocations: methods[0], createRunPack: methods[1], importRunPack: methods[2], createResultPack: methods[3], pickResultPacks: methods[4], compileResultPacks: methods[5] })}`);

  // 5. Role panel rendered as main coordinator (admin)
  const roleText = await evalJs(`(document.getElementById('role-panel')||{}).textContent || ''`);
  ok(/main coordinator|Main coordinator/i.test(roleText), `role panel is main-coordinator: ${roleText.slice(0,40).trim()}...`);

  // 6. listElections populates the selector (admin sees own elections)
  await new Promise((r) => setTimeout(r, 800));
  const pageActions = await evalJs(`(document.getElementById('page-actions')||{}).innerHTML || ''`);
  ok(pageActions.includes('btn-new-runpack') && pageActions.includes('Create run pack'), 'admin sees "Create run pack" action in page header');
  const ddc = await evalJs(`(() => { const dd = document.querySelector('.pdd'); if (!dd) return -1; dd.querySelector('.pdd-trigger').click(); return dd.querySelectorAll('.pdd-option').length; })()`);
  ok(ddc > 0, `election custom dropdown populated (${ddc} options)`);

  // 7. IPC: listLocations on the live election works
  const locRes = await evalJs(`(async () => { const r = await window.pvh.listLocations('${LIVE_EID}'); return JSON.stringify(r); })()`, true);
  const locParsed = JSON.parse(locRes || '{}');
  ok(locParsed.ok === true, `location:list IPC ok (${(locParsed.locations || []).length} locations)`);

  // 8. Select the live election via the custom dropdown and confirm detail + packs panel render
  const selectSet = await evalJs(`(async () => {
    const dd = document.querySelector('.pdd');
    if (!dd) return 'no-dd';
    if (!dd.classList.contains('open')) dd.querySelector('.pdd-trigger').click();
    await new Promise(r => setTimeout(r, 150));
    const opt = dd.querySelector('.pdd-option[data-value="${LIVE_EID}"]');
    if (!opt) return 'no-opt';
    opt.click();
    await new Promise(r => setTimeout(r, 700));
    const detail = (document.getElementById('election-detail')||{}).textContent || '';
    const packs = (document.getElementById('packs-panel')||{}).innerHTML || '';
    const actions = (document.getElementById('page-actions')||{}).innerHTML || '';
    return JSON.stringify({ detail: detail.trim().slice(0,60), packs: packs.slice(0,120), actions: actions });
  })()`, true);
  let selState;
  try { selState = JSON.parse(selectSet || '{}'); } catch (e) { selState = { detail: selectSet }; }
  ok(/Sample Election 2026 \(Live\)/.test(selState.detail || ''), 'election detail shows live election: ' + (selState.detail || ''));
  ok(/result pack/i.test(selState.packs || ''), 'packs panel rendered (mentions result pack)');
  ok((selState.actions || '').includes('btn-new-runpack') && (selState.actions || '').includes('btn-import-results'), 'admin header keeps both buttons after selection');

  // 9. Location-coordinator branch: fabricate an LC session and reload via navigation
  await evalJs(`localStorage.setItem('pvh_session', JSON.stringify({ id: 'lc-fake', role: 'location_coordinator', officer_id: 'LCX', name: 'Loc Coord' })); true`);
  await send('Page.navigate', { url: 'file://' + __dirname + '/renderer/location-runs.html' });
  await new Promise((r) => setTimeout(r, 1500));
  const lcParsed = JSON.parse(await evalJs(`JSON.stringify({
    role: (document.getElementById('role-panel')||{}).textContent || '',
    hint: (document.getElementById('election-hint')||{}).textContent || '',
    actions: (document.getElementById('page-actions')||{}).innerHTML || ''
  })`));
  ok(/Location coordinator/i.test(lcParsed.role), 'LC role panel shows location coordinator');
  ok(lcParsed.actions.includes('btn-import-run'), 'LC sees "Import run pack" action when no election');

  const ready = await evalJs(`document.readyState`);
  ok(ready === 'complete', `document ready: ${ready}`);

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  ws.close(); cdp.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
