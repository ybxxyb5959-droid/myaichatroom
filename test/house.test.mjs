import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { House, parseHouseReply, HOUSE_LIMITS } from '../lib/house.mjs';
import { houseNoticeHTML } from '../public/format.mjs';

const opts = { ids: ['claude', 'gpt', 'gemini'], names: { claude: 'Claude', gpt: 'ChatGPT', gemini: 'Gemini' } };
const make = () => new House(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'house-')), 'house.json'), opts);
const sofa = { type: 'define', name: '소파', parts: [{ s: 'box', x: 0, y: 0, z: 0, w: 2, h: 0.5, d: 1, c: 'blue' }, { s: 'box', x: 0, y: 0.5, z: 0, w: 2, h: 0.6, d: 0.3, c: 'navy' }] };

test('floors, walls, doors and furniture are built from model replies and survive a reload', () => {
  const house = make();
  const reply = { say: '거실부터 만들자', plan: '거실 → 주방', actions: [
    { type: 'floor', x1: 2, z1: 2, x2: 6, z2: 5, color: 'wood' },
    { type: 'wall', x1: 2, z1: 1, x2: 7, z2: 1, color: 'cream' },
    { type: 'door', x: 4, z: 1 }, sofa, { type: 'place', def: '소파', x: 3, z: 3, rot: 1 }, { type: 'move', x: 4, z: 4 },
  ] };
  const out = house.apply('claude', reply, 1000);
  assert.deepEqual(out.errors, []);
  assert.equal(house.view().floors.length, 20);
  assert.equal(house.view().walls.filter((w) => w[3]).length, 1);
  assert.equal(house.view().items.length, 1);
  assert.deepEqual(house.s.agents.claude, { x: 4, z: 4 });
  assert.equal(house.s.plan, '거실 → 주방');
  const again = new House(house.file, opts);
  assert.equal(again.view().items.length, 1);
  assert.equal(again.s.log.at(-1).text, '거실부터 만들자');
});

test('invalid actions are refused without stopping the rest of the turn', () => {
  const house = make();
  const out = house.apply('gpt', { actions: [
    { type: 'floor', x1: 0, z1: 0, x2: 30, z2: 3, color: 'wood' },        // outside the grid
    { type: 'floor', x1: 0, z1: 0, x2: 9, z2: 9, color: 'wood' },         // too many cells
    { type: 'floor', x1: 0, z1: 0, x2: 2, z2: 2, color: 'hotpink' },      // unknown colour
    { type: 'place', def: 'constructor', x: 1, z: 1 },                    // not a real design
    { type: 'wall', x1: 1, z1: 1, x2: 3, z2: 3, color: 'white' },         // diagonal
    { type: 'floor', x1: 0, z1: 0, x2: 1, z2: 1, color: 'green' },
  ] }, 1);
  assert.equal(out.errors.length, 5);
  assert.equal(house.view().floors.length, 4);
});

test('furniture needs floor, cannot overlap walls or other furniture, and designs belong to their author', () => {
  const house = make();
  house.apply('claude', { actions: [{ type: 'floor', x1: 0, z1: 0, x2: 5, z2: 2, color: 'beige' }, { type: 'wall', x1: 5, z1: 0, x2: 5, z2: 2, color: 'white' }, sofa] }, 1);
  const out = house.apply('gpt', { actions: [
    { type: 'place', def: '소파', x: 8, z: 8 },     // no floor
    { type: 'place', def: '소파', x: 4, z: 0 },     // runs into the wall
    { type: 'place', def: '소파', x: 0, z: 0 },     // fine
    { type: 'place', def: '소파', x: 1, z: 0 },     // overlaps the first
    { ...sofa, parts: [{ ...sofa.parts[0], c: 'red' }] }, // someone else's name
  ] }, 2);
  assert.equal(out.errors.length, 4);
  assert.equal(house.view().items.length, 1);
  assert.equal(house.s.defs['소파'].by, 'claude');
});

test('a turn cannot paint more than the per-turn budget', () => {
  const house = make();
  const out = house.apply('gemini', { actions: [
    { type: 'floor', x1: 0, z1: 0, x2: 5, z2: 5, color: 'wood' }, { type: 'floor', x1: 6, z1: 0, x2: 11, z2: 5, color: 'wood' },
  ] }, 1);
  assert.equal(out.errors.length, 1);
  assert.equal(house.view().floors.length, 36);
  assert.ok(36 <= HOUSE_LIMITS.cellsPerTurn);
});

test('the prompt shows the map, the plan and a resume request after a long break', () => {
  const house = make();
  house.apply('claude', { say: '안녕', plan: '거실 만들기', actions: [{ type: 'floor', x1: 1, z1: 1, x2: 2, z2: 2, color: 'wood' }] }, 1);
  const text = house.prompt('gpt', { resumedAfterMs: 5 * 3600000 });
  assert.match(text, /공동 계획: 거실 만들기/);
  assert.match(text, /\n 1 \.,,/);
  assert.match(text, /이어서 하자/);
  assert.doesNotMatch(house.prompt('gpt', { resumedAfterMs: 1000 }), /이어서 하자/);
});

test('model text is parsed from fenced or chatty replies', () => {
  assert.deepEqual(parseHouseReply('```json\n{"say":"hi"}\n```'), { say: 'hi' });
  assert.equal(parseHouseReply('no json here'), null);
  assert.equal(parseHouseReply('[1,2]'), null);
});

test('build notices count actual changes and ignore repeated paint, failed actions, speech and movement', () => {
  const house = make();
  const floor = { type: 'floor', x1: 2, z1: 2, x2: 3, z2: 3, color: 'wood' };
  assert.equal(house.apply('claude', { actions: [floor] }).notice, '바닥 놓음 4칸 (2,2–3,3)');
  assert.equal(house.apply('claude', { say: '이어 하자', actions: [floor, { type: 'move', x: 4, z: 4 },
    { type: 'place', def: '없는 가구', x: 0, z: 0 }] }).notice, '');
  assert.equal(house.apply('gpt', { actions: [{ ...floor, color: 'blue' }] }).notice, '바닥 변경 4칸 (2,2–3,3)');
  assert.equal(house.apply('gpt', { actions: [{ type: 'erase', x: 2, z: 2 }] }).notice, '바닥 지움 1칸 (2,2–2,2)');
  assert.equal(house.apply('gpt', { actions: [{ ...floor, x1: 2, z1: 2, x2: 2, z2: 2 },
    { type: 'erase', x: 2, z: 2 }] }).notice, '', 'a reverted change has no net effect');
});

test('notices include doors, furniture footprint and designs but suppress unchanged doors and designs', () => {
  const house = make();
  house.apply('claude', { actions: [{ type: 'floor', x1: 0, z1: 0, x2: 3, z2: 3, color: 'wood' },
    { type: 'wall', x1: 0, z1: 0, x2: 1, z2: 0, color: 'cream' }] });
  assert.equal(house.apply('claude', { actions: [{ type: 'door', x: 1, z: 0 }, sofa,
    { type: 'place', def: '소파', x: 2, z: 1, rot: 1 }] }).notice,
  '문 1개 만듦, 소파 배치, 가구 설계 1개 (1,0–2,2)');
  assert.equal(house.apply('claude', { actions: [{ type: 'door', x: 1, z: 0 }, sofa] }).notice, '');
  assert.equal(house.apply('claude', { actions: [{ type: 'erase', x: 2, z: 2 }] }).notice, '소파 치움 (2,1–2,2)');
});

test('notices count only permitted cells and retain partial changes when a wall reaches its limit', () => {
  const house = make();
  const out = house.apply('gemini', { actions: [
    { type: 'floor', x1: 0, z1: 0, x2: 5, z2: 5, color: 'wood' },
    { type: 'floor', x1: 6, z1: 0, x2: 11, z2: 5, color: 'wood' },
  ] });
  assert.equal(out.notice, '바닥 놓음 36칸 (0,0–5,5)');
  for (let x = 0; x < 15; x++) for (let z = 0; z < 20; z++) house.s.walls[`${x},${z}`] = { c: 'white', door: false };
  delete house.s.walls['0,0'];
  const partial = house.apply('gpt', { actions: [{ type: 'wall', x1: 0, z1: 0, x2: 19, z2: 0, color: 'blue' }] });
  assert.equal(partial.notice, '', 'an overlong wall is refused before mutation');
  const limited = house.apply('gpt', { actions: [{ type: 'wall', x1: 14, z1: 0, x2: 16, z2: 0, color: 'blue' }] });
  assert.equal(limited.errors.length, 1);
  assert.equal(limited.notice, '벽 놓음 1칸, 벽 변경 1칸 (14,0–15,0)');
});

test('house notice markup distinguishes the actor and escapes all untrusted text', () => {
  assert.equal(houseNoticeHTML('Claude', '바닥 놓음 4칸 (2,2–3,3)'),
    '🧱 <span class="who">Claude</span> 바닥 놓음 4칸 (2,2–3,3)');
  assert.equal(houseNoticeHTML('<img>', '<script>'), '🧱 <span class="who">&lt;img&gt;</span> &lt;script&gt;');
});
