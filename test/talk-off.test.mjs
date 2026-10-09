import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';

const callsBy = (s, id) => s.calls.filter((call) => call.id === id && !call.options.independent).length;

test('with Talk off the members still answer the owner, once each, but never start talking among themselves', async (t) => {
  const s = await roomFixture(t, { reply: ({ id }) => (id === 'claude' ? { action: 'say', messages: ['@GPT 너는 어떻게 생각해?'] } : { action: 'pass' }) });
  assert.equal(s.app.view().room.auto.on, false, 'Talk starts off');
  // Left alone, nobody says anything.
  for (let i = 0; i < 6; i++) await s.advance(120000);
  assert.equal(s.calls.length, 0);
  await s.send('클로드야 안녕?');
  await s.advance(0); await s.advance(4000);
  assert.ok(s.app.store.messages.some((m) => m.from === 'claude' && /너는 어떻게 생각해/.test(m.text)), 'the owner gets an answer');
  const asked = { claude: callsBy(s, 'claude'), gpt: callsBy(s, 'gpt') };
  assert.equal(asked.claude, 1);
  assert.equal(asked.gpt, 0, 'a message that names Claude is answered by Claude only');
  // Claude's question to GPT is talk among members: with Talk off it does not wake GPT.
  for (let i = 0; i < 5; i++) await s.advance(10000);
  assert.equal(callsBy(s, 'gpt'), asked.gpt);
  assert.equal(callsBy(s, 'claude'), 1);
  assert.equal(s.app.view().room.auto.on, false, 'answering does not switch Talk on');
});
