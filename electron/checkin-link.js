// Secure browser check-in links for station officers.
//
// The coordinator generates a per-station "magic link" carrying a random token,
// plus a separate 6-digit one-time PIN. Token and PIN are only ever stored as
// SHA-256 hashes. Links are valid until the station polls are over and can be
// revoked instantly by the coordinator. This means a leaked link alone is
// useless: the PIN is shared separately (verbally / in person).
const crypto = require('crypto');
const db = require('./db');

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

// Timing-safe compare to avoid leaking the PIN via string comparison timing.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// "Until polls close" deadline: the election end, extended by any active grace
// period, and floored so a bogus/unset election end still expires eventually.
function computeExpiry(d, electionId, stationId) {
  const e = d.prepare('SELECT * FROM elections WHERE id = ?').get(electionId);
  const s = d.prepare('SELECT * FROM stations WHERE id = ? AND election_id = ?').get(stationId, electionId);
  let exp = 0;
  if (e && e.end_date) exp = Math.max(exp, Number(e.end_date));
  if (s && s.grace_ends_at) exp = Math.max(exp, Number(s.grace_ends_at));
  if (!exp || exp <= Date.now()) exp = Date.now() + 12 * 3600 * 1000;
  return exp;
}

function createCheckinLink({ electionId, stationId, actor }) {
  const d = db.get();
  const s = d.prepare('SELECT * FROM stations WHERE id = ? AND election_id = ?').get(stationId, electionId);
  if (!s) return { ok: false, error: 'Station not found for this election' };
  const off = d.prepare('SELECT name FROM officers WHERE assigned_election_id = ? AND assigned_station_id = ? LIMIT 1').get(electionId, stationId);
  const officerName = (off && off.name) || (actor && actor.name) || 'Officer';
  const token = crypto.randomBytes(32).toString('hex');
  const pin = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresAt = computeExpiry(d, electionId, stationId);
  d.prepare(
    `INSERT INTO station_tokens (id, token_hash, pin_hash, election_id, station_id, officer_name, created_at, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, sha256(token), sha256(pin), electionId, stationId, officerName, createdAt, actor && actor.id, expiresAt);
  return { ok: true, id, token, pin, officerName, expiresAt, createdAt, urlToken: token };
}

function listCheckinLinks(electionId) {
  const d = db.get();
  const rows = d.prepare(
    `SELECT t.id, t.election_id, t.station_id, t.officer_name, t.created_at, t.expires_at, t.revoked_at,
            s.name AS station_name, s.code AS station_code
     FROM station_tokens t LEFT JOIN stations s ON s.id = t.station_id
     WHERE t.election_id = ? AND t.revoked_at IS NULL
     ORDER BY t.created_at DESC`
  ).all(electionId);
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    station_id: r.station_id,
    station_name: r.station_name,
    station_code: r.station_code,
    officer_name: r.officer_name,
    created_at: r.created_at,
    expires_at: r.expires_at,
    valid: r.expires_at > now,
    expires_atField: r.expires_at,
  }));
}

function revokeCheckinLink(electionId, tokenId) {
  const d = db.get();
  const rec = d.prepare('SELECT id FROM station_tokens WHERE id = ? AND election_id = ?').get(tokenId, electionId);
  if (!rec) return { ok: false, error: 'Check-in link not found' };
  d.prepare('UPDATE station_tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), tokenId);
  return { ok: true };
}

// Resolve a raw link token to its stored record (rejecting revoked/expired).
function getCheckinToken(rawToken) {
  const d = db.get();
  const rec = d.prepare('SELECT * FROM station_tokens WHERE token_hash = ?').get(sha256(String(rawToken || '')));
  if (!rec) return { ok: false, error: 'This check-in link is not valid.', code: 'bad-link' };
  if (rec.revoked_at) return { ok: false, error: 'This check-in link has been revoked.', code: 'revoked' };
  if (Date.now() > Number(rec.expires_at)) return { ok: false, error: 'This check-in link has expired.', code: 'expired' };
  return { ok: true, rec };
}

function verifyPin(rec, pin) {
  return safeEqual(sha256(String(pin || '')), rec.pin_hash);
}

module.exports = { createCheckinLink, listCheckinLinks, revokeCheckinLink, getCheckinToken, verifyPin, sha256, safeEqual };