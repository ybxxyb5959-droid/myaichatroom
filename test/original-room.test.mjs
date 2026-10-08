import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEEDS } from '../lib/original-room.mjs';
import { roomFixture, IDS } from './helpers/room.mjs';
import { run, running } from '../lib/agents.mjs';

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
  assert.deepEqual(s.calls.filter((c) => !c.options.independent).map((c) => c.id), ['claude']);
  await s.advance(6000);
  assert.deepEqual(s.calls.filter((c) => !c.options.independent).map((c) => c.id).sort(), [...IDS].sort());
});

test('unread messages schedule from the reading tick, exactly as upstream, not from an old message timestamp', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'] });
  await s.start(); await s.send('안녕');
  s.clock.now += 100000;
  await s.app.tick(); assert.equal(s.calls.length, 0);
  await s.advance(2000); assert.equal(s.calls.length, 1);
});

test('chat frequency changes spontaneous timing but preserves mention replies and saved selection', async t => {
  for (const frequency of ['quiet', 'lively']) {
    const s = await roomFixture(t, { ids: ['gpt'] });
    await s.start(); await s.advance(); await s.advance(8000);
    const before = s.calls.length;
    assert.equal((await s.post('/api/room', { chatFrequency: frequency })).status, 200);
    s.app.runtime.spark.quick = false; s.app.runtime.spark.base = null;
    await s.advance(115000);
    assert.equal(s.calls.length, before + (frequency === 'lively' ? 1 : 0));
    const count = s.calls.length;
    await s.send('@GPT 질문'); await s.advance(); await s.advance(8000);
    assert.equal(s.calls.length, count + 1);
    await s.reopen();
    assert.equal(s.app.view().room.chatFrequency, frequency);
    assert.equal((await s.post('/api/room', { chatFrequency: 'invalid' })).status, 400);
  }
});

test('normal read, cooldown, per-minute caps and opening silence delays use upstream values', () => {
  assert.deepEqual(SPEEDS.normal, { read: [4, 12], idle: [50, 120], spark: [150, 330], cooldown: 8, perMin: 10, typing: 1 });
  assert.deepEqual(SPEEDS.slow.spark, [300, 600]);
  assert.deepEqual(SPEEDS.fast.spark, [70, 160]);
});

test('a quiet room wakes only one member and a pass increases the next silence delay', async (t) => {
  const s = await roomFixture(t);
  const ordinaryCalls = () => s.calls.filter((call) => !call.options.independent);
  // The first reading of the one-time system welcome is completed without speech.
  await s.start(); await s.advance(); await s.advance(8000);
  assert.equal(s.calls.length, 3);
  s.app.runtime.spark.quick = false;
  s.app.runtime.spark.base = null;
  const before = ordinaryCalls().length;
  await s.advance(240000);
  assert.equal(ordinaryCalls().length, before + 1);
  const starter = ordinaryCalls().at(-1).id;
  const at = s.clock.now;
  await s.advance(383999);
  assert.equal(ordinaryCalls().length, before + 1);
  await s.advance(1);
  assert.equal(ordinaryCalls().length, before + 2);
  assert.notEqual(ordinaryCalls().at(-1).id, starter);
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

test('AI mention and reply_to wake the addressed peer while pass remains an independent choice', async t => {
  const s = await roomFixture(t, { reply: ({ id }) => id === 'claude' ? { action: 'say', messages: ['@GPT 이 의견은 어때?'] }
    : { action: 'pass' } });
  await s.start(); const user = await s.send('시작'); await s.advance(); await s.advance(2000);
  const source = s.app.store.messages.findLast(m => m.from === 'claude');
  assert.ok(source); assert.equal(s.app.runtime.isCalled(source, 'gpt'), true);
  assert.equal(s.app.runtime.isCalled(source, 'gemini'), false);
  await s.advance(); assert.equal(s.app.runtime.agents.gpt.reason, 'urgent');
  s.reply(({ id }) => id === 'gpt' ? { action: 'say', messages: ['후속 답변'], reply_to: source.id } : { action: 'pass' });
  await s.advance(8000);
  const followup = s.app.store.messages.findLast(m => m.from === 'gpt');
  assert.equal(followup.replyTo, source.id);
  assert.equal(s.app.runtime.isCalled(followup, 'claude'), true);
  assert.ok(s.calls.at(-1).prompt.includes(String(user.id)));
});

test('malformed say/pass retries once, reports an error and never becomes a successful pass', async t => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({ ok: true, text: 'broken JSON', ms: 1 }) });
  await s.start(); await s.send('응답해 줘'); await s.advance(); await s.advance(2000);
  assert.equal(s.calls.length, 2);
  assert.equal(s.app.runtime.agents.gpt.fails, 1);
  assert.equal(s.app.view().members.find(m => m.id === 'gpt').health.kind, 'response');
  assert.ok(s.app.store.messages.some(m => m.kind === 'error' && m.errorKind === 'response'));
  assert.ok(!s.app.store.messages.some(m => m.from === 'gpt'));
  await s.advance(1000); assert.equal(s.calls.length, 2);
});

test('ordinary cancellation leaves another CLI process alive until its own signal is cancelled', async t => {
  const s = await roomFixture(t), controller = new AbortController();
  const baseline = running.size;
  const task = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, timeoutMs: 10000 });
  t.after(async () => { controller.abort(); await task; });
  await s.app.runtime.cancel();
  assert.equal(running.size, baseline + 1);
  assert.equal(controller.signal.aborted, false);
  controller.abort(); assert.equal((await task).code, -3);
});

test('a malformed quota recovery probe does not announce a successful return', async t => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({ ok: true, text: 'invalid recovery response', ms: 1 }) });
  s.app.runtime.restForQuota('gpt');
  await s.start(); await s.app.runtime.tick();
  assert.equal(s.calls.length, 2);
  assert.equal(s.app.room.enabled.gpt, false);
  assert.ok(s.app.room.quotaRest.gpt);
  assert.ok(!s.app.store.messages.some(m => m.kind === 'presence' && m.text.includes('들어옴')));
});

test('quiet participation wakes only explicitly called AIs; friend lines read as that friend, never the owner', async (t) => {
  const s = await roomFixture(t, { reply: ({ id }) => ({ action: 'say', messages: [`${id} 답`] }) });
  await s.start();
  assert.equal((await s.post('/api/room', { aiIntensity: 'quiet' })).status, 200);
  s.app.store.addMessage({ from: 'user', guestId: 'g-1', displayName: '민수', text: '친구가 한 말', ts: s.clock.now });
  await s.send('그냥 혼잣말이야');
  await s.advance(); await s.advance(30000); await s.advance(300000);
  assert.equal(s.calls.length, 0, 'no wake, idle or spark turns in quiet mode');
  await s.send('@Claude 너만 와줘');
  await s.advance(); await s.advance(4000);
  assert.deepEqual(s.calls.map((c) => c.id), ['claude']);
  assert.match(s.calls[0].prompt, /민수\(친구\): 친구가 한 말/);
  assert.doesNotMatch(s.calls[0].prompt, /방장: 친구가 한 말/);
  await s.advance(30000);
  assert.deepEqual(s.calls.map((c) => c.id), ['claude']);
  assert.equal((await s.post('/api/room', { aiIntensity: 'normal' })).status, 200);
  await s.send('다들 안녕'); await s.advance(); await s.advance(13000);
  assert.ok(s.calls.length > 1, 'normal mode keeps the original autonomous say/pass');
});
