import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { roomFixture } from './helpers/room.mjs';
import { CodexTaskProvider, AgyTaskProvider } from '../lib/task-providers.mjs';
import { taskSystem } from '../lib/task-prompts.mjs';
import { run } from '../lib/agents.mjs';

const json = JSON.stringify;
const adapterFor = (bin, extra = {}) => ({ bins: { codex: bin, agy: bin }, cfg: { agents: { gpt: { model: 'gpt-test' }, gemini: { model: 'gemini-test' } } }, agyEnv: () => ({ TEMP: 'x' }), ...extra });
const EXISTING = process.execPath;

test('Codex runs read-only, ephemeral and without shell/computer tools; the answer is read from the output file', async () => {
  const calls = [];
  const runner = async (bin, args, options) => {
    calls.push({ args, options });
    if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.160.0\n', stderr: '' };
    if (args[0] === 'exec' && args[1] === '--help') return { code: 0, stdout: '--ignore-user-config --ephemeral --sandbox --disable --skip-git-repo-check --output-last-message', stderr: '' };
    if (args[0] === 'login') return { code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' };
    fs.writeFileSync(args[args.indexOf('-o') + 1], '  코덱스의 답변  ');
    return { code: 0, stdout: '', stderr: '' };
  };
  const provider = new CodexTaskProvider(adapterFor(EXISTING), { runner });
  assert.equal((await provider.check()).state, 'ready');
  assert.equal(provider.verified(), true);
  const answer = await provider.analyze('{"request":"안녕"}', { mode: 'analysis' });
  assert.equal(answer, '코덱스의 답변');
  const run = calls.at(-1);
  const flags = run.args.join(' ');
  for (const needed of ['-s read-only', '--ephemeral', '--ignore-user-config', '--disable shell_tool', '--disable computer_use', '--disable browser_use', '-c web_search="disabled"', '-m gpt-test']) {
    assert.ok(flags.includes(needed), `missing ${needed}`);
  }
  assert.match(run.options.input, /^프로젝트 자료를 분석하는 읽기 전용 도우미/);
  assert.match(run.options.input, /=====\n\n\{"request":"안녕"\}$/);
  assert.notEqual(run.options.cwd, process.cwd());
  assert.ok(!fs.existsSync(run.options.cwd), 'the scratch folder is removed');
  assert.ok(!('env' in run.options) || !JSON.stringify(run.options.env || {}).includes('API_KEY'));
});

test('Codex is refused when it is missing, not logged in, API-key based or lacks the safety flags', async () => {
  const make = (overrides) => new CodexTaskProvider(adapterFor(EXISTING), { runner: async (bin, args) => {
    if (args[0] === '--version') return { code: 0, stdout: '1.0.0', stderr: '' };
    if (args[0] === 'exec') return overrides.help ?? { code: 0, stdout: '--ignore-user-config --ephemeral --sandbox --disable --skip-git-repo-check --output-last-message', stderr: '' };
    return overrides.login ?? { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
  } });
  assert.equal((await new CodexTaskProvider(adapterFor('Z:/nope/codex')).check()).state, 'missing');
  assert.equal((await make({ login: { code: 1, stdout: 'Not logged in', stderr: '' } }).check()).state, 'login');
  assert.equal((await make({ login: { code: 0, stdout: 'Logged in using an API key', stderr: '' } }).check()).state, 'api-key');
  assert.equal((await make({ help: { code: 0, stdout: '--sandbox', stderr: '' } }).check()).state, 'unsupported');
  await assert.rejects(() => make({ login: { code: 1, stdout: 'Not logged in', stderr: '' } }).prepare(), /로그인/);
});

test('Codex reports cancellation, timeout, failure and empty answers distinctly', async () => {
  const run = (result) => new CodexTaskProvider(adapterFor(EXISTING), { runner: async () => result }).analyze('x', {});
  await assert.rejects(run({ code: -3, stdout: '', stderr: '' }), /취소/);
  await assert.rejects(run({ code: -2, stdout: '', stderr: '' }), /시간이 초과/);
  await assert.rejects(run({ code: -4, stdout: '', stderr: '' }), /출력 크기/);
  await assert.rejects(run({ code: 1, stdout: '', stderr: 'x' }), /실행에 실패/);
  await assert.rejects(run({ code: 0, stdout: '', stderr: '' }), /답변을 반환하지/);
});

test('Gemini (agy) needs a real successful call before it is verified, takes only small prompts and parses the JSON reply', async () => {
  const calls = [];
  let reply = { status: 'SUCCESS', response: '제미나이 답변' };
  const runner = async (bin, args, options) => { calls.push({ args, options }); return { code: 0, stdout: json(reply), stderr: '' }; };
  const provider = new AgyTaskProvider(adapterFor(EXISTING), { runner });
  assert.equal(provider.verified(), false);
  assert.equal((await provider.check()).ok, true);
  assert.equal(provider.verified(), true);
  assert.equal(calls.length, 1, 'one tiny real call verifies the login; a second check is remembered');
  await provider.check();
  assert.equal(calls.length, 1);
  assert.equal(await provider.analyze('{"request":"hi"}', { mode: 'analysis' }), '제미나이 답변');
  const last = calls.at(-1);
  assert.deepEqual(last.args.slice(0, 4), ['--model', 'gemini-test', '--output-format', 'json']);
  assert.equal(last.args.at(-2), '-p');
  assert.equal(last.options.env.TEMP, 'x');
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) assert.equal(last.options.env[key], undefined);
  await assert.rejects(() => provider.analyze('가'.repeat(30000), {}), /한 번에 약/);
  assert.ok(calls.length === 2, 'oversized input is refused before any call');
  reply = { status: 'ERROR', response: '' };
  await assert.rejects(() => provider.analyze('x', {}), /성공한 답변/);
  const bad = new AgyTaskProvider(adapterFor(EXISTING), { runner: async () => ({ code: 1, stdout: '', stderr: 'auth' }) });
  assert.equal((await bad.check()).ok, false);
  assert.equal(bad.verified(), false);
  assert.deepEqual([...provider.modes].sort(), ['analysis', 'docs']);
  assert.equal(taskSystem('docs.chunk').includes('구간'), true);
});

test('subscription providers remove inherited and adapter API keys from real child environments without dropping other overrides', async (t) => {
  const keys = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  for (const key of keys) process.env[key] = 'test-api-key-never-send';
  const calls = [];
  const runner = async (bin, args, options) => {
    calls.push(options);
    if (args[0] === '--version') return { code: 0, stdout: 'test', stderr: '' };
    if (args[0] === 'exec' && args[1] === '--help') return { code: 0, stdout: '--ignore-user-config --ephemeral --sandbox --disable --skip-git-repo-check --output-last-message', stderr: '' };
    if (args[0] === 'login') return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
    if (args[0] === 'exec') fs.writeFileSync(args[args.indexOf('-o') + 1], 'answer');
    return { code: 0, stdout: JSON.stringify({ status: 'SUCCESS', response: 'answer' }), stderr: '' };
  };
  const adapter = adapterFor(EXISTING, { agyEnv: () => ({ WB_ENV_TEST: 'preserved', OPENAI_API_KEY: 'adapter-key', gemini_api_key: 'adapter-key' }) });
  for (const Provider of [CodexTaskProvider, AgyTaskProvider]) {
    calls.length = 0;
    const provider = new Provider(adapter, { runner });
    assert.equal((await provider.check()).ok, true);
    assert.equal(await provider.analyze('hello'), 'answer');
    for (const options of calls) {
      for (const key of keys) assert.equal(options.env[key], undefined);
      const probe = await run(process.execPath, ['-e', 'console.log(JSON.stringify({ keys: Object.keys(process.env).filter(k => ["OPENAI_API_KEY","CODEX_API_KEY","GEMINI_API_KEY","GOOGLE_API_KEY"].includes(k.toUpperCase())), keep: process.env.WB_ENV_TEST }))'], { env: options.env });
      assert.equal(probe.code, 0);
      const result = JSON.parse(probe.stdout);
      assert.deepEqual(result.keys, []);
      if (Provider === AgyTaskProvider) assert.equal(result.keep, 'preserved');
    }
  }
});

test('the workbench lets the user pick an installed AI per task, records which AI answered, and refuses unsupported modes', async (t) => {
  const seen = [];
  const make = (id, label, modes, reply) => ({ id, label, shortName: id === 'codex' ? 'Codex' : 'Gemini', available: () => true, verified: () => true, modes: new Set(modes), maxInputChars: 5000, note: '테스트',
    prepare: async () => 'ok', check: async () => ({ ok: true, state: 'ready', detail: 'ok' }), analyze: async (input, options) => { seen.push({ id, mode: options.mode }); return reply; } });
  const claude = { available: () => true, prepare: async () => 'ok', analyze: async () => { seen.push({ id: 'claude' }); return 'Claude 답'; } };
  let dir;
  const room = await roomFixture(t, { taskProvider: claude, folderPicker: async () => dir, taskProviders: {
    codex: make('codex', 'Codex 테스트', ['analysis', 'explore'], '코덱스 답'), gemini: make('gemini', 'Gemini 테스트', ['analysis'], '제미나이 답') } });
  dir = path.join(room.root, 'proj'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const post = async (url, body, status = 200) => {
    const response = await fetch(room.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: room.base }, body: json(body) });
    const value = await response.json(); assert.equal(response.status, status, json(value)); return value;
  };
  const state = await post('/api/tasks', { action: 'project.createLinked', name: 'AI 선택' });
  const ids = { projectId: state.selectedProjectId, sessionId: state.selectedSessionId };
  const get = async () => (await fetch(room.base + '/api/tasks/ai')).json();
  const wait = async () => { const end = Date.now() + 5000; while (Date.now() < end) { const v = await get(); if (!v.running) return v; await delay(10); } assert.fail('timeout'); };
  const view = await get();
  assert.deepEqual(view.providers.map((p) => [p.id, p.name, p.available]), [['claude', 'Claude Code · Sonnet', true], ['codex', 'Codex 테스트', true], ['gemini', 'Gemini 테스트', true]]);
  assert.deepEqual(view.providers[2].modes, ['analysis']);
  const start = async (provider, mode, text, status = 202) => {
    const s = (await get()).state.projects[0].sessions[0];
    const saved = await post('/api/tasks', { action: 'draft.save', ...ids, revision: s.revision, text });
    return post('/api/tasks/ai', { action: 'start', ...ids, mode, provider, consent: true, files: mode === 'analysis' ? ['a.txt'] : [], revision: saved.projects[0].sessions[0].revision }, status);
  };
  await start('codex', 'analysis', '코덱스로 분석');
  let result = await wait();
  let entry = result.state.projects[0].sessions[0];
  assert.equal(entry.analysis.provider, 'codex');
  assert.equal(entry.messages.at(-1).provider, 'codex');
  assert.equal(entry.messages.at(-1).text, '코덱스 답');
  const refused = await start('gemini', 'explore', 'x', 400);
  assert.match(refused.error, /지원하지 않습니다/);
  await start('gemini', 'analysis', '제미나이로 분석');
  await wait();
  assert.deepEqual(seen.map((s) => s.id), ['codex', 'gemini']);
  await start('claude', 'analysis', '클로드로 분석');
  result = await wait();
  assert.equal(result.state.projects[0].sessions[0].messages.at(-1).provider, 'claude');
  await post('/api/tasks/ai', { action: 'start', ...ids, mode: 'analysis', provider: 'grok', consent: true, files: [], revision: 0 }, 403);
  const check = await post('/api/tasks/ai', { action: 'provider.check', provider: 'gemini' });
  assert.equal(check.ok, true);
  await post('/api/tasks/ai', { action: 'provider.check', provider: 'nobody' }, 404);
  // the record survives a restart with the provider that answered
  await room.reopen();
  assert.equal((await get()).state.projects[0].sessions[0].messages.filter((m) => m.role === 'assistant').map((m) => m.provider).join(), 'codex,gemini,claude');
  const runs = (await (await fetch(`${room.base}/api/tasks/runs?projectId=${ids.projectId}&sessionId=${ids.sessionId}`)).json()).runs;
  assert.ok(runs[0].events.some((e) => /Codex CLI 로그인·안전 설정 확인 완료/.test(e.text)), 'events name the AI that ran');
});
