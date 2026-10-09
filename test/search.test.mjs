import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';

test('chat search returns every matching message oldest first, ignoring case, and nothing for an empty query', async (t) => {
  const s = await roomFixture(t);
  const first = await s.send('오늘 저녁은 Pizza 어때?');
  await s.send('다른 이야기');
  s.app.runtime.post({ from: 'gpt', text: '피자 좋지! pizza 최고' });
  const last = s.app.store.messages.at(-1);
  const found = await s.post('/api/search', { q: 'PIZZA' });
  assert.equal(found.status, 200);
  assert.deepEqual(found.value.ids, [first.id, last.id]);
  assert.deepEqual((await s.post('/api/search', { q: '   ' })).value.ids, []);
  assert.deepEqual((await s.post('/api/search', { q: '없는 말' })).value.ids, []);
});
