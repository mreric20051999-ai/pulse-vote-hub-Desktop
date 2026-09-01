// Automatic backup & restore.
//
// Two safety nets for election day:
//   1. Scheduled + on-close backups are written with better-sqlite3's .backup()
//      (SQLite's online backup API), so a consistent snapshot is produced even
//      while votes are being written — no torn/corrupt copies.
//   2. Restore verifies the chosen backup's vote/audit hash chains + page
//      integrity BEFORE swapping it in, pauses LAN while the file is swapped
//      (so no device writes during the exchange), rolls back on a bad restore,
//      then resumes LAN.
//
// This module is deliberately thin and receives its two dependencies from the
// main process: `db` (the db module) and `lan` (the LanManager). No Electron
// globals are needed here so it stays unit-testable.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const integrity = require('./integrity');

const CFG = {
  enabled: 'auto_backup_enabled',
  interval: 'auto_backup_interval_min',
  keep: 'auto_backup_keep',
  dir: 'auto_backup_dir',
  last: 'auto_backup_last',
};

// Defaults mirror what the UI pre-fills so the scheduler and the form agree.
const DEFAULTS = { enabled: false, intervalMin: 30, keep: 10, dir: null };

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function dbSize() {
  try { return fs.statSync(dbModule.getDbPath()).size; } catch (e) { return 0; }
}

let dbModule = null;
let lan = null;
let timer = null;

function configure(deps) {
  dbModule = deps.db;
  lan = deps.lan || null;
}

function defaultDir() {
  return path.join(appUserData, 'backups');
}
let appUserData = '';
function setUserData(u) { appUserData = u || ''; }

function settingsDir() {
  return (dbModule.getConfig(CFG.dir) || '').trim() || defaultDir();
}

function getSettings() {
  const on = dbModule.getConfig(CFG.enabled) === '1';
  const interval = Number(dbModule.getConfig(CFG.interval)) || DEFAULTS.intervalMin;
  const keep = Number(dbModule.getConfig(CFG.keep)) || DEFAULTS.keep;
  const dir = (dbModule.getConfig(CFG.dir) || '').trim() || defaultDir();
  const last = Number(dbModule.getConfig(CFG.last)) || 0;
  const dirOk = (() => { try { fs.mkdirSync(dir, { recursive: true }); return true; } catch (e) { return false; } })();
  const list = listBackups(dir);
  return {
    enabled: on,
    intervalMin: interval,
    keep,
    dir,
    lastRun: last,
    dbSize: dbSize(),
    dirOk,
    backups: list,
  };
}

function saveSettings(s) {
  dbModule.setConfig(CFG.enabled, s.enabled ? '1' : '0');
  dbModule.setConfig(CFG.interval, String(Math.max(1, Number(s.intervalMin) || DEFAULTS.intervalMin)));
  dbModule.setConfig(CFG.keep, String(Math.max(1, Number(s.keep) || DEFAULTS.keep)));
  if (s.dir && String(s.dir).trim()) dbModule.setConfig(CFG.dir, String(s.dir).trim());
  try { fs.mkdirSync(settingsDir(), { recursive: true }); } catch (e) { /* noop */ }
  return getSettings();
}

// Produce one consistent snapshot via better-sqlite3's online backup API.
async function runBackup(dirOverride) {
  const dir = (dirOverride || '').trim() || settingsDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: 'Cannot create backup folder: ' + e.message }; }
  const name = `pvh-auto-${stamp()}.db`;
  const dest = path.join(dir, name);
  try {
    const d = dbModule.get();
    await d.backup(dest);
    dbModule.setConfig(CFG.last, String(Date.now()));
    prune(dir, dbModule.getConfig(CFG.keep) || DEFAULTS.keep);
    return { ok: true, path: dest, name };
  } catch (err) {
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (e) { /* noop */ }
    return { ok: false, error: err.message };
  }
}

// Keep only the most recent N backups in a folder. Also removes orphaned
// SQLite sidecar files (-wal / -shm) whose .db copy has been pruned, so the
// folder never accumulates leftovers.
function prune(dir, keep) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return; }
  const dbs = entries
    .filter((f) => /^pvh-auto-.*\.db$/.test(f))
    .map((f) => ({ f, m: (() => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch (e) { return 0; } })() }))
    .sort((a, b) => b.m - a.m);
  keep = Math.max(1, Number(keep) || DEFAULTS.keep);
  dbs.slice(keep).forEach((x) => {
    try { fs.unlinkSync(path.join(dir, x.f)); } catch (e) { /* noop */ }
  });
  // Remove sidecars for backups that no longer exist.
  const kept = new Set(dbs.slice(0, keep).map((x) => x.f));
  entries
    .filter((f) => /^pvh-auto-.*\.(db-wal|db-shm)$/.test(f))
    .forEach((f) => {
      const base = f.replace(/-(wal|shm)$/, '');
      if (!kept.has(base)) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* noop */ } }
    });
}

function listBackups(dirOverride) {
  const dir = (dirOverride || '').trim() || settingsDir();
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return []; }
  return files
    .filter((f) => /^pvh-auto-.*\.db$/.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (e) { /* noop */ }
      return { name: f, path: full, size, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// Verify a backup file fully (hash chains + signatures + page integrity) against
// a detached read-only handle — used BEFORE touching the live database.
function verifyBackupFile(filePath) {
  try {
    const BetterSqlite3 = require('better-sqlite3');
    const d = new BetterSqlite3(filePath, { readonly: true });
    let result;
    try {
      const checkers = [
        () => integrity.verifyVoteChain(d),
        () => integrity.verifyAuditChain(d),
        () => integrity.verifyPragma(d),
        () => integrity.verifyVoteSignatures(d),
      ];
      const parts = {};
      const labels = ['voteChain', 'auditChain', 'pragma', 'signatures'];
      checkers.forEach((fn, i) => { parts[labels[i]] = fn(); });
      const ok = ['voteChain', 'auditChain', 'pragma', 'signatures'].every((k) => parts[k].ok);
      result = { ok, checkedAt: Date.now(), ...parts };
    } finally {
      try { d.close(); } catch (e) { /* noop */ }
    }
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Swap a verified backup into the live location. Pauses LAN, closes the live
// DB, swaps the file, reopens, verifies, and rolls back on failure.
async function restore(filePath) {
  if (!dbModule.getDbPath) return { ok: false, error: 'Backup module not configured' };
  const live = dbModule.getDbPath();
  if (path.resolve(filePath) === path.resolve(live)) return { ok: false, error: 'That is the live database file itself.' };
  if (!fs.existsSync(filePath)) return { ok: false, error: 'Backup file not found.' };

  // 1. Confirm the backup is healthy before touching anything.
  const check = verifyBackupFile(filePath);
  if (!check.ok) {
    return { ok: false, error: 'This backup failed integrity verification and was NOT restored.', report: summarize(check) };
  }

  const lanWasOn = !!lan && lan.status().mode !== 'off';
  if (lan && lanWasOn) { try { await lan.stop(); } catch (e) { /* noop */ } }

  // Rollback copy of the current live DB.
  const rollback = path.join(path.dirname(live), `pre-restore-${stamp()}.db`);
  try {
    dbModule.close();
    fs.copyFileSync(live, rollback);
    fs.copyFileSync(filePath, live);
    if (fs.existsSync(live + '-wal')) { try { fs.unlinkSync(live + '-wal'); } catch (e) { /* noop */ } }
    if (fs.existsSync(live + '-shm')) { try { fs.unlinkSync(live + '-shm'); } catch (e) { /* noop */ } }
    dbModule.init();

    // 2. Verify the restored live DB; roll back if anything is off.
    const liveCheck = integrity.verifyAll();
    if (!liveCheck.ok) {
      dbModule.close();
      try { fs.copyFileSync(rollback, live); } catch (e) { /* noop */ }
      dbModule.init();
      if (lan && lanWasOn) { try { await lan.resume(); } catch (e) { /* noop */ } }
      return { ok: false, error: 'Restored database failed verification — rolled back to the previous database.', report: summarize(liveCheck) };
    }

    dbModule.setConfig(CFG.dir, path.dirname(filePath));
    if (lan && lanWasOn) { try { await lan.resume(); } catch (e) { /* noop */ } }
    return { ok: true, report: summarize(liveCheck), rollbackFile: rollback };
  } catch (err) {
    // Something threw mid-swap; try to restore the original DB.
    try {
      dbModule.close();
      fs.copyFileSync(rollback, live);
      dbModule.init();
    } catch (e) { /* noop */ }
    if (lan && lanWasOn) { try { await lan.resume(); } catch (e) { /* noop */ } }
    return { ok: false, error: err.message };
  }
}

function summarize(check) {
  return {
    voteChain: check.voteChain,
    auditChain: check.auditChain,
    pragma: check.pragma,
    signatures: check.signatures,
  };
}

// ----- scheduler -----

function dueMs(settings) {
  const intervalMs = Math.max(1, settings.intervalMin) * 60000;
  const last = settings.lastRun || 0;
  return last + intervalMs - Date.now();
}

function startScheduler() {
  stopScheduler();
  timer = setInterval(checkAndRun, 30 * 1000);
  checkAndRun();
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

async function checkAndRun() {
  if (!dbModule) return;
  let on = false;
  try { on = dbModule.getConfig('auto_backup_enabled') === '1'; } catch (e) { on = false; }
  if (!on) return;
  const s = getSettings();
  if (dueMs(s) > 0) return;
  try { await runBackup(); } catch (e) { /* noop */ }
}

// Run one now (forces regardless of schedule) and return the updated state.
async function runNow() {
  const r = await runBackup();
  return { ...r, settings: getSettings() };
}

module.exports = {
  configure,
  setUserData,
  getSettings,
  saveSettings,
  runBackup,
  runNow,
  listBackups,
  verifyBackupFile,
  restore,
  startScheduler,
  stopScheduler,
};
