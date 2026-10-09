import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { quotaDay, nextReset, dailyLimit } from '../src/quota.js';

const SESSION_SECRET = 'test-session-secret';
const ORIGIN = 'https://agents-sdk.space';
const PNG = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');

async function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(dir)).sort()) db.exec(await readFile(new URL(name, dir), 'utf8'));
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => db.prepare(sql).run(...params)
  });
  return { raw: db, prepare: (sql) => statement(sql), batch: async (list) => { for (const s of list) await s.run(); } };
}

function b64url(value) {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function cookieFor(id, extra = {}) {
  const body = b64url(JSON.stringify({ typ: 'auth_session', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600, provider: 'google', id, email: id + '@example.com', name: id, ...extra }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = b64url(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
  return `lsuperagen_trial_session=${encodeURIComponent(`${body}.${signature}`)}`;
}

let ip = 0;
async function post(env, user, path, body, extra) {
  // A fresh IP per request keeps the in-memory burst guard out of the way; the D1 quota is per account.
  return worker.fetch(new Request(ORIGIN + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '10.9.' + Math.floor(++ip / 250) + '.' + (ip % 250), cookie: await cookieFor(user, extra) },
    body: JSON.stringify(body)
  }), env);
}

function stubOpenAI(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init ? JSON.parse(init.body) : {});
  return () => { globalThis.fetch = original; };
}
const ok = () => new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 });

test('quota day and reset follow Thai time (UTC+7)', () => {
  const lateUtc = Date.UTC(2026, 8, 28, 18, 0); // 01:00 on 29 Sep in Bangkok
  assert.equal(quotaDay(lateUtc), '2026-09-29');
  assert.equal(new Date(nextReset(lateUtc)).toISOString(), '2026-09-29T17:00:00.000Z');
  assert.equal(dailyLimit({}, 'chat'), 50);
  assert.equal(dailyLimit({ CHAT_DAILY_LIMIT: '5' }, 'chat'), 5);
  assert.equal(dailyLimit({ CHAT_DAILY_LIMIT: 'nope' }, 'chat'), 50);
});

test('an account is cut off after its daily chat limit, with a clear message and headers', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: await fakeD1(), CHAT_DAILY_LIMIT: '3' };
  const restore = stubOpenAI(ok);
  try {
    const remaining = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await post(env, 'alice', '/api/chat', { message: 'q' + i });
      assert.equal(response.status, 200);
      remaining.push(response.headers.get('x-lsuperagen-quota-remaining'));
    }
    assert.deepEqual(remaining, ['2', '1', '0']);
    const blocked = await post(env, 'alice', '/api/chat', { message: 'one more' });
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.status, 'quota_exceeded');
    assert.match(body.message, /ครบ 3 ครั้ง/);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    // Another account is unaffected.
    assert.equal((await post(env, 'bob', '/api/chat', { message: 'hi' })).status, 200);
  } finally { restore(); }
});

test('a message with attachments costs 2 units', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: await fakeD1(), CHAT_DAILY_LIMIT: '3' };
  const restore = stubOpenAI(ok);
  try {
    const response = await post(env, 'alice', '/api/chat', { message: 'ดูรูป', attachments: [{ name: 'a.png', data: PNG }] });
    assert.equal(response.headers.get('x-lsuperagen-quota-remaining'), '1');
    assert.equal((await post(env, 'alice', '/api/chat', { message: 'ดูอีกรูป', attachments: [{ name: 'b.png', data: PNG }] })).status, 429);
    assert.equal((await post(env, 'alice', '/api/chat', { message: 'ข้อความธรรมดา' })).status, 200);
  } finally { restore(); }
});

test('a failed provider call does not use up quota', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: await fakeD1(), CHAT_DAILY_LIMIT: '1' };
  let restore = stubOpenAI(() => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }));
  try {
    assert.equal((await post(env, 'alice', '/api/chat', { message: 'q' })).status, 502);
  } finally { restore(); }
  restore = stubOpenAI(() => new Response('data: ' + JSON.stringify({ type: 'response.failed', response: {} }) + '\n\n', { status: 200 }));
  try {
    const streamed = await post(env, 'alice', '/api/chat', { message: 'q', stream: true });
    assert.match(await streamed.text(), /"type":"error"/);
  } finally { restore(); }
  restore = stubOpenAI(ok);
  try {
    assert.equal((await post(env, 'alice', '/api/chat', { message: 'q' })).status, 200, 'quota was refunded twice, so this still fits');
  } finally { restore(); }
});

test('the site-wide daily cap stops everyone once reached', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: await fakeD1(), SITE_DAILY_LIMIT: '2' };
  const restore = stubOpenAI(ok);
  try {
    assert.equal((await post(env, 'alice', '/api/chat', { message: 'q' })).status, 200);
    assert.equal((await post(env, 'bob', '/api/chat', { message: 'q' })).status, 200);
    const blocked = await post(env, 'carol', '/api/chat', { message: 'q' });
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).message, /โควตารวม/);
    // Carol's own counter was rolled back when the site cap refused her.
    assert.equal(env.DB.raw.prepare("SELECT units FROM usage_counters WHERE scope LIKE 'chat:google:carol'").get().units, 0);
  } finally { restore(); }
});

test('the owner account is exempt from the daily quota', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: await fakeD1(), CHAT_DAILY_LIMIT: '1', OWNER_GOOGLE_EMAIL: 'owner@example.com' };
  const restore = stubOpenAI(ok);
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await post(env, 'owner', '/api/chat', { message: 'q' }, { email_verified: true })).status, 200);
  } finally { restore(); }
});

test('image generation has its own daily quota', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: await fakeD1(), IMAGE_DAILY_LIMIT: '1' };
  const restore = stubOpenAI((url) => url.includes('/images/')
    ? new Response(JSON.stringify({ data: [{ b64_json: 'aW1n' }] }), { status: 200 })
    : ok());
  try {
    assert.equal((await post(env, 'alice', '/api/image', { prompt: 'cat' })).status, 200);
    const blocked = await post(env, 'alice', '/api/image', { prompt: 'dog' });
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).message, /การสร้างภาพ/);
    assert.equal((await post(env, 'alice', '/api/chat', { message: 'chat still works' })).status, 200);
  } finally { restore(); }
});

test('an answer cut off at the output cap is delivered and flagged truncated', async () => {
  const env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB: await fakeD1() };
  const cut = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: 'ครึ่งแรกของคำตอบ' };
  let restore = stubOpenAI(() => new Response(
    'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'ครึ่งแรกของคำตอบ' }) + '\n\n' +
    'data: ' + JSON.stringify({ type: 'response.incomplete', response: cut }) + '\n\n', { status: 200 }));
  try {
    const events = (await (await post(env, 'alice', '/api/chat', { message: 'เขียนยาว ๆ', stream: true })).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const done = events.at(-1);
    assert.equal(done.type, 'done');
    assert.equal(done.truncated, true);
    assert.equal(done.output, 'ครึ่งแรกของคำตอบ');
  } finally { restore(); }
  restore = stubOpenAI(() => new Response(JSON.stringify(cut), { status: 200 }));
  try {
    const body = await (await post(env, 'alice', '/api/chat', { message: 'เขียนยาว ๆ' })).json();
    assert.equal(body.truncated, true);
  } finally { restore(); }
});
