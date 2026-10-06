import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAssistantServer, loadConfig } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { ACTIVITY_PROMPT } from '../lib/activities.mjs';
import { GAME_BRIEF, gameDocument, parseDraft, applyGamePatches, syntaxCheck } from '../lib/game.mjs';
import { checkGame } from '../lib/gamecheck.mjs';
import { shootWorld } from '../lib/worldshot.mjs';

const code = {
  body: '<h1>클릭 게임</h1><button id="start">시작</button><p id="score">0점</p>',
  css: 'button{padding:12px}',
  js: 'let score=0;document.getElementById("start").onclick=()=>{score+=1;document.getElementById("score").textContent=score+"점";};',
};
const draft = () => JSON.stringify({ text: '초안 만들었어. 너도 기능 붙여 봐.', title: '클릭 게임', code });
const addition = () => JSON.stringify({ text: '한 번 누르면 2점씩 오르게 붙였어.', patches: [{ field: 'js', find: 'score+=1', replace: 'score+=2' }] });
const final = () => JSON.stringify({ text: '마지막 확인 끝! 같이 만든 게임이야.', patches: [] });
const HOUR = 3600000;
async function start(root, log, opts = {}) {
  const clock = log.clock || { t: new Date(2026, 9, 6, 8).getTime() };
  log.clock = clock;
  const adapter = {
    available: () => ({ claude: true, gpt: true, gemini: false }),
    listModels: async () => [{ id: 'gpt-6-luna', description: 'Fast and affordable model', efforts: ['low'] }],
    chat: async (id, brief, prompt, settings) => {
      log.calls.push({ id, brief, prompt, settings });
      if (brief.startsWith(GAME_BRIEF)) {
        const n = log.gameCalls++;
        if (log.wait && n === 1) {
          await new Promise((resolve) => settings.signal.addEventListener('abort', resolve, { once: true }));
          return { ok: true, text: addition() };
        }
        if (log.quota) return { ok: false, detail: 'usage limit reached api_key=SECRET123' };
        return { ok: true, text: [draft(), addition(), final()][n % 3] };
      }
      if (prompt.includes(ACTIVITY_PROMPT))
        return { ok: true, text: '{"text":"야, 같이 클릭 게임이나 만들래?","activity":{"kind":"game","theme":"party","title":"클릭 게임","prompt":"클릭하면 점수를 모으는 게임"}}' };
      return { ok: true, text: '그냥 수다야.' };
    },
  };
  const app = createAssistantServer({ root, cfg: { ...loadConfig(), autoSleepMinutes: 0 }, adapter, clock: () => clock.t,
    random: () => .5, autoTickMs: HOUR, pairDelayMs: 0, greetings: false,
    gameChecker: async ({ code: current }) => {
      log.checks.push({ ...current });
      return log.failCheck ? { ok: false, errors: ['게임 실행 오류'] } : syntaxCheck(current);
    }, ...opts });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, body) => {
    const res = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, value: await res.json() };
  };
  return { app, url, post, clock, state: async () => (await fetch(url + '/api/state')).json() };
}
const fresh = () => ({ calls: [], gameCalls: 0, checks: [] });
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-collab-'));

test('게임 수정은 지정된 코드 부분만 바꾸고, 경로·중복 일치·과대 코드를 거부한다', () => {
  const first = parseDraft(draft());
  const next = applyGamePatches(first.code, addition());
  assert.match(next.code.js, /score\+=2/);
  assert.equal(next.code.body, code.body);
  assert.throws(() => applyGamePatches(code, '{"patches":[{"field":"path","find":"a","replace":"../../x"}]}'));
  assert.throws(() => applyGamePatches({ ...code, body: 'aa' }, '{"patches":[{"field":"body","find":"a","replace":"b"}]}'));
  assert.throws(() => parseDraft(JSON.stringify({ text: '초안', code: { ...code, js: 'x'.repeat(8001) } })));
  assert.throws(() => parseDraft(JSON.stringify({ text: '초안', code: { ...code, js: '</script><script>' } })));
  assert.ok(!gameDocument('<script>제목</script>', code).includes('<title><script>'));
  assert.equal(syntaxCheck({ ...code, js: 'process.exit(1)' }).ok, true); // compile only; never execute in Node
});

test('A 초안 → B 변경 부분 추가 → A 최종 확인, 제작 3회 후 검증된 게임만 작업공간에 올린다', async () => {
  const root = temp(); const log = fresh(); const s = await start(root, log);
  try {
    await s.post('/api/room', { auto: { on: true } });
    s.clock.t += 20000; await s.app.tick();
    const view = await s.state();
    const calls = log.calls.filter((c) => c.brief.startsWith(GAME_BRIEF));
    assert.equal(calls.length, 3);
    assert.equal(calls[0].id, calls[2].id); assert.notEqual(calls[0].id, calls[1].id);
    assert.ok(calls.every((c) => c.settings.independent && !c.settings.webSearch));
    assert.ok(calls[1].prompt.includes('score+=1')); assert.ok(calls[2].prompt.includes('score+=2'));
    assert.equal(log.checks.length, 3);
    assert.match(log.checks[2].js, /score\+=2/);
    assert.equal(view.room.auto.usage.calls, 4); // one invitation + three code-writing turns
    assert.equal(view.room.auto.usage.games, 1); assert.equal(view.room.auto.usage.creations, 1);
    assert.deepEqual(view.messages.filter((m) => m.gameStage !== undefined).map((m) => m.gameStage), [0, 1, 2]);
    const message = view.messages.find((m) => m.game);
    assert.equal(message.game.checked, true); assert.equal(message.game.creators.length, 2);
    assert.equal(view.files.length, 1); assert.equal(view.files[0].path, message.game.path);
    const response = await fetch(s.url + '/ws/' + message.game.path);
    assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.ok(!response.headers.get('content-security-policy').includes('allow-same-origin'));
    assert.match(await response.text(), /score\+=2/);
    const file = await (await fetch(s.url + '/api/file?path=' + encodeURIComponent(message.game.path))).json();
    assert.equal(file.activity, 'game');
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('게임 하루 1개 제한은 재시작 후에도 유지되고 다음 날 초기화된다', async () => {
  const root = temp(); const log = fresh(); let s = await start(root, log);
  try {
    await s.post('/api/room', { auto: { on: true, level: 'high' } });
    s.clock.t += 20000; await s.app.tick();
    await s.app.close(); s = await start(root, log);
    s.clock.t += 7 * HOUR; await s.app.tick();
    assert.equal(log.gameCalls, 3); assert.equal((await s.state()).room.auto.usage.games, 1);
    s.clock.t += 24 * HOUR; await s.app.tick();
    assert.equal(log.gameCalls, 6); assert.equal((await s.state()).room.auto.usage.games, 1);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('남은 자동 호출이 3회 미만이면 게임을 시작하지 않는다', async () => {
  const root = temp(); const log = fresh(); const store = new Store(root);
  const clock = { t: new Date(2026, 9, 6, 8).getTime() };
  store.state.assistant = { auto: { usage: { day: '2026-10-06', calls: 5 } } };
  const s = await start(root, log, { store, clock: () => clock.t });
  try {
    await s.post('/api/room', { auto: { on: true } });
    clock.t += 20000; await s.app.tick();
    assert.equal(log.gameCalls, 0); assert.equal((await s.state()).files.length, 0);
    assert.equal((await s.state()).room.auto.usage.calls, 6);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('3차례 후 실행 오류가 남으면 미완성 게임을 게시하지 않고 재시도하지 않는다', async () => {
  const root = temp(); const log = { ...fresh(), failCheck: true }; const s = await start(root, log);
  try {
    await s.post('/api/room', { auto: { on: true, level: 'high' } });
    s.clock.t += 20000; await s.app.tick();
    let view = await s.state();
    assert.equal(log.gameCalls, 3); assert.equal(view.files.length, 0);
    assert.ok(!view.messages.some((m) => m.game));
    assert.ok(view.messages.some((m) => m.kind === 'error' && m.text.includes('완성되지 않은 게임')));
    assert.ok(log.calls.filter((c) => c.brief.startsWith(GAME_BRIEF))[2].prompt.includes('게임 실행 오류'));
    assert.equal(view.room.auto.usage.stopped, null); // game failure doesn't stop ordinary chat
    s.clock.t += 7 * HOUR; await s.app.tick(); view = await s.state();
    assert.equal(log.gameCalls, 3);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('게임 제작 중 사용자 메시지는 우선 처리하고 늦은 코드·완성물은 버린다', async () => {
  const root = temp(); const log = { ...fresh(), wait: true }; const s = await start(root, log);
  try {
    await s.post('/api/room', { auto: { on: true } }); s.clock.t += 20000;
    const work = s.app.tick();
    while (log.gameCalls < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    await s.post('/api/send', { text: '지금 질문' }); await work; await s.app.active?.done;
    const view = await s.state();
    assert.equal(log.gameCalls, 2); assert.equal(view.files.length, 0);
    assert.ok(!view.messages.some((m) => m.gameStage === 1 || m.game));
    assert.equal(view.room.auto.usage.games, 1);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('게임 CLI 한도 오류는 재시도 없이 자동 호출도 중단하고 비밀을 숨긴다', async () => {
  const root = temp(); const log = { ...fresh(), quota: true }; const s = await start(root, log);
  try {
    await s.post('/api/room', { auto: { on: true } }); s.clock.t += 20000; await s.app.tick();
    const view = await s.state();
    assert.equal(log.gameCalls, 1); assert.equal(view.room.auto.usage.stopped, 'quota');
    assert.ok(!JSON.stringify(view).includes('SECRET123'));
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('실제 격리 브라우저는 게임 시작 버튼을 눌러 보고 실행 오류를 잡는다', async () => {
  const good = await checkGame({ title: '클릭 게임', code });
  assert.deepEqual(good, { ok: true, errors: [] });
  const bad = await checkGame({ title: '오류 게임', code: { ...code, js: 'document.getElementById("start").onclick=()=>{throw new Error("버튼 오류");};' } });
  assert.equal(bad.ok, false); assert.ok(bad.errors.some((s) => s.includes('버튼 오류')));
  const escape = await checkGame({ title: '격리 확인', code: { ...code, js: 'document.getElementById("start").onclick=()=>{parent.document.body.textContent="escaped";};' } });
  assert.equal(escape.ok, false); assert.ok(escape.errors.length > 0);
});
test('공유 브라우저 처리 후에도 기존 월드 스크린샷은 요청한 크기의 PNG를 반환한다', async () => {
  const root = temp();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><p>camera fixture</p><script>window.__shotReady=true;</script>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const png = await shootWorld(root, server.address().port, { width: 320, height: 240, timeoutMs: 15000 });
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 320); assert.equal(png.readUInt32BE(20), 240);
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
