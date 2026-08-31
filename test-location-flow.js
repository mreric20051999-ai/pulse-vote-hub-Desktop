// Headless end-to-end logic test for the multi-location run feature.
// Uses a scratch DB in a temp dir (electron app.getPath stubbed out).
// Run: node test-location-flow.js
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvh-loc-test-'));
const appStub = {
  getPath: () => tmp,
  getAppPath: () => tmp,
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: appStub };
  return origLoad.apply(this, arguments);
};

const db = require('./electron/db');
const auth = require('./electron/auth');
const voter = require('./electron/voter');
const election = require('./electron/election');
const signature = require('./electron/signature');
const locationPack = require('./electron/location');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

const d = db.get();

// ---------- 1. Set up a minimal "main" election ----------
section('Main coordinator: set up election');
const setup = auth.setupAdmin('Main Admin', 'ADMIN', 'password1');
ok(setup.ok, 'admin created: ' + JSON.stringify(setup));

// create an election directly via election module
const enc = election.createElection({ title: '2026 General Election', type: 'station' }, { id: setup.officer.id, role: 'admin' });
ok(enc.ok, 'election created: ' + JSON.stringify(enc.election && enc.election.title));
const eid = enc.election.id;

const p = election.addPosition(eid, 'President', 1, { id: setup.officer.id, role: 'admin' });
const posId = p.position.id;
election.addPosition(eid, 'Treasurer', 1, { id: setup.officer.id, role: 'admin' });
const c1 = election.addCandidate({ electionId: eid, positionId: posId, name: 'Alice' }, { id: setup.officer.id, role: 'admin' });
election.addCandidate({ electionId: eid, positionId: posId, name: 'Bob' }, { id: setup.officer.id, role: 'admin' });

// add stations
d.prepare("INSERT INTO stations (id, election_id, name, code, status, created_at) VALUES (?,?,?,?, 'not_opened', ?)")
  .run(require('uuid').v4(), eid, 'Main Hall', 'MAIN', Date.now());
d.prepare("INSERT INTO stations (id, election_id, name, code, status, created_at) VALUES (?,?,?,?, 'not_opened', ?)")
  .run(require('uuid').v4(), eid, 'West Campus', 'WEST', Date.now());

// add voters with plain passwords
const salt = voter.getVoterSalt();
const hashFor = (pw) => auth.hashPassword(pw, salt);
d.prepare("INSERT INTO voters (id, election_id, voter_id, name, password_hash, password_salt, plain_password, assigned_station, has_voted) VALUES (?,?,?,?,?,?,?,?,0)")
  .run(require('uuid').v4(), eid, 'V001', 'A Voter', hashFor('alien'), '', 'alien', 'MAIN');
d.prepare("INSERT INTO voters (id, election_id, voter_id, name, password_hash, password_salt, plain_password, assigned_station, has_voted) VALUES (?,?,?,?,?,?,?,?,0)")
  .run(require('uuid').v4(), eid, 'V002', 'B Voter', hashFor('bee'), '', 'bee', 'WEST');

ok(election.listPositions(eid, { id: setup.officer.id, role: 'admin' }).length === 2, '2 positions');

// ---------- 2. Create a run pack (encrypted) ----------
section('Create encrypted run pack');
const created = locationPack.createRunPackBody({ electionId: eid, locationName: 'West Campus', locationCode: 'WEST', passphrase: 'p@ss secret' });
ok(created.ok, 'run pack created');
ok(created.pack && created.pack.encrypted, 'run pack is encrypted');
ok(created.setupCode && created.setupCode.length === 12, 'setup code present: ' + created.setupCode);
const runPack = created.pack;

// ---------- 3. Simulate the LOCATION machine on a fresh DB ----------
// Point the location module at a FRESH temp db by resetting the electron app path stub.
// We need a second DB instance; simplest: re-require location with a new app path cache.
console.log('\n>> switching to a fresh location DB <<');
fs.mkdirSync(path.join(tmp, 'location1'), { recursive: true });
let locAppPath = path.join(tmp, 'location1');
appStub.getPath = () => locAppPath;

// purge module caches so db re-initializes against the new path
for (const k of Object.keys(require.cache)) {
  if (k.includes('/electron/')) delete require.cache[k];
}
const db2 = require('./electron/db');
const locDb = db2.get();
section('Location coordinator: import run pack (fresh machine, setup code)');
let okImp;
(async () => {
  // We must use the freshly-loaded modules for the location. Re-require.
  const locAuth = require('./electron/auth');
  const locVoter = require('./electron/voter');
  const locElection = require('./electron/election');
  const locSig = require('./electron/signature');
  const locPack = require('./electron/location');

  // fresh machine: no admin -> we simulate actor = null, pass setup code
  const imported = locPack.importRunPack(runPack, { passphrase: 'p@ss secret', setupCode: created.setupCode, actor: null });
  ok(imported.ok, 'import ok: ' + JSON.stringify({ election: imported.election && imported.election.title, location: imported.location && imported.location.name }));
  if (!imported.ok) { console.log(JSON.stringify(imported, null, 2)); process.exit(1); }
  const leid = imported.election.id;

  // location coordinator account should have been created
  const lcOfficers = locDb.prepare("SELECT * FROM officers WHERE role = 'location_coordinator'").all();
  ok(lcOfficers.length === 1, 'one location_coordinator created');
  const lc = lcOfficers[0];
  ok(lc.location_id, 'location coordinator bound to a location');

  // voter credentials should verify on the location machine (salt adopted)
  section('Location: voter credential verification');
  const vRes = locVoter.verifyVoter(leid, 'V001', 'alien');
  ok(vRes && vRes.ok === true, 'voter V001 verifies on location: ' + JSON.stringify(vRes && vRes.error));

  // stations present
  const st = locDb.prepare('SELECT * FROM stations WHERE election_id = ?').all(leid);
  ok(st.length === 2, '2 stations imported');

  // Let's cast votes directly into the location DB to simulate a sealed run.
  section('Location: cast votes + seal stations');
  locDb.prepare("UPDATE voters SET checked_in = 1, checked_in_at = ?, ballot_cast = 1, has_voted = 1 WHERE voter_id = 'V001' AND election_id = ?").run(Date.now(), leid);
  locDb.prepare("UPDATE voters SET checked_in = 1, checked_in_at = ?, ballot_cast = 1, has_voted = 1 WHERE voter_id = 'V002' AND election_id = ?").run(Date.now(), leid);
  const posRows = locDb.prepare('SELECT * FROM positions WHERE election_id = ?').all(leid);
  const candRows = locDb.prepare('SELECT * FROM candidates WHERE election_id = ?').all(leid);
  const presCand = candRows.find((c) => c.name === 'Alice');
  const statRows = locDb.prepare('SELECT * FROM stations WHERE election_id = ?').all(leid);
  ok(presCand, 'Alice exists on location');
  // insert votes (chain)
  const raw0 = `${leid}|${presCand.id}|V001|${Date.now()}`;
  const prev = require('crypto').createHash('sha256').update(raw0).digest('hex');
  const voterIds = ['V001', 'V002'];
  let lastPrev = null;
  voterIds.forEach((vid) => {
    const t = Date.now();
    const raw = `${leid}|${presCand.id}|${vid}|${t}`;
    const h = require('crypto').createHash('sha256').update(raw).digest('hex');
    locDb.prepare("INSERT INTO votes (election_id, position_id, candidate_id, voter_id, station_id, vote_hash, prev_hash, timestamp) VALUES (?,?,?,?,?,?,?,?)")
      .run(leid, presCand.position_id, presCand.id, vid, statRows[0].id, h, lastPrev, t);
    lastPrev = h;
  });
  // seal all stations (status submitted + final_submit_json)
  for (const s of statRows) {
    locDb.prepare("UPDATE stations SET status = 'submitted', closed_at = ?, final_submit_json = ? WHERE id = ?")
      .run(Date.now(), JSON.stringify({ votes: 1 }), s.id);
  }

  // ---------- 4. Create the result pack ----------
  section('Location: create result pack');
  const result = locPack.createResultPack(leid);
  ok(result.ok, 'result pack created');
  if (!result.ok) { console.log(JSON.stringify(result)); process.exit(1); }
  const resultPack = result.pack;

  // ---------- 5. Main coordinator verifies + compiles ----------
  section('Main coordinator: verify + compile result pack');
  const report = locationPack.verifyResultPack(resultPack);
  ok(report.ok, 'result pack verifies: ' + JSON.stringify(report.summary));
  if (!report.ok) console.log(JSON.stringify(report, null, 2));

  const agg = locationPack.compileResult([{ payload: resultPack.payload }]);
  ok(agg.ok, 'compile ok, votes=' + agg.votes);
  const aliceRow = (agg.tally || []).find((t) => t.candidate === 'Alice');
  ok(aliceRow && aliceRow.count === 2, 'Alice tally = 2 (got ' + (aliceRow && aliceRow.count) + ')');

  section('RESULT');
  console.log('pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
