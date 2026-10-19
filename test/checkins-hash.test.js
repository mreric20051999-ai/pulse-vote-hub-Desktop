// Check-in integrity hashing (gap #4): hashes written at every existing
// check-in write path, NULL hashes tolerated as "pre-hash", tampering fails.
const h = require('./helpers');
const election = require('../electron/election');
const voter = require('../electron/voter');
const sync = require('../electron/lan/sync');
const integrity = require('../electron/integrity');
const { db, check, eq, ok, report } = h;

const actor = { id: 'admin-1', role: 'admin' };

const created = election.createElection({ title: 'Hash test', type: 'school' }, actor);
ok(created.ok, 'createElection must succeed');
const eid = created.election.id;

const pos = election.addPosition(eid, 'President', 1, actor);
election.addCandidate({ electionId: eid, positionId: pos.position.id, name: 'A' }, actor);

voter.addVoter({ electionId: eid, voterId: 'V1', name: 'One' });
voter.addVoter({ electionId: eid, voterId: 'V2', name: 'Two' });
voter.addVoter({ electionId: eid, voterId: 'V3', name: 'Three' });

const d = db.get();

check('checkinHash is deterministic and salted by all inputs', () => {
  const a = integrity.checkinHash(eid, 'V1', 'o1', 'd1', 1000);
  const b = integrity.checkinHash(eid, 'V1', 'o1', 'd1', 1000);
  eq(a, b, 'same inputs => same hash');
  eq(a.length, 64, 'sha256 hex length');
  ok(integrity.checkinHash(eid, 'V1', 'o1', 'd1', 1001) !== a, 'timestamp changes hash');
  ok(integrity.checkinHash(eid, 'V1', 'o2', 'd1', 1000) !== a, 'officer changes hash');
  ok(integrity.checkinHash(eid, 'V9', 'o1', 'd1', 1000) !== a, 'voter changes hash');
});

check('applyRemoteCheckin (peer/standalone insert path) writes a hash', () => {
  const r = sync.applyRemoteCheckin(d, {
    election_id: eid, voter_id: 'V1', officer_id: 'off-9', device_id: 'dev-1', timestamp: 5000,
  });
  ok(r === true, 'applyRemoteCheckin must succeed');
  const row = d.prepare('SELECT * FROM checkins WHERE election_id = ? AND voter_id = ?').get(eid, 'V1');
  ok(row, 'check-in row inserted');
  ok(row.hash, 'hash written on insert');
  eq(row.hash, integrity.checkinHash(eid, 'V1', 'off-9', 'dev-1', 5000),
    'stored hash matches recomputed hash');
});

check('applyRemoteCheckin update path recomputes the hash', () => {
  const r = sync.applyRemoteCheckin(d, {
    election_id: eid, voter_id: 'V1', officer_id: 'off-9', device_id: 'dev-1', timestamp: 6000,
  });
  ok(r === true, 'second apply (update) must succeed');
  const row = d.prepare('SELECT * FROM checkins WHERE election_id = ? AND voter_id = ?').get(eid, 'V1');
  eq(row.timestamp, 6000, 'timestamp updated');
  eq(row.hash, integrity.checkinHash(eid, 'V1', 'off-9', 'dev-1', 6000),
    'hash recomputed for the update path');
});

check('recordRemoteCheckin (hub insert path) writes a hash', () => {
  const r = sync.recordRemoteCheckin(d, eid, { voter_id: 'V2', officer_name: 'Desk', device_id: 'dev-2' });
  ok(r && r.ok, `recordRemoteCheckin must succeed: ${r && r.reason}`);
  const row = d.prepare('SELECT * FROM checkins WHERE election_id = ? AND voter_id = ?').get(eid, 'V2');
  ok(row, 'check-in row inserted');
  eq(row.hash, integrity.checkinHash(eid, 'V2', null, 'dev-2', row.timestamp),
    'stored hash matches recomputed hash (officer_id is null on this path)');
});

check('verifyCheckins passes an intact table', () => {
  const r = integrity.verifyCheckins(d);
  ok(r.ok, `expected ok, got ${r.reason || ''}`);
  ok(r.hashed >= 1, 'at least one hashed row verified');
});

check('tampered check-in row fails with hash-mismatch', () => {
  const row = d.prepare('SELECT * FROM checkins WHERE election_id = ? AND voter_id = ?').get(eid, 'V1');
  d.prepare('UPDATE checkins SET timestamp = timestamp + 7 WHERE id = ?').run(row.id);
  const r = integrity.verifyCheckins(d);
  eq(r.ok, false, 'tamper must fail verification');
  eq(r.reason, 'hash-mismatch');
  d.prepare('UPDATE checkins SET timestamp = ? WHERE id = ?').run(row.timestamp, row.id);
});

check('NULL hash rows count as unhashed, not failures', () => {
  const row = d.prepare('SELECT * FROM checkins WHERE election_id = ? AND voter_id = ?').get(eid, 'V1');
  d.prepare('UPDATE checkins SET hash = NULL WHERE id = ?').run(row.id);
  const r = integrity.verifyCheckins(d);
  ok(r.ok, 'legacy (pre-hash) rows must not fail verification');
  ok(r.unhashed >= 1, 'unhashed count reported');
  d.prepare('UPDATE checkins SET hash = ? WHERE id = ?').run(row.hash, row.id);
});

check('verifyAll includes the checkins result', () => {
  const all = integrity.verifyAll();
  ok(all.checkins, 'verifyAll must include checkins');
  ok(all.checkins.ok, 'checkins must pass within verifyAll');
});

report('checkins-hash.test.js');
