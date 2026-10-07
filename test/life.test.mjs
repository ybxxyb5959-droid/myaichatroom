import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { House } from '../lib/house.mjs';
import { isComplete, enterLife, lifeBeat, lifeEvent, relate, relationOf, drift, decide, undo, useOf, LIFE_PACE, EVENT_GAP, ASK_MS, RELATION_START, MAX_STEP } from '../lib/life.mjs';
import { AUTO_BRIEF } from '../lib/auto.mjs';
import { HOUSE_BRIEF } from '../lib/house.mjs';
import { createAssistantServer, loadConfig } from '../server.mjs';

const IDS = ['claude', 'gpt', 'gemini'];
const names = { claude: 'Claude', gpt: 'ChatGPT', gemini: 'Gemini' };
const opts = { ids: IDS, names };
const temp = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const def = (name, w = 1, use) => ({ type: 'define', name, ...(use ? { use } : {}), parts: [{ s: 'box', x: 0, y: 0, z: 0, w, h: 0.6, d: 1, c: 'wood' }] });
const place = (name, x, z) => ({ type: 'place', def: name, x, z, rot: 0 });
// Floor 5x4, eleven wall cells with a door, then a sofa, a desk and a plant.
function buildHome(house, { furniture = true } = {}) {
  house.apply('claude', { actions: [{ type: 'floor', x1: 2, z1: 2, x2: 6, z2: 5, color: 'wood' }, { type: 'wall', x1: 2, z1: 1, x2: 8, z2: 1, color: 'cream' },
    { type: 'wall', x1: 7, z1: 2, x2: 7, z2: 5, color: 'cream' }, { type: 'door', x: 4, z: 1 }] }, 1);
  house.apply('gpt', { actions: [def('소파', 2), def('책상'), def('화분'), def('탁자', 1, 'read')] }, 2);
  if (furniture) house.apply('gemini', { actions: [place('소파', 2, 2), place('책상', 5, 2), place('화분', 6, 5)] }, 3);
}
// Small deterministic random source for repeatable runs.
const seeded = (seed) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const adjacent = (house, id, item) => house.cellsOf(item).some(([x, z]) => Math.abs(x - house.s.agents[id].x) + Math.abs(z - house.s.agents[id].z) === 1);

test('an older house file loads unchanged and starts in the build phase', (t) => {
  const file = path.join(temp(t, 'life-old-'), 'house.json');
  fs.writeFileSync(file, JSON.stringify({ floors: { '1,1': 'wood' }, walls: {}, defs: {}, items: [], agents: { claude: { x: 3, z: 3 } }, plan: '거실', log: [], turns: 4 }));
  const house = new House(file, opts);
  assert.deepEqual([house.s.phase, house.s.mode, house.s.relations, house.s.events, house.s.turns, house.s.plan], ['build', 'balanced', {}, [], 4, '거실']);
  assert.deepEqual(house.s.agents.claude, { x: 3, z: 3 });
  assert.equal(house.view().floors.length, 1);
});

test('build turns into life by simple rules, once, and the life phase survives a reload', (t) => {
  const file = path.join(temp(t, 'life-done-'), 'house.json');
  const house = new House(file, opts);
  buildHome(house, { furniture: false });
  assert.equal(isComplete(house), false, 'no furniture yet');
  house.apply('gemini', { actions: [place('책상', 5, 2), place('화분', 6, 5), place('탁자', 3, 4)] }, 3);
  assert.equal(isComplete(house), false, 'three pieces but nowhere to sit or rest');
  house.apply('gemini', { actions: [place('소파', 2, 2)] }, 4);
  assert.equal(isComplete(house), true);
  assert.equal(enterLife(house, 5), true);
  assert.equal(enterLife(house, 6), false, 'only once');
  house.save();
  const again = new House(file, opts);
  assert.equal(again.s.phase, 'life');
  assert.equal(again.view().floors.length, 20, 'nothing is reset');
  assert.match(again.prompt('gpt'), /완성되어 지금은 다 같이 생활하는 중/);
  assert.deepEqual([useOf(null, '책상'), useOf(null, '책장'), useOf(null, '빈백 소파'), useOf({ use: 'plant' }, '장식'), useOf(null, '조형물')], ['desk', 'read', 'sit', 'plant', null]);
});

test('life beats use the furniture, never repeat a member\'s last action and mirror the app state', (t) => {
  const house = new House(path.join(temp(t, 'life-beat-'), 'house.json'), opts);
  buildHome(house); enterLife(house, 1);
  const [sofa, desk] = house.s.items;
  const work = lifeBeat(house, 'claude', { mode: 'work', names, rand: () => 0.1, now: 2 });
  assert.equal(work.text, '💻 책상에서 작업 중'); assert.ok(adjacent(house, 'claude', desk));
  const after = lifeBeat(house, 'claude', { mode: 'after-work', names, rand: () => 0.1, now: 3 });
  assert.equal(after.text, '☕ 작업 끝나고 소파에서 쉬는 중'); assert.ok(adjacent(house, 'claude', sofa));
  const talk = lifeBeat(house, 'gpt', { mode: 'talk', partner: 'claude', names, rand: () => 0.1, now: 4 });
  assert.equal(talk.text, '💬 Claude와 이야기 중');
  assert.equal(Math.abs(house.s.agents.gpt.x - house.s.agents.claude.x) + Math.abs(house.s.agents.gpt.z - house.s.agents.claude.z), 1);
  assert.match(lifeBeat(house, 'gemini', { mode: 'rest', names, rand: () => 0.1, now: 5 }).text, /^😴 소파에서 한숨 쉬는 중$/);
  const rand = seeded(7);
  const seen = [];
  for (let i = 0; i < 40; i++) {
    const before = house.s.agents.gemini.act;
    const beat = lifeBeat(house, 'gemini', { names, rand, now: 10 + i });
    assert.notEqual(beat.act, before);
    seen.push(beat.act);
    assert.ok(house.walkable(house.s.agents.gemini.x, house.s.agents.gemini.z));
  }
  for (const kind of ['sit', 'desk', 'plant', 'visit', 'tidy', 'alone', 'wander']) assert.ok(seen.includes(kind), `${kind} happens`);
});

test('relations move in small steps, stay in range and drift back once a day', (t) => {
  const house = new House(path.join(temp(t, 'life-rel-'), 'house.json'), opts);
  assert.equal(relationOf(house, 'gpt', 'claude'), RELATION_START);
  assert.equal(relate(house, 'gpt', 'claude', 10), RELATION_START + MAX_STEP);
  assert.equal(relate(house, 'claude', 'gpt', -10), RELATION_START);
  for (let i = 0; i < 50; i++) relate(house, 'gpt', 'gemini', 3);
  assert.equal(relationOf(house, 'gemini', 'gpt'), 100);
  assert.equal(drift(house, '2026-10-07'), true); assert.equal(drift(house, '2026-10-07'), false);
  assert.equal(relationOf(house, 'gpt', 'gemini'), 99);
});

test('events mix positive, neutral and conflict; conflicts are mediated and reconciled; no type repeats back to back', (t) => {
  const house = new House(path.join(temp(t, 'life-events-'), 'house.json'), opts);
  buildHome(house); enterLife(house, 1); house.s.mode = 'auto';
  const rand = seeded(11);
  const events = [];
  for (let i = 0; i < 300; i++) {
    const before = { ...house.s.relations };
    const ev = lifeEvent(house, { ids: IDS, names, rand, now: 100 + i });
    assert.ok(ev, 'in 🤖 mode nothing ever waits');
    for (const [key, v] of Object.entries(house.s.relations)) {
      assert.ok(Math.abs(v - (before[key] ?? RELATION_START)) <= MAX_STEP && v >= 0 && v <= 100);
    }
    events.push(ev);
  }
  const tones = new Set(events.map((e) => e.tone));
  assert.deepEqual([...tones].sort(), ['conflict', 'neutral', 'positive']);
  for (let i = 1; i < events.length; i++) assert.notEqual(events[i].type, events[i - 1].type);
  events.forEach((e, i) => {
    if (e.tone !== 'conflict') return;
    assert.equal(events[i + 1]?.type ?? 'mediate', 'mediate'); // with a third member a mediator steps in
    assert.equal(events[i + 2]?.type ?? 'reconcile', 'reconcile');
  });
  assert.ok(events.some((e) => e.type === 'major') && events.every((e) => !e.ask), 'big matters happen but 🤖 never asks');
  assert.equal(house.s.events.length, 30, 'only the latest events are kept');
  assert.ok(Object.values(house.s.relations).every((v) => v >= 40 && v <= 100), 'no relation runs away');
});

test('a big matter waits for the owner only until its deadline; an answer or silence both settle it', (t) => {
  const house = new House(path.join(temp(t, 'life-ask-'), 'house.json'), opts);
  buildHome(house); enterLife(house, 1);
  const sofa = house.s.items[0];
  const open = (now) => { house.s.open = { eventId: 1, type: 'major', pair: ['gpt', 'claude'], stage: 'conflict', itemId: sofa.id, text: '작업 공간 배치로 크게 의견이 갈림', ask: { deadline: now + ASK_MS, answer: null } }; };
  open(1000);
  assert.equal(lifeEvent(house, { ids: IDS, names, now: 2000 }), null, 'waits while the question is open');
  assert.equal(house.view().open.ask.deadline, 1000 + ASK_MS);
  const settled = lifeEvent(house, { ids: IDS, names, rand: () => 0.1, now: 1000 + ASK_MS });
  assert.equal(settled.type, 'mediate'); assert.match(settled.text, /Gemini가 소파 방향을 바꿔 보자고 중재함/);
  assert.equal(lifeEvent(house, { ids: IDS, names, now: 1000 + ASK_MS + 1 }).type, 'reconcile');
  assert.equal(house.s.open, null);
  open(5000);
  decide(house, 'owner', '창가 쪽 "으로"');
  const owner = lifeEvent(house, { ids: IDS, names, now: 5001 });
  assert.equal(owner.type, 'owner'); assert.match(owner.text, /방장 의견\(“창가 쪽 으로”\)대로 정리하기로 함/);
  assert.throws(() => decide(house, 'ai'), /정할 집 일이 없어요/);
  assert.equal(lifeEvent(house, { ids: IDS, names, now: 5002 }).type, 'reconcile');
  // The arrangement change made while settling can be undone, once.
  const rot = sofa.rot;
  house.s.open = { eventId: 2, type: 'minor', pair: ['gpt', 'claude'], stage: 'conflict', itemId: house.s.items[2].id, text: 'x', ask: null };
  const turned = lifeEvent(house, { ids: IDS, names, now: 6000 });
  assert.match(turned.text, /새 배치 적용/);
  assert.ok(house.view().undo);
  const plant = house.s.items[2];
  undo(house, 6001);
  assert.equal(house.s.items[2].rot, 0); assert.equal(plant.rot, 1, 'restored from the saved copy');
  assert.throws(() => undo(house, 6002), /되돌릴 수 있는/);
  assert.equal(sofa.rot === rot || sofa.rot === (rot + 1) % 4, true);
});

function adapter() {
  const calls = [];
  return { calls, available: () => Object.fromEntries(IDS.map((id) => [id, true])), loginStatus: async () => ({ status: 'ok' }),
    chat: async (id, brief) => { calls.push({ id, auto: brief.startsWith(AUTO_BRIEF), house: brief.startsWith(HOUSE_BRIEF) }); return { ok: true, text: `${id}의 말` }; } };
}
async function start(t, root, { clock, usage = null } = {}) {
  const a = adapter();
  const app = createAssistantServer({ root, cfg: { ...loadConfig(), autoSleepMinutes: 0 }, adapter: a, usage, greetings: false,
    clock: () => clock.t, random: seeded(3), autoTickMs: 3600000, pairDelayMs: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, body) => (await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { app, calls: a.calls, post };
}
function homeRoot(t) {
  const root = temp(t, 'life-app-');
  const house = new House(path.join(root, 'data', 'house.json'), opts);
  buildHome(house); house.save();
  return root;
}

test('the server switches to life once, mirrors member presence and records events without any AI call', async (t) => {
  const root = homeRoot(t);
  const clock = { t: new Date(2026, 9, 7, 10).getTime() };
  let s = await start(t, root, { clock });
  await s.post('/api/check/login', {});
  await s.post('/api/room', { auto: { on: true, level: 'high' } });
  s.app.lifeTick();
  assert.equal(s.app.house.s.phase, 'life');
  assert.equal(s.app.store.messages.filter((m) => /집이 기본적으로 완성됐어요/.test(m.text)).length, 1);
  assert.match(s.app.activity.list({ kind: 'house' })[0].text, /기본 집 완성/);
  assert.equal(s.app.view().members.find((m) => m.id === 'claude').activity.text, s.app.house.s.agents.claude.doing, 'idle members show their house life');
  // A member switched off rests in the house.
  await s.post('/api/room', { enabled: { gemini: false } });
  s.app.lifeTick();
  assert.match(s.app.house.s.agents.gemini.doing, /쉬는 중/);
  // Events arrive by cooldown and land in the shared timeline.
  clock.t += 16 * 60000;
  const out = s.app.lifeTick();
  assert.ok(out.event);
  const entry = s.app.activity.list({ kind: 'house' })[0];
  assert.equal(entry.ref.houseEvent, out.event.id);
  assert.equal(entry.text, out.event.text);
  const notice = s.app.store.messages.find((m) => m.kind === 'house-event' && m.houseEvent.id === out.event.id);
  assert.equal(notice.text, out.event.text);
  assert.deepEqual(notice.houseEvent.actors, out.event.actors);
  s.app.lifeTick();
  assert.equal(s.app.store.messages.filter((m) => m.kind === 'house-event' && m.houseEvent.id === out.event.id).length, 1);
  assert.equal(s.calls.length, 0, 'life needs no AI call');
  await s.app.close();
  s = await start(t, root, { clock });
  assert.equal(s.app.house.s.phase, 'life');
  await s.post('/api/room', { auto: { on: true } });
  s.app.lifeTick();
  assert.equal(s.app.store.messages.filter((m) => /집이 기본적으로 완성됐어요/.test(m.text)).length, 1, 'the notice is not repeated after a restart');
});

test('life beats and events follow the level cooldowns; a nearly-out AI starts no spontaneous call', async (t) => {
  const root = homeRoot(t);
  const clock = { t: new Date(2026, 9, 7, 10).getTime() };
  const usage = { polling: false, lastPoll: Date.now(), onUpdate: () => {}, pollAll: async () => {},
    view: () => ({ claude: { ok: true, at: clock.t, windows: [{ id: '5h', usedPct: 95, remainingPct: 5 }] } }) };
  const s = await start(t, root, { clock, usage });
  await s.post('/api/check/login', {});
  await s.post('/api/room', { auto: { on: true, level: 'high' } });
  s.app.lifeTick(); // enter life and mirror
  clock.t += 60000; assert.ok(s.app.lifeTick().beats.length, 'first beat');
  const [lo, hi] = LIFE_PACE.high;
  clock.t += lo - 1000; assert.equal(s.app.lifeTick(), null, 'no beat inside the cooldown');
  clock.t += hi; assert.ok(s.app.lifeTick().beats.length);
  assert.ok(EVENT_GAP.low > EVENT_GAP.medium && EVENT_GAP.medium > EVENT_GAP.high);
  assert.ok(LIFE_PACE.low[0] > LIFE_PACE.medium[0] && LIFE_PACE.medium[0] > LIFE_PACE.high[0]);
  // A full round never picks Claude (5% left), and Claude still lives in the house.
  clock.t += 60 * 60000; await s.app.tick();
  const talk = s.calls.filter((c) => c.auto);
  assert.ok(talk.length > 0);
  assert.ok(talk.every((c) => c.id !== 'claude'));
  assert.ok(s.app.view().room.auto.usage.calls <= 40, 'the internal safety cap is unchanged');
  assert.ok(s.app.house.s.agents.claude.doing);
});

test('the owner can answer, undo and change the house mode through the API; bad input is refused', async (t) => {
  const root = homeRoot(t);
  const clock = { t: new Date(2026, 9, 7, 10).getTime() };
  const s = await start(t, root, { clock });
  await s.post('/api/room', { auto: { on: true } });
  s.app.lifeTick();
  assert.equal((await s.post('/api/house/decide', { choice: 'ai' })).error, '지금 정할 집 일이 없어요.');
  assert.equal((await s.post('/api/house/mode', { mode: 'chaos' })).error, '집 운영 방식을 확인하세요.');
  assert.equal((await s.post('/api/house/mode', { mode: 'together' })).mode, 'together');
  s.app.house.s.open = { eventId: 9, type: 'minor', pair: ['gpt', 'gemini'], stage: 'conflict', itemId: s.app.house.s.items[0].id, text: '소파 위치로 의견이 갈림', ask: { deadline: clock.t + ASK_MS, answer: null } };
  const view = await s.post('/api/house/decide', { choice: 'owner', note: '벽 쪽으로' });
  assert.match(view.events.at(-1).text, /방장 의견\(“벽 쪽으로”\)/);
  assert.match(s.app.activity.list({ kind: 'house' })[0].text, /방장 의견/);
  assert.match(s.app.store.messages.findLast((m) => m.kind === 'house-event').text, /방장 의견/);
  if (view.undo) {
    const back = await s.post('/api/house/undo', {});
    assert.equal(back.undo, null);
  }
  assert.equal((await s.post('/api/house/undo', {})).error, '되돌릴 수 있는 최근 변경이 없어요.');
  assert.equal(s.calls.length, 0);
});
