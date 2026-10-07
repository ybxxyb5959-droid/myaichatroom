import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { socialOutput, BIO_INTERVAL } from '../lib/social.mjs';
import { discuss, IDS } from '../lib/discussion.mjs';
import { createAssistantServer, loadConfig } from '../server.mjs';

test('social controls are stripped, validated, and default to work', () => {
  assert.deepEqual(socialOutput('안녕\n[대화유형] 잡담\n[공감] 12 👍'), {
    text: '안녕', kind: 'chat', reaction: { id: 12, emoji: '👍' }, imagePrompt: '',
  });
  assert.equal(socialOutput('자료 조사해줘').kind, 'work');
  assert.deepEqual(socialOutput('ㅎㅇ 용빈! 👋 [대화유형] 잡담'), { text: 'ㅎㅇ 용빈! 👋', kind: 'chat', reaction: null, imagePrompt: '' });
  assert.equal(socialOutput('[공감] 12 <script>').reaction, null);
  assert.equal(socialOutput('설명\n[이미지요청] 고양이').imagePrompt, '');
  assert.equal(socialOutput('[대화유형] 이미지\n[이미지요청] 고양이').imagePrompt, '고양이');
});

async function conversation(kind, picks, custom) {
  const calls = [], messages = [];
  const result = await discuss({
    adapter: { chat: async (id) => {
      calls.push(id);
      return { ok: true, text: custom ? custom(id) : `${id} 답변\n[대화유형] ${kind}` };
    } },
    request: { text: '질문', participants: IDS, peerIds: IDS, chatParticipants: picks,
      models: Object.fromEntries(IDS.map((id) => [id, { model: id }])), messageId: 1 },
    history: '', signal: new AbortController().signal, onState() {}, onLog() {},
    onMessage(m) { const saved = { ...m, id: messages.length + 2 }; messages.push(saved); return saved; },
  });
  return { calls, messages, result };
}

test('casual conversation supports one, two, or all speakers', async () => {
  for (let count = 1; count <= IDS.length; count++) {
    const h = await conversation('잡담', IDS.slice(0, count));
    assert.equal(h.calls.length, count);
  }
});
test('work and image requests reach everyone despite random casual selection', async () => {
  for (const kind of ['작업', '이미지']) {
    const h = await conversation(kind, ['claude']);
    assert.deepEqual(new Set(h.calls), new Set(IDS));
  }
});
test('peer mentions create real replies and stop after three extra calls', async () => {
  const h = await conversation('잡담', ['claude'], (id) =>
    `@${id === 'claude' ? 'gemini' : id === 'gemini' ? 'gpt' : 'claude'} 근거는?\n[대화유형] 잡담`);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.calls, ['claude', 'gemini', 'gpt', 'claude']);
  assert.equal(h.messages[1].replyTo, h.messages[0].id);
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-social-'));
  const now = { value: Date.now() };
  const control = { text: '안녕\n[대화유형] 잡담', images: [], imageFail: false };
  const adapter = {
    available: () => Object.fromEntries(IDS.map((id) => [id, true])),
    loginStatus: async () => ({ status: 'ok' }),
    chat: async () => ({ ok: true, text: control.text }),
    image: async (id, prompt) => {
      control.images.push({ id, prompt });
      if (control.imageFail) return { ok: false, detail: 'image tool unavailable' };
      const file = path.join(root, 'generated.png');
      fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJAAAAABJRU5ErkJggg==', 'base64'));
      return { ok: true, file };
    },
  };
  const app = createAssistantServer({ root, cfg: loadConfig(), adapter, greetings: false,
    autoTickMs: 3600000, clock: () => now.value, random: () => 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, body) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const send = async (body) => {
    const result = await post('/api/send', body);
    if (app.active) await app.active.done;
    return result;
  };
  return { app, post, send, now, control };
}

test('skipping and finishing setup never establish a connection', async (t) => {
  const h = await fixture(t);
  for (const body of [{ onboarding: { done: true } }, { models: { gpt: { model: 'gpt-test' } }, onboarding: { done: true } }]) {
    await h.post('/api/room', body);
    assert.ok(IDS.every((id) => !h.app.view().catalog[id].connected));
  }
  await h.post('/api/check/login', {});
  assert.ok(IDS.every((id) => h.app.view().catalog[id].connected));
});
test('replies and reactions persist and reject invalid targets', async (t) => {
  const h = await fixture(t);
  await h.send({ text: '안녕' });
  const target = h.app.view().messages.find((m) => IDS.includes(m.from));
  const reply = await h.send({ text: '너에게 답장', replyTo: target.id });
  assert.equal(reply.body.msg.replyTo, target.id);
  assert.equal(reply.body.msg.replyPreview.text, target.text);
  assert.equal((await h.post('/api/react', { id: target.id, emoji: '❤️' })).status, 200);
  assert.deepEqual(h.app.view().messages.find((m) => m.id === target.id).reactions['❤️'], ['user']);
  assert.equal((await h.post('/api/react', { id: -1, emoji: '❤️' })).status, 400);
  assert.equal((await h.send({ text: '답장', replyTo: -1 })).status, 400);
});
test('an image request to @claude is answered by Claude only and produces exactly one real image, never through Claude', async (t) => {
  const h = await fixture(t);
  await h.post('/api/check/login', {});
  h.control.text = '구도를 정리했어\n[대화유형] 이미지\n[이미지요청] 밤하늘의 고양이';
  await h.send({ text: '@claude 고양이 그림 만들어줘' });
  assert.equal(h.control.images.length, 1);
  assert.notEqual(h.control.images[0].id, 'claude');
  const messages = h.app.view().messages;
  assert.deepEqual([...new Set(messages.filter((m) => m.model && !m.attach).map((m) => m.from))], ['claude']); // @mention: only the named AI answers
  assert.equal(messages.filter((m) => m.attach?.generated).length, 1);
  assert.match(messages.find((m) => m.attach?.generated).text, /기획 .*이미지 생성/);
});
test('image failures are visible and never create fake attachments', async (t) => {
  const h = await fixture(t);
  await h.post('/api/check/login', {});
  h.control.imageFail = true;
  h.control.text = '요청 확인\n[대화유형] 이미지\n[이미지요청] 고양이';
  await h.send({ text: '그려줘' });
  assert.equal(h.control.images.length, 1);
  assert.ok(h.app.view().messages.some((m) => m.kind === 'error' && m.text.includes('이미지를 생성하지')));
  assert.ok(!h.app.view().messages.some((m) => m.attach?.generated));
});
test('bios have a persisted minimum day interval', async (t) => {
  const h = await fixture(t);
  h.control.text = '안녕\n[대화유형] 작업\n[소개] 오늘도 살아있다';
  await h.send({ text: '얘들아 인사' });
  h.control.text = '안녕\n[대화유형] 작업\n[소개] 샘알트먼 사랑해';
  await h.send({ text: '얘들아 인사' });
  assert.ok(IDS.every((id) => h.app.view().room.bios[id] === '오늘도 살아있다'));
  h.now.value += BIO_INTERVAL;
  await h.send({ text: '얘들아 인사' });
  assert.ok(IDS.every((id) => h.app.view().room.bios[id] === '샘알트먼 사랑해'));
});
