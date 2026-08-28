const db = require('./db');
const election = require('./election');

// Compute a professional results report for an election, mirroring the web
// app's results.html. Owner-scoped: coordinators may only view results for
// elections they own; admins may view all.
//
// Returns:
//   { ok, election:{...}, status, effectivelyClosed, totalVotes,
//     categories:[{ id, name, votes, candidates:[{ id, name, votes,
//       percentage, photo }], topVotes }], winner, tie, stats:{votes,candidates,categories},
//     stations:[...], countsByStation }
function buildReport(electionRow, { stationId } = {}) {
  const d = db.get();
  const status = election.computedStatus(electionRow);
  const end = Number(electionRow.end_date) || 0;
  const now = Date.now();
  const effectivelyClosed = status === 'closed' || (end > 0 && now >= end);

  const positions = d.prepare('SELECT * FROM positions WHERE election_id = ? ORDER BY title').all(electionRow.id);
  const posById = new Map(positions.map((p) => [p.id, p]));
  const candidates = d.prepare('SELECT * FROM candidates WHERE election_id = ? ORDER BY sort_order').all(electionRow.id);

  let rows = stationId
    ? d.prepare('SELECT candidate_id, position_id, COUNT(*) AS n FROM votes WHERE election_id = ? AND station_id = ? GROUP BY candidate_id, position_id').all(electionRow.id, stationId)
    : d.prepare('SELECT candidate_id, position_id, COUNT(*) AS n FROM votes WHERE election_id = ? GROUP BY candidate_id, position_id').all(electionRow.id);
  const countByCand = new Map();
  for (const r of rows) countByCand.set(r.candidate_id, r.n);

  let totalVotes = 0;
  const categories = [];
  const catById = new Map();

  for (const p of positions) {
    const list = candidates
      .filter((c) => c.position_id === p.id)
      .map((c) => {
        const votes = countByCand.get(c.id) || 0;
        return { id: c.id, name: c.name, photo_path: c.photo_path || null, votes };
      })
      .sort((a, b) => b.votes - a.votes);
    const catVotes = list.reduce((s, c) => s + c.votes, 0);
    totalVotes += catVotes;
    const cat = {
      id: p.id,
      name: p.title,
      votes: catVotes,
      topVotes: list.length ? list[0].votes : 0,
      candidates: list,
    };
    categories.push(cat);
    catById.set(p.id, cat);
  }

  categories.sort((a, b) => b.votes - a.votes);

  // Percentages per category and overall.
  const allCandidates = [];
  for (const cat of categories) {
    for (const c of cat.candidates) {
      c.catId = cat.name;
      c.percentage = cat.votes > 0 ? Number(((c.votes / cat.votes) * 100).toFixed(1)) : 0;
      c.overallPct = totalVotes > 0 ? Number(((c.votes / totalVotes) * 100).toFixed(1)) : 0;
      allCandidates.push(c);
    }
  }
  allCandidates.sort((a, b) => b.votes - a.votes);

  // ---- Per-category winners (each category's top candidate(s)) ----
  const categoryWinners = categories.map((cat) => {
    const top = cat.candidates.filter((c) => c.votes > 0);
    if (!top.length) return { id: cat.id, name: cat.name, mode: 'none', votes: 0 };
    const maxV = top[0].votes;
    const leaders = top.filter((c) => c.votes === maxV);
    if (leaders.length > 1) {
      return {
        id: cat.id, name: cat.name, mode: 'tie',
        names: leaders.map((c) => c.name), votes: maxV,
      };
    }
    return {
      id: cat.id, name: cat.name, mode: 'win', votes: maxV,
      winner: { id: leaders[0].id, name: leaders[0].name, votes: maxV, percentage: leaders[0].percentage },
    };
  });

  // Overall winner/tie: candidate with the most votes overall (only published
  // once effectively closed). Note: true "winner of the election" across
  // separate categories is conveyed by the per-category winners; overall is a
  // headline of the single candidate with the most votes.
  const overallTop = allCandidates.length ? allCandidates[0] : null;
  const overallTop2 = allCandidates.length >= 2 ? allCandidates[1] : null;
  let winner = null;
  let tie = null;
  if (overallTop && totalVotes > 0 && effectivelyClosed) {
    const overTie = overallTop2 && overallTop2.votes === overallTop.votes;
    if (overTie) {
      tie = { type: 'tie', name: `${overallTop.name} & ${overallTop2.name}`, votes: overallTop.votes };
    } else {
      winner = { id: overallTop.id, name: overallTop.name, votes: overallTop.votes, percentage: overallTop.overallPct, catName: overallTop.catId };
    }
  }

  // ---- Voter turnout ----
  // Overall: distinct voters who cast at least one ballot.
  const registered = d.prepare('SELECT COUNT(*) n FROM voters WHERE election_id = ?').get(electionRow.id).n;
  const castVoters = (d.prepare('SELECT COUNT(DISTINCT voter_id) n FROM votes WHERE election_id = ?').get(electionRow.id) || { n: 0 }).n;
  const turnoutPct = registered > 0 ? Number(((castVoters / registered) * 100).toFixed(1)) : 0;
  const turnout = { registered, cast: castVoters, turnoutPct };

  // ---- Stations + per-station breakdown (station-mode only) ----
  const stations = [];
  if (electionRow.type === 'station') {
    const stationRows = d.prepare('SELECT * FROM stations WHERE election_id = ? ORDER BY name').all(electionRow.id);
    const allVoters = d.prepare('SELECT * FROM voters WHERE election_id = ?').all(electionRow.id);
    for (const st of stationRows) {
      const keys = new Set([st.id, st.code, st.name].filter(Boolean).map((k) => String(k).toLowerCase()));
      const members = allVoters.filter((v) => {
        if (v.station_id && String(v.station_id) === st.id) return true;
        return keys.has(String(v.assigned_station || '').toLowerCase());
      });
      const sRegistered = members.length;
      const sCast = members.filter((v) => v.has_voted === 1 || v.ballot_cast === 1).length;
      stations.push({
        id: st.id,
        name: st.name,
        location: st.location || null,
        code: st.code || null,
        status: st.status,
        submitted: !!(st.final_submit_json) || st.status === 'submitted',
        registered: sRegistered,
        cast: sCast,
        turnoutPct: sRegistered > 0 ? Number(((sCast / sRegistered) * 100).toFixed(1)) : 0,
      });
    }
  }

  return {
    ok: true,
    election: {
      id: electionRow.id,
      title: electionRow.title,
      type: electionRow.type,
      status,
      start_date: electionRow.start_date,
      end_date: electionRow.end_date,
    },
    status,
    effectivelyClosed,
    totalVotes,
    categories,
    winner,
    tie,
    categoryWinners,
    turnout,
    stats: { votes: totalVotes, candidates: candidates.length, categories: categories.length },
    stations,
    currentStationId: stationId || null,
  };
}

module.exports = {
  buildReport,
};
