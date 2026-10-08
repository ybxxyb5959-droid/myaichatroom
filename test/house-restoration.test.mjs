import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { roomFixture } from './helpers/room.mjs';
import { House } from '../lib/house.mjs';
import { buildBrief } from '../lib/prompt.mjs';
import { dayKey } from '../lib/auto.mjs';

const home = (store) => {
  const h = new House(path.join(store.dataDir, 'house.json'), { ids: ['claude', 'gpt', 'gemini'], names: {} });
  Object.assign(h.s, { phase: 'life', floors: Object.fromEntries(Array.from({ length: 36 }, (_, i) => [`${i % 6},${Math.floor(i / 6)}`, 'wood'])),
    defs: { 소파: { by: 'gpt', use: 'sit', parts: [{ s: 'box', x: 0, y: 0, z: 0, w: 2, h: .6, d: 1, c: 'blue' }] } },
    items: [{ id: 1, def: '소파', by: 'gpt', x: 2, z: 2, rot: 0 }], nextId: 2,
    events: [{ id: 1, type: 'prank', tone: 'positive', actors: ['claude', 'gpt'], at: 1, text: '기존 집 기록' }], nextEventId: 2 });
  h.save();
  store.state.assistant = { onboarding: { done: true }, tutorial: { done: true } };
};

test('house, characters and diary return without deleting the world, messages or notes; backup is one-time', async (t) => {
  let savedHouse, savedWorld;
  const s = await roomFixture(t, { seed(store) {
    home(store); savedHouse = fs.readFileSync(path.join(store.dataDir, 'house.json'));
    savedWorld = Buffer.from('{"blocks":{"2,1,2":"stone"},"avatars":{},"log":[]}');
    fs.writeFileSync(path.join(store.dataDir, 'world.json'), savedWorld);
    store.addMessage({ from: 'user', text: '이전 대화' }); store.writeNote('gpt', '기억 유지');
  } });
  const backup = s.app.store.state.houseRestoration.backup;
  assert.deepEqual(fs.readFileSync(path.join(backup, 'house.json')), savedHouse);
  assert.deepEqual(fs.readFileSync(path.join(backup, 'world.json')), savedWorld);
  const view = await fetch(s.base + '/api/house').then(r => r.json());
  assert.equal(view.items[0].def, '소파'); assert.equal(view.events[0].text, '기존 집 기록');
  assert.deepEqual(Object.keys(view.agents).sort(), ['claude', 'gemini', 'gpt']);
  assert.ok(view.player);
  const html = await fetch(s.base).then(r => r.text());
  assert.match(html, /id="houseBtn"/); assert.doesNotMatch(html, /id="worldBtn"/);
  assert.equal(s.app.world.blocks.get('2,1,2'), 'stone');
  assert.equal(s.app.store.readNote('gpt'), '기억 유지');
  await s.reopen();
  assert.equal(s.app.store.state.houseRestoration.backup, backup);
  assert.ok(s.app.store.messages.some(m => m.text === '이전 대화'));
  assert.deepEqual(fs.readFileSync(path.join(s.root, 'data', 'world.json')), savedWorld);
});

test('life events progress from conflict to mediation and reconciliation and stay in the house diary', async (t) => {
  const s = await roomFixture(t, { seed: home });
  await s.start();
  await s.post('/api/house/active', { active: true });
  s.app.house.s.open = { eventId: 2, type: 'minor', pair: ['claude', 'gpt'], stage: 'conflict', itemId: 1, text: '소파 배치 갈등',
    ask: { deadline: s.clock.now + 60000, answer: null } };
  const result = await s.post('/api/house/decide', { choice: 'owner', note: '방향을 바꿔 보자', eventId: 2 });
  assert.equal(result.status, 200);
  assert.ok(result.value.events.some(e => e.type === 'owner'));
  assert.equal(s.calls.length, 0);
  s.app.houseRuntime.eventAt = s.clock.now;
  s.app.houseRuntime.buildAt = Infinity;
  s.app.houseRuntime.lifeTick();
  assert.equal(s.app.house.s.open, null);
  assert.equal(s.app.house.s.events.at(-1).type, 'reconcile');
  assert.ok(s.app.store.messages.some(m => m.kind === 'house-event' && m.houseEvent.id));
  await s.reopen();
  assert.equal(s.app.house.s.events.at(-1).type, 'reconcile');
});

test('house construction uses its own prompt and counted calls; OFF and regular chat remain unchanged', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], discussionReply: () => ({ ok: true, text: JSON.stringify({
    say: '서재부터 지어 볼게',
    design: { title: '작은 서재부터', rooms: [{ name: '서재', owner: 'gpt', x1: 2, z1: 2, x2: 3, z2: 3, min: 1, uses: [] }], entry: [2, 2] },
    actions: [{ type: 'floor', x1: 2, z1: 2, x2: 3, z2: 3, color: 'wood' }],
  }) }) });
  const brief = buildBrief('gpt', s.cfg);
  await s.advance(60001);
  assert.equal(s.calls.length, 0);
  await s.start();
  await s.post('/api/house/continue-solo', {});
  await s.app.houseRuntime.tick();
  assert.equal(s.calls.length, 1); assert.match(s.calls[0].brief, /같이 "집"/);
  assert.equal(s.app.store.state.houseUsage.calls, 1);
  assert.equal(s.app.room.auto.usage.calls, 1);
  assert.equal(Object.keys(s.app.house.s.floors).length, 4);
  assert.ok(s.app.store.messages.some(m => m.kind === 'house-build'));
  assert.ok(s.app.store.messages.some(m => m.kind === 'house-say' && m.text === '서재부터 지어 볼게'));
  assert.equal(buildBrief('gpt', s.cfg), brief);
  await s.post('/api/room', { auto: { on: false } });
  await s.post('/api/house/active', { active: false });
  const saved = fs.readFileSync(s.app.house.file);
  await s.advance(2 * 3600000);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(fs.readFileSync(s.app.house.file), saved);
});

test('building and decorating continue beyond former daily caps with the current sequential scheduler', async (t) => {
  for (const [level, previousCap] of [['low', 3], ['medium', 12], ['high', 100]]) {
    for (const phase of ['build', 'life']) {
      await t.test(`${level}: ${phase}`, async (t) => {
        const s = await roomFixture(t, { ids: ['gpt'], cfg: { house: { level } },
          discussionReply: () => ({ ok: true, text: '{"actions":[]}' }) });
        await s.start();
        await s.post('/api/house/continue-solo', {});
        s.app.house.s.phase = phase;
        s.clock.now += 60001;
        s.app.store.state.houseUsage = { day: dayKey(s.clock.now), calls: previousCap };
        await s.app.houseRuntime.tick();
        assert.equal(s.calls.length, 1);
        assert.equal(s.app.store.state.houseUsage.calls, previousCap + 1);
        s.clock.now++;
        await s.app.houseRuntime.tick();
        assert.equal(s.calls.length, 2);
        assert.equal(s.app.store.state.houseUsage.calls, previousCap + 2);
        assert.equal(s.app.room.auto.usage.calls, 2, 'calls remain counted without imposing a cap');
      });
    }
  }
});

test('stopping ordinary chat leaves house work intact; house OFF cancels its own call and refuses late changes', async (t) => {
  let finished = false;
  const s = await roomFixture(t, { ids: ['gpt'], discussionReply: (call) => new Promise(resolve => {
    call.options.signal.addEventListener('abort', () => {
      finished = true;
      resolve({ ok: true, text: '{"actions":[{"type":"floor","x1":2,"z1":2,"x2":3,"z2":3,"color":"wood"}]}' });
    }, { once: true });
  }) });
  await s.start(); await s.post('/api/house/continue-solo', {}); s.clock.now += 60001;
  const pending = s.app.houseRuntime.tick();
  assert.equal(s.calls.length, 1);
  await s.post('/api/room', { auto: { on: false } });
  assert.equal(finished, false);
  assert.equal(s.app.houseRuntime.running(), true);
  await s.post('/api/house/active', { active: false });
  await pending;
  assert.equal(finished, true);
  assert.equal(Object.keys(s.app.house.s.floors).length, 0);
});

test('house activation is explicit and persisted, and house-only history never enters ordinary prompts', async t => {
  const s = await roomFixture(t, { discussionReply: () => ({ ok: true, text: '{"actions":[]}' }) });
  await s.start(); await s.app.houseRuntime.tick();
  assert.equal(s.calls.length, 0); assert.equal(s.app.houseRuntime.view().active, false);
  s.app.store.addMessage({ from: 'claude', kind: 'house-say', text: 'HOUSE-PRIVATE' });
  s.app.store.addMessage({ from: 'system', kind: 'house-build', text: 'HOUSE-BUILD' });
  s.app.store.addMessage({ from: 'claude', mode: 'discussion', phase: 'review', text: 'DEBATE-PRIVATE' });
  s.app.store.writeNote('gpt', 'KEEP-MEMORY');
  s.app.house.s.log.push({ kind: 'say', id: 'user', speechId: 'chat-100', text: 'OLD-NORMAL-MIRROR' });
  assert.ok(!s.app.house.prompt('gpt').includes('OLD-NORMAL-MIRROR'));
  assert.ok(s.app.house.s.log.some(m => m.text === 'OLD-NORMAL-MIRROR'));
  await s.send('NORMAL-QUESTION'); await s.app.runtime.tick(); s.clock.now += 2000; await s.app.runtime.tick();
  for (const c of s.calls) {
    assert.ok(!c.prompt.includes('HOUSE-PRIVATE')); assert.ok(!c.prompt.includes('HOUSE-BUILD'));
    assert.ok(!c.prompt.includes('DEBATE-PRIVATE'));
  }
  assert.ok(s.calls.find(c => c.id === 'gpt').prompt.includes('KEEP-MEMORY'));
  assert.ok(!s.app.house.s.log.some(m => m.text.includes('NORMAL-QUESTION')));
  await s.post('/api/house/active', { active: true }); await s.reopen();
  assert.equal(s.app.houseRuntime.view().active, true);
  assert.ok(s.app.store.messages.some(m => m.text === 'HOUSE-PRIVATE'));
  await s.post('/api/house/active', { active: false });
  const before = s.calls.length; await s.app.houseRuntime.tick(); assert.equal(s.calls.length, before);
});

test('house work owns its controller and slot while the same AI answers ordinary chat with maxInFlight one', async t => {
  let release;
  const s = await roomFixture(t, { ids: ['gpt'], cfg: { maxInFlight: 1 },
    reply: () => ({ action: 'say', messages: ['일반 채팅 응답'] }),
    discussionReply: ({ options }) => new Promise(resolve => {
      release = resolve;
      options.signal.addEventListener('abort', () => resolve({ ok: true, text: '{"actions":[]}' }), { once: true });
    }) });
  await s.start(); await s.post('/api/house/continue-solo', {});
  const house = s.app.houseRuntime.tick(), signal = s.calls[0].options.signal;
  assert.equal(s.app.runtime.agents.gpt.busy, false);
  await s.send('집짓기 중 질문'); await s.app.runtime.tick(); s.clock.now += 2000; await s.app.runtime.tick();
  assert.ok(s.app.store.messages.some(m => m.text === '일반 채팅 응답'));
  assert.equal(s.calls.filter(c => c.options.usageKind === 'house').length, 1);
  await s.post('/api/cancel', {}); assert.equal(signal.aborted, false);
  assert.equal(s.app.houseRuntime.running(), true);
  release({ ok: true, text: '{"say":"HOUSE-FOLLOWUP","actions":[]}' }); await house;
  const again = s.app.houseRuntime.tick();
  assert.equal(s.calls.filter(c => c.options.usageKind === 'house').length, 2);
  await s.app.houseRuntime.cancel(); await again;
  assert.equal(s.app.runtime.agents.gpt.controller.signal.aborted, true);
});
