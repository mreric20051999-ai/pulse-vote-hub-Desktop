const { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');

// Fix the user-data path so dev runs (`npx electron .`) resolve to the same
// directory as the packaged app; otherwise dev defaults to the "Electron" dir
// and loads a stale, separate database.
app.setName('pulse-vote-hub-desktop');

// Two-instance LAN testing override: point this instance at an isolated data
// directory (e.g. PVH_USER_DATA=/tmp/pvh-client) so two processes share one
// network but keep separate databases and device identities.
if (process.env.PVH_USER_DATA) {
  app.setPath('userData', process.env.PVH_USER_DATA);
}

const db = require('./db');
const auth = require('./auth');
const election = require('./election');
const voter = require('./voter');
const station = require('./station');
const results = require('./results');
const merge = require('./merge');
const messages = require('./messages');
const distribution = require('./distribution');
const checkInLink = require('./checkin-link');
const vault = require('./vault');
const locationPack = require('./location');
const { LanManager } = require('./lan');
const backup = require('./backup');

let lan = null;
function getLan() {
  if (!lan) lan = new LanManager({ getD: () => db.get(), version: app.getVersion(), rendererDir });
  return lan;
}

let mainWindow = null;
let splashWindow = null;
let isKiosk = false;

// The sign-in / setup screen opens at the normal full desktop size, but the
// window is locked down (non-resizable, no maximize) so its layout never
// reflows or auto-resizes after install. App pages keep the same size but a
// resizable window.
const FIXED_WIN = { width: 1280, height: 800 };
const APP_MIN = { width: 1024, height: 680 };

// Resolve the renderer directory for both dev and packaged builds
function rendererDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'renderer')
    : path.join(__dirname, '..', 'renderer');
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 760,
    height: 560,
    frame: false,
    transparent: false,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.loadFile(path.join(rendererDir(), 'splash.html'));
  splashWindow.once('ready-to-show', () => {
    splashWindow.show();
  });
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

// The sign-in / setup screen runs in a fixed, non-resizable window so its
// layout never reflows or auto-resizes after install. App pages restore a
// resizable window automatically.
function syncWindowToPage(page) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const auth = page === 'index.html' || page === '';
  try {
    if (auth) {
      // Full desktop size, but frozen: cannot be resized or maximized.
      mainWindow.setResizable(false);
      mainWindow.setMinimumSize(FIXED_WIN.width, FIXED_WIN.height);
      mainWindow.setMaximumSize(FIXED_WIN.width, FIXED_WIN.height);
      mainWindow.setSize(FIXED_WIN.width, FIXED_WIN.height);
      mainWindow.center();
    } else {
      mainWindow.setResizable(true);
      mainWindow.setMinimumSize(APP_MIN.width, APP_MIN.height);
      mainWindow.setMaximumSize(10000, 10000);
      const [w, h] = mainWindow.getSize();
      if (w < APP_MIN.width || h < APP_MIN.height) {
        mainWindow.setSize(FIXED_WIN.width, FIXED_WIN.height);
        mainWindow.center();
      }
    }
  } catch (e) { /* noop */ }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: getComputedBg(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Kiosk lockdown: swallow reload / devtools / close / fullscreen shortcuts
  // while a kiosk screen (vote.html) is active in this window.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!isKiosk) return;
    const key = String(input.key || '').toLowerCase();
    const mod = input.control || input.meta || input.alt;
    if (mod && ['r', 'w', 'q', 'i', 'j', 'u', '+', '-', '0'].includes(key)) event.preventDefault();
    else if (['f11', 'f5', 'f7', 'f12', 'escape'].includes(key)) event.preventDefault();
  });

  // Keep the window in the right mode per page: fixed, non-resizable size on
  // the sign-in / setup screen, resizable for the app. Re-runs on navigation.
  const onNavigate = (_ev, url) => {
    let page = '';
    try { page = new URL(url).pathname.split('/').pop() || ''; } catch (e) { page = ''; }
    syncWindowToPage(page || 'index.html');
  };
  mainWindow.webContents.on('did-navigate', onNavigate);
  mainWindow.webContents.on('did-navigate-in-page', onNavigate);

  mainWindow.loadFile(path.join(rendererDir(), 'index.html'));

  mainWindow.once('ready-to-show', () => {
    // Hold the fixed sign-in size before first paint so there's no resize flash.
    syncWindowToPage('index.html');
    // Let splash show first, then tear down after a beat
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      mainWindow.show();
    }, 2000);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function getComputedBg() {
  // Match the dark default in styles.css to avoid white flash
  return isKiosk ? '#0f172a' : '#0f172a';
}

app.whenReady().then(() => {
  try {
    db.init();
  } catch (err) {
    console.error('Database init failed:', err);
  }

  // LAN networking: restore the persisted mode (host/client) from last run and
  // forward live sync status to whichever window is focused. The broadcast is
  // sanitized: the network secret is only disclosed on demand through the
  // admin-gated `lan:status` IPC, never pushed to every (splash) window.
  getLan().onStatus((status) => {
    const s = (status && typeof status === 'object') ? Object.assign({}, status) : status;
    if (s && typeof s === 'object' && 'secret' in s) delete s.secret;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lan:status', s);
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send('lan:status', s);
  });
  getLan().resume().catch((err) => console.error('LAN resume failed:', err));

  // Automatic backup: configure (db + lan for safe restores), then run the
  // due-check scheduler in the background.
  backup.configure({ db, lan: getLan() });
  backup.setUserData(app.getPath('userData'));
  backup.startScheduler();

  // Auto-update: packaged installs check the GitHub release feed on launch and
  // periodically, so users upgrade in place without manual downloads. Dev runs
  // (npx electron .) skip this entirely.
  try { require('./updater').startAutoUpdate(); } catch (err) { console.error('[updater] start failed:', err.message); }

  createSplashWindow();
  setTimeout(createMainWindow, 600);

  // Verify the vote + audit hash chains and SQLite page integrity at startup.
  try {
    const check = integrity.verifyAll();
    if (check.ok) console.log('[integrity] all checks passed', JSON.stringify({ votes: check.voteChain.rows, audit: check.auditChain.rows }));
    else console.error('[integrity] verification FAILED at startup:', JSON.stringify(check));
  } catch (err) { console.error('[integrity] startup check failed:', err.message); }

  // Auto-transition elections by schedule (start_date/end_date) every minute.
  try { election.applySchedule(); } catch (err) { console.error('applySchedule init failed:', err); }
  setInterval(() => {
    try { election.applySchedule(); } catch (err) { console.error('applySchedule failed:', err); }
  }, 60 * 1000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('before-quit', () => {
  try { getLan().stop(); } catch (err) { /* noop */ }
  try {
    // If automatic backup is enabled, take one final snapshot on close so
    // election-day data is safe the moment the app exits.
    if (db.getConfig && db.getConfig('auto_backup_enabled') === '1') {
      backup.runBackup().catch(() => { /* noop */ });
    }
    // Append a close-time audit marker, then verify the chains once more so the
    // audit entry itself leaves a verifiable record of when the app last ran.
    election.audit('system', 'Application shutdown');
    const check = integrity.verifyAll();
    if (!check.ok) console.error('[integrity] verification failed at shutdown:', JSON.stringify({ votes: check.voteChain, audit: check.auditChain, pragma: check.pragma }));
  } catch (err) { /* noop */ }
});

app.on('will-quit', () => {
  try { getLan().stop(); } catch (err) { /* noop */ }
});

// ---------- IPC ----------

ipcMain.handle('platform:info', () => ({
  platform: process.platform,
  version: app.getVersion(),
  isPackaged: app.isPackaged,
}));

ipcMain.handle('theme:get', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
ipcMain.handle('theme:set', (_e, theme) => {
  if (theme === 'dark' || theme === 'light') {
    nativeTheme.themeSource = theme;
  } else {
    nativeTheme.themeSource = 'system';
  }
  return theme === 'dark' || theme === 'light' ? theme : 'system';
});

ipcMain.handle('db:init', () => {
  try {
    db.init();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:stats', (_e, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  // Developer supersedes the admin role, so both see the whole-org summary.
  const isAdmin = actor && (actor.role === 'admin' || actor.role === 'developer');
  const d = db.get();
  const row = isAdmin
    ? d.prepare(`
        SELECT
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)    AS active,
          SUM(CASE WHEN status = 'upcoming' THEN 1 ELSE 0 END)  AS upcoming,
          SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END)     AS draft,
          SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END)    AS closed
        FROM elections
      `).get()
    : (actor && actor.id
        ? d.prepare(`
            SELECT
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)    AS active,
              SUM(CASE WHEN status = 'upcoming' THEN 1 ELSE 0 END)  AS upcoming,
              SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END)     AS draft,
              SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END)    AS closed
            FROM elections
            WHERE owner_id = ?
          `).get(actor.id)
        : { active: 0, upcoming: 0, draft: 0, closed: 0 });
  // Voter / cast / vote totals are scoped to what the actor can actually see:
  // admins + developers get the whole-org count, coordinators only the voters
  // inside elections they own (respecting coordinator isolation — a coordinator
  // must not learn org-wide turnout or register size through this endpoint).
  const counts = isAdmin
    ? {
        voters: d.prepare('SELECT COUNT(*) AS c FROM voters').get().c || 0,
        cast: d.prepare('SELECT COUNT(*) AS c FROM voters WHERE has_voted = 1').get().c || 0,
        votes: d.prepare('SELECT COUNT(*) AS c FROM votes').get().c || 0,
      }
    : (actor && actor.id
        ? {
            voters: d.prepare('SELECT COUNT(*) AS c FROM voters WHERE election_id IN (SELECT id FROM elections WHERE owner_id = ?)').get(actor.id).c || 0,
            cast: d.prepare('SELECT COUNT(*) AS c FROM voters WHERE has_voted = 1 AND election_id IN (SELECT id FROM elections WHERE owner_id = ?)').get(actor.id).c || 0,
            votes: d.prepare('SELECT COUNT(*) AS c FROM votes WHERE election_id IN (SELECT id FROM elections WHERE owner_id = ?)').get(actor.id).c || 0,
          }
        : { voters: 0, cast: 0, votes: 0 });
  const voters = counts.voters;
  const cast = counts.cast;
  const votes = counts.votes;
  const officers = auth.listOfficers();
  const admins = officers.filter((o) => o.role === 'admin' || o.role === 'developer').length;
  const coords = officers.filter((o) => o.role !== 'admin' && o.role !== 'developer').length;
  const totalElections = (row.active || 0) + (row.upcoming || 0) + (row.draft || 0) + (row.closed || 0);
  return {
    active: row.active || 0,
    upcoming: row.upcoming || 0,
    draft: row.draft || 0,
    closed: row.closed || 0,
    totalElections,
    voters,
    cast,
    votes,
    turnout: voters ? Math.round((cast / voters) * 100) : 0,
    admins,
    coords,
    officers: officers.length,
  };
});

// Active (voting) elections with their live counts, for the dashboard summary.
ipcMain.handle('db:active-elections', (_e, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  const d = db.get();
  const isAdmin = actor && (actor.role === 'admin' || actor.role === 'developer');
  const rows = !isAdmin
    ? d.prepare(`
        SELECT e.id, e.title, e.type, e.status, e.owner_id,
          (SELECT COUNT(*) FROM positions p WHERE p.election_id = e.id) AS positions,
          (SELECT COUNT(*) FROM candidates c WHERE c.election_id = e.id) AS candidates,
          (SELECT COUNT(*) FROM voters v WHERE v.election_id = e.id) AS voters,
          (SELECT COUNT(*) FROM voters v WHERE v.election_id = e.id AND v.has_voted = 1) AS cast
        FROM elections e
        WHERE e.status = 'active' AND e.owner_id = ?
        ORDER BY e.created_at DESC
      `).all(actor.id)
    : d.prepare(`
        SELECT e.id, e.title, e.type, e.status, e.owner_id,
          (SELECT COUNT(*) FROM positions p WHERE p.election_id = e.id) AS positions,
          (SELECT COUNT(*) FROM candidates c WHERE c.election_id = e.id) AS candidates,
          (SELECT COUNT(*) FROM voters v WHERE v.election_id = e.id) AS voters,
          (SELECT COUNT(*) FROM voters v WHERE v.election_id = e.id AND v.has_voted = 1) AS cast
        FROM elections e
        WHERE e.status = 'active'
        ORDER BY e.created_at DESC
      `).all();
  return rows;
});

ipcMain.handle('auth:setup-check', () => auth.isConfigured());
ipcMain.handle('auth:has-admin', () => auth.hasAdmin());
ipcMain.handle('auth:has-developer', () => auth.hasDeveloper());
ipcMain.handle('auth:can-developer-bootstrap', () => auth.canAccessDeveloperBootstrap());
ipcMain.handle('auth:has-dev-key', () => auth.hasDevelopmentKey());

ipcMain.handle('auth:setup', (_e, { name, officerId, password }) => {
  try {
    return auth.setupCoordinator(name, officerId, password);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:setup-admin', (_e, { name, officerId, password, setupCode, confirmSetupCode }) => {
  try {
    return auth.setupAdmin(name, officerId, password, setupCode, confirmSetupCode);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Recover a locked-out admin password via the break-glass recovery code issued
// at first admin setup. Public (the recovery code is the credential), so it is
// rate-limited per device to stop brute-forcing.
ipcMain.handle('auth:recover-password', (_e, { officerId, recoveryCode, newPassword }) => {
  try {
    const rl = recoveryResetLimit(_e.sender.id);
    if (!rl.ok) {
      return { ok: false, error: `Too many recovery attempts on this device. Try again in a minute.`, code: 'rate-limit', retryAfterMs: rl.retryAfterMs };
    }
    return auth.resetPasswordByRecovery(officerId, recoveryCode, newPassword);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:setup-developer', async (_e, { name, officerId, password, devKey }) => {
  try {
    return await auth.setupDeveloper(name, officerId, password, devKey);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:has-setup-code', () => auth.hasSetupCode());

// Whether a break-glass recovery code exists on this machine (drives whether
// the login screen offers "Forgot password?", and the setup-time save prompt).
ipcMain.handle('auth:has-recovery-code', () => auth.hasRecoveryCode());

// Login — on every attempt, record an audit entry tied to this machine so a
// developer can review who signed in from which device.
ipcMain.handle('auth:login', (_e, { officerId, password }) => {
  try {
    const res = auth.attemptLogin(officerId, password);
    const device = os.hostname() || 'This computer';
    if (!res.ok) {
      auth.logLoginAttempt({ officerId, role: null, device, success: false });
      return res;
    }
    if (res.officer.suspended) {
      auth.logLoginAttempt({ officerId: res.officer.officer_id, officerName: res.officer.name, role: res.officer.role, device, success: false });
      return { ok: false, error: 'This account has been suspended. Contact the administrator.', code: 'suspended' };
    }
    // Mint an opaque session token bound to THIS webContents. The renderer must
    // present this token (instead of an officer id) on every privileged call,
    // and the binding means it can never be replayed from a different window.
    const token = auth.createSession(res.officer, _e.sender.id);
    auth.logLoginAttempt({ officerId: res.officer.officer_id, officerName: res.officer.name, role: res.officer.role, device, success: true });
    return { ok: true, officer: stripSecret(res.officer), session: { token } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- Integrity verification (hash chains + PRAGMA integrity_check) ----

const integrity = require('./integrity');
let lastIntegrity = null;
const integrityStatus = () => {
  try { lastIntegrity = integrity.verifyAll(); } catch (err) { lastIntegrity = { ok: false, error: err.message, checkedAt: Date.now() }; }
  return lastIntegrity;
};

ipcMain.handle('integrity:verify', () => integrityStatus());

// ---- Kiosk lockdown (public voting screens) ----

ipcMain.handle('kiosk:enter', () => {
  isKiosk = true;
  try { mainWindow.setMenuBarVisibility(false); } catch (e) { /* noop */ }
  try { mainWindow.setFullScreen(true); } catch (e) { /* noop */ }
  return { ok: true };
});

ipcMain.handle('kiosk:exit', () => {
  isKiosk = false;
  try { mainWindow.setMenuBarVisibility(true); } catch (e) { /* noop */ }
  try { mainWindow.setFullScreen(false); } catch (e) { /* noop */ }
  return { ok: true };
});

// ---- Admin / superuser IPC ----
// Every admin operation requires a valid session token whose owner has the
// admin role AND must originate from the app window. Without this a non-admin
// (or a malicious script) can never create admins or change passwords.
// The developer role outranks admin, so requireAdmin admits both.

// A signed-in session has gone stale in the main process (expired, superseded,
// or the app restarted so the in-memory session map is empty) even though the
// renderer still holds a token in localStorage. Tell that window to re-authenticate
// instead of letting the user stare at a bare "Not signed in" on a private action.
function notifySessionExpired(event) {
  try {
    if (event && event.sender && !event.sender.isDestroyed()) {
      event.sender.send('auth:session-expired');
    }
  } catch (e) { /* best effort */ }
}

function requireAdmin(token, event) {
  if (!senderIsApp(event)) return { ok: false, error: 'Unauthorized', code: 'forbidden' };
  const actor = resolveActor(token, event.sender.id);
  if (!actor) { notifySessionExpired(event); return { ok: false, error: 'Not signed in', code: 'forbidden' }; }
  if (actor.role !== 'admin' && actor.role !== 'developer') return { ok: false, error: 'Requires admin access', code: 'forbidden' };
  return { ok: true, actor };
}

// Strict guard for features reserved to the top-level developer role (deep
// system operations and the developer section that admins no longer see).
function requireDeveloper(token, event) {
  if (!senderIsApp(event)) return { ok: false, error: 'Unauthorized', code: 'forbidden' };
  const actor = resolveActor(token, event.sender.id);
  if (!actor) { notifySessionExpired(event); return { ok: false, error: 'Not signed in', code: 'forbidden' }; }
  if (actor.role !== 'developer') return { ok: false, error: 'Requires developer access', code: 'forbidden' };
  return { ok: true, actor };
}

// Any signed-in officer may manage their OWN elections (ownership is enforced
// inside the election functions via canAccessElection). This deliberately does
// NOT require admin/developer so coordinators and assistants can delete and
// recover elections they created.
function requireSignedIn(token, event) {
  if (!senderIsApp(event)) return { ok: false, error: 'Unauthorized', code: 'forbidden' };
  const actor = resolveActor(token, event.sender.id);
  if (!actor) { notifySessionExpired(event); return { ok: false, error: 'Not signed in', code: 'forbidden' }; }
  return { ok: true, actor };
}

ipcMain.handle('admin:officers', (e, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  return auth.listOfficers();
});
ipcMain.handle('admin:add-officer', (e, payload, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  try { return auth.addOfficer(payload); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('admin:remove-officer', (e, payload, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  try { return auth.removeOfficer(payload.id, payload.actingId); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('admin:set-suspended', (e, payload, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  try { return auth.setSuspended(payload.id, payload.suspended); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('admin:change-password', (e, payload, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  try { return auth.changePassword(payload.id, payload.newPassword); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('admin:assign-station', (e, payload, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  try { return auth.assignStationOfficer(payload.officerId, payload.stationId, payload.electionId); } catch (err) { return { ok: false, error: err.message }; }
});

// ---- One-time privilege codes ----

// Redeeming a code needs no session (the invitee is not signed in yet).
ipcMain.handle('auth:redeem-code', (_e, payload) => {
  try { return auth.redeemSetupCode(payload); } catch (err) { return { ok: false, error: err.message }; }
});

// Listing and issuing codes are developer-only (moved out of the admin UI;
// admins no longer see or can mint access codes).
ipcMain.handle('admin:list-codes', (e, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  try { return auth.listSetupCodes(); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('admin:issue-code', (e, privilege, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  try { return auth.issueSetupCode(r.actor.id, privilege); } catch (err) { return { ok: false, error: err.message }; }
});

// ---- Login audit (developer-only) ----
ipcMain.handle('dev:list-login-audit', (e, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  try { return auth.listLoginAudit(); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('dev:clear-login-audit', (e, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  try { return auth.clearLoginAudit(); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('dev:development-key-status', (e, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  return { ok: true, provisioned: auth.hasDevelopmentKey() };
});

// ---- Developer short codes (main developer invites other developers) ----
ipcMain.handle('dev:issue-developer-code', (e, name, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  try { return auth.issueDeveloperCode(r.actor.id, name); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('dev:list-developer-codes', (e, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  try { return auth.listDeveloperCodes(); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('dev:revoke-developer-code', (e, id, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  try { return auth.revokeDeveloperCode(r.actor.id, id); } catch (err) { return { ok: false, error: err.message }; }
});
// Redeeming a developer short code is public (no session required): the code
// itself is the credential that creates the developer account.
ipcMain.handle('auth:redeem-developer-code', (_e, payload) => {
  try { return auth.redeemDeveloperCode(payload || {}); } catch (err) { return { ok: false, error: err.message }; }
});

// ---- Software licensing (per-site activation codes) ----
// License state is public (any window can ask). Issuing/listing/revoking are
// developer-only. Redemption is public — the code is the credential.
ipcMain.handle('lic:status', async () => {
  try { return await auth.licenseStatus(app.getVersion()); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('lic:issue', async (e, siteName, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  try { return await auth.issueActivationCode(r.actor.id, siteName); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('lic:list', async (e, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  try { return await auth.listActivationCodes(); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('lic:revoke', async (e, id, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  try { return await auth.revokeActivationCode(r.actor.id, id); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('lic:redeem', async (_e, payload) => {
  try { return await auth.redeemLicense(payload || {}); } catch (err) { return { ok: false, error: err.message }; }
});

// Mint a single-use developer bootstrap key (developer-only). The returned key
// (DVK-...) is what a machine presents in the developer setup to claim the
// developer account. Minted only with the admin token on the license server.
ipcMain.handle('lic:devkey', async (e, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  try { return await auth.mintDevKey(); } catch (err) { return { ok: false, error: err.message }; }
});

// Read/write the license server config (developer-only). The URL points at the
// self-hosted server; the token authorizes mint/list/revoke on it.
ipcMain.handle('lic:server-config', (e, token) => {
  const auth2 = requireDeveloper(token, e);
  if (!auth2.ok) return auth2;
  const cfg = require('./license-client').serverConfig();
  return { ok: true, url: cfg.url, hasToken: !!cfg.token };
});
ipcMain.handle('lic:server-config-set', (e, payload, token) => {
  const auth2 = requireDeveloper(token, e);
  if (!auth2.ok) return auth2;
  const { url, adminToken } = payload || {};
  if (url !== undefined && url !== null && String(url || '').trim()) {
    try {
      const u = new URL(String(url).trim());
      if (!['https:', 'http:'].includes(u.protocol)) return { ok: false, error: 'License server URL must start with http(s)://' };
    } catch (err) {
      return { ok: false, error: 'License server URL is invalid' };
    }
    if (String(url).trim().length > 500) return { ok: false, error: 'License server URL is too long' };
  }
  if (adminToken !== undefined && adminToken !== null && String(adminToken).length > 500) {
    return { ok: false, error: 'Admin token is too long' };
  }
  db.setConfig('lic_server', String(url || '').trim());
  db.setConfig('lic_server_token', String(adminToken || '').trim());
  return { ok: true };
});

// ---- Safety kill-switch (developer only) ----
// The developer can terminate the application immediately when suspicious
// activity is suspected. The action is recorded in the login audit trail
// before the app quits so there is a trace of who ordered the shutdown.
ipcMain.handle('dev:terminate-app', (e, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  try {
    auth.logLoginAttempt({
      officerId: r.actor.officer_id,
      officerName: r.actor.name,
      role: 'developer',
      device: os.hostname(),
      ip: null,
      success: true,
    });
  } catch (err) { /* never block a kill-switch on audit failure */ }
  // Let the IPC response reach the renderer, then quit promptly.
  setTimeout(() => app.quit(), 350);
  return { ok: true, message: 'Application is shutting down.' };
});

// ---- Backup / export IPC ----

// Backup the entire database (a synchronized copy of the SQLite file).
// Full-database backup + restore safeguard election data; open to any
// administrator or developer (not coordinators), so an election supervisor can
// protect/recover data mid-election without a developer present.
ipcMain.handle('backup:database', async (e, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  const src = db.getDbPath();
  const defaultName = `pulse-vote-hub-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`;
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Backup Database',
    defaultPath: defaultName,
    filters: [{ name: 'SQLite Database', extensions: ['db'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, error: 'Backup cancelled' };
  try {
    fs.copyFileSync(src, res.filePath);
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Build a portable election snapshot: the election config plus its
// positions, candidates, voters and encrypted vote log. This is the format the
// Multi-Location Merge tool consumes from each polling location.
function buildElectionSnapshot(electionId) {
  const d = db.get();
  const e = election.getElection(electionId);
  if (!e) return null;
  e.status = election.computedStatus(e);
  const positions = d.prepare('SELECT id, election_id, title, max_votes FROM positions WHERE election_id = ?').all(electionId);
  const candidates = d.prepare('SELECT id, election_id, position_id, name, photo_path, ballot_number, sort_order FROM candidates WHERE election_id = ?').all(electionId);
  const voters = d.prepare(
    'SELECT voter_id, name, assigned_station, has_voted, ballot_cast, voted_at FROM voters WHERE election_id = ?'
  ).all(electionId);
  const votes = d.prepare(
    'SELECT position_id, candidate_id, voter_id, station_id, timestamp FROM votes WHERE election_id = ? ORDER BY timestamp, id'
  ).all(electionId);
  return {
    schema: 'pulse-vote-hub-election',
    schema_version: 1,
    exported_at: Date.now(),
    exporter: 'pulse-vote-hub-desktop',
    election: e,
    positions,
    candidates,
    voters,
    votes,
  };
}

// Export a single election (its config + all data) as a JSON snapshot.
ipcMain.handle('backup:election', async (e, electionId, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  const eid = electionId;
  if (!eid) return { ok: false, error: 'Election not found' };
  const electionRec = election.getElection(eid);
  if (!electionRec) return { ok: false, error: 'Election not found' };
  const snapshot = buildElectionSnapshot(eid);
  const defaultName = `election-${(electionRec.title || 'export').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Election',
    defaultPath: defaultName,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, error: 'Export cancelled' };
  try {
    fs.writeFileSync(res.filePath, JSON.stringify(snapshot, null, 2));
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- Automatic backup & restore ----
// Available to any admin or developer so an election supervisor can back up
// and restore election data mid-election (a developer is NOT required).

// Read the current automatic-backup state (schedule settings + list of
// existing snapshots).
ipcMain.handle('backup:auto-get', (e, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  try { return { ok: true, settings: backup.getSettings() }; } catch (err) { return { ok: false, error: err.message }; }
});

// Persist schedule + retention settings (and switch the backup folder).
ipcMain.handle('backup:auto-save', (e, settings, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  try { return { ok: true, settings: backup.saveSettings(settings) }; } catch (err) { return { ok: false, error: err.message }; }
});

// Force a backup right now (ignores the schedule).
ipcMain.handle('backup:auto-now', async (e, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  try { return await backup.runNow(); } catch (err) { return { ok: false, error: err.message }; }
});

// Restore a previously-saved automatic backup. Verifies it, pauses LAN, swaps
// the DB, re-verifies, and rolls back on any failure.
ipcMain.handle('backup:auto-restore', async (e, filePath, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'No backup selected.' };
  try { return await backup.restore(filePath.replace(/^file:\/\//, '')); } catch (err) { return { ok: false, error: err.message }; }
});

// Pick a folder for automatic backups (e.g. a USB drive).
ipcMain.handle('backup:auto-pick-dir', async (e, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose backup folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, error: 'Pick cancelled' };
  return { ok: true, path: res.filePaths[0] };
});

// Restore the database from an arbitrarily-chosen backup .db file (e.g. copied
// from another machine), using the same verify/pause/swap/rollback safety as
// the saved-list restore. This handler only picks the file; the renderer
// confirms, then calls backup:auto-restore with the returned path.
ipcMain.handle('backup:restore-file', async (e, token) => {
  const r = requireAdmin(token, e);
  if (!r.ok) return r;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Restore database from file',
    properties: ['openFile'],
    filters: [
      { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, error: 'Restore cancelled', canceled: true };
  const p = res.filePaths[0];
  if (!fs.existsSync(p)) return { ok: false, error: 'Backup file not found.' };
  return { ok: true, path: p, name: path.basename(p) };
});

// Import a portable election snapshot (JSON) that was previously exported.
// Creates the election with its positions, candidates and voters in this
// database. Votes are re-inserted so an exported election is fully recoverable.
ipcMain.handle('backup:election-import', async (e, token) => {
  const r = requireDeveloper(token, e);
  if (!r.ok) return r;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Import election snapshot',
    properties: ['openFile'],
    filters: [{ name: 'Election Snapshot (JSON)', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, error: 'Import cancelled', canceled: true };
  const filePath = res.filePaths[0];
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { ok: false, error: 'The chosen file is not valid JSON: ' + err.message };
  }
  if (!doc || doc.schema !== 'pulse-vote-hub-election') return { ok: false, error: 'This is not a Pulse Vote Hub election snapshot.' };
  const d = db.get();
  const snap = doc;
  const now = Date.now();
  const actor = r.actor;

  // Bounds guard: a malicious or corrupted snapshot must not be able to exhaust
  // memory or stall the app by declaring absurd array sizes (DoS via file).
  const cap = (arr, max, label) => {
    if (!Array.isArray(arr)) return { ok: true, n: 0 };
    if (arr.length > max) return { ok: false, error: `Snapshot has too many ${label} (max ${max}).` };
    return { ok: true, n: arr.length };
  };
  const bounds = [
    ['positions', 50000, 'positions'],
    ['candidates', 250000, 'candidates'],
    ['voters', 1000000, 'voters'],
    ['votes', 2000000, 'votes'],
  ];
  const counts = {};
  for (const [key, max, label] of bounds) {
    const c = cap(snap[key], max, label);
    if (!c.ok) return { ok: false, error: c.error };
    counts[key] = c.n;
  }

  const eid = (snap.election && snap.election.id) || null;

  if (eid && db.prepare('SELECT id FROM elections WHERE id = ?').get(eid)) {
    return { ok: false, error: 'An election with the same ID already exists in this database. Delete it first or rename the snapshot.' };
  }
  const assignedEid = eid || uuid();

  const tx = d.transaction(() => {
    db.prepare('INSERT INTO elections (id, title, type, status, election_date, start_date, end_date, owner_id, station_mode, close_grace_minutes, max_close_grace_minutes, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        assignedEid,
        String((snap.election && snap.election.title) || 'Imported election').trim().slice(0, 300),
        (snap.election && ['school', 'station'].includes(snap.election.type)) ? snap.election.type : 'school',
        'draft',
        snap.election && snap.election.election_date ? Number(snap.election.election_date) : now,
        snap.election && snap.election.start_date ? Number(snap.election.start_date) : now,
        snap.election && snap.election.end_date ? Number(snap.election.end_date) : null,
        actor.id,
        (snap.election && snap.election.station_mode) ? 1 : 0,
        Math.max(0, Math.min(Number((snap.election && snap.election.close_grace_minutes)) || 30, 1440)),
        Math.max(1, Math.min(Number((snap.election && snap.election.max_close_grace_minutes)) || 120, 10080)),
        now,
        snap.election && snap.election.closed_at ? Number(snap.election.closed_at) : null
      );

    const realEid = assignedEid;
    const insPos = db.prepare('INSERT INTO positions (id, election_id, title, max_votes) VALUES (?, ?, ?, ?)');
    for (const p of (snap.positions || [])) {
      insPos.run(p && p.id ? String(p.id).slice(0, 64) : uuid(), realEid, String((p && p.title) || 'Position').trim().slice(0, 300), Math.max(1, Math.min(Number(p && p.max_votes) || 1, 100)));
    }
    const insCand = db.prepare('INSERT INTO candidates (id, election_id, position_id, name, photo_path, ballot_number, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const c of (snap.candidates || [])) {
      insCand.run(c && c.id ? String(c.id).slice(0, 64) : uuid(), realEid, c && c.position_id ? String(c.position_id).slice(0, 64) : null, String((c && c.name) || '').trim().slice(0, 300) || 'Candidate', c && c.photo_path ? String(c.photo_path).slice(0, 1000) : null, c && c.ballot_number != null ? Number(c.ballot_number) : null, c && c.sort_order != null ? Number(c.sort_order) : null);
    }
    const insVoter = db.prepare('INSERT INTO voters (id, election_id, voter_id, name, password_hash, password_salt, assigned_station, has_voted, ballot_cast, voted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    let v = 0;
    for (const voter of (snap.voters || [])) {
      v++;
      const vid = String((voter && voter.voter_id) || ('V' + String(v).padStart(6, '0'))).trim().toUpperCase().slice(0, 64);
      const salt = crypto.randomBytes(16).toString('hex');
      insVoter.run(uuid(), realEid, vid, (voter && voter.name) ? String(voter.name).trim().slice(0, 300) : null, auth.hashPassword('pvh' + vid + salt, salt), '', voter && voter.assigned_station ? String(voter.assigned_station).trim().slice(0, 64) : null, Number(voter && voter.has_voted) || 0, Number(voter && voter.ballot_cast) || 0, voter && voter.voted_at ? Number(voter.voted_at) : null);
    }
    const insVote = db.prepare('INSERT INTO votes (election_id, position_id, candidate_id, voter_id, station_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
    let voteCount = 0;
    for (const vt of (snap.votes || [])) {
      voteCount++;
      insVote.run(realEid, vt && vt.position_id ? String(vt.position_id).slice(0, 64) : null, vt && vt.candidate_id ? String(vt.candidate_id).slice(0, 64) : null, vt && vt.voter_id ? String(vt.voter_id).slice(0, 64) : null, vt && vt.station_id ? String(vt.station_id).slice(0, 64) : 'MAIN', Number(vt && vt.timestamp) || now);
    }
    return { electionId: realEid, positions: counts.positions, candidates: counts.candidates, voters: counts.voters, votes: voteCount };
  });

  let result;
  try { result = tx(); } catch (err) { return { ok: false, error: 'Import failed: ' + err.message }; }
  election.audit('elections', `Imported election "${(snap.election && snap.election.title) || 'Imported election'}" from file`);
  return { ok: true, path: filePath, ...result };
});


// Pick one or more election snapshot files for the merge tool. The files are
// read and validated in the main process so the renderer never touches fs.
ipcMain.handle('merge:pick-files', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose election snapshot files to merge',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Election Snapshots (JSON)', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, error: 'Pick cancelled', canceled: true };
  const files = [];
  for (const filePath of res.filePaths) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const val = merge.validateSnapshot(parsed);
      files.push({
        path: filePath,
        base: path.basename(filePath),
        valid: val.ok,
        errors: val.errors,
        warns: val.warns,
        snapshot: val.ok ? parsed : null,
        summary: val.ok ? merge.summarize(parsed) : null,
      });
    } catch (err) {
      files.push({
        path: filePath,
        base: path.basename(filePath),
        valid: false,
        errors: ['Could not read or parse file: ' + err.message],
        warns: [],
        snapshot: null,
        summary: null,
      });
    }
  }
  return { ok: true, files };
});

function stripSecret(o) {
  const { password, password_salt, ...rest } = o;
  return rest;
}

// Resolve the acting officer from a signed session token (NOT a caller-supplied
// officer id). Tokens are minted at login, are unguessable, expire, and are
// bound to the originating webContents — so a malicious script in the renderer
// cannot fabricate an admin identity by inventing an officerId.
function resolveActor(token, senderId) {
  const sess = auth.validateSession(token, senderId);
  if (!sess) return null;
  return { id: sess.officer.id, role: sess.officer.role };
}

// Sliding-window rate limiter for the public voter endpoints. Mirrors the LAN
// hub limiter so credential guessing on the desktop is throttled the same way
// it already is over the network. Bounded; old buckets are swept lazily.
function makeRateLimiter(limit, windowMs) {
  const hits = new Map();
  return function check(key) {
    if (!key) return { ok: true };
    const now = Date.now();
    const arr = hits.get(key) || [];
    const kept = arr.filter((t) => now - t < windowMs);
    kept.push(now);
    hits.set(key, kept);
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= windowMs) hits.delete(k);
    }
    const remaining = Math.max(0, limit - kept.length);
    return { ok: kept.length <= limit, remaining, retryAfterMs: kept.length ? windowMs - (now - kept[0]) : 0 };
  };
}
const voterVerifyLimit = makeRateLimiter(10, 60 * 1000);
const voterRecoverLimit = makeRateLimiter(10, 60 * 1000);
// Break-glass recovery-code attempts are throttled per device to stop offline
// brute-forcing of the admin recovery secret.
const recoveryResetLimit = makeRateLimiter(5, 60 * 1000);

// Authorize an election-scoped management operation: admins pass, coordinators
// must own the election. Runs `fn(actor)` only when access is allowed.
function guardElection(electionId, token, fn, senderId) {
  const actor = resolveActor(token, senderId);
  const acc = election.getElectionOrError(electionId, actor);
  if (!acc.ok) return acc;
  return fn(actor);
}

// IPC handler must originate from the main app window's webContents. The kiosk
// / hub-served pages run in different contexts and must never drive privileged
// IPC, even if a token somehow leaks into them.
function senderIsApp(event) {
  try { return !!(event && event.sender && mainWindow && event.sender.id === mainWindow.webContents.id); }
  catch (e) { return false; }
}

// ---------- Election IPC ----------

ipcMain.handle('election:list', (_e, officerId) => election.listElections(resolveActor(officerId, _e.sender.id)));
ipcMain.handle('election:get', (_e, id, officerId) => guardElection(id, officerId, (actor) => election.getElection(id, actor), _e.sender.id));
ipcMain.handle('election:create', (_e, payload, officerId) => {
  if (!senderIsApp(_e)) return { ok: false, error: 'Unauthorized source', code: 'forbidden' };
  return election.createElection(payload, resolveActor(officerId, _e.sender.id));
});
ipcMain.handle('election:update', (_e, id, payload, officerId) => {
  if (!senderIsApp(_e)) return { ok: false, error: 'Unauthorized source', code: 'forbidden' };
  return election.updateElection(id, payload, resolveActor(officerId, _e.sender.id));
});
ipcMain.handle('election:status', (_e, id, status, officerId) => {
  if (!senderIsApp(_e)) return { ok: false, error: 'Unauthorized source', code: 'forbidden' };
  return election.setStatus(id, status, resolveActor(officerId, _e.sender.id));
});
ipcMain.handle('election:publish', (_e, id, opts, officerId) => {
  if (!senderIsApp(_e)) return { ok: false, error: 'Unauthorized source', code: 'forbidden' };
  return election.publishElection(id, opts, resolveActor(officerId, _e.sender.id));
});
ipcMain.handle('election:apply-schedule', (e, token) => {
  const r = requireSignedIn(token, e);
  if (!r.ok) return { ...r, changed: [] };
  return election.applySchedule();
});
ipcMain.handle('election:delete', (e, id, permanent, token) => {
  const r = requireSignedIn(token, e);
  if (!r.ok) return r;
  return election.deleteElection(id, r.actor, !!permanent);
});
ipcMain.handle('election:list-deleted', (e, token) => {
  const r = requireSignedIn(token, e);
  if (!r.ok) return r;
  try { return { ok: true, elections: election.listDeletedElections(r.actor) }; } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('election:recover', (e, id, token) => {
  const r = requireSignedIn(token, e);
  if (!r.ok) return r;
  return election.recoverElection(id, r.actor);
});
ipcMain.handle('election:purge-deleted', (e, id, token) => {
  const r = requireSignedIn(token, e);
  if (!r.ok) return r;
  return election.purgeDeletedElection(id, r.actor);
});

ipcMain.handle('election:positions', (_e, electionId, officerId) => guardElection(electionId, officerId, (actor) => election.listPositions(electionId, actor), _e.sender.id));
ipcMain.handle('election:position-add', (_e, electionId, title, maxVotes, officerId) => {
  if (!senderIsApp(_e)) return { ok: false, error: 'Unauthorized source', code: 'forbidden' };
  return election.addPosition(electionId, title, maxVotes, resolveActor(officerId, _e.sender.id));
});
ipcMain.handle('election:position-remove', (_e, id, officerId) => {
  const pos = db.get().prepare('SELECT * FROM positions WHERE id = ?').get(id);
  if (!pos) return { ok: false, error: 'Position not found' };
  return guardElection(pos.election_id, officerId, (actor) => election.removePosition(id, actor), _e.sender.id);
});
ipcMain.handle('election:position-update-max', (_e, id, maxVotes, officerId) => {
  const pos = db.get().prepare('SELECT * FROM positions WHERE id = ?').get(id);
  if (!pos) return { ok: false, error: 'Position not found' };
  return guardElection(pos.election_id, officerId, (actor) => election.setPositionMax(id, maxVotes, actor), _e.sender.id);
});

ipcMain.handle('election:candidates', (_e, electionId, officerId) => guardElection(electionId, officerId, (actor) => election.listCandidates(electionId, actor), _e.sender.id));
ipcMain.handle('election:candidates-by-position', (_e, positionId, officerId) => {
  const cand = db.get().prepare('SELECT election_id FROM candidates WHERE position_id = ? LIMIT 1').get(positionId);
  if (!cand) return election.listCandidatesByPosition(positionId);
  return guardElection(cand.election_id, officerId, () => election.listCandidatesByPosition(positionId), _e.sender.id);
});
ipcMain.handle('election:candidate-add', (_e, payload, officerId) => {
  if (!senderIsApp(_e)) return { ok: false, error: 'Unauthorized source', code: 'forbidden' };
  return election.addCandidate(payload, resolveActor(officerId, _e.sender.id));
});
ipcMain.handle('election:candidate-remove', (_e, id, officerId) => {
  const cand = db.get().prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  if (!cand) return { ok: false, error: 'Candidate not found' };
  return guardElection(cand.election_id, officerId, (actor) => election.removeCandidate(id, actor), _e.sender.id);
});

// Opens a file dialog for a candidate photo, copies the chosen image into the
// app's data folder, and returns the stored relative path (or null if cancelled).
ipcMain.handle('candidate:pick-photo', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a candidate photo',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  });
  if (canceled || !filePaths || !filePaths[0]) return null;
  const src = filePaths[0];
  const photosDir = path.join(db.getDataDir(), 'candidate-photos');
  fs.mkdirSync(photosDir, { recursive: true });
  const dest = path.join(photosDir, `${Date.now()}_${path.basename(src)}`);
  fs.copyFileSync(src, dest);
  return path.relative(db.getDataDir(), dest);
});

// Resolve a stored candidate photo path to a loadable file:// URL. Restricted
// to the app's own candidate-photos directory.
ipcMain.handle('candidate:photo-url', (_e, storedPath) => {
  if (!storedPath) return null;
  const photosDir = path.resolve(path.join(db.getDataDir(), 'candidate-photos'));
  const abs = path.isAbsolute(storedPath) ? path.normalize(storedPath) : path.resolve(path.join(photosDir, storedPath));
  const rel = path.relative(photosDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return `file://${abs}`;
});

// ---------- Voter IPC ----------

ipcMain.handle('voter:list', (_e, electionId, opts, officerId) => guardElection(electionId, officerId, () => voter.listVoters(electionId, opts || {}), _e.sender.id));
ipcMain.handle('voter:get', (_e, electionId, voterId, officerId) => guardElection(electionId, officerId, () => {
  // Never expose credential material (plaintext password, password hash/salt,
  // phone) through this unauthenticated-by-design surface. Only an officer
  // with access to the election may even reach the row.
  const row = voter.getVoter(electionId, voterId);
  if (!row) return null;
  const { password_hash, password_salt, plain_password, ...safe } = row;
  return safe;
}, _e.sender.id));
ipcMain.handle('voter:add', (_e, payload, officerId) => guardElection(payload.electionId, officerId, () => voter.addVoter(payload), _e.sender.id));
ipcMain.handle('voter:import', (_e, electionId, csvText, officerId) => guardElection(electionId, officerId, () => voter.importCsv(electionId, csvText), _e.sender.id));
ipcMain.handle('voter:autogen', (_e, electionId, opts, officerId) => guardElection(electionId, officerId, () => voter.autoGenerate(electionId, opts || {}), _e.sender.id));
ipcMain.handle('voter:delete', (_e, electionId, voterId, officerId) => guardElection(electionId, officerId, () => voter.deleteVoter(electionId, voterId), _e.sender.id));
ipcMain.handle('voter:clear', (_e, electionId, officerId) => guardElection(electionId, officerId, () => voter.clearVoters(electionId), _e.sender.id));
ipcMain.handle('voter:unvote', (_e, electionId, voterId, officerId) => {
  const res = guardElection(electionId, officerId, () => voter.unvoteVoter(electionId, voterId), _e.sender.id);
  if (res && res.ok) {
    try { getLan().onLocalUnvote(electionId, voterId); } catch (err) { console.error('LAN unvote hook failed:', err.message); }
  }
  return res;
});
ipcMain.handle('voter:verify', (_e, electionId, voterId, password) => {
  const vid = String(voterId || '').trim();
  const rl = voterVerifyLimit(`${_e.sender.id}|${electionId}|${vid.toUpperCase()}`);
  if (!rl.ok) return { ok: false, error: 'Too many sign-in attempts for this device. Wait a minute and try again.', code: 'rate-limit', retryAfterMs: rl.retryAfterMs };
  if (!vid || !password) return { ok: false, error: 'Missing voter ID or password', code: 'missing' };
  return voter.verifyVoter(electionId, vid, password, `desktop:${_e.sender.id}`);
});
ipcMain.handle('voter:verify-details', (_e, electionId, details) => {
  const d = Object.assign({}, details || {});
  const base = `${_e.sender.id}|${electionId}|${String(d.voterId || '').toUpperCase()}`;
  const rl = voterRecoverLimit(base);
  if (!rl.ok) return { ok: false, error: 'Too many recovery attempts for this device. Wait a minute and try again.', code: 'rate-limit', retryAfterMs: rl.retryAfterMs };
  return voter.verifyVoterDetails(electionId, Object.assign(d, { revealPassword: true }));
});
ipcMain.handle('voter:cast', (_e, electionId, voterId, selection, castTicket, stationContext) => {
  const res = voter.castVote(electionId, voterId, selection, castTicket, stationContext || undefined, `desktop:${_e.sender.id}`);
  if (res && res.ok) {
    try { getLan().onLocalVote(electionId, voterId, selection, res.timestamp, { station: stationContext || null }); } catch (err) { console.error('LAN vote hook failed:', err.message); }
  }
  return res;
});

// ---- Voter roll export (CSV / HTML / PDF / Print) ----
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const csvCell = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;

function buildVoterRollHtml(electionId) {
  const e = election.getElection(electionId);
  const voters = voter.listVoters(electionId, { limit: 1000000 }).voters;
  const title = (e && e.title) || 'Election';
  const stamp = new Date().toLocaleString();
  const safe = (e && e.safe_name) || String(title).replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  const rows = voters.map((v, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td class="vid">${escHtml(v.voter_id)}</td>
      <td>${escHtml(v.name || '—')}</td>
      <td>${escHtml(v.assigned_station || '—')}</td>
      <td class="status ${v.has_voted ? 'voted' : 'ready'}">${v.has_voted ? 'Voted' : 'Ready'}</td>
    </tr>`).join('');

  return {
    title,
    safe,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Voter Roll — ${escHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; margin: 0; padding: 32px; }
  .mast { border-bottom: 3px solid #dc2626; padding-bottom: 12px; margin-bottom: 20px; }
  .brand { font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: #9ca3af; font-weight: 600; }
  h1 { margin: 4px 0 0; font-size: 22px; color: #111827; }
  .meta { margin-top: 6px; font-size: 12px; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; background: #f3f4f6; border-bottom: 2px solid #e5e7eb; text-transform: uppercase; font-size: 11px; letter-spacing: .5px; color: #4b5563; }
  td { padding: 7px 10px; border-bottom: 1px solid #f3f4f6; }
  tr:nth-child(even) td { background: #fafafa; }
  .num { width: 40px; color: #9ca3af; }
  .vid { font-weight: 600; color: #111827; }
  .status { text-align: center; }
  .status.voted { color: #15803d; font-weight: 600; }
  .status.ready { color: #2563eb; }
  .foot { margin-top: 20px; font-size: 11px; color: #9ca3af; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <div class="mast">
    <div class="brand">Pulse Vote Hub &middot; Official Voter Roll</div>
    <h1>${escHtml(title)}</h1>
    <div class="meta">${voters.length} voter${voters.length === 1 ? '' : 's'} &middot; generated ${escHtml(stamp)}</div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Voter ID</th><th>Name</th><th>Station</th><th>Status</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No voters found.</td></tr>'}</tbody>
  </table>
  <div class="foot">Pulse Vote Hub &middot; ${escHtml(stamp)}</div>
</body>
</html>`,
  };
}

function sanitizeFileName(name) {
  return String(name || 'voters').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'voters';
}

async function voterExportWindow(html) {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1100,
    webPreferences: { sandbox: true, webSecurity: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return win;
}

ipcMain.handle('voter:export', async (_e, { electionId, format }, officerId) => {
  if (!['csv', 'html', 'pdf', 'print'].includes(format)) {
    return { ok: false, error: 'Invalid export format' };
  }
  const actor = resolveActor(officerId, _e.sender.id);
  const acc = election.getElectionOrError(electionId, actor);
  if (!acc.ok) return acc;
  try {
    const { title, safe, html } = buildVoterRollHtml(electionId);
    const voters = voter.listVoters(electionId, { limit: 1000000 }).voters;
    const base = sanitizeFileName(safe);

    if (format === 'csv') {
      const csvLines = ['Voter ID,Name,Station,Status'];
      for (const v of voters) {
        csvLines.push([csvCell(v.voter_id), csvCell(v.name || ''), csvCell(v.assigned_station || ''), v.has_voted ? 'Voted' : 'Ready'].join(','));
      }
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Voter Roll (CSV)',
        defaultPath: `${base}-voters.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, error: 'Export cancelled', canceled: true };
      fs.writeFileSync(res.filePath, csvLines.join('\n'), 'utf8');
      return { ok: true, path: res.filePath, format };
    }

    if (format === 'html') {
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Voter Roll (HTML)',
        defaultPath: `${base}-voters.html`,
        filters: [{ name: 'HTML', extensions: ['html'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, error: 'Export cancelled', canceled: true };
      fs.writeFileSync(res.filePath, html, 'utf8');
      return { ok: true, path: res.filePath, format };
    }

    if (format === 'pdf') {
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Voter Roll (PDF)',
        defaultPath: `${base}-voters.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, error: 'Export cancelled', canceled: true };
      const win = await voterExportWindow(html);
      try {
        const pdf = await win.webContents.printToPDF({ pageSize: 'A4' });
        fs.writeFileSync(res.filePath, pdf);
      } finally {
        if (!win.isDestroyed()) win.destroy();
      }
      return { ok: true, path: res.filePath, format };
    }

    if (format === 'print') {
      const win = await voterExportWindow(html);
      let resolved = false;
      const done = (ok, reason) => {
        if (resolved) return;
        resolved = true;
        ipcMain.emit('voter:export:print-done', { ok, reason });
      };
      win.webContents.print({ silent: false, printBackground: true }, (ok, failureReason) => {
        done(ok, failureReason);
      });
      const result = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ ok: true, format }), 120000);
        ipcMain.once('voter:export:print-done', (_, r) => { clearTimeout(t); resolve({ ok: r.ok, error: r.reason, format }); });
      });
      if (!win.isDestroyed()) win.destroy();
      return result;
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Export the voter credentials (voter ID + password) as CSV. This is a
// privileged, desktop-only action for coordinators/help desk handing out
// voting passwords; it is intentionally separate from the ordinary voter-roll
// export which never carries credentials.
ipcMain.handle('voter:export-credentials', async (_e, { electionId }, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  const acc = election.getElectionOrError(electionId, actor);
  if (!acc.ok) return acc;
  try {
    const e = election.getElection(electionId);
    const d = db.get();
    const rows = d.prepare(
      'SELECT voter_id, name, phone, assigned_station, plain_password, has_voted FROM voters WHERE election_id = ? ORDER BY name, voter_id'
    ).all(electionId);
    const title = (e && e.title) || 'Election';
    const safe = sanitizeFileName((e && e.safe_name) || String(title).replace(/[^a-z0-9]+/gi, '-').toLowerCase());
    const lines = ['Voter ID,Name,Phone,Station,Password,Status'];
    for (const v of rows) {
      lines.push([
        csvCell(v.voter_id),
        csvCell(v.name || ''),
        csvCell(v.phone || ''),
        csvCell(v.assigned_station || ''),
        csvCell(Array.isArray(v.plain_password) ? v.plain_password.join(',') : String(vault.decrypt(v.plain_password) || '')),
        v.has_voted ? 'Voted' : 'Ready',
      ].join(','));
    }
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Voter Credentials (CSV)',
      defaultPath: `${safe}-credentials.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, error: 'Export cancelled', canceled: true };
    fs.writeFileSync(res.filePath, lines.join('\n'), 'utf8');
    return { ok: true, path: res.filePath, count: rows.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- Stations ----
const safeStation = (fn) => (_e, ...args) => {
  try { return fn(...args); } catch (err) { return { ok: false, error: err.message }; }
};

// Authorize a station-scoped operation. Admins and election owners pass;
// an assistant (station officer) passes only when assigned to exactly this
// (election, station). Station ops are no longer open to any signed-in caller.
function guardStation(electionId, stationId, officerId, senderId, fn) {
  const actor = resolveActor(officerId, senderId);
  // Resolve the station row by id, code, or name within this election so
  // operators can reference their station however the portal expresses it.
  const st = (electionId ? station.resolveStationRef(electionId, stationId) : null) || station.getStation(stationId);
  const realId = st ? st.id : stationId;
  const electionId2 = st ? st.election_id : electionId;
  let allowed = false;
  if (actor && (actor.role === 'admin' || actor.role === 'developer')) allowed = true;
  else if (actor && election.getElectionOrError(electionId2, actor).ok) allowed = true;
  else if (actor) {
    const o = auth.findById(actor.id);
    allowed = !!(o && o.assigned_election_id === electionId2 && o.assigned_station_id === realId);
  }
  if (!allowed) return { ok: false, error: 'You do not have access to this station.', code: 'forbidden' };
  return safeStation(fn)();
}
ipcMain.handle('station:list', (_e, electionId, officerId) => guardElection(electionId, officerId, () => station.getStationsForElection(electionId), _e.sender.id));
ipcMain.handle('station:add', (_e, payload, officerId) => guardElection(payload.electionId, officerId, () => station.addStation(payload), _e.sender.id));
ipcMain.handle('station:update', (_e, id, payload, officerId) => {
  const row = db.get().prepare('SELECT election_id FROM stations WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Station not found' };
  return guardElection(row.election_id, officerId, () => station.updateStation(id, payload), _e.sender.id);
});
ipcMain.handle('station:remove', (_e, id, officerId) => {
  const row = db.get().prepare('SELECT election_id FROM stations WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Station not found' };
  return guardElection(row.election_id, officerId, () => station.removeStation(id), _e.sender.id);
});
ipcMain.handle('station:open', (_e, id, opts, officerId) => {
  const row = db.get().prepare('SELECT election_id FROM stations WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Station not found' };
  return guardStation(row.election_id, id, officerId, _e.sender.id, () => station.openPolls(id, opts || {}));
});
ipcMain.handle('station:close', (_e, id, opts, officerId) => {
  const row = db.get().prepare('SELECT election_id FROM stations WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Station not found' };
  return guardStation(row.election_id, id, officerId, _e.sender.id, () => station.closePolls(id, opts || {}));
});
ipcMain.handle('station:close-queue-now', (_e, id, opts, officerId) => {
  const row = db.get().prepare('SELECT election_id FROM stations WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Station not found' };
  return guardStation(row.election_id, id, officerId, _e.sender.id, () => station.closeQueueNow(id, opts || {}));
});
ipcMain.handle('station:submit', (_e, id, opts, officerId) => {
  const row = db.get().prepare('SELECT election_id FROM stations WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Station not found' };
  return guardStation(row.election_id, id, officerId, _e.sender.id, () => station.submitPacket(id, opts || {}));
});
ipcMain.handle('station:checkin', (_e, voterId, opts, officerId) => {
  const stationId = (opts && opts.stationId) || null;
  if (!stationId) return { ok: false, error: 'stationId is required for a station check-in.', code: 'no-station' };
  const row = db.get().prepare('SELECT election_id, station_id FROM voters WHERE id = ?').get(voterId);
  if (!row) return { ok: false, error: 'Voter not found' };
  return guardStation(row.election_id, stationId, officerId, _e.sender.id, () => {
    const res = station.checkInVoter(voterId, opts || {});
    if (res && res.ok && res.voter) {
      try { getLan().onLocalCheckin(res.voter, (opts && opts.officerName) || 'Officer', { station: stationId }); } catch (err) { console.error('LAN checkin hook failed:', err.message); }
    }
    return res;
  });
});
ipcMain.handle('station:ballot-cast', (_e, voterId, opts, officerId) => {
  const row = db.get().prepare('SELECT * FROM voters WHERE id = ?').get(voterId);
  if (!row) return { ok: false, error: 'Voter not found' };
  const st = station.resolveVoterStation(row);
  return guardStation(row.election_id, st ? st.id : null, officerId, _e.sender.id, () => station.markBallotCast(voterId, opts || {}));
});
ipcMain.handle('station:dashboard', (_e, electionId, stationId, officerId) => guardStation(electionId, stationId, officerId, _e.sender.id, () => station.stationDashboard(electionId, stationId)));

// ---- Secure browser check-in links (coordinator-generated magic link + PIN) ----

function checkinLinkBase() {
  try {
    const st = getLan().status();
    if (st.mode === 'host' && st.addresses && st.addresses.length && st.port) {
      return `http://${st.addresses[0]}:${st.port}`;
    }
  } catch (err) { /* fall through to localhost fallback */ }
  return `http://localhost:${process.env.PVH_LAN_PORT || 7380}`;
}

ipcMain.handle('station:create-checkin-link', (_e, { electionId, stationId }, officerId) =>
  guardElection(electionId, officerId, (actor) => {
    const res = checkInLink.createCheckinLink({ electionId, stationId, actor });
    if (!res.ok) return res;
    return {
      ok: true,
      id: res.id,
      url: `${checkinLinkBase()}/kiosk/station?t=${encodeURIComponent(res.urlToken)}`,
      pin: res.pin,
      officerName: res.officerName,
      expiresAt: res.expiresAt,
    };
  }, _e.sender.id));

ipcMain.handle('station:list-checkin-links', (_e, electionId, officerId) =>
  guardElection(electionId, officerId, () => ({ ok: true, links: checkInLink.listCheckinLinks(electionId) }), _e.sender.id));

ipcMain.handle('station:revoke-checkin-link', (_e, { electionId, tokenId }, officerId) =>
  guardElection(electionId, officerId, () => {
    const res = checkInLink.revokeCheckinLink(electionId, tokenId);
    if (res.ok) {
      try { const hub = getLan().hub; if (hub) hub.revokeTokenSessions(tokenId); } catch (err) { /* best-effort */ }
    }
    return res;
  }, _e.sender.id));

// ---------- Results IPC ----------

ipcMain.handle('result:report', (_e, electionId, officerId, stationId) =>
  guardElection(electionId, officerId, (actor) => {
    const row = db.get().prepare('SELECT * FROM elections WHERE id = ?').get(electionId);
    if (!row) return { ok: false, error: 'Election not found' };
    return results.buildReport(row, { stationId: stationId || null });
  }, _e.sender.id));

// Results export: pass the already-rendered content and let the user pick a
// destination. Mirrors the voter-roll export flow (save dialog + write / printToPDF).
ipcMain.handle('result:export-file', async (_e, { content, defaultName, ext }) => {
  try {
    if (!content && content !== '') return { ok: false, error: 'Nothing to export' };
    const base = sanitizeFileName(defaultName || 'results-report');
    const extName = ext === 'csv' ? 'CSV' : 'HTML';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: `Export Results (${extName})`,
      defaultPath: `${base}.${ext}`,
      filters: [{ name: extName, extensions: [ext] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, error: 'Export cancelled', canceled: true };
    fs.writeFileSync(res.filePath, content, 'utf8');
    return { ok: true, path: res.filePath, format: ext };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('result:export-pdf', async (_e, { html, defaultName } = {}) => {
  try {
    if (!html) return { ok: false, error: 'Nothing to export' };
    const base = sanitizeFileName(defaultName || 'results-report');
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Results (PDF)',
      defaultPath: `${base}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, error: 'Export cancelled', canceled: true };
    const win = await voterExportWindow(html);
    try {
      const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
      fs.writeFileSync(res.filePath, pdf);
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
    return { ok: true, path: res.filePath, format: 'pdf' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Write a JSON artifact generated by the merge tool (merged snapshot or the
// duplicate/violation report) to a user-chosen location.
ipcMain.handle('merge:export-json', async (_e, { content, defaultName }) => {
  try {
    let text;
    if (typeof content === 'string') {
      text = content;
    } else {
      text = JSON.stringify(content, null, 2);
    }
    const base = sanitizeFileName(defaultName || 'merged-election');
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export JSON',
      defaultPath: `${base}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, error: 'Export cancelled', canceled: true };
    fs.writeFileSync(res.filePath, text, 'utf8');
    return { ok: true, path: res.filePath, format: 'json' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- Multi-location runs ("Location Coordinator") ----------

// List the locations (and their result-pack state) for an election.
ipcMain.handle('location:list', (_e, electionId, officerId) => guardElection(electionId, officerId, () => {
  try {
    const d = db.get();
    const rows = d.prepare(
      `SELECT l.id, l.election_id, l.name, l.code, l.created_at,
              (SELECT COUNT(*) FROM locations_officers lo WHERE lo.location_id = l.id) AS coordinators,
              (SELECT COUNT(*) FROM result_packs rp WHERE rp.location_id = l.id AND rp.compiled = 1) AS compiled_packs
       FROM locations l WHERE l.election_id = ? ORDER BY l.name`
    ).all(electionId);
    return { ok: true, locations: rows };
  } catch (err) { return { ok: false, error: err.message }; }
}, _e.sender.id));

// Main coordinator: create (and offer to save) a run pack for a location.
ipcMain.handle('location:create-run', async (_e, { electionId, locationName, locationCode, passphrase }, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  const acc = election.getElectionOrError(electionId, actor);
  if (!acc.ok) return acc;
  const created = locationPack.createRunPackBody({ electionId, locationName, locationCode, passphrase });
  if (!created.ok) return created;
  try {
    const e = election.getElection(electionId);
    const base = `run-${(locationName || 'location').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${(e && e.title || 'election').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Run Pack',
      defaultPath: `${base}.json`,
      filters: [{ name: 'Run Pack (JSON)', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, error: 'Export cancelled', canceled: true };
    fs.writeFileSync(res.filePath, JSON.stringify(created.pack, null, 2), 'utf8');
    // Record the run pack in the DB so result packs can be linked back.
    const d = db.get();
    d.prepare(`
      INSERT OR REPLACE INTO run_packs (id, election_id, location_id, pack_hash, version, created_at, created_by, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(created.pack.pack_id, electionId, null, created.packHash || '', 1, Date.now(), actor && actor.id);
    return { ok: true, path: res.filePath, packId: created.pack.pack_id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Location coordinator (or admin): import a run pack file. The renderer collects
// the passphrase + setup code in a modal (this is a desktop app — no console prompts).
ipcMain.handle('location:import-run', async (_e, { passphrase, setupCode }, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a Run Pack to import',
    properties: ['openFile'],
    filters: [{ name: 'Run Pack (JSON)', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, error: 'Pick cancelled', canceled: true };
  const filePath = res.filePaths[0];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { ok: false, error: 'Could not read that file as JSON.' };
  }
  const out = locationPack.importRunPack(parsed, { passphrase: passphrase || '', setupCode: setupCode || '', actor });
  if (!out.ok) return { ok: false, error: out.error, code: out.code };
  return { ...out, path: filePath };
});

// Location coordinator: export the result pack after sealing every station.
ipcMain.handle('location:create-result', async (_e, electionId, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  const acc = election.getElectionOrError(electionId, actor);
  if (!acc.ok) return acc;
  const created = locationPack.createResultPack(electionId);
  if (!created.ok) return created;
  try {
    const e = election.getElection(electionId);
    const base = `result-${(e && e.title || 'election').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Result Pack',
      defaultPath: `${base}.json`,
      filters: [{ name: 'Result Pack (JSON)', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, error: 'Export cancelled', canceled: true };
    fs.writeFileSync(res.filePath, JSON.stringify(created.pack, null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Main coordinator: pick one or more result packs, verify each, and store them
// for compilation.
ipcMain.handle('location:pick-result', async (_e, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  if (!actor || (actor.role !== 'admin' && actor.role !== 'developer')) return { ok: false, error: 'Only the main coordinator can import result packs.' };
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose result pack(s) from locations',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Result Pack (JSON)', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, error: 'Pick cancelled', canceled: true };
  const results = [];
  for (const filePath of res.filePaths) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const report = locationPack.verifyResultPack(parsed);
      results.push({
        base: path.basename(filePath),
        ok: report.ok,
        report,
        pack: parsed,
      });
    } catch (err) {
      results.push({ base: path.basename(filePath), ok: false, report: { ok: false, errors: ['Could not parse file.'] }, pack: null });
    }
  }
  return { ok: true, results };
});

// Main coordinator: compile verified result packs into the aggregate result.
ipcMain.handle('location:compile', (_e, { packs }, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  if (!actor || (actor.role !== 'admin' && actor.role !== 'developer')) return { ok: false, error: 'Only the main coordinator can compile results.' };
  const valid = (Array.isArray(packs) ? packs : [])
    .map((p) => (p && p.pack) || p)
    .filter((p) => p && p.payload);
  return locationPack.compileResult(valid);
});

// ---------- LAN Networking (Phase 2) ----------
// LAN control is available to any signed-in officer (the Browser-ballot kiosk
// is a core coordination feature), but every handler requires a VALID session:
// an unauth/XSS context with no token can no longer start/stop the hub, rotate
// the secret, or read addresses. The shared network secret is disclosed ONLY
// to admins/developers through `lan:status` (and never pushed to windows).

function lanSession(req, _e) {
  const actor = resolveActor(typeof req === 'string' ? req : null, _e.sender.id);
  return actor ? actor : null;
}

ipcMain.handle('lan:status', (_e, token) => {
  try {
    const actor = resolveActor(token, _e.sender.id);
    if (!actor) return { ok: false, error: 'Not authorized' };
    const s = getLan().status();
    if (s && actor.role !== 'admin' && actor.role !== 'developer' && s.secret) delete s.secret;
    return s;
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('lan:set-mode', async (_e, payload, token) => {
  try {
    if (!lanSession(token, _e)) return { ok: false, error: 'Not authorized' };
    return await getLan().setMode(payload && payload.mode, payload || {});
  }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('lan:stop', async (_e, token) => {
  try {
    if (!lanSession(token, _e)) return { ok: false, error: 'Not authorized' };
    await getLan().setMode('off'); return { ok: true };
  }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('lan:set-name', (_e, name, token) => {
  try {
    if (!lanSession(token, _e)) return { ok: false, error: 'Not authorized' };
    return getLan().setName(name);
  }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('lan:set-secret', (_e, value, token) => {
  try {
    if (!lanSession(token, _e)) return { ok: false, error: 'Not authorized' };
    return getLan().setSecret(value);
  }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('lan:discover', async (_e, ms, token) => {
  try {
    if (!lanSession(token, _e)) return { ok: false, error: 'Not authorized' };
    return { ok: true, services: await getLan().discovers(ms || 4000) };
  }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('lan:local-addresses', (_e, token) => {
  try {
    if (!lanSession(token, _e)) return { ok: false, error: 'Not authorized' };
    return { ok: true, addresses: getLan().status().addresses };
  }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---------- In-app messaging ("Speak to admin") ----------

ipcMain.handle('messages:send', (_e, body, officerId) => {
  try {
    const actor = resolveActor(officerId, _e.sender.id);
    const res = messages.send(actor ? actor.id : null, body);
    if (res.ok) { try { getLan().onLocalMessage(res.message); } catch (err) { console.error('LAN message hook failed:', err.message); } }
    return res;
  } catch (err) { return { ok: false, error: err.message }; }
});

// Admin-only: reply to a message (opens/continues a thread).
ipcMain.handle('messages:reply', (_e, id, body, officerId) => {
  try {
    const actor = resolveActor(officerId, _e.sender.id);
    if (!actor || (actor.role !== 'admin' && actor.role !== 'developer')) return { ok: false, error: 'Admins only' };
    const res = messages.replyTo(id, actor, body);
    if (res.ok) { try { getLan().onLocalMessage(res.message); } catch (err) { console.error('LAN message hook failed:', err.message); } }
    return res;
  } catch (err) { return { ok: false, error: err.message }; }
});

// Admin-only: list inbox + unread count. Non-admins get an empty inbox.
ipcMain.handle('messages:list', (_e, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  const isAdmin = actor && (actor.role === 'admin' || actor.role === 'developer');
  if (!actor || !isAdmin) return { ok: true, messages: [] };
  try { return { ok: true, messages: messages.list() }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Any officer: their own conversation (sent notes + replies addressed to them).
ipcMain.handle('messages:mine', (_e, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  if (!actor) return { ok: true, messages: [] };
  try { return { ok: true, messages: messages.listMine(actor.id) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('messages:unread', (_e, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  const isAdmin = actor && (actor.role === 'admin' || actor.role === 'developer');
  if (!actor || !isAdmin) return { ok: true, count: 0 };
  try { return { ok: true, count: messages.unreadCount() }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Any officer: count of replies addressed to them that they haven't read.
ipcMain.handle('messages:mine-unread', (_e, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  if (!actor) return { ok: true, count: 0 };
  try { return { ok: true, count: messages.unreadMine(actor.id) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Any officer: mark replies addressed to them as read (opens the thread view).
ipcMain.handle('messages:mark-mine-read', (_e, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  if (!actor) return { ok: false, error: 'Not signed in' };
  try { return messages.markMineRead(actor.id); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('messages:mark-read', (_e, id, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  if (!actor || (actor.role !== 'admin' && actor.role !== 'developer')) return { ok: false, error: 'Admins only' };
  try { return messages.markRead(id); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('messages:delete', (_e, id, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  if (!actor) return { ok: false, error: 'Not signed in' };
  try { return messages.del(id, actor); }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---- Creator console: product distribution (admin-only) ----
const adminGuard = (officerId, senderId) => {
  const actor = resolveActor(officerId, senderId);
  if (!actor || (actor.role !== 'admin' && actor.role !== 'developer')) return null;
  return actor;
};

const developerGuard = (officerId, senderId) => {
  const actor = resolveActor(officerId, senderId);
  if (!actor || actor.role !== 'developer') return null;
  return actor;
};

ipcMain.handle('dist:list', (_e, officerId) => {
  if (!developerGuard(officerId, _e.sender.id)) return { ok: false, error: 'Developer only' };
  try { return { ok: true, deployments: distribution.listDeployments() }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('dist:add', (_e, fields, officerId) => {
  const actor = developerGuard(officerId, _e.sender.id);
  if (!actor) return { ok: false, error: 'Developer only' };
  try { return distribution.addDeployment(fields, actor); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('dist:remove', (_e, id, officerId) => {
  const actor = developerGuard(officerId, _e.sender.id);
  if (!actor) return { ok: false, error: 'Developer only' };
  try { return distribution.removeDeployment(id, actor); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('dist:this-computer', (_e, fields, officerId) => {
  if (!developerGuard(officerId, _e.sender.id)) return { ok: false, error: 'Developer only' };
  try { return { ok: true, computer: distribution.thisComputer(fields) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('dist:github', (_e, officerId) => {
  if (!developerGuard(officerId, _e.sender.id)) return { ok: false, error: 'Developer only' };
  return distribution.fetchReleases();
});

ipcMain.handle('dist:get-token', (_e, officerId) => {
  if (!developerGuard(officerId, _e.sender.id)) return { ok: false, error: 'Developer only' };
  const v = db.getConfig('github_token') || '';
  return { ok: true, hasToken: !!v.trim() };
});

ipcMain.handle('dist:set-token', (_e, token, officerId) => {
  if (!developerGuard(officerId, _e.sender.id)) return { ok: false, error: 'Developer only' };
  const t = String(token || '').trim();
  if (t) db.setConfig('github_token', t); else db.setConfig('github_token', '');
  return { ok: true };
});

ipcMain.handle('dist:export-csv', async (_e, officerId) => {
  if (!developerGuard(officerId, _e.sender.id)) return { ok: false, error: 'Developer only' };
  try {
    const rows = distribution.listDeployments();
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['Machine,Location,Platform,Version,Installed,Notes'];
    for (const r of rows) {
      lines.push([
        cell(r.machine_name),
        cell(r.location),
        cell(r.platform),
        cell(r.app_version),
        cell(r.installed_at ? new Date(r.installed_at).toISOString() : ''),
        cell(r.notes),
      ].join(','));
    }
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Installs Register (CSV)',
      defaultPath: 'install-register.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, error: 'Export cancelled', canceled: true };
    fs.writeFileSync(res.filePath, lines.join('\n'), 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('messages:clear', (_e, officerId) => {
  const actor = resolveActor(officerId, _e.sender.id);
  if (!actor) return { ok: false, error: 'Not signed in' };
  try { return messages.clearAll(actor); }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---------- External links (open the web version in the default browser) ----------

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'pulse-vote-hub-app.web.app',
  'web.facebook.com',
  'www.facebook.com',
  'facebook.com',
  'x.com',
  'tiktok.com',
  'www.tiktok.com',
  'youtube.com',
  'www.youtube.com',
  'instagram.com',
  'threads.net',
  'www.threads.net',
  'threads.com',
  'www.threads.com',
]);

ipcMain.handle('shell:open-external', async (_e, url) => {
  try {
    const u = new URL(String(url || ''));
    if (!['https:', 'http:'].includes(u.protocol)) return { ok: false, error: 'Unsupported link' };
    if (!ALLOWED_EXTERNAL_HOSTS.has(u.hostname)) return { ok: false, error: 'Unsupported link' };
    await shell.openExternal(u.href);
    return { ok: true };
  } catch (err) { return { ok: false, error: 'Invalid link' }; }
});
