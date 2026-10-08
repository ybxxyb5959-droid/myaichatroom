import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { House, SIZE } from '../lib/house.mjs';
import { isComplete } from '../lib/life.mjs';
import { PROJECT_ROOMS, PROJECT_CORRIDORS, PROJECT_WALLS, PROJECT_DOORS, rectangleCells, projectStatus } from '../lib/house-project.mjs';

const opts = { ids: ['claude', 'gpt', 'gemini'], names: { claude: 'Claude', gpt: 'GPT', gemini: 'Gemini' } };
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'house-project-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new House(path.join(dir, 'house.json'), { ...opts, rebuild: true });
}
function completeStructure(house) {
  for (const area of [...PROJECT_ROOMS, ...PROJECT_CORRIDORS]) {
    for (const [x, z] of rectangleCells(area)) house.s.floors[`${x},${z}`] = 'wood';
  }
  for (const [x1, z1, x2, z2] of PROJECT_WALLS) {
    for (const [x, z] of rectangleCells({ x1, z1, x2, z2 })) house.s.walls[`${x},${z}`] = { c: 'cream', door: false };
  }
  for (const [x, z] of PROJECT_DOORS) house.s.walls[`${x},${z}`].door = true;
}
function furnish(house) {
  for (const room of PROJECT_ROOMS) {
    for (let i = 0; i < room.min; i++) {
      const name = `${room.name}${i}`;
      house.s.defs[name] = { by: room.owner, ...(room.uses[i] ? { use: room.uses[i] } : {}),
        parts: [{ s: 'box', x: 0, y: 0, z: 0, w: 1, h: .6, d: 1, c: 'wood' }] };
      house.s.items.push({ id: house.s.nextId++, def: name, x: room.x1 + 1 + i, z: room.z1 + 1, rot: 0, by: room.owner });
    }
  }
}

test('explicit rebuild resets house state only when saved, retains legacy loading and persists its project', (t) => {
  const house = home(t);
  const old = { floors: { '7,8': 'wood' }, walls: {}, defs: {}, items: [], phase: 'life', turns: 19, mode: 'auto' };
  fs.writeFileSync(house.file, JSON.stringify(old));
  const legacy = new House(house.file, opts);
  assert.equal(legacy.s.phase, 'life'); assert.equal(legacy.s.project, null);
  const fresh = new House(house.file, { ...opts, rebuild: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(house.file, 'utf8')), old, 'constructing the reset does not overwrite data');
  fresh.s.mode = legacy.s.mode; fresh.save();
  const again = new House(house.file, opts);
  assert.equal(SIZE, 32); assert.equal(again.view().size, 32);
  assert.equal(again.s.project, 'spacious'); assert.equal(again.s.phase, 'build');
  assert.equal(again.s.turns, 0); assert.equal(again.s.items.length, 0);
  assert.equal(again.s.mode, 'auto'); assert.deepEqual(again.s.relations, {});
  assert.match(again.prompt('gpt'), /현재 작업 가능한 참가 AI 3명/);
  for (const room of PROJECT_ROOMS) assert.ok(again.prompt('gpt').includes(room.name));
});

test('a spacious rebuild cannot finish as a small living room or with unfurnished rooms', (t) => {
  const house = home(t);
  house.apply('claude', { actions: [{ type: 'floor', x1: 2, z1: 2, x2: 6, z2: 5, color: 'wood' },
    { type: 'wall', x1: 2, z1: 1, x2: 8, z2: 1, color: 'cream' }, { type: 'door', x: 4, z: 1 },
    { type: 'define', name: '소파', use: 'sit', parts: [{ s: 'box', w: 1, h: .6, d: 1, c: 'blue' }] },
    { type: 'place', def: '소파', x: 3, z: 3 }, { type: 'place', def: '소파', x: 5, z: 3 }] });
  assert.equal(isComplete(house), false);
  house.s.floors = {}; house.s.walls = {}; house.s.items = [];
  completeStructure(house);
  assert.equal(Object.keys(house.s.floors).length, 574);
  assert.equal(Object.keys(house.s.walls).length, 210);
  const status = projectStatus(house);
  assert.deepEqual([status.floorMissing, status.wallMissing, status.doorMissing], [0, 0, 0]);
  assert.equal(status.passagesOpen, true);
  assert.equal(status.rooms.length, 6); assert.equal(isComplete(house), false);
  assert.match(house.prompt('claude'), /"stage":"furniture"/);
});

test('all six rooms need furniture, essential uses and accessible passages before life starts', (t) => {
  const house = home(t); completeStructure(house); furnish(house);
  assert.equal(house.s.items.length, 23); assert.equal(isComplete(house), true);
  house.s.walls['22,26'].door = false;
  assert.equal(isComplete(house), false, 'bathroom door is required');
  house.s.walls['22,26'].door = true;
  const bed = house.s.items.find((item) => item.def === '침실 10');
  delete house.s.defs[bed.def].use;
  assert.equal(isComplete(house), false, 'a bedroom needs a bed marked rest');
  house.s.defs[bed.def].use = 'rest';
  const removed = house.s.items.pop();
  assert.equal(isComplete(house), false, 'furniture is required in every room, not just in total');
  house.s.items.push(removed);
  house.s.floors['20,28'] && delete house.s.floors['20,28'];
  assert.equal(isComplete(house), false, 'required corridor flooring cannot be omitted');
  house.s.floors['20,28'] = 'wood';
  house.s.defs['blocking'] = { parts: [{ s: 'box', x: 0, y: 0, z: 0, w: 2, h: .6, d: 1, c: 'wood' }] };
  house.s.items.push({ id: 999, def: 'blocking', x: 20, z: 28, rot: 0 });
  assert.equal(isComplete(house), false, 'furniture cannot block the entry corridor');
  house.s.items.pop();
  assert.equal(isComplete(house), true);
  house.save();
  assert.equal(isComplete(new House(house.file, opts)), true);
});

test('expanded coordinates are buildable and outside coordinates still fail', (t) => {
  const house = home(t);
  const result = house.apply('gpt', { actions: [
    { type: 'floor', x1: 28, z1: 28, x2: 31, z2: 31, color: 'wood' },
    { type: 'floor', x1: 32, z1: 31, x2: 32, z2: 31, color: 'wood' },
  ] });
  assert.equal(result.errors.length, 1);
  assert.equal(house.view().floors.length, 16);
  assert.match(house.prompt('gemini'), /"stage":"floor"/);
});
