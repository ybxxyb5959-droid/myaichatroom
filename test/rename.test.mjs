import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';

test('renaming the owner is announced in the chat and the very next AI turn uses the new name', async (t) => {
  const s = await roomFixture(t);
  await s.start();
  await s.send('안녕');
  await s.post('/api/room', { userName: '용빈' });
  const notice = s.app.store.messages.at(-1);
  assert.equal(notice.kind, 'presence');
  assert.match(notice.text, /방장이 이름을 방장에서 용빈\(으\)로 바꿨어요/);
  await s.post('/api/room', { userName: '용빈' });
  assert.equal(s.app.store.messages.filter((m) => /이름을/.test(m.text || '')).length, 1, 'the same name twice is not announced again');
  const before = s.calls.length;
  await s.turn('나 누구게?');
  const call = s.calls.slice(before).find((c) => !c.options.independent);
  assert.ok(call, 'an AI turn ran');
  assert.match(call.brief + call.prompt, /용빈/);
});
