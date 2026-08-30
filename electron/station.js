const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const electionMod = require('./election');

const STATION_STATUSES = ['not_opened', 'open', 'queuing', 'counted', 'submitted'];

// Effective status: a queuing station whose grace window has elapsed is counted.
// Mirrors effectiveStatus() in the web station page.
function effectiveStatus(station, now = Date.now()) {
  if (!station) return 'not_opened';
  if (station.status === 'queuing' && station.grace_ends_at && Number(station.grace_ends_at) <= now) return 'counted';
  return station.status || 'not_opened';
}
function isOpen(status) { return status === 'open' || status === 'queuing'; }

function getStation(id) {
  return db.get().prepare('SELECT * FROM stations WHERE id = ?').get(id) || null;
}
function getStationsForElection(electionId) {
  return db.get().prepare('SELECT * FROM stations WHERE election_id = ? ORDER BY created_at').all(electionId);
}

// Resolve a station reference (its id, code or name) within an election.
// Used to bind a ballot/check-in to the physical station it was opened on.
function resolveStationRef(electionId, ref) {
  if (!ref) return null;
  const label = String(ref).trim().toLowerCase();
  const rows = db.get().prepare('SELECT * FROM stations WHERE election_id = ?').all(electionId);
  return rows.find((s) =>
    label && [s.id, s.code, s.name].filter(Boolean).some((k) => String(k).toLowerCase() === label)
  ) || null;
}

// ---- Stations CRUD ----

function addStation({ electionId, name, location, code }) {
  const e = electionMod.getElection(electionId);
  if (!e) return { ok: false, error: 'Election not found' };
  if (e.type !== 'station') return { ok: false, error: 'This election does not use polling stations' };
  if (electionMod.isLocked(e.status)) return electionMod.lockedError();
  if (!name || !String(name).trim()) return { ok: false, error: 'Station name is required' };

  const requestedId = (code && String(code).trim()) ? String(code).trim() : null;
  let id = requestedId || uuidv4();
  if (requestedId && getStation(id)) id = uuidv4(); // code collision -> unique id
  const now = Date.now();
  db.get().prepare(`
    INSERT INTO stations (id, election_id, name, location, code, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'not_opened', ?)
  `).run(id, electionId, String(name).trim(), location || null, (code && String(code).trim()) || id, now);

  electionMod_audit(`Added station "${name}" to election "${electionId}"`, null);
  return { ok: true, station: getStation(id) };
}

function updateStation(id, { name, location, code }) {
  const s = getStation(id);
  if (!s) return { ok: false, error: 'Station not found' };
  if (name !== undefined && !String(name).trim()) return { ok: false, error: 'Station name is required' };
  if (s.status === 'submitted') return { ok: false, error: 'This station has already submitted its results and is locked.' };
  db.get().prepare('UPDATE stations SET name = ?, location = ?, code = ? WHERE id = ?')
    .run(name !== undefined ? String(name).trim() : s.name, location !== undefined ? location : s.location, code !== undefined ? String(code).trim() : s.code, id);
  electionMod_audit(`Updated station "${id}"`, null);
  return { ok: true, station: getStation(id) };
}

function removeStation(id) {
  const s = getStation(id);
  if (!s) return { ok: false, error: 'Station not found' };
  const d = db.get();
  d.transaction(() => {
    d.prepare('UPDATE voters SET station_id = NULL WHERE station_id = ?').run(id);
    d.prepare('DELETE FROM stations WHERE id = ?').run(id);
  })();
  electionMod_audit(`Removed station "${id}"`, null);
  return { ok: true };
}

// ---- Station lifecycle ----

// Opens polls at a station with a zero report. Mirrors web openPolls().
function openPolls(stationId, { officerName = 'Officer' } = {}) {
  const s = getStation(stationId);
  if (!s) return { ok: false, error: 'Station not found' };
  if (s.status !== 'not_opened') return { ok: false, error: 'Polls at this station are already open.' };
  const now = Date.now();
  db.get().prepare(`
    UPDATE stations SET status = 'open', opened_at = ?, zero_report = 1, opened_by_name = ? WHERE id = ?
  `).run(now, officerName, stationId);
  electionMod_audit(`Opened polls at station "${stationId}" (zero report) by ${officerName}`, null);
  return { ok: true, station: getStation(stationId) };
}

// Closes the queue. graceMinutes: 0 -> counted immediately; >0 -> queuing with
// grace_ends_at = now + grace. Mirrors web closePolls().
function closePolls(stationId, { graceMinutes = 0, officerName = 'Officer' } = {}) {
  const s = getStation(stationId);
  if (!s) return { ok: false, error: 'Station not found' };
  if (s.status !== 'open') return { ok: false, error: 'Polls can only be closed from the open state.' };
  const now = Date.now();
  const grace = Math.max(0, Number(graceMinutes) || 0);
  const next = grace > 0 ? 'queuing' : 'counted';
  db.get().prepare(`
    UPDATE stations SET status = ?, closed_at = ?, closed_by_name = ?, grace_minutes = ?,
      grace_ends_at = ?, queue_closed_at = ? WHERE id = ?
  `).run(next, now, officerName, grace, grace > 0 ? (now + grace * 60000) : null, now, stationId);
  electionMod_audit(`Closed polls at station "${stationId}" with ${grace}m grace by ${officerName}`, null);
  return { ok: true, station: getStation(stationId) };
}

// Close the queue immediately while already in a grace/queuing state.
function closeQueueNow(stationId, { officerName = 'Officer' } = {}) {
  const s = getStation(stationId);
  if (!s) return { ok: false, error: 'Station not found' };
  if (s.status !== 'queuing') return { ok: false, error: 'This station is not in a grace period.' };
  const now = Date.now();
  db.get().prepare(`
    UPDATE stations SET status = 'counted', grace_minutes = 0, grace_ends_at = null, queue_closed_at = ? WHERE id = ?
  `).run(now, stationId);
  electionMod_audit(`Closed queue at station "${stationId}" immediately by ${officerName}`, null);
  return { ok: true, station: getStation(stationId) };
}

// Seals the final result packet. Mirrors web submitPacket().
function submitPacket(stationId, { figures, categories, checks, officerName = 'Officer' } = {}) {
  const s = getStation(stationId);
  if (!s) return { ok: false, error: 'Station not found' };
  const eff = effectiveStatus(s);
  if (eff !== 'counted') return { ok: false, error: 'Station must be counted before results can be submitted.' };
  const packet = {
    stationId,
    submittedAt: new Date().toISOString(),
    submittedByName: officerName,
    figures: figures || {},
    categories: categories || [],
    consistency: { checks: checks || [] },
  };
  db.get().prepare('UPDATE stations SET status = ?, final_submit_json = ? WHERE id = ?')
    .run('submitted', JSON.stringify(packet), stationId);
  electionMod_audit(`Results submitted for station "${stationId}" by ${officerName} — packet sealed`, null);
  return { ok: true, station: getStation(stationId), packet };
}

// ---- Voters (station-scoped) ----

function checkInVoter(voterId, { officerName = 'Officer', stationId = null } = {}) {
  const d = db.get();
  const v = d.prepare('SELECT * FROM voters WHERE id = ?').get(voterId);
  if (!v) return { ok: false, error: 'Voter not found' };
  const station = resolveVoterStation(v);
  if (!station) return { ok: false, error: 'This voter is not assigned to a station.' };
  if (stationId) {
    const ctx = resolveStationRef(v.election_id, stationId);
    if (!ctx || ctx.id !== station.id) {
      return { ok: false, error: 'This voter is not assigned to this station.' };
    }
  }
  if (!isOpen(effectiveStatus(station))) return { ok: false, error: 'Polls are not open at this station.' };
  if (v.ballot_cast) return { ok: false, error: 'This voter has already cast their ballot.' };
  if (v.checked_in) return { ok: false, error: 'This voter is already checked in.' };
  const now = Date.now();
  d.prepare('UPDATE voters SET checked_in = 1, checked_in_at = ?, checked_in_by = ? WHERE id = ?')
    .run(now, officerName, voterId);
  electionMod_audit(`Checked in voter "${voterId}" at station "${station.id}" by ${officerName}`, null);
  return { ok: true, voter: d.prepare('SELECT * FROM voters WHERE id = ?').get(voterId) };
}

// Resolve a voter's station from the stations table, matching by station_id OR
// the station's id/code/name against the voter's assigned_station label.
function resolveVoterStation(v) {
  const d = db.get();
  if (v.station_id) {
    const byId = getStation(v.station_id);
    if (byId) return byId;
  }
  if (!v.assigned_station) return null;
  const label = String(v.assigned_station).toLowerCase();
  const rows = d.prepare('SELECT * FROM stations WHERE election_id = ?').all(v.election_id);
  return rows.find((s) => label && [s.id, s.code, s.name].filter(Boolean).some((k) => String(k).toLowerCase() === label)) || null;
}

// Marks a voter's ballot as cast. gracePeriod=true when voted during a grace window.
// Mirrors the ballot page updating registries with ballotCast + gracePeriod.
function markBallotCast(voterId, { gracePeriod = false, officerName = 'Officer' } = {}) {
  const d = db.get();
  const v = d.prepare('SELECT * FROM voters WHERE id = ?').get(voterId);
  if (!v) return { ok: false, error: 'Voter not found' };
  if (v.ballot_cast) return { ok: false, error: 'This voter has already cast their ballot.' };
  if (!v.checked_in) return { ok: false, error: 'This voter has not been checked in.' };
  const station = getStation(v.station_id);
  if (station && !isOpen(effectiveStatus(station))) return { ok: false, error: 'Polls are not accepting ballots at this station.' };
  d.prepare('UPDATE voters SET ballot_cast = 1, grace_period = ?, has_voted = 1 WHERE id = ?')
    .run(gracePeriod ? 1 : 0, voterId);
  electionMod_audit(`Voter "${voterId}" cast ballot at station "${v.station_id}"${gracePeriod ? ' (grace)' : ''}`, null);
  return { ok: true, voter: d.prepare('SELECT * FROM voters WHERE id = ?').get(voterId) };
}

// Full dashboard snapshot for a station: station record + its voters + derived stats.
function stationDashboard(electionId, stationId) {
  const e = electionMod.getElection(electionId);
  const station = getStation(stationId);
  if (!e) return { ok: false, error: 'Election not found' };
  if (!station) return { ok: false, error: 'Station not found' };
  const all = db.get().prepare('SELECT * FROM voters WHERE election_id = ?').all(electionId);
  const keys = new Set([stationId, station.code, station.name].filter(Boolean).map((k) => String(k).toLowerCase()));
  const members = all.filter((v) => {
    if (v.station_id && String(v.station_id) === stationId) return true;
    return keys.has(String(v.assigned_station || '').toLowerCase());
  }).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const checkedIn = members.filter((v) => v.checked_in === 1).length;
  const ballots = members.filter((v) => v.ballot_cast === 1).length;
  const grace = members.filter((v) => v.grace_period === 1).length;
  return {
    ok: true,
    election: e,
    station: Object.assign({}, station, { effStatus: effectiveStatus(station) }),
    voters: members,
    stats: {
      registered: members.length,
      checkedIn,
      inQueue: Math.max(0, checkedIn - ballots),
      ballots,
      grace,
    },
    packet: station.final_submit_json ? JSON.parse(station.final_submit_json) : null,
  };
}

function electionMod_audit(context, details) {
  // NOTE: callers MUST pass an explicit second argument. An omitted argument
  // leaves `details === undefined`, which hashes as the string "undefined" in
  // the raw and is silently persisted as NULL — a formula mismatch vs every
  // other audit writer (election.js, hub.js). Pass `null` to hash as "null".
  if (arguments.length < 2) details = arguments.length === 1 ? null : details;
  try {
    const d = db.get();
    const prev = d.prepare('SELECT id, entry_hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
    const entry = {
      election_id: null,
      officer_id: null,
      action: context,
      details,
      timestamp: Date.now(),
      prev_hash: prev ? prev.entry_hash : null,
      entry_hash: '',
    };
    const raw = `${entry.action}|${entry.details}|${entry.timestamp}`;
    const crypto = require('crypto');
    entry.entry_hash = crypto.createHash('sha256').update(raw).digest('hex');
    d.prepare('INSERT INTO audit_log (election_id, officer_id, action, details, timestamp, prev_hash, entry_hash) VALUES (@election_id, @officer_id, @action, @details, @timestamp, @prev_hash, @entry_hash)')
      .run(entry);
  } catch (e) { /* audit should never break an operation */ }
}

module.exports = {
  STATION_STATUSES,
  effectiveStatus,
  isOpen,
  getStation,
  getStationsForElection,
  addStation,
  updateStation,
  removeStation,
  openPolls,
  closePolls,
  closeQueueNow,
  submitPacket,
  checkInVoter,
  resolveVoterStation,
  resolveStationRef,
  markBallotCast,
  stationDashboard,
};
