import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

const SESSION_SECRET = 'test-session-secret';
const ORIGIN = 'https://agents-sdk.space';
const PNG = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4').toString('base64');
const BASE_ENV = { OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a-key', AUTH_SESSION_SECRET: SESSION_SECRET };

function b64url(value) {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function cookie(id = 'claude-user') {
  const body = b64url(JSON.stringify({ typ: 'auth_session', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600, provider: 'google', id, email: id + '@example.com', name: id }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = b64url(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
  return `lsuperagen_trial_session=${encodeURIComponent(`${body}.${signature}`)}`;
}

let ip = 0;
async function chat(body, env = BASE_ENV) {
  return worker.fetch(new Request(ORIGIN + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.77.0.' + (++ip), cookie: await cookie() },
    body: JSON.stringify(body)
  }), env);
}

function stub(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return handler(String(url), JSON.parse(init.body));
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const ndjson = async (response) => (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));

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

test('/api/chat-providers lists only providers with a configured key, and needs login', async () => {
  const list = async (env) => (await worker.fetch(new Request(ORIGIN + '/api/chat-providers', { headers: { cookie: await cookie() } }), env)).json();
  assert.deepEqual((await list(BASE_ENV)).providers.map((p) => [p.id, p.available]), [['openai', true], ['claude', true]]);
  assert.deepEqual((await list({ OPENAI_API_KEY: 'o', AUTH_SESSION_SECRET: SESSION_SECRET })).providers.map((p) => [p.id, p.available]), [['openai', true], ['claude', false]]);
  const anonymous = await worker.fetch(new Request(ORIGIN + '/api/chat-providers'), BASE_ENV);
  assert.equal(anonymous.status, 401);
  assert.equal(JSON.stringify(await list(BASE_ENV)).includes('a-key'), false, 'key value never exposed');
});

test('provider claude calls the Messages API with the key, version header, default model and fallbacks', async () => {
  const { calls, restore } = stub(() => new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'สวัสดีจาก Claude' }], stop_reason: 'end_turn' }), { status: 200 }));
  try {
    const response = await chat({ message: 'hello', provider: 'claude' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.output, 'สวัสดีจาก Claude');
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call.headers['x-api-key'], 'a-key');
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    assert.equal(call.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.equal(call.body.model, 'claude-opus-5-5');
    assert.equal(call.body.fallbacks, 'default');
    assert.equal(call.body.output_config.effort, 'medium');
    assert.equal(typeof call.body.system, 'string');
    assert.deepEqual(call.body.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal('thinking' in call.body, false);
  } finally { restore(); }
});

test('without provider the request still goes to OpenAI', async () => {
  const { calls, restore } = stub(() => new Response(JSON.stringify({ output_text: 'openai' }), { status: 200 }));
  try {
    await chat({ message: 'hello' });
    assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  } finally { restore(); }
});

test('attachments become Claude image and document blocks placed before the text', async () => {
  const { calls, restore } = stub(() => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { status: 200 }));
  try {
    const history = [{ role: 'user', content: 'ก่อน' }, { role: 'assistant', content: 'ตอบ' }, { role: 'user', content: 'ดูไฟล์' }];
    await chat({ messages: history, provider: 'claude', attachments: [{ name: 'a.png', data: PNG }, { name: 'b.pdf', data: PDF }] });
    const messages = calls[0].body.messages;
    assert.deepEqual(messages.slice(0, 2), history.slice(0, 2));
    assert.deepEqual(messages[2], {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.split(',')[1] } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF.split(',')[1] } },
        { type: 'text', text: 'ดูไฟล์' }
      ]
    });
  } finally { restore(); }
});

test('streamed Claude answers relay text deltas and flag an answer cut at max_tokens', async () => {
  const { restore } = stub(() => sse([
    { type: 'message_start', message: { id: 'msg_1' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ครึ่ง' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'แรก' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
    { type: 'message_stop' }
  ]));
  try {
    const events = await ndjson(await chat({ message: 'เขียนยาว', provider: 'claude', stream: true }));
    assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text), ['ครึ่ง', 'แรก']);
    const done = events.at(-1);
    assert.equal(done.type, 'done');
    assert.equal(done.output, 'ครึ่งแรก');
    assert.equal(done.truncated, true);
  } finally { restore(); }
});

test('a Claude refusal is reported as an error, never as an answer, and refunds quota', async () => {
  const env = { ...BASE_ENV, DB: await fakeD1(), CHAT_DAILY_LIMIT: '1' };
  let restore = stub(() => sse([
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    { type: 'message_delta', delta: { stop_reason: 'refusal' } },
    { type: 'message_stop' }
  ])).restore;
  try {
    const events = await ndjson(await chat({ message: 'q', provider: 'claude', stream: true }, env));
    assert.equal(events.at(-1).type, 'error');
    assert.equal(events.at(-1).status, 'refused');
    assert.equal(events.some((e) => e.type === 'done'), false);
  } finally { restore(); }
  restore = stub(() => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { status: 200 })).restore;
  try {
    assert.equal((await chat({ message: 'q', provider: 'claude' }, env)).status, 200, 'refused request did not use up the 1-message quota');
  } finally { restore(); }
});

test('Claude errors fail cleanly: missing key 503, unknown provider 400, web modes 400, provider error 502', async () => {
  assert.equal((await chat({ message: 'q', provider: 'claude' }, { OPENAI_API_KEY: 'o', AUTH_SESSION_SECRET: SESSION_SECRET })).status, 503);
  assert.equal((await chat({ message: 'q', provider: 'gemini' })).status, 400);
  assert.equal((await chat({ message: 'q', provider: 'claude', tool: 'research' })).status, 400);
  const { restore } = stub(() => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }), { status: 400 }));
  try {
    const response = await chat({ message: 'q', provider: 'claude' });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).ok, false);
  } finally { restore(); }
});

test('ANTHROPIC_MODEL overrides the model; fallbacks are only sent for models that support them', async () => {
  const { calls, restore } = stub(() => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { status: 200 }));
  try {
    await chat({ message: 'q', provider: 'claude' }, { ...BASE_ENV, ANTHROPIC_MODEL: 'claude-sonnet-5-5' });
    await chat({ message: 'q', provider: 'claude' }, { ...BASE_ENV, ANTHROPIC_MODEL: 'claude-haiku-4-5' });
    assert.equal(calls[0].body.model, 'claude-sonnet-5-5');
    assert.equal(calls[0].body.fallbacks, 'default');
    assert.equal(calls[1].body.model, 'claude-haiku-4-5');
    assert.equal('fallbacks' in calls[1].body, false);
    assert.equal('anthropic-beta' in calls[1].headers, false);
    assert.equal('output_config' in calls[1].body, false);
  } finally { restore(); }
});
