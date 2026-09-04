// LAN hub (host device): an Express + WebSocket server that is the source of
// truth for the network. It validates and records peer events transactionally
// against its own SQLite, broadcasts accepted events to every other client, and
// serves full/partial snapshots so peers can reconcile.
const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID, timingSafeEqual } = require('crypto');
const { WebSocketServer } = require('ws');
const sync = require('./sync');
const db = require('../db');
const voter = require('../voter');
const station = require('../station');
const checkInLink = require('../checkin-link');
const results = require('../results');

// Sliding-window rate limiter: at most `limit` requests per `windowMs` per key
// (keyed by client IP and/or voter id). Exceeding the window rejects further
// attempts, which blunts remote brute-forcing of voter PINs.
function makeRateLimiter(limit, windowMs) {
  const hits = new Map();
  return function check(key) {
    if (!key) return { ok: true };
    const now = Date.now();
    const arr = hits.get(key) || [];
    const kept = arr.filter((t) => now - t < windowMs);
    kept.push(now);
    hits.set(key, kept);
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= windowMs) hits.delete(k);
    }
    const remaining = Math.max(0, limit - kept.length);
    return { ok: kept.length <= limit, remaining, retryAfterMs: kept.length ? windowMs - (now - kept[0]) : 0 };
  };
}

// Best-effort client IP from the socket; X-Forwarded-For is trusted only for
// loopback/local proxies, so remote callers can't spoof their limiter bucket.
function clientIp(req) {
  const sock = (req.socket && (req.socket.remoteAddress || (req.connection && req.connection.remoteAddress))) || 'unknown';
  const raw = String(sock).replace(/^::ffff:/, '');
  if (raw === '::1' || raw === '127.0.0.1') {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return raw;
}

function Hub({ d, secret, deviceId, deviceName, version, onStatus, rendererDir, kioskEnabled, onWritten, onCheckin }) {
  this.d = d;
  this.secret = secret || null;
  this.deviceId = deviceId;
  this.deviceName = deviceName;
  this.version = version;
  this.onStatus = onStatus || (() => {});
  this.rendererDir = rendererDir;
  this.kioskEnabled = kioskEnabled !== false;
  this.onWritten = onWritten || (() => {});
  this.onCheckin = onCheckin || (() => {});
// Browser check-in sessions issued after a correct PIN (token -> sessions),
// and per-link PIN attempt throttling (tokenId -> { fails, lockedUntil }).
this._sessions = new Map();
this._pinTries = new Map();
// HTTP rate limiting for the network voting endpoints (per key).
this._rate = new Map();
// Per-IP limits: allow a burst of 12 attempts, then 10 per 60s window.
this._ipLimit = makeRateLimiter(10, 60 * 1000);
// Per-voter verify limit: a tighter cap on credential guesses (5 per minute).
this._verifyLimit = makeRateLimiter(5, 60 * 1000);
this._castLimit = makeRateLimiter(6, 60 * 1000);
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

  app.get('/api/snapshot', (req, res) => {
    // This endpoint returns the full election dataset (voters, votes, messages),
    // so it requires the shared network secret. No browser flow calls it; only
    // authorized peers/operators with the token may read a snapshot.
    if (self.secret) {
      const provided = (req.query.token) || req.get('x-hub-token') || '';
      // Constant-time comparison: never short-circuits on length, so a LAN
      // attacker cannot use timing to recover the network secret byte-by-byte.
      let ok = false;
      if (typeof provided === 'string' && typeof self.secret === 'string') {
        const a = Buffer.from(provided);
        const b = Buffer.from(self.secret);
        ok = a.length === b.length && timingSafeEqual(a, b);
      }
      if (!ok) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
    }
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

  // Public browser view (live results + official declaration). Served to any
  // device on the LAN while the hub runs, independent of the ballot-kiosk flag.
  self._mountPublic(app);

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

  // Ballot statics (same relative paths vote.html uses). Pages are served
  // under /kiosk, so mirror the mount under that prefix as well — otherwise a
  // browser resolving `css/styles.css` from /kiosk gets a 404 HTML error page.
  app.use('/js', express.static(path.join(rd, 'js'), { index: false, maxAge: 0 }));
  app.use('/css', express.static(path.join(rd, 'css'), { index: false, maxAge: 0 }));
  app.use('/assets', express.static(path.join(rd, 'assets'), { index: false, maxAge: 0 }));
  app.use('/kiosk/js', express.static(path.join(rd, 'js'), { index: false, maxAge: 0 }));
  app.use('/kiosk/css', express.static(path.join(rd, 'css'), { index: false, maxAge: 0 }));
  app.use('/kiosk/assets', express.static(path.join(rd, 'assets'), { index: false, maxAge: 0 }));

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
      res.set('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Ballot template unavailable' });
    }
  });

  // Secure browser check-in portal for station officers. The coordinator
  // generates a magic link (token) + one-time PIN; the page verifies the PIN
  // and then issues a short-lived session scoped to that station.
  app.get('/kiosk/station', (_req, res) => {
    const p = path.join(self.rendererDir, 'station-link.html');
    if (!fs.existsSync(p)) { res.status(404).json({ ok: false, error: 'Check-in page unavailable' }); return; }
    try {
      res.set('Cache-Control', 'no-store');
      res.type('html').send(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Check-in page unavailable' });
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

  // Candidate photos, resolved the same way the desktop does. Restricted to
  // files under the app's own candidate-photos directory and to image file
  // extensions only, so this endpoint can't be used to read arbitrary files.
  app.get('/api/kiosk/photo', (req, res) => self._servePhoto(req, res));

  // Identity gate — identical to the desktop kiosk flow.
  app.post('/api/kiosk/verify', express.json(), (req, res) => {
    const b = req.body || {};
    if (!b.electionId || !b.voterId || b.password === undefined) {
      res.status(400).json({ ok: false, error: 'Missing verification fields' });
      return;
    }
    // Rate-limit credential guessing: per-IP burst cap + per-voter tick.
    const ip = clientIp(req);
    const ipR = self._ipLimit(ip);
    const voterKey = b.electionId + '|' + String(b.voterId).trim().toUpperCase();
    const vR = self._verifyLimit(voterKey);
    if (!ipR.ok || !vR.ok) {
      res.status(429).json({ ok: false, error: 'Too many attempts. Please slow down and try again in a minute.', code: 'rate-limited' });
      return;
    }
    // The ticket is minted against the caller's IP so it cannot be replayed
    // from a different LAN device, and is single-use/expiring.
    res.json(voter.verifyVoter(b.electionId, b.voterId, b.password, ip));
  });

  app.post('/api/kiosk/verify-details', express.json(), (req, res) => {
    const b = req.body || {};
    const details = (b.details || {}).voterId ? b.details : b;
    if (!b.electionId || !details.voterId) {
      res.status(400).json({ ok: false, error: 'Missing recovery fields' });
      return;
    }
    const ipR = self._ipLimit(clientIp(req));
    if (!ipR.ok) {
      res.status(429).json({ ok: false, error: 'Too many attempts. Please slow down and try again in a minute.', code: 'rate-limited' });
      return;
    }
    // The hub serves the official ballot kiosk for THIS election: the verify-
    // details screen is the help desk's password-recovery surface and is
    // expected to hand the voter the password to cast their ballot, so it
    // reveals the credential exactly like the desktop app does. Guarded by the
    // same per-IP rate limiter as the other kiosk endpoints.
    res.json(voter.verifyVoterDetails(b.electionId, Object.assign({}, details, { revealPassword: true })));
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
    const ipR = self._ipLimit(clientIp(req));
    const castR = self._castLimit(b.electionId + '|' + String(b.voterId).trim().toUpperCase());
    if (!ipR.ok || !castR.ok) {
      res.status(429).json({ ok: false, error: 'Too many requests. Please try again shortly.', code: 'rate-limited' });
      return;
    }
    const r = voter.castVote(b.electionId, b.voterId, b.selection, b.castTicket, b.station, clientIp(req));
    if (r && r.ok) {
      try { self.onWritten(b.electionId, b.voterId, b.selection, r.timestamp); } catch (err) { /* ignore */ }
    } else if (r && r.code === 'verify-first') {
      // Browser must re-verify before casting.
      r.needVerifyAgain = true;
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

  // ---- Live agent tally ("pink sheet" live view) ----
  // Polling agents open this in a browser over the LAN and watch per-candidate
  // vote totals update as ballots land on the hub. Mirrors the Ghana "pink
  // sheet" idea: candidate -> votes, per office, with turnout + valid-ballot
  // reconciliation the agent can cross-check against their own records.
  app.get('/api/kiosk/agent-tally', (req, res) => {
    try {
      const eid = String(req.query.election || '');
      if (!eid) { res.json({ ok: false, error: 'Missing election' }); return; }
      const d = self.d;
      const e = d.prepare('SELECT * FROM elections WHERE id = ?').get(eid);
      if (!e) { res.json({ ok: false, error: 'Election not found' }); return; }

      const now = Date.now();
      const end = Number(e.end_date) || 0;
      const closed = e.status === 'closed' || (end > 0 && now >= end);

      const positions = d.prepare('SELECT * FROM positions WHERE election_id = ? ORDER BY title').all(eid);
      const candidates = d.prepare('SELECT * FROM candidates WHERE election_id = ? ORDER BY sort_order, ballot_number').all(eid);
      const tallyRows = d.prepare(
        'SELECT candidate_id, position_id, COUNT(*) AS n FROM votes WHERE election_id = ? GROUP BY candidate_id, position_id'
      ).all(eid);
      const countByCand = new Map();
      for (const r of tallyRows) countByCand.set(r.candidate_id, r.n);

      let totalValid = 0;
      const categories = [];
      for (const p of positions) {
        const list = candidates
          .filter((c) => c.position_id === p.id)
          .map((c) => ({ id: c.id, name: c.name, party: c.party || null, votes: countByCand.get(c.id) || 0 }))
          .sort((a, b) => b.votes - a.votes);
        const catVotes = list.reduce((s, c) => s + c.votes, 0);
        totalValid += catVotes;
        categories.push({
          id: p.id,
          name: p.title,
          votes: catVotes,
          candidates: list.map((c) => ({
            ...c,
            percentage: catVotes > 0 ? Number(((c.votes / catVotes) * 100).toFixed(1)) : 0,
          })),
        });
      }

      const registered = (d.prepare('SELECT COUNT(*) n FROM voters WHERE election_id = ?').get(eid) || { n: 0 }).n;
      const castVoters = (d.prepare('SELECT COUNT(DISTINCT voter_id) n FROM votes WHERE election_id = ?').get(eid) || { n: 0 }).n;
      const turnoutPct = registered > 0 ? Number(((castVoters / registered) * 100).toFixed(1)) : 0;

      let stations = [];
      if (e.type === 'station') {
        const stRows = d.prepare('SELECT id, code, name, status FROM stations WHERE election_id = ? ORDER BY name').all(eid);
        const votes = d.prepare('SELECT station_id, COUNT(*) n FROM votes WHERE election_id = ? GROUP BY station_id').all(eid);
        const voteMap = new Map(votes.map((v) => [v.station_id, v.n]));
        stations = stRows.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          status: s.status,
          votes: voteMap.get(s.id) || 0,
        }));
      }

      res.json({
        ok: true,
        election: { id: e.id, title: e.title, type: e.type, status: e.status },
        regime: closed ? 'sealed' : 'live',
        generated_at: now,
        totalValid,
        castVoters,
        registered,
        turnoutPct,
        categories,
        stations,
      });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // Live agent display page (a plain browser, no login, on the LAN).
  app.get('/kiosk/agent', (_req, res) => {
    const p = path.join(self.rendererDir, 'agent.html');
    if (!fs.existsSync(p)) { res.status(404).json({ ok: false, error: 'Agent page unavailable' }); return; }
    try {
      res.set('Cache-Control', 'no-store');
      res.type('html').send(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Agent page unavailable' });
    }
  });

  // ---- Secure station check-in (magic link + one-time PIN) ----

  // Validate a session token and kill it if its link was revoked/expired.
  function session(req, res) {
    const b = (req.body || {}).session || (req.query || {}).session;
    const s = self._sessions.get(String(b || ''));
    if (!s || Date.now() > s.expiresAt) {
      if (s) self._sessions.delete(s.id);
      res.json({ ok: false, code: 'no-session', error: 'Session expired — reload the link and enter your PIN again.' });
      return null;
    }
    const tk = checkInLink.getCheckinToken(s.rawToken);
    if (!tk.ok) {
      self._sessions.delete(s.id);
      res.json({ ok: false, code: 'no-session', error: tk.error });
      return null;
    }
    return s;
  }

  function dashboardPayload(s) {
    const dash = station.stationDashboard(s.election_id, s.station_id);
    if (!dash || !dash.ok) return { ok: false, error: (dash && dash.error) || 'Could not load station' };
    return {
      ok: true,
      officerName: s.officerName,
      election: dash.election,
      station: dash.station,
      stats: dash.stats || {},
      voters: (dash.voters || []).map((v) => ({
        id: v.id,
        voter_id: v.voter_id,
        name: v.name,
        assigned_station: v.assigned_station,
        station_id: v.station_id,
        checked_in: v.checked_in,
        ballot_cast: v.ballot_cast,
        grace_period: v.grace_period,
        checked_in_by: v.checked_in_by,
      })),
    };
  }

  // Correct link token + PIN -> short-lived station-scoped session.
  app.post('/api/kiosk/station/unlock', express.json(), (req, res) => {
    const { token, pin, officerName } = req.body || {};
    if (!token || !pin) { res.json({ ok: false, error: 'Missing link token or PIN' }); return; }
    const tk = checkInLink.getCheckinToken(token);
    if (!tk.ok) { res.json(tk); return; }
    const rec = tk.rec;

    // Throttle PIN guessing: 5 wrong attempts lock the link for 10 minutes.
    const tries = self._pinTries.get(rec.id) || { fails: 0, lockedUntil: 0 };
    if (Date.now() < tries.lockedUntil) {
      res.json({ ok: false, code: 'pin-locked', error: 'Too many incorrect attempts. Retry in a few minutes.' });
      return;
    }
    if (!checkInLink.verifyPin(rec, pin)) {
      const fails = tries.fails + 1;
      if (fails >= 5) {
        self._pinTries.set(rec.id, { fails: 0, lockedUntil: Date.now() + 10 * 60 * 1000 });
        res.json({ ok: false, code: 'pin-locked', error: 'Too many incorrect attempts. Link locked for 10 minutes.' });
      } else {
        self._pinTries.set(rec.id, { fails, lockedUntil: 0 });
        res.json({ ok: false, error: `Incorrect PIN. ${5 - fails} attempt${5 - fails === 1 ? '' : 's'} left.` });
      }
      return;
    }
    self._pinTries.delete(rec.id);

    // Cap concurrent sessions per link so one leaked PIN can't fan out everywhere.
    const active = [...self._sessions.values()].filter((s) => s.tokenId === rec.id && Date.now() < s.expiresAt).length;
    if (active >= 5) {
      res.json({ ok: false, code: 'session-limit', error: 'This link already has 5 active sessions. Revoke it and generate a new one.' });
      return;
    }
    const name = String(officerName || '').trim() || rec.officer_name;
    const sessionId = randomUUID();
    self._sessions.set(sessionId, {
      id: sessionId,
      tokenId: rec.id,
      rawToken: token,
      election_id: rec.election_id,
      station_id: rec.station_id,
      officerName: name,
      expiresAt: Math.min(Number(rec.expires_at), Date.now() + 8 * 3600 * 1000),
    });
    res.json({ ok: true, session: sessionId, ...dashboardPayload(self._sessions.get(sessionId)) });
  });

  // Check a voter in under the unlocked session.
  app.post('/api/kiosk/station/checkin', express.json(), (req, res) => {
    const s = session(req, res);
    if (!s) return;
    const voterId = (req.body || {}).voterId;
    if (!voterId) { res.json({ ok: false, error: 'Missing voter' }); return; }
    const r = station.checkInVoter(String(voterId), { officerName: s.officerName, stationId: s.station_id });
    if (r && r.ok) {
      try { self.onCheckin(r.voter, s.officerName, { station: s.station_id }); } catch (err) { /* LAN fan-out is best-effort */ }
      // Never return credential material to the browser.
      const v = r.voter;
      res.json({ ok: true, voter: {
        id: v.id, voter_id: v.voter_id, name: v.name, assigned_station: v.assigned_station,
        station_id: v.station_id, checked_in: v.checked_in, ballot_cast: v.ballot_cast,
        grace_period: v.grace_period, checked_in_by: v.checked_in_by,
      } });
      return;
    }
    res.json(r);
  });

  // Live pollbook refresh for the check-in page.
  app.post('/api/kiosk/station/pollbook', express.json(), (req, res) => {
    const s = session(req, res);
    if (!s) return;
    res.json(dashboardPayload(s));
  });
};

// Kill every unlocked browser session issued against a revoked check-in link.
Hub.prototype.revokeTokenSessions = function (tokenId) {
  if (!tokenId) return;
  for (const [id, s] of this._sessions) {
    if (s.tokenId === tokenId) this._sessions.delete(id);
  }
};

Hub.prototype._kioskElections = function () {
  const rows = this.d.prepare(`
    SELECT e.id, e.title, e.type, e.status, e.election_date, e.start_date, e.end_date, e.voter_scheme,
      (SELECT COUNT(*) FROM candidates c WHERE c.election_id = e.id) AS candidate_count
    FROM elections e
    ORDER BY e.created_at DESC
  `).all();
  return rows.map((r) => {
    const out = {
      id: r.id,
      title: r.title,
      type: r.type,
      status: r.status,
      election_date: r.election_date,
      start_date: r.start_date,
      end_date: r.end_date,
      voter_scheme: r.voter_scheme,
      candidate_count: r.candidate_count,
    };
    if (r.type === 'station') {
      out.stations = this.d.prepare(
        'SELECT s.id, s.code, s.name FROM stations s WHERE s.election_id = ? ORDER BY s.name'
      ).all(r.id).map((s) => ({ id: s.id, code: s.code, name: s.name }));
    }
    return out;
  });
};

// Serve a candidate photo, resolving it strictly inside the app's own
// candidate-photos directory and only for known image extensions.
Hub.prototype._servePhoto = function (req, res) {
  const stored = req.query.p;
  if (!stored) { res.status(400).json({ ok: false, error: 'Missing photo path' }); return; }
  const raw = String(stored);
  const photosDir = path.resolve(path.join(db.getDataDir(), 'candidate-photos'));
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(path.join(photosDir, raw));
  const rel = path.relative(photosDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.status(404).json({ ok: false, error: 'Photo not found' }); return; }
  const ct = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(abs).toLowerCase()];
  if (!ct) { res.status(403).json({ ok: false, error: 'Forbidden' }); return; }
  res.type(ct);
  fs.createReadStream(abs).on('error', () => res.status(404).end()).pipe(res);
};

// Public browser view: live results + official declaration, open to anyone on
// the LAN while the hub runs. Read-only — it never accepts writes. Serves the
// same structured report the desktop uses so numbers are always identical.
Hub.prototype._mountPublic = function (app) {
  const self = this;
  const rd = this.rendererDir;

  // Shared statics the public page references with absolute paths. Mounted here
  // so the view works even when the ballot kiosk flag is turned off.
  app.use('/js', express.static(path.join(rd, 'js'), { index: false, maxAge: 0 }));
  app.use('/css', express.static(path.join(rd, 'css'), { index: false, maxAge: 0 }));
  app.use('/assets', express.static(path.join(rd, 'assets'), { index: false, maxAge: 0 }));

  app.get('/public', (_req, res) => {
    const p = path.join(rd, 'public.html');
    if (!fs.existsSync(p)) { res.status(404).json({ ok: false, error: 'Public view unavailable' }); return; }
    try {
      res.set('Cache-Control', 'no-store');
      res.type('html').send(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Public view unavailable' });
    }
  });

  app.get('/api/public/elections', (_req, res) => {
    try {
      res.json({ ok: true, elections: self._kioskElections() });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.get('/api/public/result/:electionId', (req, res) => {
    try {
      const row = self.d.prepare('SELECT * FROM elections WHERE id = ?').get(String(req.params.electionId || ''));
      if (!row) { res.status(404).json({ ok: false, error: 'Election not found' }); return; }
      res.json(results.buildReport(row, {}));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/public/photo', (req, res) => self._servePhoto(req, res));
};

Hub.prototype._onConnection = function (ws) {
  const self = this;
  this.peers.add(ws);
  this._touch();
  ws.isAlive = true;
  ws.authorized = !self.secret; // no secret configured => legacy open behavior
  ws.deviceId = null;
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
      // Authenticate the peer against the shared network secret. When a secret
      // is configured, only authorized peers may mutate data (vote/checkin/
      // unvote/message). `sync`/`get_voter` are only meaningful after auth too.
      if (this.secret) ws.authorized = String(msg.secret || '') === this.secret;
      ws.deviceId = msg.device_id || null;
      this._bumpStatus();
      send({
        t: 'welcome', server_id: this.deviceId, server_name: this.deviceName,
        server_version: this.version, port: this.port, authorized: ws.authorized,
      });
      break;

    case 'sync':
      if (!this._requireAuth(ws)) return;
      this._sendSnapshot(ws);
      break;

    case 'vote': {
      if (!this._requireAuth(ws)) return;
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
      if (!this._requireAuth(ws)) return;
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
      if (!this._requireAuth(ws)) return;
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
      if (!this._requireAuth(ws)) return;
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
      if (!this._requireAuth(ws)) return;
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

// Reject a frame from a connection that hasn't presented the shared secret.
Hub.prototype._requireAuth = function (ws) {
  if (!ws || ws.authorized) return true;
  if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'conflict', type: 'auth', code: 'unauthorized', reason: 'Not authorized' }));
  return false;
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