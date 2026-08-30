// LAN hub (host device): an Express + WebSocket server that is the source of
// truth for the network. It validates and records peer events transactionally
// against its own SQLite, broadcasts accepted events to every other client, and
// serves full/partial snapshots so peers can reconcile.
const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const sync = require('./sync');
const db = require('../db');
const voter = require('../voter');
const station = require('../station');

function Hub({ d, deviceId, deviceName, version, onStatus, rendererDir, kioskEnabled, onWritten }) {
  this.d = d;
  this.deviceId = deviceId;
  this.deviceName = deviceName;
  this.version = version;
  this.onStatus = onStatus || (() => {});
  this.rendererDir = rendererDir;
  this.kioskEnabled = kioskEnabled !== false;
  this.onWritten = onWritten || (() => {});
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

  // Browser ballot ("kiosk in any browser, no install"). Only exposed while the
  // hub is running (host mode). Votes pushed here go through the exact same
  // voter module the desktop ballot uses, so integrity hashing and LAN sync
  // behave identically to a ballot cast on the machine itself.
  if (self.kioskEnabled) self._mountKiosk(app);

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

Hub.prototype._mountKiosk = function (app) {
  const self = this;
  const rd = this.rendererDir;

  // Ballot statics (same relative paths vote.html uses).
  app.use('/js', express.static(path.join(rd, 'js'), { index: false, maxAge: 0 }));
  app.use('/css', express.static(path.join(rd, 'css'), { index: false, maxAge: 0 }));
  app.use('/assets', express.static(path.join(rd, 'assets'), { index: false, maxAge: 0 }));

  // The ballot page, with the browser transport shim injected so vote.js runs
  // unchanged in a plain browser.
  app.get('/kiosk', (_req, res) => {
    try {
      let html = fs.readFileSync(path.join(rd, 'vote.html'), 'utf8');
      if (!html.includes('<script src="js/vote.js"></script>')) {
        res.status(500).json({ ok: false, error: 'Ballot template malformed' });
        return;
      }
      html = html.replace(
        '<script src="js/vote.js"></script>',
        '<script src="js/kiosk-server.js"></script>\n  <script src="js/vote.js"></script>');
      res.type('html').send(html);
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Ballot template unavailable' });
    }
  });

  // Public ballot data (read-only). Elections are listed like the desktop
  // picker expects; positions/candidates mirror the desktop IPC result shapes.
  app.get('/api/kiosk/elections', (_req, res) => {
    try {
      res.json({ ok: true, elections: self._kioskElections() });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.get('/api/kiosk/positions/:electionId', (req, res) => {
    try {
      const rows = self.d.prepare(
        'SELECT p.*, (SELECT COUNT(*) FROM candidates c WHERE c.position_id = p.id) AS candidate_count FROM positions p WHERE p.election_id = ? ORDER BY p.title'
      ).all(String(req.params.electionId || ''));
      res.json({ ok: true, positions: rows });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.get('/api/kiosk/candidates/:electionId', (req, res) => {
    try {
      const rows = self.d.prepare(
        'SELECT id, election_id, position_id, name, photo_path, ballot_number, sort_order FROM candidates WHERE election_id = ? ORDER BY sort_order, ballot_number'
      ).all(String(req.params.electionId || ''));
      res.json({ ok: true, candidates: rows });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // Candidate photos, resolved the same way the desktop does.
  app.get('/api/kiosk/photo', (req, res) => {
    const stored = req.query.p;
    if (!stored) { res.status(400).json({ ok: false, error: 'Missing photo path' }); return; }
    const abs = path.isAbsolute(stored) ? stored : path.join(db.getDataDir(), stored);
    if (!fs.existsSync(abs)) { res.status(404).json({ ok: false, error: 'Photo not found' }); return; }
    const ct = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.type(ct);
    fs.createReadStream(abs).on('error', () => res.status(404).end()).pipe(res);
  });

  // Identity gate — identical to the desktop kiosk flow.
  app.post('/api/kiosk/verify', express.json(), (req, res) => {
    const b = req.body || {};
    if (!b.electionId || !b.voterId || b.password === undefined) {
      res.status(400).json({ ok: false, error: 'Missing verification fields' });
      return;
    }
    res.json(voter.verifyVoter(b.electionId, b.voterId, b.password));
  });

  app.post('/api/kiosk/verify-details', express.json(), (req, res) => {
    const b = req.body || {};
    if (!b.electionId || !b.voterId) {
      res.status(400).json({ ok: false, error: 'Missing recovery fields' });
      return;
    }
    res.json(voter.verifyVoterDetails(b.electionId, b.details || {}));
  });

  // Cast a ballot from a browser. Reuses the desktop castVote (validation,
  // vote+audit hash chain, transactional write), then fans the vote out to any
  // connected LAN peers exactly like a ballot cast on this machine.
  app.post('/api/kiosk/cast', express.json(), (req, res) => {
    const b = req.body || {};
    if (!b.electionId || !b.voterId || !Array.isArray(b.selection)) {
      res.status(400).json({ ok: false, error: 'Missing cast fields' });
      return;
    }
    const r = voter.castVote(b.electionId, b.voterId, b.selection, b.station);
    if (r && r.ok) {
      try { self.onWritten(b.electionId, b.voterId, b.selection, r.timestamp); } catch (err) { /* ignore */ }
    }
    res.json(r);
  });

  app.get('/api/kiosk/status', (_req, res) => {
    res.json({
      ok: true,
      deviceName: self.deviceName,
      version: self.version,
      ballotUrl: self.port ? `http://localhost:${self.port}/kiosk` : null,
    });
  });
};

Hub.prototype._kioskElections = function () {
  const rows = this.d.prepare(`
    SELECT e.id, e.title, e.type, e.status, e.election_date, e.start_date, e.end_date, e.voter_scheme,
      (SELECT COUNT(*) FROM candidates c WHERE c.election_id = e.id) AS candidate_count
    FROM elections e
    ORDER BY e.created_at DESC
  `).all();
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    status: r.status,
    election_date: r.election_date,
    start_date: r.start_date,
    end_date: r.end_date,
    voter_scheme: r.voter_scheme,
    candidate_count: r.candidate_count,
  }));
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
        station: msg.station,
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
        voter_id: msg.voter_id, officer_name: msg.officer_name, device_id: msg.device_id, station: msg.station,
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

    case 'message': {
      const rec = {
        id: msg.id, from_officer_id: msg.from_officer_id, from_name: msg.from_name,
        from_officer: msg.from_officer, to_officer: msg.to_officer,
        to_officer_name: msg.to_officer_name, reply_to_id: msg.reply_to_id,
        body: msg.body, created_at: msg.created_at, read: msg.read === 1 ? 1 : 0,
      };
      const res = sync.recordRemoteMessage(this.d, rec);
      if (!res.ok) {
        send({ t: 'conflict', type: 'message', ref: { id: msg.id }, code: res.reason, reason: 'Invalid message' });
        return;
      }
      this._broadcast({ t: 'broadcast', type: 'message', payload: rec }, ws);
      send({ t: 'accepted', type: 'message', ref: { id: msg.id } });
      this._touch();
      this._audit('lan:message', `"Speak to admin" message over LAN from ${msg.from_name || 'peer'}`);
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
  let stationId = null;
  let stationLabel = msg.station || null;
  if (msg.voter_id) {
    const v = self.d.prepare(
      'SELECT station_id, assigned_station FROM voters WHERE election_id = ? AND voter_id = ?'
    ).get(msg.election_id, String(msg.voter_id || '').trim().toUpperCase());
    if (v) {
      const st = station.resolveVoterStation(v);
      stationId = st ? st.id : null;
      if (!stationLabel) stationLabel = (v.assigned_station || null);
    }
  }
  const rows = (msg.selections || []).map((sel, i) => ({
    election_id: msg.election_id,
    voter_id: msg.voter_id,
    position_title: sel.position_title,
    candidate_name: sel.candidate_name,
    device_id: msg.device_id || null,
    station: stationLabel,
    station_id: stationId,
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