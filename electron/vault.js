const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---- At-rest encryption for voter plaintext passwords ----
//
// Voters must be able to recover their login password on demand (printed on
// their registration slip / help-desk recovery), so the app must be able to
// turn the hash back into plaintext. Storing that plaintext directly in the
// voter row means anyone who copies the SQLite file can read every password.
//
// This module AES-256-GCM encrypts `plain_password` before it is written to
// the DB, so a leaked/copied database yields only ciphertext. The 32-byte key
// lives in a *separate* file (`pvh_vault.key`) inside the app data folder with
// owner-only permissions, so copying the DB alone is not enough.
//
// The key file holds the same secrets as the machine that runs the app; the
// threat model here is accidental DB-handoff / file copy, not an attacker who
// already owns the whole app data folder.

const VAULT_KEY_FILE = 'pvh_vault.key';
const ALGO = 'aes-256-gcm';

let cachedKey = null;

function userDataDir() {
  const { app } = require('electron');
  return app.getPath('userData');
}

function keyFilePath() {
  return path.join(userDataDir(), VAULT_KEY_FILE);
}

function loadKey() {
  if (cachedKey) return cachedKey;
  ensureUserDataDir();
  try {
    const buf = fs.readFileSync(keyFilePath());
    if (buf.length === 32) {
      cachedKey = buf;
      return cachedKey;
    }
  } catch (err) { /* fall through to generate */ }

  cachedKey = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyFilePath(), cachedKey, { mode: 0o600, flag: 'w' });
    try { fs.chmodSync(keyFilePath(), 0o600); } catch (err) { /* best effort */ }
  } catch (err) {
    console.error('vault: failed to persist key file:', err.message);
  }
  return cachedKey;
}

// Ensure the userData dir exists before first access.
function ensureUserDataDir() {
  try {
    const dir = userDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    return userDataDir();
  }
}

const PREFIX = 'pv1:';

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  // Idempotent: a value already produced by this vault (e.g. re-imported from a
  // snapshot) is passed through untouched so we never double-encrypt.
  if (typeof plaintext === 'string' && plaintext.startsWith(PREFIX)) return plaintext;
  const key = loadKey();
  ensureUserDataDir();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(ciphertext) {
  if (ciphertext === null || ciphertext === undefined || ciphertext === '') return ciphertext;
  // Plaintext that was never encrypted (e.g. older DB rows / legacy snapshots)
  // has no vault prefix and passes through unchanged.
  if (typeof ciphertext !== 'string' || !ciphertext.startsWith(PREFIX)) return ciphertext;
  const key = loadKey();
  try {
    const body = ciphertext.slice(PREFIX.length);
    const [ivB64, tagB64, dataB64] = body.split('.');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(data), decipher.final()]);
    return out.toString('utf8');
  } catch (err) {
    return ciphertext;
  }
}

module.exports = { encrypt, decrypt, loadKey, keyFilePath };