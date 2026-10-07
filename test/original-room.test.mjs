import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEEDS } from '../lib/original-room.mjs';
import { roomFixture, IDS } from './helpers/room.mjs';

test('ordinary send never picks a representative or calls the retained discussion pipeline', async (t) => {
  const s = await roomFixture(t, { reply: ({ id }) => ({ action: id === 'gpt' ? 'pass' : 'say', messages: [`${id}의 말`] }) });
  await s.start();
  await s.send('안녕');
  assert.equal(s.calls.length, 0);
  await s.advance();
  await s.advance(1999); assert.equal(s.calls.length, 0);
  await s.advance(1);
  assert.deepEqual(s.calls.map((c) => c.id).sort(), [...IDS].sort());
  assert.ok(s.calls.every((c) => !c.options.independent));
  assert.deepEqual(s.app.store.messages.filter((m) => IDS.includes(m.from)).map((m) => m.from).sort(), ['claude', 'gemini']);
});

test('three calls overlap and a new user message does not cancel them', async (t) => {
  const pending = [];
  const s = await roomFixture(t, { reply: (call) => new Promise((resolve) => pending.push({ ...call, resolve })) });
  await s.start(); await s.send('다들 안녕'); await s.advance();
  s.clock.now += 2000;
  const work = s.app.tick();
  assert.equal(pending.length, 3);
  assert.equal(Object.values(s.app.runtime.agents).filter((a) => a.busy).length, 3);
  assert.deepEqual(s.app.view().members.filter((m) => m.typing).map((m) => m.id).sort(), [...IDS].sort());
  await s.send('기다리는 중에도 새 메시지');
  assert.ok(pending.every((p) => !p.options.signal.aborted));
  pending.forEach((p) => p.resolve({ action: 'pass' }));
  await work;
  assert.ok(s.app.view().members.every((m) => !m.typing));
});

test('maxInFlight is a shared ceiling; a free slot can start the third AI without waiting for the second', async (t) => {
  const pending = [];
  const s = await roomFixture(t, { cfg: { maxInFlight: 2 }, reply: (call) => new Promise((resolve) => pending.push({ ...call, resolve })) });
  await s.start(); await s.send('안녕'); await s.advance();
  s.clock.now += 2000;
  const first = s.app.tick();
  assert.equal(pending.length, 2);
  pending[0].resolve({ action: 'pass' });
  await new Promise((resolve) => setImmediate(resolve));
  const next = s.app.tick();
  assert.equal(pending.length, 3);
  assert.equal(pending[1].options.signal.aborted, false);
  pending[1].resolve({ action: 'pass' }); pending[2].resolve({ action: 'pass' });
  await Promise.all([first, next]);
});

test('@mentions accelerate the named member but do not exclude the others', async (t) => {
  const s = await roomFixture(t);
  await s.start(); await s.send('@Claude 안녕'); await s.advance();
  await s.advance(2000);
  assert.deepEqual(s.calls.map((c) => c.id), ['claude']);
  await s.advance(6000);
  assert.deepEqual(s.calls.map((c) => c.id).sort(), [...IDS].sort());
});

test('unread messages schedule from the reading tick, exactly as upstream, not from an old message timestamp', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'] });
  await s.start(); await s.send('안녕');
  s.clock.now += 100000;
  await s.app.tick(); assert.equal(s.calls.length, 0);
  await s.advance(2000); assert.equal(s.calls.length, 1);
});

test('normal read, cooldown, per-minute caps and opening silence delays use upstream values', () => {
  assert.deepEqual(SPEEDS.normal, { read: [4, 12], idle: [50, 120], spark: [150, 330], cooldown: 8, perMin: 10, typing: 1 });
  assert.deepEqual(SPEEDS.slow.spark, [300, 600]);
  assert.deepEqual(SPEEDS.fast.spark, [70, 160]);
});

test('a quiet room wakes only one member and a pass increases the next silence delay', async (t) => {
  const s = await roomFixture(t);
  // The first reading of the one-time system welcome is completed without speech.
  await s.start(); await s.advance(); await s.advance(8000);
  assert.equal(s.calls.length, 3);
  s.app.runtime.spark.quick = false;
  s.app.runtime.spark.base = null;
  const before = s.calls.length;
  await s.advance(240000);
  assert.equal(s.calls.length, before + 1);
  const starter = s.calls.at(-1).id;
  const at = s.clock.now;
  await s.advance(383999);
  assert.equal(s.calls.length, before + 1);
  await s.advance(1);
  assert.equal(s.calls.length, before + 2);
  assert.notEqual(s.calls.at(-1).id, starter);
  assert.equal(s.clock.now - at, 384000);
});

test('stale non-urgent speech is dropped after three new messages, but data actions still execute', async (t) => {
  let resolve;
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => new Promise((r) => { resolve = r; }) });
  await s.start(); await s.advance(); s.clock.now += 8000;
  const turn = s.app.tick();
  for (let i = 0; i < 3; i++) await s.send(`새 메시지 ${i}`);
  resolve({ action: 'say', messages: ['지나간 이야기'], files: [{ op: 'write', path: 'kept.txt', content: '자료 작업' }] });
  await turn;
  assert.ok(!s.app.store.messages.some((m) => m.text === '지나간 이야기'));
  assert.equal(s.app.store.readFile('kept.txt').text, '자료 작업');
});

test('sleep uses the original strict boundary, a message wakes sleeping rooms, and manual OFF stays off', async (t) => {
  const s = await roomFixture(t, { ids: [] });
  await s.post('/api/room', { auto: { on: true, sleepMinutes: 5 } });
  await s.advance(5 * 60000); assert.equal(s.app.view().room.autoSleeping, false);
  await s.advance(1); assert.equal(s.app.view().room.autoSleeping, true);
  await s.send('깨어나'); assert.equal(s.app.view().room.auto.on, true);
  await s.post('/api/room', { auto: { on: false } });
  await s.send('꺼진 방에 기록만'); assert.equal(s.app.view().room.auto.on, false);
});

test('global stop aborts all three replies and drops late speech, notes and buildings', async (t) => {
  const s = await roomFixture(t, { reply: ({ options }) => new Promise((resolve) => options.signal.addEventListener('abort', () =>
    resolve({ action: 'say', messages: ['late'], note_add: 'late', build: [{ op: 'place', at: [1, 1, 1], block: 'gold' }] }), { once: true })) });
  await s.start(); await s.send('안녕'); await s.advance(); s.clock.now += 2000;
  const pending = s.app.tick();
  assert.equal(s.calls.length, 3);
  await s.post('/api/cancel', {}); await pending;
  assert.ok(s.app.view().members.every((m) => !m.typing));
  assert.ok(s.calls.every((c) => c.options.signal.aborted));
  assert.ok(!s.app.store.messages.some((m) => m.text === 'late'));
  assert.ok(IDS.every((id) => s.app.store.readNote(id) === ''));
  assert.equal(s.app.world.blocks.size, 0);
  assert.equal(s.app.view().room.auto.on, false);
});
