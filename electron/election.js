const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const ELECTION_TYPES = ['school', 'station'];
const ELECTION_STATUSES = ['setup', 'voting', 'closed'];

// ---- Elections ----

function createElection({ title, type, election_date }) {
  if (!title || !String(title).trim()) return { ok: false, error: 'Title is required' };
  if (!ELECTION_TYPES.includes(type)) return { ok: false, error: 'Invalid election type' };

  const now = Date.now();
  const election = {
    id: uuidv4(),
    title: String(title).trim(),
    type,
    status: 'setup',
    election_date: election_date ? Number(election_date) : null,
    created_at: now,
    closed_at: null,
  };

  db.get().prepare(`
    INSERT INTO elections (id, title, type, status, election_date, created_at, closed_at)
    VALUES (@id, @title, @type, @status, @election_date, @created_at, @closed_at)
  `).run({
    id: election.id,
    title: election.title,
    type: election.type,
    status: election.status,
    election_date: election.election_date,
    created_at: election.created_at,
    closed_at: election.closed_at,
  });

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

function updateElection(id, { title, type, election_date }) {
  const exists = getElection(id);
  if (!exists) return { ok: false, error: 'Election not found' };
  if (title && !String(title).trim()) return { ok: false, error: 'Title is required' };
  if (type && !ELECTION_TYPES.includes(type)) return { ok: false, error: 'Invalid election type' };

  const newDate = election_date !== undefined
    ? (election_date ? Number(election_date) : null)
    : exists.election_date;

  db.get().prepare('UPDATE elections SET title = ?, type = ?, election_date = ? WHERE id = ?')
    .run(title ? String(title).trim() : exists.title, type || exists.type, newDate, id);

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

function deleteElection(id) {
  const d = db.get();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM candidates WHERE election_id = ?').run(id);
    d.prepare('DELETE FROM positions WHERE election_id = ?').run(id);
    d.prepare('DELETE FROM voters WHERE election_id = ?').run(id);
    d.prepare('DELETE FROM checkins WHERE election_id = ?').run(id);
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
  db.get().prepare('DELETE FROM candidates WHERE position_id = ?').run(id);
  db.get().prepare('DELETE FROM positions WHERE id = ?').run(id);
  audit('elections', `Removed position "${id}"`);
  return { ok: true };
}

// ---- Candidates ----

function addCandidate({ electionId, positionId, name }) {
  if (!getElection(electionId)) return { ok: false, error: 'Election not found' };
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
    photo_path: null,
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
  deleteElection,
  addPosition,
  listPositions,
  removePosition,
  addCandidate,
  listCandidates,
  listCandidatesByPosition,
  removeCandidate,
};
