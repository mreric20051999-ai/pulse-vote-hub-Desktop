// Digital vote signatures. Each SQLite database owns one persistent ed25519
// key pair (Node's native crypto — no external deps) stored as PEM in its own
// config table. Every written vote row carries a signature over the exact raw
// string that produced its vote_hash, so tampering invalidates the signature
// even if the hash were rebuilt. The integrity verifier checks every signature
// it finds; rows written by older versions (no signature column) are reported
// as unsigned but never fail the check.
//
// All functions take the db handle like the rest of the LAN layer, so they are
// testable under plain Node with no global singleton.
const crypto = require('crypto');

const KEY_PUB = 'vote_sig_pub';
const KEY_PRIV = 'vote_sig_priv';

const cache = new WeakMap(); // db handle -> { publicKey, privateKey, publicPem }

function ensureConfigTable(d) {
  const has = d.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='config'"
  ).get();
  if (!has) {
    d.exec('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)');
  }
}

function getKeyPair(d) {
  const hit = cache.get(d);
  if (hit) return hit;
  ensureConfigTable(d);
  const pubRow = d.prepare('SELECT value FROM config WHERE key = ?').get(KEY_PUB);
  const privRow = d.prepare('SELECT value FROM config WHERE key = ?').get(KEY_PRIV);
  let pair;
  if (!pubRow || !privRow) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    pair = {
      publicKey,
      privateKey,
      publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    };
    d.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(KEY_PUB, pair.publicPem);
    d.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(KEY_PRIV, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  } else {
    pair = {
      publicKey: crypto.createPublicKey(pubRow.value),
      privateKey: crypto.createPrivateKey(privRow.value),
      publicPem: pubRow.value,
    };
  }
  cache.set(d, pair);
  return pair;
}

function signRaw(d, raw) {
  const { privateKey } = getKeyPair(d);
  return crypto.sign(null, Buffer.from(String(raw), 'utf8'), privateKey).toString('base64');
}

// null  -> no signature present (legacy row)
// true  -> signature valid
// false -> signature invalid or unparseable
function verifyRaw(d, raw, signatureB64) {
  if (!signatureB64) return null;
  try {
    const { publicKey } = getKeyPair(d);
    return crypto.verify(
      null,
      Buffer.from(String(raw), 'utf8'),
      publicKey,
      Buffer.from(String(signatureB64), 'base64')
    );
  } catch (err) {
    return false;
  }
}

// Fingerprint of this database's signing public key (display / export labels).
function publicFingerprint(d) {
  const { publicPem } = getKeyPair(d);
  return crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
}

module.exports = { getKeyPair, signRaw, verifyRaw, publicFingerprint };