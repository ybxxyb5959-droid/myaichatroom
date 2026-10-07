import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Sharing } from '../lib/sharing.mjs';
import { createAssistantServer, loadConfig } from '../server.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharing-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('one-use invitations, persistent identity, revocation, expiry and daily real-call quotas', (t) => {
  const root = temporary(t);
  let now = new Date(2026, 9, 8, 12).getTime();
  let sharing = new Sharing(root, () => now);
  const invite = sharing.invite('guest');
  assert.throws(() => sharing.redeem(invite.secret, '', 50, '주인'), /이름/);
  assert.throws(() => sharing.redeem(invite.secret, '방장', 50, '주인'), /다른 이름/);
  const entry = sharing.redeem(invite.secret, '친구', 50, '주인');
  assert.equal(entry.identity.role, 'guest');
  assert.equal(entry.guest.since, 50);
  assert.throws(() => sharing.redeem(invite.secret, '다른 친구', 50, '주인'), /이미 사용/);
  const req = { headers: { cookie: sharing.cookie(entry.secret, true) } };
  assert.equal(sharing.identity(req).guestId, entry.guest.id);
  assert.ok(!fs.readFileSync(sharing.file, 'utf8').includes(entry.secret));
  assert.ok(!fs.readFileSync(sharing.file, 'utf8').includes(invite.secret));
  for (let n = 0; n < 15; n++) sharing.charge(entry.guest.id);
  assert.equal(sharing.usage(entry.guest.id).total, 15);
  assert.throws(() => sharing.charge(entry.guest.id), /한도/);
  sharing = new Sharing(root, () => now);
  assert.throws(() => sharing.charge(entry.guest.id), /한도/);
  now += 86400000;
  sharing.charge(entry.guest.id);
  assert.equal(sharing.usage(entry.guest.id).total, 1);
  sharing.limits({ guestId: entry.guest.id, limit: 1 });
  assert.throws(() => sharing.charge(entry.guest.id), /한도/);
  sharing.revokeGuest(entry.guest.id);
  assert.equal(sharing.identity(req), null);
  const expired = sharing.invite('owner');
  now += 10 * 60000 + 1;
  assert.throws(() => sharing.redeem(expired.secret, '', 50, '주인'), /만료/);
  const cancelled = sharing.invite('guest');
  sharing.revokeInvite(cancelled.id);
  assert.throws(() => sharing.redeem(cancelled.secret, '친구2', 50, '주인'), /만료/);
  assert.throws(() => sharing.limits({ total: -1 }), /정수/);
});

async function fixture(t, chat) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharing-http-'));
  let now = new Date(2026, 9, 8, 12).getTime(), proxy, stopped = 0;
  const calls = [];
  const app = createAssistantServer({ root, cfg: loadConfig(path.join(root, 'config.json')), clock: () => now, autoTickMs: 3600000,
    adapter: { available: () => ({ claude: true, gpt: false, gemini: false }),
      chat: async (...args) => { calls.push(args); return chat ? chat(...args) : { ok: true, text: '친구 답변입니다.' }; } },
    tailscaleServe: async target => { proxy = target; return { url: 'https://room.example.ts.net:8443', stop: async () => { stopped++; } }; } });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${app.server.address().port}`;
  const owner = async (route, body) => {
    const res = await fetch(local + route, body === undefined ? {} : { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const connected = await owner('/api/share/connect', {});
  assert.equal(connected.status, 200);
  const remote = (route, { cookie, body, headers = {}, origin = connected.body.url, host = new URL(connected.body.url).host } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(proxy + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { Host: host, ...(origin === null ? {} : { Origin: origin }),
          ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', ...headers } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          let data = null; try { data = JSON.parse(text); } catch { /* Static document. */ }
          resolve({ status: res.statusCode, text, body: data, headers: res.headers });
        });
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const invite = async role => {
    const result = await owner('/api/share/invite', { role });
    assert.equal(result.status, 200);
    assert.ok(result.body.qr.startsWith('data:image/png;base64,'));
    assert.equal(Buffer.from(result.body.qr.split(',')[1], 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    return { ...result.body, token: new URLSearchParams(new URL(result.body.link).hash.slice(1)).get('token') };
  };
  const join = async (name, role = 'guest') => {
    const invitation = await invite(role);
    const response = await remote('/api/share/redeem', { body: { token: invitation.token, name, role: 'owner' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.role, role);
    return { invitation, cookie: response.headers['set-cookie'][0].split(';')[0] };
  };
  const wait = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), 'operation should complete');
  };
  return { app, owner, remote, invite, join, calls, wait, tick: () => { now += 1100; }, proxy: () => proxy, stopped: () => stopped };
}

test('QR and PWA document navigation preserves authentication and cross-site API protection', async (t) => {
  const f = await fixture(t);
  const headers = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const landing = await f.remote('/join', { origin: null, headers });
  assert.equal(landing.status, 200);
  assert.match(landing.text, /joinForm/);
  assert.equal(landing.headers['set-cookie'], undefined);
  assert.equal((await f.remote('/api/state', { origin: null })).status, 401);
  for (const route of ['/', '/index.html']) {
    const entry = await f.remote(route, { origin: null, headers });
    assert.equal(entry.status, 303);
    assert.equal(entry.headers.location, '/join');
  }
  for (const route of ['/api/state', '/events', '/logout']) {
    assert.equal((await f.remote(route, { origin: null, headers })).status, 403, route);
  }
  for (const overrides of [
    { 'Sec-Fetch-Mode': 'cors' },
    { 'Sec-Fetch-Dest': 'iframe' },
    { 'Sec-Fetch-Dest': 'empty' },
  ]) {
    assert.equal((await f.remote('/join', { origin: null, headers: { ...headers, ...overrides } })).status, 403);
  }
  assert.equal((await f.remote('/join', { origin: 'https://evil.example', headers })).status, 403);
  assert.equal((await f.remote('/join', { origin: null, host: 'evil.example', headers })).status, 403);
  assert.equal((await f.remote('/join', { body: {}, headers })).status, 403);
  const invitation = await f.invite('guest');
  const body = { token: invitation.token, name: 'QR 친구' };
  assert.equal((await f.remote('/api/share/redeem', { body, headers })).status, 403);
  assert.equal((await f.remote('/api/share/redeem', { body, origin: null })).status, 403);
  const redeemed = await f.remote('/api/share/redeem', { body });
  assert.equal(redeemed.status, 200);
  assert.match(redeemed.headers['set-cookie'][0], /SameSite=Lax/);
  assert.match(redeemed.headers['set-cookie'][0], /HttpOnly/);
  assert.match(redeemed.headers['set-cookie'][0], /Secure/);
  const guestCookie = redeemed.headers['set-cookie'][0].split(';')[0];
  const guestPage = await f.remote('/', { cookie: guestCookie, origin: null, headers });
  assert.equal(guestPage.status, 200);
  assert.match(guestPage.text, /guestForm/);
  assert.equal((await f.remote('/api/share', { cookie: guestCookie })).status, 403);
  const { cookie } = await f.join('', 'owner');
  for (const route of ['/', '/index.html']) {
    const page = await f.remote(route, { cookie, origin: null, headers });
    assert.equal(page.status, 200);
    assert.match(page.text, /shareBtn/);
  }
  for (const route of ['/api/send', '/api/room']) {
    assert.equal((await f.remote(route, { cookie, body: {}, headers })).status, 403, route);
  }
});

test('HTTPS proxy authenticates before room data, isolates guest permissions and exposes no secrets through SSE', async (t) => {
  const f = await fixture(t);
  f.app.store.addMessage({ from: 'user', text: '입장 전 비공개 기록' });
  f.app.store.writeNote('claude', '소유자 개인 메모 비밀');
  assert.equal((await f.remote('/api/state')).status, 401);
  assert.equal((await f.remote('/events')).status, 401);
  const landing = await f.remote('/join');
  assert.equal(landing.status, 200);
  assert.match(landing.text, /이름이 무엇인가요/);
  const { cookie, invitation } = await f.join('민수');
  assert.equal((await f.remote('/api/share/redeem', { body: { token: invitation.token, name: '다른사람' } })).status, 401);
  for (const route of ['/api/share', '/api/notes', '/api/models', '/api/file?path=test.txt', '/ws/test.txt', '/api/world'])
    assert.equal((await f.remote(route, { cookie })).status, 403, route);
  for (const route of ['/api/room', '/api/check/call', '/api/cancel', '/api/share/invite', '/api/share/connect'])
    assert.equal((await f.remote(route, { cookie, body: {} })).status, 403, route);
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '안녕' }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '안녕' }, origin: null })).status, 403);
  assert.equal((await f.remote('/api/state', { cookie, host: 'evil.example' })).status, 403);
  const state = await f.remote('/api/state', { cookie });
  assert.equal(state.body.role, 'guest');
  assert.ok(!state.text.includes('입장 전 비공개'));
  assert.ok(!state.text.includes('개인 메모'));
  assert.equal(state.body.room, undefined);
  const guestPage = await f.remote('/', { cookie });
  assert.match(guestPage.text, /guestForm/);
  assert.ok(!guestPage.text.includes('shareBtn'));
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '사람끼리 대화' } })).status, 200);
  assert.equal(f.calls.length, 0);
  assert.equal(f.app.store.messages.at(-1).displayName, '민수');
  assert.equal(f.app.runtime.store.recent(100).some(m => m.guestId), false);
  const ownerMobile = await f.join('', 'owner');
  assert.equal((await f.remote('/api/share', { cookie: ownerMobile.cookie })).status, 200);
  assert.match((await f.remote('/', { cookie: ownerMobile.cookie })).text, /shareBtn/);
  const guestId = (await f.owner('/api/share')).body.guests[0].id;
  const streamEnded = new Promise((resolve, reject) => {
    const req = http.get(f.proxy() + '/events', { headers: { Host: 'room.example.ts.net:8443', Cookie: cookie } }, res => {
      let first = true;
      res.on('data', chunk => {
        const text = chunk.toString();
        assert.ok(!text.includes('個人') && !text.includes('個人メモ') && !text.includes('소유자 개인 메모'));
        if (first) { first = false; f.owner('/api/share/revoke-guest', { id: guestId }).catch(reject); }
      });
      res.on('end', resolve); res.on('error', reject);
    });
    req.on('error', reject);
  });
  await streamEnded;
  assert.equal((await f.remote('/api/state', { cookie })).status, 401);
  await f.remote('/logout', { cookie: ownerMobile.cookie });
  assert.equal((await f.remote('/api/share', { cookie: ownerMobile.cookie })).status, 401);
});

test('friend total 15 limits actual calls, survives restart, rejects unmetered features, and leaves human chat usable', async (t) => {
  const f = await fixture(t);
  const { cookie } = await f.join('수진');
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '그림', image: {}, askAI: true } })).status, 403);
  for (let n = 1; n <= 15; n++) {
    f.tick();
    const response = await f.remote('/api/send', { cookie, body: { text: `질문 ${n}`, askAI: true, ai: 'claude' } });
    assert.equal(response.status, 200);
    await f.wait(() => f.calls.length === n && f.app.store.messages.at(-1).from === 'claude');
  }
  f.tick();
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '한도 초과', askAI: true } })).status, 429);
  assert.equal(f.calls.length, 15);
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '대화는 계속' } })).status, 200);
  assert.equal(f.calls.length, 15);
  for (const [, , , options] of f.calls) {
    assert.equal(options.boost, false); assert.equal(options.webSearch, false); assert.equal(options.independent, true);
  }
  const admin = (await f.owner('/api/share')).body;
  assert.equal(admin.usage.total, 15);
  const disk = new Sharing(path.dirname(path.dirname(f.app.store.stateFile)));
  assert.equal(Object.values(disk.data.usage)[0].total, 15);
  const friend2 = await f.join('현우');
  assert.equal((await f.remote('/api/send', { cookie: friend2.cookie, body: { text: '다른 친구도 한도 공유', askAI: true } })).status, 429);
  await f.owner('/api/share/limits', { total: 16, guestId: admin.guests[0].id, limit: 16 });
  f.tick();
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '한도 변경 뒤', askAI: true } })).status, 200);
  await f.wait(() => f.calls.length === 16);
  await f.app.close();
  assert.equal(f.stopped(), 1);
});

test('failed and cancelled guest calls are charged once, with no late response after revocation', async (t) => {
  let resolveCall;
  const f = await fixture(t, (_id, _brief, _prompt, options) => new Promise(resolve => {
    resolveCall = resolve;
    options.signal.addEventListener('abort', () => resolve({ ok: true, text: '늦게 온 답변' }), { once: true });
  }));
  const { cookie } = await f.join('지연');
  await f.remote('/api/send', { cookie, body: { text: '실패할 질문', askAI: true } });
  await f.wait(() => !!resolveCall);
  resolveCall({ ok: false, detail: 'quota' });
  await f.wait(() => f.app.store.messages.at(-1).kind === 'error');
  assert.equal((await f.owner('/api/share')).body.usage.total, 1);
  f.tick(); resolveCall = null;
  await f.remote('/api/send', { cookie, body: { text: '취소할 질문', askAI: true } });
  await f.wait(() => !!resolveCall);
  const admin = (await f.owner('/api/share')).body;
  await f.owner('/api/share/revoke-guest', { id: admin.guests[0].id });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls.length, 2);
  assert.equal((await f.owner('/api/share')).body.usage.total, 2);
  assert.ok(!f.app.store.messages.some(m => m.text === '늦게 온 답변'));
});

test('PWA metadata and icons are public but service worker does not cache private API responses', async (t) => {
  const f = await fixture(t);
  const manifest = (await f.remote('/manifest.webmanifest')).body;
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.start_url, '/');
  assert.deepEqual(manifest.icons.map(i => i.sizes), ['192x192', '512x512']);
  for (const icon of manifest.icons) assert.equal((await f.remote(icon.src)).status, 200);
  const sw = await f.remote('/sw.js');
  assert.equal(sw.headers['service-worker-allowed'], '/');
  assert.equal((await f.remote('/offline.html')).status, 200);
  assert.equal((await f.remote('/api/history')).status, 401);
});
