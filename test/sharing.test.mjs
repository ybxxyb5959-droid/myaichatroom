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
  for (let n = 0; n < 100; n++) sharing.charge(entry.guest.id);
  assert.equal(sharing.usage(entry.guest.id).total, 100);
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

async function fixture(t, chat, { ids = ['claude'], pushSend = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharing-http-'));
  let now = new Date(2026, 9, 8, 12).getTime(), proxy, stopped = 0;
  const calls = [];
  const tunnel = async target => { proxy = target; return { url: 'https://room.example.ts.net:8443', stop: async () => { stopped++; } }; };
  const app = createAssistantServer({ root, cfg: loadConfig(path.join(root, 'config.json')), clock: () => now, autoTickMs: 3600000,
    adapter: { available: () => Object.fromEntries(['claude', 'gpt', 'gemini'].map(id => [id, ids.includes(id)])),
      chat: async (...args) => { calls.push(args); return chat ? chat(...args) : { ok: true, text: '친구 답변입니다.' }; } },
    tailscaleServe: tunnel, tailscaleFunnel: tunnel, pushSend });
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
    let response = await remote('/api/share/redeem', { body: { token: invitation.token, name, role: 'owner' } });
    if (role === 'owner') {
      assert.equal(response.status, 202);
      const pending = await owner('/api/share/pairing');
      await owner('/api/share/pairing', { id: pending.body.requests[0].id, approve: true });
      response = await remote('/api/share/pair-status', { body: { token: invitation.token, challenge: response.body.challenge } });
    }
    assert.equal(response.status, 200);
    assert.equal(response.body.role, role);
    return { invitation, cookie: response.headers['set-cookie'][0].split(';')[0] };
  };
  const wait = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), 'operation should complete');
  };
  return { app, local, owner, remote, invite, join, calls, wait, tick: (ms = 1100) => { now += ms; },
    start: () => owner('/api/room', { auto: { on: true, sleepMinutes: 0 } }),
    pump: (ms = 15001) => { now += ms; return app.tickGuestReplies(); },
    proxy: () => proxy, stopped: () => stopped };
}

test('QR and PWA document navigation preserves authentication and cross-site API protection', async (t) => {
  const f = await fixture(t);
  const headers = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const landing = await f.remote('/join', { origin: null, headers });
  assert.equal(landing.status, 200);
  assert.match(landing.text, /joinForm/);
  assert.equal(landing.headers['set-cookie'], undefined);
  const workerHeaders = { ...headers, 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' };
  assert.equal((await f.remote('/join', { origin: null, headers: workerHeaders })).status, 200);
  assert.equal((await f.remote('/', { origin: null, headers: workerHeaders })).status, 303);
  assert.equal((await f.remote('/api/state', { origin: null, headers: workerHeaders })).status, 403);
  const mobileHeaders = { ...headers, 'Sec-Fetch-Dest': 'empty' };
  assert.equal((await f.remote('/join', { origin: null, headers: mobileHeaders })).status, 200);
  assert.equal((await f.remote('/', { origin: null, headers: mobileHeaders })).status, 303);
  assert.equal((await f.remote('/api/state', { origin: null, headers: mobileHeaders })).status, 403);
  assert.equal((await f.remote('/api/share/redeem', { body: {}, headers: mobileHeaders })).status, 403);
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
  assert.match(guestPage.text, /data-role="guest"/); assert.match(guestPage.text, /id="input"/);
  assert.equal((await f.remote('/api/share', { cookie: guestCookie })).status, 403);
  const otherFriend = await f.join('남아 있는 친구');
  const left = await f.remote('/logout', { cookie: guestCookie });
  assert.equal(left.status, 303);
  assert.equal(left.headers.location, '/join');
  assert.match(left.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await f.remote('/api/state', { cookie: guestCookie })).status, 401);
  assert.equal((await f.remote('/api/state', { cookie: otherFriend.cookie })).status, 200);
  assert.equal((await f.owner('/api/state')).status, 200);
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
    assert.match(landing.text, /id="joinName"[^>]*required/);
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
  assert.match(guestPage.text, /data-role="guest"/); assert.match(guestPage.text, /id="input"/);
  assert.match(guestPage.text, /room-ui.mjs/);
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '사람끼리 대화' } })).status, 200);
  assert.equal(f.calls.length, 0);
  assert.equal(f.app.store.messages.at(-1).displayName, '민수');
  assert.equal(f.app.runtime.store.after(0).some(m => m.guestId), false, 'friend messages never wake the unmetered engine');
  assert.equal(f.app.runtime.store.recent(100).some(m => m.guestId), true, 'friend messages are shared room history');
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

test('friend discussion charges each call, blocks overlapping AI requests and keeps human chat', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async () => { await gate; return { ok: true, text: '토론 의견' }; }, { ids: ['claude', 'gpt'] });
  t.after(() => release());
  const first = await f.join('토론 친구'), second = await f.join('채팅 친구');
  await f.owner('/api/share/limits', { total: 20 });
  const rejected = await f.owner('/api/share');
  const id = rejected.body.guests.find(g => g.name === '토론 친구').id;
  await f.owner('/api/share/limits', { guestId: id, limit: 4 });
  assert.equal((await f.remote('/api/send', { cookie: first.cookie, body: { text: '토론', discussion: true } })).status, 429);
  assert.equal(f.calls.length, 0);
  await f.owner('/api/share/limits', { guestId: id, limit: 5 });
  assert.equal((await f.remote('/api/send', { cookie: first.cookie, body: { text: '토론', discussion: true, webSearch: true } })).status, 200);
  await f.wait(() => f.calls.length === 2);
  const state = (await f.remote('/api/state', { cookie: second.cookie })).body;
  assert.equal(state.sharedRoom.active.startedBy, '토론 친구');
  assert.equal(state.sharedRoom.active.models, undefined);
  assert.equal((await f.remote('/api/send', { cookie: second.cookie, body: { text: '겹치는 토론', discussion: true } })).status, 409);
  assert.equal((await f.remote('/api/send', { cookie: second.cookie, body: { text: '@Claude 질문' } })).status, 409);
  // While a discussion runs nobody sends anything, people's chat included.
  assert.equal((await f.remote('/api/send', { cookie: second.cookie, body: { text: '사람끼리 채팅' } })).status, 409);
  release();
  await f.wait(() => f.app.view().room.active === null);
  assert.equal(f.calls.length, 5);
  assert.ok(f.calls.every(call => call[3].webSearch === true));
  assert.equal(f.app.view().room.webSearch, false);
  assert.ok(f.app.store.messages.some(m => m.phase === 'final' && m.addressedTo === '토론 친구'));
  const quota = (await f.remote('/api/state', { cookie: first.cookie })).body.usage;
  assert.equal(quota.used, 5); assert.equal(quota.remaining, 0); assert.equal(quota.total, 5);
  f.tick();
  assert.equal((await f.remote('/api/send', { cookie: first.cookie, body: { text: '한도 초과 토론', discussion: true } })).status, 429);
  assert.equal(f.calls.length, 5);
  assert.equal((await f.remote('/api/room', { cookie: first.cookie, body: { discussion: true } })).status, 403);
});

test('friend rejoin preserves identity and quota; solo and permissions are enforced by server', async t => {
  const f = await fixture(t);
  const friend = await f.join('재입장 친구');
  const original = (await f.remote('/api/state', { cookie: friend.cookie })).body;
  const logout = await f.remote('/logout', { cookie: friend.cookie });
  const returnCookie = logout.headers['set-cookie'].find(c => c.startsWith('room_return=')).split(';')[0];
  assert.match(logout.headers['set-cookie'][1], /HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await f.remote('/api/share/rejoin', { body: {} })).status, 401);
  assert.equal((await f.remote('/api/share/rejoin', { cookie: returnCookie, body: {}, origin: 'https://evil.example' })).status, 403);
  const restored = await f.remote('/api/share/rejoin', { cookie: returnCookie, body: {} });
  assert.equal(restored.status, 200);
  const cookie = restored.headers['set-cookie'][0].split(';')[0];
  const after = (await f.remote('/api/state', { cookie })).body;
  assert.equal(after.selfId, original.selfId); assert.deepEqual(after.usage, original.usage);
  assert.equal((await f.owner('/api/share')).body.guests.length, 1);
  assert.equal((await f.remote('/api/share/access', { cookie, body: { mode: 'solo' } })).status, 403);
  assert.equal((await f.owner('/api/share/access', { mode: 'solo' })).status, 200);
  assert.equal((await f.remote('/api/state', { cookie })).status, 403);
  assert.equal((await f.remote('/api/share/rejoin', { cookie: returnCookie, body: {} })).status, 403);
  await f.owner('/api/share/access', { mode: 'multi', permissions: { chat: false, discussion: false, house: false, questions: false } });
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '권한 없는 채팅' } })).status, 403);
  assert.equal((await f.remote('/api/house/ballot', { cookie, body: { id: 'x', choice: 0 } })).status, 403);
  await f.owner('/api/share/access', { permissions: { chat: true } });
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '토론', discussion: true } })).status, 403);
  assert.equal((await f.remote('/api/send', { cookie, body: { text: 'AI', askAI: true } })).status, 403);
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '사람끼리 대화' } })).status, 200);
  assert.equal(f.calls.length, 0);
  await f.owner('/api/share/revoke-guest', { id: after.selfId });
  assert.equal((await f.remote('/api/share/rejoin', { cookie: returnCookie, body: {} })).status, 401);
});

test('friend presence distinguishes away, online and disconnected', async t => {
  const f = await fixture(t), friend = await f.join('자리비움 친구');
  const stream = http.get(f.proxy() + '/events', { headers: { Host: 'room.example.ts.net:8443', Cookie: friend.cookie } });
  t.after(() => stream.destroy());
  await new Promise((resolve, reject) => { stream.on('error', reject); stream.on('response', res => { res.once('data', resolve); }); });
  const person = () => f.app.view().participants.find(p => p.name === '자리비움 친구');
  await f.wait(() => person()?.online);
  assert.equal((await f.remote('/api/share/presence', { cookie: friend.cookie, body: { away: true } })).status, 200);
  assert.equal(person().away, true);
  await f.remote('/api/share/presence', { cookie: friend.cookie, body: { away: false } });
  assert.equal(person().away, false);
  stream.destroy();
  await f.wait(() => !person().online);
});

test('guest web search uses one metered call without changing owner search settings', async t => {
  const f = await fixture(t), friend = await f.join('검색 친구');
  await f.start();
  assert.equal((await f.remote('/api/send', { cookie: friend.cookie, body: { text: '웹에서 찾아줘', webSearch: true } })).status, 200);
  await f.pump(); await f.wait(() => f.calls.length === 1 && f.app.store.messages.at(-1).from === 'claude');
  assert.equal(f.calls[0][3].webSearch, true);
  assert.equal((await f.remote('/api/state', { cookie: friend.cookie })).body.usage.used, 1);
  assert.equal(f.app.view().room.webSearch, false);
  await f.owner('/api/share/access', { permissions: { questions: false } }); f.tick();
  assert.equal((await f.remote('/api/send', { cookie: friend.cookie, body: { text: '차단된 검색', webSearch: true } })).status, 403);
  assert.equal(f.calls.length, 1);
});

test('friend total 15 limits actual calls, survives restart, rejects unmetered features, and leaves human chat usable', async (t) => {
  const f = await fixture(t);
  await f.owner('/api/share/limits', { total: 15 });
  await f.start();
  const { cookie } = await f.join('수진');
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '그림', image: {}, askAI: true } })).status, 403);
  for (let n = 1; n <= 15; n++) {
    f.tick();
    const response = await f.remote('/api/send', { cookie, body: { text: `질문 ${n}` } });
    assert.equal(response.status, 200);
    await f.pump();
    await f.wait(() => f.calls.length === n && f.app.store.messages.at(-1).from === 'claude');
  }
  f.tick();
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '한도 초과여도 채팅 저장' } })).status, 200);
  await f.pump();
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
  assert.equal((await f.remote('/api/send', { cookie: friend2.cookie, body: { text: '다른 친구도 한도 공유' } })).status, 200);
  await f.pump();
  await f.owner('/api/share/limits', { total: 16, guestId: admin.guests[0].id, limit: 16 });
  f.tick();
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '한도 변경 뒤', askAI: true } })).status, 200);
  await f.pump();
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
  await f.start();
  await f.remote('/api/send', { cookie, body: { text: '실패할 질문', askAI: true } });
  const first = f.pump();
  await f.wait(() => !!resolveCall);
  resolveCall({ ok: false, detail: 'quota' });
  await first;
  await f.wait(() => f.app.store.messages.at(-1).kind === 'error');
  assert.equal((await f.owner('/api/share')).body.usage.total, 1);
  f.tick(20000); resolveCall = null;
  await f.remote('/api/send', { cookie, body: { text: '취소할 질문', askAI: true } });
  const second = f.pump();
  await f.wait(() => !!resolveCall);
  const admin = (await f.owner('/api/share')).body;
  await f.owner('/api/share/revoke-guest', { id: admin.guests[0].id });
  await second;
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

test('a 24-hour friend link admits ten people, survives reload, and preserves legacy one-use owner links', (t) => {
  const root = temporary(t), now = 1791420000000;
  let sharing = new Sharing(root, () => now);
  const invite = sharing.invite('guest', { maxUses: 10 });
  assert.equal(invite.exp - now, 24 * 3600000);
  for (let i = 0; i < 10; i++) {
    sharing = new Sharing(root, () => now);
    assert.equal(sharing.redeem(invite.secret, `친구${i}`, 10, '방장', { guestOnly: true }).identity.role, 'guest');
  }
  assert.throws(() => sharing.redeem(invite.secret, '열한번째', 10, '방장'), /이미 사용/);
  const owner = sharing.invite('owner');
  assert.throws(() => sharing.redeem(owner.secret, '', 10, '방장', { guestOnly: true }), /친구 초대/);
  assert.equal(sharing.redeem(owner.secret, '', 10, '방장').identity.role, 'owner', 'public rejection does not consume private owner invitation');
  assert.throws(() => sharing.invite('owner', { maxUses: 10 }), /방장 연결/);
  assert.throws(() => sharing.invite('guest', { maxUses: 11 }), /최대 10명/);
  const cancelled = sharing.invite('guest', { maxUses: 10 });
  sharing.redeem(cancelled.secret, '취소전', 10, '방장');
  sharing.revokeInvite(cancelled.id);
  assert.throws(() => sharing.redeem(cancelled.secret, '취소후', 10, '방장'), /만료/);
});

test('a failed redeem save leaves no guest, session or consumed invitation in memory', (t) => {
  const sharing = new Sharing(temporary(t));
  const invite = sharing.invite('guest', { maxUses: 10 }), before = structuredClone(sharing.data);
  sharing.save = () => { throw new Error('disk failure'); };
  assert.throws(() => sharing.redeem(invite.secret, '친구', 10, '방장'), /disk failure/);
  assert.deepEqual(sharing.data, before);
});

test('guest UI reuses authenticated theme and portraits without exposing owner controls or private reply history', async (t) => {
  const f = await fixture(t);
  const secret = f.app.store.addMessage({ from: 'user', text: '입장 전 비밀', ts: 1 });
  const { cookie } = await f.join('친구화면');
  const initial = (await f.remote('/api/state', { cookie })).body;
  assert.ok(initial.selfId);
  assert.equal(initial.members.find(m => m.id === 'claude').maker, 'Anthropic');
  const own = f.app.store.addMessage({ from: 'user', guestId: initial.selfId, displayName: '친구화면', text: '내 메시지', ts: 2 });
  f.app.store.addMessage({ from: 'claude', text: '**답변**', model: 'test-model', replyTo: own.id, ts: 3 });
  f.app.store.addMessage({ from: 'claude', text: '과거 답장', replyTo: secret.id, ts: 4 });
  const hiddenError = f.app.store.addMessage({ from: 'system', kind: 'error', text: '비공개 오류 경로', ts: 5 });
  f.app.store.addMessage({ from: 'claude', text: '오류 안내', replyTo: hiddenError.id, ts: 6 });
  const state = (await f.remote('/api/state', { cookie })).body;
  assert.equal(state.messages.find(m => m.id === own.id).guestId, state.selfId);
  assert.deepEqual(state.messages.find(m => m.text === '**답변**').replyPreview, { name: '친구화면', text: '내 메시지' });
  assert.equal(state.messages.find(m => m.text === '과거 답장').replyPreview, undefined);
  assert.doesNotMatch(JSON.stringify(state), /입장 전 비밀|비공개 오류 경로/);
  assert.equal(state.room, undefined);
  assert.equal(state.sharedRoom.models, undefined);
  assert.equal(state.sharedRoom.memos, undefined);
  assert.equal(state.sharedRoom.checks, undefined);
  assert.deepEqual(state.files, []);
  const page = (await f.remote('/', { cookie })).text;
  assert.match(page, /\/style.css/); assert.match(page, /\/assistant.css/);
  assert.match(page, /id="themeBtn"/); assert.match(page, /id="input"/); assert.match(page, /room-ui.mjs/);
  assert.match(page, /data-role="guest"/); assert.doesNotMatch(page, /guestForm|src="\/task-screen.js"|src="\/share.js"/);
  for (const asset of ['/style.css', '/assistant.css', '/format.mjs', '/assistant.js', '/room-ui.mjs', '/status.mjs', '/dot-title.mjs', '/discussion-stage.mjs', '/dot-characters.mjs', '/house.js', '/house.css', '/avatars/claude-pixel-128.png',
    '/avatars/gpt-pixel-128.png', '/avatars/gemini-pixel-128.png']) {
    assert.equal((await f.remote(asset, { cookie })).status, 200, asset);
    assert.equal((await f.remote(asset)).status, asset === '/style.css' ? 200 : 401, asset);
  }
  for (const asset of ['/task-screen.js', '/avatars/dev.svg', '/ws/private.txt'])
    assert.equal((await f.remote(asset, { cookie })).status, 403, asset);
  await f.owner('/api/share/disconnect', {}); await f.wait(() => f.stopped() === 1);
  await f.owner('/api/share/connect', { public: true });
  for (const asset of ['/style.css', '/assistant.css', '/format.mjs', '/avatars/claude-pixel-128.png'])
    assert.equal((await f.remote(asset, { cookie })).status, 200, asset);
  for (const route of ['/api/room', '/api/tasks', '/api/share'])
    assert.equal((await f.remote(route, { cookie })).status, 403, route);
});

test('public Funnel denies owner tokens/cookies and all settings/files/tasks, while metered guest chat and SSE work', async (t) => {
  const f = await fixture(t);
  const privateOwner = await f.join('', 'owner'), ownerInvite = await f.invite('owner');
  await f.owner('/api/share/disconnect', {}); await f.wait(() => f.stopped() === 1);
  const connected = await f.owner('/api/share/connect', { public: true });
  assert.equal(connected.body.public, true);
  assert.equal((await f.owner('/api/share/invite', { role: 'owner' })).status, 403);
  assert.equal((await f.remote('/api/share/redeem', { body: { token: ownerInvite.token, name: '탈취' } })).status, 403);
  assert.equal((await f.remote('/api/state', { cookie: privateOwner.cookie })).status, 401);
  assert.equal((await f.remote('/api/share/session', { cookie: privateOwner.cookie })).body.role, null);
  const invitation = await f.invite('guest');
  assert.equal(invitation.maxUses, 10);
  const response = await f.remote('/api/share/redeem', { body: { token: invitation.token, name: '공개친구', role: 'owner' } });
  assert.equal(response.body.role, 'guest');
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  assert.equal((await f.remote('/api/share/session', { cookie })).body.role, 'guest');
  const same = await f.remote('/api/share/redeem', { cookie, body: { token: invitation.token, name: '중복' } });
  assert.equal(same.status, 200);
  assert.equal((await f.owner('/api/share')).body.invites.find((i) => i.id === invitation.id).uses, 1);
  const blocked = ['/api/room', '/api/share', '/api/share/limits', '/api/share/connect', '/api/share/invite',
    '/api/notes', '/api/models', '/api/check/call', '/api/dev/state', '/api/world',
    '/api/tasks', '/api/tasks/ai', '/api/tasks/attachments', '/api/tasks/events', '/task-screen.js', '/api/file?path=secret.txt', '/ws/private.html'];
  for (const route of blocked) {
    assert.equal((await f.remote(route, { cookie })).status, 403, route);
    assert.equal((await f.remote(route, { cookie: privateOwner.cookie, body: {} })).status, 403, route);
  }
  assert.equal((await f.remote('/api/house', { cookie })).status, 200);
  assert.equal((await f.remote('/api/house/undo', { cookie, body: {} })).status, 403);
  assert.match((await f.remote('/', { cookie })).text, /data-role="guest"/);
  await f.start();
  assert.equal((await f.remote('/api/send', { cookie, body: { text: 'AI 질문', askAI: true, ai: 'claude' } })).status, 200);
  await f.pump();
  await f.wait(() => f.calls.length === 1);
  await f.wait(() => f.app.store.messages.at(-1).from === 'claude');
  await f.owner('/api/share/limits', { total: 1 });
  f.tick();
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '추가 AI' } })).status, 200);
  await f.pump();
  assert.equal((await f.remote('/api/send', { cookie, body: { text: '일반 채팅 계속' } })).status, 200);
  assert.equal(f.calls.length, 1);
  await new Promise((resolve, reject) => {
    const req = http.get(f.proxy() + '/events', { headers: { Host: 'room.example.ts.net:8443', Cookie: cookie } }, res => {
      res.once('data', chunk => {
        try { assert.match(chunk.toString(), /"role":"guest"/); assert.doesNotMatch(chunk.toString(), /"checks":/); res.destroy(); resolve(); }
        catch (e) { res.destroy(); reject(e); }
      });
    }); req.on('error', reject);
  });
});

test('remaining daily budget is shared fairly on admission, persists, and is not redistributed per call or reconnect', (t) => {
  const root = temporary(t); let now = new Date(2026, 9, 8, 12).getTime();
  let s = new Sharing(root, () => now);
  const join = name => s.redeem(s.invite('guest').secret, name, 10, '방장');
  const a = join('가').guest.id;
  assert.equal(s.usage(a).remaining, 100);
  for (let i = 0; i < 20; i++) s.charge(a);
  const entryB = join('나'), b = entryB.guest.id;
  assert.deepEqual([s.usage(a).remaining, s.usage(b).remaining], [40, 40]);
  for (let i = 0; i < 10; i++) s.charge(b);
  assert.deepEqual([s.usage(a).remaining, s.usage(b).remaining], [40, 30]);
  s = new Sharing(root, () => now);
  assert.deepEqual([s.usage(a).remaining, s.usage(b).remaining], [40, 30]);
  s.logout(entryB.identity);
  assert.deepEqual([s.usage(a).remaining, s.usage(b).remaining], [40, 30]);
  const c = join('다').guest.id;
  assert.deepEqual([a, b, c].map(id => s.usage(id).remaining), [24, 23, 23]);
  assert.deepEqual([a, b, c].map(id => s.usage(id).used), [20, 10, 0]);
  now += 86400000;
  assert.deepEqual([a, b, c].map(id => s.usage(id).remaining), [34, 33, 33]);
  assert.equal(s.usage().total, 0);
});

test('owner caps and pool edits redistribute only unspent calls; revoked guests never refund spent calls', (t) => {
  const s = new Sharing(temporary(t));
  const a = s.redeem(s.invite('guest').secret, '가', 0, '방장').guest.id;
  const b = s.redeem(s.invite('guest').secret, '나', 0, '방장').guest.id;
  s.limits({ guestId: a, limit: 10 });
  assert.deepEqual([s.usage(a).remaining, s.usage(b).remaining], [10, 90]);
  for (let i = 0; i < 10; i++) s.charge(a);
  assert.throws(() => s.charge(a), /한도/);
  s.revokeGuest(a);
  assert.equal(s.usage(b).remaining, 90); assert.equal(s.usage().total, 10);
  s.limits({ total: 5 });
  assert.equal(s.usage(b).remaining, 0);
  s.limits({ total: 100, guestId: b, limit: 0 });
  assert.equal(s.usage(b).remaining, 0);
  s.limits({ guestId: b, limit: null });
  assert.equal(s.usage(b).remaining, 90);
  const before = structuredClone(s.data);
  s.save = () => { throw Error('disk failure'); };
  assert.throws(() => s.charge(b), /disk failure/);
  assert.deepEqual(s.data, before);
  assert.throws(() => s.limits({ total: 999 }), /disk failure/);
  assert.deepEqual(s.data, before);
});

test('legacy sharing migrates to the 100-call pool once and retains usage, credentials and personal caps', (t) => {
  const root = temporary(t), s = new Sharing(root);
  const entry = s.redeem(s.invite('guest').secret, '기존 친구', 0, '방장');
  s.limits({ total: 15, guestId: entry.guest.id, limit: 5 });
  s.charge(entry.guest.id); s.charge(entry.guest.id);
  s.data.version = 1; s.save();
  const migrated = new Sharing(root);
  assert.equal(migrated.usage().limit, 100);
  assert.equal(migrated.usage(entry.guest.id).used, 2);
  assert.equal(migrated.usage(entry.guest.id).remaining, 3);
  assert.equal(migrated.identity({ headers: { cookie: migrated.cookie(entry.secret, true) } }).guestId, entry.guest.id);
  migrated.limits({ total: 25 });
  assert.equal(new Sharing(root).usage().limit, 25, 'later owner settings are not overwritten');
});

test('ordinary friend messages batch automatically, use mention priority and recent identity context, and do not chain calls', async (t) => {
  const f = await fixture(t, async () => ({ ok: true, text: '@GPT 다음에도 같이 얘기하자' }), { ids: ['claude', 'gpt'] });
  const { cookie } = await f.join('일상친구'); await f.start();
  await f.remote('/api/send', { cookie, body: { text: '오늘 산책했어' } });
  f.tick();
  await f.remote('/api/send', { cookie, body: { text: '@Claude 날씨 좋더라', askAI: false, ai: 'gpt' } });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.remote('/api/state', { cookie })).body.autoReply, 'queued');
  await f.pump();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'claude');
  assert.match(f.calls[0][2], /일상친구/); assert.match(f.calls[0][2], /오늘 산책했어/);
  assert.match(f.calls[0][2], /날씨 좋더라/);
  assert.equal((await f.owner('/api/share')).body.usage.total, 1);
  await f.pump(10000); assert.equal(f.calls.length, 1);
  assert.equal(f.app.runtime.store.after(0).some(m => m.guestId), false, 'friend messages never wake the unmetered engine');
  assert.equal(f.app.runtime.store.recent(100).some(m => m.guestId), true, 'friend messages are shared room history');
});

test('friends queue while a reply is running; multiple friends cannot double-charge or overlap providers', async (t) => {
  const releases = [];
  const f = await fixture(t, () => new Promise(resolve => releases.push(resolve)), { ids: ['claude', 'gpt'] });
  const a = await f.join('가'), b = await f.join('나'); await f.start();
  await f.remote('/api/send', { cookie: a.cookie, body: { text: '@Claude 안녕' } });
  const first = f.pump();
  assert.equal(f.app.runtime.agents.claude.busy, true);
  await f.remote('/api/send', { cookie: b.cookie, body: { text: '@GPT 나도 안녕' } });
  await f.pump(); assert.equal(f.calls.length, 1);
  releases[0]({ ok: true, text: '안녕 가' }); await first;
  const second = f.pump();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1][0], 'gpt');
  releases[1]({ ok: true, text: '안녕 나' }); await second;
  const admin = (await f.owner('/api/share')).body;
  assert.equal(admin.usage.total, 2);
  assert.deepEqual(admin.guests.map(g => g.usage.used), [1, 1]);
  assert.deepEqual(admin.guests.map(g => g.usage.remaining), [49, 49]);
});

test('Talk OFF cancels a guest response and queued batches, and cannot be overridden by a friend', async (t) => {
  const f = await fixture(t, (_id, _brief, _prompt, options) => new Promise(resolve => {
    options.signal.addEventListener('abort', () => resolve({ ok: true, text: '늦은 친구 답변' }), { once: true });
  }));
  const { cookie } = await f.join('중지 확인'); await f.start();
  await f.remote('/api/send', { cookie, body: { text: '대화해줘' } });
  const running = f.pump();
  f.tick(); await f.remote('/api/send', { cookie, body: { text: '이어 말할게' } });
  await f.owner('/api/room', { auto: { on: false } }); await running;
  assert.equal(f.calls[0][3].signal.aborted, true);
  assert.ok(!f.app.store.messages.some(m => m.text === '늦은 친구 답변'));
  assert.equal((await f.owner('/api/share')).body.usage.total, 1);
  assert.equal((await f.remote('/api/room', { cookie, body: { auto: { on: true } } })).status, 403);
  await f.start(); await f.pump(10000);
  assert.equal(f.calls.length, 1, 'queued messages are not replayed after OFF');
});

test('beta shared house and ballots use server identity across owner devices and guest reconnects', async t => {
  const f = await fixture(t, null, { ids: ['claude', 'gpt'] });
  f.app.runtime.setEnabled('claude', true); f.app.runtime.setEnabled('gpt', true);
  f.app.house.s.floors = { '1,1': 'wood' };
  const friend = await f.join('투표친구'), ownerA = await f.join('', 'owner'), ownerB = await f.join('', 'owner');
  for (const cookie of [friend.cookie, ownerA.cookie, ownerB.cookie]) {
    await new Promise((resolve, reject) => {
      const req = http.get(f.proxy() + '/events', { headers: { Host: 'room.example.ts.net:8443', Cookie: cookie } }, res => {
        res.once('data', resolve); res.on('error', reject);
      });
      req.on('error', reject); t.after(() => req.destroy());
    });
  }
  await f.start();
  await f.owner('/api/house/active', { active: true });
  f.app.houseRuntime.buildAt = Infinity; // This regression exercises shared ballots, without a construction call.
  await f.app.houseRuntime.tick();
  const pendingId = f.app.house.s.story.current.id;
  f.app.houseRuntime.ballot('claude', { id: pendingId, choice: 0 }, true, '정원을 선택할게');
  f.app.houseRuntime.ballot('gpt', { id: pendingId, choice: 1 }, true, '바비큐장을 선택할게');
  const state = (await f.remote('/api/house', { cookie: friend.cookie })).body;
  assert.equal(state.role, 'guest');
  // A friend allowed into the house walks in as their own character, listed with everyone in the house.
  assert.ok(state.player); assert.ok(Object.keys(state.people).some((who) => who.startsWith('guest:')));
  const id = state.story.current.id;
  const notice = (await f.remote('/api/state', { cookie: friend.cookie })).body.messages.filter(m => m.kind === 'house-vote' && m.voteId === id);
  assert.equal(notice.length, 1); assert.match(notice[0].text, /투표가 열렸어요/);
  f.app.houseRuntime.changed();
  assert.equal(f.app.store.messages.filter(m => m.kind === 'house-vote' && m.voteId === id).length, 1);
  assert.equal((await f.remote('/joint-vote.mjs', { cookie: friend.cookie })).status, 200);
  const cast = (cookie, choice, extra = {}) => f.remote('/api/house/ballot', { cookie, body: { id, choice, ...extra } });
  assert.equal((await cast(ownerA.cookie, 1)).status, 200);
  assert.equal((await cast(ownerB.cookie, 0)).status, 409, 'owner devices share exactly one identity');
  assert.equal((await cast(friend.cookie, 1, { voter: 'ai:gpt', role: 'owner' })).status, 200);
  assert.equal((await cast(friend.cookie, 0)).status, 409);
  assert.equal((await f.remote('/api/house/undo', { cookie: friend.cookie, body: {} })).status, 403);
  f.tick(180001); await f.app.houseRuntime.tick();
  const shared = (await f.remote('/api/house', { cookie: friend.cookie })).body;
  assert.equal(shared.story.current.status, 'applied');
  assert.deepEqual(shared.story.current.counts, [1, 3]);
  assert.equal(shared.story.current.myChoice, 1);
  assert.equal((await cast(friend.cookie, 0)).status, 409);
  assert.equal((await f.owner('/api/house')).body.story.environment.yard, 'bbq');
  await f.app.houseRuntime.tick();
  assert.equal(f.app.house.s.story.history.length, 1);
});

test('beta friends share one 12-second normal-flow call and a single budget charge', async t => {
  const f = await fixture(t);
  const a = await f.join('묶음가'), b = await f.join('묶음나'); await f.start();
  await f.remote('/api/send', { cookie: a.cookie, body: { text: '오늘 만나자' } });
  f.tick(); await f.remote('/api/send', { cookie: b.cookie, body: { text: '좋아 같이 가자' } });
  await f.pump(5000); assert.equal(f.calls.length, 0);
  await f.pump(10001); assert.equal(f.calls.length, 1);
  assert.match(f.calls[0][2], /오늘 만나자/); assert.match(f.calls[0][2], /좋아 같이 가자/);
  const state = (await f.owner('/api/share')).body;
  assert.equal(state.usage.total, 1); assert.equal(state.calls.friend, 1);
  await f.pump(); assert.equal(f.calls.length, 1);
});

test('beta private owner Serve remains separate while public Funnel serves friends only', async t => {
  const root = temporary(t), targets = {};
  const tunnel = (role, port) => async target => {
    targets[role] = target; return { url: `https://separate.example.ts.net:${port}`, stop: async () => {} };
  };
  const app = createAssistantServer({ root, cfg: loadConfig(path.join(root, 'config.json')), adapter: { available: () => ({}) },
    tailscaleServe: tunnel('owner', 8444), tailscaleFunnel: tunnel('guest', 8443) });
  t.after(() => app.close()); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, body) => (await fetch(local + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  await request('/api/share/connect', {});
  await request('/api/share/connect', { public: true });
  assert.notEqual(targets.owner, targets.guest);
  const ownerInvite = await request('/api/share/invite', { role: 'owner' });
  const friendInvite = await request('/api/share/invite', { role: 'guest' });
  assert.equal(new URL(ownerInvite.link).port, '8444'); assert.equal(new URL(friendInvite.link).port, '8443');
  const remote = (role, route, body, cookie) => new Promise((resolve, reject) => {
    const port = role === 'owner' ? 8444 : 8443;
    const req = http.request(targets[role] + route, { method: body ? 'POST' : 'GET', headers: { Host: `separate.example.ts.net:${port}`,
      Origin: `https://separate.example.ts.net:${port}`, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text), cookie: res.headers['set-cookie']?.[0].split(';')[0] }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const token = new URLSearchParams(new URL(ownerInvite.link).hash.slice(1)).get('token');
  assert.equal((await remote('guest', '/api/share/redeem', { token })).status, 403);
  const pending = await remote('owner', '/api/share/redeem', { token }); assert.equal(pending.status, 202);
  assert.equal(pending.cookie, undefined);
  assert.equal((await remote('owner', '/api/share/pairing', { id: 'fake', approve: true })).status, 403);
  assert.equal((await remote('guest', '/api/share/pair-status', { token, challenge: pending.body.challenge })).status, 403);
  const requests = await request('/api/share/pairing');
  await request('/api/share/pairing', { id: requests.requests[0].id, approve: true });
  const grant = await remote('owner', '/api/share/pair-status', { token, challenge: pending.body.challenge }); assert.equal(grant.status, 200);
  assert.equal((await remote('owner', '/api/share/pair-status', { token, challenge: pending.body.challenge })).status, 401);
  assert.equal((await remote('owner', '/api/share', undefined, grant.cookie)).status, 200);
  assert.equal((await remote('guest', '/api/share', undefined, grant.cookie)).status, 403);
  assert.equal((await remote('guest', '/api/tasks', undefined, grant.cookie)).status, 403);
});

test('owner pairing rejects denied, expired, mismatched and canceled requests before granting a session', t => {
  const root = temporary(t); let now = Date.now();
  const sharing = new Sharing(root, () => now);
  const invite = sharing.invite('owner');
  const p = sharing.requestOwnerPair(invite.secret, 'Mozilla/5.0 (Linux; Android 14; SM-S928N Build/ABC)');
  assert.match(sharing.pendingPairs()[0].name, /SM-S928N/);
  assert.deepEqual(sharing.claimPair(p.challenge, invite.secret, 0, '방장'), { pending: true });
  assert.equal(Object.keys(sharing.data.sessions).length, 0);
  assert.throws(() => sharing.claimPair(p.challenge, 'a'.repeat(43), 0, '방장'), /만료/);
  sharing.decidePair(sharing.pendingPairs()[0].id, false);
  assert.throws(() => sharing.claimPair(p.challenge, invite.secret, 0, '방장'), /거절/);
  const expired = sharing.requestOwnerPair(invite.secret, 'iPhone'); now += 180001;
  assert.throws(() => sharing.claimPair(expired.challenge, invite.secret, 0, '방장'), /만료/);
  const canceled = sharing.requestOwnerPair(invite.secret, 'Android');
  sharing.decidePair(sharing.pendingPairs()[0].id, true); sharing.revokeInvite(invite.id);
  assert.throws(() => sharing.claimPair(canceled.challenge, invite.secret, 0, '방장'), /만료/);
  assert.equal(Object.keys(sharing.data.sessions).length, 0);
});

test('guest gallery serves only AI media shared after entry; private files, old media and writes stay blocked', async t => {
  const f = await fixture(t);
  const add = (name, content, meta = {}) => {
    const rel = `images/${name}`; fs.mkdirSync(path.dirname(f.app.store.abs(rel)), {recursive:true});
    fs.writeFileSync(f.app.store.abs(rel),content); f.app.store.touchMeta(rel,'claude',true);
    Object.assign(f.app.store.meta[rel],meta); return rel;
  };
  const old = add('old.png',Buffer.from('old'));
  f.app.store.addMessage({from:'claude',text:'',attach:{path:old}});
  const friend = await f.join('보관함친구');
  const picture = add('shared.png',Buffer.from('shared'));
  const privateFile = add('private.txt','private PC text');
  const unpublished = add('unpublished.png',Buffer.from('unpublished'));
  const game = add('shared.html','<h1>shared game</h1>',{activity:'game',title:'함께 만든 게임'});
  f.app.store.addMessage({from:'claude',text:'',attach:{path:picture}});
  f.app.store.addMessage({from:'claude',text:'',attach:{path:privateFile}});
  f.app.store.addMessage({from:'claude',text:'',game:{path:game,title:'함께 만든 게임'}});
  await f.owner('/api/share/connect',{public:true});
  const gallery = await f.remote('/api/gallery',{cookie:friend.cookie});
  assert.equal(gallery.status,200); assert.deepEqual(gallery.body.files.map(f=>f.path).sort(),[picture,game].sort());
  const state = (await f.remote('/api/state',{cookie:friend.cookie})).body;
  assert.deepEqual(state.files,gallery.body.files);
  assert.ok(state.messages.some(m=>m.attach?.path===picture));
  assert.ok(!state.messages.some(m=>m.attach?.path===privateFile));
  for (const rel of [old,privateFile,unpublished,'../config.json','/etc/passwd'])
    assert.equal((await f.remote(`/api/gallery/file?path=${encodeURIComponent(rel)}`,{cookie:friend.cookie})).status,403,rel);
  assert.equal((await f.remote(`/api/gallery/file?path=${encodeURIComponent(picture)}`,{cookie:friend.cookie})).text,'shared');
  const html = await f.remote(`/api/gallery/file?path=${encodeURIComponent(game)}`,{cookie:friend.cookie});
  assert.equal(html.status,200); assert.match(html.headers['content-security-policy'],/sandbox allow-scripts/);
  assert.equal((await f.remote('/api/gallery/file',{cookie:friend.cookie,body:{path:picture}})).status,403);
  for (const rel of ['/api/file?path='+picture,'/ws/'+picture,'/api/tasks'])
    assert.equal((await f.remote(rel,{cookie:friend.cookie})).status,403);
  assert.equal((await f.remote('/api/gallery')).status,401);
  const manifest = (await f.remote('/manifest.webmanifest')).body;
  assert.deepEqual(manifest.related_applications,[{platform:'webapp',url:'https://room.example.ts.net:8443/manifest.webmanifest',id:'https://room.example.ts.net:8443/'}]);
});

const say = (body) => ({ ok: true, text: JSON.stringify(body) });
test('phase 2: owner and three friends share one room; AIs see each speaker, answer the chosen friend, may pass, and charge per chain', async t => {
  const replies = [];
  const f = await fixture(t, (id, brief, prompt) => (replies.shift() || (() => say({ action: 'pass' })))(id, prompt), { ids: ['claude', 'gpt', 'gemini'] });
  const a = await f.join('민수'), b = await f.join('지영'), c = await f.join('하늘');
  await f.start();
  assert.equal((await f.owner('/api/send', { text: '방장도 왔어' })).status, 200);
  const first = (await f.remote('/api/send', { cookie: a.cookie, body: { text: '@Claude 오늘 뭐해?' } })).body.messageId;
  f.tick();
  const second = (await f.remote('/api/send', { cookie: b.cookie, body: { text: '나는 영화 볼래' } })).body.messageId;
  replies.push((id, prompt) => {
    assert.equal(id, 'claude');
    assert.match(prompt, /민수\(친구\): @Claude 오늘 뭐해\?/); assert.match(prompt, /지영\(친구\): 나는 영화 볼래/);
    assert.match(prompt, /방장: 방장도 왔어/); assert.match(prompt, new RegExp(`너를 부르거나 너한테 답한 메시지: #${first}`));
    return say({ action: 'say', messages: ['지영아 무슨 영화?', '민수는 나랑 산책 어때'], reply_to: second });
  });
  await f.pump(); await f.wait(() => f.app.store.messages.at(-1).from === 'claude');
  const answers = f.app.store.messages.filter(m => m.from === 'claude');
  assert.deepEqual(answers.map(m => m.addressedTo), ['지영', '지영']);
  assert.equal(answers[0].replyTo, second); assert.equal(answers[1].replyTo, undefined);
  assert.equal(answers[0].chain.cause, second); assert.equal(f.calls.length, 1);
  assert.equal(f.app.runtime.store.after(0).some(m => m.guestId), false);
  let admin = (await f.owner('/api/share')).body;
  assert.deepEqual(admin.guests.map(g => g.usage.used), [1, 0, 0]);
  // A friend-caused turn may pass: nothing is posted, the call is still charged once.
  f.tick(); await f.remote('/api/send', { cookie: c.cookie, body: { text: '그냥 혼잣말' } });
  await f.pump(); await f.wait(() => f.calls.length === 2 && !f.app.runtime.agents[f.calls[1][0]].busy);
  assert.equal(f.app.store.messages.at(-1).text, '그냥 혼잣말');
  admin = (await f.owner('/api/share')).body;
  assert.deepEqual(admin.guests.map(g => g.usage.used), [1, 0, 1]);
  const guestState = (await f.remote('/api/state', { cookie: b.cookie })).body;
  assert.equal(guestState.messages.find(m => m.id === answers[0].id).addressedTo, '지영');
  assert.equal(guestState.sharedRoom.aiIntensity, 'normal');
});

const CHAIN_LINES = { claude: '@GPT 너는 어때?', gpt: '@Gemini 너도 말해줘', gemini: '@Claude 다시 너!' };
test('phase 2: lively chains follow AI mentions up to three charged calls; normal and quiet stay bounded', async t => {
  const f = await fixture(t, (id) => say({ action: 'say', messages: [CHAIN_LINES[id]] }), { ids: ['claude', 'gpt', 'gemini'] });
  const friend = await f.join('체인친구'); await f.start();
  assert.equal((await f.remote('/api/room', { cookie: friend.cookie, body: { aiIntensity: 'lively' } })).status, 403);
  assert.equal((await f.owner('/api/room', { aiIntensity: 'loud' })).status, 400);
  assert.equal((await f.owner('/api/room', { aiIntensity: 'lively' })).status, 200);
  await f.remote('/api/send', { cookie: friend.cookie, body: { text: '@Claude 이야기 시작해줘' } });
  await f.pump(); await f.wait(() => f.calls.length === 1 && !f.app.runtime.agents.claude.busy);
  assert.equal((await f.remote('/api/state', { cookie: friend.cookie })).body.autoReply, 'responding');
  await f.pump(1000); assert.equal(f.calls.length, 1, 'follow-up waits a short beat');
  await f.pump(600); await f.wait(() => f.calls.length === 2 && !f.app.runtime.agents.gpt.busy);
  assert.equal(f.calls[1][0], 'gpt'); assert.match(f.calls[1][2], /Claude가 너에게 말을 넘겼어/);
  await f.pump(2000); await f.wait(() => f.calls.length === 3 && !f.app.runtime.agents.gemini.busy);
  for (let n = 0; n < 5; n++) await f.pump(2000);
  assert.equal(f.calls.length, 3, 'a chain never exceeds three calls even when the AI keeps mentioning');
  assert.deepEqual(f.calls.map(c => c[0]), ['claude', 'gpt', 'gemini']);
  assert.equal((await f.owner('/api/share')).body.usage.total, 3);
  assert.equal(new Set(f.app.store.messages.filter(m => m.chain).map(m => m.chain.id)).size, 1);
  // Normal: one call; the AI's mention does not continue the chain.
  await f.owner('/api/room', { aiIntensity: 'normal' }); f.tick(20000);
  await f.remote('/api/send', { cookie: friend.cookie, body: { text: '@Claude 한 번 더' } });
  await f.pump(); await f.wait(() => f.calls.length === 4 && !f.app.runtime.agents.claude.busy);
  for (let n = 0; n < 3; n++) await f.pump(2000);
  assert.equal(f.calls.length, 4);
  // Quiet: plain friend chatter is never sent to an AI; an explicit call is.
  await f.owner('/api/room', { aiIntensity: 'quiet' }); f.tick(20000);
  await f.remote('/api/send', { cookie: friend.cookie, body: { text: '사람끼리 수다' } });
  assert.equal((await f.remote('/api/state', { cookie: friend.cookie })).body.autoReply, 'ready');
  await f.pump(); await f.pump(); assert.equal(f.calls.length, 4);
  f.tick();
  await f.remote('/api/send', { cookie: friend.cookie, body: { text: '@GPT 너만 대답해' } });
  await f.pump(); await f.wait(() => f.calls.length === 5 && !f.app.runtime.agents.gpt.busy);
  assert.equal(f.calls[4][0], 'gpt');
  assert.equal(f.app.view().room.aiIntensity, 'quiet');
});

test('phase 2: chain stops when the friend budget runs out, and simultaneous friends never overlap or double-charge', async t => {
  const f = await fixture(t, (id) => say({ action: 'say', messages: [id === 'claude' ? '@GPT 받아' : '좋아'] }), { ids: ['claude', 'gpt'] });
  const one = await f.join('한도친구'); await f.start();
  await f.owner('/api/room', { aiIntensity: 'lively' });
  const guestId = (await f.owner('/api/share')).body.guests[0].id;
  await f.owner('/api/share/limits', { guestId, limit: 1 });
  await f.remote('/api/send', { cookie: one.cookie, body: { text: '@Claude 시작' } });
  await f.pump(); await f.wait(() => f.calls.length === 1 && !f.app.runtime.agents.claude.busy);
  for (let n = 0; n < 3; n++) await f.pump(2000);
  assert.equal(f.calls.length, 1, 'no follow-up without remaining budget');
  assert.equal((await f.remote('/api/state', { cookie: one.cookie })).body.usage.remaining, 0);
  assert.equal((await f.remote('/api/send', { cookie: one.cookie, body: { text: '한도 끝나도 채팅' } })).status, 200);
  const two = await f.join('동시1'), three = await f.join('동시2');
  f.tick();
  const sent = await Promise.all([two, three].map((p, i) => f.remote('/api/send', { cookie: p.cookie, body: { text: `@GPT 동시 ${i}` } })));
  assert.deepEqual(sent.map(r => r.status), [200, 200]);
  await Promise.all([f.pump(), f.pump(0), f.pump(0)]);
  await f.wait(() => f.calls.length === 2 && !f.app.runtime.agents.gpt.busy);
  await f.pump(2000); await f.wait(() => f.calls.length === 3 && !f.app.runtime.agents.gpt.busy);
  const admin = (await f.owner('/api/share')).body;
  assert.deepEqual(admin.guests.map(g => g.usage.used), [1, 1, 1]);
});

test('phase 2: friends toggle emoji reactions with their own id, live and after restart, without AI calls', async t => {
  const f = await fixture(t);
  const before = f.app.store.addMessage({ from: 'claude', text: '입장 전 메시지' });
  const friend = await f.join('반응친구'), other = await f.join('다른반응');
  const owned = f.app.store.addMessage({ from: 'user', text: '방장 메시지' });
  const target = (await f.remote('/api/send', { cookie: other.cookie, body: { text: '친구 메시지' } })).body.messageId;
  const react = (cookie, id, emoji = '😂') => f.remote('/api/react', { cookie, body: { id, emoji } });
  assert.equal((await react(friend.cookie, before.id)).status, 403);
  assert.equal((await react(friend.cookie, target, '🔥')).status, 400);
  const system = f.app.store.messages.find(m => m.from === 'system' && m.id > before.id);
  assert.equal((await react(friend.cookie, system.id)).status, 403);
  assert.equal((await react(friend.cookie, target)).body.on, true);
  assert.equal((await react(other.cookie, target)).body.on, true);
  assert.equal((await react(friend.cookie, owned.id, '❤️')).status, 200);
  const guestId = (await f.owner('/api/share')).body.guests.find(g => g.name === '반응친구').id;
  const state = (await f.remote('/api/state', { cookie: other.cookie })).body;
  assert.equal(state.messages.find(m => m.id === target).reactions['😂'].length, 2);
  assert.ok(state.messages.find(m => m.id === owned.id).reactions['❤️'].includes(`guest:${guestId}`));
  assert.equal((await react(friend.cookie, target)).body.on, false);
  assert.equal((await f.owner('/api/react', { id: target, emoji: '👍' })).body.on, true);
  assert.equal((await f.owner('/api/react', { id: target, emoji: '👍' })).body.on, false);
  assert.equal((await f.owner('/api/react', { id: target, emoji: '👍' })).body.on, true);
  const { Store } = await import('../lib/store.mjs');
  const reloaded = new Store(f.app.store.root).byId.get(target).reactions;
  assert.equal(reloaded['😂'].length, 1); assert.ok(!reloaded['😂'].includes(`guest:${guestId}`));
  assert.deepEqual(reloaded['👍'], ['user']);
  assert.equal(f.calls.length, 0);
  await f.owner('/api/share/access', { permissions: { chat: false } });
  assert.equal((await react(friend.cookie, target)).status, 403);
});

const QUIZ = { questions: [
  { q: '1+1은?', choices: ['2', '3', '4', '5'], answer: 0 }, { q: '하늘색은?', choices: ['파랑', '빨강', '검정', '하양'], answer: 0 },
  { q: '고양이 소리는?', choices: ['야옹', '멍멍', '음메', '꿀꿀'], answer: 0 }, { q: '한 주는 며칠?', choices: ['7일', '5일', '6일', '8일'], answer: 0 },
  { q: '얼음은 무엇이 언 것?', choices: ['물', '모래', '돌', '나무'], answer: 0 }], reaction: '다들 똑똑하네!' };
const playFixture = (t, { quiz = QUIZ, fail = false } = {}) => fixture(t, (id, brief, prompt) => {
  if (!/미니게임 문제/.test(brief)) return { ok: true, text: JSON.stringify({ action: 'pass' }) };
  if (fail) return { ok: false, detail: 'RESOURCE_EXHAUSTED 429' };
  return { ok: true, text: /밸런스게임/.test(prompt)
    ? JSON.stringify({ question: '여행 간다면?', a: '산', b: '바다', reactions: { a: '산파 승리!', b: '바다 최고!', tie: '팽팽하네' } })
    : JSON.stringify(quiz) };
}, { ids: ['claude', 'gpt'] });
const act = (f, cookie, body) => cookie ? f.remote('/api/play', { cookie, body }) : f.owner('/api/play', body);

test('phase 3: chat polls are 1 person 1 vote, live, closable only by creator or owner, persistent and AI-free', async t => {
  const f = await playFixture(t);
  const a = await f.join('투표왕'), b = await f.join('투표러');
  assert.equal((await act(f, a.cookie, { action: 'poll.create', question: '점심?', options: ['국밥'] })).status, 400);
  assert.equal((await act(f, a.cookie, { action: 'poll.create', question: '점심?', options: ['국밥', '국밥'] })).status, 400);
  assert.equal((await act(f, a.cookie, { action: 'poll.create', question: '점심?', options: ['1', '2', '3', '4', '5'] })).status, 400);
  const created = await act(f, a.cookie, { action: 'poll.create', question: '점심 뭐 먹지?', options: ['국밥', '파스타', '초밥'] });
  assert.equal(created.status, 200);
  const id = created.body.id;
  assert.equal((await act(f, a.cookie, { action: 'poll.vote', id, choice: 1, voter: 'ai:claude' })).status, 200);
  assert.equal((await act(f, a.cookie, { action: 'poll.vote', id, choice: 0 })).status, 409);
  assert.equal((await act(f, b.cookie, { action: 'poll.vote', id, choice: 9 })).status, 400);
  assert.equal((await act(f, b.cookie, { action: 'poll.vote', id, choice: 1 })).status, 200);
  assert.equal((await act(f, null, { action: 'poll.vote', id, choice: 2 })).status, 200);
  const live = (await f.remote('/api/state', { cookie: b.cookie })).body.play.polls.find(p => p.id === id);
  assert.deepEqual(live.counts, [0, 2, 1]); assert.equal(live.mine, 1);
  assert.ok(!JSON.stringify(live.voters).includes('ai:'));
  const late = await f.join('늦은친구');
  assert.equal((await f.remote('/api/state', { cookie: late.cookie })).body.play.polls.length, 0);
  assert.equal((await act(f, late.cookie, { action: 'poll.vote', id, choice: 0 })).status, 403);
  assert.equal((await act(f, b.cookie, { action: 'poll.close', id })).status, 403);
  assert.equal((await act(f, a.cookie, { action: 'poll.close', id })).status, 200);
  assert.equal((await act(f, null, { action: 'poll.vote', id, choice: 0 })).status, 409);
  assert.match(f.app.store.messages.at(-1).text, /투표 마감 · 점심 뭐 먹지\? → "파스타" \(2표\) · 총 3표/);
  const timed = (await act(f, null, { action: 'poll.create', question: '영화?', options: ['예', '아니오'], minutes: 1 })).body.id;
  f.tick(60001); f.app.playTick();
  assert.equal(f.app.play.data.polls[timed].status, 'closed');
  assert.equal(f.calls.length, 0, 'polls never call an AI');
  const { Play } = await import('../lib/play.mjs');
  const reloaded = new Play(path.join(f.app.store.root, 'data', 'play.json'));
  assert.deepEqual(reloaded.data.polls[id].result.counts, [0, 2, 1]);
});

test('phase 3: balance game needs owner or a permitted friend, uses one charged content call, one choice each, and posts the result with the AI reaction', async t => {
  const f = await playFixture(t);
  const a = await f.join('밸런스가'), b = await f.join('밸런스나');
  await f.start();
  assert.equal((await act(f, a.cookie, { action: 'game.start', kind: 'balance' })).status, 403);
  await f.owner('/api/share/access', { permissions: { games: true } });
  const started = await act(f, a.cookie, { action: 'game.start', kind: 'balance', topic: '여행' });
  assert.equal(started.status, 200);
  assert.equal((await act(f, b.cookie, { action: 'game.start', kind: 'quiz' })).status, 409, 'one game at a time');
  await f.wait(() => f.app.play.data.games[started.body.id].status === 'open');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.owner('/api/share')).body.guests.find(g => g.name === '밸런스가').usage.used, 1);
  const game = (await f.remote('/api/state', { cookie: b.cookie })).body.play.games.at(-1);
  assert.deepEqual(game.options, ['산', '바다']); assert.equal(game.reactions, undefined);
  for (const [cookie, choice] of [[a.cookie, 1], [b.cookie, 1], [null, 0]])
    assert.equal((await act(f, cookie, { action: 'game.choose', id: game.id, choice })).status, 200);
  assert.equal((await act(f, b.cookie, { action: 'game.choose', id: game.id, choice: 0 })).status, 409);
  assert.equal((await act(f, a.cookie, { action: 'game.end' })).status, 403);
  f.tick(60001); f.app.playTick();
  const tail = f.app.store.messages.slice(-2);
  assert.match(tail[0].text, /산 1표 vs 바다 2표 → "바다" 승!/);
  assert.equal(tail[1].from, f.app.play.data.games[game.id].author); assert.equal(tail[1].text, '바다 최고!'); assert.equal(tail[1].playId, game.id);
  assert.equal(f.app.runtime.store.after(0).some(m => m.playId), false, 'game messages never wake the unmetered engine');
  assert.equal(f.calls.length, 1, 'choices and results never call an AI');
});

test('phase 3: quiz battle hides answers, scores on the server, rejects duplicates, ranks, and falls back to the bank', async t => {
  const f = await playFixture(t);
  const a = await f.join('퀴즈가'), b = await f.join('퀴즈나');
  await f.start();
  const id = (await act(f, null, { action: 'game.start', kind: 'quiz' })).body.id;
  await f.wait(() => f.app.play.data.games[id].status === 'open');
  const stored = f.app.play.data.games[id];
  for (let n = 0; n < 5; n++) {
    const view = (await f.remote('/api/state', { cookie: a.cookie })).body.play.games.at(-1);
    assert.equal(view.index, n); assert.equal(JSON.stringify(view.question).includes('answer'), false);
    assert.equal(view.review.length, n);
    const right = stored.questions[n].answer;
    assert.equal((await act(f, a.cookie, { action: 'game.choose', id, index: n, choice: right })).body.correct, true);
    assert.equal((await act(f, a.cookie, { action: 'game.choose', id, index: n, choice: right })).status, 409);
    if (n < 2) assert.equal((await act(f, b.cookie, { action: 'game.choose', id, index: n, choice: (right + 1) % 4 })).body.correct, false);
    if (n === 3) assert.equal((await act(f, b.cookie, { action: 'game.choose', id, index: n - 1, choice: 0 })).status, 409, 'stale question');
    f.tick(20001); f.app.playTick();
  }
  assert.equal(stored.status, 'ended');
  const view = (await f.remote('/api/state', { cookie: b.cookie })).body.play.games.at(-1);
  assert.deepEqual(view.scores.map(s => s.id), [`guest:${(await f.owner('/api/share')).body.guests.find(g => g.name === '퀴즈가').id}`, view.scores[1].id]);
  assert.equal(view.scores[1].score, 0); assert.equal(view.review.length, 5);
  assert.ok(view.review.every(r => Number.isInteger(r.answer)));
  const tail = f.app.store.messages.slice(-2);
  assert.match(tail[0].text, /1위 퀴즈가 \d+점 · 2위 퀴즈나 0점/); assert.equal(tail[1].text, '다들 똑똑하네!');
  assert.equal(f.calls.length, 1);
  // Owner may stop a running game; a failing AI falls back to reused questions without a reaction.
  const g = await playFixture(t, { fail: true });
  const second = (await act(g, null, { action: 'game.start', kind: 'quiz' })).body.id;
  await g.wait(() => g.app.play.data.games[second].status === 'open');
  assert.equal(g.app.play.data.games[second].questions.length, 5); assert.equal(g.app.play.data.games[second].author, null);
  assert.equal((await act(g, null, { action: 'game.end' })).status, 200);
  assert.match(g.app.store.messages.at(-1).text, /퀴즈 배틀을 종료했어요/);
});

test('phase 3: bookmarks are private per person, limited to visible messages, survive restart and call no AI', async t => {
  const f = await playFixture(t);
  const old = f.app.store.addMessage({ from: 'claude', text: '입장 전 명언' });
  const a = await f.join('북마크가'), b = await f.join('북마크나');
  const funny = f.app.store.addMessage({ from: 'gpt', text: '웃긴 말' });
  assert.equal((await act(f, a.cookie, { action: 'bookmark.toggle', id: old.id })).status, 403);
  assert.equal((await act(f, a.cookie, { action: 'bookmark.toggle', id: funny.id })).body.on, true);
  assert.equal((await act(f, null, { action: 'bookmark.toggle', id: old.id })).body.on, true);
  assert.deepEqual((await f.remote('/api/state', { cookie: a.cookie })).body.play.bookmarks, [funny.id]);
  assert.deepEqual((await f.remote('/api/state', { cookie: b.cookie })).body.play.bookmarks, []);
  assert.deepEqual(f.app.view().play.bookmarks, [old.id]);
  assert.equal((await act(f, a.cookie, { action: 'bookmark.toggle', id: funny.id })).body.on, false);
  assert.equal((await act(f, a.cookie, { action: 'bookmark.toggle', id: funny.id })).body.on, true);
  const { Play } = await import('../lib/play.mjs');
  const reloaded = new Play(path.join(f.app.store.root, 'data', 'play.json'));
  const guestId = (await f.owner('/api/share')).body.guests.find(g => g.name === '북마크가').id;
  assert.deepEqual(reloaded.bookmarks(`guest:${guestId}`), [funny.id]);
  assert.equal(f.calls.length, 0);
});

test('phase 4: a friend edits only their own profile; ids keep old messages linked and prompts use the new name', async t => {
  const f = await fixture(t, () => ({ ok: true, text: JSON.stringify({ action: 'pass' }) }));
  const a = await f.join('옛이름'), b = await f.join('다른친구');
  const first = (await f.remote('/api/send', { cookie: a.cookie, body: { text: '이름 바꾸기 전 메시지' } })).body.messageId;
  const profile = (cookie, body) => f.remote('/api/profile', { cookie, body });
  assert.equal((await profile(a.cookie, { name: '다른친구' })).status, 409);
  assert.equal((await profile(a.cookie, { name: 'Claude' })).status, 400);
  assert.equal((await profile(a.cookie, { name: '방장' })).status, 400);
  assert.equal((await profile(a.cookie, { icon: '<script>' })).status, 400);
  const changed = await profile(a.cookie, { name: '새이름', icon: '🦊' });
  assert.equal(changed.status, 200); assert.equal(changed.body.icon, '🦊');
  assert.equal((await f.owner('/api/profile', { name: '방장도' })).status, 404, 'owner has no friend profile route');
  const state = (await f.remote('/api/state', { cookie: b.cookie })).body;
  const me = state.participants.find(p => p.name === '새이름');
  assert.equal(me.icon, '🦊');
  assert.equal(state.messages.find(m => m.id === first).guestId, me.id);
  assert.match(state.messages.at(-1).text, /옛이름님이 이름을 새이름\(으\)로 바꿨어요/);
  assert.equal((await f.owner('/api/share')).body.guests.find(g => g.id === me.id).name, '새이름');
  const { formatMessage } = await import('../lib/prompt.mjs');
  const line = formatMessage(f.app.store.byId.get(first), 'claude', { userName: '방장', people: { [`guest:${me.id}`]: '새이름' } }, { attached: new Set() });
  assert.match(line, /새이름\(친구\): 이름 바꾸기 전 메시지/);
});

test('phase 4: read positions only move forward and survive restart', async t => {
  const f = await fixture(t);
  const a = await f.join('읽음친구');
  for (let n = 0; n < 3; n++) { f.tick(); await f.owner('/api/send', { text: `메시지 ${n}` }); }
  const last = f.app.store.lastId;
  assert.equal((await f.remote('/api/read', { cookie: a.cookie, body: { id: last } })).body.lastRead, last);
  assert.equal((await f.remote('/api/read', { cookie: a.cookie, body: { id: last - 2 } })).body.lastRead, last);
  assert.equal((await f.remote('/api/read', { cookie: a.cookie, body: { id: last + 999 } })).body.lastRead, last);
  assert.equal((await f.remote('/api/read', { cookie: a.cookie, body: { id: 'x' } })).status, 400);
  assert.equal((await f.remote('/api/state', { cookie: a.cookie })).body.lastRead, last);
  assert.equal((await f.owner('/api/read', { id: last - 1 })).body.lastRead, last - 1);
  assert.equal(f.app.view().lastRead, last - 1);
  const disk = new Sharing(path.dirname(path.dirname(f.app.store.stateFile)));
  assert.equal(Object.values(disk.data.guests)[0].lastRead, last);
  assert.equal(JSON.parse(fs.readFileSync(f.app.store.stateFile, 'utf8')).room.lastRead, last - 1);
});

test('phase 4: missed-chat summary runs only on request, covers only what the reader may see, is metered and fails safely', async t => {
  let fail = false;
  const f = await fixture(t, (id, brief, prompt) => fail ? { ok: false, detail: 'RESOURCE_EXHAUSTED' } : { ok: true, text: '민수와 방장이 저녁 메뉴를 정했어요.' });
  f.app.store.addMessage({ from: 'user', text: '입장 전 비밀 대화' });
  f.app.store.writeNote('claude', '개인 메모 비밀');
  const friend = await f.join('요약친구');
  assert.equal((await f.remote('/api/summary', { cookie: friend.cookie, body: {} })).status, 400, 'nothing missed yet');
  await f.owner('/api/send', { text: '저녁은 치킨으로 하자' });
  f.app.store.addMessage({ from: 'claude', text: '집 기록', kind: 'house-build', mode: 'house' });
  const result = await f.remote('/api/summary', { cookie: friend.cookie, body: {} });
  assert.equal(result.status, 200); assert.match(result.body.summary, /저녁 메뉴/);
  const prompt = f.calls.at(-1)[2];
  assert.match(prompt, /저녁은 치킨으로 하자/); assert.match(prompt, /요약친구님이 자리를 비운 사이/);
  for (const secret of ['입장 전 비밀', '개인 메모', '집 기록']) assert.ok(!prompt.includes(secret), secret);
  assert.equal(f.calls.at(-1)[3].independent, true);
  assert.equal((await f.remote('/api/state', { cookie: friend.cookie })).body.usage.used, 1);
  assert.ok(!f.app.store.messages.some(m => m.text?.includes('저녁 메뉴를 정했')), 'the summary is private to the reader');
  fail = true;
  const failed = await f.remote('/api/summary', { cookie: friend.cookie, body: {} });
  assert.equal(failed.status, 502);
  assert.equal((await f.remote('/api/send', { cookie: friend.cookie, body: { text: '요약 실패해도 채팅 가능' } })).status, 200);
  const guestId = (await f.owner('/api/share')).body.guests[0].id;
  await f.owner('/api/share/limits', { guestId, limit: 2 });
  assert.equal((await f.remote('/api/summary', { cookie: friend.cookie, body: {} })).status, 429);
  await f.owner('/api/share/access', { permissions: { questions: false } });
  assert.equal((await f.remote('/api/summary', { cookie: friend.cookie, body: {} })).status, 403);
  fail = false;
  assert.equal((await f.owner('/api/summary', {})).status, 200, 'owner summary uses the owner path');
});

test('phase 4: web push stores per-person subscriptions for known push services and sends private, deduplicated alerts', async t => {
  const sent = [];
  const f = await fixture(t, () => ({ ok: true, text: JSON.stringify({ action: 'pass' }) }), { pushSend: async (endpoint, headers, body) => { sent.push({ endpoint, headers, body }); return endpoint.includes('gone') ? 410 : 201; } });
  const crypto = await import('node:crypto');
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = (endpoint) => ({ endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } });
  const a = await f.join('알림친구'), b = await f.join('조용친구');
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com:8443/x'])
    assert.equal((await f.owner('/api/push/subscribe', { subscription: sub(endpoint) })).status, 400, endpoint);
  assert.equal((await f.owner('/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/bad', keys: { p256dh: 'x', auth: 'y' } } })).status, 400);
  assert.equal((await f.owner('/api/push/subscribe', { subscription: sub('https://fcm.googleapis.com/fcm/send/owner') })).status, 200);
  assert.equal((await f.remote('/api/push/subscribe', { cookie: b.cookie, body: { subscription: sub('https://updates.push.services.mozilla.com/wpush/v2/gone') } })).status, 200);
  assert.equal(f.app.view().push.subscribed, 1);
  assert.equal((await f.remote('/api/state', { cookie: b.cookie })).body.push.subscribed, 1);
  await f.remote('/api/send', { cookie: a.cookie, body: { text: '아주 비밀스러운 내용' } });
  await f.wait(() => sent.length === 2);
  const toOwner = sent.find(s => s.endpoint.includes('owner'));
  assert.match(toOwner.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(toOwner.headers['Content-Encoding'], 'aes128gcm');
  const body = toOwner.body, salt = body.subarray(0, 16), keyid = body.subarray(21, 86), cipher = body.subarray(86);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const prk = hmac(salt, hmac(hmac(auth, ua.computeSecret(keyid)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), keyid, Buffer.from([1])])));
  const decipher = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12));
  decipher.setAuthTag(cipher.subarray(-16));
  const payload = JSON.parse(Buffer.concat([decipher.update(cipher.subarray(0, -16)), decipher.final()]).subarray(0, -1).toString());
  assert.equal(payload.body, '알림친구님의 새 메시지'); assert.ok(!JSON.stringify(payload).includes('비밀'));
  assert.equal(f.app.push.data.subs[`guest:${(await f.owner('/api/share')).body.guests.find(g => g.name === '조용친구').id}`], undefined, 'a 410 endpoint is removed');
  f.tick(); await f.remote('/api/send', { cookie: a.cookie, body: { text: '또 보냄' } });
  f.tick(); await f.remote('/api/send', { cookie: a.cookie, body: { text: '@방장 이거 봐줘' } });
  await f.wait(() => sent.length === 3);
  assert.equal(sent.at(-1).headers.Urgency, 'high');
  f.tick(40000); f.app.runtime.post({ from: 'claude', text: 'AI 혼잣말' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sent.length, 3, 'chat alerts are collapsed for 30s and AI chatter is off by default');
  await f.owner('/api/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/owner' });
  assert.equal(f.app.view().push.subscribed, 0);
});

test('phase 4: a friend cannot widen the summary range past their entry', async t => {
  const f = await fixture(t, () => ({ ok: true, text: '요약' }));
  f.app.store.addMessage({ from: 'user', text: '입장 전 비밀 대화' });
  const friend = await f.join('범위친구');
  await f.owner('/api/send', { text: '입장 후 대화' });
  assert.equal((await f.remote('/api/summary', { cookie: friend.cookie, body: { since: 0 } })).status, 200);
  assert.ok(!f.calls.at(-1)[2].includes('입장 전 비밀')); assert.match(f.calls.at(-1)[2], /입장 후 대화/);
});

test('with Talk off a friend still gets one answer, with no follow-ups among the members', async t => {
  const f = await fixture(t, (id) => say(id === 'claude' ? { action: 'say', messages: ['@GPT 너도 와'] } : { action: 'pass' }), { ids: ['claude', 'gpt'] });
  const friend = await f.join('토프친구');
  assert.equal(f.app.view().room.auto.on, false);
  assert.equal((await f.remote('/api/send', { cookie: friend.cookie, body: { text: '@Claude 안녕?' } })).status, 200);
  await f.pump(); await f.wait(() => f.app.store.messages.at(-1).from === 'claude');
  for (let i = 0; i < 5; i++) await f.pump();
  assert.equal(f.calls.length, 1, 'one answer and no chain to GPT');
});

test('the join screen learns who invited the friend, only for a valid guest link, without using the invite up', async t => {
  const f = await fixture(t);
  await f.owner('/api/room', { userName: '용빈' });
  const invitation = await f.invite('guest');
  const asked = await f.remote('/api/share/invite-info', { body: { token: invitation.token } });
  assert.equal(asked.status, 200);
  assert.deepEqual(asked.body, { host: '용빈' });
  assert.equal((await f.remote('/api/share/invite-info', { body: { token: 'x'.repeat(43) } })).status, 404);
  const owner = await f.invite('owner');
  assert.equal((await f.remote('/api/share/invite-info', { body: { token: owner.token } })).status, 404, 'an owner pairing link names nobody');
  await f.join('민수');
  assert.equal((await f.remote('/api/share/invite-info', { body: { token: invitation.token } })).status, 200, 'asking did not consume the link');
});
