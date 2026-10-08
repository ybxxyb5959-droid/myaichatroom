import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { House } from '../lib/house.mjs';
import { enterLife, relationOf, RELATION_START, relationHint, eventChatter } from '../lib/life.mjs';
import { chooseShare, captionFor, renderShare, seasonOf, SHARE_GAP } from '../lib/lifeshare.mjs';
import { buildNote, todayDigest, TODAY_QUESTION, noteScore } from '../lib/digest.mjs';
import { AUTO_BRIEF } from '../lib/auto.mjs';
import { createAssistantServer, loadConfig } from '../server.mjs';

const IDS = ['claude', 'gpt', 'gemini'];
const names = { claude: 'Claude', gpt: 'ChatGPT', gemini: 'Gemini', user: '방장' };
const temp = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const seeded = (seed) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const def = (name, w = 1) => ({ type: 'define', name, parts: [{ s: 'box', x: 0, y: 0, z: 0, w, h: 0.6, d: 1, c: 'blue' }] });
test('a builder who did not choose where to walk ends up on the floor next to the work; idle members stroll', (t) => {
  const house = new House(path.join(temp(t, 'chat-walk-'), 'house.json'), { ids: IDS, names });
  house.apply('gpt', { actions: [{ type: 'floor', x1: 10, z1: 10, x2: 13, z2: 13, color: 'wood' }] }, 1);
  const { x, z } = house.s.agents.gpt;
  assert.ok(x >= 10 && x <= 13 && z >= 10 && z <= 13, 'gpt stands on the floor it laid');
  const before = { ...house.s.agents.claude };
  assert.ok(house.wander('claude', seeded(7)));
  const after = house.s.agents.claude;
  assert.ok((after.x !== before.x || after.z !== before.z) && house.s.floors[`${after.x},${after.z}`], 'claude strolled onto a floor cell');
});

function home(file) {
  const house = new House(file, { ids: IDS, names });
  house.apply('claude', { actions: [{ type: 'floor', x1: 2, z1: 2, x2: 6, z2: 5, color: 'wood' }, { type: 'wall', x1: 2, z1: 1, x2: 8, z2: 1, color: 'cream' }, { type: 'wall', x1: 7, z1: 2, x2: 7, z2: 5, color: 'cream' }, { type: 'door', x: 4, z: 1 }] }, 1);
  house.apply('gpt', { actions: [def('소파', 2), def('책상'), def('화분')] }, 2);
  house.apply('gemini', { actions: [{ type: 'place', def: '소파', x: 2, z: 2 }, { type: 'place', def: '책상', x: 5, z: 2 }, { type: 'place', def: '화분', x: 6, z: 5 }] }, 3);
  return house;
}

test('life shares are app-drawn SVG scenes with short varied captions and no repeated theme', (t) => {
  const house = home(path.join(temp(t, 'share-'), 'house.json'));
  enterLife(house, 1);
  const svg = renderShare({ theme: 'sofa', actor: 'claude', friends: ['gpt'], house, names, caption: '소파가 <날> 놔주지 않음' });
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/); assert.match(svg, /data:image\/png;base64,/); assert.match(svg, /소파가 &lt;날&gt;/);
  assert.match(svg, /앱이 그린 장면/); assert.ok(Buffer.byteLength(svg) < 60 * 1024, `${Buffer.byteLength(svg)} bytes fit the workspace limit`);
  assert.match(renderShare({ theme: 'party', actor: 'gemini', names, caption: '나 파티옴ㅋㅋ' }), /🎉/);
  const recent = [];
  for (let i = 0; i < 6; i++) recent.push(captionFor('done', { a: 'Claude', recent, rand: seeded(5 + i) }));
  assert.equal(new Set(recent).size, 6, 'six different remarks before any repeats');
  let last = {};
  const rand = seeded(9);
  for (let i = 0; i < 40; i++) {
    const share = chooseShare({ house, ids: IDS, now: 1000 + i, rand, last });
    assert.notEqual(share.theme, last.theme);
    assert.notEqual(share.actor, last.actor);
    last = { theme: share.theme, actor: share.actor };
  }
  assert.equal(seasonOf(new Date(2026, 9, 30).getTime()), 'halloween');
  assert.equal(seasonOf(new Date(2026, 5, 1).getTime()), null);
});

test('real events are shared first and only once: reconciliation, house change, finished task, game result', (t) => {
  const house = home(path.join(temp(t, 'share-ev-'), 'house.json'));
  enterLife(house, 1);
  const now = 10 * 60000;
  house.s.events.push({ id: 7, at: now - 1000, type: 'reconcile', tone: 'positive', actors: ['gpt', 'claude'], text: '화해' });
  const first = chooseShare({ house, ids: IDS, now, last: {} });
  assert.deepEqual([first.theme, first.actor, first.friends, first.ref], ['reconcile', 'gpt', ['claude'], 'ev:7']);
  const entries = [{ id: 3, at: now - 2000, kind: 'task', actors: ['claude'], text: '"로그인 오류 수정" 작업 완료' }];
  const second = chooseShare({ house, entries, ids: IDS, now, last: { theme: 'reconcile', refs: ['ev:7'] } });
  assert.deepEqual([second.theme, second.actor, second.ref], ['done', 'claude', 'act:3']);
  const third = chooseShare({ house, entries, ids: IDS, now, rand: () => 0.1, last: { theme: 'done', refs: ['ev:7', 'act:3'] } });
  assert.ok(!['reconcile', 'done'].includes(third.theme));
});

test('helpful notes and the "what did you do today" list come from the activity log only', () => {
  const now = new Date(2026, 9, 7, 18).getTime();
  const at = (h) => new Date(2026, 9, 7, h).getTime();
  const quiet = [{ id: 1, at: at(10), kind: 'talk', actors: ['gpt'], text: 'GPT·Claude Talk 대화 (3마디)' }];
  assert.equal(buildNote(quiet, { now }), null, 'nothing meaningful, no memo');
  const busy = [
    { id: 2, at: at(11), kind: 'task', actors: ['claude'], text: '"로그인 오류 수정" 작업 완료' },
    { id: 3, at: at(12), kind: 'task', actors: ['gpt'], text: '"사진 공유 빈도" 작업 중단' },
    { id: 4, at: at(13), kind: 'chat', actors: ['gpt'], text: 'ChatGPT가 "모바일 준비 어떻게 해?"에 답함' },
    { id: 5, at: at(14), kind: 'house', actors: ['gpt', 'claude'], text: 'ChatGPT와 Claude가 화해함 · Claude가 결과에 만족함' },
  ];
  assert.ok(noteScore(busy) >= 6);
  const note = buildNote(busy, { now });
  assert.match(note.markdown, /## 한 작업[\s\S]*로그인 오류 수정/);
  assert.match(note.markdown, /## 다음에 해볼 것 \(제안\)\n1\. 중단된 "사진 공유 빈도" 다시 확인하기/);
  assert.match(note.markdown, /`feat: 로그인 오류 수정`/);
  assert.match(note.markdown, /프로젝트 파일은 바꾸지 않았어요/);
  for (const q of ['오늘 뭐 했어?', '나 없는 동안 뭐했음?', '오늘 AI들 뭐 했어?', '아까 무슨 일 있었어?']) assert.ok(TODAY_QUESTION.test(q), q);
  for (const q of ['오늘 날씨 어때?', '이 코드 뭐 했는지 설명해줘']) assert.ok(!TODAY_QUESTION.test(q), q);
  const list = todayDigest([...busy].reverse(), { since: at(0) });
  assert.match(list, /📋 오늘 AI들은:\n- 11:00 "로그인 오류 수정" 작업 완료/);
  assert.match(todayDigest([], { since: at(0) }), /아직 기록된 활동이 없어요/);
});

test('a recent house event reaches Talk only as a light hint or a scripted pair of lines', (t) => {
  const house = home(path.join(temp(t, 'hint-'), 'house.json'));
  enterLife(house, 1);
  const now = 5 * 3600000;
  house.s.events.push({ id: 1, at: now - 1000, type: 'minor', tone: 'conflict', actors: ['gpt', 'claude'], text: 'x' },
    { id: 2, at: now - 500, type: 'mediate', tone: 'positive', actors: ['gemini', 'gpt', 'claude'], text: 'y' },
    { id: 3, at: now - 100, type: 'reconcile', tone: 'positive', actors: ['gpt', 'claude'], text: 'z' });
  assert.deepEqual(relationHint(house, 'gpt', { names, now }), ['최근 Claude와 화해함', '최근 집에서 중재를 맡음']);
  assert.deepEqual(relationHint(house, 'gemini', { names, now }), ['최근 집에서 중재를 맡음']);
  assert.deepEqual(relationHint(house, 'gpt', { names, now: now + 25 * 3600000 }), [], 'older than a day: no hint');
  const lines = eventChatter(house, IDS, { names, now, rand: () => 0 });
  assert.deepEqual(lines.map((l) => l.id), ['gpt', 'claude']);
  assert.match(lines[0].text, /Claude/);
});

function adapter() {
  const calls = [];
  return { calls, available: () => Object.fromEntries(IDS.map((id) => [id, true])), loginStatus: async () => ({ status: 'ok' }), listModels: async () => [],
    chat: async (id, brief, prompt) => { calls.push({ id, auto: brief.includes('## 응답 형식'), prompt }); return { ok: true, text: brief.includes('## 응답 형식') ? JSON.stringify({ action: 'say', messages: [`${id}의 말`] }) : `${id}의 말` }; } };
}
async function start(t, { clock, root, usage = null } = {}) {
  root ??= temp(t, 'fun-app-');
  const a = adapter();
  const app = createAssistantServer({ root, cfg: { ...loadConfig(path.join(root, 'no-user-config.json')), autoSleepMinutes: 0 }, adapter: a, usage, clock: () => clock.t, random: seeded(4), autoTickMs: 3600000, wait: async () => {} });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, body) => (await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { app, calls: a.calls, post, root, url };
}
const MIN = 60000, HOUR = 60 * MIN;

test('legacy house scene sharing stays disabled even when its saved schedule is due', async (t) => {
  const clock = { t: new Date(2026, 9, 7, 10).getTime() };
  const s = await start(t, { clock });
  await s.post('/api/check/login', {});
  await s.post('/api/room', { auto: { on: true, level: 'high' } });
  await s.post('/api/send', { text: '오늘 뭐 했어?' }); // the user is here (this question costs no call)
  clock.t += 30 * MIN;
  await s.app.tick();
  clock.t += 4 * HOUR;
  await s.app.tick();
  assert.ok(!s.app.store.messages.some((m) => m.auto === 'life'));
  assert.equal(s.app.store.listFiles().filter((f) => f.path.startsWith('life/')).length, 0);
  assert.ok(s.calls.length > 0);
});

test('automatic activity never starts a chat game and the removed game participation endpoints are unavailable', async (t) => {
  const clock = { t: new Date(2026, 9, 7, 10).getTime() };
  const root = temp(t, 'fun-game-');
  const house = home(path.join(root, 'data', 'house.json')); enterLife(house, 1); house.save();
  const s = await start(t, { clock, root });
  await s.post('/api/check/login', {});
  await s.post('/api/room', { auto: { on: true, level: 'high' } });
  for (let i = 0; i < 40; i++) {
    clock.t += 31 * MIN;
    await s.app.tick();
  }
  assert.equal(s.app.view().room.game, undefined);
  assert.equal(s.app.activity.list({ kind: 'game' }).length, 0);
  assert.equal(s.app.store.messages.filter((m) => m.play || m.auto === 'game').length, 0);
  for (const route of ['/api/game/join', '/api/game/answer']) {
    const response = await fetch(s.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'old-game', choice: 0 }) });
    assert.equal(response.status, 404);
  }
  assert.ok(s.calls.length > 0);
});

test('activity logs no longer generate notes or intercept the owner with a canned digest', async (t) => {
  const clock = { t: new Date(2026, 9, 7, 10).getTime() };
  const s = await start(t, { clock });
  await s.post('/api/check/login', {});
  await s.post('/api/room', { auto: { on: true } });
  clock.t += 2 * HOUR;
  await s.app.tick();
  const add = (kind, actors, text) => s.app.activity.add({ kind, actors, text });
  add('task', ['claude'], '"로그인 오류 수정" 작업 완료');
  add('task', ['gpt'], '"집 생활" 작업 완료');
  clock.t += 31 * MIN;
  await s.app.tick();
  assert.equal(s.app.activity.list({ kind: 'note' }).length, 0);
  assert.ok(!s.app.store.listFiles().some((f) => f.path.startsWith('notes/')));
  clock.t += 31 * MIN;
  await s.app.tick();
  const before = s.calls.length;
  await s.post('/api/send', { text: '오늘 AI들 뭐 했어?' });
  assert.equal(s.calls.length, before, 'send enqueues the message rather than choosing a responder');
  assert.equal(s.app.store.messages.at(-1).from, 'user');
  assert.ok(!s.app.store.messages.some((m) => m.kind === 'digest'));
  await s.post('/api/send', { text: 'Promise가 뭐야?' });
  await s.app.tick(); clock.t += 12000; await s.app.tick();
  assert.ok(s.calls.length > before);
});

test('Talk keeps its existing round length without reviving legacy house events', async (t) => {
  const clock = { t: new Date(2026, 9, 7, 10).getTime() };
  const root = temp(t, 'fun-hint-');
  const house = home(path.join(root, 'data', 'house.json')); enterLife(house, 1);
  house.s.events.push({ id: 1, at: clock.t - 1000, type: 'reconcile', tone: 'positive', actors: ['gpt', 'claude'], text: '화해' });
  house.save();
  const s = await start(t, { clock, root });
  await s.post('/api/check/login', {});
  await s.post('/api/room', { auto: { on: true, level: 'low' } });
  clock.t += 30 * MIN; await s.app.tick();
  const talk = s.calls.filter((c) => c.auto);
  assert.equal(talk.length, 1, 'one member starts the silence rather than a forced three-turn round');
  const hinted = talk.filter((c) => c.prompt.includes('[최근 집 소식'));
  assert.equal(hinted.length, 0);
  assert.equal(relationOf(new House(house.file, { ids: IDS, names }), 'gpt', 'claude'), RELATION_START);
});
