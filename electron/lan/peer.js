// LAN client (peer device): connects to a hub, keeps a persistent WebSocket,
// auto-reconnects with backoff, relays local events, and applies the hub's
// authoritative snapshots/broadcasts to the local database.
const crypto = require('crypto');
const sync = require('./sync');

const BACKOFF_BASE = 1200;
const BACKOFF_MAX = 10000;

function Peer({ d, secret, deviceId, deviceName, version, onStatus }) {
  this.d = d;
  this.secret = secret || null;
  this.deviceId = deviceId;
  this.deviceName = deviceName;
  this.version = version;
  this.onStatus = onStatus || (() => {});
  this.url = null;
  this.ws = null;
  this.state = 'idle'; // idle | connecting | connected | offline
  this.hub = null;     // { serverId, serverName, host, port }
  this.lastError = null;
  this.lastSyncAt = null;
  this.reconnectDelay = BACKOFF_BASE;
  this.reconnectTimer = null;
  this.reconnectAttempts = 0;
  this._stopped = false;
  this._syncRequested = false;
}

Peer.prototype.connect = function (url) {
  const self = this;
  this._stopped = false;
  this.url = url;
  this._open();
};

Peer.prototype._open = function () {
  const self = this;
  if (this._stopped || !this.url) return;
  this._setState('connecting');
  let ws;
  try {
    const WebSocket = require('ws');
    ws = new WebSocket(this.url, { handshakeTimeout: 6000 });
  } catch (err) {
    this.lastError = err.message;
    this._scheduleReconnect();
    return;
  }
  this.ws = ws;

  ws.on('open', () => {
    self.reconnectAttempts = 0;
    self.reconnectDelay = BACKOFF_BASE;
    const hello = { t: 'hello', device_id: self.deviceId, device_name: self.deviceName, app_version: self.version };
    if (self.secret) hello.secret = self.secret;
    self._send(hello);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    self._onMessage(msg);
  });

  ws.on('close', () => {
    self.ws = null;
    if (self._stopped) { self._setState('idle'); return; }
    self._setState('offline');
    self._scheduleReconnect();
  });

  ws.on('error', (err) => {
    self.lastError = (err && err.message) || 'connection error';
  });
};

Peer.prototype._scheduleReconnect = function () {
  const self = this;
  if (this._stopped || this.reconnectTimer) return;
  this.reconnectTimer = setTimeout(() => {
    self.reconnectTimer = null;
    if (!self._stopped) self._open();
  }, this.reconnectDelay);
  this.reconnectDelay = Math.min(BACKOFF_MAX, this.reconnectDelay * 2);
};

Peer.prototype._onMessage = function (msg) {
  const self = this;
  switch (msg.t) {
    case 'welcome':
      this.hub = {
        serverId: msg.server_id, serverName: msg.server_name,
        serverVersion: msg.server_version,
        host: this._hostOf(this.url), port: msg.port,
      };
      this._setState('connected');
      // Flush the offline queue first, then reconcile to the authoritative
      // snapshot so accepted rows are never wiped by sync.
      this.flushPending(() => {
        self._send({ t: 'sync' });
      });
      break;

    case 'snapshot':
      try {
        sync.applySnapshot(this.d, msg);
        this.lastSyncAt = Date.now();
        this._bumpStatus();
      } catch (err) {
        this.lastError = err.message;
        this._bumpStatus();
      }
      break;

    case 'voter_state':
      try {
        sync.applyVoterState(this.d, msg.state);
        this._dequeueFor(msg.type, msg.ref);
        this._bumpStatus();
      } catch (err) {
        this.lastError = err.message;
      }
      break;

    case 'accepted':
      this._onAccepted(msg);
      break;

    case 'conflict':
      this._onConflict(msg);
      break;

    case 'broadcast':
      this._onBroadcast(msg);
      break;

    case 'pong':
      break;

    default:
      break;
  }
};

Peer.prototype._onAccepted = function (msg) {
  const ref = msg.ref || {};
  if (msg.type === 'vote' && ref.election_id && ref.voter_id) {
    sync.markVoteSynced(this.d, ref.election_id, ref.voter_id);
  }
  this._dequeueFor(msg.type, ref);
  this._bumpStatus();
};

Peer.prototype._onConflict = function (msg) {
  const ref = msg.ref || {};
  this._dequeueFor(msg.type, ref);
  if (ref.election_id && ref.voter_id) {
    this._send({ t: 'get_voter', election_id: ref.election_id, voter_id: ref.voter_id });
  }
  this._bumpStatus();
};

Peer.prototype._onBroadcast = function (msg) {
  const d = this.d;
  try {
    if (msg.type === 'vote') {
      const rows = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
      for (const row of rows) if (row) sync.applyRemoteVote(d, row);
    } else if (msg.type === 'checkin') {
      if (msg.payload) sync.applyRemoteCheckin(d, msg.payload);
    } else if (msg.type === 'unvote') {
      if (msg.payload) sync.applyRemoteUnvote(d, msg.payload);
    } else if (msg.type === 'message') {
      if (msg.payload) sync.recordRemoteMessage(d, msg.payload);
    }
  } catch (err) {
    this.lastError = err.message;
  }
  this._bumpStatus();
};

// Local events: recorded in the lan_queue so they survive a disconnect, then
// sent immediately when a connection exists.
Peer.prototype.enqueueLocal = function (type, payload) {
  sync.enqueue(this.d, type, payload);
  if (this.state === 'connected' && this.ws && this.ws.readyState === 1) {
    this._send({ t: type, ...payload });
  }
  this._bumpStatus();
};

// Send every queued local event to the hub. `done` runs once all items have
// been dispatched (accept layers handle their own bookkeeping).
Peer.prototype.flushPending = function (done) {
  let items;
  try { items = sync.listQueue(this.d); } catch (e) { items = []; }
  for (const raw of items) {
    // listQueue spreads the stored payload onto the item, keeping the row id
    // as _rowId. Domain events that carry their own `id` (messages) must keep
    // it in the frame; strip only the row bookkeeping.
    const { _rowId: _row, type, ...fields } = Object.assign({}, raw);
    this._send({ t: type, ...fields });
  }
  if (typeof done === 'function') done();
};

Peer.prototype._dequeueFor = function (type, ref) {
  const d = this.d;
  let items = [];
  try { items = sync.listQueue(d); } catch (e) { items = []; }
  for (const item of items) {
    if (item.type !== type) continue;
    const i = JSON.parse(JSON.stringify(item));
    if (ref && ref.election_id && ref.voter_id) {
      if (i.election_id === ref.election_id && i.voter_id === ref.voter_id) sync.dequeue(d, item.id);
    } else if (ref && ref.id) {
      if (String(i.id) === String(ref.id)) sync.dequeue(d, i._rowId != null ? i._rowId : i.id);
    } else if (!i.election_id && !i.voter_id && !i.id) {
      // No hub ref to match against: only drop events that are themselves
      // unaddressable rather than the entire queue of that type.
      sync.dequeue(d, i._rowId != null ? i._rowId : i.id);
    }
  }
};

Peer.prototype._send = function (obj) {
  if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
};

Peer.prototype._hostOf = function (url) {
  try { return new URL(url).hostname; } catch (e) { return null; }
};

Peer.prototype._setState = function (s) {
  this.state = s;
  this._bumpStatus();
};

Peer.prototype._bumpStatus = function () {
  const d = this.d;
  let queue = 0, unsynced = 0;
  try { queue = sync.queueSize(d); unsynced = sync.unsyncedVoteCount(d); } catch (e) { /* noop */ }
  this.onStatus({
    type: 'state',
    state: this.state,
    hub: this.hub,
    queue,
    unsynced,
    lastSyncAt: this.lastSyncAt,
    lastError: this.lastError,
  });
};

Peer.prototype.disconnect = function () {
  this._stopped = true;
  if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  if (this.ws) { try { this.ws.close(); } catch (e) { /* noop */ } this.ws = null; }
  this.state = 'idle';
  this._bumpStatus();
};

module.exports = { Peer };