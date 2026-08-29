// LAN hub (host device): an Express + WebSocket server that is the source of
// truth for the network. It validates and records peer events transactionally
// against its own SQLite, broadcasts accepted events to every other client, and
// serves full/partial snapshots so peers can reconcile.
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const sync = require('./sync');

function Hub({ d, deviceId, deviceName, version, onStatus }) {
  this.d = d;
  this.deviceId = deviceId;
  this.deviceName = deviceName;
  this.version = version;
  this.onStatus = onStatus || (() => {});
  this.port = null;
  this.server = null;
  this.wss = null;
  this.peers = new Set(); // ws sockets
  this.peerMeta = new Map(); // ws -> { deviceId, deviceName }
  this.advertiser = null;
  this._pingTimer = null;
  this._statusTimer = null;
  this.stopped = false;
}

Hub.prototype.start = function (port) {
  const self = this;
  this.port = Number(port) || 7380;
  const app = express();

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, deviceName: self.deviceName, version: self.version, peers: self.peers.size });
  });

  app.get('/api/snapshot', (_req, res) => {
    try {
      res.json({ ok: true, generated_at: Date.now(), ...sync.buildSnapshot(self.d) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  this.server = http.createServer(app);
  this.wss = new WebSocketServer({ server: this.server });
  this.wss.on('connection', (ws) => this._onConnection(ws));
  this.wss.on('error', (err) => {
    if (!self.stopped && process.env.PVH_DEBUG === '1') console.error('[hub] wss error', err.message);
  });

  return new Promise((resolve, reject) => {
    this.server.once('error', (err) => reject(err));
    this.server.listen(this.port, '0.0.0.0', () => {
      if (process.env.PVH_DEBUG === '1') console.log('[hub] listening on 0.0.0.0:' + self.port);
      self._pingTimer = setInterval(() => self._heartbeat(), 20000);
      resolve(self);
    });
  });
};

Hub.prototype._onConnection = function (ws) {
  const self = this;
  this.peers.add(ws);
  this._touch();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    this._handleMessage(ws, msg);
  });
  ws.on('close', () => {
    this.peers.delete(ws);
    this.peerMeta.delete(ws);
    this._touch();
    this._bumpStatus();
  });
  ws.on('error', () => {});
};

Hub.prototype._handleMessage = function (ws, msg) {
  const self = this;
  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  switch (msg.t) {
    case 'hello':
      this.peerMeta.set(ws, { deviceId: msg.device_id, deviceName: msg.device_name });
      this._bumpStatus();
      send({
        t: 'welcome', server_id: this.deviceId, server_name: this.deviceName,
        server_version: this.version, port: this.port,
      });
      break;

    case 'sync':
      this._sendSnapshot(ws);
      break;

    case 'vote': {
      const res = sync.recordRemoteVote(this.d, msg.election_id, {
        voter_id: msg.voter_id,
        device_id: msg.device_id,
        selections: msg.selections || [],
      });
      if (!res.ok) {
        send({ t: 'conflict', type: 'vote', ref: res.ref, code: res.code, reason: res.reason });
        return;
      }
      this._broadcast({ t: 'broadcast', type: 'vote', payload: this._votePayload(msg.election_id, msg) }, ws);
      send({ t: 'accepted', type: 'vote', ref: res.ref });
      this._touch();
      this._audit('lan:vote', `Vote recorded over LAN from ${msg.device_id || 'peer'}`);
      break;
    }

    case 'checkin': {
      const res = sync.recordRemoteCheckin(this.d, msg.election_id, {
        voter_id: msg.voter_id, officer_name: msg.officer_name, device_id: msg.device_id,
      });
      if (!res.ok) {
        send({ t: 'conflict', type: 'checkin', ref: res.ref, code: res.code, reason: res.reason });
        return;
      }
      this._broadcast({
        t: 'broadcast', type: 'checkin',
        payload: { election_id: msg.election_id, voter_id: msg.voter_id, officer_name: msg.officer_name, device_id: msg.device_id, timestamp: Date.now() },
      }, ws);
      send({ t: 'accepted', type: 'checkin', ref: res.ref });
      this._touch();
      this._audit('lan:checkin', `Check-in recorded over LAN from ${msg.device_id || 'peer'}`);
      break;
    }

    case 'unvote': {
      const res = sync.recordRemoteUnvote(this.d, msg.election_id, { voter_id: msg.voter_id });
      if (!res.ok) {
        send({ t: 'conflict', type: 'unvote', ref: res.ref, code: res.code, reason: res.reason });
        return;
      }
      this._broadcast({ t: 'broadcast', type: 'unvote', payload: { election_id: msg.election_id, voter_id: msg.voter_id } }, ws);
      send({ t: 'accepted', type: 'unvote', ref: res.ref });
      this._touch();
      this._audit('lan:unvote', `Unvote recorded over LAN from ${msg.device_id || 'peer'}`);
      break;
    }

    case 'get_voter': {
      const state = sync.buildVoterState(this.d, msg.election_id, msg.voter_id);
      send({ t: 'voter_state', election_id: msg.election_id, state });
      break;
    }

    case 'ping':
      send({ t: 'pong' });
      break;

    default:
      break;
  }
};

// Convert a client vote message into the authoritative broadcast row (symbolic).
Hub.prototype._votePayload = function (_electionId, msg) {
  const self = this;
  const rows = (msg.selections || []).map((sel, i) => ({
    election_id: msg.election_id,
    voter_id: msg.voter_id,
    position_title: sel.position_title,
    candidate_name: sel.candidate_name,
    device_id: msg.device_id || null,
    station_id: null,
    timestamp: sel.timestamp || (Date.now() + i),
  }));
  return rows.length ? rows : null;
};

// Host-device events that were already written locally are broadcast verbatim
// so every client converges without re-recording on the hub.
Hub.prototype.broadcastLocal = function (type, payload) {
  this._broadcast({ t: 'broadcast', type, payload });
  this._touch();
};

Hub.prototype._broadcast = function (msg, except) {
  const text = JSON.stringify(msg);
  for (const ws of this.peers) {
    if (ws === except) continue;
    if (ws.readyState === 1) ws.send(text);
  }
};

Hub.prototype._sendSnapshot = function (ws) {
  try { ws.send(JSON.stringify({ t: 'snapshot', ...sync.buildSnapshot(this.d) })); }
  catch (e) { /* peer vanished */ }
};

Hub.prototype._heartbeat = function () {
  const self = this;
  for (const ws of this.peers) {
    if (ws.isAlive === false) { ws.terminate(); this.peers.delete(ws); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* noop */ }
  }
  this._bumpStatus();
};

Hub.prototype._audit = function (action, details) {
  try {
    const prev = this.d.prepare('SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
    const crypto = require('crypto');
    const timestamp = Date.now();
    const entry = { action, details, timestamp, prev_hash: prev ? prev.entry_hash : null, entry_hash: '' };
    entry.entry_hash = crypto.createHash('sha256').update(`${action}|${details}|${timestamp}`).digest('hex');
    this.d.prepare('INSERT INTO audit_log (election_id, officer_id, action, details, timestamp, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(null, null, action, details, timestamp, entry.prev_hash, entry.entry_hash);
  } catch (e) { /* audit never breaks sync */ }
};

Hub.prototype._touch = function () {
  const self = this;
  if (this._statusTimer) return;
  this._statusTimer = setTimeout(() => {
    self._statusTimer = null;
    self._bumpStatus();
  }, 50);
};

Hub.prototype._bumpStatus = function () {
  this.onStatus({
    type: 'peers',
    peerCount: this.peers.size,
    peers: [...this.peers].map((ws) => this.peerMeta.get(ws) || { deviceId: null, deviceName: 'Peer' }),
  });
};

Hub.prototype.stop = function () {
  const self = this;
  this.stopped = true;
  clearInterval(this._pingTimer);
  if (this._statusTimer) clearTimeout(this._statusTimer);
  if (this.advertiser) { try { this.advertiser.stop(); } catch (e) { /* noop */ } this.advertiser = null; }
  for (const ws of this.peers) { try { ws.close(); } catch (e) { /* noop */ } }
  this.peers.clear();
  if (this.wss) { try { this.wss.close(); } catch (e) { /* noop */ } }
  return new Promise((resolve) => {
    if (this.server) this.server.close(() => resolve());
    else resolve();
    if (self.stopped) resolve();
  });
};

module.exports = { Hub };