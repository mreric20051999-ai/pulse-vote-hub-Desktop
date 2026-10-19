// Merge algorithm (renderer/js/merge-core.js) — pure UMD module.
const MergeCore = require('../renderer/js/merge-core.js');
const { check, eq, ok, report } = require('./helpers');

function snap(title, positions, candidates, voters, votes) {
  return { election: { title, type: 'school', start_date: null, end_date: null }, positions, candidates, voters, votes };
}

const fileA = snap('Mayor 2026',
  [{ id: 'pA', title: 'Mayor' }],
  [{ id: 'cA1', position_id: 'pA', name: 'Alice' }, { id: 'cA2', position_id: 'pA', name: 'Bob' }],
  [{ voter_id: 'V1', name: 'One', assigned_station: 'North' }, { voter_id: 'V2', name: 'Two' }],
  [{ voter_id: 'V1', position_id: 'pA', candidate_id: 'cA1', timestamp: 2000 }]);

const fileB = snap('mayor   2026',
  [{ id: 'pB', title: 'MAYOR' }],
  [{ id: 'cB1', position_id: 'pB', name: 'alice' }, { id: 'cB2', position_id: 'pB', name: 'Carol' }],
  [{ voter_id: 'v2', name: 'Two', assigned_station: 'South' }, { voter_id: 'V1', name: 'One' }],
  [{ voter_id: 'V1', position_id: 'pB', candidate_id: 'cB2', timestamp: 1000 },
   { voter_id: 'V2', position_id: 'pB', candidate_id: 'cB1', timestamp: 3000 }]);

const work = MergeCore.buildWork([fileA, fileB]);

check('positions/candidates unify by normalized name', () => {
  eq(work.positions.map((p) => p.title), ['Mayor']);
  eq(work.candidates.map((c) => c.name).sort(), ['Alice', 'Bob', 'Carol']);
  eq(work.election.title, 'Mayor 2026');
});

check('duplicate voter detected across files, double-vote flagged', () => {
  eq(work.duplicates.length, 2, 'V1 and V2 both registered in two files');
  const v1 = work.duplicates.find((d) => d.vid === 'V1');
  ok(v1, 'V1 present');
  eq(v1.dbl, true, 'V1 voted in both files');
  eq(v1.ballotFiles, [0, 1]);
  const v2 = work.duplicates.find((d) => d.vid === 'V2');
  eq(v2.dbl, false, 'V2 voted once');
});

check('defaultResolutions keeps each double voter\'s earliest ballot', () => {
  const res = MergeCore.defaultResolutions(work);
  eq(res.V1, 1, 'V1 has earlier timestamp in file B');
  eq(res.V2, 1, 'V2 only voted in file B');
});

check('tally counts only kept ballots and dedupes voters', () => {
  const res = MergeCore.defaultResolutions(work);
  const tally = MergeCore.applicationTally(work, res);
  eq(tally.registered, 2, 'two unique voters');
  eq(tally.cast, 2);
  eq(tally.votesCast, 2, 'V1 ballot from file A discarded');
  eq(tally.candVotes.get('mayor|alice'), 1, 'V2 -> Alice');
  eq(tally.candVotes.get('mayor|carol'), 1, 'V1 -> Carol');
  eq(tally.candVotes.get('mayor|bob') || 0, 0);
});

check('buildReport produces totals, categories and a winner', () => {
  const res = MergeCore.defaultResolutions(work);
  const r = MergeCore.buildReport(work, res);
  ok(r.ok, 'report ok');
  eq(r.totalVotes, 2);
  eq(r.registered, 2);
  eq(r.cast, 2);
  eq(r.turnoutPct, 100);
  eq(r.filesCount, 2);
  eq(r.doubleCount, 1);
  eq(r.categories.length, 1);
  eq(r.categories[0].name, 'Mayor');
  eq(r.categories[0].candidates.find((c) => c.name === 'Alice').votes, 1);
  ok(r.tie, 'Alice and Carol tie at 1 vote');
});

check('_exclude removes a voter entirely', () => {
  const res = MergeCore.defaultResolutions(work);
  res.V1 = '_exclude';
  const tally = MergeCore.applicationTally(work, res);
  eq(tally.registered, 1);
  eq(tally.votesCast, 1);
  ok(!tally.candVotes.get('mayor|carol'), 'excluded voter\'s ballot not counted');
});

check('buildSnapshotExport emits the merged artifact', () => {
  const res = MergeCore.defaultResolutions(work);
  const out = MergeCore.buildSnapshotExport(work, res, ['a.json', 'b.json'], [{ exported_at: 1, title: 'A', type: 'school' }]);
  eq(out.schema, 'pulse-vote-hub-merged-election');
  eq(out.counts, { registered: 2, cast: 2, votes: 2 });
  eq(out.ballots.length, 2);
  eq(out.sources.length, 2);
  eq(out.duplicates.length, 2);
});

report('merge-core.test.js');
