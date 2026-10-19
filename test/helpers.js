// Shared test bootstrap: stubs the electron module (so the real production
// modules load under plain Node) and points the database at a throwaway
// temp file. Every test file requires this FIRST.
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvh-test-'));
const dbPath = path.join(dir, 'test.db');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => dir,
        getVersion: () => '0.0.0-test',
        isPackaged: false,
        getName: () => 'Pulse Vote Hub Test',
      },
      ipcMain: { handle: () => {}, on: () => {} },
      BrowserWindow: function BrowserWindow() {},
      nativeTheme: {},
      dialog: {},
      shell: {},
      contextBridge: { exposeInMainWorld: () => {} },
      ipcRenderer: { invoke: async () => {}, on: () => {}, send: () => {} },
    };
  }
  return originalLoad.apply(this, arguments);
};

// Give later require()s of db.js a stable handle on this test database.
const db = require('../electron/db');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || 'eq'} — expected ${b}, got ${a}`);
}

function ok(value, label) {
  if (!value) throw new Error(label || 'expected truthy value');
}

function report(file) {
  console.log(`${file}: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.err.stack || f.err.message}`);
    process.exit(1);
  }
}

// Temp database path for assertions / cleanup.
module.exports = { db, dbPath, dir, check, eq, ok, report };
