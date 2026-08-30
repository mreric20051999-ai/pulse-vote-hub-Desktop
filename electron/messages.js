// In-app "Speak to admin" messages. Officers write to the admin; the admin can
// reply, forming a thread (root message + reply_to_id replies). Messages sync
// over LAN like votes, so replies reach officers on connected devices.
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { audit } = require('./election');

const MAX_LEN = 2000;

const COLS = 'id, from_officer_id, from_name, from_officer, to_officer, to_officer_name, reply_to_id, body, created_at, read';

function officerOf(d, id) {
  return id ? d.prepare('SELECT id, name, role, officer_id FROM officers WHERE id = ?').get(id) : null;
}

function normalizeText(body) {
  const text = String(body || '').trim();
  if (!text) return { error: 'Message cannot be empty.' };
  if (text.length > MAX_LEN) return { error: `Message is too long (${MAX_LEN} characters max).` };
  return { text };
}

function insert(d, rec) {
  d.prepare(`
    INSERT INTO messages (id, from_officer_id, from_name, from_officer, to_officer, to_officer_name, reply_to_id, body, created_at, read)
    VALUES (@id, @from_officer_id, @from_name, @from_officer, @to_officer, @to_officer_name, @reply_to_id, @body, @created_at, @read)
  `).run(rec);
}

function send(officerId, body) {
  const d = db.get();
  const officer = officerOf(d, officerId);
  if (!officer) return { ok: false, error: 'You must be signed in to message the admin.' };
  const chk = normalizeText(body);
  if (chk.error) return { ok: false, error: chk.error };
  const rec = {
    id: uuidv4(),
    from_officer_id: officer.id,
    from_name: officer.name,
    from_officer: officer.officer_id,
    to_officer: null,
    to_officer_name: null,
    reply_to_id: null,
    body: chk.text,
    created_at: Date.now(),
    read: 0,
  };
  insert(d, rec);
  audit('send_message', `From ${officer.name}: ${chk.text.slice(0, 120)}${chk.text.length > 120 ? '…' : ''}`);
  return { ok: true, message: rec };
}

// Admin replies to an existing officer message, opening a thread. The reply is
// addressed to the original sender (by login id + name) so it can be matched on
// other machines where internal officer ids differ.
function replyTo(msgId, actor, body) {
  const d = db.get();
  const admin = officerOf(d, actor && actor.id);
  if (!admin || admin.role !== 'admin') return { ok: false, error: 'Admins only' };
  const root = d.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  if (!root) return { ok: false, error: 'Message not found' };
  const chk = normalizeText(body);
  if (chk.error) return { ok: false, error: chk.error };
  let toOfficer = root.from_officer;
  if (!toOfficer) {
    const sender = officerOf(d, root.from_officer_id);
    toOfficer = sender ? sender.officer_id : null;
  }
  const rec = {
    id: uuidv4(),
    from_officer_id: admin.id,
    from_name: admin.name,
    from_officer: admin.officer_id,
    to_officer: toOfficer,
    to_officer_name: root.from_name,
    reply_to_id: msgId,
    body: chk.text,
    created_at: Date.now(),
    read: 0,
  };
  insert(d, rec);
  if (!root.reply_to_id) {
    d.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(msgId);
  }
  audit('reply_message', `Admin → ${toOfficer || root.from_name}: ${chk.text.slice(0, 120)}${chk.text.length > 120 ? '…' : ''}`);
  return { ok: true, message: rec };
}

function rows(d, where, params) {
  return d.prepare(`SELECT ${COLS} FROM messages ${where} ORDER BY created_at ASC`).all(params);
}

// Admin inbox: every message (officer notes and their own replies) newest first.
function list() {
  const d = db.get();
  return d.prepare(`SELECT ${COLS} FROM messages ORDER BY created_at DESC`).all();
}

// One officer's conversation: their own notes plus replies addressed to them.
function listMine(officerId) {
  const d = db.get();
  const officer = officerOf(d, officerId);
  if (!officer) return [];
  return rows(d, 'WHERE from_officer = ? OR to_officer = ?', [officer.officer_id, officer.officer_id]);
}

// Admin unread: incoming officer notes only (not their own replies).
function unreadCount() {
  return db.get().prepare('SELECT COUNT(*) AS c FROM messages WHERE read = 0 AND to_officer IS NULL').get().c;
}

// Officer unread: replies addressed to them.
function unreadMine(officerId) {
  const d = db.get();
  const officer = officerOf(d, officerId);
  if (!officer) return 0;
  return d.prepare('SELECT COUNT(*) AS c FROM messages WHERE read = 0 AND to_officer = ?').get(officer.officer_id).c;
}

// Admin marks incoming notes (or all of them) read.
function markRead(id) {
  const d = db.get();
  if (id === 'all') {
    d.prepare('UPDATE messages SET read = 1 WHERE to_officer IS NULL AND read = 0').run();
  } else if (id) {
    d.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(id);
  }
  return { ok: true };
}

// Officer marks replies addressed to them read.
function markMineRead(officerId) {
  const d = db.get();
  const officer = officerOf(d, officerId);
  if (!officer) return { ok: true, updated: 0 };
  const r = d.prepare('UPDATE messages SET read = 1 WHERE to_officer = ? AND read = 0').run(officer.officer_id);
  return { ok: true, updated: r.changes };
}

// Admins may delete any message; an officer may delete their own and the
// replies addressed to them.
function del(id, actor) {
  const d = db.get();
  const msg = d.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!msg) return { ok: false, error: 'Message not found' };
  const o = officerOf(d, actor && actor.id);
  if (actor.role !== 'admin' && !(o && (o.officer_id === msg.from_officer || o.officer_id === msg.to_officer))) {
    return { ok: false, error: 'You can only delete your own messages' };
  }
  d.prepare('DELETE FROM messages WHERE id = ?').run(id);
  audit('delete_message', `From ${msg.from_name}: ${msg.body.slice(0, 120)}${msg.body.length > 120 ? '…' : ''}`);
  return { ok: true };
}

// Admins only: empty the whole inbox.
function clearAll(actor) {
  if (!actor || actor.role !== 'admin') return { ok: false, error: 'Admins only' };
  const n = db.get().prepare('DELETE FROM messages').run().changes;
  audit('clear_inbox', `Deleted ${n} message${n === 1 ? '' : 's'}`);
  return { ok: true, deleted: n };
}

module.exports = { send, replyTo, list, listMine, markRead, markMineRead, unreadCount, unreadMine, del, clearAll };