import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantServer, loadConfig } from '../server.mjs';

test('legacy house event APIs are disabled without changing saved house data', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-event-'));
  fs.mkdirSync(path.join(root, 'data'));
  const file = path.join(root, 'data', 'house.json');
  const saved = '{"phase":"life","mode":"auto","open":{"eventId":41,"stage":"conflict"}}';
  fs.writeFileSync(file, saved);
  let calls = 0;
  const app = createAssistantServer({ root, cfg: loadConfig(), greetings: false,
    adapter: { available: () => ({ claude: true, gpt: true, gemini: true }), chat: async () => { calls++; return { ok: true, text: 'hi' }; } } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base + '/api/house')).status, 404);
  for (const action of ['decide', 'undo', 'mode', 'player']) {
    const response = await fetch(`${base}/api/house/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"choice":"owner","eventId":41}' });
    assert.equal(response.status, 404);
  }
  assert.equal((await fetch(base + '/api/world')).status, 200);
  assert.equal(app.store.messages.filter((m) => m.kind === 'house-event').length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.equal(calls, 0);
});
