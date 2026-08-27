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

// Is the coordinator configured?
function isConfigured() {
  const row = db.get()
    .prepare("SELECT COUNT(*) AS c FROM officers WHERE role = 'coordinator'")
    .get();
  return row.c > 0;
}

// Set up the initial coordinator (first-run wizard)
function setupCoordinator(name, officerId, password) {
  if (isConfigured()) return { ok: false, error: 'Coordinator already configured' };
  if (!name || !officerId || !password) return { ok: false, error: 'All fields are required' };
  if (String(password).length < 6) return { ok: false, error: 'Password must be at least 6 characters' };

  const salt = generateSalt();
  const hash = hashPassword(String(password), salt);
  const stored = encodeHash(salt, hash);

  const officer = {
    id: uuidv4(),
    name: String(name).trim(),
    officer_id: String(officerId).trim().toUpperCase(),
    password: stored,
    role: 'coordinator',
    assigned_device: null,
    created_at: Date.now(),
  };

  db.get().prepare(`
    INSERT INTO officers (id, name, officer_id, password, role, assigned_device, created_at)
    VALUES (@id, @name, @officer_id, @password, @role, @assigned_device, @created_at)
  `).run({
    id: officer.id,
    name: officer.name,
    officer_id: officer.officer_id,
    password: officer.password,
    role: officer.role,
    assigned_device: officer.assigned_device,
    created_at: officer.created_at,
  });

  db.setConfig('initialized_at', String(Date.now()));

  return { ok: true, officer: publicOfficer(officer) };
}

// Login an officer
function login(officerId, password) {
  const row = db.get()
    .prepare('SELECT * FROM officers WHERE officer_id = ?')
    .get(String(officerId).trim().toUpperCase());

  if (!row) return null;

  const decoded = decodeHash(row.password);
  if (!decoded) return null;

  const expected = Buffer.from(decoded.hash, 'hex');
  const actual = Buffer.from(hashPassword(String(password), decoded.salt), 'hex');

  const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (!ok) return null;

  return publicOfficer(row);
}

function publicOfficer(row) {
  return {
    id: row.id,
    name: row.name,
    officer_id: row.officer_id,
    role: row.role,
    assigned_device: row.assigned_device,
    created_at: row.created_at,
  };
}

module.exports = {
  hashPassword,
  generateSalt,
  isConfigured,
  setupCoordinator,
  login,
};
