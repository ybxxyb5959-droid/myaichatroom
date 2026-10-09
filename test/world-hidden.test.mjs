import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';

test('build-world block lines stay out of the chat timeline and search, like house details', async (t) => {
  const s = await roomFixture(t);
  await s.send('같이 뭐 짓자');
  s.app.runtime.post({ from: 'system', kind: 'world', by: 'claude', text: 'Claude 49칸 놓음 (20,6,20~26,6,26)' });
  assert.ok(s.app.store.messages.some((m) => m.kind === 'world'), 'kept in the record');
  assert.ok(!s.app.view().messages.some((m) => m.kind === 'world'), 'not shown in the chat');
  assert.deepEqual((await s.post('/api/search', { q: '49칸' })).value.ids, []);
});
