const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let db = null;
let dataDir = null;

// Data directory for both dev and packaged builds
function getDataDir() {
  if (dataDir) return dataDir;
  const base = app.getPath('userData');
  dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function getDbPath() {
  return path.join(getDataDir(), 'pulse-vote-hub.db');
}

// Schema — mirrors ROADMAP.html
const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS officers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  officer_id TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT CHECK(role IN ('coordinator', 'assistant')) DEFAULT 'assistant',
  assigned_device TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS elections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT CHECK(type IN ('school', 'station')),
  status TEXT CHECK(status IN ('setup', 'voting', 'closed')) DEFAULT 'setup',
  election_date INTEGER,
  created_at INTEGER,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  election_id TEXT REFERENCES elections(id),
  title TEXT NOT NULL,
  max_votes INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  election_id TEXT REFERENCES elections(id),
  position_id TEXT REFERENCES positions(id),
  name TEXT NOT NULL,
  photo_path TEXT,
  sort_order INTEGER
);

CREATE TABLE IF NOT EXISTS voters (
  id TEXT PRIMARY KEY,
  election_id TEXT REFERENCES elections(id),
  voter_id TEXT NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  assigned_station TEXT,
  has_voted INTEGER DEFAULT 0,
  voted_at INTEGER,
  position_voted TEXT
);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id TEXT,
  voter_id TEXT NOT NULL,
  officer_id TEXT,
  device_id TEXT,
  timestamp INTEGER,
  hash TEXT,
  UNIQUE(election_id, voter_id)
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id TEXT,
  position_id TEXT,
  candidate_id TEXT,
  voter_id TEXT,
  device_id TEXT,
  station_id TEXT,
  timestamp INTEGER,
  prev_hash TEXT,
  vote_hash TEXT,
  signature TEXT,
  synced INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id TEXT,
  officer_id TEXT,
  action TEXT,
  details TEXT,
  timestamp INTEGER,
  prev_hash TEXT,
  entry_hash TEXT
);
`;

function init() {
  if (db) return db;
  const BetterSqlite3 = require('better-sqlite3');
  const dbPath = getDbPath();
  db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate();
  return db;
}

// Idempotent migrations for existing databases (safe to run every start).
function migrate() {
  const addColumn = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  addColumn('elections', 'election_date', 'INTEGER');
}

function get() {
  if (!db) init();
  return db;
}

// --- config helpers ---
function getConfig(key) {
  const row = get().prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  get().prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

module.exports = {
  init,
  get,
  getDataDir,
  getDbPath,
  getConfig,
  setConfig,
};
