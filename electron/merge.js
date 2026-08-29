// Snapshot validation + per-file summaries for the Multi-Location Merge tool.
//
// Election exports (backup:election) carry this shape:
//   {
//     schema: 'pulse-vote-hub-election', schema_version: 1,
//     exported_at, exporter,
//     election: { id, title, type, status, start_date, end_date, ... },
//     positions: [ { id, title, max_votes } ],
//     candidates: [ { id, position_id, name, ballot_number, sort_order } ],
//     voters:   [ { voter_id, name, assigned_station, has_voted, ballot_cast } ],
//     votes:    [ { position_id, candidate_id, voter_id, station_id, timestamp } ]
//   }
// Legacy exports (pre-Phase-10) only carried `{ exported_at, exporter, election }`
// and are accepted but flagged as "config only".

function norm(str) {
  return String(str || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Structural validation. `ok:false` means the file cannot take part in a merge;
// `warns` are worth knowing but do not block.
function validateSnapshot(s) {
  const errors = [];
  const warns = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return { ok: false, errors: ['File is not a JSON snapshot object'], warns: [] };
  }
  if (typeof s.schema === 'string' && s.schema !== 'pulse-vote-hub-election') {
    errors.push(`Unrecognized snapshot schema "${s.schema}"`);
  }
  const e = s.election;
  if (!e || typeof e !== 'object') {
    errors.push('Missing election metadata');
  } else {
    if (!e.title || !String(e.title).trim()) errors.push('Election has no title');
    if (e.type && !['school', 'station'].includes(e.type)) {
      warns.push(`Unknown election type "${e.type}"`);
    }
  }
  const positions = Array.isArray(s.positions) ? s.positions : [];
  const candidates = Array.isArray(s.candidates) ? s.candidates : (Array.isArray(s.election && s.election.positions) ? [] : []);
  const voters = Array.isArray(s.voters) ? s.voters : [];
  const votes = Array.isArray(s.votes) ? s.votes : [];
  if (!positions.length) warns.push('No positions in this snapshot');
  if (!candidates.length) warns.push('No candidates in this snapshot');
  if (!voters.length) warns.push('No voters in this snapshot');
  if (!votes.length) warns.push('No ballot data — this snapshot contributes no votes');
  if (s.schema === undefined && !Array.isArray(s.voters) && !Array.isArray(s.votes)) {
    warns.push('Legacy snapshot (metadata only) — try re-exporting the election');
  }
  return { ok: errors.length === 0, errors, warns };
}

// Light per-file counts used to render the file list before merging.
function summarize(s) {
  const e = (s && s.election) || {};
  const positions = Array.isArray(s.positions) ? s.positions : [];
  const candidates = Array.isArray(s.candidates) ? s.candidates : [];
  const voters = Array.isArray(s.voters) ? s.voters : [];
  const votes = Array.isArray(s.votes) ? s.votes : [];
  return {
    title: e.title || 'Untitled election',
    type: e.type || null,
    status: e.status || null,
    exportedAt: s.exported_at || null,
    positions: positions.length,
    candidates: candidates.length,
    registered: voters.filter((v) => v && v.voter_id).length,
    cast: voters.filter((v) => v && (v.has_voted === 1 || v.has_voted === true || v.ballot_cast === 1)).length,
    votes: votes.length,
  };
}

module.exports = {
  normalizeKey: norm,
  validateSnapshot,
  summarize,
};