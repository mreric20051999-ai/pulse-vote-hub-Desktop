// ---- Pulse Vote Hub — license client (app side) ----
//
// Talks to the self-hosted license server (server/license-server.js) so that a
// code minted by the developer on any machine can be redeemed on a new device
// without shipping database files, and so licenses can be revoked server-side.
//
// Server URL + admin token are stored as app config keys (set in the developer
// console). The admin token is used only for mint/list/revoke; redemption is a
// public "code = credential" call, like the app's original local model.

const https = require('https');
const http = require('http');
const db = require('./db');

// Default license server bundled into the app so a brand-new device can redeem
// a code without any per-device configuration. The Developer console override
// (lic_server config key) takes precedence when it is set.
const DEFAULT_LICENSE_SERVER = 'https://pulse-vote-hub-license.onrender.com';

function serverConfig() {
  const url = (String(db.getConfig('lic_server') || '').trim() || DEFAULT_LICENSE_SERVER).replace(/\/+$/, '');
  const token = (String(db.getConfig('lic_server_token') || '').trim()) || '';
  return { url, token };
}

function hasServer() {
  return true; // a default server is always available; only the URL may change
}

function request(method, path, { body, token, query } = {}) {
  const { url, token: cfgToken } = serverConfig();
  if (!url) return Promise.resolve({ ok: false, error: 'License server not configured. Set it in the Developer console.' });

  let target;
  try { target = new URL(url); }
  catch (e) { return Promise.resolve({ ok: false, error: 'Invalid license server URL.' }); }

  const lib = target.protocol === 'https:' ? https : http;
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const adminToken = token || cfgToken;

  return new Promise((resolve) => {
    const req = lib.request(target, {
      method,
      path: path + qs,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'pulse-vote-hub',
        ...(adminToken ? { 'X-Admin-Token': adminToken } : {}),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); }
        catch (e) { resolve({ ok: false, error: 'Bad response from license server' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'License server timed out' }); });
    req.on('error', (err) => { resolve({ ok: false, error: 'License server unreachable: ' + err.message }); });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// --- Admin (developer) operations: require the admin token from config ---

function mintCode(siteName) {
  return request('POST', '/mint', { body: { site_name: siteName } });
}

function listCodes() {
  return request('GET', '/codes');
}

function revokeCode(id) {
  return request('POST', '/revoke', { body: { id } });
}

// --- Public (redeem / status): the code is the credential ---

function machineId() {
  // Stable per-machine id reused across installs so a device can re-activate.
  // Falls back to hostname; not secret, just a device identifier.
  const os = require('os');
  return (db.getConfig('device_id')) || os.hostname() || 'unknown-device';
}

function redeemLicense({ code }) {
  return request('POST', '/redeem', { body: { code, machine_id: machineId() } });
}

function licenseStatus(code) {
  return request('GET', '/status', { query: { code: code || '' } });
}

module.exports = { serverConfig, hasServer, mintCode, listCodes, revokeCode, redeemLicense, licenseStatus, machineId };