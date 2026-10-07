import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';

test('say/pass, reply_to, react and note_add are interpreted as the original JSON protocol', async (t) => {
  let target;
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({ action: 'say', messages: ['첫 말', '두 번째 말'], reply_to: target,
    react: { id: target, emoji: '👍' }, note_add: '하고 싶은 것: 탑 짓기' }) });
  await s.start();
  target = (await s.send('안녕')).id;
  await s.advance(); await s.advance(2000);
  const spoken = s.app.store.messages.filter((m) => m.from === 'gpt');
  assert.deepEqual(spoken.map((m) => m.text), ['첫 말', '두 번째 말']);
  assert.equal(spoken[0].replyTo, target); assert.equal(spoken[1].replyTo, undefined);
  assert.deepEqual(s.app.store.byId.get(target).reactions['👍'], ['gpt']);
  assert.match(s.app.store.readNote('gpt'), /하고 싶은 것: 탑 짓기/);
  s.reply(() => ({ action: 'pass', messages: ['보이면 안 됨'], note_replace: '정리한 메모' }));
  await s.turn('메모 정리해');
  assert.ok(!s.app.store.messages.some((m) => m.text === '보이면 안 됨'));
  assert.equal(s.app.store.readNote('gpt'), '정리한 메모');
  await s.reopen();
  assert.equal(s.app.view().room.memos.gpt, '정리한 메모');
});

test('an image is created by its requesting AI and only the original per-member image cooldown applies', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({ action: 'pass', image: { prompt: '작은 탑 그림', ref: 'gpt', save_as: 'stickers/gpt/tower.png' } }) });
  await s.start(); await s.turn('그림을 그려줘');
  await Promise.all([...s.app.runtime.jobs]);
  assert.equal(s.images.length, 1);
  assert.equal(s.images[0].id, 'gpt'); assert.equal(s.images[0].prompt, '작은 탑 그림');
  assert.ok(s.images[0].options.refSheet);
  assert.ok(s.app.store.listFiles().some((f) => f.path === 'stickers/gpt/tower.png'));
  await s.turn('한 장 더'); await Promise.all([...s.app.runtime.jobs]);
  assert.equal(s.images.length, 1);
  await s.advance(240000);
  await s.turn('이제 한 장 더'); await Promise.all([...s.app.runtime.jobs]);
  assert.equal(s.images.length, 2);
});
