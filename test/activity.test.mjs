import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ActivityLog } from '../lib/activity.mjs';
import { roomFixture } from './helpers/room.mjs';

test('activity remains a bounded, persisted UI log, not an AI action selector', async (t) => {
  const s = await roomFixture(t, { ids: [] });
  const log = new ActivityLog(path.join(s.root, 'activity.json'), { max: 3, clock: () => s.clock.now });
  for (let i = 0; i < 6; i++) log.add({ kind: 'talk', actors: ['gpt'], text: `말 ${i}`, ref: { messageId: i } });
  assert.equal(log.list().length, 3);
  assert.equal(log.list()[0].ref.messageId, 5);
  assert.ok(fs.existsSync(log.file));
  await s.start();
  for (let i = 0; i < 20; i++) await s.advance(3600000);
  assert.equal(s.calls.length, 0);
  assert.equal(s.app.store.listFiles().length, 0);
  assert.ok(!s.app.store.messages.some((m) => m.auto === 'ambient' || m.auto === 'life' || m.kind === 'digest'));
});

test('ordinary preview reports the room, never a chosen representative, while debate preview remains explicit', async (t) => {
  const s = await roomFixture(t);
  const preview = async (text) => (await fetch(s.base + '/api/preview?text=' + encodeURIComponent(text))).json();
  const normal = await preview('@GPT 안녕');
  assert.equal(normal.kind, 'room');
  assert.equal(normal.ids.length, 3);
  assert.deepEqual(normal.priority, ['gpt']);
  assert.equal(normal.reason, undefined);
  await s.post('/api/room', { discussion: true });
  const debate = await preview('@GPT @Claude 비교');
  assert.equal(debate.kind, 'discussion');
  assert.deepEqual(debate.ids.sort(), ['claude', 'gpt']);
});
