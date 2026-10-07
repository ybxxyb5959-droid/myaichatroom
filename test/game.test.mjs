import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';
import { withHeadlessPage } from '../lib/worldshot.mjs';
import path from 'node:path';

test('any ordinary AI turn can write, edit and show an executable HTML game without a fixed collaboration pipeline', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({ action: 'say', messages: ['직접 만든 게임이야'],
    files: [{ op: 'write', path: 'game.html', content: '<!doctype html><button id="play">시작</button><p id="score">0</p><script>play.onclick=()=>score.textContent="1";</script>' }],
    show: 'game.html' }) });
  await s.start(); await s.turn('만들어 봐');
  assert.equal(s.calls.length, 1);
  assert.ok(s.app.store.messages.some((m) => m.attach?.path === 'game.html'));
  s.reply(() => ({ action: 'pass', files: [{ op: 'edit', path: 'game.html', find: 'textContent="1"', replace: 'textContent="2"' }] }));
  await s.turn('고쳐 봐');
  assert.equal(s.calls.length, 2);
  assert.match(s.app.store.readFile('game.html').text, /textContent="2"/);
  const response = await fetch(s.base + '/ws/game.html');
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /sandbox allow-scripts/); assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.equal((await (await fetch(s.base + '/api/file?path=game.html')).json()).activity, 'game');
  await withHeadlessPage(path.join(s.root, 'browser'), { timeoutMs: 30000 }, async (send) => {
    await send('Page.navigate', { url: s.base + '/ws/game.html' });
    await send('Runtime.evaluate', { expression: 'new Promise(resolve => { if (document.readyState === "complete") resolve(); else addEventListener("load", resolve, {once:true}); })', awaitPromise: true });
    const result = await send('Runtime.evaluate', { expression: 'document.getElementById("play").click(); document.getElementById("score").textContent', returnByValue: true });
    assert.equal(result.result.value, '2');
  });
});

test('workspace paths remain bounded and arbitrary host files are not exposed to generated games', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], reply: () => ({ action: 'pass', files: [
    { op: 'write', path: '../outside.txt', content: 'no' }, { op: 'write', path: 'safe.txt', content: 'yes' },
  ] }) });
  await s.start(); await s.turn('자료를 써 봐');
  assert.equal(s.app.store.readFile('safe.txt').text, 'yes');
  assert.ok(s.app.store.messages.some((m) => m.kind === 'error'));
  assert.equal((await fetch(s.base + '/api/room', { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
});
