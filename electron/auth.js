const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64, SCRYPT_OPTS).toString('hex');
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// Store as "scrypt$<salt>$<hash>" in a single column.
function encodeHash(salt, hash) {
  return `scrypt$${salt}$${hash}`;
}

function decodeHash(stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return null;
  return { salt: parts[1], hash: parts[2] };
}

// Is any officer account configured? (Once set up, the app is configured.)
function isConfigured() {
  const row = db.get()
    .prepare('SELECT COUNT(*) AS c FROM officers')
    .get();
  return row.c > 0;
}

// Is there at least one superuser (admin) account?
function hasAdmin() {
  const row = db.get()
    .prepare("SELECT COUNT(*) AS c FROM officers WHERE role = 'admin'")
    .get();
  return row.c > 0;
}

function findByOfficerId(officerId) {
  return db.get()
    .prepare('SELECT * FROM officers WHERE officer_id = ?')
    .get(String(officerId).trim().toUpperCase());
}

// Look up an officer by its internal UUID id (used to resolve the acting
// officer that the renderer session reports).
function findById(id) {
  if (!id) return null;
  return db.get()
    .prepare('SELECT * FROM officers WHERE id = ?')
    .get(String(id));
}

function insertOfficer(name, officerId, password, role, extra = {}) {
  const salt = generateSalt();
  const hash = hashPassword(String(password), salt);
  const stored = encodeHash(salt, hash);

  const officer = {
    id: uuidv4(),
    name: String(name).trim(),
    officer_id: String(officerId).trim().toUpperCase(),
    password: stored,
    role,
    assigned_device: extra.assigned_device != null ? extra.assigned_device : null,
    assigned_election_id: extra.assigned_election_id != null ? extra.assigned_election_id : null,
    assigned_station_id: extra.assigned_station_id != null ? extra.assigned_station_id : null,
    suspended: extra.suspended ? 1 : 0,
    created_at: Date.now(),
  };

  db.get().prepare(`
    INSERT INTO officers (id, name, officer_id, password, role, assigned_device, assigned_election_id, assigned_station_id, suspended, created_at)
    VALUES (@id, @name, @officer_id, @password, @role, @assigned_device, @assigned_election_id, @assigned_station_id, @suspended, @created_at)
  `).run(officer);

  return officer;
}

// Set up the initial superuser (admin) — first-run wizard
function setupAdmin(name, officerId, password) {
  if (hasAdmin()) return { ok: false, error: 'An admin account already exists' };
  if (!name || !officerId || !password) return { ok: false, error: 'All fields are required' };
  if (String(password).length < 6) return { ok: false, error: 'Password must be at least 6 characters' };
  if (findByOfficerId(officerId)) return { ok: false, error: 'Officer ID already in use' };

  const officer = insertOfficer(name, officerId, password, 'admin');
  db.setConfig('initialized_at', String(Date.now()));
  return { ok: true, officer: publicOfficer(officer) };
}

// Set up a coordinator (legacy / non-admin bootstrap)
function setupCoordinator(name, officerId, password) {
  if (isConfigured()) return { ok: false, error: 'Coordinator already configured' };
  if (!name || !officerId || !password) return { ok: false, error: 'All fields are required' };
  if (String(password).length < 6) return { ok: false, error: 'Password must be at least 6 characters' };
  const officer = insertOfficer(name, officerId, password, 'coordinator');
  db.setConfig('initialized_at', String(Date.now()));
  return { ok: true, officer: publicOfficer(officer) };
}

// Login an officer (admin, coordinator or assistant)
function login(officerId, password) {
  const row = findByOfficerId(officerId);
  if (!row) return null;

  const decoded = decodeHash(row.password);
  if (!decoded) return null;

  const expected = Buffer.from(decoded.hash, 'hex');
  const actual = Buffer.from(hashPassword(String(password), decoded.salt), 'hex');

  const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (!ok) return null;

  return publicOfficer(row);
}

// ---- Admin management (superuser operations) ----

function listOfficers() {
  return db.get()
    .prepare('SELECT * FROM officers ORDER BY role DESC, created_at ASC')
    .all()
    .map(publicOfficer);
}

// Admin creates a coordinator or assistant account
function addOfficer({ name, officerId, password, role = 'coordinator' }) {
  if (!name || !officerId || !password) return { ok: false, error: 'All fields are required' };
  if (String(password).length < 6) return { ok: false, error: 'Password must be at least 6 characters' };
  if (!['coordinator', 'assistant'].includes(role)) role = 'coordinator';
  if (findByOfficerId(officerId)) return { ok: false, error: 'Officer ID already in use' };

  const officer = insertOfficer(name, officerId, password, role);
  return { ok: true, officer: publicOfficer(officer) };
}

// Remove a coordinator/assistant (cannot remove admins or yourself)
function removeOfficer(id, actingId) {
  const row = db.get().prepare('SELECT * FROM officers WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Account not found' };
  if (row.role === 'admin') return { ok: false, error: 'Cannot remove an admin account' };
  if (row.id === actingId) return { ok: false, error: 'You cannot remove your own account' };
  db.get().prepare('DELETE FROM officers WHERE id = ?').run(id);
  return { ok: true };
}

// Suspend or activate a coordinator/assistant (cannot suspend admins)
function setSuspended(id, suspended) {
  const row = db.get().prepare('SELECT * FROM officers WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Account not found' };
  if (row.role === 'admin') return { ok: false, error: 'Cannot suspend an admin account' };
  db.get().prepare('UPDATE officers SET suspended = ? WHERE id = ?').run(suspended ? 1 : 0, id);
  return { ok: true, officer: publicOfficer(db.get().prepare('SELECT * FROM officers WHERE id = ?').get(id)) };
}

// Change an officer's password (admin for others, or any officer for themselves)
function changePassword(id, newPassword) {
  if (String(newPassword).length < 6) return { ok: false, error: 'Password must be at least 6 characters' };
  const salt = generateSalt();
  const stored = encodeHash(salt, hashPassword(String(newPassword), salt));
  db.get().prepare('UPDATE officers SET password = ? WHERE id = ?').run(stored, id);
  return { ok: true };
}

function publicOfficer(row) {
  return {
    id: row.id,
    name: row.name,
    officer_id: row.officer_id,
    role: row.role,
    suspended: !!row.suspended,
    assigned_device: row.assigned_device,
    assigned_election_id: row.assigned_election_id || null,
    assigned_station_id: row.assigned_station_id || null,
    created_at: row.created_at,
  };
}

// Link an assistant (station officer) account to a station for an election.
// Passing stationId = null clears the assignment.
function assignStationOfficer(officerId, stationId, electionId) {
  const officer = db.get().prepare('SELECT * FROM officers WHERE id = ?').get(officerId);
  if (!officer) return { ok: false, error: 'Account not found' };
  if (officer.role === 'admin') return { ok: false, error: 'Admin accounts cannot serve as station officers' };
  db.get().prepare('UPDATE officers SET assigned_station_id = ?, assigned_election_id = ? WHERE id = ?')
    .run(stationId, stationId ? electionId : null, officerId);
  return { ok: true, officer: publicOfficer(db.get().prepare('SELECT * FROM officers WHERE id = ?').get(officerId)) };
}

module.exports = {
  hashPassword,
  generateSalt,
  isConfigured,
  hasAdmin,
  setupAdmin,
  setupCoordinator,
  login,
  listOfficers,
  findById,
  addOfficer,
  removeOfficer,
  setSuspended,
  changePassword,
  assignStationOfficer,
};
