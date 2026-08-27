const { app, BrowserWindow, ipcMain, nativeTheme, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Fix the user-data path so dev runs (`npx electron .`) resolve to the same
// directory as the packaged app; otherwise dev defaults to the "Electron" dir
// and loads a stale, separate database.
app.setName('pulse-vote-hub-desktop');

const db = require('./db');
const auth = require('./auth');
const election = require('./election');
const voter = require('./voter');
const station = require('./station');

let mainWindow = null;
let splashWindow = null;
let isKiosk = false;

// Resolve the renderer directory for both dev and packaged builds
function rendererDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'renderer')
    : path.join(__dirname, '..', 'renderer');
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 640,
    height: 480,
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

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: getComputedBg(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(rendererDir(), 'index.html'));

  mainWindow.once('ready-to-show', () => {
    // Let splash show first, then tear down after a beat
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      mainWindow.show();
    }, 800);
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

  createSplashWindow();
  setTimeout(createMainWindow, 600);

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

ipcMain.handle('db:stats', () => {
  const d = db.get();
  const row = d.prepare(`
    SELECT
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)    AS active,
      SUM(CASE WHEN status = 'upcoming' THEN 1 ELSE 0 END)  AS upcoming,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END)     AS draft,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END)    AS closed
    FROM elections
  `).get();
  const voters = d.prepare('SELECT COUNT(*) AS c FROM voters').get().c || 0;
  const cast = d.prepare('SELECT COUNT(*) AS c FROM voters WHERE has_voted = 1').get().c || 0;
  const votes = d.prepare('SELECT COUNT(*) AS c FROM votes').get().c || 0;
  const officers = auth.listOfficers();
  const admins = officers.filter((o) => o.role === 'admin').length;
  const coords = officers.filter((o) => o.role !== 'admin').length;
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
ipcMain.handle('db:active-elections', () => {
  const d = db.get();
  return d.prepare(`
    SELECT e.id, e.title, e.type, e.status,
      (SELECT COUNT(*) FROM positions p WHERE p.election_id = e.id) AS positions,
      (SELECT COUNT(*) FROM candidates c WHERE c.election_id = e.id) AS candidates,
      (SELECT COUNT(*) FROM voters v WHERE v.election_id = e.id) AS voters,
      (SELECT COUNT(*) FROM voters v WHERE v.election_id = e.id AND v.has_voted = 1) AS cast
    FROM elections e
    WHERE e.status = 'active'
    ORDER BY e.created_at DESC
  `).all();
});

ipcMain.handle('auth:setup-check', () => auth.isConfigured());
ipcMain.handle('auth:has-admin', () => auth.hasAdmin());

ipcMain.handle('auth:setup', (_e, { name, officerId, password }) => {
  try {
    return auth.setupCoordinator(name, officerId, password);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:setup-admin', (_e, { name, officerId, password }) => {
  try {
    return auth.setupAdmin(name, officerId, password);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:login', (_e, { officerId, password }) => {
  try {
    const officer = auth.login(officerId, password);
    if (!officer) return { ok: false, error: 'Invalid officer ID or password' };
    if (officer.suspended) return { ok: false, error: 'This account has been suspended. Contact the administrator.', code: 'suspended' };
    return { ok: true, officer: stripSecret(officer) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- Admin / superuser IPC ----

ipcMain.handle('admin:officers', () => auth.listOfficers());
ipcMain.handle('admin:add-officer', (_e, payload) => {
  try { return auth.addOfficer(payload); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('admin:remove-officer', (_e, { id, actingId }) => {
  try { return auth.removeOfficer(id, actingId); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('admin:set-suspended', (_e, { id, suspended }) => {
  try { return auth.setSuspended(id, suspended); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('admin:change-password', (_e, { id, newPassword }) => {
  try { return auth.changePassword(id, newPassword); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('admin:assign-station', (_e, { officerId, stationId, electionId }) => {
  try { return auth.assignStationOfficer(officerId, stationId, electionId); } catch (err) { return { ok: false, error: err.message }; }
});

// ---- Backup / export IPC ----

// Backup the entire database (a synchronized copy of the SQLite file).
ipcMain.handle('backup:database', async () => {
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

// Export a single election (its config + all data) as a JSON snapshot.
ipcMain.handle('backup:election', async (_e, electionId) => {
  const e = election.getElection(electionId);
  if (!e) return { ok: false, error: 'Election not found' };
  const snapshot = { exported_at: Date.now(), exporter: 'pulse-vote-hub-desktop', election: e };
  const defaultName = `election-${(e.title || 'export').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
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

function stripSecret(o) {
  const { password, password_salt, ...rest } = o;
  return rest;
}

// ---------- Election IPC ----------

ipcMain.handle('election:list', () => election.listElections());
ipcMain.handle('election:get', (_e, id) => election.getElection(id));
ipcMain.handle('election:create', (_e, payload) => election.createElection(payload));
ipcMain.handle('election:update', (_e, id, payload) => election.updateElection(id, payload));
ipcMain.handle('election:status', (_e, id, status) => election.setStatus(id, status));
ipcMain.handle('election:publish', (_e, id, opts) => election.publishElection(id, opts));
ipcMain.handle('election:apply-schedule', () => election.applySchedule());
ipcMain.handle('election:delete', (_e, id) => election.deleteElection(id));

ipcMain.handle('election:positions', (_e, electionId) => election.listPositions(electionId));
ipcMain.handle('election:position-add', (_e, electionId, title, maxVotes) => election.addPosition(electionId, title, maxVotes));
ipcMain.handle('election:position-remove', (_e, id) => election.removePosition(id));

ipcMain.handle('election:candidates', (_e, electionId) => election.listCandidates(electionId));
ipcMain.handle('election:candidates-by-position', (_e, positionId) => election.listCandidatesByPosition(positionId));
ipcMain.handle('election:candidate-add', (_e, payload) => election.addCandidate(payload));
ipcMain.handle('election:candidate-remove', (_e, id) => election.removeCandidate(id));

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

// Resolve a stored candidate photo path to a loadable file:// URL.
ipcMain.handle('candidate:photo-url', (_e, storedPath) => {
  if (!storedPath) return null;
  const abs = path.isAbsolute(storedPath) ? storedPath : path.join(db.getDataDir(), storedPath);
  if (!fs.existsSync(abs)) return null;
  return `file://${abs}`;
});

// ---------- Voter IPC ----------

ipcMain.handle('voter:list', (_e, electionId, opts) => voter.listVoters(electionId, opts || {}));
ipcMain.handle('voter:get', (_e, electionId, voterId) => voter.getVoter(electionId, voterId));
ipcMain.handle('voter:add', (_e, payload) => voter.addVoter(payload));
ipcMain.handle('voter:import', (_e, electionId, csvText) => voter.importCsv(electionId, csvText));
ipcMain.handle('voter:autogen', (_e, electionId, opts) => voter.autoGenerate(electionId, opts || {}));
ipcMain.handle('voter:delete', (_e, electionId, voterId) => voter.deleteVoter(electionId, voterId));
ipcMain.handle('voter:clear', (_e, electionId) => voter.clearVoters(electionId));
ipcMain.handle('voter:unvote', (_e, electionId, voterId) => voter.unvoteVoter(electionId, voterId));
ipcMain.handle('voter:verify', (_e, electionId, voterId, password) => voter.verifyVoter(electionId, voterId, password));
ipcMain.handle('voter:cast', (_e, electionId, voterId, selection) => voter.castVote(electionId, voterId, selection));

// ---- Stations ----
const safeStation = (fn) => (_e, ...args) => {
  try { return fn(...args); } catch (err) { return { ok: false, error: err.message }; }
};
ipcMain.handle('station:list', safeStation((electionId) => station.getStationsForElection(electionId)));
ipcMain.handle('station:add', safeStation((payload) => station.addStation(payload)));
ipcMain.handle('station:update', safeStation((id, payload) => station.updateStation(id, payload)));
ipcMain.handle('station:remove', safeStation((id) => station.removeStation(id)));
ipcMain.handle('station:open', safeStation((id, opts) => station.openPolls(id, opts || {})));
ipcMain.handle('station:close', safeStation((id, opts) => station.closePolls(id, opts || {})));
ipcMain.handle('station:close-queue-now', safeStation((id, opts) => station.closeQueueNow(id, opts || {})));
ipcMain.handle('station:submit', safeStation((id, opts) => station.submitPacket(id, opts || {})));
ipcMain.handle('station:checkin', safeStation((voterId, opts) => station.checkInVoter(voterId, opts || {})));
ipcMain.handle('station:ballot-cast', safeStation((voterId, opts) => station.markBallotCast(voterId, opts || {})));
ipcMain.handle('station:dashboard', safeStation((electionId, stationId) => station.stationDashboard(electionId, stationId)));
