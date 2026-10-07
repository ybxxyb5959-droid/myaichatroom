import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog, ACTIVITY_MAX } from '../lib/activity.mjs';
import { pickPrimary } from '../lib/callpick.mjs';
import { AUTO_BRIEF, LEVELS } from '../lib/auto.mjs';
import { HOUSE_BRIEF } from '../lib/house.mjs';
import { IDS as ORDER } from '../lib/discussion.mjs';
import { createAssistantServer, loadConfig } from '../server.mjs';

const IDS = ['gemini', 'gpt', 'claude'];
const temp = (t, name) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), name)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const DAY = 86400000;

test('the activity log keeps one-line entries with refs, newest first, capped by count and age', (t) => {
  const dir = temp(t, 'activity-');
  const clock = { t: Date.UTC(2026, 9, 7) };
  const file = path.join(dir, 'activity.json');
  const log = new ActivityLog(file, { clock: () => clock.t, max: 5, days: 30 });
  for (let i = 0; i < 7; i++) log.add({ kind: 'chat', actors: [i % 2 ? 'gpt' : 'claude'], text: `답변 ${i}\n두 줄`, ref: { messageId: i } });
  assert.deepEqual(log.list().map((e) => e.text), ['답변 6 두 줄', '답변 5 두 줄', '답변 4 두 줄', '답변 3 두 줄', '답변 2 두 줄']);
  assert.deepEqual(log.list({ actor: 'gpt' }).map((e) => e.ref.messageId), [5, 3]);
  assert.throws(() => log.add({ kind: 'unknown', text: 'x' }), /알 수 없는 활동/);
  assert.equal(log.add({ kind: 'task', text: 'x'.repeat(500) }).text.length, 160);
  clock.t += 31 * DAY;
  log.add({ kind: 'house', actors: ['gemini'], text: '책상 배치' });
  assert.deepEqual(log.list().map((e) => e.kind), ['house'], 'entries older than 30 days are dropped');
  const reloaded = new ActivityLog(file, { clock: () => clock.t });
  assert.equal(reloaded.list()[0].text, '책상 배치');
  assert.equal(reloaded.add({ kind: 'system', text: 'next' }).id, log.list()[0].id + 1);
  assert.equal(ACTIVITY_MAX, 500);
  fs.writeFileSync(file, '{broken');
  const fresh = new ActivityLog(file, { clock: () => clock.t });
  assert.equal(fresh.list().length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('activity.json.unreadable-')), 'an unreadable file is kept aside, never overwritten');
});

test('the automatic pick uses rules only: continuity, the chosen AI, usage headroom; nearly-out AIs are avoided', () => {
  const quota = { claude: { known: true, pct: 10, low: true }, gpt: { known: true, pct: 70, low: false }, gemini: { known: false } };
  assert.deepEqual(pickPrimary({ candidates: IDS, text: '안녕', recent: ['gemini', 'gpt'], quota }), { id: 'gemini', reason: '최근 대화를 이어서' });
  assert.equal(pickPrimary({ candidates: IDS, text: '안녕', recent: ['claude'], selected: 'claude', quota }).id, 'gpt', 'a nearly-out AI is skipped; then the most headroom wins (unknown counts as the middle, 50)');
  assert.equal(pickPrimary({ candidates: ['claude', 'gemini'], text: '안녕', selected: 'claude', quota }).id, 'gemini', 'unknown usage is not treated as nearly out');
  assert.deepEqual(pickPrimary({ candidates: IDS, text: '안녕', selected: 'gpt', quota }), { id: 'gpt', reason: '기본으로 고른 AI' });
  const heavy = pickPrimary({ candidates: IDS, text: '이 함수 리팩터링 코드 짜줘', recent: ['gemini'], selected: 'gemini', quota });
  assert.equal(heavy.id, 'gpt'); assert.match(heavy.reason, /사용량 여유/);
  assert.equal(pickPrimary({ candidates: ['claude'], text: '안녕', quota }).id, 'claude', 'if everyone is nearly out, someone still answers');
  assert.equal(pickPrimary({ candidates: IDS, text: '코드 고쳐줘', selected: 'claude', quota: {} }).id, 'claude', 'with no usage data the chosen AI wins the tie');
  assert.equal(pickPrimary({ candidates: [], text: '안녕' }), null);
});

function chatAdapter() {
  const calls = [];
  return { calls, available: () => Object.fromEntries(IDS.map((id) => [id, true])), loginStatus: async () => ({ status: 'ok' }),
    chat: async (id, brief, prompt, opts) => {
      calls.push({ id, auto: brief.startsWith(AUTO_BRIEF), house: brief.startsWith(HOUSE_BRIEF), prompt });
      if (brief.startsWith(HOUSE_BRIEF)) return { ok: true, text: JSON.stringify({ say: '바닥부터 깔자', actions: [{ type: 'floor', x1: 2, z1: 2, x2: 3, z2: 3, color: 'wood' }] }) };
      return { ok: true, text: `${id} 답변\n[대화유형] 작업` };
    } };
}
async function start(t, { usage = null, autoTickMs = 3600000, clock = { t: new Date(2026, 9, 7, 10).getTime() }, root } = {}) {
  root ??= temp(t, 'activity-app-');
  const adapter = chatAdapter();
  const app = createAssistantServer({ root, cfg: { ...loadConfig(), autoSleepMinutes: 0 }, adapter, usage, greetings: false,
    clock: () => clock.t, random: () => 0.5, autoTickMs, pairDelayMs: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, body) => (await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const get = async (route) => (await fetch(url + route)).json();
  const send = async (text) => { const before = adapter.calls.length; await post('/api/send', { text }); await app.active?.done; return adapter.calls.slice(before).map((c) => c.id); };
  return { app, adapter, post, get, send, clock, root };
}
const fakeUsage = (pcts) => ({ polling: false, lastPoll: Date.now(), onUpdate: () => {}, pollAll: async () => {},
  view: () => Object.fromEntries(Object.entries(pcts).map(([id, used]) => [id, { ok: true, at: Date.now(), windows: [{ id: '5h', usedPct: used, remainingPct: 100 - used }] }])) });

test('💬 자동 calls one AI, 👥 모두 everyone, 🎯 지정 and @mentions only the named AI', async (t) => {
  const s = await start(t);
  await s.post('/api/check/login', {});
  assert.equal((await s.get('/api/state')).room.callMode, 'auto');
  const one = await s.send('Promise가 뭐야? 설명해줘');
  assert.equal(one.length, 1, 'a plain question calls one AI, not all three');
  const userMsg = s.app.store.messages.filter((m) => m.from === 'user').at(-1);
  assert.equal(userMsg.autoPick.id, one[0]);
  assert.deepEqual(await s.send('고마워'), [one[0]], 'the next light message continues with the same AI');
  assert.deepEqual((await s.send('다들 어때?')).sort(), [...IDS].sort());
  assert.deepEqual(await s.send('@지피티 알려줘'), ['gpt']);
  assert.equal((await s.post('/api/room', { callMode: 'loud' })).error, '호출 방식을 확인하세요.');
});

test('who answers: names and nicknames, room-wide phrases, one smart pick, and a short-lived conversation partner', async (t) => {
  const s = await start(t);
  await s.post('/api/check/login', {});
  const ids = async (text) => (await s.send(text)).sort();
  assert.deepEqual(await ids('지피티야 설명해줘'), ['gpt']);
  assert.deepEqual(await ids('젬짱 이 사진 봐줘'), ['gemini']);
  assert.deepEqual(await ids('클로드야 이거 설명해줘'), ['claude']);
  assert.deepEqual(await ids('GPT랑 Claude 둘이 이거 봐줘'), ['claude', 'gpt']);
  assert.deepEqual(await ids('제미나이랑 클로드 의견 궁금해'), ['claude', 'gemini']);
  assert.deepEqual(await ids('GPT, 제미니야, 클로드야 다들 봐'), [...IDS].sort());
  assert.deepEqual(await ids('얘들아 이거 어떻게 생각해?'), [...IDS].sort());
  assert.deepEqual(await ids('각자 의견 하나씩 줘'), [...IDS].sort());
  assert.deepEqual(await ids('@모두 안녕'), [...IDS].sort());
  assert.equal((await ids('모두 파일 삭제해줘')).length, 1, 'a plain "모두" is not a room-wide call');
  assert.equal((await ids('GPTest 결과 알려줘')).length, 1, 'a name inside another word is not a call');
  // The AI called by name keeps the conversation for follow-ups, even when the question is heavy …
  assert.deepEqual(await ids('지피티야 Promise 설명해줘'), ['gpt']);
  assert.deepEqual(await ids('그럼 async/await이랑 뭐가 달라?'), ['gpt']);
  assert.deepEqual(await ids('이 함수 리팩터링 코드 짜줘'), ['gpt']);
  // … until someone else is called, or too much time has passed.
  assert.deepEqual(await ids('클로드야 너는?'), ['claude']);
  assert.deepEqual(await ids('고마워'), ['claude']);
  s.clock.t += 16 * 60000;
  assert.deepEqual(await ids('젬짱 안녕'), ['gemini']);
  s.clock.t += 16 * 60000;
  const after = await ids('이 함수 리팩터링 코드 짜줘');
  assert.equal(after.length, 1);
  // A nickname the user gives is remembered.
  assert.equal((await ids('클로드를 클롱이라고 부를게')).length, 1); // saying it is not itself a call
  assert.deepEqual(await ids('클롱아 안녕'), ['claude']);
  assert.deepEqual((await s.get('/api/state')).room.aliases.claude, ['클롱']);
});

test('a builder that @mentions a teammate in its house line hands the next turn to them, in the chat too', async (t) => {
  const clock = { t: new Date(2026, 9, 7, 10).getTime() };
  const s = await start(t, { clock, autoTickMs: 25 });
  await s.post('/api/check/login', {});
  const original = s.adapter.chat;
  s.adapter.chat = async (id, brief, prompt, opts) => {
    const base = await original(id, brief, prompt, opts);
    if (!brief.startsWith(HOUSE_BRIEF)) return base;
    // The first builder calls the teammate who would NOT be next in the usual turn order.
    const first = s.adapter.calls.filter((c) => c.house).length === 1;
    if (first) { picked.builder = id; picked.target = ORDER[(ORDER.indexOf(id) + 2) % ORDER.length]; }
    return { ok: true, text: JSON.stringify({ say: first ? `@${{ claude: 'Claude', gpt: 'GPT', gemini: 'Gemini' }[picked.target]} 벽을 이어서 부탁해` : '좋아', actions: [] }) };
  };
  const picked = {};
  await s.post('/api/room', { auto: { on: true } });
  clock.t += 2 * 60000;
  for (let i = 0; i < 40 && !s.adapter.calls.some((c) => c.house); i++) await new Promise((r) => setTimeout(r, 25));
  clock.t += 2 * 60 * 60000;
  for (let i = 0; i < 40 && s.adapter.calls.filter((c) => c.house).length < 2; i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(s.adapter.calls.filter((c) => c.house).map((c) => c.id).slice(0, 2), [picked.builder, picked.target], 'the @mentioned teammate builds next, not the next in turn');
  const lines = s.app.store.messages.filter((m) => m.kind === 'house-say');
  assert.match(lines[0].text, /^@\w+ 벽을 이어서 부탁해$/); assert.equal(lines[0].from, picked.builder); assert.equal(lines[0].auto, 'house');
});

test('nobody is @called in the house chat who is resting; the prompt names who is resting', async (t) => {
  const clock = { t: new Date(2026, 9, 7, 10).getTime() };
  const s = await start(t, { clock, autoTickMs: 25, usage: fakeUsage({ claude: 95, gpt: 10, gemini: 10 }) }); // Claude has 5% left
  await s.post('/api/check/login', {});
  const original = s.adapter.chat;
  s.adapter.chat = async (id, brief, prompt, opts) => {
    const base = await original(id, brief, prompt, opts);
    if (!brief.startsWith(HOUSE_BRIEF)) return base;
    return { ok: true, text: JSON.stringify({ say: '@Claude 러그 깔아줘', actions: [] }) };
  };
  await s.post('/api/room', { auto: { on: true } });
  clock.t += 2 * 60000;
  for (let i = 0; i < 40 && !s.adapter.calls.some((c) => c.house); i++) await new Promise((r) => setTimeout(r, 25));
  clock.t += 2 * 60 * 60000;
  for (let i = 0; i < 40 && s.adapter.calls.filter((c) => c.house).length < 2; i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 50));
  const turns = s.adapter.calls.filter((c) => c.house);
  assert.ok(turns.length >= 2 && turns.every((c) => c.id !== 'claude'), 'a resting AI is not asked to build');
  assert.match(turns[0].prompt, /지금 쉬는 동료\(@로 부르지 않는다\): .*Claude/);
  const lines = s.app.store.messages.filter((m) => m.kind === 'house-say');
  assert.ok(lines.every((m) => !m.text.includes('@Claude')), 'the @ is dropped, the name stays as plain text');
});

// A casual answer: every normal answer is tagged 잡담; the chime-in turn (prompt has "[끼어들기 턴]") answers by `chime`.
function casual(s, chime) {
  const original = s.adapter.chat;
  s.adapter.chat = async (id, brief, prompt, opts) => {
    const base = await original(id, brief, prompt, opts); // records the call
    if (prompt.includes('[끼어들기 턴]')) return { ok: true, text: chime(id) };
    return { ok: true, text: `${id} 답변\n[대화유형] 잡담` };
  };
}
const aiTexts = (s) => s.app.store.messages.filter((m) => IDS.includes(m.from));

test('활동량 높음: the others react in a wave after a casual answer (or pass); 낮음/보통 stay quiet at this dice; no wave for names or work', async (t) => {
  const s = await start(t);
  await s.post('/api/check/login', {});
  casual(s, (id) => `${id}도 한마디 @방장 어때?`);
  // random is fixed at 0.5: 조용히 (30%) and 보통 (45%) stay quiet, 활발하게 (70%) sets off a wave.
  assert.equal((await s.send('오늘 날씨 좋다')).length, 1);
  await s.post('/api/room', { auto: { level: 'medium' } });
  assert.equal((await s.send('오늘 날씨 좋다')).length, 1);
  await s.post('/api/room', { auto: { level: 'high' } });
  s.clock.t += 120000;
  assert.equal((await s.send('점심 뭐 먹지')).length, 3, 'one answer, then the other two AIs react (one call each)');
  const [first, second, third] = aiTexts(s).slice(-3);
  assert.deepEqual([first.from, second.from, third.from].sort(), [...IDS].sort());
  assert.equal(second.replyTo, first.id); assert.equal(third.replyTo, second.id);
  assert.equal(second.interjected, true);
  assert.match(second.text, /@방장/);
  assert.ok(s.adapter.calls.at(-1).prompt.includes(`${second.from}:`), 'a reaction reads the lines before it');
  // Pacing: an AI that just spoke waits, and a minute holds at most 8 AI lines.
  s.clock.t += 10000;
  assert.equal((await s.send('이어서 얘기하자')).length, 3);
  s.clock.t += 10000;
  const paced = await s.send('계속 얘기하자');
  assert.ok(paced.length >= 1 && paced.length < 3, `the per-minute cap stops the wave early (${paced.length})`);
  assert.ok(aiTexts(s).filter((m) => m.ts > s.clock.t - 60000).length <= 8);
  // Passing is not a failure: nothing is shown and no error is posted.
  s.clock.t += 120000;
  casual(s, () => '{"action":"pass"}');
  const before = s.app.store.messages.length;
  assert.equal((await s.send('오늘은 쉬는 날이야')).length, 3, 'everyone was asked');
  assert.equal(s.app.store.messages.length - before, 2, 'but only the user line and the first answer are shown');
  assert.ok(!s.app.store.messages.some((m) => m.kind === 'error'));
  // Named calls, heavy work and work-tagged answers never set off a wave.
  s.clock.t += 120000;
  casual(s, (id) => `${id}도 한마디`);
  assert.equal((await s.send('클로드야 안녕')).length, 1);
  assert.equal((await s.send('이 함수 리팩터링 코드 짜줘')).length, 1);
  s.adapter.chat = async (id) => { s.adapter.calls.push({ id, prompt: '' }); return { ok: true, text: `${id} 답변\n[대화유형] 작업` }; };
  s.clock.t += 120000;
  assert.equal((await s.send('날씨 흐리네')).length, 1);
});

test('활발하게: reactions and spontaneous calls skip AIs with under 40% usage left; the cap is 200 a day', async (t) => {
  const s = await start(t, { usage: fakeUsage({ claude: 20, gpt: 70, gemini: 70 }) }); // left: claude 80%, gpt 30%, gemini 30%
  await s.post('/api/check/login', {});
  casual(s, () => '한마디');
  await s.post('/api/room', { auto: { level: 'high' } });
  assert.deepEqual(await s.send('오늘 날씨 좋다'), ['claude'], 'the others have under 40% left, so nobody reacts');
  const view = (await s.get('/api/state')).room;
  assert.equal(view.autoDaily, 200);
  assert.equal(view.autoReady, true, 'Claude (80% left) can still talk freely');
  await s.post('/api/room', { auto: { level: 'medium' } });
  assert.equal((await s.get('/api/state')).room.autoReady, true);
  const lowOnly = await start(t, { usage: fakeUsage({ claude: 70, gpt: 70, gemini: 70 }) });
  await lowOnly.post('/api/check/login', {});
  assert.equal((await lowOnly.get('/api/state')).room.autoReady, true, 'at 30% left the usual levels still talk');
  await lowOnly.post('/api/room', { auto: { level: 'high' } });
  assert.equal((await lowOnly.get('/api/state')).room.autoReady, false, 'everyone is under 40%: nobody starts a call in 활발하게');
});

test('an AI name that is only the topic is not a call; addressing forms still are', async () => {
  const { parseCall } = await import('../public/recipients.mjs');
  const named = (text, custom) => parseCall(text, custom).named;
  for (const topic of ['GPT가 뭐야?', 'Claude와 GPT 차이는?', 'Gemini API 설명해줘', 'Claude는 누가 만들었어?', '이건 GPT야?', '지피티 요금 알려줘',
    'Claude 3 모델 비교', 'GPT 너무 비싸다', 'Gemini랑 GPT 중에 뭐가 나아?', 'me@gemini.com 으로 보내줘']) {
    assert.deepEqual(named(topic), [], topic);
  }
  assert.deepEqual(named('@GPT 알려줘'), ['gpt']);
  assert.deepEqual(named('GPT야 이거 봐줘'), ['gpt']);
  assert.deepEqual(named('GPT 너는 어떻게 생각해?'), ['gpt']);
  assert.deepEqual(named('Claude, 이거 설명해줘'), ['claude']);
  assert.deepEqual(named('그런데 클로드야 이건?'), ['claude']);
  assert.deepEqual(named('젬짱 이 사진 봐줘'), ['gemini']);
  assert.deepEqual(named('GPT랑 Claude 둘이 봐줘'), ['gpt', 'claude']);
  assert.deepEqual(named('제미나이랑 클로드 의견 궁금해'), ['gemini', 'claude']);
  assert.deepEqual(named('클롱아 안녕', { claude: ['클롱'] }), ['claude']);
  assert.deepEqual(named('클롱 이거 봐줘', { claude: ['클롱'] }), ['claude']);
  assert.equal(parseCall('얘들아 GPT가 뭐야?').all, true);
});

test('discussion needs two or more called AIs; one called AI is refused and nobody is added', async (t) => {
  const s = await start(t);
  await s.post('/api/check/login', {});
  await s.post('/api/room', { discussion: true });
  const lone = await s.post('/api/send', { text: '클로드야 이거 봐줘' });
  assert.equal(lone.error, '토론하려면 AI를 2명 이상 불러주세요.');
  assert.equal(s.adapter.calls.length, 0);
  assert.equal((await s.get('/api/preview?text=' + encodeURIComponent('클로드야 이거 봐줘'))).needTwo, true);
  await s.send('GPT랑 Claude 둘이 봐줘');
  assert.deepEqual([...new Set(s.adapter.calls.map((c) => c.id))].sort(), ['claude', 'gpt']);
  const before = s.adapter.calls.length;
  await s.send('얘들아 이거 토론해봐');
  assert.deepEqual([...new Set(s.adapter.calls.slice(before).map((c) => c.id))].sort(), [...IDS].sort());
  const second = s.adapter.calls.length;
  await s.send('이 주제 토론해봐');
  assert.deepEqual([...new Set(s.adapter.calls.slice(second).map((c) => c.id))].sort(), [...IDS].sort());
});

test('the preview and a resting AI follow the same local rules, with no AI call', async (t) => {
  const s = await start(t, { usage: fakeUsage({ claude: 95, gpt: 40, gemini: 90 }) });
  await s.post('/api/check/login', {});
  const preview = (text) => s.get('/api/preview?text=' + encodeURIComponent(text));
  assert.deepEqual((await preview('클로드야 이거 봐줘')).ids, ['claude']);
  assert.deepEqual((await preview('GPT랑 Gemini 둘이 봐줘')).ids, ['gpt', 'gemini']);
  assert.deepEqual((await preview('얘들아 뭐함')).ids.sort(), [...IDS].sort());
  const auto = await preview('안녕');
  assert.equal(auto.kind, 'auto'); assert.deepEqual(auto.ids, ['gpt'], 'nearly-out Claude and Gemini are avoided');
  // A named AI is called even when its usage is low; a resting AI is reported, not silently replaced.
  assert.deepEqual(await s.send('클로드야 안녕'), ['claude']);
  await s.post('/api/room', { enabled: { gemini: false } });
  const off = await preview('젬짱 안녕');
  assert.deepEqual(off.excluded, [{ id: 'gemini', reason: '쉬는 중' }]); assert.equal(off.kind, 'named');
  assert.equal((await s.post('/api/send', { text: '젬짱 안녕' })).error, '답할 수 있는 AI가 없습니다. 연결 설정을 확인하거나 쉬는 중인 AI를 켜 주세요.');
  assert.equal(s.adapter.calls.length, 1, 'previews and refused sends spent no AI call');
});

test('💬 자동 avoids a nearly-out AI and works when usage is unknown', async (t) => {
  const s = await start(t, { usage: fakeUsage({ claude: 95, gpt: 40, gemini: 90 }) });
  await s.post('/api/check/login', {});
  await s.post('/api/room', { selected: 'claude' });
  assert.deepEqual(await s.send('안녕'), ['gpt'], 'Claude (5%) and Gemini (10%) are nearly out; GPT answers');
  const unknown = await start(t);
  await unknown.post('/api/check/login', {});
  assert.deepEqual(await unknown.send('안녕'), ['claude'], 'no usage report: the chosen AI answers, nothing breaks');
});

test('chat answers, Talk rounds and member activity are recorded without extra AI calls', async (t) => {
  const s = await start(t);
  await s.post('/api/check/login', {});
  await s.send('로그인 오류 원인 알려줘');
  let entries = (await s.get('/api/activity')).entries;
  assert.equal(entries[0].kind, 'chat');
  assert.match(entries[0].text, /로그인 오류 원인/);
  assert.ok(!JSON.stringify(entries[0]).includes('답변\n'), 'no answer text is copied');
  assert.equal(typeof entries[0].ref.messageId, 'number');

  // A Talk round: later turns reply to the line before them; the daily cap is unchanged.
  const states = [];
  const chat = s.adapter.chat;
  s.adapter.chat = async (id, brief, ...rest) => {
    if (brief.startsWith(AUTO_BRIEF)) states.push(s.app.view().members.find((m) => m.id === id).activity.text);
    return chat(id, brief, ...rest);
  };
  await s.post('/api/room', { auto: { on: true, level: 'low' } });
  s.clock.t += 5 * 60000; await s.app.tick();
  const talk = s.app.store.messages.filter((m) => m.auto === 'call');
  assert.equal(talk.length, LEVELS.low.turns);
  assert.equal(talk[0].replyTo, undefined);
  // Only about half of the later lines are replies (the dice here is 0.5, so none); a reply always points at the line before it.
  assert.ok(talk.every((m, i) => m.replyTo === undefined || m.replyTo === talk[i - 1].id));
  assert.equal(talk.filter((m) => m.replyTo !== undefined).length, 0);
  assert.ok(states.every((text) => text === '💬 Talk에서 말하는 중'), states.join(' / '));
  const view = s.app.view();
  assert.equal(view.room.auto.usage.calls, LEVELS.low.turns);
  assert.equal(view.room.autoDaily, 10, 'the quiet level has a daily cap of 10');
  entries = (await s.get('/api/activity?kind=talk')).entries;
  assert.equal(entries.length, 1);
  assert.match(entries[0].text, /Talk 대화 \(3마디\)/);
  const someone = talk[0].from;
  assert.ok(view.activity.recent[someone].some((e) => e.kind === 'talk'));
  assert.ok((await s.get(`/api/activity?actor=${someone}&limit=3`)).entries.every((e) => e.actors.includes(someone)));
  assert.ok(view.members.every((m) => m.activity.text === '🟢 대기 중'));
  await s.post('/api/room', { enabled: { gpt: false } });
  assert.equal(s.app.view().members.find((m) => m.id === 'gpt').activity.text, '☕ 쉬는 중');
});

test('a busy model rests only that member for ten minutes; lasting errors still stop the day', async (t) => {
  const root = temp(t, 'activity-busy-');
  const clock = { t: new Date(2026, 9, 7, 10).getTime() };
  let s = await start(t, { clock, root });
  await s.post('/api/check/login', {});
  const chat = s.adapter.chat;
  let failure = 'ERROR: Selected model is at capacity. Please try a different model.';
  s.adapter.chat = async (id, brief, ...rest) => (brief.startsWith(AUTO_BRIEF) && id === 'gpt' ? { ok: false, detail: failure } : chat(id, brief, ...rest));
  await s.post('/api/room', { auto: { on: true, level: 'high' } });
  clock.t += 60000; await s.app.tick();
  let view = s.app.view();
  assert.equal(view.room.auto.usage.stopped, null, 'a busy model does not stop the room');
  assert.equal(view.room.autoRest, false);
  assert.ok(s.app.store.messages.some((m) => m.auto === 'call' && m.from !== 'gpt'), 'the others kept talking');
  assert.equal(view.room.auto.lastError.kind, 'capacity');
  // The member list gets the server's own cooldown, with the exact end time it applies.
  const health = view.members.find((m) => m.id === 'gpt').health;
  assert.equal(health.state, 'cooldown'); assert.equal(health.kind, 'capacity');
  assert.equal(health.until, s.app.room.checks.gpt.models[s.app.view().room.autoUses.gpt.model].at + 10 * 60000);
  assert.ok(view.members.filter((m) => m.id !== 'gpt').every((m) => m.health === null));
  // Within ten minutes GPT is left out; afterwards it is tried again.
  const tried = () => s.adapter.calls.filter((c) => c.auto && c.id === 'gpt').length;
  const before = tried();
  clock.t += 5 * 60000; await s.app.tick();
  assert.equal(tried(), before, 'GPT sits out for now');
  failure = null; s.adapter.chat = chat;
  clock.t += 6 * 60000; await s.app.tick();
  clock.t += 6 * 60000; await s.app.tick();
  assert.ok(tried() > before, 'GPT is back after ten minutes');
  assert.equal(s.app.view().members.find((m) => m.id === 'gpt').health, null, 'a success or the end of the cooldown clears it');
  // Lasting problems and quota rest are told apart.
  const checks = s.app.room.checks.gemini;
  checks.models.fake = { status: 'fail', kind: 'model', at: clock.t + 1 };
  assert.deepEqual(s.app.view().members.find((m) => m.id === 'gemini').health, { state: 'model' });
  checks.models.fake = { status: 'fail', kind: 'auth', at: clock.t + 1 };
  assert.deepEqual(s.app.view().members.find((m) => m.id === 'gemini').health, { state: 'auth' });
  delete checks.models.fake;
  s.app.room.quotaRest.claude = { at: clock.t, autoResume: true, windows: [] };
  assert.deepEqual(s.app.view().members.find((m) => m.id === 'claude').health, { state: 'quota' });
  s.app.room.quotaRest.claude = null;
  // A sign-in problem is not passing: it still stops automatic chat for the day.
  s.adapter.chat = async (id, brief, ...rest) => (brief.startsWith(AUTO_BRIEF) ? { ok: false, detail: 'Error: not logged in' } : chat(id, brief, ...rest));
  clock.t += 7 * 60000; await s.app.tick();
  assert.equal(s.app.view().room.auto.usage.stopped, 'auth');
  // A day stop that an older version saved for a passing error is lifted when the app starts again.
  s.app.room.auto.usage.stopped = 'capacity';
  await s.app.close();
  const file = path.join(root, 'data', 'state.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.assistant.auto.usage.stopped = 'capacity'; fs.writeFileSync(file, JSON.stringify(saved));
  s = await start(t, { clock, root });
  assert.equal(s.app.view().room.auto.usage.stopped, null);
  saved.assistant.auto.usage.stopped = 'auth'; fs.writeFileSync(file, JSON.stringify(saved));
  await s.app.close();
  s = await start(t, { clock, root });
  assert.equal(s.app.view().room.auto.usage.stopped, 'auth', 'a lasting stop is kept');
});

test('activity selection cannot be configured, old switches are ignored, and house notices survive restart', async (t) => {
  const clock = { t: new Date(2026, 9, 7, 10).getTime() };
  const root = temp(t, 'activity-features-');
  const s = await start(t, { clock, root, autoTickMs: 25 });
  await s.post('/api/check/login', {});
  assert.equal((await s.get('/api/state')).room.auto.features, undefined);
  await s.post('/api/room', { auto: { on: true, level: 'high', features: { talk: false, house: false, photos: false, games: false, notes: false } } });
  assert.equal((await s.get('/api/state')).room.auto.features, undefined);
  // Old switches cannot disable either house building or automatic conversation.
  clock.t += 2 * 60000;
  for (let i = 0; i < 40 && !s.adapter.calls.some((c) => c.house); i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(s.adapter.calls.some((c) => c.house));
  await s.app.tick();
  assert.ok(s.adapter.calls.some((c) => c.auto), 'automatic conversation is also selected');
  const house = (await s.get('/api/activity?kind=house')).entries[0];
  assert.match(house.text, /집 작업: 바닥 4칸/);
  assert.equal(typeof house.ref.houseTurn, 'number');
  const notices = s.app.store.messages.filter((m) => m.kind === 'house-build');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].from, 'system');
  assert.equal(notices[0].by, s.adapter.calls.find((c) => c.house).id);
  assert.equal(notices[0].text, '바닥 놓음 4칸 (2,2–3,3)');
  // Every builder line is shared in the chat.
  assert.equal(s.app.store.messages.filter((m) => m.kind === 'house-say').length, 1);
  clock.t += 60 * 60000;
  for (let i = 0; i < 40 && s.adapter.calls.filter((c) => c.house).length < 2; i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.adapter.calls.filter((c) => c.house).length, 2);
  assert.equal(s.app.store.messages.filter((m) => m.kind === 'house-build').length, 1, 'repainting the same cells does not post another notice');
  await s.app.close();
  const again = await start(t, { clock, root });
  assert.equal(again.app.store.messages.filter((m) => m.kind === 'house-build').length, 1, 'the notice survives restart');
  assert.equal((await again.get('/api/state')).room.auto.features, undefined);
  await again.post('/api/room', { auto: { on: false } });
  const before = again.adapter.calls.length;
  clock.t += 120 * 60000;
  await again.app.tick();
  assert.equal(again.adapter.calls.length, before);
});

