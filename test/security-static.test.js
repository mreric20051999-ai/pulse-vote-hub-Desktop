// Static regression guards for the security/gap fixes. These assert wiring
// survives future edits; they don't execute the Electron runtime.
const fs = require('fs');
const path = require('path');
const { check, ok, report } = require('./helpers');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const main = read('electron/main.js');
const preload = read('electron/preload.js');
const hub = read('electron/lan/hub.js');
const db = read('electron/db.js');
const station = read('electron/station.js');
const stationUI = read('renderer/js/station.js');
const integrityUI = read('renderer/js/integrity.js');
const mergeUI = read('renderer/js/merge.js');
const adminHTML = read('renderer/administration.html');

check('verify-details reveals only from staff paths (desktop + LAN link)', () => {
  const at = main.indexOf("ipcMain.handle('voter:verify-details'");
  ok(at !== -1, 'handler exists');
  const body = main.slice(at, at + 1600);
  ok(body.includes('revealPassword: true'), 'desktop help desk reveals');
  ok(body.includes('voterRecoverLimit'), 'desktop path is rate-limited');
  ok(preload.includes("ipcRenderer.invoke('voter:verify-details', eid, details, oid())"),
    'preload threads the session token');
});

check('LAN recovery link reveals (staff-guided) and is rate-limited', () => {
  const at = hub.indexOf('verify-details');
  ok(at !== -1, 'kiosk route exists');
  const body = hub.slice(at, at + 1400);
  ok(body.includes('revealPassword: true'), 'LAN recovery link reveals the password');
  ok(body.includes('_ipLimit'), 'network path is rate-limited per IP');
});

check('election export/import are admin-accessible (not developer-only)', () => {
  for (const channel of ["'backup:election'", "'backup:election-import'"]) {
    const at = main.indexOf('ipcMain.handle(' + channel);
    ok(at !== -1, `${channel} handler exists`);
    const body = main.slice(at, at + 500);
    ok(body.includes('requireAdmin(token, e)'), `${channel} uses requireAdmin`);
    ok(!body.includes('requireDeveloper(token, e)'), `${channel} no longer requires developer`);
  }
});

check('station incident/activity persistence is wired end to end', () => {
  for (const ch of ["'station:incidents'", "'station:incident-add'", "'station:activity'", "'station:activity-add'"]) {
    ok(main.includes('ipcMain.handle(' + ch), `IPC handler ${ch}`);
  }
  ok(/guardStation\(/.test(main.slice(main.indexOf("'station:incidents'"), main.indexOf("'station:incidents'") + 1200)),
    'station handlers use guardStation');
  ok(station.includes('function addIncident') && station.includes('function addActivity'),
    'station module persists incidents/activity');
  for (const fn of ['listStationIncidents', 'addStationIncident', 'listStationActivity', 'addStationActivity']) {
    ok(preload.includes(fn + ':'), `preload exposes ${fn}`);
    ok(stationUI.includes(callName(fn)), `renderer calls ${fn}`);
  }
});

function callName(fn) {
  const map = {
    listStationIncidents: 'listStationIncidents',
    addStationIncident: 'addStationIncident',
    listStationActivity: 'listStationActivity',
    addStationActivity: 'addStationActivity',
  };
  return map[fn];
}

check('database migration ledger and station tables exist', () => {
  ok(db.includes('schema_migrations'), 'schema_migrations ledger present');
  ok(db.includes('station_incidents') && db.includes('station_activity'), 'station tables in schema');
});

check('check-in hashes are written on both sync paths and surfaced in the UI', () => {
  const sync = read('electron/lan/sync.js');
  ok(sync.includes('checkinHash('), 'sync requires/uses checkinHash');
  ok((sync.match(/hash, synced\) VALUES|\bhash = \?/g) || []).length >= 2, 'hash written on insert and update');
  ok(read('electron/integrity.js').includes('function verifyCheckins'), 'verifyCheckins exists');
  ok(integrityUI.includes('Check-in records'), 'integrity UI row present');
});

check('admin merge panel exposes the election export entry point', () => {
  ok(adminHTML.includes('id="merge-export-btn"'), 'export button in administration page');
  ok(mergeUI.includes('merge-export-btn'), 'merge UI wires the export button');
  ok(mergeUI.includes('exportElection('), 'merge UI calls exportElection');
});

report('security-static.test.js');
