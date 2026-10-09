// Chat history in Cloudflare D1 (binding "DB"). Every query is scoped by user_key,
// so one signed-in user can never read or delete another user's conversations.

const LIST_LIMIT = 50;
const TITLE_MAX = 80;
const ID_PATTERN = /^c_[a-f0-9]{32}$/;

export function historyEnabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

export function userKey(session) {
  return String(session.provider || 'unknown') + ':' + String(session.id || session.sub || session.email || '');
}

export function isConversationId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function newConversationId() {
  return 'c_' + crypto.randomUUID().replace(/-/g, '');
}

function titleFrom(text) {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > TITLE_MAX ? line.slice(0, TITLE_MAX - 1) + '…' : line || 'แชตใหม่';
}

export async function listConversations(env, key) {
  const { results } = await env.DB
    .prepare('SELECT id, title, updated_at FROM conversations WHERE user_key = ? ORDER BY updated_at DESC LIMIT ?')
    .bind(key, LIST_LIMIT)
    .all();
  return (results || []).map((row) => ({ id: row.id, title: row.title, updated_at: new Date(row.updated_at).toISOString() }));
}

export async function getConversation(env, key, id) {
  if (!isConversationId(id)) return null;
  const conversation = await env.DB
    .prepare('SELECT id, title, updated_at FROM conversations WHERE id = ? AND user_key = ?')
    .bind(id, key)
    .first();
  if (!conversation) return null;
  const { results } = await env.DB
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id')
    .bind(id)
    .all();
  return { id: conversation.id, title: conversation.title, updated_at: new Date(conversation.updated_at).toISOString(), messages: results || [] };
}

export async function deleteConversation(env, key, id) {
  if (!isConversationId(id)) return false;
  const owned = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_key = ?').bind(id, key).first();
  if (!owned) return false;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(id),
    env.DB.prepare('DELETE FROM conversations WHERE id = ? AND user_key = ?').bind(id, key)
  ]);
  return true;
}

// Appends one completed exchange. Uses the given conversation only if this user owns it;
// otherwise starts a new one. Returns the conversation id the exchange was saved under.
export async function saveExchange(env, key, conversationId, userText, assistantText) {
  const now = Date.now();
  let id = null;
  if (isConversationId(conversationId)) {
    const owned = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_key = ?').bind(conversationId, key).first();
    if (owned) id = owned.id;
  }
  const statements = [];
  if (id) {
    statements.push(env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND user_key = ?').bind(now, id, key));
  } else {
    id = newConversationId();
    statements.push(env.DB.prepare('INSERT INTO conversations (id, user_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, key, titleFrom(userText), now, now));
  }
  statements.push(env.DB.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').bind(id, 'user', userText, now));
  statements.push(env.DB.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').bind(id, 'assistant', assistantText, now));
  await env.DB.batch(statements);
  return id;
}
