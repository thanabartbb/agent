import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const SESSION_SECRET = 'test-session-secret';
const PNG = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64');
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 fake').toString('base64');

function b64url(value) {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sessionCookie() {
  const body = b64url(JSON.stringify({ typ: 'auth_session', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600, provider: 'google', id: 'attach-user', email: 'a@example.com', name: 'A' }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = b64url(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
  return `lsuperagen_trial_session=${encodeURIComponent(`${body}.${signature}`)}`;
}

let ip = 0;
async function chat(body, env = { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET }) {
  return worker.fetch(new Request('https://agents-sdk.space/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.' + (++ip), cookie: await sessionCookie() },
    body: JSON.stringify(body)
  }), env);
}

async function capture(fn) {
  const original = globalThis.fetch;
  const payloads = [];
  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ output_text: 'เห็นรูปแล้ว' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { return { response: await fn(), payloads }; } finally { globalThis.fetch = original; }
}

test('image and PDF attachments reach the model as input_image and input_file on the current turn', async () => {
  const history = [
    { role: 'user', content: 'ก่อนหน้า' },
    { role: 'assistant', content: 'ตอบก่อนหน้า' },
    { role: 'user', content: 'ดูรูปนี้' }
  ];
  const { response, payloads } = await capture(() => chat({ messages: history, attachments: [{ name: 'cat.png', data: PNG }, { name: 'spec.pdf', data: PDF }] }));
  assert.equal(response.status, 200);
  const input = payloads[0].input;
  assert.deepEqual(input.slice(0, 2), history.slice(0, 2));
  assert.deepEqual(input[2], {
    role: 'user',
    content: [
      { type: 'input_text', text: 'ดูรูปนี้' },
      { type: 'input_image', image_url: PNG, detail: 'auto' },
      { type: 'input_file', filename: 'spec.pdf', file_data: PDF }
    ]
  });
});

test('a single message with an attachment becomes one structured user turn', async () => {
  const { payloads } = await capture(() => chat({ message: 'อธิบาย', attachments: [{ name: 'a.png', data: PNG }] }));
  assert.deepEqual(payloads[0].input, [{ role: 'user', content: [{ type: 'input_text', text: 'อธิบาย' }, { type: 'input_image', image_url: PNG, detail: 'auto' }] }]);
});

test('chat without attachments sends the same plain input as before', async () => {
  const { payloads } = await capture(() => chat({ message: 'hello' }));
  assert.equal(payloads[0].input, 'hello');
});

test('invalid attachments are rejected before any provider call', async () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(Math.ceil(5 * 1024 * 1024 * 4 / 3) + 8);
  const cases = [
    [{ name: 'x.svg', data: 'data:image/svg+xml;base64,PHN2Zz4=' }],
    [{ name: 'x.exe', data: 'data:application/octet-stream;base64,AAAA' }],
    [{ name: 'x.png', data: 'https://example.com/x.png' }],
    [{ name: 'x.png', data: 'data:image/png;base64,not base64!' }],
    [{ name: 'empty.png', data: 'data:image/png;base64,' }],
    [{ name: 'short.png', data: 'data:image/png;base64,AAAAA' }],
    [{ name: 'big.png', data: big }],
    Array.from({ length: 5 }, (_, i) => ({ name: i + '.png', data: PNG })),
    'not-an-array'
  ];
  for (const attachments of cases) {
    const { response, payloads } = await capture(() => chat({ message: 'q', attachments }));
    assert.equal(response.status, 400, JSON.stringify(attachments).slice(0, 80));
    assert.equal((await response.json()).status, 'validation_error');
    assert.equal(payloads.length, 0);
  }
});

test('attachment names are cleaned and recorded in chat history instead of file data', async () => {
  const saved = [];
  const statement = (sql, params = []) => ({ bind: (...v) => statement(sql, v), first: async () => (/RETURNING units/.test(sql) ? { units: 1 } : null), all: async () => ({ results: [] }), run: async () => saved.push({ sql, params }) });
  const DB = { prepare: (sql) => statement(sql), batch: async (list) => { for (const s of list) await s.run(); } };
  const { response } = await capture(() => chat({ message: 'ดูหน่อย', attachments: [{ name: 'bad\u0000name.png', data: PNG }] }, { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB }));
  assert.equal((await response.json()).history_saved, true);
  const userRow = saved.find((row) => /INSERT INTO messages/.test(row.sql) && row.params[1] === 'user');
  assert.equal(userRow.params[2], 'ดูหน่อย\n\n📎 badname.png');
  assert.equal(saved.some((row) => row.params.some((p) => typeof p === 'string' && p.includes('base64'))), false);
});

test('with attachments, a model that rejects image input falls back to the next model', async () => {
  const original = globalThis.fetch;
  const models = [];
  globalThis.fetch = async (_url, init) => {
    models.push(JSON.parse(init.body).model);
    if (models.length === 1) return new Response(JSON.stringify({ error: { message: 'Invalid content type. image_url is only supported by certain models.' } }), { status: 400 });
    return new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 });
  };
  try {
    const response = await chat({ message: 'ดูรูป', attachments: [{ name: 'a.png', data: PNG }] });
    assert.equal(response.status, 200);
    assert.equal(models.length, 2);
  } finally { globalThis.fetch = original; }
});

test('with attachments, a 400 that is not about image support is not retried on other models', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'Invalid base64 image data.' } }), { status: 400 });
  };
  try {
    const response = await chat({ message: 'ดูรูป', attachments: [{ name: 'a.png', data: PNG }] });
    assert.equal(response.status, 502);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('the attachment note is dropped when it would push a history turn past 12,000 characters', async () => {
  const saved = [];
  const statement = (sql, params = []) => ({ bind: (...v) => statement(sql, v), first: async () => (/RETURNING units/.test(sql) ? { units: 1 } : null), all: async () => ({ results: [] }), run: async () => saved.push({ sql, params }) });
  const DB = { prepare: (sql) => statement(sql), batch: async (list) => { for (const s of list) await s.run(); } };
  const longText = 'ก'.repeat(11995);
  await capture(() => chat({ message: longText, attachments: [{ name: 'photo.png', data: PNG }] }, { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET, DB }));
  const userRow = saved.find((row) => /INSERT INTO messages/.test(row.sql) && row.params[1] === 'user');
  assert.equal(userRow.params[2], longText);
});

test('an oversized chat body is refused with 413 before parsing or calling a provider', async () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(29 * 1024 * 1024);
  const { response, payloads } = await capture(() => chat({ message: 'q', attachments: [{ name: 'huge.png', data: huge }] }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).status, 'payload_too_large');
  assert.equal(payloads.length, 0);
});

test('invalid attachment requests count against the rate limit', async () => {
  const cookie = await sessionCookie();
  const send = () => worker.fetch(new Request('https://agents-sdk.space/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.18.0.77', cookie },
    body: JSON.stringify({ message: 'q', attachments: [{ name: 'x.svg', data: 'data:image/svg+xml;base64,PHN2Zz4=' }] })
  }), { OPENAI_API_KEY: 'k', AUTH_SESSION_SECRET: SESSION_SECRET });
  const statuses = [];
  for (let i = 0; i < 11; i += 1) statuses.push((await send()).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400));
  assert.equal(statuses[10], 429);
});
