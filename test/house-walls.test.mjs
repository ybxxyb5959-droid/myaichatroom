import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { House } from '../lib/house.mjs';
import { lifeBeat } from '../lib/life.mjs';
import { walkPath } from '../public/house-view.mjs';

const opts = { ids: ['claude', 'gpt', 'gemini'], names: { claude: 'Claude', gpt: 'ChatGPT', gemini: 'Gemini' } };
const make = () => new House(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'house-walls-')), 'house.json'), opts);
// A 3x3 room (floors 5..7) closed by walls on every side; `door` opens one wall cell.
function sealedRoom(h, door = false) {
  for (let x = 5; x <= 7; x++) for (let z = 5; z <= 7; z++) h.s.floors[`${x},${z}`] = 'wood';
  for (let i = 4; i <= 8; i++) for (const [x, z] of [[i, 4], [i, 8], [4, i], [8, i]]) h.s.walls[`${x},${z}`] = { c: 'cream' };
  if (door) h.s.walls['6,8'] = { c: 'cream', door: true };
  // Floor outside the room so there is somewhere legal to go.
  for (let x = 10; x <= 12; x++) h.s.floors[`${x},10`] = 'wood';
  h.s.agents.claude = { x: 11, z: 10 };
}
const inside = (a) => a.x >= 5 && a.x <= 7 && a.z >= 5 && a.z <= 7;

test('AI members never stroll, walk near work or move into a room they cannot reach on foot', () => {
  const h = make(); sealedRoom(h);
  for (let i = 0; i < 40; i++) { h.wander('claude', () => i / 40); assert.ok(!inside(h.s.agents.claude), 'wander stays outside the sealed room'); }
  h.s.agents.claude = { x: 11, z: 10 };
  h.walkNear('claude', 6, 6);
  assert.ok(!inside(h.s.agents.claude), 'work next to the sealed room is watched from outside');
  assert.throws(() => h.act('claude', { type: 'move', x: 6, z: 6 }), /벽에 막혀서/);
  assert.deepEqual(h.reachable(11, 10).has('6,6'), false);
});

test('a door makes the room reachable, and everyday life only picks reachable spots', () => {
  const h = make(); sealedRoom(h, true);
  assert.ok(h.reachable(11, 10).has('6,6'));
  h.act('claude', { type: 'move', x: 6, z: 6 });
  assert.deepEqual([h.s.agents.claude.x, h.s.agents.claude.z], [6, 6]);
  // Shut the door with the member inside: life beats keep it inside the room.
  h.s.walls['6,8'] = { c: 'cream' };
  h.s.agents.gpt = { x: 11, z: 10 }; h.s.agents.gemini = { x: 12, z: 10 };
  for (let i = 0; i < 30; i++) {
    lifeBeat(h, 'claude', { mode: 'talk', partner: 'gpt', rand: () => (i % 10) / 10, now: i });
    assert.ok(inside(h.s.agents.claude), 'cannot walk through the wall to talk');
  }
});

test('the screen walks members around walls and reports when there is no way through', () => {
  const data = { size: 32, defs: {}, items: [], walls: [[5, 4, 'cream', false], [5, 5, 'cream', false], [5, 6, 'cream', false]] };
  const path = walkPath(data, { x: 4.5, z: 5.5 }, { x: 6, z: 5 });
  assert.ok(path.length > 2, 'goes around the wall instead of straight through');
  assert.ok(!path.some((p) => Math.floor(p.x) === 5 && Math.floor(p.z) >= 4 && Math.floor(p.z) <= 6), 'never steps on a wall cell');
  assert.deepEqual(path.at(-1), { x: 6.5, z: 5.5 });
  const boxed = { size: 32, defs: {}, items: [], walls: [[5, 6, 'c', false], [7, 6, 'c', false], [6, 5, 'c', false], [6, 7, 'c', false]] };
  assert.equal(walkPath(boxed, { x: 1.5, z: 1.5 }, { x: 6, z: 6 }), null);
});
