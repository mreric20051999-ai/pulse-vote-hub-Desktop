const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const ELECTION_TYPES = ['school', 'station'];
const ELECTION_STATUSES = ['draft', 'upcoming', 'active', 'closed'];

// A locked election (active or closed) cannot have its ballot/configuration changed,
// but its status may still change (open/close). Mirrors the web app model.
function isLocked(status) {
  return status === 'active' || status === 'closed';
}
function lockedError() {
  return { ok: false, error: 'This election is locked because it is active or closed. Set it back to Draft to edit it.' };
}

// Derive the effective status from the schedule, mirroring getStatus() in the
// web app. Explicit draft/closed are returned as-is; upcoming/active are
// computed from start_date/end_date.
function computedStatus(e, now = Date.now()) {
  if (!e || !e.status) return 'draft';
  if (e.status === 'draft' || e.status === 'closed') return e.status;
  if (!e.start_date || !e.end_date) return 'draft';
  const s = Number(e.start_date);
  const end = Number(e.end_date);
  if (now < s) return 'upcoming';
  if (now >= s && now <= end) return 'active';
  return 'closed';
}

// ---- Elections ----

function createElection({ title, type, election_date, start_date, end_date, station_mode, close_grace_minutes, max_close_grace_minutes }) {
  if (!title || !String(title).trim()) return { ok: false, error: 'Title is required' };
  if (!ELECTION_TYPES.includes(type)) return { ok: false, error: 'Invalid election type' };

  const now = Date.now();
  const start = start_date !== undefined ? (start_date ? Number(start_date) : null) : (election_date ? Number(election_date) : null);
  const end = end_date ? Number(end_date) : null;
  const election = {
    id: uuidv4(),
    title: String(title).trim(),
    type,
    status: 'draft',
    election_date: start,       // legacy alias for the start timestamp
    start_date: start,
    end_date: end,
    station_mode: type === 'station' ? (station_mode ? 1 : 0) : 0,
    close_grace_minutes: type === 'station' ? Math.max(0, Number(close_grace_minutes) || 30) : 30,
    max_close_grace_minutes: type === 'station' ? Math.max(1, Number(max_close_grace_minutes) || 120) : 120,
    created_at: now,
    closed_at: null,
  };

  db.get().prepare(`
    INSERT INTO elections (
      id, title, type, status, election_date, start_date, end_date,
      station_mode, close_grace_minutes, max_close_grace_minutes, created_at, closed_at
    )
    VALUES (
      @id, @title, @type, @status, @election_date, @start_date, @end_date,
      @station_mode, @close_grace_minutes, @max_close_grace_minutes, @created_at, @closed_at
    )
  `).run(election);

  audit('elections', `Created election "${election.title}" (${election.type})`);
  return { ok: true, election };
}

function listElections() {
  return db.get().prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM positions p WHERE p.election_id = e.id) AS position_count,
      (SELECT COUNT(*) FROM candidates c WHERE c.election_id = e.id) AS candidate_count,
      (SELECT COUNT(*) FROM voters v WHERE v.election_id = e.id) AS voter_count
    FROM elections e
    ORDER BY e.created_at DESC
  `).all();
}

function getElection(id) {
  return db.get().prepare('SELECT * FROM elections WHERE id = ?').get(id) || null;
}

function updateElection(id, { title, type, election_date, start_date, end_date, station_mode, close_grace_minutes, max_close_grace_minutes }) {
  const exists = getElection(id);
  if (!exists) return { ok: false, error: 'Election not found' };
  if (title && !String(title).trim()) return { ok: false, error: 'Title is required' };
  if (type && !ELECTION_TYPES.includes(type)) return { ok: false, error: 'Invalid election type' };

  const newTitle = title ? String(title).trim() : exists.title;
  const newType = type || exists.type;
  const newStart = start_date !== undefined
    ? (start_date ? Number(start_date) : null)
    : (election_date !== undefined ? (election_date ? Number(election_date) : null) : exists.start_date);
  const newEnd = end_date !== undefined ? (end_date ? Number(end_date) : null) : exists.end_date;
  const newStationMode = station_mode !== undefined ? (station_mode ? 1 : 0) : exists.station_mode;
  const newGrace = close_grace_minutes !== undefined ? Math.max(0, Number(close_grace_minutes) || 0) : exists.close_grace_minutes;
  const newMaxGrace = max_close_grace_minutes !== undefined ? Math.max(1, Number(max_close_grace_minutes) || 1) : exists.max_close_grace_minutes;

  // Only block when an editable field actually differs (status-only saves pass).
  const wasChanged = newTitle !== exists.title || newType !== exists.type
    || newStart !== exists.start_date || newEnd !== exists.end_date
    || newStationMode !== exists.station_mode
    || newGrace !== exists.close_grace_minutes || newMaxGrace !== exists.max_close_grace_minutes;
  if (wasChanged && isLocked(exists.status)) return lockedError();

  db.get().prepare(`
    UPDATE elections
    SET title = ?, type = ?, start_date = ?, end_date = ?, election_date = ?,
        station_mode = ?, close_grace_minutes = ?, max_close_grace_minutes = ?
    WHERE id = ?
  `).run(newTitle, newType, newStart, newEnd, newStart, newStationMode, newGrace, newMaxGrace, id);

  audit('elections', `Updated election "${id}"`);
  return { ok: true, election: getElection(id) };
}

function setStatus(id, status) {
  if (!ELECTION_STATUSES.includes(status)) return { ok: false, error: 'Invalid status' };
  const exists = getElection(id);
  if (!exists) return { ok: false, error: 'Election not found' };

  db.get().prepare('UPDATE elections SET status = ?, closed_at = ? WHERE id = ?')
    .run(status, status === 'closed' ? Date.now() : exists.closed_at, id);

  audit('elections', `Set election "${id}" status to ${status}`);
  return { ok: true, election: getElection(id) };
}

// Publish an election: compute its status from the schedule, mirroring the web
// app's saveElection('publish') logic. A school election without any voters
// cannot publish — it is forced back to 'draft'.
function publishElection(id, { schoolVoterCount = null } = {}) {
  const exists = getElection(id);
  if (!exists) return { ok: false, error: 'Election not found' };

  const now = Date.now();
  let status = deriveStatusFromSchedule(exists, now);
  // School elections must have registered voters to go live.
  if (exists.type === 'school') {
    const vcount = schoolVoterCount != null
      ? schoolVoterCount
      : db.get().prepare('SELECT COUNT(*) AS c FROM voters WHERE election_id = ?').get(id).c;
    if (vcount === 0) status = 'draft';
  }

  db.get().prepare('UPDATE elections SET status = ? WHERE id = ?')
    .run(status, id);
  audit('elections', `Published election "${id}" -> ${status}`);
  return { ok: true, election: getElection(id) };
}

// Pure schedule→status derivation (used when publishing): ignores the stored
// status, deriving upcoming/active/closed from start_date/end_date.
function deriveStatusFromSchedule(e, now = Date.now()) {
  if (!e || !e.start_date || !e.end_date) return 'draft';
  const s = Number(e.start_date);
  const end = Number(e.end_date);
  if (now < s) return 'upcoming';
  if (now >= s && now <= end) return 'active';
  return 'closed';
}

// Auto-transition elections based on their schedule (web-app model):
//   - upcoming reaches its start_date  -> active
//   - active/upcoming reach end_date   -> closed
// Returns the ids of elections whose status changed.
function applySchedule(now = Date.now()) {
  const d = db.get();
  const rows = d.prepare(`
    SELECT id, status, start_date, end_date FROM elections
    WHERE (status = 'upcoming' AND start_date IS NOT NULL AND start_date <= ?)
       OR (status = 'active'   AND end_date   IS NOT NULL AND end_date   <= ?)
       OR (status = 'upcoming' AND end_date   IS NOT NULL AND end_date   <= ?)
  `).all(now, now, now);

  const changed = [];
  for (const r of rows) {
    let next = null;
    if (r.status === 'upcoming') {
      if (r.start_date != null && r.start_date <= now) next = 'active';
      if (r.end_date != null && r.end_date <= now) next = 'closed';
    } else if (r.status === 'active' && r.end_date != null && r.end_date <= now) {
      next = 'closed';
    }
    if (next && next !== r.status) {
      d.prepare('UPDATE elections SET status = ?, closed_at = ? WHERE id = ?')
        .run(next, next === 'closed' ? now : null, r.id);
      audit('elections', `Auto-${next === 'closed' ? 'closed' : 'opened'} election "${r.id}" by schedule`);
      changed.push(r.id);
    }
  }
  return { ok: true, changed };
}

function deleteElection(id) {
  const d = db.get();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM candidates WHERE election_id = ?').run(id);
    d.prepare('DELETE FROM positions WHERE election_id = ?').run(id);
    d.prepare('DELETE FROM voters WHERE election_id = ?').run(id);
    d.prepare('DELETE FROM checkins WHERE election_id = ?').run(id);
    d.prepare('DELETE FROM stations WHERE election_id = ?').run(id);
    d.prepare('DELETE FROM elections WHERE id = ?').run(id);
  });
  try {
    tx();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  audit('elections', `Deleted election "${id}"`);
  return { ok: true };
}

// ---- Positions ----

function addPosition(electionId, title, maxVotes = 1) {
  if (!getElection(electionId)) return { ok: false, error: 'Election not found' };
  if (isLocked(getElection(electionId).status)) return lockedError();
  if (!title || !String(title).trim()) return { ok: false, error: 'Position title is required' };
  maxVotes = Math.max(1, Number(maxVotes) || 1);

  const position = {
    id: uuidv4(),
    election_id: electionId,
    title: String(title).trim(),
    max_votes: maxVotes,
  };

  db.get().prepare('INSERT INTO positions (id, election_id, title, max_votes) VALUES (@id, @election_id, @title, @max_votes)')
    .run(position);

  audit('elections', `Added position "${position.title}"`);
  return { ok: true, position };
}

function listPositions(electionId) {
  return db.get().prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM candidates c WHERE c.position_id = p.id) AS candidate_count
    FROM positions p WHERE p.election_id = ? ORDER BY p.title
  `).all(electionId);
}

function removePosition(id) {
  const pos = db.get().prepare('SELECT * FROM positions WHERE id = ?').get(id);
  if (pos && isLocked(getElection(pos.election_id).status)) return lockedError();
  db.get().prepare('DELETE FROM candidates WHERE position_id = ?').run(id);
  db.get().prepare('DELETE FROM positions WHERE id = ?').run(id);
  audit('elections', `Removed position "${id}"`);
  return { ok: true };
}

// ---- Candidates ----

function addCandidate({ electionId, positionId, name, photo_path }) {
  if (!getElection(electionId)) return { ok: false, error: 'Election not found' };
  if (isLocked(getElection(electionId).status)) return lockedError();
  if (!name || !String(name).trim()) return { ok: false, error: 'Candidate name is required' };

  const position = db.get().prepare('SELECT * FROM positions WHERE id = ? AND election_id = ?').get(positionId, electionId);
  if (!position) return { ok: false, error: 'Position not found in election' };

  const d = db.get();
  const sortOrder = d.prepare('SELECT COUNT(*) AS c FROM candidates WHERE position_id = ?').get(positionId).c;
  // Auto-assign next ballot number within this category (never reused).
  const ballotNumber = (d.prepare('SELECT MAX(ballot_number) AS m FROM candidates WHERE position_id = ?').get(positionId).m || 0) + 1;
  const candidate = {
    id: uuidv4(),
    election_id: electionId,
    position_id: positionId,
    name: String(name).trim(),
    photo_path: photo_path || null,
    ballot_number: ballotNumber,
    sort_order: sortOrder,
  };

  d.prepare('INSERT INTO candidates (id, election_id, position_id, name, photo_path, ballot_number, sort_order) VALUES (@id, @election_id, @position_id, @name, @photo_path, @ballot_number, @sort_order)')
    .run(candidate);

  audit('elections', `Added candidate "${candidate.name}" (ballot #${ballotNumber})`);
  return { ok: true, candidate };
}

function listCandidates(electionId) {
  return db.get().prepare(`
    SELECT c.* FROM candidates c
    WHERE c.election_id = ? ORDER BY c.position_id, c.sort_order
  `).all(electionId);
}

function listCandidatesByPosition(positionId) {
  return db.get().prepare('SELECT * FROM candidates WHERE position_id = ? ORDER BY sort_order').all(positionId);
}

function removeCandidate(id) {
  const cand = db.get().prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  if (cand && isLocked(getElection(cand.election_id).status)) return lockedError();
  db.get().prepare('DELETE FROM candidates WHERE id = ?').run(id);
  audit('elections', `Removed candidate "${id}"`);
  return { ok: true };
}

// ---- Audit ----

function audit(context, details) {
  try {
    const d = db.get();
    const prev = d.prepare('SELECT id, entry_hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
    const entry = {
      election_id: null,
      officer_id: null,
      action: context,
      details,
      timestamp: Date.now(),
      prev_hash: prev ? prev.entry_hash : null,
      entry_hash: '',
    };
    const raw = `${entry.action}|${entry.details}|${entry.timestamp}`;
    const crypto = require('crypto');
    entry.entry_hash = crypto.createHash('sha256').update(raw).digest('hex');
    d.prepare('INSERT INTO audit_log (election_id, officer_id, action, details, timestamp, prev_hash, entry_hash) VALUES (@election_id, @officer_id, @action, @details, @timestamp, @prev_hash, @entry_hash)')
      .run(entry);
  } catch (e) {
    // audit should never break an operation
  }
}

module.exports = {
  createElection,
  listElections,
  getElection,
  updateElection,
  setStatus,
  publishElection,
  computedStatus,
  isLocked,
  deriveStatusFromSchedule,
  applySchedule,
  deleteElection,
  addPosition,
  listPositions,
  removePosition,
  addCandidate,
  listCandidates,
  listCandidatesByPosition,
  removeCandidate,
};
