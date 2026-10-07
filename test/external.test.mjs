import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createAssistantServer, loadConfig } from '../server.mjs';
import { ExternalGate, setPassword } from '../lib/external.mjs';

test('HTTPS external access protects the shared room, preserves local access and closes with the app', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-room-'));
  const cfg = { ...loadConfig(path.join(root, 'config.json')),
    external: { enabled: true, port: 0, host: '127.0.0.1', https: true } };
  const app = createAssistantServer({ root, cfg, greetings: false,
    adapter: { available: () => ({ claude: false, gpt: false, gemini: false }) } });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const listener = await app.startExternal();
  const port = listener.address().port;
  const origin = `https://127.0.0.1:${port}`;
  const request = (route, { method = 'GET', cookie, body = '', headers = {} } = {}) => new Promise((resolve, reject) => {
    // Trust only this test's generated self-signed endpoint; production keeps browser TLS checks.
    const req = https.request(`${origin}${route}`, { method, rejectUnauthorized: false,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`)).status, 200);
  assert.equal((await request('/')).status, 303);
  assert.equal((await request('/login')).status, 200);
  for (const route of ['/api/state', '/api/history', '/api/world', '/events', '/assistant.js', '/ws/private.txt'])
    assert.equal((await request(route)).status, 401, route);
  assert.equal((await request('/api/dev/state')).status, 403);
  const password = fs.readFileSync(path.join(root, 'data/external-password.txt'), 'utf8').trim();
  const login = (pw, headers = { Origin: origin }) => request('/login', {
    method: 'POST', body: new URLSearchParams({ password: pw }).toString(), headers });
  assert.equal((await login(password, { Origin: 'null' })).status, 403);
  assert.equal((await login(password, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await login(password, {})).status, 403);
  assert.equal((await login('wrong')).status, 401);
  const signedIn = await login(password);
  assert.equal(signedIn.status, 303);
  const setCookie = signedIn.headers['set-cookie'][0];
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(setCookie.includes(flag));
  const cookie = setCookie.split(';')[0];
  assert.equal((await request('/api/state', { cookie })).status, 200);
  assert.equal((await request('/world.html', { cookie })).status, 200);
  assert.equal((await request('/api/dev/state', { cookie })).status, 403);
  assert.equal((await request('/data/external-password.txt', { cookie })).status, 404);
  assert.equal((await request('/api/room', { method: 'POST', cookie, body: '{}' })).status, 403);
  const update = await request('/api/room', { method: 'POST', cookie,
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ roomName: '휴대폰 방' }) });
  assert.equal(update.status, 200);
  assert.equal(app.room.roomName, '휴대폰 방');
  await request('/logout', { cookie });
  assert.equal((await request('/api/state', { cookie })).status, 401);
  const again = await login(password);
  const oldCookie = again.headers['set-cookie'][0].split(';')[0];
  setPassword(root, 'changed-password-for-test');
  assert.equal((await request('/api/state', { cookie: oldCookie })).status, 401);
  assert.equal((await login('changed-password-for-test')).status, 303);
  for (let n = 0; n < 5; n++) assert.equal((await login('wrong')).status, 401);
  assert.equal((await login('changed-password-for-test')).status, 429);
  await app.close();
  assert.equal(listener.listening, false);
  assert.equal(app.server.listening, false);
});

test('external access is opt-in, refuses plain HTTP, and enforces the global login lock', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-policy-'));
  const cfg = loadConfig(path.join(root, 'config.json'));
  const app = createAssistantServer({ root, cfg, greetings: false,
    adapter: { available: () => ({}) } });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(await app.startExternal(), null);
  assert.equal(fs.existsSync(path.join(root, 'data/external-auth.json')), false);
  cfg.external = { enabled: true, https: false };
  await assert.rejects(app.startExternal(), /HTTPS/);
  const gate = new ExternalGate(root);
  const now = Date.now();
  for (let n = 0; n < 30; n++) gate.noteFail(`ip-${n}`, now);
  assert.ok(gate.locked('new-ip', now));
  assert.equal(gate.locked('new-ip', now + 3600001), null);
});
