// Ballot number assignment rules (the "refill freed ballot numbers" fix).
const h = require('./helpers');
const election = require('../electron/election');
const voter = require('../electron/voter');
const { check, eq, ok, report } = h;

const actor = { id: 'admin-1', role: 'admin' };

const created = election.createElection({ title: 'Ballot test', type: 'school' }, actor);
ok(created.ok, 'createElection must succeed');
const eid = created.election.id;

const pos = election.addPosition(eid, 'President', 1, actor);
ok(pos.ok, 'addPosition must succeed');
const pid = pos.position.id;

function add(name, number) {
  const payload = { electionId: eid, positionId: pid, name };
  if (number !== undefined) payload.ballot_number = number;
  const r = election.addCandidate(payload, actor);
  ok(r.ok, `addCandidate(${name}) must succeed: ${r.error || ''}`);
  return r.candidate;
}

function numbers() {
  return election.listCandidates(eid, actor).map((c) => c.ballot_number).sort((a, b) => a - b);
}

check('auto numbering starts at 1 and increments', () => {
  eq(add('Alice').ballot_number, 1);
  eq(add('Bob').ballot_number, 2);
  eq(add('Carol').ballot_number, 3);
  eq(numbers(), [1, 2, 3]);
});

check('explicit number bumps candidates >= that number', () => {
  const d = add('Dave', 2);
  eq(d.ballot_number, 2);
  const list = election.listCandidates(eid, actor);
  const bob = list.find((c) => c.name === 'Bob');
  eq(bob.ballot_number, 3, 'old #2 shifted to 3');
});

check('lowest free number is refilled after removal', () => {
  const list = election.listCandidates(eid, actor);
  const alice = list.find((c) => c.name === 'Alice');
  const r = election.removeCandidate(alice.id, actor);
  ok(r.ok, 'removeCandidate must succeed');
  const next = add('Erin');
  eq(next.ballot_number, 1, 'freed #1 must be reused by the next auto-assign');
});

check('explicit number within limits is accepted', () => {
  const f = add('Frank', 9999);
  eq(f.ballot_number, 9999);
});

check('voter add + verify-details flows against the same election', () => {
  const v = voter.addVoter({ electionId: eid, voterId: 'V-TEST', name: 'Test Voter' });
  ok(v.ok, 'addVoter must succeed');
  const res = voter.verifyVoterDetails(eid, { voterId: 'V-TEST', name: 'Test Voter' });
  ok(res.ok, 'verifyDetails must match');
  ok(res.voter.password, 'recovery reveals the password by default (help desk)');
  const kiosk = voter.verifyVoterDetails(eid, { voterId: 'V-TEST', name: 'Test Voter', revealPassword: false });
  ok(kiosk.ok, 'kiosk lookup must match');
  eq(kiosk.voter.password ?? null, null, 'revealPassword:false returns no password');
});

report('ballot-rules.test.js');
