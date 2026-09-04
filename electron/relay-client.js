// ---- Pulse Vote Hub — over-the-internet sealed-pack relay (app side) ----
//
// Distance hand-off without any manual file transfer. A location coordinator
// encrypts their sealed result pack END-TO-END (AES-256-GCM with a passphrase
// they set and share by phone) and pushes the ciphertext to the relay server,
// keyed by a high-entropy transfer code. The main coordinator claims the code
// once (one-time) and decrypts with the passphrase. The relay never sees the
// passphrase or any plaintext, and envelopes expire automatically.
//
// Reuses the existing license-server infrastructure (same host/URL), so a
// deployment that already runs the license server gets this too — nothing new
// to host. Override the host per-install with the `relay_server` config key.

const crypto = require('crypto');
const lic = require('./license-client');
const db = require('./db');

// Default: same server as licensing. The Developer console override
// (`relay_server`) takes precedence when set.
const DEFAULT_RELAY_SERVER = lic.serverConfig().url || 'https://pulse-vote-hub-license.onrender.com';

function relayConfig() {
  const stored = String(db.getConfig('relay_server') || '').trim();
  return stored || lic.serverConfig().url || DEFAULT_RELAY_SERVER;
}

// High-entropy claim code, e.g. "PK8F-31A2-C0B1-7D03". The receiver only needs
// this code + the passphrase to decrypt; the code is the credential.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateTransferCode() {
  let raw = '';
  for (let i = 0; i < 16; i++) raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `PK-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
}

// Strong KDF: result packs carry voter PII and travel over the internet, so use
// scrypt rather than the fast-sha256 used for on-disk run packs.
function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 16384, r: 8, p: 1 });
}

function encrypt(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { salt, iv, authTag, data };
}

function decrypt(payload, passphrase) {
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
}

// Push an already-encrypted result envelope. `meta` holds only non-secret
// identification. Returns { ok, code, expires_at }.
async function sendPack({ code, passphrase, pack, meta }) {
  if (!pack || typeof pack !== 'object') return { ok: false, error: 'Nothing to send.' };
  if (!passphrase || String(passphrase).length < 8) return { ok: false, error: 'Passphrase must be at least 8 characters.' };
  const transferCode = code || generateTransferCode();
  const enc = encrypt(JSON.stringify(pack), passphrase);
  const envelope = { salt: enc.salt.toString('base64'), iv: enc.iv.toString('base64'), authTag: enc.authTag.toString('base64'), data: enc.data.toString('base64') };
  const res = await lic.request('POST', '/relay/put', {
    url: relayConfig(),
    body: {
      code: transferCode,
      kind: 'result',
      title: (meta && meta.title) || '',
      location: (meta && meta.location) || '',
      fingerprint: (meta && meta.fingerprint) || '',
      device: lic.machineId(),
      ttl_days: (meta && meta.ttl_days) || 7,
      ciphertext: JSON.stringify(envelope),
    },
  });
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'Relay push failed.' };
  return { ok: true, code: transferCode, expires_at: res.expires_at, ttl_days: res.ttl_days };
}

// Claim a sealed result envelope from the relay and decrypt it with the
// passphrase the sender shared out-of-band. One-time: a second claim fails.
async function receivePack({ code, passphrase }) {
  const transferCode = String(code || '').trim();
  if (!transferCode) return { ok: false, error: 'Enter the transfer code from your location coordinator.' };
  if (!passphrase || String(passphrase).length < 8) return { ok: false, error: 'Passphrase must be at least 8 characters.' };
  const res = await lic.request('GET', '/relay/get', { url: relayConfig(), query: { code: transferCode } });
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'Relay pull failed.' };
  let envelope;
  try { envelope = JSON.parse(res.ciphertext); }
  catch (e) { return { ok: false, error: 'The envelope on the relay is corrupt.' }; }
  let packText;
  try { packText = decrypt(envelope, passphrase); }
  catch (e) { return { ok: false, error: 'Wrong passphrase — could not decrypt the pack.' }; }
  let pack;
  try { pack = JSON.parse(packText); }
  catch (e) { return { ok: false, error: 'Decrypted content is not a valid pack.' }; }
  // Success: release the envelope from the relay (best-effort).
  await lic.request('POST', '/relay/ack', { url: relayConfig(), body: { code: transferCode } }).catch(() => {});
  return {
    ok: true,
    pack,
    meta: {
      title: res.title,
      location: res.location,
      fingerprint: res.fingerprint || '',
      device: res.device,
      created_at: res.created_at,
      expires_at: res.expires_at,
      claimed: true,
    },
  };
}

module.exports = { relayConfig, generateTransferCode, encrypt, decrypt, sendPack, receivePack };