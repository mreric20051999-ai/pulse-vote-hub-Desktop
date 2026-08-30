// LanManager: ties the LAN modules (hub, peer, discovery, sync) to the app.
// One instance is created in main.js; it owns the current mode, persists it,
// routes local events to the right transport, and pushes status to any window.
const sync = require('./sync');
const discovery = require('./discovery');
const { Hub } = require('./hub');
const { Peer } = require('./peer');

const DEFAULT_PORT = 7380;

function LanManager({ getD, version = '1.0.0', rendererDir }) {
  this.getD = getD;
  this.version = version;
  this.rendererDir = rendererDir;
  this.mode = 'off';          // off | host | client
  this.hub = null;
  this.peer = null;
  this._statusCb = null;
  this._lastPeers = [];
  this._lastClient = null;
}

LanManager.prototype._d = function () {
  return this.getD();
};

LanManager.prototype.deviceName = function () {
  return sync.deviceNameOf(this._d());
};

LanManager.prototype.deviceId = function () {
  return sync.deviceIdOf(this._d());
};

LanManager.prototype._emitStatus = function () {
  const cb = this._statusCb;
  if (cb) {
    try { cb(this.status()); } catch (e) { /* renderer gone */ }
  }
};

// Called by hub/peer internals whenever something changes; merge into the full
// status snapshot that's pushed to the renderer.
LanManager.prototype._delegateStatus = function (patch) {
  if (patch && patch.type === 'peers') this._lastPeers = patch.peers || [];
  if (patch && patch.type === 'state') this._lastClient = patch;
  this._emitStatus();
};

LanManager.prototype.status = function () {
  const d = this._d();
  let stats = { votes: 0, lastVoteAt: null, unsynced: 0, queue: 0 };
  try {
    stats = {
      votes: sync.voteCount(d),
      lastVoteAt: sync.lastVoteAt(d),
      unsynced: this.mode === 'client' ? sync.unsyncedVoteCount(d) : 0,
      queue: this.mode === 'client' ? sync.queueSize(d) : 0,
    };
  } catch (e) { /* db not ready */ }
  return {
    mode: this.mode,
    deviceId: this.deviceId(),
    deviceName: this.deviceName(),
    addresses: (this.mode === 'host') ? discovery.localAddresses() : [],
    port: this.mode === 'host' && this.hub ? this.hub.port : null,
    kioskUrls: this.mode === 'host' && this.hub
      ? discovery.localAddresses().map((addr) => addr ? `http://${addr}:${this.hub.port}/kiosk` : null).filter(Boolean)
      : [],
    peers: this._lastPeers,
    client: this._lastClient,
    stats,
    version: this.version,
  };
};

LanManager.prototype.onStatus = function (cb) {
  this._statusCb = cb;
  this._emitStatus();
};

// Switch the whole device: 'off', 'host' {port}, or 'client' {host}.
LanManager.prototype.setMode = async function (mode, opts = {}) {
  const d = this._d();
  if (mode === 'off') {
    await this.stop();
    this.mode = 'off';
    d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('lan_mode', 'off')").run();
    this._emitStatus();
    return { ok: true, mode: 'off' };
  }

  if (mode === 'host') {
    if (this.peer) { this.peer.disconnect(); this.peer = null; }
    if (this.hub) await this.hub.stop();
    const port = Number(opts.port) || Number(process.env.PVH_LAN_PORT) || this._savedPort() || DEFAULT_PORT;
    this.hub = new Hub({
      d,
      deviceId: this.deviceId(),
      deviceName: this.deviceName(),
      version: this.version,
      rendererDir: typeof this.rendererDir === 'function' ? this.rendererDir() : this.rendererDir,
      kioskEnabled: this._kioskEnabled(),
      onStatus: (p) => this._delegateStatus(p),
      // A ballot cast via the browser kiosk must reach LAN peers exactly like
      // one cast on this machine: broadcast + mark synced.
      onWritten: (electionId, voterId, selection, timestamp) => this.onLocalVote(electionId, voterId, selection, timestamp),
    });
    try {
      await this.hub.start(port);
    } catch (err) {
      this.hub = null;
      return { ok: false, error: `Could not start server on port ${port}: ${err.message}` };
    }
    const txt = { device: this.deviceName(), id: this.deviceId().slice(0, 8) };
    try {
      this.hub.advertiser = discovery.advertise({ name: this.deviceName(), port, txt });
    } catch (e) { /* mDNS unavailable; manual connect still works */ }
    this.mode = 'host';
    this._lastPeers = [];
    this._lastClient = null;
    d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('lan_mode', 'host')").run();
    d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('lan_port', ?)").run(String(port));
    this._emitStatus();
    return { ok: true, mode: 'host', port };
  }

  if (mode === 'client') {
    if (this.hub) { await this.hub.stop(); this.hub = null; }
    if (this.peer) this.peer.disconnect();
    const raw = (opts.host || this._savedHost()).trim();
    if (!raw) return { ok: false, error: 'No hub address provided' };
    const host = /^wss?:\/\//.test(raw) ? raw : raw.includes(':') && !/:\/\//.test(raw)
      ? `ws://${raw}`
      : `ws://${raw}`;
    this.peer = new Peer({
      d,
      deviceId: this.deviceId(),
      deviceName: this.deviceName(),
      version: this.version,
      onStatus: (p) => this._delegateStatus(p),
    });
    this.mode = 'client';
    this._lastClient = null;
    d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('lan_mode', 'client')").run();
    d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('lan_host', ?)").run(host);
    this.peer.connect(host);
    this._emitStatus();
    return { ok: true, mode: 'client', host };
  }

  return { ok: false, error: 'Unknown mode' };
};

// Local events already written to this device's DB: route them to the network
// (broadcast from a host, enqueue+push from a client).

LanManager.prototype.onLocalVote = function (electionId, voterId, selection, timestamp) {
  const d = this._d();
  const selections = (selection || []).map((sel) => {
    const lbl = sync.labelSelection(d, electionId, sel.positionId, sel.candidateId);
    return lbl ? { position_title: lbl.position_title, candidate_name: lbl.candidate_name, timestamp } : null;
  }).filter(Boolean);
  if (!selections.length) return;

  if (this.mode === 'host' && this.hub) {
    this.hub.broadcastLocal('vote', selections.map((s) => ({
      election_id: electionId, voter_id: String(voterId || '').trim().toUpperCase(),
      position_title: s.position_title, candidate_name: s.candidate_name,
      device_id: this.deviceId(), station_id: null, timestamp,
    })));
    sync.markVoteSynced(d, electionId, String(voterId || '').trim().toUpperCase());
  } else if (this.mode === 'client' && this.peer) {
    this.peer.enqueueLocal('vote', {
      election_id: electionId,
      voter_id: String(voterId || '').trim().toUpperCase(),
      device_id: this.deviceId(),
      selections,
    });
  }
};

LanManager.prototype.onLocalCheckin = function (voterRow, officerName) {
  if (!voterRow) return;
  const payload = {
    election_id: voterRow.election_id,
    voter_id: String(voterRow.voter_id || '').trim().toUpperCase(),
    officer_name: officerName || 'Officer',
    timestamp: voterRow.checked_in_at || Date.now(),
  };
  if (this.mode === 'host' && this.hub) {
    this.hub.broadcastLocal('checkin', payload);
  } else if (this.mode === 'client' && this.peer) {
    this.peer.enqueueLocal('checkin', payload);
  }
};

LanManager.prototype.onLocalUnvote = function (electionId, voterId) {
  const payload = { election_id: electionId, voter_id: String(voterId || '').trim().toUpperCase() };
  if (this.mode === 'host' && this.hub) {
    this.hub.broadcastLocal('unvote', payload);
  } else if (this.mode === 'client' && this.peer) {
    this.peer.enqueueLocal('unvote', payload);
  }
};

LanManager.prototype.discovers = function (ms) {
  return discovery.scan(ms || 4000);
};

LanManager.prototype.setName = function (name) {
  sync.setDeviceName(this._d(), name);
  this._emitStatus();
  return { ok: true, deviceName: this.deviceName() };
};

LanManager.prototype.stop = async function () {
  if (this.hub) { await this.hub.stop(); this.hub = null; }
  if (this.peer) { this.peer.disconnect(); this.peer = null; }
  this._lastPeers = [];
  this._lastClient = null;
  discovery.stopDiscovery();
};

// Restore the persisted mode at startup (auto-resume on app launch).
LanManager.prototype.resume = async function () {
  const d = this._d();
  const mode = d.prepare("SELECT value FROM config WHERE key = 'lan_mode'").get();
  if (!mode || mode.value === 'off') return;
  if (mode.value === 'host') await this.setMode('host');
  if (mode.value === 'client') await this.setMode('client');
};

LanManager.prototype._savedPort = function () {
  const row = this._d().prepare("SELECT value FROM config WHERE key = 'lan_port'").get();
  return row ? Number(row.value) || null : null;
};

LanManager.prototype._kioskEnabled = function () {
  try {
    const row = this._d().prepare("SELECT value FROM config WHERE key = 'lan_kiosk'").get();
    return !row || row.value !== '0';
  } catch (e) { return true; }
};

LanManager.prototype._savedHost = function () {
  const row = this._d().prepare("SELECT value FROM config WHERE key = 'lan_host'").get();
  return row ? row.value : null;
};

module.exports = { LanManager };