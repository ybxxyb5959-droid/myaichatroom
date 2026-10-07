import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';

test('all call failures use upstream 20/40/80/160/300-second backoff without disabling the member', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], cfg: { spark: { enabled: true, afterSec: [0, 0], backoff: 1.6, maxWaitSec: 1800 } },
    reply: () => ({ ok: false, detail: 'usage limit reached' }) });
  await s.start(); await s.send('안녕'); await s.advance(); await s.advance(2000);
  const a = s.app.runtime.agents.gpt;
  for (let i = 0; i < 7; i++) {
    const gap = Math.min(20000 * 2 ** i, 300000);
    assert.equal(a.fails, i + 1);
    assert.equal(a.offlineUntil - s.clock.now, gap);
    assert.equal(s.app.room.enabled.gpt, true);
    assert.equal(s.app.room.quotaRest, undefined);
    const count = s.calls.length;
    await s.advance(gap - 1); assert.equal(s.calls.length, count);
    await s.advance(1); assert.equal(s.calls.length, count + 1);
  }
});

test('a successful call resets the failure streak; there is no daily auth/usage stop', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], cfg: { spark: { enabled: true, afterSec: [0, 0], backoff: 1.6, maxWaitSec: 1800 } },
    reply: () => ({ ok: false, detail: 'not logged in' }) });
  await s.start(); await s.send('안녕'); await s.advance(); await s.advance(2000);
  assert.equal(s.app.runtime.agents.gpt.fails, 1);
  s.reply(() => ({ action: 'pass' }));
  await s.advance(20000);
  assert.equal(s.app.runtime.agents.gpt.fails, 0);
  assert.equal(s.app.room.auto.usage.stopped, null);
  assert.equal(s.app.room.enabled.gpt, true);
});

test('usage reports remain informational and do not eject or automatically return members', async (t) => {
  const reports = {};
  const usage = { polling: false, lastPoll: 0, view: () => reports, pollAll: async () => {}, onUpdate: () => {} };
  const s = await roomFixture(t, { usage });
  reports.gpt = { ok: true, at: s.clock.now, windows: [{ id: '5h', usedPct: 100, remainingPct: 0 }] };
  usage.onUpdate();
  assert.equal(s.app.room.enabled.gpt, true);
  assert.equal(s.app.room.quotaRest, undefined);
  assert.equal(s.app.view().usage.gpt.windows[0].remainingPct, 0);
  await s.post('/api/room', { enabled: { gpt: false } });
  reports.gpt.windows[0].usedPct = 0; reports.gpt.windows[0].remainingPct = 100;
  usage.onUpdate();
  assert.equal(s.app.room.enabled.gpt, false);
});
