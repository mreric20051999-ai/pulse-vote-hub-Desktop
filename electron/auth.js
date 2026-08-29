const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Brute-force protection: N failed logins within a window freezes the account
// for LOCKOUT_MS. Failures are tracked per attempted officer ID (persisted in
// the config table so restarting the app does not bypass the lockout).
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const LOCKOUT_PREFIX = 'lockout:';

function lockoutKey(officerId) {
  return LOCKOUT_PREFIX + String(officerId).trim().toUpperCase();
}

function readLockout(officerId) {
  const raw = db.getConfig(lockoutKey(officerId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function writeLockout(officerId, record) {
  db.setConfig(lockoutKey(officerId), JSON.stringify(record));
}

// Remaining freeze time for an officer ID, or 0 if they can log in.
function remainingLockoutMs(officerId) {
  const rec = readLockout(officerId);
  if (!rec || !rec.until) return 0;
  const ms = rec.until - Date.now();
  return ms > 0 ? ms : 0;
}

// Login with lockout enforcement. Unlike `login`, failures for unknown IDs are
// also tracked so the lockout cannot be defeated by targeting a real account.
function attemptLogin(officerId, password) {
  const key = lockoutKey(officerId);
  const now = Date.now();

  const held = remainingLockoutMs(officerId);
  if (held > 0) {
    return { ok: false, code: 'locked', error: 'Too many failed attempts. Try again in a few minutes.', retryAfterMs: held };
  }

  const row = findByOfficerId(officerId);
  const ok = row && decodeHash(row.password)
    ? (() => {
        const d = decodeHash(row.password);
        const expected = Buffer.from(d.hash, 'hex');
        const actual = Buffer.from(hashPassword(String(password), d.salt), 'hex');
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
      })()
    : false;

  if (ok) {
    writeLockout(officerId, { n: 0, until: 0 });
    return { ok: true, officer: publicOfficer(row) };
  }

  const rec = readLockout(officerId) || { n: 0, until: 0 };
  const n = rec.n + 1;
  if (n >= MAX_ATTEMPTS) {
    writeLockout(officerId, { n: 0, until: now + LOCKOUT_MS });
    return { ok: false, code: 'locked', error: 'Too many failed attempts. Account is locked for 5 minutes.', retryAfterMs: LOCKOUT_MS, remaining: 0 };
  }
  writeLockout(officerId, { n, until: 0 });
  return { ok: false, code: 'invalid', error: 'Invalid officer ID or password', remaining: MAX_ATTEMPTS - n };
}

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
  attemptLogin,
  remainingLockoutMs,
  listOfficers,
  findById,
  addOfficer,
  removeOfficer,
  setSuspended,
  changePassword,
  assignStationOfficer,
};
