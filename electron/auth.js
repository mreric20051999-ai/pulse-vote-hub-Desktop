const crypto = require('crypto');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const lic = require('./license-client');
const { LIMITS } = require('./validate');

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Current app version. Used to force re-activation whenever the app is upgraded
// (the license is bound to the version it was activated under), so a user must
// enter their code again on each new release — verifying they are a real user.
function currentVersion() {
  try { return (require('electron').app.getVersion() || '').trim(); }
  catch (e) { return ''; }
}

// Brute-force protection: N failed logins within a window freezes the account
// for LOCKOUT_MS. Failures are tracked per attempted officer ID (persisted in
// the config table so restarting the app does not bypass the lockout).
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const LOCKOUT_PREFIX = 'lockout:';

function lockoutKey(officerId) {
  return LOCKOUT_PREFIX + String(officerId).trim();
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
  // Hard guard: never run scrypt on an unbounded input (CPU/memory DoS). The
  // caller-facing validators enforce the same 128 cap with a friendly message.
  const pw = String(password || '');
  if (pw.length > 128) throw new Error('Password exceeds maximum length');
  return crypto.scryptSync(pw, salt, 64, SCRYPT_OPTS).toString('hex');
}

// Shared password policy used by every create/change path: at least 6 chars,
// at most 128 chars, and not blank/whitespace-only.
const PW_MIN = 6;
const PW_MAX = 128;
function validatePassword(password) {
  const pw = password === undefined || password === null ? '' : String(password);
  if (pw.length < PW_MIN) return { ok: false, code: 'weak', error: `Password must be at least ${PW_MIN} characters` };
  if (pw.length > PW_MAX) return { ok: false, code: 'weak', error: `Password must be ${PW_MAX} characters or fewer` };
  if (!pw.trim()) return { ok: false, code: 'weak', error: 'Password cannot be blank' };
  return { ok: true };
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

// Can this machine reach the developer bootstrap (Ctrl/⌘+Shift+D)? The hidden
// gesture may only open on a machine that is already licensed (activation done)
// or already has a developer account. A fresh, unactivated user machine must
// NOT be able to self-register a developer account (which would bypass
// activation), so the bootstrap is locked to licensed/dev machines only.
function canAccessDeveloperBootstrap() {
  return !!(db.getConfig('license_code')) || hasDeveloper();
}

// Is there at least one superuser (admin) account?
function hasAdmin() {
  const row = db.get()
    .prepare("SELECT COUNT(*) AS c FROM officers WHERE role = 'admin'")
    .get();
  return row.c > 0;
}

// Is there at least one developer account?
function hasDeveloper() {
  const row = db.get()
    .prepare("SELECT COUNT(*) AS c FROM officers WHERE role = 'developer'")
    .get();
  return row.c > 0;
}

function findByOfficerId(officerId) {
  return db.get()
    .prepare('SELECT * FROM officers WHERE officer_id = ?')
    .get(String(officerId).trim());
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
    officer_id: String(officerId).trim(),
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
  if (String(name).trim().length > LIMITS.officerName) return { ok: false, error: `Name must be ${LIMITS.officerName} characters or fewer` };
  if (String(officerId).trim().length > LIMITS.officerId) return { ok: false, error: `Officer ID must be ${LIMITS.officerId} characters or fewer` };
  const pwCheck = validatePassword(password); if (!pwCheck.ok) return pwCheck;
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

  // Provision a one-time break-glass recovery code the operator must save
  // off-device. It is generated exactly once at first admin setup, stored only
  // as a hash, and can never be changed through the app afterwards (so the
  // moment the operator saves it, it becomes the trusted recovery path for a
  // locked-out admin). The plaintext is returned this once for display.
  const recovery = provisionAdminRecoveryCode();
  return { ok: true, officer: publicOfficer(officer), recoveryCode: recovery.code || null };
}

// ---- Recovery code (break-glass for a locked-out admin) ----
// The recovery code is a high-entropy secret issued at first admin setup. A
// forgetful/locked-out admin redeems it (with their officer ID) to reset their
// password directly, without contacting the developer. It is stored only as a
// hash in config (never in the officers table / plaintext), persists for the
// life of the install, and is deliberately NOT changeable through the app so it
// cannot be weaponised to re-claim privilege.
const RECOVERY_CODE_KEY = 'admin_recovery_code';
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function recoveryCodeHash(code) {
  const salt = generateSalt();
  return encodeHash(salt, hashPassword(String(code).trim(), salt));
}

// Whether a recovery code has been provisioned on this machine.
function hasRecoveryCode() {
  return !!db.getConfig(RECOVERY_CODE_KEY);
}

// Generate an unguessable recovery code, store only its hash, and return the
// plaintext (for the single, explicit save-at-setup display).
function provisionAdminRecoveryCode() {
  // Refuse to overwrite / re-issue on a machine that already has one — recovery
  // is a fixed break-glass secret, not a rotating one.
  if (hasRecoveryCode()) return { ok: false, error: 'A recovery code is already provisioned for this machine' };

  const bytes = crypto.randomBytes(12);
  let raw = '';
  for (let i = 0; i < bytes.length; i += 1) {
    raw += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  }
  const code = `REC-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;

  db.setConfig(RECOVERY_CODE_KEY, recoveryCodeHash(code));
  return { ok: true, code };
}

// Verify a submitted recovery code against the provisioned one.
function verifyRecoveryCode(code) {
  const stored = db.getConfig(RECOVERY_CODE_KEY);
  if (!stored) return false;
  const decoded = decodeHash(stored);
  if (!decoded) return false;
  const expected = Buffer.from(decoded.hash, 'hex');
  const actual = Buffer.from(hashPassword(String(code).trim(), decoded.salt), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Reset a privileged account's password using the break-glass recovery code.
// Only admin/developer accounts may be recovered this way; a coordinator or
// assistant (lower privilege) cannot be escalated via recovery.
function resetPasswordByRecovery(officerId, recoveryCode, newPassword) {
  if (!officerId || !recoveryCode) return { ok: false, error: 'Officer ID and recovery code are required' };
  const pwCheck = validatePassword(newPassword); if (!pwCheck.ok) return pwCheck;
  if (!verifyRecoveryCode(recoveryCode)) return { ok: false, error: 'Incorrect recovery code' };

  const officer = findByOfficerId(officerId);
  if (!officer) return { ok: false, error: 'No account found with that officer ID' };
  if (officer.role !== 'admin' && officer.role !== 'developer') {
    return { ok: false, error: 'This account is not privileged enough for recovery. Ask an administrator.' };
  }

  const r = changePassword(officer.id, newPassword);
  if (!r.ok) return r;
  db.setConfig('password_recovered_at', String(Date.now()));
  return { ok: true, officer: publicOfficer(officer) };
}

// Set up a coordinator (legacy / non-admin bootstrap)
function setupCoordinator(name, officerId, password) {
  if (isConfigured()) return { ok: false, error: 'Coordinator already configured' };
  if (!name || !officerId || !password) return { ok: false, error: 'All fields are required' };
  if (String(name).trim().length > LIMITS.officerName) return { ok: false, error: `Name must be ${LIMITS.officerName} characters or fewer` };
  if (String(officerId).trim().length > LIMITS.officerId) return { ok: false, error: `Officer ID must be ${LIMITS.officerId} characters or fewer` };
  const pwCheck = validatePassword(password); if (!pwCheck.ok) return pwCheck;
  const officer = insertOfficer(name, officerId, password, 'coordinator');
  db.setConfig('initialized_at', String(Date.now()));
  return { ok: true, officer: publicOfficer(officer) };
}

// ---- Developer bootstrap (top-level, above admin) ----
// The developer role is deliberately NOT reachable via access codes. It is
// created only here, gated by a dedicated developer key that is provisioned
// independently of the admin setup code. This is the "root" identity that owns
// deep system functions (backups, officer lifecycle, election deletion, access
// codes) which administrators are intentionally stripped from seeing.
const DEVELOPMENT_KEY = 'developer_key';
// The officer ID of the developer account created via the setup key. Only this
// "main developer" may invite further developers with short codes.
const DEVELOPER_ROOT = 'developer_root';

function isRootDeveloper(officerId) {
  return !!officerId && String(officerId) === db.getConfig(DEVELOPER_ROOT);
}

function developmentKeyHash(code) {
  const salt = generateSalt();
  return encodeHash(salt, hashPassword(String(code).trim(), salt));
}

// Whether a developer key has been provisioned on this machine.
function hasDevelopmentKey() {
  return !!db.getConfig(DEVELOPMENT_KEY);
}

// Verify a submitted developer key against the provisioned one.
function verifyDevelopmentKey(code) {
  const stored = db.getConfig(DEVELOPMENT_KEY);
  if (!stored) return false;
  const decoded = decodeHash(stored);
  if (!decoded) return false;
  const expected = Buffer.from(decoded.hash, 'hex');
  const actual = Buffer.from(hashPassword(String(code).trim(), decoded.salt), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Set up the initial developer account (gated by a server-issued dev key).
// The developer channel is private: a machine can ONLY claim developer status
// by presenting a single-use developer key minted by the license server with
// the admin token. A fresh installer cannot choose its own key, and a cloned
// install cannot reuse a key (it is redeemed server-side).
async function setupDeveloper(name, officerId, password, devKey) {
  if (hasDeveloper()) return { ok: false, error: 'A developer account already exists' };
  if (!name || !officerId || !password) return { ok: false, error: 'All fields are required' };
  if (String(name).trim().length > LIMITS.officerName) return { ok: false, error: `Name must be ${LIMITS.officerName} characters or fewer` };
  if (String(officerId).trim().length > LIMITS.officerId) return { ok: false, error: `Officer ID must be ${LIMITS.officerId} characters or fewer` };
  const pwCheck = validatePassword(password); if (!pwCheck.ok) return pwCheck;
  if (findByOfficerId(officerId)) return { ok: false, error: 'Officer ID already in use' };

  const key = String(devKey || '').trim();
  if (!key) return { ok: false, error: 'A developer key issued by the license server is required to set up the developer account' };

  const v = await lic.validateDevKey(key);
  if (!v || !v.ok || !v.valid) {
    return { ok: false, error: (v && v.error) || 'Invalid developer key. Ask the owner to mint a new one from the license server.' };
  }

  const officer = insertOfficer(name, officerId, password, 'developer');
  db.setConfig('developer_claimed_at', String(Date.now()));
  db.setConfig(DEVELOPER_ROOT, officer.id);
  return { ok: true, officer: publicOfficer(officer) };
}

// ---- Developer short codes (main developer invites other developers) ----
// The identity is deliberately NOT grantable via access codes nor via the
// dev-key bootstrap (which only runs once). The main developer issues a short,
// single-use code that an invitee redeems on the sign-in screen to create
// their own developer account. Codes can be revoked at any time until used.

// Issue a short code for a named developer. Main-developer only.
function issueDeveloperCode(actingOfficerId, name) {
  const actor = findById(actingOfficerId);
  if (!actor || actor.role !== 'developer') return { ok: false, error: 'Not authorized' };
  if (!isRootDeveloper(actor.id)) return { ok: false, error: 'Only the main developer can invite another developer' };
  const person = String(name || '').trim();
  if (!person) return { ok: false, error: 'The developer name is required' };

  // Short, unambiguous code (no 0/O/1/I/L), 6 characters.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];

  const salt = generateSalt();
  const record = {
    id: uuidv4(),
    code_hash: encodeHash(salt, hashPassword(code, salt)),
    name: person,
    created_by: actor.id,
    created_at: Date.now(),
  };
  db.get().prepare(`
    INSERT INTO developer_codes (id, code_hash, name, created_by, created_at, redeemed_at, redeemed_by, revoked_at)
    VALUES (@id, @code_hash, @name, @created_by, @created_at, NULL, NULL, NULL)
  `).run(record);
  return { ok: true, code, id: record.id };
}

// List issued developer codes with usage/revocation status (developer-only).
function listDeveloperCodes() {
  return db.get().prepare(`
    SELECT id, name, created_by, created_at, redeemed_at, redeemed_by, revoked_at
    FROM developer_codes ORDER BY created_at DESC
  `).all().map((c) => ({
    ...c,
    status: c.revoked_at ? 'revoked' : (c.redeemed_at ? 'used' : 'active'),
  }));
}

// Revoke an unused developer code (main-developer only).
function revokeDeveloperCode(actingOfficerId, codeId) {
  const actor = findById(actingOfficerId);
  if (!actor || actor.role !== 'developer') return { ok: false, error: 'Not authorized' };
  if (!isRootDeveloper(actor.id)) return { ok: false, error: 'Only the main developer can revoke a developer code' };
  const row = db.get().prepare('SELECT * FROM developer_codes WHERE id = ?').get(codeId);
  if (!row) return { ok: false, error: 'Unknown developer code' };
  if (row.revoked_at) return { ok: true };
  if (row.redeemed_at) return { ok: false, error: 'This code was already redeemed' };
  db.get().prepare('UPDATE developer_codes SET revoked_at = ? WHERE id = ?').run(Date.now(), codeId);
  return { ok: true };
}

// Redeem a developer short code: creates the developer account using the name
// the main developer registered with the code. Single-use and revoked codes
// are rejected. This is a public (unauthenticated) operation like code redemption.
function redeemDeveloperCode({ code, officerId, password, confirmPassword }) {
  const raw = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return { ok: false, error: 'A developer short code is required' };
  if (!officerId || !password) return { ok: false, error: 'All fields are required' };
  const pwCheck = validatePassword(password); if (!pwCheck.ok) return pwCheck;
  if (password !== confirmPassword) return { ok: false, error: 'Password confirmation does not match' };
  if (findByOfficerId(officerId)) return { ok: false, error: 'Officer ID already in use' };

  // Bounded, timing-safe scan over the still-usable codes.
  const candidates = db.get().prepare(
    'SELECT * FROM developer_codes WHERE redeemed_at IS NULL AND revoked_at IS NULL'
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
  if (!match) return { ok: false, error: 'Invalid or revoked developer code' };

  const officer = insertOfficer(match.name, officerId, password, 'developer');
  db.get().prepare('UPDATE developer_codes SET redeemed_at = ?, redeemed_by = ? WHERE id = ?')
    .run(Date.now(), officer.id, match.id);
  return { ok: true, officer: publicOfficer(officer) };
}

// ---- Software licensing (per-site activation via the license server) ----
// Commercial licensing: the developer issues a one-time, revocable activation
// code for a paid site. Codes are validated against the self-hosted license
// server (see server/license-server.js) so a code works on ANY new device and
// can be revoked remotely after redemption. Redemption is recorded locally too
// so the device is licensed even if the server is briefly unreachable.

// Normalize a typed code: strip separators/spaces, uppercase (PVH-8X2K-L7QN).
function normalizeActivationCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Issue an activation code for a paid site (developer-only). Delegates to the
// license server so the code can be redeemed on other devices.
async function issueActivationCode(actingOfficerId, siteName) {
  const actor = findById(actingOfficerId);
  if (!actor || actor.role !== 'developer') return { ok: false, error: 'Not authorized' };
  const site = String(siteName || '').trim();
  if (!site) return { ok: false, error: 'A customer / site name is required' };
  if (!lic.hasServer()) return { ok: false, error: 'License server not configured. Set it in the Developer console.' };
  const res = await lic.mintCode(site);
  return { ok: res.ok, code: res.code, id: res.id, site_name: res.site_name, error: res.error };
}

// List issued activation codes with usage status (developer-only). Live view
// from the server so you always see which sites are activated/revoked.
async function listActivationCodes() {
  if (!lic.hasServer()) return { ok: false, error: 'License server not configured. Set it in the Developer console.', codes: [] };
  const res = await lic.listCodes();
  if (!res.ok) return { ok: false, error: res.error, codes: [] };
  return { ok: true, codes: res.codes || [] };
}

// Mint a single-use developer bootstrap key (developer-only, privileged). Uses
// the license server's admin endpoint so only the owner can provision developer
// accounts on a machine.
async function mintDevKey() {
  if (!lic.hasServer()) return { ok: false, error: 'License server not configured. Set it in the Developer console.' };
  const res = await lic.mintDevKey();
  return { ok: res.ok, key: res.key, id: res.id, error: res.error };
}

// Revoke a license (developer-only). The server marks it revoked, which
// propagates to the device on its next status check. Works on redeemed and
// unredeemed licenses alike (unlike the old local model).
async function revokeActivationCode(actingOfficerId, codeId) {
  const actor = findById(actingOfficerId);
  if (!actor || actor.role !== 'developer') return { ok: false, error: 'Not authorized' };
  if (!lic.hasServer()) return { ok: false, error: 'License server not configured. Set it in the Developer console.' };
  const res = await lic.revokeCode(codeId);
  return { ok: res.ok, id: res.id, revoked: res.revoked, error: res.error };
}

// Redeem an activation code. Public (the code is the credential), like access
// and developer-code redemption. On success the device is licensed for good.
async function redeemLicense({ code }) {
  const raw = normalizeActivationCode(code);
  if (!raw) return { ok: false, error: 'An activation code is required' };

  // A device is only activated once.
  if (db.getConfig('license_code')) return { ok: false, error: 'This device is already activated.' };

  if (!lic.hasServer()) return { ok: false, error: 'License server not configured. Set it in the Developer console.' };

  const res = await lic.redeemLicense({ code });
  if (!res.ok || !res.licensed) {
    return { ok: false, error: res.error || 'Invalid or already-in-use activation code' };
  }

  const machine = lic.machineId();
  db.setConfig('license_code', raw);
  db.setConfig('license_site', res.site || '');
  db.setConfig('license_activated_at', String(Date.now()));
  db.setConfig('license_machine', machine);
  db.setConfig('license_activated_version', currentVersion());
  return { ok: true, site: res.site || '', machine };
}

// Current license state for this device. Re-checks the server so a remote
// revocation takes effect. Falls back to the locally stored license if the
// server is unreachable (see syncStatusForKnownCode below).
async function licenseStatus(runtimeVersion) {
  // Re-activation on version change: the license is bound to the version it was
  // activated under. If the app was upgraded (or the version isn't recorded yet
  // from older releases), clear the stored license so the user must enter their
  // activation code again — verifying a real user on each release. Only enforced
  // when the current app version is actually known.
  const currentVer = (runtimeVersion || '').trim() || currentVersion();
  const activatedVer = db.getConfig('license_activated_version');
  const hasCode = !!db.getConfig('license_code');
  if (currentVer && hasCode && activatedVer !== currentVer) {
    db.setConfig('license_code', '');
    db.setConfig('license_site', '');
    db.setConfig('license_activated_at', '');
    db.setConfig('license_machine', '');
    db.setConfig('license_activated_version', '');
  }

  const code = db.getConfig('license_code');
  const site = db.getConfig('license_site');
  const activatedAtRaw = db.getConfig('license_activated_at');
  const activatedAt = activatedAtRaw ? Number(activatedAtRaw) : null;
  const developerAuthed = hasDeveloper();
  const machine = db.getConfig('license_machine') || lic.machineId();
  const stored = !!code;

  if (!stored && !developerAuthed) {
    return { ok: true, licensed: false, activated: false, developerAuthed, site: null, activatedAt: null, machine };
  }

  // If we hold a code, confirm it is not revoked. Best-effort: on network
  // failure we keep the local state (offline device stays licensed) and mark
  // `confirmed` so the UI can note the check didn't complete.
  let confirmed = false;
  if (code) {
    try {
      const st = await lic.licenseStatus(code);
      if (st && st.ok && typeof st.licensed === 'boolean') {
        confirmed = true;
        if (st.revoked) return { ok: true, licensed: false, activated: false, revoked: true, developerAuthed, site, activatedAt, machine };
      }
    } catch (e) { /* offline — keep local state */ }
  }

  return {
    ok: true,
    licensed: true,
    activated: true,
    developerAuthed,
    site: site || null,
    activatedAt,
    machine,
    confirmed,
  };
}

// ---- Login audit log (track who signs in and from which device) ----
function logLoginAttempt({ officerId, officerName, role, device, ip, success }) {
  try {
    db.get().prepare(`
      INSERT INTO login_audit (id, officer_id, officer_name, role, device, ip, success, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      officerId || null,
      officerName || null,
      role || null,
      device || null,
      ip || null,
      success ? 1 : 0,
      Date.now()
    );
  } catch (e) { /* audit must never break a login */ }
  return { ok: true };
}

// List recent login activity (developer only).
function listLoginAudit(limit = 200) {
  return db.get().prepare(
    'SELECT officer_id, officer_name, role, device, ip, success, created_at FROM login_audit ORDER BY created_at DESC LIMIT ?'
  ).all(Math.max(1, Math.min(Number(limit) || 200, 1000)));
}

// Clear the login audit log (developer only).
function clearLoginAudit() {
  db.get().prepare('DELETE FROM login_audit').run();
  return { ok: true };
}

// ---- One-time privilege codes (operator issues codes to grant access) ----

// developer > admin > location_coordinator > coordinator > assistant.
// A negative rank keeps 'developer' above 'admin' so no admin (or any other
// role) can ever issue a developer privilege — it is only bootstrap-able.
const ROLE_ORDER = { developer: -1, admin: 0, location_coordinator: 1, coordinator: 2, assistant: 3 };
function privilegeAllows(actor, priv) {
  const a = ROLE_ORDER[actor] == null ? 99 : ROLE_ORDER[actor];
  const p = ROLE_ORDER[priv];
  if (p == null) return false;
  // An actor can only issue a privilege equal to or below their own standing,
  // so a coordinator cannot mint an admin (prevents privilege escalation),
  // and not even an admin can mint a developer.
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
  const pwCheck = validatePassword(password); if (!pwCheck.ok) return pwCheck;
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
  if (String(name).trim().length > LIMITS.officerName) return { ok: false, error: `Name must be ${LIMITS.officerName} characters or fewer` };
  if (String(officerId).trim().length > LIMITS.officerId) return { ok: false, error: `Officer ID must be ${LIMITS.officerId} characters or fewer` };
  const pwCheck = validatePassword(password); if (!pwCheck.ok) return pwCheck;
  if (!['coordinator', 'assistant'].includes(role)) role = 'coordinator';
  if (findByOfficerId(officerId)) return { ok: false, error: 'Officer ID already in use' };

  const officer = insertOfficer(name, officerId, password, role);
  return { ok: true, officer: publicOfficer(officer) };
}

// Remove a coordinator/assistant (cannot remove admins, developers, or yourself)
function removeOfficer(id, actingId) {
  const row = db.get().prepare('SELECT * FROM officers WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Account not found' };
  if (row.role === 'admin') return { ok: false, error: 'Cannot remove an admin account' };
  if (row.role === 'developer') return { ok: false, error: 'Cannot remove the developer account' };
  if (row.id === actingId) return { ok: false, error: 'You cannot remove your own account' };
  db.get().prepare('DELETE FROM officers WHERE id = ?').run(id);
  return { ok: true };
}

// Suspend or activate a coordinator/assistant (cannot suspend admins/devs)
function setSuspended(id, suspended) {
  const row = db.get().prepare('SELECT * FROM officers WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Account not found' };
  if (row.role === 'admin') return { ok: false, error: 'Cannot suspend an admin account' };
  if (row.role === 'developer') return { ok: false, error: 'Cannot suspend the developer account' };
  db.get().prepare('UPDATE officers SET suspended = ? WHERE id = ?').run(suspended ? 1 : 0, id);
  return { ok: true, officer: publicOfficer(db.get().prepare('SELECT * FROM officers WHERE id = ?').get(id)) };
}

// Change an officer's password (admin for others, or any officer for themselves)
function changePassword(id, newPassword) {
  const pwCheck = validatePassword(newPassword); if (!pwCheck.ok) return pwCheck;
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

// Validate a session token and return the acting officer, or null. Every
// caller MUST pass the originating webContents id (`senderId`): a token is only
// valid from the exact renderer that minted it, so a token stolen from one
// window can never be replayed from another. Sessions are always created bound
// to a sender, but even a defensive null-bound token requires a senderId here.
function validateSession(token, senderId) {
  if (!token || typeof token !== 'string') return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (senderId == null) return null;
  if (s.senderId != null && s.senderId !== senderId) return null;
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
  hasDeveloper,
  canAccessDeveloperBootstrap,
  hasSetupCode,
  setupAdmin,
  setupCoordinator,
  setupDeveloper,
  hasDevelopmentKey,
  verifyDevelopmentKey,
  logLoginAttempt,
  listLoginAudit,
  clearLoginAudit,
  isRootDeveloper,
  issueDeveloperCode,
  listDeveloperCodes,
  revokeDeveloperCode,
  redeemDeveloperCode,
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
  issueActivationCode,
  listActivationCodes,
  revokeActivationCode,
  mintDevKey,
  redeemLicense,
  licenseStatus,
  hasRecoveryCode,
  provisionAdminRecoveryCode,
  resetPasswordByRecovery,
  createSession,
  validateSession,
  revokeSession,
  sessionTokenFor,
};
