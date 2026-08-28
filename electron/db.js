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
  role TEXT CHECK(role IN ('admin', 'coordinator', 'assistant')) DEFAULT 'assistant',
  assigned_device TEXT,
  assigned_election_id TEXT,
  assigned_station_id TEXT,
  suspended INTEGER DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS elections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT CHECK(type IN ('school', 'station')),
  status TEXT CHECK(status IN ('draft', 'upcoming', 'active', 'closed')) DEFAULT 'draft',
  election_date INTEGER,
  start_date INTEGER,
  end_date INTEGER,
  station_mode INTEGER DEFAULT 0,
  close_grace_minutes INTEGER DEFAULT 30,
  max_close_grace_minutes INTEGER DEFAULT 120,
  owner_id TEXT,
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
  ballot_number INTEGER,
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
  station_id TEXT,
  checked_in INTEGER DEFAULT 0,
  checked_in_at INTEGER,
  checked_in_by TEXT,
  ballot_cast INTEGER DEFAULT 0,
  grace_period INTEGER DEFAULT 0,
  has_voted INTEGER DEFAULT 0,
  voted_at INTEGER,
  position_voted TEXT
);

CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  election_id TEXT REFERENCES elections(id),
  name TEXT NOT NULL,
  location TEXT,
  code TEXT,
  status TEXT CHECK(status IN ('not_opened', 'open', 'queuing', 'counted', 'submitted')) DEFAULT 'not_opened',
  opened_at INTEGER,
  zero_report INTEGER DEFAULT 0,
  opened_by_name TEXT,
  closed_at INTEGER,
  closed_by_name TEXT,
  grace_minutes INTEGER,
  grace_ends_at INTEGER,
  queue_closed_at INTEGER,
  final_submit_json TEXT,
  created_at INTEGER
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
  addColumn('elections', 'start_date', 'INTEGER');
  addColumn('elections', 'end_date', 'INTEGER');
  addColumn('elections', 'station_mode', 'INTEGER DEFAULT 0');
  addColumn('elections', 'close_grace_minutes', 'INTEGER DEFAULT 30');
  addColumn('elections', 'max_close_grace_minutes', 'INTEGER DEFAULT 120');
  addColumn('elections', 'owner_id', 'TEXT');
  addColumn('candidates', 'ballot_number', 'INTEGER');
  addColumn('officers', 'suspended', 'INTEGER DEFAULT 0');

  // Station-runtime columns (faithful to the web station flow).
  addColumn('officers', 'assigned_election_id', 'TEXT');
  addColumn('officers', 'assigned_station_id', 'TEXT');
  addColumn('voters', 'station_id', 'TEXT');
  addColumn('voters', 'checked_in', 'INTEGER DEFAULT 0');
  addColumn('voters', 'checked_in_at', 'INTEGER');
  addColumn('voters', 'checked_in_by', 'TEXT');
  addColumn('voters', 'ballot_cast', 'INTEGER DEFAULT 0');
  addColumn('voters', 'grace_period', 'INTEGER DEFAULT 0');
  addColumn('voters', 'plain_password', 'TEXT');
  addColumn('voters', 'phone', 'TEXT');
  addColumn('elections', 'voter_scheme', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      election_id TEXT REFERENCES elections(id),
      name TEXT NOT NULL,
      location TEXT,
      code TEXT,
      status TEXT CHECK(status IN ('not_opened', 'open', 'queuing', 'counted', 'submitted')) DEFAULT 'not_opened',
      opened_at INTEGER,
      zero_report INTEGER DEFAULT 0,
      opened_by_name TEXT,
      closed_at INTEGER,
      closed_by_name TEXT,
      grace_minutes INTEGER,
      grace_ends_at INTEGER,
      queue_closed_at INTEGER,
      final_submit_json TEXT,
      created_at INTEGER
    );
  `);

  // Older databases had a role CHECK constraint without 'admin'. SQLite cannot
  // ALTER a CHECK constraint, so rebuild the officers table to allow the role.
  const hasAdminRole = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='officers'"
  ).get();
  if (hasAdminRole && !/role IN \('admin'/.test(hasAdminRole.sql)) {
    db.exec(`
      ALTER TABLE officers RENAME TO officers_old;
      CREATE TABLE officers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        officer_id TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT CHECK(role IN ('admin', 'coordinator', 'assistant')) DEFAULT 'assistant',
        assigned_device TEXT,
        assigned_election_id TEXT,
        assigned_station_id TEXT,
        suspended INTEGER DEFAULT 0,
        created_at INTEGER
      );
      INSERT INTO officers (id, name, officer_id, password, role, assigned_device, assigned_election_id, assigned_station_id, suspended, created_at)
        SELECT id, name, officer_id, password, role, assigned_device, assigned_election_id, assigned_station_id, COALESCE(suspended, 0), created_at
        FROM officers_old;
      DROP TABLE officers_old;
    `);
  }

  // Migrate legacy statuses to the web-app model:
  //   setup -> draft, voting -> active (closed stays closed). Rebuild the
  //   elections table so the status CHECK accepts the new status values.
  const elecSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='elections'"
  ).get();
  const statusCol = db.prepare("SELECT name FROM pragma_table_info('elections') WHERE name='status'").get();
  const statusIsLegacy = statusCol && /setup.*voting.*closed/.test(elecSql.sql);
  if (statusIsLegacy) {
    db.prepare("UPDATE elections SET status = CASE status WHEN 'setup' THEN 'draft' WHEN 'voting' THEN 'active' ELSE status END").run();
    db.exec(`
      ALTER TABLE elections RENAME TO elections_old;
      CREATE TABLE elections (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT CHECK(type IN ('school', 'station')),
        status TEXT CHECK(status IN ('draft', 'upcoming', 'active', 'closed')) DEFAULT 'draft',
        election_date INTEGER,
        start_date INTEGER,
        end_date INTEGER,
        station_mode INTEGER DEFAULT 0,
        close_grace_minutes INTEGER DEFAULT 30,
        max_close_grace_minutes INTEGER DEFAULT 120,
        created_at INTEGER,
        closed_at INTEGER
      );
      INSERT INTO elections (
        id, title, type, status, election_date, start_date, end_date,
        station_mode, close_grace_minutes, max_close_grace_minutes, created_at, closed_at
      )
        SELECT id, title, type, status, election_date, start_date, end_date,
               COALESCE(station_mode, 0), COALESCE(close_grace_minutes, 30),
               COALESCE(max_close_grace_minutes, 120), created_at, closed_at
        FROM elections_old;
      DROP TABLE elections_old;
    `);
  }

  // Older databases had stale child-table foreign keys left over from an early
  // rebuild of the elections table: positions/candidates/voters.election_id
  // still REFERENCES "elections_old" (a table that no longer exists). SQLite
  // cannot ALTER a FK, so rebuild those tables to point at "elections" again.
  // Each scene is pristine (it also repairs tables that lost their PRIMARY KEY
  // annotations from an earlier naive rebuild). FK enforcement is toggled off
  // during the structural changes to avoid "foreign key mismatch" errors, and
  // any leftover '*_old' tables from interrupted runs are dropped.
  const STALE = { name: 'elections_old', ddl: /\belections_old\b/ };
  const childDdl = {
    positions: `id TEXT PRIMARY KEY, election_id TEXT REFERENCES elections(id), title TEXT NOT NULL, max_votes INTEGER DEFAULT 1`,
    candidates: `id TEXT PRIMARY KEY, election_id TEXT REFERENCES elections(id), position_id TEXT REFERENCES positions(id), name TEXT NOT NULL, photo_path TEXT, ballot_number INTEGER, sort_order INTEGER`,
    voters: `id TEXT PRIMARY KEY, election_id TEXT REFERENCES elections(id), voter_id TEXT NOT NULL, name TEXT, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, assigned_station TEXT, station_id TEXT, checked_in INTEGER DEFAULT 0, checked_in_at INTEGER, checked_in_by TEXT, ballot_cast INTEGER DEFAULT 0, grace_period INTEGER DEFAULT 0, has_voted INTEGER DEFAULT 0, voted_at INTEGER, position_voted TEXT`,
  };
  const staleRef = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table'"
  ).all().filter((t) => childDdl[t.name] && STALE.ddl.test(t.sql));
  if (staleRef.length) {
    db.pragma('foreign_keys = OFF');
    const tx = db.transaction(() => {
      for (const name of ['positions', 'candidates', 'voters']) {
        db.exec(`DROP TABLE IF EXISTS ${name}_old`);
        if (!staleRef.some((x) => x.name === name)) continue;
        const cols = db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all().map((c) => c.name);
        const colList = cols.join(', ');
        db.exec(`
          ALTER TABLE ${name} RENAME TO ${name}_old;
          CREATE TABLE ${name} (${childDdl[name]});
          INSERT INTO ${name} (${colList}) SELECT ${colList} FROM ${name}_old;
          DROP TABLE ${name}_old;
        `);
      }
    });
    tx();
    db.pragma('foreign_keys = ON');
  }

  // Backfill ballot numbers for candidates that predate the column.
  backfillBallotNumbers();

  // Backfill election start_date from the legacy single election_date.
  db.prepare('UPDATE elections SET start_date = election_date WHERE start_date IS NULL AND election_date IS NOT NULL').run();

  // Ownership: elections predating coordinator isolation have no owner. Claim
  // them by the first admin so existing data remains visible to admins (who
  // can see everything) and is not exposed to coordinators.
  const admin = db.prepare("SELECT id FROM officers WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
  if (admin) db.prepare('UPDATE elections SET owner_id = ? WHERE owner_id IS NULL').run(admin.id);
}

// Assign sequential ballot numbers (per category) to any candidates that
// don't have one yet, ordered by their sort order.
function backfillBallotNumbers() {
  const rows = db.prepare(
    'SELECT id, position_id FROM candidates WHERE ballot_number IS NULL ORDER BY position_id, sort_order'
  ).all();
  const perPos = new Map();
  for (const r of rows) {
    let n = perPos.get(r.position_id) || 0;
    n += 1;
    perPos.set(r.position_id, n);
    db.prepare('UPDATE candidates SET ballot_number = ? WHERE id = ?').run(n, r.id);
  }
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
