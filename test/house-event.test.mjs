import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantServer, loadConfig } from '../server.mjs';

test('the owner can join an autonomous conflict; stale event links cannot decide a different conflict', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-event-'));
  let calls = 0;
  const app = createAssistantServer({ root, cfg: loadConfig(), greetings: false,
    adapter: { available: () => ({ claude: true, gpt: true, gemini: true }), chat: async () => { calls++; return { ok: true, text: 'hi' }; } } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  app.house.s.phase = 'life'; app.house.s.mode = 'auto';
  app.house.s.open = { eventId: 41, stage: 'conflict', type: 'tidy', pair: ['claude', 'gemini'], itemId: null,
    text: 'Claude와 Gemini가 정리 방식으로 티격태격함', ask: null };
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const view = await (await fetch(base + '/api/house')).json();
  assert.equal(view.open.eventId, 41); assert.equal(view.open.stage, 'conflict');
  const post = (body) => fetch(base + '/api/house/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const stale = await post({ choice: 'owner', eventId: 40, note: '다른 사건' });
  assert.equal(stale.status, 400); assert.equal(app.house.s.open.ask, null);
  const response = await post({ choice: 'owner', eventId: 41, note: '서로 번갈아 정리하자' });
  assert.equal(response.status, 200);
  const decided = await response.json();
  assert.match(decided.events.at(-1).text, /방장 의견.*서로 번갈아 정리하자/);
  assert.equal(app.house.s.mode, 'auto', 'joining one event does not change the autonomous setting');
  assert.equal(decided.open.stage, 'mediated');
  assert.equal((await post({ choice: 'owner', eventId: 41, note: '중복' })).status, 400);
  assert.equal(app.store.messages.filter((m) => m.kind === 'house-event').length, 1);
  assert.equal(calls, 0);
});
