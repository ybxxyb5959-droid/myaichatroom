import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { roomFixture } from './helpers/room.mjs';

const said = (text) => () => ({ action: 'say', messages: [text] });

test('an image request answered in words only still makes the picture, once, by the member it was asked of', async (t) => {
  const s = await roomFixture(t, { reply: said('앱 아이콘 시안 그렸어!') });
  await s.start();
  await s.send('@ChatGPT ai들의 단톡방이라는 앱 예상 아이콘 이미지 생성좀');
  for (let i = 0; i < 4; i++) await s.advance(4000);
  assert.equal(s.images.length, 1);
  assert.equal(s.images[0].id, 'gpt');
  assert.match(s.images[0].prompt, /앱 예상 아이콘 이미지 생성좀/);
  assert.ok(!s.images[0].prompt.includes('@'), 'the mention is not part of the picture prompt');
  const picture = s.app.store.messages.find((m) => m.from === 'gpt' && m.attach?.path?.startsWith('images/'));
  assert.ok(picture, 'the picture is posted in the chat');
  assert.ok(fs.existsSync(path.join(s.root, 'workspace', picture.attach.path)), 'and saved in the workspace folder');
  const claim = s.app.store.messages.find((m) => m.from === 'gpt' && m.text === '앱 아이콘 시안 그렸어!');
  assert.ok(claim && claim.id > picture.id, '"그렸어" appears only after the picture is in the chat');
  for (let i = 0; i < 4; i++) await s.advance(10000);
  assert.equal(s.images.length, 1, 'the same request is not drawn again');
});

test('a request named to nobody is drawn by one member only; ordinary talk never makes pictures', async (t) => {
  const s = await roomFixture(t, { reply: said('좋아!') });
  await s.start();
  await s.send('오늘 저녁 뭐 먹지?');
  for (let i = 0; i < 4; i++) await s.advance(4000);
  assert.equal(s.images.length, 0);
  await s.send('귀여운 고양이 그림 그려줘');
  for (let i = 0; i < 4; i++) await s.advance(4000);
  assert.equal(s.images.length, 1);
});

test('when the picture cannot be made, the member does not claim it was drawn', async (t) => {
  const s = await roomFixture(t, { reply: said('바다 그림 그렸어 🌊') });
  s.adapter.image = async () => ({ ok: false, detail: '이미지 한도 초과' });
  await s.start();
  await s.send('@ChatGPT 바다그림 간단하게 그려줘');
  for (let i = 0; i < 4; i++) await s.advance(4000);
  assert.ok(!s.app.store.messages.some((m) => m.from === 'gpt' && /그렸어/.test(m.text)), 'no false claim');
  assert.ok(s.app.store.messages.some((m) => m.kind === 'error' && m.by === 'gpt' && /그림을 만들지 못했어/.test(m.text)));
});
