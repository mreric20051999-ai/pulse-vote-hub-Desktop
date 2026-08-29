// Hash-chain + database integrity verification. Every vote and audit_log row
// stores a SHA-256 hash of its own payload plus the hash of the previous row
// in the chain, so any tampering breaks the chain at the exact row that was
// edited. This module recomputes both chains and asks SQLite for its built-in
// `PRAGMA integrity_check` as well.
const crypto = require('crypto');
const db = require('./db');

function sha256(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Audit rows authored by the current writers hash `details` as its JS String
// value inside the raw (election.js, hub.js: explicit value; station.js legacy:
// single-arg call left details === undefined, persisted as NULL). Because a NULL
// in the DB is ambiguous, a NULL-details row is accepted if EITHER the current
// "null" form or the legacy "undefined" form recomputes to the stored hash.
const auditHashes = (r) => {
  const base = `${r.action}|`;
  const out = [sha256(base + `${r.details}|${r.timestamp}`)];
  if (r.details == null) out.push(sha256(base + `undefined|${r.timestamp}`));
  return out;
};

// Recompute and validate a chained row stream.
//   hashCandidates(row) -> one or more hashes the author could have written.
function verifyChain(d, table, rows, hashKey, prevKey, hashCandidates) {
  let lastStoredHash = null;
  for (const row of rows) {
    const candidates = hashCandidates(row);
    const matches = candidates.includes(row[hashKey]);
    if (!matches) {
      return { ok: false, at: row.id, reason: 'hash-mismatch', expected: candidates[0], found: row[hashKey] };
    }
    if (row[prevKey] !== lastStoredHash) {
      return { ok: false, at: row.id, reason: 'chain-gap', expectedPrev: lastStoredHash, found: row[prevKey] };
    }
    lastStoredHash = row[hashKey];
  }
  return { ok: true, rows: rows.length };
}

function verifyVoteChain(d) {
  const rows = d.prepare(
    'SELECT id, election_id, candidate_id, voter_id, timestamp, prev_hash, vote_hash FROM votes ORDER BY id'
  ).all();
  return verifyChain(d, 'votes', rows, 'vote_hash', 'prev_hash',
    (r) => [sha256(`${r.election_id}|${r.candidate_id}|${r.voter_id}|${r.timestamp}`)]);
}

function verifyAuditChain(d) {
  const rows = d.prepare(
    'SELECT id, action, details, timestamp, prev_hash, entry_hash FROM audit_log ORDER BY id'
  ).all();
  return verifyChain(d, 'audit_log', rows, 'entry_hash', 'prev_hash', auditHashes);
}

// SQLite's built-in page-level check.
function verifyPragma(d) {
  try {
    const out = d.pragma('integrity_check', { simple: true });
    return { ok: out === 'ok', result: out };
  } catch (err) {
    return { ok: false, result: err.message };
  }
}

// Full check, ready for IPC + on-disk report.
function verifyAll() {
  const d = db.get();
  const started = Date.now();
  let voteChain, auditChain, pragma;
  try { voteChain = verifyVoteChain(d); } catch (e) { voteChain = { ok: false, reason: e.message }; }
  try { auditChain = verifyAuditChain(d); } catch (e) { auditChain = { ok: false, reason: e.message }; }
  try { pragma = verifyPragma(d); } catch (e) { pragma = { ok: false, result: e.message }; }
  return {
    ok: !!(voteChain.ok && auditChain.ok && pragma.ok),
    checkedAt: started,
    durationMs: Date.now() - started,
    voteChain,
    auditChain,
    pragma,
  };
}

module.exports = { verifyAll, verifyVoteChain, verifyAuditChain, verifyPragma };