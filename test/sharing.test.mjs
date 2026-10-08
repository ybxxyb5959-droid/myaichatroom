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

async function fixture(t, chat, { ids = ['claude'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharing-http-'));
  let now = new Date(2026, 9, 8, 12).getTime(), proxy, stopped = 0;
  const calls = [];
  const tunnel = async target => { proxy = target; return { url: 'https://room.example.ts.net:8443', stop: async () => { stopped++; } }; };
  const app = createAssistantServer({ root, cfg: loadConfig(path.join(root, 'config.json')), clock: () => now, autoTickMs: 3600000,
    adapter: { available: () => Object.fromEntries(['claude', 'gpt', 'gemini'].map(id => [id, ids.includes(id)])),
      chat: async (...args) => { calls.push(args); return chat ? chat(...args) : { ok: true, text: '친구 답변입니다.' }; } },
    tailscaleServe: tunnel, tailscaleFunnel: tunnel });
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
  return { app, owner, remote, invite, join, calls, wait, tick: (ms = 1100) => { now += ms; },
    start: () => owner('/api/room', { auto: { on: true, sleepMinutes: 0 } }),
    pump: (ms = 2100) => { now += ms; return app.tickGuestReplies(); },
    proxy: () => proxy, stopped: () => stopped };
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
  assert.equal(initial.members[0].maker, 'Anthropic');
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
  const page = (await f.remote('/', { cookie })).text;
  assert.match(page, /\/style.css/); assert.match(page, /\/assistant.css/);
  assert.match(page, /id="themeBtn"/); assert.match(page, /id="guestForm"/);
  assert.doesNotMatch(page, /id="(?:powerBtn|chatterBtn|taskBtn|wsBtn|shareBtn)"/);
  for (const asset of ['/style.css', '/assistant.css', '/format.mjs', '/avatars/claude-pixel-128.png',
    '/avatars/gpt-pixel-128.png', '/avatars/gemini-pixel-128.png']) {
    assert.equal((await f.remote(asset, { cookie })).status, 200, asset);
    assert.equal((await f.remote(asset)).status, 401, asset);
  }
  for (const asset of ['/assistant.js', '/task-screen.js', '/avatars/dev.svg', '/ws/private.txt'])
    assert.equal((await f.remote(asset, { cookie })).status, 403, asset);
  await f.owner('/api/share/disconnect', {}); await f.wait(() => f.stopped() === 1);
  await f.owner('/api/share/connect', { public: true });
  for (const asset of ['/style.css', '/assistant.css', '/format.mjs', '/avatars/claude-pixel-128.png'])
    assert.equal((await f.remote(asset, { cookie })).status, 200, asset);
  for (const route of ['/assistant.js', '/api/room', '/api/tasks', '/api/share'])
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
    '/api/notes', '/api/models', '/api/check/call', '/api/dev/state', '/api/house', '/api/world',
    '/api/tasks', '/api/tasks/ai', '/api/tasks/attachments', '/api/tasks/events', '/task-screen.js', '/assistant.js', '/api/file?path=secret.txt', '/ws/private.html'];
  for (const route of blocked) {
    assert.equal((await f.remote(route, { cookie })).status, 403, route);
    assert.equal((await f.remote(route, { cookie: privateOwner.cookie, body: {} })).status, 403, route);
  }
  assert.match((await f.remote('/', { cookie })).text, /guestForm/);
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
        try { assert.match(chunk.toString(), /"role":"guest"/); assert.doesNotMatch(chunk.toString(), /"checks":|"files":/); res.destroy(); resolve(); }
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
  assert.equal(f.app.runtime.store.recent(100).some(m => m.guestId), false);
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
