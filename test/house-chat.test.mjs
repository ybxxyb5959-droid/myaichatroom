import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';

const DESIGN = { title: '작은 서재', rooms: [{ name: '서재', owner: 'claude', x1: 2, z1: 2, x2: 3, z2: 3, min: 1, uses: [] }], entry: [2, 2] };
const study = (actions = [{ type: 'floor', x1: 2, z1: 2, x2: 3, z2: 3, color: 'wood' }]) => ({ ok: true, text: JSON.stringify({ say: '서재 바닥부터 깔게', actions }) });
const houseCalls = (s) => s.calls.filter((c) => /같이 "집"/.test(c.brief));
// Two members must agree on a design before any floor is laid; agree on one up front.
function approveStudy(s) {
  const h = s.app.house, team = ['claude', 'gpt'];
  h.apply('claude', { say: '이 설계 어때', design: DESIGN, actions: [] }, s.clock.now, team);
  h.apply('gpt', { say: '좋아 이 설계로 하자', designDecision: { id: h.s.planning.pending.id, choice: 'approve' }, actions: [] }, s.clock.now, team);
  h.save();
}
const news = (s) => s.app.store.messages.filter((m) => m.kind === 'house-news').map((m) => m.text);

test('phase 5: an AI proposal in ordinary chat cues the next real house turn, and only real work is announced in chat', async (t) => {
  let reply = () => study();
  const s = await roomFixture(t, { ids: ['claude', 'gpt'], discussionReply: () => reply() });
  await s.start();
  approveStudy(s);
  // House auto-run off: house talk stays talk.
  s.app.runtime.post({ from: 'gpt', text: '@Claude 우리 집 서재 마저 짓자' });
  assert.equal(s.app.houseRuntime.cue, null);
  await s.post('/api/house/active', { active: true });
  s.app.runtime.post({ from: 'gpt', text: '우리 거실 완성됐냐?' });
  assert.equal(s.app.houseRuntime.cue, null, 'a question about the house is not a work cue');
  const before = s.calls.length;
  s.app.runtime.post({ from: 'gpt', text: '@Claude 야 우리 집 서재 마저 짓자 ㅋㅋ' });
  assert.equal(s.calls.length, before, 'a cue never makes an AI call by itself');
  assert.equal(s.app.houseRuntime.cue.from, 'gpt'); assert.equal(s.app.houseRuntime.nextActor, 'claude');
  await s.app.houseRuntime.tick();
  const call = houseCalls(s).at(-1);
  assert.equal(call.id, 'claude');
  assert.match(call.prompt, /\[일반 단톡방에서 나온 집 이야기\]\nChatGPT: "@Claude 야 우리 집 서재 마저 짓자 ㅋㅋ"/);
  assert.equal(news(s)[0], 'ChatGPT의 제안으로 Claude가 집짓기를 시작했어요.');
  // A progress milestone flushes the batch right away instead of waiting for the work unit to end.
  assert.match(news(s)[1], /^Claude 공사 소식 · 바닥 4칸 완료 · 전체 공사 (25|50|75)% 돌파$/);
  assert.equal(news(s).length, 2);
  assert.equal(s.app.houseRuntime.cue, null);
  // Per-turn detail stays out of the chat timeline but is preserved.
  assert.ok(s.app.store.messages.some((m) => m.kind === 'house-build'));
  assert.ok(s.app.store.messages.some((m) => m.kind === 'house-say'));
  assert.ok(!s.app.view().messages.some((m) => ['house-build', 'house-say'].includes(m.kind)));
  assert.ok(!news(s).some((text) => /\d+,\d+/.test(text)), 'no coordinates in chat');
  // Batched: the progress notice waits for the work unit to end.
  s.clock.now += 3 * 60000 + 1; s.app.houseRuntime.buildAt = Infinity;
  await s.app.houseRuntime.tick(); await s.app.houseRuntime.tick();
  assert.equal(news(s).length, 2, 'nothing new to report after the batch was flushed');
  // A turn that changes nothing is never announced as work.
  reply = () => ({ ok: true, text: '{"say":"잠깐 둘러볼게","actions":[]}' });
  s.clock.now += 20 * 60000; s.app.houseRuntime.buildAt = s.clock.now;
  await s.app.houseRuntime.tick();
  assert.equal(news(s).length, 2);
});

test('phase 5: ordinary AIs see a short house status, and house chatter never wakes the ordinary engine', async (t) => {
  const s = await roomFixture(t, { ids: ['claude', 'gpt'], discussionReply: () => study(), reply: () => ({ action: 'pass' }) });
  await s.start(); approveStudy(s);
  await s.post('/api/house/active', { active: true });
  await s.app.houseRuntime.tick();
  assert.ok(s.app.store.messages.some((m) => m.kind === 'house-news'));
  assert.equal(s.app.runtime.store.after(0).some((m) => m.kind?.startsWith('house')), false, 'house talk and news never wake ordinary turns');
  await s.send('다들 뭐해?'); await s.advance(); await s.advance(13000);
  const prompt = s.calls.filter((c) => !c.options.independent).at(-1).prompt;
  assert.match(prompt, /\[우리 집\] 집 자동 실행 켜짐/);
  assert.match(prompt, /@이름으로 동료에게 집짓기를 제안해도 돼/);
  assert.ok(!prompt.includes('서재 바닥부터 깔게'), 'house-only talk stays out of the ordinary prompt');
});

test('phase 5: commands typed in the house screen reach the house log and choose the next builder without an ordinary turn', async (t) => {
  const s = await roomFixture(t, { ids: ['claude', 'gpt'], discussionReply: () => study() });
  await s.start();
  await s.post('/api/house/active', { active: true });
  const sent = await s.post('/api/send', { text: '@ChatGPT 소파는 창가에 놓아줘', mode: 'house' });
  assert.equal(sent.status, 200); assert.equal(sent.value.msg.mode, 'house');
  assert.ok(s.app.house.s.log.some((l) => l.source === 'user' && l.text === '@ChatGPT 소파는 창가에 놓아줘'));
  assert.equal(s.app.runtime.store.after(0).some((m) => m.mode === 'house'), false);
  assert.equal(s.app.houseRuntime.nextActor, 'gpt');
  await s.app.houseRuntime.tick();
  assert.equal(houseCalls(s).at(-1).id, 'gpt');
  assert.match(houseCalls(s).at(-1).prompt, /소파는 창가에 놓아줘/);
});

test('phase 5: a settled house vote announced in chat gets one result notice there', async (t) => {
  const s = await roomFixture(t, { ids: ['claude', 'gpt'], discussionReply: () => ({ ok: true, text: '{"actions":[]}' }) });
  s.app.house.s.floors = { '1,1': 'wood' };
  await s.start();
  s.app.houseRuntime.humans = () => ['owner'];
  await s.post('/api/house/active', { active: true });
  s.app.houseRuntime.buildAt = Infinity;
  await s.app.houseRuntime.tick();
  const pending = s.app.house.s.story.current.id;
  s.app.houseRuntime.ballot('claude', { id: pending, choice: 0 }, true, '정원');
  s.app.houseRuntime.ballot('gpt', { id: pending, choice: 1 }, true, '바비큐');
  const vote = s.app.house.s.story.current;
  assert.ok(s.app.store.messages.some((m) => m.kind === 'house-vote' && m.voteId === vote.id));
  assert.equal((await s.post('/api/house/ballot', { id: vote.id, choice: 1 })).status, 200);
  s.clock.now += 180001; await s.app.houseRuntime.tick(); await s.app.houseRuntime.tick();
  const results = s.app.store.messages.filter((m) => m.kind === 'house-news' && m.voteId === vote.id);
  assert.equal(results.length, 1); assert.match(results[0].text, /^투표 결과/);
  await s.reopen(); s.app.houseRuntime.changed();
  assert.equal(s.app.store.messages.filter((m) => m.kind === 'house-news' && m.voteId === vote.id).length, 1, 'not repeated after restart');
});

test('phase 5: progress is batched per work unit, flushed after five turns or when the unit goes idle', async (t) => {
  const s = await roomFixture(t, { ids: ['claude', 'gpt'] });
  const runtime = s.app.houseRuntime, counts = { floors: 2, walls: 1, doors: 0, placed: 0, moved: 0, removed: 0 };
  for (let n = 0; n < 4; n++) { runtime.reportWork(n % 2 ? 'gpt' : 'claude', counts, [], null); s.clock.now += 1000; }
  assert.deepEqual(news(s), ['Claude가 집짓기를 시작했어요.']);
  runtime.reportWork('gpt', { ...counts, placed: 1 }, [], null);
  assert.equal(news(s).at(-1), 'Claude·ChatGPT 공사 소식 · 바닥 10칸 · 벽 5칸 · 가구 배치 1개 완료');
  runtime.reportWork('claude', { ...counts, moved: 2 }, [], null);
  assert.equal(news(s).length, 2);
  s.clock.now += 3 * 60000 + 1; runtime.buildAt = Infinity;
  await runtime.tick();
  assert.equal(news(s).at(-1), 'Claude·ChatGPT 공사 소식 · 바닥 2칸 · 벽 1칸 · 가구 옮김 2개 완료');
  await runtime.tick();
  assert.equal(news(s).length, 3);
});
