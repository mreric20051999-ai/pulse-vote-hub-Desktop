// In-app "Speak to admin" messages. Officers write, admins read/reply ready.
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { audit } = require('./election');

const MAX_LEN = 2000;

function send(officerId, body) {
  const d = db.get();
  const officer = officerId
    ? d.prepare('SELECT id, name, role FROM officers WHERE id = ?').get(officerId)
    : null;
  if (!officer) return { ok: false, error: 'You must be signed in to message the admin.' };
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'Message cannot be empty.' };
  if (text.length > MAX_LEN) return { ok: false, error: `Message is too long (${MAX_LEN} characters max).` };
  const rec = {
    id: uuidv4(),
    from_officer_id: officer.id,
    from_name: officer.name,
    body: text,
    created_at: Date.now(),
    read: 0,
  };
  d.prepare(
    'INSERT INTO messages (id, from_officer_id, from_name, body, created_at, read) VALUES (@id, @from_officer_id, @from_name, @body, @created_at, @read)'
  ).run(rec);
  audit('send_message', `From ${officer.name}: ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`);
  return { ok: true, message: rec };
}

function list() {
  return db.get()
    .prepare('SELECT id, from_officer_id, from_name, body, created_at, read FROM messages ORDER BY created_at DESC')
    .all();
}

function unreadCount() {
  return db.get().prepare('SELECT COUNT(*) AS c FROM messages WHERE read = 0').get().c;
}

function markRead(id) {
  const d = db.get();
  if (id === 'all') {
    d.prepare('UPDATE messages SET read = 1 WHERE read = 0').run();
  } else if (id) {
    d.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(id);
  }
  return { ok: true };
}

// Admins may delete any message; an officer may delete only their own.
function del(id, actor) {
  const d = db.get();
  const msg = d.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!msg) return { ok: false, error: 'Message not found' };
  if (actor.role !== 'admin' && actor.id !== msg.from_officer_id) {
    return { ok: false, error: 'You can only delete your own messages' };
  }
  d.prepare('DELETE FROM messages WHERE id = ?').run(id);
  audit('delete_message', `From ${msg.from_name}: ${msg.body.slice(0, 120)}${msg.body.length > 120 ? '…' : ''}`);
  return { ok: true };
}

// Admins only: empty the whole inbox.
function clearAll(actor) {
  if (actor.role !== 'admin') return { ok: false, error: 'Admins only' };
  const n = db.get().prepare('DELETE FROM messages').run().changes;
  audit('clear_inbox', `Deleted ${n} message${n === 1 ? '' : 's'}`);
  return { ok: true, deleted: n };
}

module.exports = { send, list, markRead, unreadCount, del, clearAll };