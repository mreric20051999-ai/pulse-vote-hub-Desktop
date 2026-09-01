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
    location_id: extra.location_id != null ? extra.location_id : null,
    suspended: extra.suspended ? 1 : 0,
    created_at: Date.now(),
  };

  db.get().prepare(`
    INSERT INTO officers (id, name, officer_id, password, role, assigned_device, assigned_election_id, assigned_station_id, location_id, suspended, created_at)
    VALUES (@id, @name, @officer_id, @password, @role, @assigned_device, @assigned_election_id, @assigned_station_id, @location_id, @suspended, @created_at)
  `).run(officer);

  return officer;
}

// The first superuser is gated by a setup code so the admin role cannot be
// silently claimed by whoever opens a fresh install first. On a machine that
// has never been provisioned the operator sets the code once (with a
// confirmation); from then on the stored code must be supplied to claim the
// first admin. Once an admin exists the setup is closed and the code cannot be
// changed, so it cannot be used to escalate or re-claim privileges.
const SETUP_CODE_MIN = 6;
const SETUP_CODE_KEY = 'setup_code';

function setupCodeHash(code) {
  const salt = generateSalt();
  return encodeHash(salt, hashPassword(String(code).trim(), salt));
}

// Whether a setup code has already been provisioned on this machine.
function hasSetupCode() {
  return !!db.getConfig(SETUP_CODE_KEY);
}

// Verify a submitted setup code against the provisioned one.
function verifySetupCode(code) {
  const stored = db.getConfig(SETUP_CODE_KEY);
  if (!stored) return false;
  const decoded = decodeHash(stored);
  if (!decoded) return false;
  const expected = Buffer.from(decoded.hash, 'hex');
  const actual = Buffer.from(hashPassword(String(code).trim(), decoded.salt), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Provision the setup code on a never-set-up machine (owner claim step).
function provisionSetupCode(code, confirm) {
  if (hasSetupCode()) return { ok: false, error: 'A setup code has already been set for this machine' };
  if (!code || String(code).trim().length < SETUP_CODE_MIN) {
    return { ok: false, error: `Setup code must be at least ${SETUP_CODE_MIN} characters` };
  }
  if (code !== confirm) return { ok: false, error: 'Setup code confirmation does not match' };
  db.setConfig(SETUP_CODE_KEY, setupCodeHash(code));
  return { ok: true };
}

// Set up the initial superuser (admin) — first-run wizard
function setupAdmin(name, officerId, password, setupCode, confirmSetupCode) {
  if (hasAdmin()) return { ok: false, error: 'An admin account already exists' };
  if (!setupCode) return { ok: false, error: 'The setup code is required to create the administrator' };
  if (!name || !officerId || !password) return { ok: false, error: 'All fields are required' };
  if (String(password).length < 6) return { ok: false, error: 'Password must be at least 6 characters' };
  if (findByOfficerId(officerId)) return { ok: false, error: 'Officer ID already in use' };

  // First-time provision: the operator sets and confirms the code (owner claim).
  // Subsequent claims must match the provisioned code.
  if (!hasSetupCode()) {
    const prov = provisionSetupCode(setupCode, confirmSetupCode);
    if (!prov.ok) return prov;
  } else if (!verifySetupCode(setupCode)) {
    return { ok: false, error: 'Incorrect setup code for this machine' };
  }

  const officer = insertOfficer(name, officerId, password, 'admin');
  db.setConfig('initialized_at', String(Date.now()));
  db.setConfig('admin_claimed_at', String(Date.now()));
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

// ---- One-time privilege codes (operator issues codes to grant access) ----

const ROLE_ORDER = { admin: 0, location_coordinator: 1, coordinator: 2, assistant: 3 };
function privilegeAllows(actor, priv) {
  const a = ROLE_ORDER[actor] == null ? 99 : ROLE_ORDER[actor];
  const p = ROLE_ORDER[priv];
  if (p == null) return false;
  // An actor can only issue a privilege equal to or below their own standing,
  // so a coordinator cannot mint an admin (prevents privilege escalation).
  return a <= p;
}

// Generate a human-friendly, single-use code bound to a privilege.
function issueSetupCode(actingOfficerId, privilege) {
  const actor = findById(actingOfficerId);
  if (!actor) return { ok: false, error: 'Not authorized' };
  if (!['admin', 'coordinator', 'assistant'].includes(privilege)) {
    return { ok: false, error: 'Invalid privilege' };
  }
  if (!privilegeAllows(actor.role, privilege)) {
    return { ok: false, error: 'You cannot issue this privilege level' };
  }
  // 3 groups of 4 = 12 chars, unambiguous (no 0/O/1/I/L).
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const gen = () => {
    let s = '';
    for (let i = 0; i < 12; i++) s += alphabet[Math.floor(crypto.randomInt(alphabet.length))];
    return s.match(/.{4}/g).join('-');
  };
  const code = gen();
  const salt = generateSalt();
  const record = {
    id: uuidv4(),
    code_hash: encodeHash(salt, hashPassword(code, salt)),
    privilege,
    created_by: actor.id,
    created_at: Date.now(),
    redeemed_at: null,
    redeemed_by: null,
  };
  db.get().prepare(`
    INSERT INTO setup_codes (id, code_hash, privilege, created_by, created_at, redeemed_at, redeemed_by)
    VALUES (@id, @code_hash, @privilege, @created_by, @created_at, @redeemed_at, @redeemed_by)
  `).run(record);
  return { ok: true, code, privilege };
}

// Redeem a code to create the invitee's account at the code's privilege.
function redeemSetupCode({ code, name, officerId, password, confirmPassword }) {
  const raw = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return { ok: false, error: 'An access code is required' };
  if (!name || !officerId || !password) return { ok: false, error: 'All fields are required' };
  if (String(password).length < 6) return { ok: false, error: 'Password must be at least 6 characters' };
  if (password !== confirmPassword) return { ok: false, error: 'Password confirmation does not match' };
  if (findByOfficerId(officerId)) return { ok: false, error: 'Officer ID already in use' };

  // Scan unscoped: compare each unused code hash. (Codes are short-lived and
  // few in number; a bounded scan with a timing-safe compare is acceptable.)
  const candidates = db.get().prepare(
    "SELECT * FROM setup_codes WHERE redeemed_at IS NULL"
  ).all();
  let match = null;
  for (const row of candidates) {
    const decoded = decodeHash(row.code_hash);
    if (!decoded) continue;
    const expected = Buffer.from(decoded.hash, 'hex');
    const actual = Buffer.from(hashPassword(raw, decoded.salt), 'hex');
    if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) {
      match = row;
      break;
    }
  }
  if (!match) return { ok: false, error: 'Invalid or expired access code' };

  const officer = insertOfficer(name, officerId, password, match.privilege);
  db.get().prepare('UPDATE setup_codes SET redeemed_at = ?, redeemed_by = ? WHERE id = ?')
    .run(Date.now(), officer.id, match.id);
  return { ok: true, officer: publicOfficer(officer), privilege: match.privilege };
}

// List issued codes with redemption status (admin only).
function listSetupCodes() {
  return db.get().prepare(
    "SELECT id, privilege, created_at, redeemed_at FROM setup_codes ORDER BY created_at DESC"
  ).all();
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

// ---- Signed sessions ----
// A successful login returns an opaque, unguessable token that the renderer
// must present on every privileged IPC call. The main process never trusts a
// caller-supplied officer id again; it validates the token and derives the
// actor (and its role) from the stored session. Tokens are kept in memory and
// expire, so app restart or timeout ends the right to act.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h, sliding
const sessions = new Map(); // token -> { officerId, expiresAt, senderId }

function createSession(officer, senderId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { officerId: officer.id, expiresAt: Date.now() + SESSION_TTL_MS, senderId: senderId || null });
  return token;
}

// Validate a session token and return the acting officer, or null.
function validateSession(token, senderId) {
  if (!token || typeof token !== 'string') return null;
  const s = sessions.get(token);
  if (!s) return null;
  // Bound to the webContents that originally logged in, so a session minted in
  // one window cannot be replayed from a different renderer.
  if (s.senderId != null && senderId != null && s.senderId !== senderId) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  // Sliding expiry.
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  const officer = findById(s.officerId);
  if (!officer || officer.suspended) { sessions.delete(token); return null; }
  return { officer, token };
}

function revokeSession(token) {
  if (token) sessions.delete(token);
}

function sessionTokenFor(officerId) {
  for (const [token, s] of sessions.entries()) if (s.officerId === officerId) return token;
  return null;
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
  hasSetupCode,
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
  insertOfficer,
  issueSetupCode,
  redeemSetupCode,
  listSetupCodes,
  createSession,
  validateSession,
  revokeSession,
  sessionTokenFor,
};
