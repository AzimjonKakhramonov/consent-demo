import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp, resolveConfig } from '../server.js';

// Synthetic transport fixture, not a real photograph or personal location.
const draft = { consent: true, photo: 'data:image/jpeg;base64,/9j/2Q==', location: { latitude: 0, longitude: 0, accuracy: 1 } };
// Use node:http for proxy fixtures: fetch does not preserve a custom Host here.
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
async function fixture(t, config = {}) {
  const calls = [];
  const app = createApp({ token: 'test-' + 'placeholder', chatId: 'test-chat', telegramFetch: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true }) };
  }, ...config });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => request(`${base}/api/check-in`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  return { base, post, calls };
}

test('page load is local; .env cannot be served; no Telegram call', async (t) => {
  const { base, calls } = await fixture(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Отправить фото и координаты/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal(calls.length, 0);
});
test('requires true consent, valid coordinates and bounded JPEG', async (t) => {
  const { post, calls } = await fixture(t);
  for (const invalid of [ {}, { ...draft, consent: false }, { ...draft, consent: 'true' }, { ...draft, location: { ...draft.location, latitude: 91 } }, { ...draft, location: { ...draft.location, longitude: '0' } }, { ...draft, photo: 'data:image/jpeg;base64,aGVsbG8=' }, { ...draft, photo: 'data:image/png;base64,/9j/2Q==' } ]) {
    assert.equal((await post(invalid)).status, 400);
  }
  assert.equal(calls.length, 0);
});
test('rejects cross-origin requests and unexpected hosts', async (t) => {
  const { post, base, calls } = await fixture(t);
  assert.equal((await post(draft, { Origin: 'https://example.invalid' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(base, { headers: { Host: 'example.invalid' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal(calls.length, 0);
});
test('missing configuration returns 503 without network', async (t) => {
  const { post, calls } = await fixture(t, { token: '', chatId: '' });
  assert.equal((await post(draft)).status, 503);
  assert.equal(calls.length, 0);
});
test('one explicit request sends photo and coordinates together', async (t) => {
  const { post, calls } = await fixture(t);
  const response = await post(draft);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/sendPhoto'));
  assert.equal(calls[0].options.body.get('photo').type, 'image/jpeg');
  assert.match(calls[0].options.body.get('caption'), /Широта: 0\nДолгота: 0/);
  assert.equal(calls[0].options.body.get('chat_id'), 'test-chat');
});
test('upstream failure is redacted and never automatically retried', async (t) => {
  let calls = 0;
  const { post } = await fixture(t, { telegramFetch: async () => { calls++; throw new Error('sensitive-upstream-details'); } });
  const response = await post(draft);
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.doesNotMatch(body, /sensitive-upstream-details|test-placeholder/);
  assert.match(body, /могло дойти/);
  assert.equal(calls, 1);
});
test('oversized or malformed JSON fails without transport', async (t) => {
  const { base, post, calls } = await fixture(t);
  assert.equal((await post({ ...draft, photo: 'x'.repeat(3 * 1024 * 1024) })).status, 413);
  assert.equal((await fetch(`${base}/api/check-in`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal(calls.length, 0);
});

test('Render reads its environment; local runs ignore inherited bot credentials', () => {
  const environment = { RENDER: 'true', PORT: '10000', RENDER_EXTERNAL_URL: 'https://demo.onrender.com', TELEGRAM_BOT_TOKEN: 'render-' + 'placeholder', TELEGRAM_CHAT_ID: 'render-chat' };
  assert.deepEqual(resolveConfig(environment), { port: 10000, host: '0.0.0.0', publicOrigin: 'https://demo.onrender.com', token: 'render-' + 'placeholder', chatId: 'render-chat' });
  assert.deepEqual(resolveConfig({ ...environment, RENDER: '' }, { PORT: '3001' }), { port: 3001, host: '127.0.0.1', publicOrigin: '', token: '', chatId: '' });
  for (const url of ['', 'http://demo.onrender.com', 'https://demo.onrender.com/path', 'https://demo.onrender.com?x=1', 'https://user:pass@demo.onrender.com']) {
    assert.throws(() => resolveConfig({ ...environment, RENDER_EXTERNAL_URL: url }));
  }
  for (const port of ['-1', '0', '65536', 'NaN', '3.5']) assert.throws(() => resolveConfig({ ...environment, PORT: port }));
});

const publicOrigin = 'https://demo.onrender.com';
const publicHeaders = { Host: 'demo.onrender.com', Origin: publicOrigin };
test('Render accepts exact HTTPS origin behind proxy and rejects forged hosts/origins', async (t) => {
  const { post, base, calls } = await fixture(t, { publicOrigin });
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await request(base, { headers: { Host: publicHeaders.Host } })).status, 200);
  assert.equal((await request(`${base}/.env`, { headers: { Host: publicHeaders.Host } })).status, 404);
  for (const headers of [
    { ...publicHeaders, Origin: 'http://demo.onrender.com' },
    { ...publicHeaders, Origin: 'https://demo.onrender.com.attacker.invalid' },
    { ...publicHeaders, Origin: 'null' },
    { ...publicHeaders, Host: 'attacker.invalid', 'X-Forwarded-Host': publicHeaders.Host },
    { ...publicHeaders, Host: 'localhost' },
  ]) assert.equal((await post(draft, headers)).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await post(draft, publicHeaders)).status, 200);
  assert.equal(calls.length, 1);
});

test('public send budget throttles after ten attempts and resets after a minute', async (t) => {
  let time = 1000;
  const { post, calls } = await fixture(t, { publicOrigin, now: () => time });
  for (let i = 0; i < 10; i++) assert.equal((await post(draft, publicHeaders)).status, 200);
  const blocked = await post(draft, publicHeaders);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal(calls.length, 10);
  time += 60000;
  assert.equal((await post(draft, publicHeaders)).status, 200);
  assert.equal(calls.length, 11);
});
