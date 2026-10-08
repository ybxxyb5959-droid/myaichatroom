import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantServer, loadConfig } from '../server.mjs';
import { quotaOf, LOW_QUOTA } from '../public/status.mjs';

test('removed workbench endpoints and assets are unavailable, while chat and game files survive restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-removed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'linked-project');
  fs.mkdirSync(project);
  const original = 'existing project content\n';
  fs.writeFileSync(path.join(project, 'keep.txt'), original);
  const adapter = { available: () => ({ gpt: false, claude: false, gemini: false }) };
  const options = { root, cfg: loadConfig(path.join(root, 'no-user-config.json')), adapter, greetings: false, autoTickMs: 3600000 };
  const app = createAssistantServer(options);
  t.after(() => app.close());
  app.store.addMessage({ from: 'user', text: '기존 채팅 보존' });
  app.store.applyFileOp({ op: 'write', path: 'games/keep.html', content: '<!doctype html><title>기존 게임</title>' }, 'gpt');
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  for (const route of ['/api/workbench', '/api/workbench/directories', '/api/workbench/change', '/workbench.js', '/workbench.css']) {
    assert.equal((await fetch(url + route)).status, 404, route);
  }
  for (const action of ['project', 'session', 'settings', 'send', 'cancel', 'approve', 'restore', 'revert/preview', 'revert']) {
    const response = await fetch(`${url}/api/workbench/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: project }),
    });
    assert.equal(response.status, 404, action);
  }
  assert.equal(fs.existsSync(path.join(root, 'data/workbench/state.json')), false);
  assert.equal(fs.readFileSync(path.join(project, 'keep.txt'), 'utf8'), original);
  await app.close();
  const again = createAssistantServer(options);
  t.after(() => again.close());
  assert.ok(again.store.messages.some((m) => m.text === '기존 채팅 보존'));
  assert.ok(again.store.listFiles().some((f) => f.path === 'games/keep.html'));
  assert.equal(fs.existsSync(path.join(root, 'data/workbench/state.json')), false);
});

test('usage is shown only when fresh, and low or unknown shares are never guessed', () => {
  const now = Date.UTC(2026, 9, 7, 4);
  const report = (pcts, extra = {}) => ({ ok: true, at: now - 60000, windows: pcts.map(([id, used]) => ({ id, usedPct: used, remainingPct: 100 - used })), ...extra });
  assert.deepEqual(quotaOf('claude', report([['5h', 82], ['week', 40]]), now), { known: true, pct: 18, level: 'low', low: true });
  assert.deepEqual(quotaOf('gpt', report([['5h', 21]]), now), { known: true, pct: 79, level: 'ok', low: false });
  for (const bad of [undefined, null, report([['5h', 10]], { ok: false }), report([['5h', 10]], { restored: true }), report([['5h', 10]], { at: now - 31 * 60000 }), report([])]) {
    assert.deepEqual(quotaOf('gpt', bad, now), { known: false });
  }
  assert.equal(LOW_QUOTA, 20);
});
