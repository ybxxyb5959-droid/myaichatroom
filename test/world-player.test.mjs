import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';
import { movementStep, createUserAvatar, BlockHold } from '../public/world-player.js';

async function join(s) {
  const r = await s.post('/api/world/join', {});
  assert.equal(r.status, 200);
  return r.value;
}
const point = (p, dx = 1, dy = 0, dz = 0) => [p.x + dx, p.y + dy, p.z + dz];

test('owner joins, moves one step, cannot teleport or cross walls; movement never calls an AI', async (t) => {
  const s = await roomFixture(t), entry = await join(s), { token, position } = entry;
  assert.equal((await s.post('/api/world/join', {})).status, 409);
  assert.equal((await s.post('/api/world/move', { token: 'wrong', dx: 1, dz: 0 })).status, 409);
  for (const dx of [20, .5, '1']) assert.equal((await s.post('/api/world/move', { token, dx, dz: 0 })).status, 400);
  s.app.world.apply({ op: 'fill', from: point(position), to: point(position, 1, 3), block: 'stone' }, 'gpt');
  assert.equal((await s.post('/api/world/move', { token, dx: 1, dz: 0 })).value.blocked, true);
  await s.advance(200);
  const moved = await s.post('/api/world/move', { token, dx: -1, dz: 0 });
  assert.equal(moved.value.position.x, position.x - 1);
  assert.equal((await s.post('/api/world/move', { token, dx: -1, dz: 0 })).status, 429);
  assert.equal(s.calls.length, 0);
  await s.post('/api/world/leave', { token });
  const w = await fetch(s.base + '/api/world').then(r => r.json());
  assert.equal(w.player.active, false); assert.equal(w.avatars.user, undefined);
});

test('player can step onto one block, walk through a door, fall when support disappears, and expires', async (t) => {
  const s = await roomFixture(t), { token, position: p } = await join(s);
  s.app.world.apply({ op: 'place', at: point(p), block: 'stone' }, 'gpt');
  const up = await s.post('/api/world/move', { token, dx: 1, dz: 0 });
  assert.equal(up.value.position.y, p.y + 1);
  s.app.world.apply({ op: 'remove', at: point(p) }, 'gpt');
  await s.advance(200);
  let w = await fetch(s.base + '/api/world').then(r => r.json());
  assert.equal(w.avatars.user.y, p.y);
  s.app.world.apply({ op: 'fill', from: point(p, 2), to: point(p, 2, 1), block: 'door' }, 'gpt');
  assert.equal((await s.post('/api/world/move', { token, dx: 1, dz: 0 })).value.position.x, p.x + 2);
  await s.advance(30001);
  w = await fetch(s.base + '/api/world').then(r => r.json());
  assert.equal(w.player.active, false);
  assert.equal((await s.post('/api/world/heartbeat', { token })).status, 409);
});

test('nearby block edits preserve ownership/signs, undo works without overwriting later AI edits', async (t) => {
  const s = await roomFixture(t), { token, position: p } = await join(s), at = point(p), k = at.join(',');
  s.app.world.apply([{ op: 'place', at, block: 'brick', shape: 'stair', facing: 'e' },
    { op: 'sign', at, text: '내 작품' }], 'gpt');
  const original = s.app.world.cell(k);
  const removed = await s.post('/api/world/edit', { token, op: 'remove', at });
  assert.equal(removed.status, 200); assert.equal(s.app.world.blocks.has(k), false); assert.equal(s.app.world.signs[k], undefined);
  await s.advance(300);
  assert.equal((await s.post('/api/world/undo', { token })).status, 200);
  assert.equal(s.app.world.blocks.get(k), original.block);
  assert.equal(s.app.world.owners[k], 'gpt'); assert.deepEqual(s.app.world.signs[k], original.sign);
  await s.advance(300);
  await s.post('/api/world/edit', { token, op: 'remove', at });
  s.app.world.apply({ op: 'place', at, block: 'lamp' }, 'claude');
  await s.advance(300);
  assert.equal((await s.post('/api/world/undo', { token })).status, 409);
  assert.equal(s.app.world.blocks.get(k), 'lamp'); assert.equal(s.app.world.owners[k], 'claude');
  await s.reopen();
  assert.equal(s.app.world.owners[k], 'claude');
});

test('edit validation protects ground, distance, occupied cells, character and request rate', async (t) => {
  const s = await roomFixture(t), { token, position: p } = await join(s);
  for (const at of [[p.x, 0, p.z], [100, 1, 1], [p.x + 10, 1, p.z], [p.x, 1.5, p.z]])
    assert.equal((await s.post('/api/world/edit', { token, op: 'remove', at })).status, 400);
  assert.equal((await s.post('/api/world/edit', { token, op: 'place', at: point(p, 0), block: 'stone' })).status, 400);
  assert.equal((await s.post('/api/world/edit', { token, op: 'fill', at: point(p), block: 'stone' })).status, 400);
  assert.equal((await s.post('/api/world/edit', { token, op: 'place', at: point(p), block: 'invalid' })).status, 400);
  assert.equal((await s.post('/api/world/edit', { token, op: 'place', at: point(p), block: 'stone' })).status, 200);
  assert.equal((await s.post('/api/world/edit', { token, op: 'remove', at: point(p) })).status, 429);
  await s.advance(300);
  assert.equal((await s.post('/api/world/edit', { token, op: 'place', at: point(p), block: 'stone' })).status, 409);
  const cross = await fetch(s.base + '/api/world/join', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(cross.status, 403);
});

test('consecutive own edits undo in order; legacy creator stays unknown', async (t) => {
  const s = await roomFixture(t), { token, position: p } = await join(s), at = point(p), k = at.join(',');
  s.app.world.blocks.set(k, 'stone');
  await s.post('/api/world/edit', { token, op: 'remove', at });
  await s.advance(300);
  await s.post('/api/world/edit', { token, op: 'place', at, block: 'brick' });
  await s.advance(300);
  assert.equal((await s.post('/api/world/undo', { token })).status, 200);
  await s.advance(300);
  assert.equal((await s.post('/api/world/undo', { token })).status, 200);
  assert.equal(s.app.world.blocks.get(k), 'stone'); assert.equal(s.app.world.owners[k], undefined);
});

test('rapid edits become one factual event and real model reactions use the ordinary prompt, without waking OFF', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({ action: 'say', messages: ['야ㅋㅋ 내 벽돌!'] }) });
  const { token, position: p } = await join(s);
  for (let i = 1; i <= 3; i++) {
    const at = point(p, i);
    s.app.world.apply({ op: 'place', at, block: 'brick' }, 'gpt');
    assert.equal((await s.post('/api/world/edit', { token, op: 'remove', at })).status, 200);
    await s.advance(300);
  }
  await s.advance(1000);
  const events = s.app.store.messages.filter(m => m.kind === 'world-player');
  assert.equal(events.length, 1); assert.match(events[0].text, /3칸 부숨.*ChatGPT/); assert.equal(events[0].from, 'system');
  assert.equal(s.calls.length, 0); assert.equal(s.app.room.auto.on, false);
  await s.start(); await s.advance(0); await s.advance(12000);
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].prompt, /3칸 부숨/);
  assert.ok(s.app.store.messages.some(m => m.from === 'gpt' && m.text === '야ㅋㅋ 내 벽돌!'));
  const sent = await s.post('/api/send', { text: 'ㅋㅋ 미안 복구할게' });
  assert.equal(sent.status, 200); assert.equal(sent.value.msg.from, 'user');
});

test('keyboard and joystick share camera-relative movement; user character is block-shaped and animated', () => {
  assert.deepEqual(movementStep(0, -1, { x: 0, z: -1 }), { dx: 0, dz: -1 });
  assert.deepEqual(movementStep(1, 0, { x: 0, z: -1 }), { dx: 1, dz: 0 });
  assert.deepEqual(movementStep(0, -1, { x: 1, z: 0 }), { dx: 1, dz: 0 });
  assert.equal(movementStep(0, 0, { x: 0, z: -1 }), null);
  const a = createUserAvatar();
  assert.equal(a.limbs.length, 4);
  a.animate(100, true); assert.notEqual(a.limbs[0].rotation.x, 0);
  a.animate(100, false); assert.equal(a.limbs[0].rotation.x, 0);
  let boxes = 0;
  a.group.traverse(o => { if (o.geometry?.type === 'BoxGeometry') boxes++; });
  assert.ok(boxes >= 12);
});

test('holding edits once after 650ms; short taps, camera drags, release and pinch cancellation do not edit', () => {
  let edits = 0;
  const hold = new BlockHold(() => edits++);
  hold.start(100, 100, 0);
  assert.ok(hold.tick(400) > 0); assert.equal(edits, 0);
  hold.cancel(); hold.tick(1000); assert.equal(edits, 0);
  hold.start(100, 100, 1000); hold.move(108, 100); hold.tick(2000); assert.equal(edits, 0);
  hold.start(100, 100, 2000);
  hold.tick(2649); assert.equal(edits, 0);
  hold.tick(2650); assert.equal(edits, 1);
  hold.tick(5000); assert.equal(edits, 1);
  hold.start(100, 100, 6000); hold.move(103, 103); hold.tick(6650); assert.equal(edits, 2);
  hold.start(100, 100, 7000); hold.cancel(); hold.tick(8000); assert.equal(edits, 2);
});
