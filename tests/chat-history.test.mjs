import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

const SESSION_SECRET = 'test-session-secret';
const ORIGIN = 'https://agents-sdk.space';

// Minimal D1 stand-in backed by real SQLite, running the real migration.
async function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../migrations/0001_chat_history.sql', import.meta.url), 'utf8'));
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => db.prepare(sql).run(...params)
  });
  return {
    raw: db,
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try { for (const s of statements) await s.run(); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
    }
  };
}

function b64url(value) {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function cookieFor(id) {
  const body = b64url(JSON.stringify({ typ: 'auth_session', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600, provider: 'google', id, email: id + '@example.com', name: id }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = b64url(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
  return `lsuperagen_trial_session=${encodeURIComponent(`${body}.${signature}`)}`;
}

async function call(env, user, path, { method = 'GET', body } = {}) {
  const headers = { 'cf-connecting-ip': '198.51.100.' + (user === 'alice' ? 1 : 2), origin: ORIGIN };
  if (user) headers.cookie = await cookieFor(user);
  if (body) headers['content-type'] = 'application/json';
  return worker.fetch(new Request(ORIGIN + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
}

async function withOpenAI(answer, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: answer }), { status: 200, headers: { 'content-type': 'application/json' } });
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test('a finished chat is saved under the signed-in user and continues in the same conversation', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: await fakeD1() };
  const first = await withOpenAI('สวัสดีครับ', async () => (await call(env, 'alice', '/api/chat', { method: 'POST', body: { message: 'สวัสดี' } })).json());
  assert.equal(first.ok, true);
  assert.equal(first.history_saved, true);
  assert.match(first.conversation_id, /^c_[a-f0-9]{32}$/);

  const second = await withOpenAI('ได้เลย', async () => (await call(env, 'alice', '/api/chat', { method: 'POST', body: { message: 'ช่วยหน่อย', conversation_id: first.conversation_id } })).json());
  assert.equal(second.conversation_id, first.conversation_id);

  const list = await (await call(env, 'alice', '/api/chats')).json();
  assert.equal(list.conversations.length, 1);
  assert.equal(list.conversations[0].title, 'สวัสดี');

  const detail = await (await call(env, 'alice', '/api/chats/' + first.conversation_id)).json();
  assert.deepEqual(detail.conversation.messages, [
    { role: 'user', content: 'สวัสดี' },
    { role: 'assistant', content: 'สวัสดีครับ' },
    { role: 'user', content: 'ช่วยหน่อย' },
    { role: 'assistant', content: 'ได้เลย' }
  ]);
});

test('streamed chats report the saved conversation id in the done event', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: await fakeD1() };
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output_text: 'hi' } })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const response = await call(env, 'alice', '/api/chat', { method: 'POST', body: { message: 'hello', stream: true } });
    const events = (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const done = events.find((e) => e.type === 'done');
    assert.equal(done.history_saved, true);
    assert.match(done.conversation_id, /^c_/);
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
  } finally { globalThis.fetch = original; }
});

test('one user can never read, continue, or delete another user\'s conversation', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: await fakeD1() };
  const alice = await withOpenAI('secret answer', async () => (await call(env, 'alice', '/api/chat', { method: 'POST', body: { message: 'my secret' } })).json());

  assert.equal((await call(env, 'bob', '/api/chats/' + alice.conversation_id)).status, 404);
  assert.equal((await call(env, 'bob', '/api/chats/' + alice.conversation_id, { method: 'DELETE' })).status, 404);
  assert.deepEqual((await (await call(env, 'bob', '/api/chats')).json()).conversations, []);

  // Bob passing Alice's id starts his own conversation instead of appending to hers.
  const bob = await withOpenAI('hi bob', async () => (await call(env, 'bob', '/api/chat', { method: 'POST', body: { message: 'hi', conversation_id: alice.conversation_id } })).json());
  assert.notEqual(bob.conversation_id, alice.conversation_id);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(alice.conversation_id).n, 2);
});

test('deleting a conversation removes it and its messages', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: await fakeD1() };
  const saved = await withOpenAI('a', async () => (await call(env, 'alice', '/api/chat', { method: 'POST', body: { message: 'q' } })).json());
  const response = await call(env, 'alice', '/api/chats/' + saved.conversation_id, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
});

test('history routes require login, reject cross-origin deletes, and report 503 without a database', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: await fakeD1() };
  assert.equal((await call(env, null, '/api/chats')).status, 401);
  const crossOrigin = new Request(ORIGIN + '/api/chats/c_' + '0'.repeat(32), { method: 'DELETE', headers: { cookie: await cookieFor('alice'), origin: 'https://evil.example' } });
  assert.equal((await worker.fetch(crossOrigin, env)).status, 403);
  assert.equal((await call({ AUTH_SESSION_SECRET: SESSION_SECRET }, 'alice', '/api/chats')).status, 503);
});

test('chat still answers without a database and does not claim history was saved', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET };
  const result = await withOpenAI('ok', async () => (await call(env, 'alice', '/api/chat', { method: 'POST', body: { message: 'q' } })).json());
  assert.equal(result.ok, true);
  assert.equal('conversation_id' in result, false);
  assert.equal('history_saved' in result, false);
});

test('a storage failure never hides a real answer', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: { prepare() { throw new Error('d1 down'); }, batch() { throw new Error('d1 down'); } } };
  const result = await withOpenAI('real answer', async () => (await call(env, 'alice', '/api/chat', { method: 'POST', body: { message: 'q' } })).json());
  assert.equal(result.ok, true);
  assert.equal(result.output, 'real answer');
  assert.equal(result.history_saved, false);
});
