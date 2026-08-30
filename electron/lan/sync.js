// LAN sync data layer: every read/write the hub and peer do against SQLite.
// All functions take a `d` (better-sqlite3 handle) instead of importing ./db,
// so the whole layer is testable under plain Node.
//
// Cross-device identity: every device provisions its own UUIDs, so peer events
// carry *symbolic* references (position title + candidate name) and each device
// resolves them against its own ids. Voters are keyed by (election_id, voter_id).
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const sig = require('../signature');

// ---------- device identity ----------

function deviceIdOf(d) {
  const row = d.prepare("SELECT value FROM config WHERE key = 'device_id'").get();
  if (row) return row.value;
  const id = 'dev-' + crypto.randomBytes(6).toString('hex');
  d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('device_id', ?)").run(id);
  return id;
}

function setDeviceName(d, name) {
  d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('dev_name', ?)").run(String(name || 'Pulse Device'));
}

function deviceNameOf(d) {
  const row = d.prepare("SELECT value FROM config WHERE key = 'dev_name'").get();
  return (row && row.value) || 'Pulse Device';
}

// ---------- symbolic id resolution ----------

// Resolve a position by title within an election. Returns { id, title } or null.
function resolvePosition(d, electionId, title) {
  return d.prepare('SELECT id, title FROM positions WHERE election_id = ? AND LOWER(title) = LOWER(?)')
    .get(electionId, String(title || '').trim()) || null;
}

// Resolve a candidate by name within a position inside an election.
function resolveCandidate(d, electionId, positionTitle, candidateName) {
  const pos = resolvePosition(d, electionId, positionTitle);
  if (!pos) return null;
  return d.prepare(
    'SELECT id, position_id, name FROM candidates WHERE election_id = ? AND position_id = ? AND LOWER(name) = LOWER(?)'
  ).get(electionId, pos.id, String(candidateName || '').trim()) || null;
}

// Turn local candidate/position ids into their symbolic labels.
function labelSelection(d, electionId, positionId, candidateId) {
  const pos = d.prepare('SELECT title FROM positions WHERE id = ? AND election_id = ?').get(positionId, electionId);
  if (!pos) return null;
  const cand = d.prepare('SELECT name FROM candidates WHERE id = ? AND election_id = ?').get(candidateId, electionId);
  if (!cand) return null;
  return { position_title: pos.title, candidate_name: cand.name };
}

function voterByVid(d, electionId, voterId) {
  return d.prepare('SELECT * FROM voters WHERE election_id = ? AND voter_id = ?')
    .get(electionId, String(voterId || '').trim().toUpperCase()) || null;
}

// ---------- hub-side station resolution (mirrors station.js) ----------
// Kept in sync.js so the LAN layer stays dependency-free under plain Node.

function stationRowsFor(d, electionId) {
  return d.prepare('SELECT * FROM stations WHERE election_id = ?').all(electionId);
}
function stationRefMatch(s, ref) {
  const label = String(ref || '').trim().toLowerCase();
  return !!label && [s.id, s.code, s.name].filter(Boolean).some((k) => String(k).toLowerCase() === label);
}
// The station a voter is registered to (by station_id or assigned_station label).
function stationForVoter(d, electionId, voterRow) {
  const rows = stationRowsFor(d, electionId);
  if (voterRow.station_id) {
    const byId = rows.find((s) => s.id === voterRow.station_id);
    if (byId) return byId;
  }
  if (!voterRow.assigned_station) return null;
  return rows.find((s) => stationRefMatch(s, voterRow.assigned_station)) || null;
}
function stationResolveRef(d, electionId, ref) {
  return stationRowsFor(d, electionId).find((s) => stationRefMatch(s, ref)) || null;
}
function stationEffective(s, now = Date.now()) {
  if (!s) return 'not_opened';
  if (s.status === 'queuing' && s.grace_ends_at && Number(s.grace_ends_at) <= now) return 'counted';
  return s.status || 'not_opened';
}
function isStationOpen(s) { const x = stationEffective(s); return x === 'open' || x === 'queuing'; }

// ---------- offline queue (lan_queue) ----------

function enqueue(d, type, payload) {
  d.prepare(
    'INSERT INTO lan_queue (type, payload, created_at) VALUES (?, ?, ?)'
  ).run(type, JSON.stringify(payload), Date.now());
}

function listQueue(d) {
  return d.prepare('SELECT id, type, payload FROM lan_queue ORDER BY id').all()
    .map((r) => Object.assign({ _rowId: r.id, id: r.id, type: r.type }, JSON.parse(r.payload)));
}

function dequeue(d, id) {
  d.prepare('DELETE FROM lan_queue WHERE id = ?').run(id);
}

function clearQueue(d) {
  d.prepare('DELETE FROM lan_queue').run();
}

// ---------- vote write (shared hash-chain shape, mirrors voter.castVote) ----------

function writeVoteRows(d, electionId, voterRow, selections) {
  // selections: [{ position_id, candidate_id, timestamp }] already validated.
  const now = Date.now();
  let prev = d.prepare('SELECT vote_hash FROM votes ORDER BY id DESC LIMIT 1').get();
  let prevHash = prev ? prev.vote_hash : null;
  for (const sel of selections) {
    const raw = `${electionId}|${sel.candidate_id}|${voterRow.voter_id}|${scrubTs(sel.timestamp, now)}`;
    const voteHash = crypto.createHash('sha256').update(raw).digest('hex');
    d.prepare(`
      INSERT INTO votes (election_id, position_id, candidate_id, voter_id, device_id, station_id, timestamp, prev_hash, vote_hash, signature, synced)
      VALUES (@election_id, @position_id, @candidate_id, @voter_id, @device_id, @station_id, @timestamp, @prev_hash, @vote_hash, @signature, 1)
    `).run({
      election_id: electionId,
      position_id: sel.position_id,
      candidate_id: sel.candidate_id,
      voter_id: voterRow.voter_id,
      device_id: sel.device_id || null,
      station_id: sel.station_id || null,
      timestamp: scrubbedNow(sel.timestamp),
      prev_hash: prevHash,
      vote_hash: voteHash,
      signature: sig.signRaw(d, raw),
    });
    prevHash = voteHash;
  }
  const positions = d.prepare('SELECT id, title FROM positions WHERE election_id = ?').all(electionId);
  const titleById = new Map(positions.map((p) => [p.id, p.title]));
  const label = [...new Set(selections.map((s) => titleById.get(s.position_id) || ''))].filter(Boolean).join(', ');
  d.prepare('UPDATE voters SET has_voted = 1, voted_at = ?, position_voted = ?, ballot_cast = 1, grace_period = 0 WHERE id = ?')
    .run(Date.now(), label || null, voterRow.id);
}

function scrubTs(ts, now) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? n : now;
}
function scrubbedNow(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

// ---------- HUB side: validate + record a remote event against local DB ----------

// A voter's ballot arrives from a peer as symbolic selections. Validated and
// written here the same way the kiosk path writes it.
function recordRemoteVote(d, electionId, payload) {
  const { voter_id: voterId, device_id: deviceId, selections = [], station: stationRef } = payload || {};
  const election = d.prepare('SELECT id, type, status, start_date, end_date FROM elections WHERE id = ?').get(electionId);
  if (!election) return { ok: false, code: 'no-election', reason: 'Election not found on this device' };
  if (effectiveStatus(election) !== 'active') {
    return { ok: false, code: 'not-open', reason: 'This election is not open for voting' };
  }
  const voterRow = voterByVid(d, electionId, voterId);
  if (!voterRow) return { ok: false, code: 'not-found', reason: 'Voter not in register on this device' };
  if (voterRow.has_voted) return { ok: false, code: 'already-voted', reason: 'Voter already voted on at least one device' };
  if (!selections.length) return { ok: false, code: 'empty', reason: 'No selections provided' };

  // Station elections mirror castVote: the ballot must carry the voter's own
  // station, that station must be open/queuing here, and the voter must already
  // be checked in so nobody can vote straight off the street at any station.
  let stationId = null;
  if (election.type === 'station') {
    const st = stationForVoter(d, electionId, voterRow);
    if (!st) return { ok: false, code: 'no-station', reason: 'Voter is not assigned to a polling station on this device' };
    if (!stationRef) return { ok: false, code: 'no-station', reason: 'Ballot must be opened for a specific polling station' };
    const ctx = stationResolveRef(d, electionId, stationRef);
    if (!ctx || ctx.id !== st.id) return { ok: false, code: 'wrong-station', reason: 'Voter registered to a different station' };
    if (!isStationOpen(st)) return { ok: false, code: 'station-not-open', reason: 'Polls at this station are not accepting ballots' };
    if (!voterRow.checked_in) return { ok: false, code: 'not-checked-in', reason: 'Voter must be checked in before casting' };
    stationId = st.id;
  }

  const resolved = [];
  const posMax = new Map(
    d.prepare('SELECT id, max_votes FROM positions WHERE election_id = ?').all(electionId)
      .map((p) => [p.id, Math.max(1, Number(p.max_votes) || 1)])
  );
  const perPosition = new Map();
  const tx = d.transaction(() => {
    for (const sel of selections) {
      const cand = resolveCandidate(d, electionId, sel.position_title, sel.candidate_name);
      if (!cand) {
        return { ok: false, code: 'invalid', reason: `Unknown candidate "${sel.candidate_name}" for "${sel.position_title}"` };
      }
      const limit = posMax.get(cand.position_id) || 1;
      const n = (perPosition.get(cand.position_id) || 0) + 1;
      perPosition.set(cand.position_id, n);
      if (n > limit) {
        return { ok: false, code: 'max-selections', reason: `Position allows at most ${limit} selection${limit === 1 ? '' : 's'}` };
      }
      resolved.push({ position_id: cand.position_id, candidate_id: cand.id, timestamp: sel.timestamp, device_id: deviceId, station_id: stationId });
    }
    writeVoteRows(d, electionId, voterRow, resolved);
    return { ok: true };
  });
  const out = tx();
  if (!out.ok) return out;
  return {
    ok: true,
    ref: { election_id: electionId, voter_id: voterRow.voter_id },
    votes: resolved.map(() => ({ position_title: null, candidate_name: null })), // filled by caller via labels
  };
}

// Check-in event from a peer: update flags + append the audit-style row. For
// station elections the voter must belong to the reporting station (when it is
// provided) and that station must be open, mirroring the desktop check-in.
function recordRemoteCheckin(d, electionId, payload) {
  const { voter_id: voterId, officer_name: officerName, device_id: deviceId, station } = payload || {};
  const v = voterByVid(d, electionId, voterId);
  if (!v) return { ok: false, code: 'not-found', reason: 'Voter not in register on this device' };
  const election = d.prepare('SELECT type FROM elections WHERE id = ?').get(electionId);
  if (election && election.type === 'station') {
    const st = stationForVoter(d, electionId, v);
    if (!st) return { ok: false, code: 'no-station', reason: 'Voter is not assigned to a polling station' };
    if (!isStationOpen(st)) return { ok: false, code: 'station-not-open', reason: 'Polls at this station are not open' };
    if (station) {
      const ctx = stationResolveRef(d, electionId, station);
      if (!ctx || ctx.id !== st.id) return { ok: false, code: 'wrong-station', reason: 'Voter registered to a different station' };
    }
  }
  if (v.ballot_cast) return { ok: false, code: 'already-voted', reason: 'This voter already cast their ballot' };
  if (v.checked_in) return { ok: false, code: 'already-checked-in', reason: 'This voter is already checked in' };
  const now = Date.now();
  d.transaction(() => {
    d.prepare('UPDATE voters SET checked_in = 1, checked_in_at = ?, checked_in_by = ? WHERE id = ?')
      .run(now, officerName || 'Officer', v.id);
    d.prepare(`
      INSERT INTO checkins (election_id, voter_id, officer_id, device_id, timestamp, synced)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(electionId, v.voter_id, null, deviceId || null, now);
  })();
  return { ok: true, ref: { election_id: electionId, voter_id: v.voter_id } };
}

// Admin unvote propagated from a peer.
function recordRemoteUnvote(d, electionId, payload) {
  const { voter_id: voterId } = payload || {};
  const v = voterByVid(d, electionId, voterId);
  if (!v) return { ok: false, code: 'not-found', reason: 'Voter not found' };
  d.transaction(() => {
    d.prepare('UPDATE voters SET has_voted = 0, voted_at = NULL, position_voted = NULL, ballot_cast = 0 WHERE id = ?').run(v.id);
    d.prepare('DELETE FROM votes WHERE election_id = ? AND voter_id = ?').run(electionId, v.voter_id);
  })();
  return { ok: true, ref: { election_id: electionId, voter_id: v.voter_id } };
}

// ---------- CLIENT side: apply hub-authoritative events to local DB ----------

function applyRemoteVote(d, row) {
  const electionId = row.election_id;
  const voterRow = voterByVid(d, electionId, row.voter_id);
  if (!voterRow) return false;
  const cand = resolveCandidate(d, electionId, row.position_title, row.candidate_name);
  if (!cand) return false;
  // Re-store the station under THIS device's own station ids: the hub's
  // station id is only meaningful on the hub, but the label travels everywhere.
  let stationIdLocal = row.station_id || null;
  if (row.station) {
    const st = stationResolveRef(d, electionId, row.station);
    if (st) stationIdLocal = st.id;
  }
  const existing = d.prepare(
    'SELECT id FROM votes WHERE election_id = ? AND voter_id = ? AND position_id = ?'
  ).get(electionId, voterRow.voter_id, cand.position_id);
  const now = scrubbedNow(row.timestamp);
  if (existing) {
    const raw2 = `${electionId}|${cand.id}|${voterRow.voter_id}|${now}`;
    d.prepare(`
      UPDATE votes SET candidate_id = ?, device_id = ?, station_id = ?, timestamp = ?, signature = ?, synced = 1 WHERE id = ?
    `).run(cand.id, row.device_id || null, stationIdLocal, now, sig.signRaw(d, raw2), existing.id);
  } else {
    const raw = `${electionId}|${cand.id}|${voterRow.voter_id}|${now}`;
    const voteHash = crypto.createHash('sha256').update(raw).digest('hex');
    let prev = d.prepare('SELECT vote_hash FROM votes ORDER BY id DESC LIMIT 1').get();
    d.prepare(`
      INSERT INTO votes (election_id, position_id, candidate_id, voter_id, device_id, station_id, timestamp, prev_hash, vote_hash, signature, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(electionId, cand.position_id, cand.id, voterRow.voter_id, row.device_id || null, stationIdLocal, now, prev ? prev.vote_hash : null, voteHash, sig.signRaw(d, raw));
  }
  const label = row.candidate_name || cand.name;
  d.prepare('UPDATE voters SET has_voted = 1, voted_at = ?, position_voted = ?, ballot_cast = 1 WHERE id = ?')
    .run(now, label, voterRow.id);
  return true;
}

function applyRemoteCheckin(d, row) {
  const v = voterByVid(d, row.election_id, row.voter_id);
  if (!v) return false;
  d.transaction(() => {
    d.prepare('UPDATE voters SET checked_in = 1, checked_in_at = ?, checked_in_by = ? WHERE id = ?')
      .run(scrubbedNow(row.timestamp), row.officer_name || 'Officer', v.id);
    const hit = d.prepare('SELECT id FROM checkins WHERE election_id = ? AND voter_id = ?').get(row.election_id, v.voter_id);
    if (hit) {
      d.prepare('UPDATE checkins SET officer_id = ?, device_id = ?, timestamp = ?, synced = 1 WHERE id = ?')
        .run(row.officer_id || null, row.device_id || null, scrubbedNow(row.timestamp), hit.id);
    } else {
      d.prepare('INSERT INTO checkins (election_id, voter_id, officer_id, device_id, timestamp, synced) VALUES (?, ?, ?, ?, ?, 1)')
        .run(row.election_id, v.voter_id, row.officer_id || null, row.device_id || null, scrubbedNow(row.timestamp));
    }
  })();
  return true;
}

function applyRemoteUnvote(d, row) {
  const v = voterByVid(d, row.election_id, row.voter_id);
  if (!v) return false;
  d.transaction(() => {
    d.prepare('UPDATE voters SET has_voted = 0, voted_at = NULL, position_voted = NULL, ballot_cast = 0 WHERE id = ?').run(v.id);
    d.prepare('DELETE FROM votes WHERE election_id = ? AND voter_id = ?').run(row.election_id, v.voter_id);
  })();
  return true;
}

// Full hub-authoritative snapshot: reconcile the local DB to it. Deleting
// local unsynced rows enforces "server is source of truth": any vote the hub
// doesn't know about was rejected and is discarded.
function applySnapshot(d, snap) {
  for (const e of snap.elections || []) {
    const electionId = e.id;
    d.transaction(() => {
      for (const v of e.voters || []) {
        const local = voterByVid(d, electionId, v.voter_id);
        if (!local) continue;
        d.prepare(`
          UPDATE voters SET
            name = COALESCE(NULLIF(?, ''), name),
            checked_in = COALESCE(?, checked_in),
            checked_in_at = COALESCE(?, checked_in_at),
            checked_in_by = COALESCE(?, checked_in_by),
            ballot_cast = COALESCE(?, ballot_cast),
            grace_period = COALESCE(?, grace_period),
            has_voted = COALESCE(?, has_voted),
            voted_at = COALESCE(?, voted_at),
            position_voted = COALESCE(?, position_voted)
          WHERE id = ?
        `).run(
          v.name || '', v.checked_in, v.checked_in_at, v.checked_in_by,
          v.ballot_cast, v.grace_period, v.has_voted, v.voted_at, v.position_voted,
          local.id
        );
      }
      for (const row of e.votes || []) applyRemoteVote(d, row);
      for (const c of e.checkins || []) applyRemoteCheckin(d, c);
      // Remove local unsynced votes the hub didn't accept (rejected / stale).
      d.prepare('DELETE FROM votes WHERE election_id = ? AND synced = 0').run(electionId);
    })();
  }
  for (const m of snap.messages || []) recordRemoteMessage(d, m);
  return true;
}

// ---------- stats ----------

function unsyncedVoteCount(d) {
  // Only count votes still tied to an existing election; orphaned rows left
  // behind by deleted elections should not count as pending sync work.
  return d.prepare(`
    SELECT COUNT(*) AS c FROM votes v
    JOIN elections e ON e.id = v.election_id
    WHERE v.synced = 0
  `).get().c || 0;
}
function queueSize(d) {
  return d.prepare('SELECT COUNT(*) AS c FROM lan_queue').get().c || 0;
}
function voteCount(d) {
  return d.prepare('SELECT COUNT(*) AS c FROM votes').get().c || 0;
}
function hubCount(d) {
  return d.prepare('SELECT COUNT(*) AS c FROM checkins').get().c || 0;
}
function lastVoteAt(d) {
  const row = d.prepare('SELECT MAX(timestamp) AS t FROM votes').get();
  return row && row.t ? row.t : null;
}

function effectiveStatus(election) {
  const now = Date.now();
  let status = election.status;
  if (election.start_date && Number(election.start_date) > now && status === 'active') status = 'upcoming';
  if (election.end_date && Number(election.end_date) < now && status === 'active') status = 'closed';
  return status;
}

// ---------- in-app messaging sync (host ↔ client) ----------
//
// Messages are standalone rows keyed by their UUID, so they travel verbatim
// (no symbolic id remapping like votes). Officers are matched across machines
// by login id + name, not by machine-local internal ids.

function listMessagesSync(d) {
  return d.prepare(
    'SELECT id, from_officer_id, from_name, from_officer, to_officer, to_officer_name, reply_to_id, body, created_at, read FROM messages ORDER BY created_at ASC'
  ).all();
}

function recordRemoteMessage(d, rec) {
  if (!rec || !rec.id || !rec.body) return { ok: false, reason: 'missing fields' };
  const clean = {
    id: String(rec.id),
    from_officer_id: rec.from_officer_id ? String(rec.from_officer_id) : null,
    from_name: String(rec.from_name || ''),
    from_officer: rec.from_officer ? String(rec.from_officer) : null,
    to_officer: rec.to_officer ? String(rec.to_officer) : null,
    to_officer_name: rec.to_officer_name ? String(rec.to_officer_name) : null,
    reply_to_id: rec.reply_to_id ? String(rec.reply_to_id) : null,
    body: String(rec.body),
    created_at: Number(rec.created_at) || Date.now(),
    read: rec.read === 1 ? 1 : 0,
  };
  d.prepare(`
    INSERT INTO messages (id, from_officer_id, from_name, from_officer, to_officer, to_officer_name, reply_to_id, body, created_at, read)
    VALUES (@id, @from_officer_id, @from_name, @from_officer, @to_officer, @to_officer_name, @reply_to_id, @body, @created_at, @read)
    ON CONFLICT(id) DO UPDATE SET
      from_name = excluded.from_name,
      to_officer_name = excluded.to_officer_name,
      body = excluded.body,
      read = excluded.read
  `).run(clean);
  return { ok: true };
}

// ---------- snapshot builder (hub-side) ----------

// Functional-only rows: never leak password/salt/plain_password columns, and
// votes/checkins carry symbolic labels so peers can resolve their own ids.
function buildSnapshot(d) {
  const elections = d.prepare('SELECT * FROM elections ORDER BY created_at').all();
  const out = [];
  for (const e of elections) {
    const voters = d.prepare(`
      SELECT election_id, voter_id, name, assigned_station, station_id,
        checked_in, checked_in_at, checked_in_by, ballot_cast, grace_period,
        has_voted, voted_at, position_voted
      FROM voters WHERE election_id = ?
    `).all(e.id);
    const rawVotes = d.prepare(
      'SELECT position_id, candidate_id, voter_id, device_id, station_id, timestamp FROM votes WHERE election_id = ? ORDER BY timestamp, id'
    ).all(e.id);
    const votes = rawVotes.map((v) => {
      const pos = d.prepare('SELECT title FROM positions WHERE id = ?').get(v.position_id);
      const cand = d.prepare('SELECT name FROM candidates WHERE id = ?').get(v.candidate_id);
      return {
        election_id: e.id, voter_id: v.voter_id,
        position_title: pos ? pos.title : v.position_id,
        candidate_name: cand ? cand.name : v.candidate_id,
        device_id: v.device_id, station_id: v.station_id, timestamp: v.timestamp,
      };
    });
    const checkins = d.prepare(
      'SELECT election_id, voter_id, officer_id, device_id, timestamp FROM checkins WHERE election_id = ? ORDER BY timestamp'
    ).all(e.id);
    out.push({
      id: e.id, title: e.title, type: e.type, status: effectiveStatus(e),
      counts: { voters: voters.length, votes: rawVotes.length, cast: voters.filter((v) => (v.has_voted === 1 || v.ballot_cast === 1)).length, checkedIn: voters.filter((v) => v.checked_in === 1).length },
      voters, votes, checkins,
    });
  }
  return { elections: out, messages: listMessagesSync(d) };
}

// Authoritative state for one voter (used to resolve a conflict).
function buildVoterState(d, electionId, voterId) {
  const v = voterByVid(d, electionId, voterId);
  if (!v) return null;
  const rawVotes = d.prepare(
    'SELECT position_id, candidate_id, voter_id, device_id, station_id, timestamp FROM votes WHERE election_id = ? AND voter_id = ? ORDER BY timestamp, id'
  ).all(electionId, v.voter_id);
  const votes = rawVotes.map((r) => {
    const pos = d.prepare('SELECT title FROM positions WHERE id = ?').get(r.position_id);
    const cand = d.prepare('SELECT name FROM candidates WHERE id = ?').get(r.candidate_id);
    return {
      election_id: electionId, voter_id: r.voter_id,
      position_title: pos ? pos.title : r.position_id,
      candidate_name: cand ? cand.name : r.candidate_id,
      device_id: r.device_id, station_id: r.station_id, timestamp: r.timestamp,
    };
  });
  return {
    election_id: electionId,
    voter: {
      voter_id: v.voter_id, name: v.name, checked_in: v.checked_in,
      checked_in_at: v.checked_in_at, checked_in_by: v.checked_in_by,
      ballot_cast: v.ballot_cast, grace_period: v.grace_period,
      has_voted: v.has_voted, voted_at: v.voted_at, position_voted: v.position_voted,
    },
    votes,
  };
}

// Apply authoritative single-voter state (conflict resolution).
function applyVoterState(d, state) {
  if (!state || !state.voter) return false;
  applyRemoteVoteAll(d, state);
  const v = voterByVid(d, state.election_id, state.voter.voter_id);
  if (!v) return false;
  const vv = state.voter;
  d.prepare(`
    UPDATE voters SET
      checked_in = COALESCE(?, checked_in), checked_in_at = COALESCE(?, checked_in_at),
      checked_in_by = COALESCE(?, checked_in_by), ballot_cast = COALESCE(?, ballot_cast),
      grace_period = COALESCE(?, grace_period), has_voted = COALESCE(?, has_voted),
      voted_at = COALESCE(?, voted_at), position_voted = COALESCE(?, position_voted)
    WHERE id = ?
  `).run(vv.checked_in, vv.checked_in_at, vv.checked_in_by, vv.ballot_cast, vv.grace_period, vv.has_voted, vv.voted_at, vv.position_voted, v.id);
  // Remove any local votes for this voter the hub doesn't list (rejected).
  const hubKeys = new Set((state.votes || []).map((r) => r.position_title + '|' + r.candidate_name));
  // Local unsynced rows that don't match hub state are removed by the next
  // full snapshot; the accepted/broadcast flow keeps us aligned between resyncs.
  return true;
}

function applyRemoteVoteAll(d, state) {
  for (const row of state.votes || []) applyRemoteVote(d, row);
}

// Convert a client voter's own pending vote (symbolic) — used by the hub
// conflict path and the peer acknowledged-marker bookkeeping.
function markVoteSynced(d, electionId, voterId) {
  d.prepare('UPDATE votes SET synced = 1 WHERE election_id = ? AND voter_id = ?').run(electionId, voterId);
}

module.exports = {
  deviceIdOf,
  setDeviceName,
  deviceNameOf,
  resolvePosition,
  resolveCandidate,
  labelSelection,
  voterByVid,
  enqueue,
  listQueue,
  dequeue,
  clearQueue,
  writeVoteRows,
  recordRemoteVote,
  recordRemoteCheckin,
  recordRemoteUnvote,
  recordRemoteMessage,
  applyRemoteVote,
  applyRemoteCheckin,
  applyRemoteUnvote,
  applySnapshot,
  applyVoterState,
  buildSnapshot,
  buildVoterState,
  markVoteSynced,
  unsyncedVoteCount,
  queueSize,
  voteCount,
  hubCount,
  lastVoteAt,
  effectiveStatus,
};