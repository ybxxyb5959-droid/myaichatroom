import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';

const notices = (s) => s.app.view().messages.filter((m) => m.kind === 'presence');
const usageFixture = () => {
  const reports = {};
  return { reports, usage: { polling: false, lastPoll: 0, view: () => reports, pollAll: async () => {}, onUpdate: () => {} } };
};

test('manual leave and return are announced once and other AIs see the roster and event', async (t) => {
  const s = await roomFixture(t);
  await s.post('/api/room', { enabled: { gpt: false } });
  await s.post('/api/room', { enabled: { gpt: false } });
  assert.deepEqual(notices(s).map((m) => m.text), ['ChatGPT가 잠깐 나감']);
  await s.start(); await s.turn('클로드 안녕');
  const call = s.calls.find((c) => c.id === 'claude');
  assert.ok(call);
  assert.match(call.prompt, /ChatGPT: 잠깐 나감/);
  assert.match(call.prompt, /ChatGPT가 잠깐 나감/);
  assert.equal(s.calls.some((c) => c.id === 'gpt'), false);
  await s.post('/api/room', { enabled: { gpt: true } });
  await s.post('/api/room', { enabled: { gpt: true } });
  assert.deepEqual(notices(s).map((m) => m.text), ['ChatGPT가 잠깐 나감', 'ChatGPT가 들어옴']);
});

test('quota errors announce departure; successful retry announces return without duplicate exits', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({ ok: false, detail: 'usage limit reached' }) });
  await s.start(); await s.turn();
  const a = s.app.runtime.agents.gpt;
  assert.equal(s.app.room.enabled.gpt, false);
  assert.equal(s.app.room.quotaRest.gpt.autoResume, true);
  assert.deepEqual(notices(s).map((m) => m.text), ['ChatGPT가 잠깐 나감']);
  await s.advance(20000);
  assert.equal(a.fails, 2);
  assert.equal(notices(s).length, 1);
  s.reply(() => ({ action: 'pass' }));
  await s.advance(40000);
  assert.equal(s.app.room.enabled.gpt, true);
  assert.equal(a.fails, 0);
  assert.deepEqual(notices(s).map((m) => m.text), ['ChatGPT가 잠깐 나감', 'ChatGPT가 들어옴']);
});

test('fresh usage exhaustion stops calls; recovery returns members, but never manually disabled ones', async (t) => {
  const { reports, usage } = usageFixture();
  const s = await roomFixture(t, { usage, ids: ['gpt'] });
  reports.gpt = { ok: true, at: s.clock.now, windows: [{ id: '5h', usedPct: 100 }] };
  usage.onUpdate(); usage.onUpdate();
  assert.equal(s.app.room.enabled.gpt, false);
  await s.start(); await s.turn(); await s.advance(300000);
  assert.equal(s.calls.length, 0);
  reports.gpt.at = s.clock.now;
  reports.gpt.windows[0].usedPct = 0;
  usage.onUpdate();
  assert.equal(s.app.room.enabled.gpt, true);
  assert.equal(notices(s).length, 2);
  await s.post('/api/room', { enabled: { gpt: false } });
  usage.onUpdate();
  assert.equal(s.app.room.enabled.gpt, false);
  assert.equal(notices(s).length, 3);
});

test('failed, restored, stale and incomplete reports cannot return a quota-resting member', async (t) => {
  const { reports, usage } = usageFixture();
  const s = await roomFixture(t, { usage });
  reports.gpt = { ok: true, at: s.clock.now, windows: [{ usedPct: 100 }] };
  usage.onUpdate();
  for (const report of [
    { ok: false, at: s.clock.now, windows: [{ usedPct: 0 }] },
    { ok: true, restored: true, at: s.clock.now, windows: [{ usedPct: 0 }] },
    { ok: true, at: s.clock.now - 600000, windows: [{ usedPct: 0 }] },
    { ok: true, at: s.clock.now, windows: [] },
    { ok: true, at: s.clock.now, windows: [{ usedPct: 0 }, { usedPct: 100 }] },
  ]) {
    reports.gpt = report; usage.onUpdate();
    assert.equal(s.app.room.enabled.gpt, false);
  }
  await s.reopen();
  assert.equal(s.app.room.enabled.gpt, false);
  reports.gpt = { ok: true, at: s.clock.now, windows: [{ usedPct: 0 }] };
  usage.onUpdate();
  assert.equal(s.app.room.enabled.gpt, true);
});

test('manual disable during quota rest cancels automatic recovery and probes', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({ ok: false, detail: 'quota exceeded' }) });
  await s.start(); await s.turn();
  await s.post('/api/room', { enabled: { gpt: false } });
  s.reply(() => ({ action: 'pass' }));
  await s.advance(300000);
  assert.equal(s.calls.length, 1);
  assert.equal(s.app.room.enabled.gpt, false);
  assert.equal(notices(s).length, 1);
});

test('non-quota failures retain ordinary retry behavior without departure', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({ ok: false, detail: 'not logged in' }) });
  await s.start(); await s.turn();
  assert.equal(s.app.room.enabled.gpt, true);
  assert.equal(notices(s).length, 0);
  s.reply(() => ({ action: 'pass' }));
  await s.advance(20000);
  assert.equal(s.app.runtime.agents.gpt.fails, 0);
});
