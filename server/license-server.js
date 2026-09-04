#!/usr/bin/env node
// ---- Pulse Vote Hub — Activation License Server ----
//
// Self-hostable server that powers per-device, revocable licensing across many
// installed copies. You (the developer/owner) run this anywhere that stays
// reachable (a VPS, Render, Railway, Glitch, a home box, etc.) and point each
// installed app at it via the URL + admin token.
//
// How it works:
//   - You POST /mint with an admin token + a site name  -> you get a PVH- code
//   - An installed app POSTs /redeem with that code + its machine id -> the
//     server validates it, binds it to that ONE machine, and returns licensed
//     status. That code is now single-use (its device is recorded).
//   - You can GET /codes (list), POST /revoke (revoke a license), and the app
//     re-checks /status on startup so revocations propagate to devices.
//
// The code is the credential, exactly like the app's older local-only model,
// but now verified server-side so a code minted by you works on ANY device
// without shipping database files.
//
// Run:
//   PORT=8080 PVH_ADMIN_TOKEN=<your-secret> node server/license-server.js
//
// Endpoints (all JSON):
//   POST /mint   { admin_token, site_name }              -> { ok, code, site_name }
//   GET  /codes  ?admin_token=                           -> { ok, codes: [...] }
//   POST /revoke { admin_token, id }                     -> { ok, revoked }
//   POST /redeem { code, machine_id }                    -> { ok, licensed, ... }
//   GET  /status ?code=                                  -> { ok, licensed, site, revoked, machine_id }
//
// All lookups use the raw code normalized the same way the app normalizes it
// (strip separators, uppercase). The server stores a SHA-256 of the code so a
// breach of the server DB does not leak usable codes.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const PORT = Number(process.env.PORT || 8080);
const ADMIN_TOKEN = process.env.PVH_ADMIN_TOKEN || '';
const DB_PATH = process.env.PVH_LIC_DB || path.join(__dirname, 'licenses.sqlite');

if (!ADMIN_TOKEN) {
  console.error('License server requires PVH_ADMIN_TOKEN. Set e.g. PVH_ADMIN_TOKEN=a-strong-secret.');
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    site_name TEXT NOT NULL,
    created_at INTEGER,
    redeemed_at INTEGER,
    redeemed_machine TEXT,
    revoked_at INTEGER
  );
`);

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode() {
  let raw = '';
  for (let i = 0; i < 8; i++) raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `PVH-${raw.slice(0, 4)}-${raw.slice(4)}`;
}

// Normalize exactly as the app does so codes typed by customers match.
function normalize(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const hash = (code) => crypto.createHash('sha256').update(normalize(code)).digest('hex');

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
});

// Verify admin token against both body and header (constant-time).
function isAdmin(body, headers) {
  const given = (body && body.admin_token) || headers['x-admin-token'] || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  // CORS not needed for a desktop app (it uses http/https directly), but keep
  // harmless support for a browser-based admin panel if you add one later.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return json(res, 204, {});

  try {
    if (req.method === 'POST' && route === '/mint') {
      const body = await readBody(req);
      if (!isAdmin(body, req.headers)) return json(res, 403, { ok: false, error: 'Forbidden: bad admin token' });
      const site = String(body.site_name || '').trim();
      if (!site) return json(res, 400, { ok: false, error: 'site_name is required' });
      const code = generateCode();
      db.prepare('INSERT INTO licenses (id, code_hash, site_name, created_at) VALUES (?,?,?,?)')
        .run(uuidv4(), hash(code), site, Date.now());
      return json(res, 200, { ok: true, code, site_name: site });
    }

    if (req.method === 'GET' && route === '/codes') {
      if (!isAdmin({ admin_token: url.searchParams.get('admin_token') }, req.headers)) {
        return json(res, 403, { ok: false, error: 'Forbidden: bad admin token' });
      }
      const rows = db.prepare('SELECT id, site_name, created_at, redeemed_at, redeemed_machine, revoked_at FROM licenses ORDER BY created_at DESC').all();
      const codes = rows.map((r) => ({
        ...r,
        status: r.redeemed_at ? 'used' : (r.revoked_at ? 'revoked' : 'active'),
      }));
      return json(res, 200, { ok: true, codes });
    }

    if (req.method === 'POST' && route === '/revoke') {
      const body = await readBody(req);
      if (!isAdmin(body, req.headers)) return json(res, 403, { ok: false, error: 'Forbidden: bad admin token' });
      const row = db.prepare('SELECT * FROM licenses WHERE id = ?').get(body.id);
      if (!row) return json(res, 404, { ok: false, error: 'License not found' });
      db.prepare('UPDATE licenses SET revoked_at = ? WHERE id = ?').run(Date.now(), row.id);
      return json(res, 200, { ok: true, id: row.id, revoked: true });
    }

    if (req.method === 'POST' && route === '/redeem') {
      const body = await readBody(req);
      const raw = normalize(body.code);
      const machine = String(body.machine_id || '').trim();
      if (!raw) return json(res, 400, { ok: false, error: 'A code is required' });
      if (!machine) return json(res, 400, { ok: false, error: 'machine_id is required' });

      const row = db.prepare('SELECT * FROM licenses WHERE code_hash = ?').get(hash(raw));
      if (!row) return json(res, 200, { ok: false, licensed: false, error: 'Invalid activation code' });
      if (row.revoked_at) return json(res, 200, { ok: false, licensed: false, error: 'This activation code has been revoked' });
      if (row.redeemed_at) {
        // Already used: allow re-activation ONLY on the same machine so a
        // reinstalled device keeps working; block a different machine.
        if (row.redeemed_machine === machine) {
          return json(res, 200, { ok: true, licensed: true, site: row.site_name, machine });
        }
        return json(res, 200, { ok: false, licensed: false, error: 'This activation code is already in use on another device' });
      }
      db.prepare('UPDATE licenses SET redeemed_at = ?, redeemed_machine = ? WHERE id = ?')
        .run(Date.now(), machine, row.id);
      return json(res, 200, { ok: true, licensed: true, site: row.site_name, machine });
    }

    if (req.method === 'GET' && route === '/status') {
      const raw = normalize(url.searchParams.get('code'));
      if (!raw) return json(res, 400, { ok: false, error: 'code is required' });
      const row = db.prepare('SELECT * FROM licenses WHERE code_hash = ?').get(hash(raw));
      if (!row) return json(res, 200, { ok: true, licensed: false });
      return json(res, 200, {
        ok: true,
        licensed: !!row.redeemed_at && !row.revoked_at,
        revoked: !!row.revoked_at,
        site: row.site_name,
        machine_id: row.redeemed_machine,
      });
    }

    return json(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Pulse Vote Hub license server listening on http://0.0.0.0:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});