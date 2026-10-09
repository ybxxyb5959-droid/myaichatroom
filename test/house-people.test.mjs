import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';

test('owner and friends appear in the house only while their screen is open, walk around walls and speak in bubbles', async (t) => {
  const s = await roomFixture(t);
  const rt = s.app.houseRuntime, h = s.app.house;
  // Construction has barely started: people can still walk in on the open ground.
  assert.equal(rt.view().player, null, 'nobody is inside before opening the house');
  const owner = (await fetch(`${s.base}/api/house`).then((r) => r.json()));
  assert.ok(owner.player, 'opening the house walks the owner in');
  assert.deepEqual(Object.keys(owner.people), ['user']);
  rt.enter('guest:g1');
  const friend = h.s.visitors['guest:g1'];
  assert.ok(friend && h.walkable(friend.x, friend.z));
  assert.notDeepEqual([friend.x, friend.z], [h.s.player.x, h.s.player.z], 'people do not appear on top of each other');
  assert.deepEqual(Object.keys(rt.view().people).sort(), ['guest:g1', 'user']);
  assert.equal(rt.view('g1').player, h.s.visitors['guest:g1'], "a friend's view carries their own character");
  // A wall blocks a friend exactly like the owner.
  const { x, z } = friend;
  h.s.walls[`${x + 1},${z}`] = { c: 'cream' };
  rt.personAction('guest:g1', { action: 'move', dx: 1, dz: 0 });
  assert.deepEqual([friend.x, friend.z], [x, z]);
  h.s.walls[`${x + 1},${z}`].door = true;
  rt.personAction('guest:g1', { action: 'move', dx: 1, dz: 0 });
  assert.deepEqual([friend.x, friend.z], [x + 1, z]);
  assert.throws(() => rt.personAction('guest:g1', { action: 'move', dx: 2, dz: 0 }), /한 칸/);
  // A line said from the house screen becomes a bubble entry for that friend.
  rt.personSay('guest:g1', '안녕 다들!', 77);
  assert.deepEqual(h.s.log.at(-1), { kind: 'say', id: 'guest:g1', text: '안녕 다들!', at: s.clock.now, source: 'guest', speechId: 'house-chat-77' });
  // Closing the screen (no polling) lets the character leave after a while; names follow who is inside.
  s.clock.now += 46000;
  rt.enter('user');
  assert.deepEqual(Object.keys(rt.view().people), ['user']);
  assert.equal(rt.view().names['guest:g1'], undefined);
});
