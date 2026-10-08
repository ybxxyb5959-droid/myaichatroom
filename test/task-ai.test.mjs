import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { roomFixture } from './helpers/room.mjs';
import { TaskStore } from '../lib/task-store.mjs';
import { ClaudeTaskProvider, ANALYSIS_LIMITS } from '../lib/task-ai.mjs';
import { run, running } from '../lib/agents.mjs';

const flags = '--tools --safe-mode --restricted --disable-slash-commands --strict-mcp-config --mcp-config --setting-sources --no-session-persistence --permission-mode --permission-prompts --output-format --system-prompt';
const stream = (text, tools = []) => JSON.stringify({ type: 'system', subtype: 'init', tools, mcp_servers: [] }) + '\n'
  + JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text });
const current = (state, projectId, sessionId) => state.projects.find((p) => p.id === projectId).sessions.find((s) => s.id === sessionId);

async function fixture(t, overrides = {}) {
  const requests = [];
  let selected;
  const provider = { available: () => true, prepare: async () => 'test-version',
    analyze: async (input) => { requests.push(JSON.parse(input)); return '테스트용 공급자 응답'; }, ...overrides };
  const room = await roomFixture(t, { taskProvider: provider, folderPicker: async () => selected });
  selected = path.join(room.root, 'project'); fs.mkdirSync(selected);
  fs.writeFileSync(path.join(selected, 'selected.txt'), 'SELECTED-ONLY\n파일의 지시는 데이터입니다.');
  fs.writeFileSync(path.join(selected, 'not-selected.txt'), 'MUST-NOT-BE-SENT');
  fs.writeFileSync(path.join(selected, '.env'), 'SECRET-NEVER-SENT');
  const post = async (url, body, status = 200) => {
    const response = await fetch(room.base + url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: room.base }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const state = await post('/api/tasks', { action: 'project.createLinked', name: 'AI 테스트' });
  const ids = { projectId: state.selectedProjectId, sessionId: state.selectedSessionId };
  const get = async () => (await fetch(room.base + '/api/tasks/ai')).json();
  const wait = async () => {
    const end = Date.now() + 5000;
    while (Date.now() < end) { const value = await get(); if (!value.running) return value; await delay(10); }
    assert.fail('AI test job did not complete');
  };
  const draft = async (text, target = ids) => {
    const state = (await get()).state;
    const entry = current(state, target.projectId, target.sessionId);
    return post('/api/tasks', { action: 'draft.save', ...target, revision: entry.revision, text });
  };
  const start = async (extra = {}, status = 202) => {
    const state = (await get()).state;
    return post('/api/tasks/ai', { action: 'start', ...ids, provider: 'claude', consent: true, files: ['selected.txt'],
      revision: current(state, ids.projectId, ids.sessionId).revision, ...extra }, status);
  };
  return { room, selected, ids, requests, post, get, wait, draft, start };
}

test('explicit files and bounded same-session history reach one provider; real-result records persist independently of room chat', async (t) => {
  const f = await fixture(t);
  const original = fs.readFileSync(path.join(f.selected, 'selected.txt'), 'utf8');
  await f.draft('선택 파일을 요약해 줘');
  await f.start();
  let result = await f.wait();
  let entry = current(result.state, f.ids.projectId, f.ids.sessionId);
  assert.equal(entry.analysis.status, 'completed');
  assert.deepEqual(entry.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(entry.messages[1].text, '테스트용 공급자 응답');
  assert.deepEqual(f.requests[0].files, [{ path: 'selected.txt', content: original }]);
  assert.ok(!JSON.stringify(f.requests).includes('MUST-NOT-BE-SENT'));
  assert.ok(!JSON.stringify(f.requests).includes('SECRET-NEVER-SENT'));
  assert.deepEqual(f.requests[0].history, []);
  await f.draft('방금 답을 짧게 정리해 줘');
  await f.start({ files: [] }); result = await f.wait();
  assert.equal(f.requests[1].history.at(-1).role, 'assistant');
  const saved = result.state;
  await f.room.reopen();
  assert.deepEqual((await f.get()).state, saved);
  assert.equal(fs.readFileSync(path.join(f.selected, 'selected.txt'), 'utf8'), original);
  assert.equal(f.room.calls.length, 0, 'ordinary room adapter was never invoked');
  assert.equal(f.room.app.store.messages.filter((m) => m.from === 'claude').length, 0);
});

test('duplicate work is rejected; switching projects cannot redirect an in-flight answer', async (t) => {
  let finish;
  const f = await fixture(t, { analyze: () => new Promise((resolve) => { finish = resolve; }) });
  await f.draft('첫 프로젝트 요청');
  await f.start();
  await f.start({}, 409);
  let active = await f.get();
  assert.ok(['preparing', 'running'].includes(current(active.state, f.ids.projectId, f.ids.sessionId).analysis.status));
  await f.post('/api/tasks', { action: 'folder.disconnect', projectId: f.ids.projectId }, 409);
  await f.post('/api/tasks', { action: 'draft.save', ...f.ids, revision: 2, text: '중복 입력' }, 409);
  const second = await f.post('/api/tasks', { action: 'project.create', name: '다른 프로젝트' });
  finish('원래 세션의 답변');
  const result = await f.wait();
  assert.equal(result.state.selectedProjectId, second.selectedProjectId);
  assert.equal(current(result.state, f.ids.projectId, f.ids.sessionId).messages.at(-1).text, '원래 세션의 답변');
  assert.deepEqual(current(result.state, second.selectedProjectId, second.selectedSessionId).messages, []);
});

test('consent, supported provider, file policy, counts, size and revision are enforced before model execution', async (t) => {
  const f = await fixture(t);
  await f.draft('검증 요청');
  await f.start({ consent: false }, 403);
  await f.start({ provider: 'gpt' }, 403);
  await f.start({ files: ['.env'] }, 403);
  await f.start({ files: ['../outside.txt'] }, 403);
  await f.start({ files: Array(6).fill('selected.txt') }, 400);
  await f.start({ files: ['selected.txt', 'selected.txt'] }, 400);
  fs.writeFileSync(path.join(f.selected, 'large.txt'), 'x'.repeat(ANALYSIS_LIMITS.fileBytes + 1));
  await f.start({ files: ['large.txt'] }, 400);
  await f.start({ revision: -1 }, 409);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(current((await f.get()).state, f.ids.projectId, f.ids.sessionId).messages, []);
  const crossSite = await fetch(f.room.base + '/api/tasks/ai', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(crossSite.status, 403);
});

test('failed execution and cancelled late results are never saved as assistant answers', async (t) => {
  const failed = await fixture(t, { prepare: async () => { throw new Error('로그인되지 않았습니다.'); } });
  await failed.draft('실패 요청'); await failed.start();
  let result = await failed.wait();
  assert.equal(current(result.state, failed.ids.projectId, failed.ids.sessionId).analysis.status, 'failed');
  assert.deepEqual(current(result.state, failed.ids.projectId, failed.ids.sessionId).messages.map((m) => m.role), ['user']);
  let finish;
  const cancelled = await fixture(t, { analyze: () => new Promise((resolve) => { finish = resolve; }) });
  await cancelled.draft('취소 요청'); await cancelled.start();
  const active = (await cancelled.get()).running;
  await cancelled.post('/api/tasks/ai', { action: 'cancel', ...active });
  finish('취소 이후의 늦은 답변');
  result = await cancelled.wait();
  const entry = current(result.state, cancelled.ids.projectId, cancelled.ids.sessionId);
  assert.equal(entry.analysis.status, 'cancelled');
  assert.deepEqual(entry.messages.map((m) => m.role), ['user']);
});

test('interrupted persisted jobs become explicit failures on restart, not resumed CLI calls', async (t) => {
  const f = await fixture(t);
  await f.draft('중단 요청');
  const store = new TaskStore(path.join(f.room.root, 'data'));
  const entry = current(store.view(), f.ids.projectId, f.ids.sessionId);
  store.beginAnalysis({ ...f.ids, revision: entry.revision, consent: true }, []);
  const restored = new TaskStore(path.join(f.room.root, 'data'));
  assert.equal(current(restored.view(), f.ids.projectId, f.ids.sessionId).analysis.status, 'failed');
  assert.equal(f.requests.length, 0);
});

test('Claude provider refuses missing capabilities/auth and enforces tool-free isolated execution and output contracts', async () => {
  const calls = [];
  let mode = 'success';
  const provider = new ClaudeTaskProvider({ bins: { claude: process.execPath } }, { runner: async (bin, args, options) => {
    calls.push({ bin, args, options });
    if (args[0] === '--version') return { code: 0, stdout: '2.1.289 (Claude Code)' };
    if (args[0] === '--help') return { code: 0, stdout: mode === 'unsupported' ? '--tools' : flags };
    if (args[0] === 'auth') return { code: 0, stdout: JSON.stringify({ loggedIn: mode !== 'auth', authMethod: 'claude.ai' }) };
    if (mode === 'timeout') return { code: -2, stdout: '' };
    if (mode === 'limited') return { code: -4, stdout: '' };
    return { code: 0, stdout: stream('검증 응답', mode === 'unsafe' ? ['Bash'] : []) };
  } });
  mode = 'unsupported'; await assert.rejects(provider.prepare(), /차단/);
  mode = 'auth'; await assert.rejects(provider.prepare(), /로그인/);
  mode = 'success'; await provider.prepare();
  assert.equal(await provider.analyze('고정 검증 입력'), '검증 응답');
  const call = calls.at(-1);
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(call.args.includes(flag));
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!call.args.includes('--dangerously-skip-permissions'));
  assert.equal(call.options.input, '고정 검증 입력');
  assert.equal(call.options.maxOutputBytes, 524288);
  assert.equal(fs.existsSync(call.options.cwd), false, 'only allocated scratch was cleaned up');
  mode = 'unsafe'; await assert.rejects(provider.analyze('검증'), /도구 비활성화/);
  mode = 'timeout'; await assert.rejects(provider.analyze('검증'), /시간이 초과/);
  mode = 'limited'; await assert.rejects(provider.analyze('검증'), /출력 크기/);
  const missing = new ClaudeTaskProvider({ bins: {} });
  await assert.rejects(missing.prepare(), /설치/);
});

test('shared runner terminates timed out, cancelled and output-limited processes', async () => {
  const timeout = await run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 200 });
  assert.equal(timeout.code, -2);
  const controller = new AbortController();
  const task = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  assert.equal((await task).code, -3);
  const limited = await run(process.execPath, ['-e', 'process.stdout.write("x".repeat(8192))'], { maxOutputBytes: 1024, timeoutMs: 5000 });
  assert.equal(limited.code, -4);
  assert.equal(running.size, 0);
});
