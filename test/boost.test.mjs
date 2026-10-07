import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';

test('original /boost and auto/manual/off routing use the configured stronger model without changing normal settings', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'] });
  const normal = s.app.room.models.gpt.model, stronger = s.cfg.agents.gpt.boost.model;
  await s.start(); await s.post('/api/room', { boostMode: 'manual' });
  await s.turn('@GPT 코드를 작성해줘');
  assert.equal(s.calls.at(-1).options.settings.model, normal);
  await s.turn('/boost @GPT 안녕');
  assert.equal(s.calls.at(-1).options.settings.model, stronger);
  assert.equal(s.app.room.models.gpt.model, normal);
  await s.post('/api/room', { boostMode: 'auto' });
  await s.turn('@GPT 함수를 작성해줘');
  assert.equal(s.calls.at(-1).options.settings.model, stronger);
  await s.post('/api/room', { boostMode: 'off' });
  assert.equal((await s.post('/api/send', { text: '/boost @GPT' })).status, 400);
  await s.turn('@GPT 진지하게 답해줘');
  assert.equal(s.calls.at(-1).options.settings.model, normal);
});

test('original self boost can post a short lead-in, upgrades once and observes its cooldown', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: ({ options }) => options.boost
    ? { action: 'say', messages: ['깊은 답'] } : { action: 'say', messages: ['잠깐 생각할게'], boost: '더 생각해 볼래' } });
  await s.start(); await s.turn('안녕');
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls.map((c) => !!c.options.boost), [false, true]);
  assert.ok(s.app.store.messages.some((m) => m.text === '잠깐 생각할게'));
  assert.ok(s.app.store.messages.some((m) => m.text === '깊은 답' && m.deep));
  await s.turn('이어서');
  assert.equal(s.calls.length, 3);
});

test('a boost failure falls back to normal once, then the ordinary error backoff handles failure', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({ ok: false, detail: 'usage limit reached' }) });
  await s.start(); await s.turn('/boost @GPT 확인');
  assert.deepEqual(s.calls.map((c) => !!c.options.boost), [true, false]);
  assert.equal(s.app.runtime.agents.gpt.fails, 1);
  assert.equal(s.app.runtime.agents.gpt.offlineUntil - s.clock.now, 20000);
  assert.equal(s.app.room.enabled.gpt, true);
});
