import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { roomFixture } from './helpers/room.mjs';
import { shootWorld } from '../lib/worldshot.mjs';

// The house replaced the old block world: ordinary chat no longer describes it, and anything a member still
// sends for it is dropped while the rest of the reply goes through.
test('ordinary chat no longer offers the old block world and ignores world commands', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({
    action: 'say', messages: ['같은 턴에 건축할게'],
    block_define: { name: 'blue_tile', pixels: Array(8).fill('aaaaaaaa'), colors: { a: '#2244aa' } },
    build: [{ op: 'fill', from: [2, 1, 2], to: [3, 1, 3], block: 'planks' }], move: [9, 10],
    world_look: { y: 1 }, world_shot: { at: [4, 5] },
  }) });
  const spot = { ...s.app.world.avatars.gpt };
  await s.start(); await s.turn('함께 지어 봐');
  assert.equal(s.calls.length, 1, 'no re-ask for a world map or photo');
  assert.doesNotMatch(s.calls[0].brief, /건축 월드|"build"|world_shot|block_define/);
  assert.doesNotMatch(s.calls[0].prompt, /건축 월드/);
  assert.equal(s.app.world.blocks.size, 0);
  assert.deepEqual(s.app.world.avatars.gpt, spot, 'the old world character does not move');
  assert.ok(s.app.store.messages.some((m) => m.text === '같은 턴에 건축할게'));
  assert.ok(!s.app.store.messages.some((m) => m.kind === 'world'));
});

test('the old world viewer still renders under its CSP', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'] });
  s.app.world.apply({ op: 'hollow', from: [18, 1, 18], to: [24, 5, 24], block: 'brick' }, 'gpt');
  const shot = await shootWorld(s.root, s.app.server.address().port, { width: 640, height: 480, timeoutMs: 30000 });
  assert.equal(shot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(shot.readUInt32BE(16), 640); assert.equal(shot.readUInt32BE(20), 480);
});
