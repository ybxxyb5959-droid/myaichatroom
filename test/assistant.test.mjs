import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { discuss, IDS, errorLabel, errorKind, mentionedTargets } from '../lib/discussion.mjs';
import { createAssistantServer, loadConfig } from '../server.mjs';
import { run } from '../lib/agents.mjs';
import { renderMarkdown, extractLinks, safeUrl, splitFold } from '../public/format.mjs';
import { AUTO_BRIEF, redact, splitMemo, memoBlock, MEMO_CHARS, BIO_CHARS, pickScript, peerContext } from '../lib/auto.mjs';
import { MEMBERS } from '../lib/members.mjs';
import { memberStatus, latestCall, limitWindows, batteryLevel } from '../public/status.mjs';
import { ACTIVITY_PROMPT, parseActivity, postcard } from '../lib/activities.mjs';
import { gameDocument } from '../lib/game.mjs';

function request(discussion = true) {
  return { text: '테스트 질문', selected: 'gpt', discussion, participants: IDS,
    webSearch: false, models: Object.fromEntries(IDS.map((id) => [id, { model: `${id}-test`, effort: '' }])) };
}
function harness(fail = []) {
  const calls = []; const messages = []; const states = [];
  const adapter = { chat: async (id, brief, prompt, options) => {
    calls.push({ id, brief, prompt, options });
    return fail.includes(id) ? { ok: false, detail: 'Selected model is at capacity' } : { ok: true, text: `${id}의 의견` };
  } };
  return { adapter, calls, messages, states, args: {
    adapter, request: request(), history: '', signal: new AbortController().signal,
    onState: (s) => states.push(s), onMessage: (m) => messages.push(m), onLog: () => {},
  } };
}
test('단독 답변은 선택 모델을 한 번만 호출한다', async () => {
  const h = harness(); h.args.request.discussion = false; h.args.request.participants = ['gpt'];
  const result = await discuss(h.args);
  assert.equal(result.calls, 1); assert.deepEqual(h.calls.map((c) => c.id), ['gpt']);
  assert.deepEqual(h.calls[0].options.settings, { model: 'gpt-test', effort: '' });
});
test('세 AI 토론은 3 의견 + 3 검토 + 1 종합으로 종료한다', async () => {
  const h = harness(); const result = await discuss(h.args);
  assert.equal(result.calls, 7); assert.equal(h.calls.length, 7);
  assert.deepEqual(h.messages.map((m) => m.phase), ['opinion', 'opinion', 'opinion', 'review', 'review', 'review', 'final']);
  assert.equal(h.messages.at(-1).from, 'gpt');
  assert.ok(!h.calls[0].prompt.includes('gpt의 의견'));
  assert.ok(h.calls[3].prompt.includes('gpt의 의견'));
});
test('부분 실패를 표시하고 살아 있는 참여자만 검토한다', async () => {
  const h = harness(['gpt']); const result = await discuss(h.args);
  assert.equal(result.calls, 6); assert.deepEqual(result.failed, [{ id: 'gpt', kind: 'capacity' }]);
  assert.equal(h.messages.at(-1).phase, 'final');
  assert.ok(h.messages.some((m) => m.kind === 'error' && m.errorKind === 'capacity' && m.text.includes('혼잡')));
  assert.ok(h.messages.some((m) => m.text.includes('종합 담당') && m.text.includes('실패하여')));
  assert.match(h.calls.at(-1).prompt, /gpt\(실패\)/);
});
test('토론은 지정한 종합 담당이 정리하고 이견·미확인 섹션과 빠진 AI를 지시한다', async () => {
  const h = harness();
  Object.assign(h.args.request, { synthesizer: 'claude', participants: ['gpt', 'claude'], excluded: [{ id: 'gemini', reason: '연결 설정 필요' }] });
  const result = await discuss(h.args);
  assert.equal(result.calls, 5); assert.equal(result.synthesizer, 'claude');
  const final = h.calls.at(-1);
  assert.equal(final.id, 'claude');
  assert.match(final.prompt, /### 중요한 이견/); assert.match(final.prompt, /### 확인되지 않은 점/);
  assert.match(final.prompt, /gemini\(제외\)/);
  assert.ok(!h.messages.some((m) => m.text.includes('종합 담당')));
});
test('최종 정리는 큰 결론 제목 → 왜 이렇게 되는가? → 의견 정리 → 이견·미확인 → 다음 행동 순서를 요구한다', async () => {
  const h = harness(); await discuss(h.args);
  const prompt = h.calls.at(-1).prompt;
  const order = ['# (질문에 대한 결론', '## 왜 이렇게 되는가?', '## 의견 정리', '### 중요한 이견', '### 확인되지 않은 점', '## 그래서 이렇게 하면 돼'];
  const at = order.map((s) => prompt.indexOf(s));
  assert.ok(at.every((i) => i >= 0), `missing section: ${order.filter((_, i) => at[i] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at); // in this order
});
test('긴 글은 첫 문단 경계에서 접고, 코드 블록은 자르지 않으며, 짧은 글은 접지 않는다', () => {
  const para = (n) => `${'가나다라마바사 '.repeat(n)}끝.`;
  assert.deepEqual(splitFold('짧은 글'), { head: '짧은 글', tail: '' });
  const long = [para(60), para(60), para(60)].join('\n\n');
  const a = splitFold(long);
  assert.equal(a.head, para(60)); assert.equal(a.tail, [para(60), para(60)].join('\n\n')); // cut at the first break after 450 chars
  // the blank line inside a code block (after 450 chars) is skipped
  const code = `${para(52)}\n\n\`\`\`js\nconst a = "${'x'.repeat(60)}";\n\nconst b = 2;\n\`\`\`\n\n${para(30)}`;
  const b = splitFold(code);
  assert.ok(b.head.includes('const b = 2;') && b.head.endsWith('```')); assert.equal(b.tail, para(30));
  // a heading is never left dangling at the end of the visible part
  const heading = `${para(54)}\n\n## 소제목이 길어서 경계를 넘는다\n\n- 항목\n\n${para(30)}`;
  const c = splitFold(heading); // the first break past 450 characters sits right after the heading: skipped
  assert.ok(c.head.includes('## 소제목') && c.head.endsWith('- 항목')); assert.equal(c.tail, para(30));
  // a short remainder is not worth folding
  assert.equal(splitFold(`${para(70)}\n\n짧은 마무리`).tail, '');
  assert.equal(splitFold('가'.repeat(2000)).tail, ''); // no paragraph break: nothing to cut at
});
test('오류 종류를 혼잡·한도·로그인·시간 초과·모델로 구분한다', () => {
  assert.equal(errorKind('Selected model is at capacity'), 'capacity');
  assert.equal(errorKind('429 Too Many Requests: usage limit'), 'quota');
  assert.equal(errorKind('Not logged in · Please run /login'), 'auth');
  assert.equal(errorKind('exit=-2 (timeout) '), 'timeout');
  assert.equal(errorKind('model "foo-1" not found'), 'model');
  assert.equal(errorKind('exit=1 something odd'), 'unknown');
});
test('출처 링크는 http(s) 형식만 모으고 코드 속 URL과 중복은 뺀다', () => {
  const links = extractLinks('[문서](https://example.com/a) 와 https://example.com/a 그리고 http://b.org/x. javascript:alert(1) ftp://c.org\n```\nhttps://code.example\n```\n`https://inline.example`');
  assert.deepEqual(links.map((l) => l.url), ['https://example.com/a', 'http://b.org/x']);
  assert.equal(links[0].label, '문서'); assert.equal(links[1].host, 'b.org');
  assert.equal(safeUrl('javascript:alert(1)'), null);
});
test('Markdown은 HTML을 이스케이프하고 긴 코드·표를 감싼다', () => {
  const html = renderMarkdown(`<script>x</script>\n\n\`\`\`js\n${Array(20).fill('a').join('\n')}\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |`);
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('class="copy-code"')); assert.ok(html.includes('<pre class="collapsed">'));
  assert.ok(html.includes('class="table-wrap"'));
  assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('href='));
  assert.ok(renderMarkdown('참고 https://example.com/x 입니다').includes('<a href="https://example.com/x"'));
});
test('한 명 성공과 전체 실패는 추가 라운드를 만들지 않는다', async () => {
  const one = harness(['gpt', 'gemini']); const a = await discuss(one.args);
  assert.equal(a.calls, 3); assert.equal(a.ok, true);
  const none = harness(IDS); const b = await discuss(none.args);
  assert.equal(b.calls, 3); assert.equal(b.ok, false);
});
test('종합 실패는 자동 재시도나 모델 변경을 하지 않는다', async () => {
  const h = harness(); let n = 0;
  h.adapter.chat = async () => ({ ok: ++n < 7, text: '답변', detail: 'capacity' });
  const result = await discuss(h.args); assert.equal(result.calls, 7); assert.equal(result.ok, false);
});
test('중지 이후 다음 단계와 답변 저장을 하지 않는다', async () => {
  const h = harness(); const controller = new AbortController(); h.args.signal = controller.signal;
  h.adapter.chat = async () => { controller.abort(); return { ok: true, text: '중지 후 응답' }; };
  await discuss(h.args);
  assert.equal(h.messages.length, 0);
  assert.equal(errorLabel('timeout').includes('시간'), true);
});
test('run의 취소가 CLI 프로세스를 종료한다', async () => {
  const controller = new AbortController();
  const task = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, timeoutMs: 10000 });
  setTimeout(() => controller.abort(), 100);
  const result = await task;
  assert.notEqual(result.code, 0);
  assert.ok(result.ms < 10000);
});
test('HTTP 무호출 대기, 선택/토론, 보안, 기존 기록 보존, 취소', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-test-'));
  let calls = 0; let wait = false;
  const adapter = {
    available: () => Object.fromEntries(IDS.map((id) => [id, true])),
    chat: async (_id, _brief, _prompt, opts) => {
      calls++;
      if (wait) await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }));
      return { ok: true, text: '응답' };
    },
  };
  const app = createAssistantServer({ root, cfg: loadConfig(), adapter });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const get = (p) => fetch(url + p);
  const post = (p, body, headers = {}) => fetch(url + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(calls, 0);
    assert.equal((await get('/')).status, 200);
    for (const asset of ['/house-scene.mjs', '/house-view.mjs', '/vendor/three.module.js']) {
      const response = await get(asset);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /javascript/);
      assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    }
    assert.equal((await get('/vendor/../package.json')).status, 404);
    const initial = await (await get('/api/state')).json();
    assert.equal(initial.room.discussion, false); assert.equal(initial.members.length, 3);
    assert.equal((await get('/world.html')).status, 404);
    assert.equal((await get('/api/dev/status')).status, 404);
    assert.equal((await post('/api/room', {}, { Origin: 'https://evil.example' })).status, 403);
    // Fetch rewrites Host; use a raw HTTP request to exercise DNS-rebinding protection.
    const forbiddenHost = await new Promise((resolve, reject) => {
      const req = http.request(`${url}/api/room`, { method: 'POST', headers: { Host: 'evil.example' } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(forbiddenHost, 403);
    assert.equal((await post('/api/room', { models: { gpt: { model: 'bad model' } } })).status, 400);
    await post('/api/room', { selected: 'gpt', targeted: true, models: { gpt: { model: 'gpt-test', effort: 'high' } } });
    assert.equal((await post('/api/send', { text: '질문' })).status, 200);
    if (app.active) await app.active.done;
    assert.equal(calls, 1); // 🎯 지정 calls only the chosen AI, even for a work request.
    await post('/api/room', { discussion: true });
    await post('/api/send', { text: '토론 질문' });
    if (app.active) await app.active.done;
    assert.equal(calls, 8);
    const before = app.store.messages.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls, 8); assert.equal(app.store.messages.length, before);
    wait = true; await post('/api/send', { text: '중지할 질문' });
    assert.equal((await post('/api/send', { text: '중복' })).status, 409);
    assert.equal((await post('/api/cancel', {})).status, 200);
    assert.equal(app.active, null);
    assert.ok(app.store.messages.some((m) => m.text === '질문'));
    assert.ok(app.store.messages.some((m) => m.kind === 'cancelled'));
    const atCancel = calls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls, atCancel);
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'data/state.json'))).assistant.discussion);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fakeAdapter() {
  const log = { chat: [], login: [], list: 0 };
  return {
    log,
    available: () => ({ gemini: false, gpt: true, claude: true }),
    loginStatus: async (id) => { log.login.push(id); return { status: 'ok', detail: '로그인됨' }; },
    listModels: async () => {
      log.list++;
      return [{ id: 'gpt-x', label: 'GPT-X', description: 'Workhorse model.', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'low' }];
    },
    chat: async (id, _brief, prompt, opts) => {
      log.chat.push({ id, prompt, settings: opts.settings });
      return opts.settings.model === 'bad-model' ? { ok: false, detail: 'Selected model is at capacity' } : { ok: true, text: 'OK' };
    },
  };
}
async function start(root, adapter, extra = {}) {
  const app = createAssistantServer({ root, cfg: loadConfig(), adapter, greetings: false, ...extra });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (p, body) => {
    const res = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { app, url, post, state: async () => (await fetch(`${url}/api/state`)).json() };
}
test('첫 시작: 버튼 전 무호출, 로그인과 실제 호출 구분, 저장한 선택 유지', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-setup-'));
  const adapter = fakeAdapter();
  let s = await start(root, adapter);
  try {
    const first = await s.state();
    assert.equal(first.room.onboarding.done, false); assert.equal(first.room.tutorial.done, false);
    assert.equal(first.room.selected, 'claude'); assert.deepEqual(first.room.models.claude, { model: 'sonnet', effort: '' });
    assert.equal(first.room.discussion, false); assert.equal(first.room.synthesizer, 'claude');
    assert.deepEqual(first.room.debateModels, {
      gemini: { model: 'gemini-3.8-flash-medium', effort: '' }, gpt: { model: 'gpt-6.1-sol', effort: 'medium' }, claude: { model: 'claude-sonnet-5-5', effort: 'medium' } });
    assert.deepEqual(adapter.log, { chat: [], login: [], list: 0 });
    assert.ok(first.catalog.gemini.models.every((m) => ['config', 'custom'].includes(m.source) && !m.efforts.length));
    assert.equal(first.catalog.claude.models.find((m) => m.id === 'sonnet').source, 'help');
    assert.ok(first.catalog.claude.models.every((m) => !m.check));

    const login = (await s.post('/api/check/login', {})).body;
    assert.deepEqual(adapter.log.login.sort(), ['claude', 'gpt']); assert.equal(adapter.log.chat.length, 0);
    assert.equal(login.room.checks.claude.login.status, 'ok'); assert.equal(login.room.checks.gemini.login.status, 'missing');
    assert.equal(adapter.log.list, 1);
    const listed = login.catalog.gpt.models.find((m) => m.id === 'gpt-x');
    assert.equal(listed.source, 'cli'); assert.deepEqual(listed.efforts, ['low', 'medium', 'ultra']); assert.ok(login.catalog.gpt.listedAt);

    assert.equal((await s.post('/api/room', { models: { gpt: { model: 'gpt-x', effort: 'xhigh' } } })).status, 400);
    assert.equal((await s.post('/api/room', { models: { gemini: { model: 'gemini-3.8-flash-medium', effort: 'low' } } })).status, 400);
    assert.equal((await s.post('/api/room', { models: { gpt: { model: 'gpt-x', effort: 'ultra' } } })).status, 200);

    const ok = (await s.post('/api/check/call', { id: 'claude', target: 'general' })).body;
    assert.equal(adapter.log.chat.length, 1); assert.equal(adapter.log.chat[0].settings.model, 'sonnet');
    assert.equal(ok.room.checks.claude.models.sonnet.status, 'ok');
    const bad = (await s.post('/api/check/call', { id: 'claude', target: 'general', model: 'bad-model' })).body;
    assert.equal(bad.room.checks.claude.models['bad-model'].kind, 'capacity');
    assert.equal(bad.room.models.claude.model, 'sonnet');
    assert.equal((await s.post('/api/check/call', { id: 'gemini' })).status, 400);
    assert.equal(adapter.log.chat.length, 2);

    await s.post('/api/room', { selected: 'gpt', onboarding: { done: true }, synthesizer: 'gpt',
      debateModels: { claude: { model: 'opus', effort: 'high' } } });
    await s.app.close();

    s = await start(root, adapter);
    const again = await s.state();
    assert.equal(again.room.selected, 'gpt'); assert.deepEqual(again.room.models.gpt, { model: 'gpt-x', effort: 'ultra' });
    assert.equal(again.room.onboarding.done, true); assert.equal(again.room.synthesizer, 'gpt');
    assert.deepEqual(again.room.debateModels.claude, { model: 'opus', effort: 'high' });
    assert.equal(again.room.checks.claude.models.sonnet.status, 'ok'); assert.ok(again.catalog.gpt.listedAt);
    assert.equal(adapter.log.chat.length, 2);

    await s.post('/api/room', { discussion: true });
    await s.post('/api/send', { text: '토론 질문' });
    await s.app.active?.done;
    const run = adapter.log.chat.slice(2);
    assert.equal(run.length, 5);
    assert.deepEqual(run.find((c) => c.id === 'claude').settings, { model: 'opus', effort: 'high' });
    assert.equal(run.at(-1).id, 'gpt');
    const end = s.app.store.messages.at(-1);
    assert.equal(end.kind, 'complete'); assert.deepEqual(end.summary.excluded, [{ id: 'gemini', reason: '연결 설정 필요' }]);
    assert.match(end.text, /빠짐: Gemini\(연결 설정 필요\)/);
    assert.ok(s.app.store.messages.filter((m) => m.runId === end.runId).every((m) => m.mode === 'discussion'));

    assert.equal((await fetch(`${s.url}/format.mjs`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${s.url}/avatars/gpt-pixel-128.png`)).status, 200);
    assert.equal((await fetch(`${s.url}/avatars/splash-gpt.png`)).status, 404); // the start screen is gone
    assert.equal((await fetch(`${s.url}/avatars/grok-pixel.png`)).status, 404);
  } finally {
    await s.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- auto chat, presence, plain status ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HOUR = 3600000;
async function startAuto(root, adapter, clock, extra = {}) {
  const app = createAssistantServer({ root, cfg: { ...loadConfig(), autoSleepMinutes: 0 }, adapter, clock: () => clock.t, random: () => 0.5, autoTickMs: 3600000, pairDelayMs: 0, greetings: false, ...extra });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (p, body) => {
    const res = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { app, url, post, state: async () => (await fetch(`${url}/api/state`)).json() };
}
function autoAdapter() {
  const log = { auto: 0, user: 0, mode: 'ok', waitForAbort: false, memo: false, userMemo: false, bio: false, prompts: [] };
  return {
    log,
    available: () => ({ gemini: false, gpt: true, claude: true }),
    listModels: async () => [
      { id: 'gpt-6.1-sol', label: 'Sol', description: 'Latest workhorse model for coding and everyday work.', efforts: ['low', 'medium'] },
      { id: 'gpt-5.6-luna', label: 'Luna 5.6', description: 'Older fast and efficient model.', efforts: ['low', 'medium'] },
      { id: 'gpt-6-luna', label: 'Luna', description: 'Fast and affordable model for easier tasks.', efforts: ['low', 'medium'] },
    ],
    chat: async (id, brief, prompt, opts) => {
      const isAuto = brief.startsWith(AUTO_BRIEF); // the user's name is appended to the brief
      log.prompts.push({ id, brief, prompt, auto: isAuto });
      if (isAuto) {
        log.auto++;
        if (log.waitForAbort) { await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true })); return { ok: true, text: '늦은 답' }; }
        if (log.mode === 'quota') return { ok: false, detail: 'usage limit reached api_key=SECRET123' };
        if (log.mode === 'timeout') return { ok: false, detail: 'timeout api_key=SECRET123' };
        if (log.mode === 'auth') return { ok: false, detail: 'not logged in api_key=SECRET123' };
        return { ok: true, text: `${id}의 짧은 말${log.memo ? `\n[메모] ${id} 말투 메모` : ''}${log.bio ? `\n[소개] ${id}의 한 줄 소개` : ''}` };
      }
      log.user++;
      return { ok: true, text: `응답${log.userMemo ? '\n[메모] 사용자 질문 메모' : ''}${log.bio ? `\n[소개] ${id}의 한 줄 소개` : ''}` };
    },
  };
}
// No setup: pressing the power button is enough. Light models are chosen by the app.
async function enableAuto(s, level = 'low') {
  await s.post('/api/room', { auto: { on: true, level } });
}
const baseTime = () => new Date(2026, 5, 10, 8, 0, 0).getTime();
test('보통은 5~10분 간격에 4차례씩 대화하고 하루 100회에서 멈춘다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-medium-'));
  const clock = { t: baseTime() }; const adapter = autoAdapter();
  let s = await startAuto(root, adapter, clock);
  try {
    await enableAuto(s, 'medium');
    clock.t += 20000; await s.app.tick();
    assert.equal(adapter.log.auto, 4);
    // The harness's fixed random=.5 makes the 5–10 minute interval exactly 7.5 minutes.
    clock.t += 7 * 60000; await s.app.tick();
    assert.equal(adapter.log.auto, 4);
    clock.t += 0.5 * 60000; await s.app.tick();
    assert.equal(adapter.log.auto, 8);
    for (let i = 0; i < 23; i++) {
      // User participation resets the separate runaway guard, not the daily budget.
      if (i === 10) {
        assert.equal((await s.post('/api/send', { text: '@GPT 안녕' })).status, 200);
        await s.app.active?.done;
      }
      clock.t += 12 * 60000; await s.app.tick();
    }
    assert.equal(adapter.log.auto, 100);
    const view = await s.state();
    assert.equal(view.room.autoDaily, 100); assert.equal(view.room.auto.usage.calls, 100);
    assert.equal(view.room.autoRest, true);
    clock.t += 12 * 60000; await s.app.tick(); assert.equal(adapter.log.auto, 100);
    await s.app.close(); s = await startAuto(root, adapter, clock);
    assert.equal((await s.state()).room.auto.usage.calls, 100);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('자동 잠들기는 기본 30분, 재시작·조회로 깨지 않고 유효한 메시지로 깨어난다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-sleep-'));
  const clock = { t: baseTime() }; const adapter = autoAdapter();
  let s = await startAuto(root, adapter, clock, { cfg: { ...loadConfig(), autoSleepMinutes: 30 } });
  try {
    assert.equal((await s.state()).room.auto.sleepMinutes, 30);
    await enableAuto(s);
    clock.t += 30 * 60000 - 1;
    assert.equal((await s.state()).room.autoSleeping, false);
    clock.t = baseTime() + 30 * 60000;
    assert.equal(await s.app.tick(), null); assert.equal(adapter.log.auto, 0);
    assert.equal((await s.state()).room.autoSleeping, true);
    assert.equal((await s.state()).room.autoNextAt, null);
    await s.app.close(); s = await startAuto(root, adapter, clock);
    assert.equal((await s.state()).room.autoSleeping, true);
    assert.equal((await s.post('/api/room', { auto: { sleepMinutes: -1 } })).status, 400);
    assert.equal((await s.post('/api/send', { text: '' })).status, 400);
    assert.equal((await s.state()).room.autoSleeping, true);
    await s.post('/api/send', { text: '깨어나' }); await s.app.active?.done;
    assert.equal((await s.state()).room.autoSleeping, false);
    clock.t += 3 * 60000; await s.app.tick();
    assert.ok(adapter.log.auto > 0);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('잠들기 경계에 걸린 자동 응답은 게시하거나 다음 AI를 호출하지 않는다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-sleep-'));
  const clock = { t: baseTime() }; const adapter = autoAdapter();
  const chat = adapter.chat;
  adapter.chat = async (...args) => { const result = await chat(...args); if (args[1].startsWith(AUTO_BRIEF)) clock.t += 30 * 60000; return result; };
  const s = await startAuto(root, adapter, clock, { cfg: { ...loadConfig(), autoSleepMinutes: 30 } });
  try {
    await enableAuto(s); clock.t += 20000; await s.app.tick();
    assert.equal(adapter.log.auto, 1);
    assert.ok(!s.app.store.messages.some((m) => m.auto === 'call'));
    assert.equal((await s.state()).room.autoSleeping, true);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('창작 데이터만 받아 그림·게임 템플릿에 넣고 실행 코드·경로를 신뢰하지 않는다', () => {
  const activity = { kind: 'postcard', theme: 'party', title: '<script>x</script>' };
  const parsed = parseActivity(JSON.stringify({ text: '가상 파티 왔음ㅋㅋ', activity }));
  assert.equal(parsed.activity.kind, 'postcard');
  assert.ok(!postcard(parsed.activity).includes('<script>'));
  assert.ok(gameDocument(parsed.activity.title, { body: '<button>시작</button>', css: '', js: '' }).includes('&lt;script&gt;'));
  assert.equal(parseActivity('그냥 대화'), null);
  assert.equal(parseActivity('{"text":"말","activity":{"kind":"game","theme":"__proto__"}}').activity, null);
  assert.equal(parseActivity('{"text":"말","activity":{"kind":"write","path":"../../bad.js"}}').activity, null);
});
test('그림은 대화 호출 안에서 생성되고 6시간 간격·하루 2개로 제한된다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-art-'));
  const clock = { t: baseTime() }; const adapter = autoAdapter();
  let kind = 'postcard'; const chat = adapter.chat;
  adapter.chat = async (...args) => {
    const result = await chat(...args);
    return args[2].includes(ACTIVITY_PROMPT) ? { ok: true, text: JSON.stringify({ text: '가상 파티 왔음ㅋㅋ', activity: { kind, theme: 'party', title: '같이 놀자' } }) } : result;
  };
  const s = await startAuto(root, adapter, clock);
  try {
    await enableAuto(s, 'high'); clock.t += 20000; await s.app.tick();
    let view = await s.state();
    assert.equal(view.room.auto.usage.calls, 5); assert.equal(view.room.auto.usage.creations, 1); // a round of 5 at 🎉 활발하게
    const picture = view.messages.find((m) => m.attach?.generated);
    assert.equal(picture.text, '가상 파티 왔음ㅋㅋ');
    const entry = view.files.find((f) => f.path === picture.attach.path);
    assert.equal(entry.title, '같이 놀자');
    assert.equal(entry.activity, 'postcard');
    assert.equal(entry.image, true);
    const image = await fetch(s.url + '/ws/' + picture.attach.path);
    assert.match(image.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await image.text(), /가상 장면/);
    clock.t += HOUR; await s.app.tick();
    assert.equal((await s.state()).room.auto.usage.creations, 1);
    clock.t += 6 * HOUR; await s.app.tick();
    view = await s.state();
    assert.equal(view.room.auto.usage.creations, 2);
    assert.equal(view.messages.filter((m) => m.attach?.generated).length, 2);
    clock.t += 6 * HOUR; await s.app.tick();
    assert.equal((await s.state()).room.auto.usage.creations, 2);
    const plain = s.app.store.applyFileOp({ op: 'write', path: 'old.html', content: '<script>alert(1)</script>' }, 'gpt');
    const old = await fetch(s.url + '/ws/' + plain.rel);
    assert.ok(!old.headers.get('content-security-policy').includes('allow-scripts'));
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('새 사진과 멘트는 한 메시지에 게시되며 이미지 호출도 일일 예산에 포함된다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-photo-'));
  const clock = { t: baseTime() }; const adapter = autoAdapter();
  adapter.available = () => ({ gpt: true, claude: false, gemini: false });
  const chat = adapter.chat; let images = 0;
  adapter.chat = async (...args) => {
    const result = await chat(...args);
    return args[2].includes(ACTIVITY_PROMPT) ? { ok: true, text: JSON.stringify({ text: '가상 파티 왔음ㅋㅋ', activity: { kind: 'photo', theme: 'party', title: '파티', prompt: 'fictional robot party' } }) } : result;
  };
  const file = path.join(root, 'photo.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  adapter.image = async (_id, prompt, opts) => {
    images++; assert.equal(prompt, 'fictional robot party'); assert.ok(opts.signal); return { ok: true, file };
  };
  let s = await startAuto(root, adapter, clock);
  try {
    await enableAuto(s, 'high'); clock.t += 20000; await s.app.tick();
    let view = await s.state(); const msg = view.messages.find((m) => m.attach?.generated);
    assert.equal(msg.text, '가상 파티 왔음ㅋㅋ'); assert.ok(msg.attach.path.endsWith('.png'));
    const entry = view.files.find((f) => f.path === msg.attach.path);
    assert.equal(entry.title, '파티');
    assert.equal(entry.activity, 'photo');
    assert.equal(entry.image, true);
    assert.equal(view.room.auto.usage.photos, 1); assert.equal(view.room.auto.usage.calls, 6);
    await s.app.close(); s = await startAuto(root, adapter, clock);
    clock.t += 7 * HOUR; await s.app.tick();
    view = await s.state();
    assert.equal(images, 1); assert.equal(view.room.auto.usage.photos, 1);
    assert.equal(view.files.find((f) => f.path === msg.attach.path).title, '파티');
    assert.ok(view.messages.some((m) => m.attach?.path.endsWith('.svg')));
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('사진 생성 한도는 숨기거나 재시도하지 않고 해당 AI만 쉰다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-photo-'));
  const clock = { t: baseTime() }; const adapter = autoAdapter(); let images = 0;
  adapter.available = () => ({ gpt: true, claude: false, gemini: false });
  adapter.chat = async () => ({ ok: true, text: '{"text":"가상 파티","activity":{"kind":"photo","theme":"party","title":"파티"}}' });
  adapter.image = async () => { images++; return { ok: false, detail: 'usage limit reached api_key=SECRET123' }; };
  const s = await startAuto(root, adapter, clock);
  try {
    await enableAuto(s); clock.t += 20000; await s.app.tick();
    const view = await s.state();
    assert.equal(view.room.auto.usage.calls, 2);
    assert.equal(view.room.auto.usage.stopped, null);
    assert.equal(view.room.enabled.gpt, false);
    assert.equal(view.room.quotaRest.gpt.autoResume, true);
    assert.ok(view.messages.some((m) => m.errorKind === 'quota'));
    assert.ok(!JSON.stringify(view).includes('SECRET123'));
    clock.t += 7 * HOUR; await s.app.tick(); assert.equal(images, 1);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('사진 생성 중 사용자 메시지가 오면 취소하고 늦은 사진·멘트를 버린다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-photo-'));
  const clock = { t: baseTime() }; const adapter = autoAdapter(); let images = 0;
  adapter.available = () => ({ gpt: true, claude: false, gemini: false });
  const chat = adapter.chat;
  adapter.chat = async (...args) => args[2].includes(ACTIVITY_PROMPT)
    ? { ok: true, text: '{"text":"늦은 사진","activity":{"kind":"photo","theme":"party","title":"파티"}}' } : chat(...args);
  adapter.image = async (_id, _prompt, opts) => {
    images++;
    await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }));
    return { ok: false, detail: 'cancelled' };
  };
  const s = await startAuto(root, adapter, clock);
  try {
    await enableAuto(s); clock.t += 20000;
    const burst = s.app.tick();
    while (!images) await sleep(5);
    await s.post('/api/send', { text: '지금 말 걸기' });
    await burst; await s.app.active?.done;
    const view = await s.state();
    assert.ok(!view.messages.some((m) => m.text === '늦은 사진' || m.attach?.generated));
    assert.ok(view.messages.some((m) => m.text === '응답'));
    assert.equal(view.room.auto.usage.calls, 2);
    assert.equal(view.room.auto.usage.stopped, null);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('자동 호출은 하루 상한에서 멈추고, 재시작해도 같은 날 기록이 유지된다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-auto-'));
  const adapter = autoAdapter(); const clock = { t: baseTime() };
  let s = await startAuto(root, adapter, clock);
  try {
    assert.equal((await s.state()).room.auto.on, false); assert.equal((await s.state()).room.auto.level, 'low');
    await s.app.tick(); assert.equal(adapter.log.auto, 0); // off until the power button is pressed
    assert.equal((await s.post('/api/room', { auto: { level: 'extreme' } })).status, 400);
    await enableAuto(s);
    await s.app.tick(); assert.equal(adapter.log.auto, 0); // too early
    for (let i = 0; i < 4; i++) { clock.t += 2 * HOUR; await s.app.tick(); }
    assert.equal(adapter.log.auto, 10); // rounds of 3 turns until the daily limit of the 낮음 level
    const usage = (await s.state()).room.auto.usage; assert.equal(usage.calls, 10);
    const spoken = s.app.store.messages.filter((m) => m.auto === 'call');
    // light models picked by the app (Claude: haiku, GPT: the one the Codex list calls affordable), lowest effort at 낮음
    assert.ok(spoken.every((m) => m.text.endsWith('짧은 말') && m.effort === 'low' && m.model === (m.from === 'claude' ? 'haiku' : 'gpt-6-luna')));
    assert.equal((await s.state()).room.autoUses.gpt.model, 'gpt-6-luna');
    assert.ok(spoken.every((m, i) => i === 0 || m.from !== spoken[i - 1].from)); // they alternate
    await s.app.close();
    s = await startAuto(root, adapter, clock);
    assert.equal((await s.state()).room.auto.usage.calls, 10);
    clock.t += 2 * HOUR; await s.app.tick();
    assert.equal(adapter.log.auto, 10);
    // next day the count starts again (a new round of 3 turns)
    clock.t += 24 * HOUR; await s.app.tick();
    assert.equal((await s.state()).room.auto.usage.calls, 3); assert.equal(adapter.log.auto, 13);
    // a higher level asks for more reasoning, more turns per round and a higher daily limit
    await s.post('/api/room', { auto: { level: 'high' } });
    assert.equal((await s.state()).room.autoDaily, 200);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('지나가는 오류는 그 AI만 잠깐 쉬고, 계속되는 오류는 하루 쉬며, 사용자 질문과 비밀 숨김은 그대로 동작한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-auto-'));
  const adapter = autoAdapter(); const clock = { t: baseTime() };
  const s = await startAuto(root, adapter, clock);
  try {
    await enableAuto(s);
    adapter.log.mode = 'timeout';
    clock.t += 2 * HOUR; await s.app.tick();
    // Each member fails once, then sits out the rest of the round: no retry, no model change, no day stop.
    assert.equal(adapter.log.auto, 2);
    assert.equal(new Set(adapter.log.prompts.filter((p) => p.auto).map((p) => p.id)).size, 2);
    let view = await s.state();
    assert.equal(view.room.autoRest, false); assert.equal(view.room.auto.usage.stopped, null);
    clock.t += 2 * HOUR; await s.app.tick();
    assert.equal(adapter.log.auto, 4, 'tried again in a later round');
    // A sign-in problem does not pass by itself: automatic chat rests for the day.
    adapter.log.mode = 'auth';
    clock.t += 2 * HOUR; await s.app.tick();
    const atStop = adapter.log.auto;
    for (let i = 0; i < 3; i++) { clock.t += 2 * HOUR; await s.app.tick(); }
    assert.equal(adapter.log.auto, atStop);
    view = await s.state();
    assert.equal(view.room.autoRest, true); assert.equal(view.room.auto.usage.stopped, 'auth');
    assert.ok(!JSON.stringify(view).includes('SECRET123'));
    assert.equal(view.room.auto.level, 'low');
    assert.equal((await s.post('/api/send', { text: '질문' })).status, 200);
    await s.app.active?.done;
    assert.ok(s.app.store.messages.some((m) => m.from === 'claude' && m.text === '응답'));
    assert.equal(adapter.log.auto, atStop);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('자동 호출 중 사용자가 말하면 자동 답은 버리고 사용자에게 먼저 답한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-auto-'));
  const adapter = autoAdapter(); const clock = { t: baseTime() };
  const s = await startAuto(root, adapter, clock);
  try {
    await enableAuto(s);
    adapter.log.waitForAbort = true;
    clock.t += 2 * HOUR;
    const burst = s.app.tick();
    while (adapter.log.auto < 1) await sleep(5);
    assert.equal((await s.state()).room.autoRunning, true);
    assert.equal((await s.post('/api/send', { text: '지금 질문' })).status, 200);
    await burst; await s.app.active?.done;
    const msgs = s.app.store.messages;
    assert.ok(!msgs.some((m) => m.text === '늦은 답'));
    assert.equal(adapter.log.auto, 1); // the second AI of the burst was never called
    const asked = msgs.findIndex((m) => m.text === '지금 질문');
    assert.equal(msgs[asked + 1].text, '응답'); assert.ok(!msgs[asked + 1].auto);
    assert.equal((await s.state()).room.auto.usage.calls, 1);
    // pause after the user spoke: nothing new for 3 minutes
    adapter.log.waitForAbort = false;
    clock.t += 2 * 60000; assert.equal(await s.app.tick(), null);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('연결된 AI가 없으면 분위기 대화만 호출 없이, 반복 없이, 반말로 나오고, 끄면 멈춘다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-auto-'));
  const adapter = autoAdapter(); const clock = { t: baseTime() };
  adapter.available = () => ({ gemini: false, gpt: false, claude: false });
  const s = await startAuto(root, adapter, clock);
  try {
    await s.post('/api/room', { auto: { on: false } });
    clock.t += 2 * HOUR; assert.equal(await s.app.tick(), null);
    await s.post('/api/room', { auto: { on: true } });
    for (let i = 0; i < 30; i++) { clock.t += 16 * 60000; await s.app.tick(); await sleep(2); }
    const lines = s.app.store.messages.filter((m) => m.auto === 'ambient');
    assert.ok(lines.length > 0 && lines.length <= 8);
    assert.equal(new Set(lines.map((m) => m.text)).size, lines.length);
    assert.equal(adapter.log.auto + adapter.log.user, 0);
    assert.ok(lines.every((m) => ['claude', 'gpt', 'gemini'].includes(m.from)));
    assert.ok(lines.every((m) => !/(해요|이에요|예요|세요|입니다|습니다)/.test(m.text))); // everyone talks 반말
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('입장·퇴장 문구는 참여 상태가 바뀔 때만 한 번 표시한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-auto-'));
  const clock = { t: baseTime() };
  const s = await startAuto(root, autoAdapter(), clock);
  const notes = () => s.app.store.messages.filter((m) => m.kind === 'presence').map((m) => m.text);
  try {
    await s.state(); await s.state();
    assert.deepEqual(notes(), []);
    await s.post('/api/room', { enabled: { gpt: false } }); await s.post('/api/room', { enabled: { gpt: false } });
    assert.deepEqual(notes(), ['ChatGPT 잠깐 나감']);
    await s.post('/api/room', { selected: 'claude' }); await s.state();
    assert.deepEqual(notes(), ['ChatGPT 잠깐 나감']);
    await s.post('/api/room', { enabled: { gpt: true } });
    assert.deepEqual(notes(), ['ChatGPT 잠깐 나감', 'ChatGPT 들어옴']);
    assert.ok(s.app.store.messages.filter((m) => m.kind === 'presence').every((m) => m.from === 'system' && m.presence === true));
    await s.app.close();
    const again = await startAuto(root, autoAdapter(), clock); // a restart repeats nothing
    assert.equal(again.app.store.messages.filter((m) => m.kind === 'presence').length, 2);
    await again.app.close();
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('대표 상태는 CLI 발견만으로 활성이 되지 않고, 비밀은 가려진다', () => {
  const now = 1_000_000_000;
  const base = { available: true, enabled: true, busy: false, checking: false, loginStatus: 'unknown', call: null, now };
  assert.equal(memberStatus(base).text, '연결 확인 필요');
  assert.equal(memberStatus({ ...base, loginStatus: 'ok' }).text, '연결 확인 필요');
  assert.equal(memberStatus({ ...base, call: { status: 'ok', at: now } }).text, '활성');
  assert.equal(memberStatus({ ...base, call: { status: 'ok', at: now }, busy: true }).text, '답변 중');
  assert.equal(memberStatus({ ...base, call: { status: 'ok', at: now }, enabled: false }).text, '쉬는 중');
  assert.equal(memberStatus({ ...base, available: false }).text, '연결 설정 필요');
  assert.equal(memberStatus({ ...base, loginStatus: 'fail' }).text, '로그인 확인 필요');
  // Errors follow the server's own record (health), not a window kept by the UI.
  const fail = { status: 'fail', kind: 'capacity', at: now - 60000 };
  assert.equal(memberStatus({ ...base, call: fail }).text, '활성', 'the server holds nothing back: ready again');
  assert.equal(memberStatus({ ...base, call: fail, health: { state: 'cooldown', kind: 'capacity', until: now + 4.5 * 60000 } }).text, '잠시 쉬는 중 · 5분 남음');
  assert.equal(memberStatus({ ...base, call: fail, health: { state: 'cooldown', kind: 'capacity', until: now } }).text, '활성', 'back at the end time');
  assert.equal(memberStatus({ ...base, health: { state: 'quota' } }).text, '한도 회복 대기');
  assert.equal(memberStatus({ ...base, health: { state: 'auth' } }).text, '로그인 확인 필요');
  assert.equal(memberStatus({ ...base, health: { state: 'model' } }).text, '모델 설정 확인 필요');
  assert.equal(memberStatus({ ...base, call: { status: 'fail', kind: 'model', at: now } }).text, '모델 설정 확인 필요');
  assert.equal(memberStatus({ ...base, call: { status: 'fail', kind: 'auth', at: now } }).text, '로그인 확인 필요');
  assert.equal(memberStatus({ ...base, health: { state: 'quota' }, enabled: false }).text, '한도 회복 대기', 'a quota rest outranks the off switch');
  const check = { models: { selected: { status: 'fail', kind: 'capacity', at: now - 1 }, auto: { status: 'ok', at: now } } };
  assert.equal(memberStatus({ ...base, call: latestCall(check) }).text, '활성');
  const out = redact('Authorization: Bearer abc.def token=xyz789 sk-abcdefghijkl password: hunter2');
  assert.ok(!/abc\.def|xyz789|abcdefghijkl|hunter2/.test(out));
});
test('일반·자동 답변 성공은 연결 기록에 반영되고 기존 답변도 재시작 시 복구한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-connectivity-'));
  const clock = { t: baseTime() };
  let s = await startAuto(root, autoAdapter(), clock);
  try {
    await s.post('/api/room', { selected: 'gpt', targeted: true });
    await s.post('/api/send', { text: '안녕' });
    await s.app.active?.done;
    let view = await s.state();
    assert.equal(view.room.checks.gpt.models[view.room.models.gpt.model].status, 'ok');
    assert.equal(view.room.checks.gpt.login.status, 'ok');
    await enableAuto(s);
    clock.t += 20 * 60000; await s.app.tick();
    view = await s.state();
    assert.equal(view.room.checks.gpt.models['gpt-6-luna'].status, 'ok');
    assert.equal(latestCall(view.room.checks.gpt).status, 'ok');
    // Simulate an old saved room with real answers but no recorded checks.
    s.app.store.state.assistant.checks.gpt = { login: null, models: {} };
    s.app.store.saveState();
    await s.app.close();
    s = await startAuto(root, autoAdapter(), clock);
    view = await s.state();
    assert.equal(view.room.checks.gpt.models['gpt-6-luna'].status, 'ok');
    assert.equal(view.room.checks.gpt.login.status, 'ok');
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('켜 둔 채 앱을 다시 켜면 첫 대화가 곧 시작되고, 내부 예약 시각은 유지되며, 예전 Gemini 기본 이름은 고친다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-restart-'));
  const adapter = autoAdapter(); const clock = { t: baseTime() };
  let s = await startAuto(root, adapter, clock);
  try {
    assert.equal((await s.state()).room.autoNextAt, null); // off: nothing is planned
    await enableAuto(s, 'medium');
    const planned = (await s.state()).room.autoNextAt;
    assert.ok(planned > clock.t && planned - clock.t <= 60000); // soon after switching on
    await s.app.close();
    // an old saved Gemini model name that `agy models` does not list
    const file = path.join(root, 'data/state.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.assistant.models.gemini = { model: 'gemini-3.6-flash', effort: '' };
    fs.writeFileSync(file, JSON.stringify(saved));
    s = await startAuto(root, adapter, clock);
    const view = await s.state();
    assert.equal(view.room.models.gemini.model, 'gemini-3.8-flash-medium');
    assert.ok(view.room.autoNextAt - clock.t <= 60000);
    assert.equal(await s.app.tick(), null); // not yet
    clock.t += 60000; assert.equal(await s.app.tick(), 'call');
    assert.equal(adapter.log.auto, 4); // a round of 4 turns at the 🙂 보통 level
    // the user speaks: the next auto message waits at least the pause
    assert.equal((await s.post('/api/send', { text: '안녕' })).status, 200); await s.app.active?.done;
    assert.ok((await s.state()).room.autoNextAt >= clock.t + 3 * 60000);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('[소개] 한 줄은 프로필 소개로 떼어 정리하고, 길이·따옴표·비밀을 걸러 낸다', () => {
  const a = splitMemo('답이야\n[소개] 졸리면 말 걸어줘 😴\n[메모] 장난꾸러기 말투');
  assert.equal(a.text, '답이야'); assert.equal(a.bio, '졸리면 말 걸어줘 😴'); assert.equal(a.memo, '장난꾸러기 말투');
  assert.equal(splitMemo(`답\n[소개] ${'가'.repeat(BIO_CHARS + 30)}`).bio.length, BIO_CHARS);
  assert.equal(splitMemo('답\n[소개] "따옴표"와 <b>태그</b>').bio, '따옴표와 b태그/b');
  assert.ok(!splitMemo('답\n[소개] token=SECRET123 안녕').bio.includes('SECRET123'));
  assert.equal(splitMemo('답\n[소개]   ').bio, null);
  assert.match(memoBlock('', true, '지금 소개'), /프로필 한 줄 소개[^\n]*\n지금 소개\n/);
  assert.equal(memoBlock('x', false, '소개'), '');
});
test('AI가 스스로 한 줄 소개를 정하고, 화면에는 나오지 않고, 지우거나 끌 수 있다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-bio-'));
  const adapter = autoAdapter(); const clock = { t: Date.now() };
  adapter.log.bio = true;
  const s = await startAuto(root, adapter, clock);
  try {
    assert.deepEqual((await s.state()).room.bios, { gemini: '', gpt: '', claude: '' });
    assert.equal((await s.post('/api/send', { text: '얘들아 안녕' })).status, 200); // everyone answers, so each can write its intro await s.app.active?.done;
    assert.ok(s.app.store.messages.filter((m) => m.from !== 'user').every((m) => m.text === '응답')); // no intro line on screen
    let bios = (await s.state()).room.bios;
    assert.equal(bios.claude, 'claude의 한 줄 소개'); assert.equal(bios.gpt, 'gpt의 한 줄 소개'); assert.equal(bios.gemini, '');
    assert.match(adapter.log.prompts.at(-1).prompt, /프로필 한 줄 소개/);

    await enableAuto(s);
    clock.t += 2 * HOUR; await s.app.tick();
    assert.ok(s.app.store.messages.filter((m) => m.auto === 'call').every((m) => m.text.endsWith('짧은 말')));
    assert.ok(adapter.log.prompts.filter((p) => p.auto).at(-1).prompt.includes('의 한 줄 소개\n')); // it sees its current intro

    assert.equal((await s.post('/api/room', { bios: { claude: '' } })).body.room.bios.claude, '');
    await s.post('/api/room', { memoOn: false, bios: { gpt: '' } });
    clock.t += 2 * HOUR; await s.app.tick();
    bios = (await s.state()).room.bios;
    assert.deepEqual(bios, { gemini: '', gpt: '', claude: '' }); // nothing is saved while it is off
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('한도 배터리: 5시간·주간만 보이고, GPT Pro는 주간만, 색은 남은 양에 따른다', () => {
  const w = (id, remainingPct, extra = {}) => ({ id, label: id, usedPct: 100 - remainingPct, remainingPct, ...extra });
  const claude = { plan: '구독', windows: [w('week', 41), w('5h', 49), w('week-sonnet', 10, { minor: true })] };
  assert.deepEqual(limitWindows('claude', claude).map((x) => x.id), ['5h', 'week']); // 5h first, minor buckets dropped
  const plus = { plan: 'Plus', windows: [w('5h', 81), w('week', 88)] };
  assert.deepEqual(limitWindows('gpt', plus).map((x) => x.id), ['5h', 'week']);
  for (const plan of ['Pro', 'Pro Lite']) assert.deepEqual(limitWindows('gpt', { plan, windows: plus.windows }).map((x) => x.id), ['week']);
  assert.deepEqual(limitWindows('claude', { plan: 'Pro', windows: plus.windows }).map((x) => x.id), ['5h', 'week']); // only GPT's Pro hides it
  assert.deepEqual(limitWindows('gemini', { plan: null, windows: [w('week', 100)] }).map((x) => x.id), ['week']); // whatever the CLI reports
  assert.deepEqual(limitWindows('gemini', null), []);
  assert.deepEqual([100, 50, 49, 20, 19, 0].map(batteryLevel), ['ok', 'ok', 'mid', 'mid', 'low', 'low']);
});
test('가장 가벼운 모델을 추천으로 알려 주고, 추천값을 그대로 저장할 수 있다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-rec-'));
  const adapter = autoAdapter();
  const s = await startAuto(root, adapter, { t: Date.now() });
  try {
    const before = (await s.state()).room.recommended;
    assert.deepEqual(before.claude, { model: 'haiku', effort: 'low' });
    assert.deepEqual(before.gemini, { model: 'gemini-3.8-flash-low', effort: '' }); // the level is part of Gemini's model name
    assert.equal(before.gpt, null); // not known until the Codex list is loaded
    assert.ok((await s.state()).catalog.claude.models.some((m) => m.id === 'haiku'));
    assert.ok((await s.state()).catalog.gemini.models.some((m) => m.id === 'gemini-3.8-flash-low'));
    const after = (await s.post('/api/models/refresh', { id: 'gpt' })).body.room.recommended;
    assert.deepEqual(after.gpt, { model: 'gpt-6-luna', effort: 'low' }); // the one the list calls affordable, not the older "efficient" one
    // what the guide saves on the first run: the recommended model for every AI
    const saved = await s.post('/api/room', { models: Object.fromEntries(Object.entries(after).map(([id, r]) => [id, r])), onboarding: { done: true } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.room.models.gpt, { model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(saved.body.room.models.claude, { model: 'haiku', effort: 'low' });
    assert.deepEqual(saved.body.room.models.gemini, { model: 'gemini-3.8-flash-low', effort: '' });
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- welcoming the user ----------
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await sleep(5); await sleep(20); };
test('첫 시작 안내를 마치면 열렸다는 줄, 입장 문구, AI들의 반말 인사가 한 번만 나온다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-welcome-'));
  const adapter = autoAdapter(); const clock = { t: Date.now() };
  let s = await startAuto(root, adapter, clock, { greetings: true });
  try {
    await s.post('/api/room', { userName: '민수' });
    await s.state(); assert.equal(s.app.store.messages.length, 0); // nothing before the guide is finished
    assert.equal(adapter.log.auto, 0);
    await s.post('/api/room', { onboarding: { done: true } });
    await waitFor(() => adapter.log.auto >= 2);
    const msgs = s.app.store.messages;
    assert.equal(msgs[0].kind, 'welcome'); assert.match(msgs[0].text, /AI 단톡방 열렸어! 멤버: .*민수/);
    assert.deepEqual([msgs[1].kind, msgs[1].text, msgs[1].presence], ['presence', '민수 들어옴', true]);
    const hello = msgs.filter((m) => m.auto === 'greet');
    assert.equal(hello.length, 2); assert.notEqual(hello[0].from, hello[1].from);
    assert.ok(hello.every((m) => m.effort === 'low' && ['haiku', 'gpt-6-luna'].includes(m.model)));
    const [p1, p2] = adapter.log.prompts.filter((p) => p.auto);
    assert.match(p1.prompt, /민수이\(가\) 이 단톡방에 처음 들어왔어/); assert.match(p2.prompt, /앞 멤버가 이렇게 인사했어/);
    assert.ok(p1.brief.includes('반말') && p1.brief.includes('"민수"'));
    assert.equal((await s.state()).room.auto.usage.calls, 2); assert.equal((await s.state()).room.auto.on, false); // Talk stays off
    // never again: same call, a restart, a reopened guide
    await s.post('/api/room', { onboarding: { done: true } });
    await s.app.close();
    s = await startAuto(root, adapter, clock, { greetings: true });
    await s.post('/api/room', { onboarding: { done: true } });
    await sleep(60);
    assert.equal(adapter.log.auto, 2); assert.equal(s.app.store.messages.filter((m) => m.kind === 'welcome').length, 1);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('첫 인사의 한도 오류는 각 AI를 한 번만 쉬게 하고, 연결된 AI가 없으면 입장 안내만 나온다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-welcome-'));
  const adapter = autoAdapter(); adapter.log.mode = 'quota';
  let s = await startAuto(root, adapter, { t: Date.now() }, { greetings: true });
  try {
    await s.post('/api/room', { onboarding: { done: true } });
    await waitFor(() => adapter.log.auto >= 2);
    assert.equal(adapter.log.auto, 2); // each AI is called once, without retrying either one
    assert.equal(adapter.log.prompts.filter((p) => p.auto && p.id === 'gpt').length, 1);
    assert.equal(adapter.log.prompts.filter((p) => p.auto && p.id === 'claude').length, 1);
    assert.equal(s.app.store.messages.filter((m) => m.text === '나 잠깐 쉬러간다 ㅋㅋ').length, 2);
    assert.ok(!s.app.store.messages.some((m) => m.auto === 'greet'));
    assert.equal((await s.state()).room.auto.usage.stopped, null); // a failed hello does not rest the day
    await s.app.close();
    fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
    const none = autoAdapter(); none.available = () => ({ gemini: false, gpt: false, claude: false });
    s = await startAuto(root, none, { t: Date.now() }, { greetings: true });
    await s.post('/api/room', { onboarding: { done: true } });
    await sleep(60);
    assert.deepEqual(s.app.store.messages.map((m) => m.kind), ['welcome', 'presence']); assert.equal(none.log.auto, 0);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('오랜만에 다시 열면 한 번만 입장 문구와 AI 환영이 나오고, 새로고침·Talk off·이미 한 안내는 조용하다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-back-'));
  const adapter = autoAdapter(); const clock = { t: Date.now() };
  // the guide is finished and one question asked in an earlier run; this run starts with greetings on
  let s = await startAuto(root, adapter, clock);
  await s.post('/api/room', { onboarding: { done: true }, userName: '민수' });
  await s.post('/api/send', { text: '안녕' }); await s.app.active?.done;
  await s.app.close();
  adapter.log.auto = 0; adapter.log.prompts.length = 0;
  s = await startAuto(root, adapter, clock, { greetings: true });
  const visit = () => new Promise((resolve) => {
    const req = http.get(`${s.url}/events`, (res) => { res.once('data', () => { req.destroy(); resolve(); }); });
    req.on('error', () => resolve());
  });
  const joins = () => s.app.store.messages.filter((m) => m.presence).length;
  try {
    await visit(); await sleep(30); assert.equal(adapter.log.auto, 0); // Talk is off: opening the page is silent
    clock.t += 3 * HOUR; await visit(); await sleep(30); assert.equal(adapter.log.auto, 0); assert.equal(joins(), 0);
    await enableAuto(s);
    clock.t += 3 * HOUR; await visit(); await waitFor(() => adapter.log.auto >= 2);
    assert.equal(joins(), 1); assert.equal(s.app.store.messages.filter((m) => m.auto === 'greet').length, 2);
    const first = adapter.log.prompts.find((p) => p.auto);
    assert.match(first.prompt, /민수이\(가\) 3시간 만에 단톡방에 다시 들어왔어/); assert.ok(first.prompt.includes('지어내진 마'));
    // reload, a second tab, a reconnect within the hour: nothing more
    clock.t += 10 * 60000; await visit(); await visit(); await sleep(40);
    assert.equal(joins(), 1); assert.equal(adapter.log.auto, 2);
    // and the next long absence welcomes again
    clock.t += 5 * HOUR; await visit(); await waitFor(() => adapter.log.auto >= 4);
    assert.equal(joins(), 2);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('자동 대화는 카드·시간대·순서(열기·받아치기·마무리)와 반말·상담원 말투 금지·지어내기 금지를 담는다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-cards-'));
  const adapter = autoAdapter(); const clock = { t: new Date(2026, 5, 10, 22, 0, 0).getTime() };
  const s = await startAuto(root, adapter, clock);
  try {
    await enableAuto(s);
    clock.t += 2 * HOUR; await s.app.tick(); // 낮음: 3 turns
    const turns = adapter.log.prompts.filter((p) => p.auto);
    assert.equal(turns.length, 3);
    assert.match(turns[0].prompt, /^지금은 (새벽|아침|점심때|오후|저녁|밤)이야\./);
    assert.ok(!turns[0].prompt.includes('방금 나온 말')); assert.ok(turns[1].prompt.includes('방금 나온 말')); assert.ok(turns[2].prompt.includes('방금 나온 말'));
    const card = (p) => p.prompt.split('\n\n[내 개인 메모')[0].split('\n\n').at(-1); // the instruction before the memo block
    assert.notEqual(card(turns[0]), card(turns[1])); // open vs answer back
    assert.notEqual(card(turns[1]), card(turns[2])); // answer back vs wrap up
    for (const turn of turns) {
      const peer = turn.id === 'gpt' ? 'claude' : 'gpt';
      assert.ok(turn.brief.includes(`너는 ${MEMBERS[turn.id].name}다.`));
      assert.ok(turn.brief.includes(`이번 대화의 AI 동료: ${MEMBERS[peer].name}.`));
      assert.match(turn.brief, /@이름으로 멘션/);
      assert.match(turn.brief, /사용자의 새 메시지에 답하는 턴이 아니다/);
      assert.match(turn.brief, /사용자에게 질문·선택·작업을 떠넘기지 않는다/);
    }
    for (const t of turns) for (const rule of ['반말', '존댓말 금지', '상담원 말투', '지어내지 않는다', '맞장구만 치지 않는다']) assert.ok(t.brief.includes(rule), rule);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('혼자 자동 대화하는 AI에게 없는 동료나 사용자를 부르도록 지시하지 않는다', () => {
  const context = peerContext('Claude', []);
  assert.match(context, /AI 동료: \(없음\)/);
  assert.match(context, /없는 상대를 부르지 않는다/);
});
test('방 이름과 내 이름을 바꿀 수 있고, AI는 바뀐 이름으로 부르며, 재시작해도 유지된다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-names-'));
  const adapter = autoAdapter(); const clock = { t: Date.now() };
  let s = await startAuto(root, adapter, clock);
  try {
    const first = (await s.state()).room;
    assert.equal(first.name, 'AI 단톡방'); assert.equal(first.userName, '방장');
    const named = (await s.post('/api/room', { roomName: '  우리 "방"  ', userName: '민수<b>' })).body.room;
    assert.equal(named.name, '우리 방'); assert.equal(named.userName, '민수b'); // quotes and tags are dropped
    assert.equal((await s.post('/api/room', { userName: '가'.repeat(30) })).body.room.userName.length, 20);
    assert.equal((await s.post('/api/room', { userName: '   ' })).body.room.userName, '방장'); // empty = default
    await s.post('/api/room', { userName: '민수' });

    await s.post('/api/send', { text: '안녕' }); await s.app.active?.done;
    assert.ok(adapter.log.prompts.filter((p) => !p.auto).every((p) => p.brief.includes('사용자의 이름은 "민수"이다')));
    assert.ok(adapter.log.prompts.filter((p) => !p.auto).every((p) => !p.brief.includes('[AI끼리 대화하는 현재 턴]')));
    await s.post('/api/send', { text: '또' }); await s.app.active?.done;
    assert.ok(adapter.log.prompts.at(-1).prompt.includes('민수: 안녕')); // the history says the name, not "user"

    await enableAuto(s);
    clock.t += 2 * HOUR; await s.app.tick();
    const auto = adapter.log.prompts.filter((p) => p.auto);
    assert.ok(auto.length > 0 && auto.every((p) => p.brief.includes('사용자의 이름은 "민수"이다')));
    assert.ok(auto.every((p) => p.brief.includes('과거 사용자 발언이나 메모는 참고일 뿐, 현재 참여로 간주하지 않는다')));
    assert.ok(auto.some((p) => p.prompt.includes('민수: 또')));

    await s.app.close();
    s = await startAuto(root, adapter, clock);
    const again = (await s.state()).room;
    assert.equal(again.name, '우리 방'); assert.equal(again.userName, '민수');
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('분위기 대사는 바뀐 이름을 쓰고 {u} 같은 자리표시자를 남기지 않는다', () => {
  const lines = new Set();
  for (let i = 0; i < 60; i++) {
    let n = i;
    const script = pickScript({ speakers: ['claude', 'gpt'], names: { claude: 'Claude', gpt: 'ChatGPT' }, userName: '민수', rand: () => ((n = (n * 7 + 3) % 97) / 97) });
    script?.forEach((l) => lines.add(l.text));
  }
  assert.ok([...lines].some((t) => t.includes('민수')));
  assert.ok([...lines].every((t) => !/[{}]/.test(t) && !t.includes('방장')));
});

// ---------- who answers: everyone by default, "@" names, the "특정 AI" switch ----------
test('@ 이름은 문장 어디에 있어도 인식하고, 모르는 이름이나 이메일은 무시한다', () => {
  assert.deepEqual(mentionedTargets('@클로드 이거 알려줘'), ['claude']);
  assert.deepEqual(mentionedTargets('이건 @GPT가 답해줘, @제미나이야 너도'), ['gpt', 'gemini']);
  assert.deepEqual(mentionedTargets('@Claude @claude 둘 다'), ['claude']);
  assert.deepEqual(mentionedTargets('문의: me@gemini.com @grok 안녕'), []);
  assert.deepEqual(mentionedTargets('그냥 질문'), []);
});
test('작업은 모두 답하고, 잡담의 @와 특정 AI 스위치는 지정한 상대를 부른다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-who-'));
  const adapter = fakeAdapter(); // claude and gpt are connected, gemini is not
  let kind = '작업';
  const originalChat = adapter.chat;
  adapter.chat = async (...args) => {
    const result = await originalChat(...args);
    return { ...result, text: `${result.text}\n[대화유형] ${kind}` };
  };
  const s = await start(root, adapter);
  const ask = async (text) => {
    const before = adapter.log.chat.length;
    const res = await s.post('/api/send', { text });
    await s.app.active?.done;
    return { res, calls: adapter.log.chat.slice(before) };
  };
  try {
    assert.equal((await s.state()).room.callMode, 'auto');
    const all = await ask('얘들아 안녕'); // a room-wide phrase: every connected AI answers
    assert.equal(all.res.status, 200); assert.deepEqual(all.calls.map((c) => c.id).sort(), ['claude', 'gpt']);
    assert.ok(all.calls.every((c) => c.prompt.includes('안녕')));
    assert.ok(!s.app.store.messages.some((m) => m.kind === 'complete')); // no closing note for a plain answer
    assert.deepEqual(s.app.store.messages.filter((m) => m.from !== 'user').map((m) => m.from).sort(), ['claude', 'gpt']);

    kind = '잡담';
    const one = await ask('이건 @지피티 가 답해줘');
    assert.deepEqual(one.calls.map((c) => c.id), ['gpt']); assert.ok(!one.calls[0].prompt.includes('다른 AI에게도'));
    assert.equal((await ask('@gemini 안녕')).res.status, 400); // not connected: nobody answers instead
    const mixed = await ask('@claude @gemini 둘에게');
    assert.deepEqual(mixed.calls.map((c) => c.id), ['claude']);
    assert.match(s.app.store.messages.at(-1).text, /빠짐: Gemini\(연결 설정 필요\)/);

    await s.post('/api/room', { enabled: { gpt: false } });
    assert.equal((await ask('@gpt 안녕')).res.status, 400);
    assert.deepEqual((await ask('안녕')).calls.map((c) => c.id), ['claude']);
    await ask('@claude @gpt 둘');
    assert.match(s.app.store.messages.at(-1).text, /빠짐: ChatGPT\(쉬는 중\)/);
    await s.post('/api/room', { enabled: { gpt: true } });

    // An older client's "targeted" switch is still accepted, but it no longer decides who answers.
    await s.post('/api/room', { targeted: true, selected: 'gpt' });
    assert.equal((await s.state()).room.callMode, 'pick');
    assert.deepEqual((await ask('@claude 부름')).calls.map((c) => c.id), ['claude']);
    await s.post('/api/room', { targeted: false, discussion: true });
    const lone = await ask('@gpt 토론 중에도');
    assert.equal(lone.res.status, 400); assert.equal(lone.calls.length, 0); // one AI cannot discuss; nobody is added
    assert.equal((await ask('@gpt @claude 둘이 토론')).calls.length, 5); // two named AIs discuss
    assert.equal((await ask('토론 질문')).calls.length, 5);
    assert.equal((await s.state()).room.targeted, false);
    assert.equal((await s.state()).room.callMode, 'auto', 'turning the old "targeted" switch off returns to the automatic choice');
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('남은 한도는 연결된 AI만 확인하고, 오류 문구의 비밀은 가려서 보낸다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-usage-'));
  const polled = [];
  const usage = {
    polling: false, lastPoll: 0, onUpdate: () => {},
    pollAll: async (ids) => { polled.push(ids); },
    view: () => ({ claude: { ok: false, at: 1, error: 'failed token=SECRET123', windows: [{ id: '5h', label: '5시간', usedPct: 30, remainingPct: 70 }] }, gpt: null, gemini: null }),
  };
  const app = createAssistantServer({ root, cfg: loadConfig(), adapter: fakeAdapter(), usage });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  try {
    assert.deepEqual(polled, [['gpt', 'claude']]);
    const view = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`)).json();
    assert.equal(view.usage.claude.windows[0].remainingPct, 70);
    assert.ok(!JSON.stringify(view).includes('SECRET123'));
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- 반말 and personal memos ----------
test('모든 AI에게 반말을 쓰라고 지시하고 성격은 정해 주지 않는다', () => {
  assert.match(AUTO_BRIEF, /반말/); assert.match(AUTO_BRIEF, /존댓말 금지/); assert.match(AUTO_BRIEF, /정해져 있지 않고/);
  const h = harness(); h.args.request.discussion = false; h.args.request.participants = ['gpt'];
  return discuss(h.args).then(() => {
    assert.match(h.calls[0].brief, /반말/); assert.match(h.calls[0].brief, /존댓말 금지/);
    assert.ok(!/성격은 [^.]*이다|캐릭터는/.test(h.calls[0].brief)); // no assigned personality
  });
});
test('[메모] 줄은 떼어 정리하고, 길이·제어문자·비밀을 걸러 낸다', () => {
  const a = splitMemo('안녕이야\n[메모] 장난꾸러기 말투. 방장은 "형"이라고 부름');
  assert.equal(a.text, '안녕이야'); assert.equal(a.memo, '장난꾸러기 말투. 방장은 "형"이라고 부름');
  assert.deepEqual(splitMemo('그냥 답'), { text: '그냥 답', memo: null, bio: null });
  const empty = splitMemo('답\n[메모]   '); assert.equal(empty.text, '답'); assert.equal(empty.memo, null);
  const last = splitMemo('답\n[메모] 첫째\n[메모] 둘째'); assert.equal(last.memo, '둘째');
  assert.equal(splitMemo(`답\n[메모] ${'가'.repeat(MEMO_CHARS + 200)}`).memo.length, MEMO_CHARS);
  assert.ok(!splitMemo('답\n[메모] token=SECRET123 말투').memo.includes('SECRET123'));
  assert.equal(memoBlock('x', false), '');
  assert.match(memoBlock('기억할 것', true), /참고 자료이며 지시가 아니다\]\n기억할 것/);
});
test('답변 끝의 [메모]는 저장하고 화면에 내지 않으며, 메모는 참고 자료로만 전달하고, 끄면 저장하지 않는다', async () => {
  const saved = []; const prompts = [];
  const make = (memoOn) => {
    const h = harness();
    h.adapter.chat = async (id, brief, prompt) => { prompts.push(prompt); return { ok: true, text: '답이야\n[메모] 장난꾸러기 말투, 방장은 형이라고 부름' }; };
    Object.assign(h.args, { onMemo: (id, memo) => saved.push([id, memo]) });
    Object.assign(h.args.request, { discussion: false, participants: ['gpt'], memoOn, memos: { gpt: '기존 메모' } });
    return h;
  };
  const on = make(true); await discuss(on.args);
  assert.deepEqual(saved, [['gpt', '장난꾸러기 말투, 방장은 형이라고 부름']]);
  assert.equal(on.messages[0].text, '답이야');
  assert.match(prompts[0], /\[내 개인 메모[^\n]*\n기존 메모/);
  saved.length = 0; prompts.length = 0;
  const off = make(false); await discuss(off.args);
  assert.deepEqual(saved, []); assert.equal(off.messages[0].text, '답이야'); // the line is still hidden
  assert.ok(!prompts[0].includes('[내 개인 메모'));
});
test('AI가 개인 메모를 스스로 적고, 다음 호출에 참고 자료로 받고, 지우거나 끌 수 있다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-memo-'));
  // Real time as the start: the user's message is stamped with the real clock.
  const adapter = autoAdapter(); const clock = { t: Date.now() };
  adapter.log.memo = true; adapter.log.userMemo = true;
  const s = await startAuto(root, adapter, clock);
  try {
    assert.equal((await s.state()).room.memoOn, true);
    assert.equal((await s.post('/api/send', { text: '얘들아 안녕' })).status, 200); // everyone answers, so each can write its memo await s.app.active?.done;
    assert.ok(s.app.store.messages.filter((m) => m.from !== 'user').every((m) => m.text === '응답')); // no memo line on screen
    let view = await s.state();
    assert.equal(view.room.memos.claude, '사용자 질문 메모'); assert.equal(view.room.memos.gpt, '사용자 질문 메모');

    await enableAuto(s);
    clock.t += 2 * HOUR; await s.app.tick();
    view = await s.state();
    assert.ok(s.app.store.messages.filter((m) => m.auto === 'call').every((m) => m.text.endsWith('짧은 말')));
    assert.equal(view.room.memos.claude, 'claude 말투 메모'); assert.equal(view.room.memos.gpt, 'gpt 말투 메모');
    clock.t += 2 * HOUR; await s.app.tick();
    const last = adapter.log.prompts.filter((p) => p.auto).at(-1);
    assert.match(last.prompt, /\[내 개인 메모/); assert.ok(last.prompt.includes(`${last.id} 말투 메모`));

    assert.equal((await s.post('/api/room', { memos: { claude: '' } })).body.room.memos.claude, '');
    const long = (await s.post('/api/room', { memos: { gpt: `${'가'.repeat(500)} token=SECRET123` } })).body.room.memos.gpt;
    assert.equal(long.length, MEMO_CHARS); assert.ok(!long.includes('SECRET123'));

    await s.post('/api/room', { memoOn: false, memos: { gpt: '' } });
    const from = adapter.log.prompts.length;
    clock.t += 2 * HOUR; await s.app.tick();
    assert.ok(adapter.log.prompts.length > from);
    assert.ok(adapter.log.prompts.slice(from).every((p) => !p.prompt.includes('[내 개인 메모')));
    view = await s.state();
    assert.equal(view.room.memos.claude, ''); assert.equal(view.room.memos.gpt, ''); // nothing saved while off
    assert.ok(s.app.store.messages.filter((m) => m.auto === 'call').every((m) => !m.text.includes('[메모]')));
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
