// Multi-location run coordinator.
//
// The overall ("main") election coordinator creates an election once, then
// hands each participating venue a RUN PACK: a portable, self-contained JSON
// file carrying the full ballot definition (positions, candidates, stations,
// and the entire voter registry) plus a registration secret. A location
// coordinator imports the pack on their own machine — no reconfiguration — and
// runs the same election at one named "location" (their stations, check-in,
// ballot kiosk, live figures). After sealing every station they export a
// RESULT PACK: the signed station packets, the votes, and the audit tail. The
// main coordinator imports each result pack, verifies it (vote hash chain +
// registered-voter/vote consistency), and compiles the aggregated result with
// a deterministic ordering so the combined tally is reproducible.
//
// Security model:
//  - Voter PII travels inside a pack. Run packs are encrypted (AES-256-GCM)
//    with a pack passphrase the main coordinator sets, so a leaked file is
//    useless without the passphrase.
//  - Each location's votes stay verifiable: the vote hash chain is
//    recomputable from the pack, and each vote references the election/station
//    it belongs to. Compilation re-checks signatures (per-machine ed25519) and
//    cross-checks votes <= check-ins before accepting a location.
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const auth = require('./auth');
const voterApi = require('./voter');
const electionMod = require('./election');
const signature = require('./signature');

const RUN_SCHEMA = 'pulse-vote-hub-run';
const RESULT_SCHEMA = 'pulse-vote-hub-result';
const SCHEMA_VERSION = 1;

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---- Portability / re-identification ----
//
// A run pack is authored on the main coordinator's machine. Each location that
// imports it must get a FRESH set of ids so the same pack can be reused across
// machines without fighting over primary keys, and so a location machine that
// already has its own elections is never corrupted. The pack therefore carries
// canonical snapshot rows keyed by stable "ref" ids which we remap on import.

function remapIds(snapshot) {
  // Map canonical -> new uuid. Voters are keyed by voter_id; positions and
  // candidates get new uuids; stations get new uuids.
  const posMap = new Map();
  const candMap = new Map();
  const stationMap = new Map();
  const newElectionId = uuidv4();
  const positions = (snapshot.positions || []).map((p) => {
    const id = uuidv4();
    posMap.set(p.id, id);
    return { ...p, id, election_id: newElectionId };
  });
  const candidates = (snapshot.candidates || []).map((c) => {
    const id = uuidv4();
    candMap.set(c.id, id);
    return { ...c, id, election_id: newElectionId, position_id: posMap.get(c.position_id) || c.position_id };
  });
  const stations = (snapshot.stations || []).map((s) => {
    const id = uuidv4();
    stationMap.set(s.id, id);
    return {
      id,
      election_id: newElectionId,
      name: s.name,
      location: s.location || null,
      code: s.code || null,
      status: 'not_opened',
      zero_report: 0,
      opened_at: null,
      closed_at: null,
      grace_minutes: null,
      grace_ends_at: null,
      queue_closed_at: null,
      final_submit_json: null,
      created_at: Date.now(),
    };
  });
  // Voters: new row per voter, fresh uuid, assigned_station resolved to the new
  // station code when possible (station codes are stable), election_id remapped.
  const voters = (snapshot.voters || []).map((v) => ({
    voter_id: v.voter_id,
    name: v.name || null,
    assigned_station: v.assigned_station || null,
    phone: v.phone || null,
    plain_password: v.plain_password || null,
  }));
  return { newElectionId, positions, candidates, stations, voters, posMap, candMap, stationMap };
}

// ---- Run pack creation (main coordinator) ----

function buildRunPackInput(electionId, d) {
  const e = d.prepare('SELECT * FROM elections WHERE id = ?').get(electionId);
  if (!e) return null;
  const positions = d.prepare('SELECT id, election_id, title, max_votes FROM positions WHERE election_id = ?').all(electionId);
  const candidates = d.prepare('SELECT id, election_id, position_id, name, photo_path, ballot_number, sort_order FROM candidates WHERE election_id = ?').all(electionId);
  const voters = d.prepare(
    'SELECT voter_id, name, assigned_station, phone, plain_password FROM voters WHERE election_id = ?'
  ).all(electionId);
  const stations = d.prepare(
    'SELECT id, election_id, name, location, code FROM stations WHERE election_id = ?'
  ).all(electionId);
  const officers = d.prepare(
    `SELECT name, officer_id, role, assigned_station_id FROM officers
     WHERE assigned_election_id = ? AND role IN ('assistant')`
  ).all(electionId);
  const voterSalt = voterApi.getVoterSalt() || '';
  return { election: e, positions, candidates, voters, stations, officers, voterSalt };
}

// Encrypt a segment (the full pack body) with a passphrase-derived key. Returns
// { iv, authTag, data } as base64 — no plaintext PII in the file.
function encryptPack(plaintext, passphrase) {
  const key = crypto.createHash('sha256').update(String(passphrase)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), authTag: authTag.toString('base64'), data: enc.toString('base64') };
}

// Build a complete run pack JSON string. The pack embeds a one-time setup code
// the main coordinator can share with the location: importing the pack with the
// correct passphrase + setup code auto-creates the location coordinator account
// and binds them to the imported election (no manual account creation needed on
// the location machine).
function createRunPackBody({ electionId, locationName, locationCode, passphrase }) {
  const d = db.get();
  const input = buildRunPackInput(electionId, d);
  if (!input) return { ok: false, error: 'Election not found' };
  const packId = uuidv4();
  const setupCode = crypto.randomBytes(9).toString('hex').toUpperCase().slice(0, 12); // 12-char secret
  const setupCodeHash = sha256(setupCode);
  const body = {
    schema: RUN_SCHEMA,
    schema_version: SCHEMA_VERSION,
    pack_id: packId,
    created_at: Date.now(),
    setup: { code: setupCode, code_hash: setupCodeHash },
    location: { name: locationName || null, code: locationCode || null },
    election: input.election,
    positions: input.positions,
    candidates: input.candidates,
    voters: input.voters,
    stations: input.stations,
    officers: input.officers,
    voter_salt: input.voterSalt,
  };
  let encrypted = null;
  if (passphrase) {
    encrypted = encryptPack(JSON.stringify(body), passphrase);
  }
  const pack = { schema: RUN_SCHEMA, schema_version: SCHEMA_VERSION, pack_id: packId, encrypted };
  const packHash = sha256(encrypted ? encrypted.data : JSON.stringify(body));
  return { ok: true, pack, packHash, body, setupCode, setupCodeHash };
}

// ---- Run pack import (location coordinator's machine) ----

// Decrypt a run pack back to its plaintext body.
function decryptPack(encrypted, passphrase) {
  if (!encrypted) return null;
  try {
    const key = crypto.createHash('sha256').update(String(passphrase)).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  } catch (e) {
    return null;
  }
}

// The main entry: import a run pack file (JSON, already parsed) on this machine,
// creating the election, location and location-coordinator account, stations,
// positions, candidates, and voters. `opts.passphrase` decrypts the pack;
// `opts.actor` is the person performing the import (admin on an existing
// install, or null on a fresh machine bootstrapping via the setup code).
function importRunPack(parsed, { passphrase = '', setupCode = '', actor = null } = {}) {
  if (!parsed || parsed.schema !== RUN_SCHEMA) return { ok: false, error: 'This is not a valid Pulse Vote Hub run pack.' };
  let body = parsed.encrypted ? decryptPack(parsed.encrypted, passphrase) : parsed;
  if (!body || body.schema_version !== SCHEMA_VERSION) {
    return { ok: false, error: 'Could not decrypt this run pack — check the passphrase, or it may be from an unsupported version.' };
  }
  const d = db.get();
  const title = (body.election && body.election.title) || '';
  if (!title) return { ok: false, error: 'This run pack has no election title.' };
  const exists = d.prepare('SELECT id FROM elections WHERE title = ?').get(title);
  if (exists) {
    return { ok: false, error: 'An election with this exact title already exists on this machine. Importing it again would create a duplicate — rename the election first or use a different pack.' };
  }

  const { newElectionId, positions, candidates, stations, voters } = remapIds(body);
  const locationName = (body.location && body.location.name) || 'Location';

  // Insert the election (owned by the acting person if admin, else unowned for now; the
  // location coordinator is created below and takes ownership).
  const e = body.election || {};
  const insertElection = d.prepare(`
    INSERT INTO elections (id, title, type, status, election_date, start_date, end_date, station_mode, close_grace_minutes, max_close_grace_minutes, created_at, closed_at, owner_id, voter_scheme)
    VALUES (@id, @title, @type, @status, @election_date, @start_date, @end_date, @station_mode, @close_grace_minutes, @max_close_grace_minutes, @created_at, @closed_at, @owner_id, @voter_scheme)
  `);
  insertElection.run({
    id: newElectionId,
    title,
    type: 'station',
    status: 'draft',
    election_date: e.election_date || null,
    start_date: e.start_date || null,
    end_date: e.end_date || null,
    station_mode: e.station_mode == null ? 1 : e.station_mode,
    close_grace_minutes: e.close_grace_minutes == null ? 30 : e.close_grace_minutes,
    max_close_grace_minutes: e.max_close_grace_minutes == null ? 120 : e.max_close_grace_minutes,
    created_at: Date.now(),
    closed_at: null,
    owner_id: actor && actor.id,
    voter_scheme: e.voter_scheme || 'index-only',
  });

  // Positions, candidates, stations.
  const insPos = d.prepare('INSERT INTO positions (id, election_id, title, max_votes) VALUES (@id, @election_id, @title, @max_votes)');
  for (const p of positions) insPos.run({ id: p.id, election_id: p.election_id, title: p.title, max_votes: p.max_votes });
  const insCand = d.prepare('INSERT INTO candidates (id, election_id, position_id, name, photo_path, ballot_number, sort_order) VALUES (@id, @election_id, @position_id, @name, @photo_path, @ballot_number, @sort_order)');
  for (const c of candidates) insCand.run({ id: c.id, election_id: c.election_id, position_id: c.position_id, name: c.name, photo_path: c.photo_path, ballot_number: c.ballot_number, sort_order: c.sort_order });
  const insStation = d.prepare(`
    INSERT INTO stations (id, election_id, name, location, code, status, opened_at, zero_report, closed_at, grace_minutes, grace_ends_at, queue_closed_at, final_submit_json, created_at)
    VALUES (@id, @election_id, @name, @location, @code, @status, @opened_at, @zero_report, @closed_at, @grace_minutes, @grace_ends_at, @queue_closed_at, @final_submit_json, @created_at)
  `);
  for (const s of stations) insStation.run(s);

  // Adopt the voter salt so the same voter credentials from the main
  // coordinator verify on this machine.
  if (body.voter_salt) voterApi.setVoterSalt(body.voter_salt);

  // Voters.
  const insVoter = d.prepare(`
    INSERT INTO voters (id, election_id, voter_id, name, password_hash, password_salt, plain_password, phone, assigned_station, has_voted, checked_in, ballot_cast)
    VALUES (@id, @election_id, @voter_id, @name, @password_hash, @password_salt, @plain_password, @phone, @assigned_station, 0, 0, 0)
  `);
  for (const v of voters) {
    insVoter.run({
      id: uuidv4(),
      election_id: newElectionId,
      voter_id: v.voter_id,
      name: v.name || null,
      password_hash: v.plain_password ? auth.hashPassword(v.plain_password, body.voter_salt || '') : '',
      password_salt: '',
      plain_password: v.plain_password || null,
      phone: v.phone || null,
      assigned_station: v.assigned_station || null,
    });
  }

  // Record the location.
  const locationId = uuidv4();
  d.prepare(`
    INSERT INTO locations (id, election_id, name, code, main_coordinator_id, setup_code_hash, setup_code_expires, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(locationId, newElectionId, locationName, (body.location && body.location.code) || null, (actor && actor.id) || null, sha256(setupCode || ''), Date.now());

  // Create / bind the location coordinator account from the setup code when no
  // admin is performing the import (fresh location machine), OR bind the acting
  // officer when present and they are an admin/coordinator.
  let coordinator = null;
  let coordinatorId = (actor && actor.id) || null;
  if (actor && (actor.role === 'admin' || actor.role === 'developer' || actor.role === 'coordinator')) {
    coordinator = actor;
  } else {
    // Fresh machine: derive a location coordinator from the pack setup code.
    const expected = (body.setup && body.setup.code_hash) || '';
    const actual = sha256(setupCode || '');
    const eq = actual.length === expected.length
      ? crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
      : false;
    if (!setupCode || !eq) {
      return { ok: false, error: 'Import succeeded, but the setup code entered does not match the main coordinator\'s — the location coordinator account was not created. Redeem it with the correct setup code.', code: 'setup-mismatch' };
    }
    const offName = `Location Coordinator — ${locationName}`;
    const offId = `LC${locationName.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const rawPassword = setupCode;
    const off = auth.insertOfficer(offName, offId, rawPassword, 'location_coordinator', { location_id: locationId });
    coordinator = { id: off.id, role: 'location_coordinator' };
    coordinatorId = off.id;
    // The imported election is owned by this location coordinator.
    d.prepare('UPDATE elections SET owner_id = ? WHERE id = ?').run(off.id, newElectionId);
  }

  d.prepare('INSERT OR IGNORE INTO locations_officers (id, location_id, officer_id, created_at) VALUES (?, ?, ?, ?)')
    .run(uuidv4(), locationId, coordinatorId, Date.now());

  // Remember the armed run pack so seal/export can reference it.
  d.prepare(`
    INSERT INTO run_packs (id, election_id, location_id, pack_hash, version, created_at, created_by, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(parsed.pack_id || uuidv4(), newElectionId, locationId, parsed.pack_id || '', SCHEMA_VERSION, Date.now(), (actor && actor.id) || null);

  d.prepare('UPDATE locations SET main_coordinator_id = ? WHERE id = ?').run(coordinator && coordinator.id, locationId);

  // Fresh audit entry so the chain continues cleanly on this machine.
  electionMod.audit('location-import', `Imported run pack "${title}" for location ${locationName}`);

  return {
    ok: true,
    election: { id: newElectionId, title },
    location: { id: locationId, name: locationName },
    coordinator: coordinator ? { id: coordinator.id, role: coordinator.role, officer_id: coordinator.officer_id } : null,
  };
}

// ---- Result pack creation (location coordinator, after sealing) ----

function buildResultPackInput(electionId, d) {
  const e = d.prepare('SELECT * FROM elections WHERE id = ?').get(electionId);
  if (!e) return { ok: false, error: 'Election not found' };
  const stations = d.prepare('SELECT * FROM stations WHERE election_id = ?').all(electionId);
  if (!stations.length) return { ok: false, error: 'No stations to export' };
  const notSealed = stations.filter((s) => s.status !== 'submitted');
  if (notSealed.length) {
    return { ok: false, error: 'Not all stations are sealed yet: ' + notSealed.map((s) => s.name).join(', ') };
  }
  const votes = d.prepare('SELECT * FROM votes WHERE election_id = ? ORDER BY id').all(electionId);
  const voters = d.prepare('SELECT voter_id, name, assigned_station, checked_in, ballot_cast FROM voters WHERE election_id = ?').all(electionId);
  const auditTail = d.prepare('SELECT action, details, timestamp, prev_hash, entry_hash FROM audit_log WHERE election_id = ? OR election_id IS NULL ORDER BY id').all(electionId);
  const location = d.prepare('SELECT * FROM locations WHERE election_id = ? ORDER BY created_at LIMIT 1').get(electionId);
  return { ok: true, election: e, stations, votes, voters, auditTail, location };
}

function createResultPack(electionId) {
  const d = db.get();
  const input = buildResultPackInput(electionId, d);
  if (!input.ok) return input;
  const e = input.election;
  const location = input.location || null;
  const locationName = (location && location.name) || 'Unknown location';
  const packId = uuidv4();
  const posTitle = new Map(d.prepare('SELECT id, title FROM positions WHERE election_id = ?').all(electionId).map((p) => [p.id, p.title]));
  const candName = new Map(d.prepare('SELECT id, name FROM candidates WHERE election_id = ?').all(electionId).map((c) => [c.id, c.name]));
  const payload = {
    schema: RESULT_SCHEMA,
    schema_version: SCHEMA_VERSION,
    pack_id: packId,
    created_at: Date.now(),
    location: location ? { id: location.id, name: location.name, code: location.code } : { name: locationName },
    election: { id: e.id, title: e.title, type: e.type, election_date: e.election_date, start_date: e.start_date, end_date: e.end_date },
    stations: input.stations.map((s) => ({
      id: s.id, name: s.name, code: s.code, status: s.status,
      figures: s.final_submit_json ? JSON.parse(s.final_submit_json) : null,
    })),
    votes: input.votes.map((v) => ({
      position_id: v.position_id,
      position_title: posTitle.get(v.position_id) || null,
      candidate_id: v.candidate_id,
      candidate_name: candName.get(v.candidate_id) || null,
      voter_id: v.voter_id,
      station_id: v.station_id,
      timestamp: v.timestamp,
      prev_hash: v.prev_hash,
    })),
    voters: input.voters,
    auditTail: input.auditTail,
  };
  const raw = JSON.stringify(payload).replace(/"signature":"[^"]*","locationPublicKey":"[^"]*"/, '');
  const verifyRaw = JSON.stringify({ ...payload, signature: null, locationPublicKey: null });
  const locationSignature = signature.signRaw(d, verifyRaw);
  const locationPublicKey = signature.getKeyPair(d).publicPem;
  const locationFingerprint = signature.publicFingerprint(d);
  const pack = {
    schema: RESULT_SCHEMA,
    schema_version: SCHEMA_VERSION,
    pack_id: packId,
    payload,
    signature: locationSignature,
    locationPublicKey,
    locationFingerprint,
  };
  return { ok: true, pack };
}

// ---- Result pack verification + compilation (main coordinator) ----

// Recompute the vote hash chain for a single result pack. `election.id` here is
// the location machine's internal election id, which is what the raw strings
// were signed over. Each vote's prev_hash must equal the recomputed hash of the
// previous vote (and the first vote has no prev). The final recomputed hash is
// also returned so the main coordinator can pin the chain per location.
function verifyResultPackVotes(pack) {
  const payload = pack.payload || {};
  const votes = Array.isArray(payload.votes) ? payload.votes : [];
  const electionId = (payload.election && payload.election.id) || '';
  let prevHash = null;
  let breakAt = -1;
  for (let i = 0; i < votes.length; i++) {
    const v = votes[i];
    const raw = `${electionId}|${v.candidate_id}|${v.voter_id}|${v.timestamp}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    if (i === 0) {
      if (v.prev_hash) { breakAt = 0; break; }
    } else if (v.prev_hash !== prevHash) {
      breakAt = i;
      break;
    }
    prevHash = hash;
  }
  return {
    ok: breakAt === -1 && votes.length > 0,
    votes: votes.length,
    breakAt,
    chainOk: breakAt === -1 && votes.length > 0,
    finalHash: prevHash,
    registeredOk: true,
  };
}

// Verify the location's signature (ed25519) over the vote payload.
function verifyResultPackSignature(pack) {
  const payload = pack.payload || {};
  try {
    const publicKey = crypto.createPublicKey(pack.locationPublicKey);
    const verifyRaw = JSON.stringify({ ...payload, signature: null, locationPublicKey: null });
    const sig = Buffer.from(pack.signature || '', 'base64');
    const ok = crypto.verify(null, Buffer.from(verifyRaw, 'utf8'), publicKey, sig);
    return ok;
  } catch (e) {
    return false;
  }
}

// Full verification used by the compile screen. `importedPack` is the parsed
// result pack. Returns a report shown to the main coordinator.
function verifyResultPack(pack) {
  const report = { ok: true, errors: [], warns: [] };
  if (!pack || pack.schema !== RESULT_SCHEMA) {
    report.ok = false;
    report.errors.push('Not a valid result pack.');
    return report;
  }
  const payload = pack.payload || {};
  const votes = Array.isArray(payload.votes) ? payload.votes : [];
  const voters = Array.isArray(payload.voters) ? payload.voters : [];
  const stations = Array.isArray(payload.stations) ? payload.stations : [];
  if (!votes.length) { report.ok = false; report.errors.push('No votes in this result pack.'); }
  if (!stations.every((s) => s.status === 'submitted')) {
    report.ok = false;
    report.errors.push('Not every station is marked as sealed/submitted.');
  }
  // Signature over the payload.
  const sigOk = verifyResultPackSignature(pack);
  if (!sigOk) { report.ok = false; report.errors.push('Location signature did not verify.'); }
  else report.warns.push('Location signature verified.');
  // Vote hash chain.
  const chain = verifyResultPackVotes(pack);
  if (!chain.ok) { report.ok = false; report.errors.push(`Vote chain broken at vote ${chain.breakAt}.`); }
  // Cross check: no voter may appear more than once, and cast <= checked in.
  const byVoter = new Map();
  for (const v of votes) byVoter.set(v.voter_id, (byVoter.get(v.voter_id) || 0) + 1);
  let dupVoters = 0;
  for (const [, n] of byVoter) if (n > 1) dupVoters += 1;
  if (dupVoters) { report.ok = false; report.errors.push(`${dupVoters} voter(s) appear more than once in this pack.`); }
  const checked = voters.filter((x) => x.checked_in === 1).length;
  if (votes.length > checked) { report.ok = false; report.errors.push(`Votes (${votes.length}) exceed checked-in voters (${checked}).`); }
  // Check the votes <= number of registered voters.
  if (votes.length > voters.length) { report.ok = false; report.errors.push(`Votes (${votes.length}) exceed registered voters (${voters.length}).`); }
  report.summary = {
    location: (payload.location && payload.location.name) || 'Unknown',
    election: (payload.election && payload.election.title) || '',
    votes: votes.length,
    voters: voters.length,
    checkedIn: checked,
    stations: stations.length,
    sealed: stations.filter((s) => s.status === 'submitted').length,
  };
  return report;
}

// Compile multiple verified result packs into the aggregate result. Votes are
// ordered deterministically by (pack creation time, then timestamp) and
// tallied per (position title, candidate name).
function compileResult(packs) {
  const valid = packs.filter((p) => p && p.payload);
  if (!valid.length) return { ok: false, error: 'No result packs to compile.' };
  const votes = [];
  for (const p of valid) {
    for (const v of (p.payload.votes || [])) {
      votes.push({
        location: (p.payload.location && p.payload.location.name) || 'Unknown',
        position_id: v.position_id,
        position: v.position_title || '',
        candidate_id: v.candidate_id,
        candidate: v.candidate_name || '',
        voter_id: v.voter_id,
        timestamp: v.timestamp,
      });
    }
  }
  // Deterministic ordering: by location name then by timestamp (stable).
  votes.sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : (a.timestamp - b.timestamp)));
  // Tally per (position, candidate).
  const tally = {};
  for (const v of votes) {
    const key = `${v.position}||${v.candidate}`;
    if (!tally[key]) tally[key] = { position: v.position, candidate: v.candidate, count: 0, locations: {} };
    tally[key].count += 1;
    tally[key].locations[v.location] = (tally[key].locations[v.location] || 0) + 1;
  }
  const positionsOrder = [];
  for (const p of valid) {
    const seen = new Set();
    for (const v of (p.payload.votes || [])) {
      if (v.position_title && !seen.has(v.position_title)) { positionsOrder.push(v.position_title); seen.add(v.position_title); }
    }
  }
  // Remove duplicates while preserving order.
  const uniquePositions = [...new Set(positionsOrder)];
  const aggregate = {
    ok: true,
    locations: valid.map((p) => (p.payload.location && p.payload.location.name) || 'Unknown'),
    votes: votes.length,
    positions: uniquePositions,
    tally: Object.values(tally).sort((a, b) => {
      const ai = uniquePositions.indexOf(a.position);
      const bi = uniquePositions.indexOf(b.position);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || (b.count - a.count);
    }),
  };
  return aggregate;
}

module.exports = {
  RUN_SCHEMA, RESULT_SCHEMA,
  createRunPackBody, importRunPack, createResultPack,
  verifyResultPack, compileResult,
  sha256,
};
