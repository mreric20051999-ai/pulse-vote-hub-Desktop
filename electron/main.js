const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const auth = require('./auth');
const election = require('./election');
const voter = require('./voter');

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
    width: 520,
    height: 380,
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
      SUM(CASE WHEN status = 'voting' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'setup' THEN 1 ELSE 0 END)   AS setup,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END)  AS closed
    FROM elections
  `).get();
  return {
    active: row.active || 0,
    setup: row.setup || 0,
    closed: row.closed || 0,
  };
});

ipcMain.handle('auth:setup-check', () => auth.isConfigured());

ipcMain.handle('auth:setup', (_e, { name, officerId, password }) => {
  try {
    return auth.setupCoordinator(name, officerId, password);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('auth:login', (_e, { officerId, password }) => {
  try {
    const officer = auth.login(officerId, password);
    if (!officer) return { ok: false, error: 'Invalid officer ID or password' };
    return { ok: true, officer: stripSecret(officer) };
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
ipcMain.handle('election:delete', (_e, id) => election.deleteElection(id));

ipcMain.handle('election:positions', (_e, electionId) => election.listPositions(electionId));
ipcMain.handle('election:position-add', (_e, electionId, title, maxVotes) => election.addPosition(electionId, title, maxVotes));
ipcMain.handle('election:position-remove', (_e, id) => election.removePosition(id));

ipcMain.handle('election:candidates', (_e, electionId) => election.listCandidates(electionId));
ipcMain.handle('election:candidates-by-position', (_e, positionId) => election.listCandidatesByPosition(positionId));
ipcMain.handle('election:candidate-add', (_e, payload) => election.addCandidate(payload));
ipcMain.handle('election:candidate-remove', (_e, id) => election.removeCandidate(id));

// ---------- Voter IPC ----------

ipcMain.handle('voter:list', (_e, electionId, opts) => voter.listVoters(electionId, opts || {}));
ipcMain.handle('voter:get', (_e, electionId, voterId) => voter.getVoter(electionId, voterId));
ipcMain.handle('voter:add', (_e, payload) => voter.addVoter(payload));
ipcMain.handle('voter:import', (_e, electionId, csvText) => voter.importCsv(electionId, csvText));
ipcMain.handle('voter:autogen', (_e, electionId, opts) => voter.autoGenerate(electionId, opts || {}));
ipcMain.handle('voter:delete', (_e, electionId, voterId) => voter.deleteVoter(electionId, voterId));
ipcMain.handle('voter:clear', (_e, electionId) => voter.clearVoters(electionId));
ipcMain.handle('voter:unvote', (_e, electionId, voterId) => voter.unvoteVoter(electionId, voterId));
