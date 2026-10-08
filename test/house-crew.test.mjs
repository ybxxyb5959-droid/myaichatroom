import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { House, HOUSE_LIMITS, USES } from '../lib/house.mjs';
import { validateDesign } from '../lib/house-project.mjs';
import { playerAction } from '../lib/house-player.mjs';
import { roomFixture } from './helpers/room.mjs';

const options = { ids: ['claude', 'gpt', 'gemini'], names: { claude: 'Claude', gpt: 'GPT', gemini: 'Gemini' } };
function seed(store) {
  const h = new House(path.join(store.dataDir, 'house.json'), options);
  const design = validateDesign({ title: '기존 방 마무리', rooms: [
    { name: '기존 방', owner: 'gpt', x1: 2, z1: 2, x2: 5, z2: 5, min: 1, uses: [] },
  ], walls: [[1, 2, 1, 5]], entry: [2, 2] }, options.ids, HOUSE_LIMITS, USES);
  h.s.planning = { design, pending: null, nextId: 1, feedback: '' };
  for (let x = 2; x <= 5; x++) for (let z = 2; z <= 5; z++) h.s.floors[`${x},${z}`] = 'wood';
  h.s.agents.gpt = { x: 2, z: 2 };
  h.save();
}

test('one member finishes at most two turns, saves a handoff across restart and hands work to a returning member', async (t) => {
  let count = 0;
  const s = await roomFixture(t, { ids: ['gpt', 'claude'], seed, discussionReply: () => {
    count++;
    return { ok: true, text: JSON.stringify({
      say: '기존 벽만 마무리했어', actions: count <= 2
        ? [{ type: 'wall', x1: 1, x2: 1, z1: count === 1 ? 2 : 4, z2: count === 1 ? 3 : 5, color: 'cream' }] : [],
      handoff: { remaining: '가구 배치가 남았어', next: '기존 방의 책장을 확인해줘', x: 3, z: 3 },
    }) };
  } });
  s.app.runtime.setEnabled('claude', false);
  await s.start();
  await s.post('/api/house/active', { active: true });
  await s.app.houseRuntime.tick(); await s.app.houseRuntime.tick();
  assert.equal(s.calls.length, 2);
  assert.equal(Object.keys(s.app.house.s.walls).length, 4);
  assert.equal(s.app.houseRuntime.view().crew.waiting, true);
  assert.equal(s.app.house.s.crew.handoff.next, '기존 방의 책장을 확인해줘');
  assert.deepEqual(s.app.house.s.crew.handoff.location, { x: 3, z: 3 });
  await s.app.houseRuntime.tick(); assert.equal(s.calls.length, 2);
  await s.reopen();
  await s.app.houseRuntime.tick();
  assert.equal(s.calls.length, 2); assert.equal(s.app.house.s.crew.waiting, true);
  s.app.runtime.setEnabled('claude', true);
  await s.app.houseRuntime.tick();
  assert.equal(s.calls.length, 3); assert.equal(s.calls[2].id, 'claude');
  assert.match(s.calls[2].prompt, /저장된 작업 인계/);
  assert.match(s.calls[2].prompt, /기존 방의 책장을 확인해줘/);
  assert.equal(s.app.house.s.crew.waiting, false);
  assert.equal(s.app.house.s.crew.handoff.pending, false);
  assert.equal(s.app.house.s.crew.handoff.resumedBy, 'claude');
  assert.equal(s.app.houseRuntime.view().agents.claude.spawn > 0, true);
});

test('solo finishing refuses new rooms, demolition and multiple work units, but an owner can explicitly continue', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], seed, discussionReply: () => ({ ok: true, text: JSON.stringify({
    say: '마무리할게', actions: [
      { type: 'wall', x1: 1, x2: 1, z1: 2, z2: 3, color: 'cream' },
      { type: 'floor', x1: 20, x2: 21, z1: 20, z2: 21, color: 'wood' },
      { type: 'erase', x: 2, z: 2 },
    ],
  }) }) });
  await s.start(); await s.post('/api/house/active', { active: true }); await s.app.houseRuntime.tick(); await s.app.houseRuntime.tick();
  assert.equal(s.app.house.s.floors['20,20'], undefined);
  assert.equal(s.app.house.s.floors['2,2'], 'wood');
  assert.equal(s.app.house.s.crew.waiting, true);
  const result = await s.post('/api/house/continue-solo', {});
  assert.equal(result.status, 200); assert.equal(result.value.crew.override, true);
  await s.app.houseRuntime.tick();
  assert.equal(s.calls.length, 3);
  assert.equal(s.app.house.s.floors['20,20'], 'wood');
});

test('a sole member without an approved task waits without wasting AI calls; ordinary chat remains separate', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'] });
  await s.start(); await s.post('/api/house/active', { active: true }); await s.app.houseRuntime.tick();
  assert.equal(s.calls.length, 0);
  assert.equal(s.app.house.s.crew.waiting, true);
  assert.equal(s.app.runtime.room.running, true);
  assert.equal(s.app.house.s.crew.handoff.source, 'saved-state');
  assert.equal((await s.post('/api/house/continue-solo', {})).status, 200);
  assert.equal(s.app.house.s.crew.waiting, false);
});

test('failed solo turns also stop after two calls without an extra summarization call', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], seed, discussionReply: () => ({ ok: false, detail: 'offline' }) });
  await s.start(); await s.post('/api/house/active', { active: true }); await s.app.houseRuntime.tick();
  s.clock.now += 20000; await s.app.houseRuntime.tick();
  s.clock.now += 300000; await s.app.houseRuntime.tick();
  assert.equal(s.calls.length, 2); assert.equal(s.app.house.s.crew.waiting, true);
  assert.equal(s.app.house.s.crew.handoff.source, 'saved-state');
});

test('only deactivation hides a character; reactivation respawns it once, not on retry backoff or polling', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt', 'claude'], seed });
  const r = s.app.houseRuntime;
  s.app.runtime.agents.claude.offlineUntil = s.clock.now + 60000;
  r.syncCrew();
  assert.ok(r.view().agents.claude);
  const old = structuredClone(s.app.house.s.agents.claude);
  r.syncCrew(); assert.deepEqual(s.app.house.s.agents.claude, old);
  s.app.runtime.setEnabled('claude', false); r.syncCrew();
  assert.equal(r.view().agents.claude, undefined);
  assert.ok(s.app.house.s.agents.claude, 'historical character data is not deleted');
  s.app.runtime.setEnabled('claude', true); r.syncCrew();
  const spawn = structuredClone(r.view().agents.claude);
  assert.ok(spawn.spawn > 0);
  assert.equal(s.app.house.s.floors[`${spawn.x},${spawn.z}`], 'wood');
  assert.notDeepEqual([spawn.x, spawn.z], [s.app.house.s.agents.gpt.x, s.app.house.s.agents.gpt.z]);
  r.syncCrew(); assert.deepEqual(r.view().agents.claude, spawn);
  assert.equal(s.calls.length, 0, 'appearance does not invoke an AI');
});

test('spawn tiles exclude walls, furniture, other characters and the player; absent characters do not reserve furniture', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-spawn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = new House(path.join(root, 'house.json'), options);
  for (let x = 1; x <= 5; x++) h.s.floors[`${x},1`] = 'wood';
  h.s.walls['1,1'] = { c: 'cream' };
  h.s.defs.sofa = { use: 'sit', parts: [{ s: 'box', x: 0, y: 0, z: 0, w: 1, h: .5, d: 1, c: 'blue' }] };
  h.s.items = [{ id: 1, def: 'sofa', x: 2, z: 1, rot: 0, by: 'claude' }];
  h.s.agents.gpt = { x: 3, z: 1 };
  h.s.player = { x: 4, z: 1 };
  h.s.agents.claude = { x: 2, z: 1, pose: 'sit', furnitureId: 1 };
  h.spawnMember('claude', ['gpt', 'claude'], () => .5);
  assert.deepEqual(h.s.agents.claude, { x: 5, z: 1, spawn: 1 });
  h.s.phase = 'life'; h.s.player = { x: 3, z: 1 };
  h.s.agents.gpt = { x: 10, z: 10 };
  h.s.agents.claude = { x: 2, z: 1, pose: 'sit', furnitureId: 1 };
  playerAction(h, { action: 'interact' }, options.names, 1, ['gpt']);
  assert.equal(h.s.player.pose, 'sit');
  h.s.floors = {};
  h.spawnMember('claude', ['gpt', 'claude'], () => .5);
  const { x, z } = h.s.agents.claude;
  assert.equal(h.s.walls[`${x},${z}`], undefined);
  assert.equal(h.itemAt(x, z), undefined);
  assert.notDeepEqual([x, z], [h.s.agents.gpt.x, h.s.agents.gpt.z]);
});
