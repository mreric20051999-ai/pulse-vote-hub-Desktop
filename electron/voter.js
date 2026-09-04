const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const db = require('./db');
const auth = require('./auth');
const { computedStatus } = require('./election');
const station = require('./station');
const sig = require('./signature');
const vault = require('./vault');
const { requiredString, optionalString, MAX_IMPORT_ROWS, LIMITS } = require('./validate');

// ---- Voter management ----

function listVoters(electionId, { limit = 200, offset = 0 } = {}) {
  const d = db.get();
  const total = d.prepare('SELECT COUNT(*) AS c FROM voters WHERE election_id = ?').get(electionId).c;
  const voters = d.prepare(`
    SELECT id, voter_id, name, assigned_station, has_voted, voted_at, position_voted
    FROM voters WHERE election_id = ? ORDER BY name, voter_id LIMIT ? OFFSET ?
  `).all(electionId, limit, offset);
  return { total, voters };
}

function getVoter(electionId, voterId) {
  return db.get().prepare('SELECT * FROM voters WHERE election_id = ? AND voter_id = ?').get(electionId, voterId) || null;
}

// Add a single voter (name optional; voterId auto-generated if not given)
function addVoter({ electionId, name, voterId, assignedStation, password, phone }) {
  if (!getElectionRow(electionId)) return { ok: false, error: 'Election not found' };

  const vName = optionalString(name, 'Name', { max: LIMITS.voterName });
  if (!vName.ok) return vName;

  const finalVoterId = (voterId && String(voterId).trim()) ? String(voterId).trim().toUpperCase() : generateVoterId();
  if (finalVoterId.length > LIMITS.voterId) return { ok: false, error: `Voter ID must be ${LIMITS.voterId} characters or fewer` };

  const finalPassword = password ? String(password) : generatePassword();
  if (!String(finalPassword).trim()) return { ok: false, error: 'Password cannot be empty' };
  if (finalPassword.length > 128) return { ok: false, error: 'Password must be 128 characters or fewer' };

  if (getVoter(electionId, finalVoterId)) return { ok: false, error: 'Voter ID already exists' };

  const stName = optionalString(assignedStation, 'Station', { max: LIMITS.stationName });
  if (!stName.ok) return stName;
  const ph = optionalString(phone, 'Phone', { max: LIMITS.phone });
  if (!ph.ok) return ph;

  const d = db.get();
  d.prepare(`
    INSERT INTO voters (id, election_id, voter_id, name, password_hash, password_salt, plain_password, phone, assigned_station, has_voted)
    VALUES (@id, @election_id, @voter_id, @name, @password_hash, @password_salt, @plain_password, @phone, @assigned_station, 0)
  `).run({
    id: uuidv4(),
    election_id: electionId,
    voter_id: finalVoterId,
    name: name ? String(name).trim() : null,
    password_hash: auth.hashPassword(finalPassword, fallbackSalt()),
    password_salt: '',
    plain_password: vault.encrypt(finalPassword),
    phone: phone ? String(phone).trim() : null,
    assigned_station: assignedStation ? String(assignedStation).trim() : null,
  });

  return { ok: true, voter: { voter_id: finalVoterId, password: finalPassword, name, phone: phone || null, assigned_station: assignedStation } };
}

// Import voters from a CSV string.
// Accepts columns: voter_id, name, assigned_station (password auto-generated when absent)
function importCsv(electionId, csvText) {
  if (!getElectionRow(electionId)) return { ok: false, error: 'Election not found' };
  if (!csvText || !String(csvText).trim()) return { ok: false, error: 'CSV is empty' };

  let records;
  try {
    records = parse(String(csvText), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return { ok: false, error: 'Could not parse CSV: ' + e.message };
  }

  if (records.length > MAX_IMPORT_ROWS) {
    return { ok: false, error: `CSV has ${records.length} rows; the maximum allowed per import is ${MAX_IMPORT_ROWS}` };
  }

  const d = db.get();
  const insert = d.prepare(`
    INSERT INTO voters (id, election_id, voter_id, name, password_hash, password_salt, plain_password, phone, assigned_station, has_voted)
    VALUES (@id, @election_id, @voter_id, @name, @password_hash, @password_salt, @plain_password, @phone, @assigned_station, 0)
  `);

  const tx = d.transaction((rows) => {
    let added = 0, skipped = 0;
    for (const row of rows) {
      const voterId = (row.voter_id || row.voterID || row.id || '').toString().trim().toUpperCase();
      if (!voterId) { skipped++; continue; }
      if (voterId.length > LIMITS.voterId) { skipped++; continue; }
      if (getVoter(electionId, voterId)) { skipped++; continue; }
      const password = row.password ? String(row.password) : generatePassword();
      if (!password.trim() || password.length > 128) { skipped++; continue; }
      const name = (row.name || row.full_name || row.fullname || '').trim() || null;
      if (name && name.length > LIMITS.voterName) { skipped++; continue; }
      const phone = (row.phone || row.phone_number || row.phoneNumber || '').trim() || null;
      if (phone && phone.length > LIMITS.phone) { skipped++; continue; }
      insert.run({
        id: uuidv4(),
        election_id: electionId,
        voter_id: voterId,
        name,
        password_hash: auth.hashPassword(password, fallbackSalt()),
        password_salt: '',
        plain_password: vault.encrypt(password),
        phone,
        assigned_station: (row.assigned_station || '').trim().slice(0, LIMITS.stationName) || null,
      });
      added++;
    }
    return { added, skipped };
  });

  return { ok: true, ...tx(records) };
}

// Auto-generate voters from a pasted list, per scheme.
// scheme: 'name-index' | 'index-only' | 'index-phone' | 'range'
// list: newline-separated; each line is "name" or CSV "name,index,phone" parts.
// range: { from, to } for 'range' scheme -> generates sequential Voter IDs over a numeric range.
function autoGenerate(electionId, { count = 10, scheme = 'name-index', list = '', from, to, assignedStation } = {}) {
  if (!getElectionRow(electionId)) return { ok: false, error: 'Election not found' };
  if (!['name-index', 'index-only', 'index-phone', 'range'].includes(scheme)) {
    return { ok: false, error: 'Invalid generation scheme' };
  }
  count = Math.min(5000, Math.max(0, Number(count) || 0));
  list = String(list || '');

  // Parse the pasted list into rows.
  const rows = [];
  for (const rawLine of list.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Support comma-separated "name,index,phone"
    const parts = line.split(',').map((s) => s.trim());
    rows.push({
      name: parts[0] || '',
      index: parts[1] || '',
      phone: parts[2] || '',
    });
  }

  const d = db.get();
  const insert = d.prepare(`
    INSERT INTO voters (id, election_id, voter_id, name, password_hash, password_salt, plain_password, phone, assigned_station, has_voted)
    VALUES (@id, @election_id, @voter_id, @name, @password_hash, @password_salt, @plain_password, @phone, @assigned_station, 0)
  `);
  const existing = new Set(d.prepare('SELECT voter_id FROM voters WHERE election_id = ?').all(electionId).map((r) => r.voter_id));

  let added = 0;
  let usedIndexes = new Set();
  const created = [];

  function nextAutoId() {
    let n = 1;
    let id;
    do {
      id = generateVoterId(n);
      n++;
    } while (existing.has(id) || usedIndexes.has(id));
    usedIndexes.add(id);
    return id;
  }

  function insertVoter(voterId, name, phone, plainPassword) {
    const password = plainPassword || generatePassword();
    insert.run({
      id: uuidv4(),
      election_id: electionId,
      voter_id: voterId,
      name,
      password_hash: auth.hashPassword(password, fallbackSalt()),
      password_salt: '',
      plain_password: vault.encrypt(password),
      phone: phone || null,
      assigned_station: assignedStation ? String(assignedStation).trim() : null,
    });
    existing.add(voterId);
    usedIndexes.add(voterId);
    created.push({ voter_id: voterId, name: name || '', phone: phone || '', password });
    added++;
  }

  // Range scheme: generate sequential Voter IDs (Vxxxx) across a numeric range.
  if (scheme === 'range') {
    const fromN = Math.max(1, Math.floor(Number(from) || 1));
    const toN = Math.floor(Number(to) || fromN);
    if (!Number.isFinite(fromN) || !Number.isFinite(toN) || toN < fromN) {
      return { ok: false, error: 'Range is invalid. To must be greater than or equal to From.' };
    }
    const cap = Math.max(1, toN - fromN + 1);
    if (cap > 5000) return { ok: false, error: 'Range is too large (max 5000 voters at once).' };
    const pad = Math.max(4, String(toN).length);
    for (let num = fromN; num <= toN; num++) {
      const voterId = `V${String(num).padStart(pad, '0')}`;
      if (existing.has(voterId) || usedIndexes.has(voterId)) { usedIndexes.add(voterId); continue; }
      insertVoter(voterId, null);
    }
    db.get().prepare('UPDATE elections SET voter_scheme = ? WHERE id = ?').run('index-only', electionId);
    return { ok: true, count: added, from: fromN, to: toN, assignedStation: assignedStation || null, created };
  }

  // number of voters wanted; if a list is provided use its length (or count cap)
  const target = rows.length ? Math.min(rows.length, count || rows.length) : Math.max(1, Number(count) || 1);

  for (let i = 0; i < target; i++) {
    let voterId;
    let name = null;
    let phoneFor = null;

    if (scheme === 'index-only') {
      // Each line is an index number -> used directly as the voter ID.
      const idx = rows[i] ? (rows[i].index || rows[i].name) : '';
      voterId = idx ? String(idx).trim().toUpperCase() : nextAutoId();
      name = null;
    } else if (scheme === 'index-phone') {
      const idx = rows[i] ? rows[i].index : '';
      const phone = rows[i] ? rows[i].phone : '';
      voterId = idx ? String(idx).trim().toUpperCase() : nextAutoId();
      name = null;
      phoneFor = phone;
    } else {
      // name-index
      const rowName = rows[i] ? rows[i].name : '';
      const idx = rows[i] ? rows[i].index : '';
      voterId = idx ? String(idx).trim().toUpperCase() : nextAutoId();
      name = rowName || null;
    }

    if (!voterId || existing.has(voterId)) {
      usedIndexes.add(voterId);
      continue;
    }

    insertVoter(voterId, name, phoneFor);
    phoneFor = null;
  }

  db.get().prepare('UPDATE elections SET voter_scheme = ? WHERE id = ?')
    .run(scheme === 'range' ? 'index-only' : scheme, electionId);
  return { ok: true, count: added, assignedStation: assignedStation || null, created };
}

function deleteVoter(electionId, voterId) {
  const d = db.get();
  d.prepare('DELETE FROM voters WHERE election_id = ? AND voter_id = ?').run(electionId, voterId);
  d.prepare('DELETE FROM checkins WHERE election_id = ? AND voter_id = ?').run(electionId, voterId);
  return { ok: true };
}

function clearVoters(electionId) {
  db.get().prepare('DELETE FROM checkins WHERE election_id = ?').run(electionId);
  db.get().prepare('DELETE FROM voters WHERE election_id = ?').run(electionId);
  return { ok: true };
}

function unvoteVoter(electionId, voterId) {
  db.get().prepare('UPDATE voters SET has_voted = 0, voted_at = NULL, position_voted = NULL WHERE election_id = ? AND voter_id = ?')
    .run(electionId, voterId);
  db.get().prepare('DELETE FROM votes WHERE election_id = ? AND voter_id = ?').run(electionId, voterId);
  return { ok: true };
}

// ---- Kiosk voter verification + ballot casting ----

// One-time ballot tickets. `verifyVoter` mints a short-lived ticket bound to
// the caller's key (desktop: the webContents id; LAN: the client IP) and to a
// single (election, voter). `castVote` refuses to record a ballot without a
// matching, unconsumed ticket, so an attacker who knows a voter ID can no
// longer cast on that voter's behalf without a successful password check.
// Tickets are single-use and expire, and the store is bounded.
const CAST_TICKET_TTL_MS = 5 * 60 * 1000;
const tickets = new Map(); // `${electionId}|${voterId}` -> { ticket, key, expiresAt }

function createCastTicket(electionId, voterId, key) {
  const now = Date.now();
  if (tickets.size > 10000) {
    for (const [k, t] of tickets) if (t.expiresAt <= now) tickets.delete(k);
  }
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(`${electionId}|${String(voterId).toUpperCase()}`, {
    ticket,
    key: key || null,
    expiresAt: now + CAST_TICKET_TTL_MS,
  });
  return ticket;
}

// Consume the ticket for (election, voter). Returns a reason string on failure
// ('verify-first' | 'no-ticket' | 'wrong-ticket' | 'expired').
function consumeCastTicket(electionId, voterId, key, ticket) {
  const slot = tickets.get(`${electionId}|${String(voterId).toUpperCase()}`);
  if (!slot || !ticket) return 'verify-first';
  if (slot.key != null && key != null && slot.key !== key) return 'wrong-ticket';
  if (slot.ticket !== ticket) return 'wrong-ticket';
  tickets.delete(`${electionId}|${String(voterId).toUpperCase()}`);
  if (Date.now() > slot.expiresAt) return 'expired';
  return null;
}

function verifyVoter(electionId, voterId, password, key) {
  const row = db.get().prepare(
    'SELECT id, voter_id, name, password_hash, assigned_station, station_id, checked_in, ballot_cast, has_voted, voted_at FROM voters WHERE election_id = ? AND voter_id = ?'
  ).get(electionId, String(voterId || '').trim().toUpperCase());
  if (!row) return { ok: false, error: 'Voter not found', code: 'not-found' };
  if (row.has_voted) return { ok: false, error: 'This voter has already cast a ballot.', code: 'already-voted' };

  const expected = Buffer.from(row.password_hash, 'hex');
  const actual = Buffer.from(auth.hashPassword(String(password || ''), fallbackSalt()), 'hex');
  const matches = expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  if (!matches) return { ok: false, error: 'Invalid voter ID or password.', code: 'bad-credentials' };

  return {
    ok: true,
    voter: {
      voter_id: row.voter_id,
      name: row.name,
      assigned_station: row.assigned_station,
      station_id: row.station_id || null,
      checked_in: !!row.checked_in,
    },
    castTicket: createCastTicket(electionId, row.voter_id, key),
  };
}

// Voter self-service password recovery. The voter types the details matching
// the scheme used to generate them; if a record matches, their cast password
// is returned so they can use it on the kiosk ballot.
// NOTE: `revealPassword` must be FALSE for any network-exposed path (the LAN
// kiosk endpoint). The voting password is never sent over the network; only
// the local desktop recovery flow may reveal it to the help desk.
function verifyVoterDetails(electionId, { voterId, name, phone, revealPassword = false } = {}) {
  const d = db.get();
  const election = d.prepare('SELECT * FROM elections WHERE id = ?').get(electionId);
  if (!election) return { ok: false, error: 'Election not found', code: 'not-found' };

  const scheme = election.voter_scheme || 'name-index';
  const vid = String(voterId || '').trim().toUpperCase();
  const nameVal = String(name || '').trim();
  const phoneVal = String(phone || '').trim();

  if (!vid) return { ok: false, error: 'Enter your voter ID.', code: 'missing' };
  if ((scheme === 'name-index' || !scheme) && !nameVal) return { ok: false, error: 'Enter your full name.', code: 'missing' };
  if (scheme === 'index-phone' && !phoneVal) return { ok: false, error: 'Enter your phone number.', code: 'missing' };

  let voter;
  if (scheme === 'name-index') {
    voter = d.prepare(
      "SELECT voter_id, name, phone, plain_password, assigned_station, election_id, station_id, has_voted FROM voters WHERE election_id = ? AND UPPER(voter_id) = ? AND LOWER(name) = LOWER(?)"
    ).get(electionId, vid, nameVal);
  } else if (scheme === 'index-phone') {
    voter = d.prepare(
      "SELECT voter_id, name, phone, plain_password, assigned_station, election_id, station_id, has_voted FROM voters WHERE election_id = ? AND UPPER(voter_id) = ? AND phone IS NOT NULL AND LOWER(phone) = LOWER(?)"
    ).get(electionId, vid, phoneVal);
  } else {
    voter = d.prepare(
      "SELECT voter_id, name, phone, plain_password, assigned_station, election_id, station_id, has_voted FROM voters WHERE election_id = ? AND UPPER(voter_id) = ?"
    ).get(electionId, vid);
  }

  if (!voter) return { ok: false, error: 'No voter matches those details. Check them and try again.', code: 'no-match' };

  // The password may only be revealed on an authenticated local (desktop) path
  // where the caller is a trusted coordinator/help desk and requests it
  // explicitly (`revealPassword: true`, gated by session token + account role
  // and rate-limited). On every network-exposed path (`revealPassword: false`)
  // the password is never released, for every scheme — otherwise an attacker
  // who knows a voter ID could turn the endpoint into an enumeration oracle.
  const canReveal = revealPassword;

  // Station elections: surface the voter's polling station during password
  // recovery, and only release credentials once polls at that station are
  // open (or in the grace window). Mirrors the cast-time gate so voters and
  // the ballot desk see the check before a ballot is ever started.
  let stationInfo = null;
  if (election && election.type === 'station') {
    const st = station.resolveVoterStation(voter);
    if (!st) return { ok: false, error: 'This voter is not assigned to a polling station.', code: 'no-station' };
    const eff = station.effectiveStatus(st);
    if (!station.isOpen(eff)) {
      return { ok: false, error: `Polls at “${st.name}” are not yet open for voting.`, code: 'station-not-open' };
    }
    stationInfo = { id: st.id, name: st.name, location: st.location || '', status: eff };
  }

  return {
    ok: true,
    voter: {
      voter_id: voter.voter_id,
      name: voter.name,
      phone: voter.phone,
      password: (canReveal && voter.plain_password) ? vault.decrypt(voter.plain_password) : null,
      assigned_station: voter.assigned_station,
      has_voted: !!voter.has_voted,
    },
    station: stationInfo,
  };
}

// Record a cast ballot for a verified voter.
// selection: [{ positionId, candidateId }] — one entry per selected candidate.
// For station elections `stationContext` carries the station (id/code/name) the
// ballot was opened on; casting requires that station, a prior check-in, and an
// open/queuing poll. Non-station elections ignore it.
// `castTicket` is the one-time ticket minted by verifyVoter — without a valid,
// unconsumed ticket the ballot is refused (prevents vote stuffing).
function castVote(electionId, voterId, selection, castTicket, stationContext, key) {
  const d = db.get();

  // A verified voter's ticket must have been minted for THIS ballot.
  const ticketErr = consumeCastTicket(electionId, voterId, key, castTicket);
  if (ticketErr) {
    return { ok: false, error: ticketErr === 'expired'
      ? 'Your sign-in has expired. Go back and sign in again.'
      : 'Please sign in again before casting your ballot.', code: 'verify-first' };
  }

  const election = d.prepare('SELECT id, title, type, status, start_date, end_date FROM elections WHERE id = ?').get(electionId);
  if (!election) return { ok: false, error: 'Election not found', code: 'no-election' };
  if (computedStatus(election) !== 'active') return { ok: false, error: 'This election is not open for voting.', code: 'not-open' };

  const voterRow = d.prepare(
    'SELECT * FROM voters WHERE election_id = ? AND voter_id = ?'
  ).get(electionId, String(voterId || '').trim().toUpperCase());
  if (!voterRow) return { ok: false, error: 'Voter not found', code: 'not-found' };
  if (voterRow.has_voted) return { ok: false, error: 'This voter has already cast a ballot.', code: 'already-voted' };

  // Station elections: the voter must be casting at a poll whose effective
  // status is open or queuing (web model). A queuing (grace-window) ballot is
  // recorded as a grace-period vote. Casting is additionally bound to the
  // physical station the ballot was opened for — a voter can only cast at
  // their own assigned station — and requires a prior check-in by an officer.
  let gracePeriod = false;
  let resolvableStation = null;
  if (election.type === 'station') {
    const st = station.resolveVoterStation(voterRow);
    if (!st) return { ok: false, error: 'This voter is not assigned to a polling station.', code: 'no-station' };
    const eff = station.effectiveStatus(st);
    if (eff !== 'open' && eff !== 'queuing') {
      return { ok: false, error: 'Polls at this station are not accepting ballots.', code: 'station-not-open' };
    }
    gracePeriod = eff === 'queuing';

    if (!stationContext) {
      return { ok: false, error: 'This ballot must be opened for a specific polling station.', code: 'no-station' };
    }
    const ctx = station.resolveStationRef(electionId, stationContext);
    if (!ctx || ctx.id !== st.id) {
      return { ok: false, error: `This voter is registered to “${st.name}”, not this polling station.`, code: 'wrong-station' };
    }
    if (!voterRow.checked_in) {
      return { ok: false, error: 'This voter must be checked in before casting a ballot.', code: 'not-checked-in' };
    }
    resolvableStation = st;
  }

  if (!selection || !selection.length) {
    return { ok: false, error: 'No selections made.', code: 'empty' };
  }

  // Enforce each position's max_votes server-side so a crafted or buggy ballot
  // cannot exceed the number of selections allowed for a position.
  const positionRows = d.prepare('SELECT id, title, max_votes FROM positions WHERE election_id = ?').all(electionId);
  const maxByPosition = new Map(positionRows.map((p) => [p.id, Math.max(1, Number(p.max_votes) || 1)]));
  const perPosition = new Map();
  for (const sel of selection) {
    perPosition.set(sel.positionId, (perPosition.get(sel.positionId) || 0) + 1);
  }
  for (const [positionId, n] of perPosition) {
    const limit = maxByPosition.get(positionId) || 1;
    if (n > limit) {
      const pos = positionRows.find((p) => p.id === positionId);
      const name = pos ? pos.title : positionId;
      return {
        ok: false,
        error: `Position “${name}” allows at most ${limit} selection${limit === 1 ? '' : 's'}.`,
        code: 'max-selections',
      };
    }
  }

  const insertVote = d.prepare(`
    INSERT INTO votes (election_id, position_id, candidate_id, voter_id, station_id, timestamp, prev_hash, vote_hash, signature, synced)
    VALUES (@election_id, @position_id, @candidate_id, @voter_id, @station_id, @timestamp, @prev_hash, @vote_hash, @signature, 0)
  `);

  const now = Date.now();
  const prev = d.prepare('SELECT vote_hash FROM votes ORDER BY id DESC LIMIT 1').get();
  let prevHash = prev ? prev.vote_hash : null;

  const tx = d.transaction(() => {
    // Validate every selection belongs to this election before writing anything.
    for (const sel of selection) {
      const cand = d.prepare(
        'SELECT id FROM candidates WHERE id = ? AND election_id = ? AND position_id = ?'
      ).get(sel.candidateId, electionId, sel.positionId);
      if (!cand) return { ok: false, error: 'Invalid candidate selection.', code: 'invalid' };
    }

    const positionTitles = d.prepare('SELECT id, title FROM positions WHERE election_id = ?').all(electionId);
    const titleByPos = new Map(positionTitles.map((p) => [p.id, p.title]));
    const votedPositions = new Set();

    for (const sel of selection) {
      const raw = `${election.id}|${sel.candidateId}|${voterRow.voter_id}|${now}`;
      const voteHash = crypto.createHash('sha256').update(raw).digest('hex');
      insertVote.run({
        election_id: electionId,
        position_id: sel.positionId,
        candidate_id: sel.candidateId,
        voter_id: voterRow.voter_id,
        station_id: resolvableStation ? resolvableStation.id : null,
        timestamp: now,
        prev_hash: prevHash,
        vote_hash: voteHash,
        signature: sig.signRaw(d, raw),
      });
      prevHash = voteHash;
      votedPositions.add(sel.positionId);
    }

    const positionLabel = [...votedPositions].map((id) => titleByPos.get(id) || '').filter(Boolean).join(', ');
    d.prepare('UPDATE voters SET has_voted = 1, voted_at = ?, position_voted = ?, ballot_cast = 1, grace_period = ? WHERE id = ?')
      .run(now, positionLabel || null, gracePeriod ? 1 : 0, voterRow.id);
    return { ok: true, count: selection.length };
  });

  const res = tx();
  if (!res.ok) return res;
  return { ok: true, count: res.count, timestamp: now };
}

// ---- helpers ----

function getElectionRow(electionId) {
  return db.get().prepare('SELECT id FROM elections WHERE id = ?').get(electionId);
}

// Salt fallback: our officers store salt baked in; voters use a fixed project salt.
let _saltCache = null;
function fallbackSalt() {
  if (_saltCache) return _saltCache;
  let s = db.get().prepare('SELECT value FROM config WHERE key = ?').get('voter_salt');
  if (!s) {
    s = crypto.randomBytes(16).toString('hex');
    db.setConfig('voter_salt', s);
  } else {
    s = s.value;
  }
  _saltCache = s;
  return s;
}

// Adopt a voter-salt supplied by an imported Run Pack so that the same voter
// IDs / passwords issued by the main coordinator verify on this machine too.
function setVoterSalt(salt) {
  if (!salt) return;
  db.setConfig('voter_salt', String(salt));
  _saltCache = null;
  fallbackSalt();
}

function generateVoterId(n) {
  const num = n ? String(n).padStart(4, '0') : randomDigits(6);
  return `V${num}`;
}

// Voting password: auto-generated 6-digit numeric code.
function generatePassword() {
  return randomDigits(6);
}

function randomDigits(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += crypto.randomInt(0, 10);
  return out;
}

module.exports = {
  listVoters,
  getVoter,
  addVoter,
  importCsv,
  autoGenerate,
  deleteVoter,
  clearVoters,
  unvoteVoter,
  verifyVoter,
  verifyVoterDetails,
  castVote,
  setVoterSalt,
  getVoterSalt: () => fallbackSalt(),
  generateVoterId,
  generatePassword,
};
