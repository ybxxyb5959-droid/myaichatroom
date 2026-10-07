import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { roomFixture } from './helpers/room.mjs';
import { shootWorld } from '../lib/worldshot.mjs';

test('speech, custom blocks, signs and movement are one ordinary response; the world survives restart', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({
    action: 'say', messages: ['같은 턴에 건축할게'],
    block_define: { name: 'blue_tile', pixels: Array(8).fill('aaaaaaaa'), colors: { a: '#2244aa' } },
    build: [{ op: 'fill', from: [2, 1, 2], to: [3, 1, 3], block: 'planks' },
      { op: 'place', at: [2, 2, 2], block: 'blue_tile' }, { op: 'sign', at: [3, 2, 3], text: '공동 작업실' }],
    move: [9, 10],
  }) });
  await s.start(); await s.turn('함께 지어 봐');
  assert.equal(s.calls.length, 1);
  assert.equal(s.app.world.blocks.size, 5);
  assert.equal(s.app.world.blocks.get('2,2,2'), 'blue_tile');
  assert.equal(s.app.world.signs['3,2,3'].text, '공동 작업실');
  assert.deepEqual(s.app.world.avatars.gpt, { x: 9, z: 10 });
  assert.ok(s.app.store.messages.some((m) => m.text === '같은 턴에 건축할게'));
  const before = s.app.world.view();
  await s.reopen(); assert.deepEqual(s.app.world.view(), before);
});

test('original world_look re-asks within the same turn and then processes the returned action', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: (_c, n) => n === 1 ? { action: 'pass', world_look: { y: 1 } }
    : { action: 'say', messages: ['지도를 보고 지었어'], build: [{ op: 'place', at: [4, 1, 4], block: 'stone' }] } });
  await s.start(); await s.turn('둘러 봐');
  assert.equal(s.calls.length, 2);
  assert.match(s.calls[1].prompt, /건축 월드 지도/);
  assert.equal(s.app.world.blocks.get('4,1,4'), 'stone');
  assert.equal(s.app.room.auto.usage.calls, 2);
});

test('screenshots are attached to a follow-up and the original viewer renders under its CSP', async (t) => {
  let options;
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const s = await roomFixture(t, { ids: ['gpt'], shot: async (_root, _port, value) => { options = value; return png; },
    reply: (_c, n) => n === 1 ? { action: 'pass', world_shot: { at: [4, 5], night: true, url: 'https://invalid.example' } } : { action: 'pass' } });
  await s.start(); await s.turn('사진을 봐');
  assert.equal(options.tx, 4.5); assert.equal(options.tz, 5.5); assert.equal(options.url, undefined);
  assert.deepEqual(fs.readFileSync(s.calls[1].options.images[0]), png);
  s.app.world.apply({ op: 'hollow', from: [18, 1, 18], to: [24, 5, 24], block: 'brick' }, 'gpt');
  const shot = await shootWorld(s.root, s.app.server.address().port, { width: 640, height: 480, timeoutMs: 30000 });
  assert.equal(shot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(shot.readUInt32BE(16), 640); assert.equal(shot.readUInt32BE(20), 480);
});
