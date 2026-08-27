const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const db = require('./db');
const auth = require('./auth');

// ---- Voter management ----

function listVoters(electionId, { limit = 200, offset = 0 } = {}) {
  const d = db.get();
  const total = d.prepare('SELECT COUNT(*) AS c FROM voters WHERE election_id = ?').get(electionId).c;
  const voters = d.prepare(`
    SELECT id, voter_id, name, assigned_station, has_voted, voted_at, position_voted
    FROM voters WHERE election_id = ? ORDER BY name, voter_id LIMIT ? OFFSET ?
  `).all(electionId, limit, offset);
  return { total, voters };
}

function getVoter(electionId, voterId) {
  return db.get().prepare('SELECT * FROM voters WHERE election_id = ? AND voter_id = ?').get(electionId, voterId) || null;
}

// Add a single voter (name optional; voterId auto-generated if not given)
function addVoter({ electionId, name, voterId, assignedStation, password }) {
  if (!getElectionRow(electionId)) return { ok: false, error: 'Election not found' };

  const finalVoterId = (voterId && String(voterId).trim()) ? String(voterId).trim().toUpperCase() : generateVoterId();
  const finalPassword = password ? String(password) : generatePassword();

  if (getVoter(electionId, finalVoterId)) return { ok: false, error: 'Voter ID already exists' };

  const d = db.get();
  d.prepare(`
    INSERT INTO voters (id, election_id, voter_id, name, password_hash, password_salt, assigned_station, has_voted)
    VALUES (@id, @election_id, @voter_id, @name, @password_hash, @password_salt, @assigned_station, 0)
  `).run({
    id: uuidv4(),
    election_id: electionId,
    voter_id: finalVoterId,
    name: name ? String(name).trim() : null,
    password_hash: auth.hashPassword(finalPassword, fallbackSalt()),
    password_salt: '',
    assigned_station: assignedStation ? String(assignedStation).trim() : null,
  });

  return { ok: true, voter: { voter_id: finalVoterId, password: finalPassword, name, assigned_station: assignedStation } };
}

// Import voters from a CSV string.
// Accepts columns: voter_id, name, assigned_station (password auto-generated when absent)
function importCsv(electionId, csvText) {
  if (!getElectionRow(electionId)) return { ok: false, error: 'Election not found' };
  if (!csvText || !String(csvText).trim()) return { ok: false, error: 'CSV is empty' };

  let records;
  try {
    records = parse(String(csvText), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return { ok: false, error: 'Could not parse CSV: ' + e.message };
  }

  const d = db.get();
  const insert = d.prepare(`
    INSERT INTO voters (id, election_id, voter_id, name, password_hash, password_salt, assigned_station, has_voted)
    VALUES (@id, @election_id, @voter_id, @name, @password_hash, @password_salt, @assigned_station, 0)
  `);

  const tx = d.transaction((rows) => {
    let added = 0, skipped = 0;
    for (const row of rows) {
      const voterId = (row.voter_id || row.voterID || row.id || '').toString().trim().toUpperCase();
      if (!voterId) { skipped++; continue; }
      if (getVoter(electionId, voterId)) { skipped++; continue; }
      const password = row.password ? String(row.password) : generatePassword();
      insert.run({
        id: uuidv4(),
        election_id: electionId,
        voter_id: voterId,
        name: (row.name || row.full_name || row.fullname || '').trim() || null,
        password_hash: auth.hashPassword(password, fallbackSalt()),
        password_salt: '',
        assigned_station: (row.assigned_station || '').trim() || null,
      });
      added++;
    }
    return { added, skipped };
  });

  return { ok: true, ...tx(records) };
}

// Auto-generate N voters with sequential IDs and random passwords
function autoGenerate(electionId, count) {
  if (!getElectionRow(electionId)) return { ok: false, error: 'Election not found' };
  count = Math.min(Math.max(1, Number(count) || 1), 1000);

  const d = db.get();
  const insert = d.prepare(`
    INSERT INTO voters (id, election_id, voter_id, name, password_hash, password_salt, assigned_station, has_voted)
    VALUES (@id, @election_id, @voter_id, @name, @password_hash, @password_salt, @assigned_station, 0)
  `);
  const existing = new Set(d.prepare('SELECT voter_id FROM voters WHERE election_id = ?').all(electionId).map((r) => r.voter_id));

  let added = 0;
  let n = 1;
  while (added < count) {
    const voterId = generateVoterId(n);
    if (existing.has(voterId)) { n++; continue; }
    const password = generatePassword();
    insert.run({
      id: uuidv4(),
      election_id: electionId,
      voter_id: voterId,
      name: null,
      password_hash: auth.hashPassword(password, fallbackSalt()),
      password_salt: '',
      assigned_station: null,
    });
    existing.add(voterId);
    added++; n++;
  }

  return { ok: true, count: added };
}

function deleteVoter(electionId, voterId) {
  const d = db.get();
  d.prepare('DELETE FROM voters WHERE election_id = ? AND voter_id = ?').run(electionId, voterId);
  d.prepare('DELETE FROM checkins WHERE election_id = ? AND voter_id = ?').run(electionId, voterId);
  return { ok: true };
}

function clearVoters(electionId) {
  db.get().prepare('DELETE FROM checkins WHERE election_id = ?').run(electionId);
  db.get().prepare('DELETE FROM voters WHERE election_id = ?').run(electionId);
  return { ok: true };
}

function unvoteVoter(electionId, voterId) {
  db.get().prepare('UPDATE voters SET has_voted = 0, voted_at = NULL, position_voted = NULL WHERE election_id = ? AND voter_id = ?')
    .run(electionId, voterId);
  return { ok: true };
}

// ---- helpers ----

function getElectionRow(electionId) {
  return db.get().prepare('SELECT id FROM elections WHERE id = ?').get(electionId);
}

// Salt fallback: our officers store salt baked in; voters use a fixed project salt.
let _saltCache = null;
function fallbackSalt() {
  if (_saltCache) return _saltCache;
  let s = db.get().prepare('SELECT value FROM config WHERE key = ?').get('voter_salt');
  if (!s) {
    s = crypto.randomBytes(16).toString('hex');
    db.setConfig('voter_salt', s);
  } else {
    s = s.value;
  }
  _saltCache = s;
  return s;
}

function generateVoterId(n) {
  const num = n ? String(n).padStart(4, '0') : randomDigits(6);
  return `V${num}`;
}

function generatePassword(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function randomDigits(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += crypto.randomInt(0, 10);
  return out;
}

module.exports = {
  listVoters,
  getVoter,
  addVoter,
  importCsv,
  autoGenerate,
  deleteVoter,
  clearVoters,
  unvoteVoter,
  generateVoterId,
  generatePassword,
};
