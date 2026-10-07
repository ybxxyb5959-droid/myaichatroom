import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Workbench, WORK_IDS } from '../lib/workbench.mjs';
import { createAssistantServer, loadConfig } from '../server.mjs';
import { run } from '../lib/agents.mjs';

function fixture(t, queues = {}, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-workbench-'));
  const root = path.join(base, 'app'), projectPath = path.join(base, 'project');
  fs.mkdirSync(root); fs.mkdirSync(projectPath);
  const events = new EventEmitter(), calls = [];
  const adapter = {
    available: () => Object.fromEntries(WORK_IDS.map((id) => [id, true])),
    maxPromptChars: () => 26000,
    chat: async (id, brief, prompt, opts) => {
      calls.push({ id, brief, prompt, opts });
      const next = queues[id]?.shift();
      if (!next) throw new Error(`Unexpected ${id} call`);
      const value = typeof next === 'function' ? await next({ id, brief, prompt, opts }) : next;
      return { ok: true, text: JSON.stringify(value) };
    },
  };
  const args = {
    root, adapter, defaults: () => ({
      gpt: { model: 'gpt-6.1-sol', effort: 'medium' },
      claude: { model: 'claude-opus-5-5', effort: 'medium' },
      gemini: { model: 'gemini-test', effort: '' },
    }),
    catalog: () => Object.fromEntries(WORK_IDS.map((id) => [id, { available: true }])),
    settings: (_id, value, fallback) => ({ ...fallback, ...value }),
    onChange: () => events.emit('change'), ...options,
  };
  const bench = new Workbench(args);
  const project = bench.addProject(projectPath);
  const session = bench.createSession(project.id);
  t.after(async () => { await bench.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const waitFor = (predicate) => {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve) => {
      const onChange = () => { if (predicate()) { events.off('change', onChange); resolve(); } };
      events.on('change', onChange);
    });
  };
  const start = async (text = '요청한 파일만 수정해줘') => {
    bench.start(session.id, text);
    await bench.jobs.get(session.id)?.done;
  };
  return { base, root, projectPath, bench, project, session, calls, adapter, args, waitFor, start };
}

test('solo edits real project files, preserves originals, and restores safely', async (t) => {
  const h = fixture(t, { gpt: [
    { action: 'read', path: 'sum.mjs' },
    { action: 'patch', path: 'sum.mjs', find: 'a - b', replace: 'a + b' },
    { action: 'write', path: 'test/sum.test.mjs', content: "import { sum } from '../sum.mjs';\nif (sum(2, 3) !== 5) throw new Error('sum failed');\n" },
    { action: 'done', text: '합산을 수정했습니다. 검사는 아직 실행하지 않았습니다.' },
  ] });
  const file = path.join(h.projectPath, 'sum.mjs');
  fs.writeFileSync(file, 'export const sum = (a, b) => a - b;\n');
  await h.start();
  assert.equal(h.session.status, 'done');
  assert.equal(fs.readFileSync(file, 'utf8'), 'export const sum = (a, b) => a + b;\n');
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every((c) => c.id === 'gpt' && c.opts.isolated && c.opts.settings.effort === 'medium'));
  assert.equal(h.session.changes[0].before, 'export const sum = (a, b) => a - b;\n');
  h.bench.restore(h.session.id, h.session.changes[0].id);
  assert.equal(fs.readFileSync(file, 'utf8'), 'export const sum = (a, b) => a - b;\n');
  h.bench.restore(h.session.id, h.session.changes[1].id);
  assert.equal(fs.existsSync(path.join(h.projectPath, 'test/sum.test.mjs')), false);
});

test('sessions, settings and history persist independently from each other', async (t) => {
  const h = fixture(t);
  const second = h.bench.createSession(h.project.id);
  h.bench.configure(h.session.id, { mode: 'collaborate', lead: 'claude', models: { gpt: { model: 'custom-gpt', effort: 'high' } } });
  h.bench.message(h.session, 'user', '이 세션만의 요청');
  const reloaded = new Workbench(h.args);
  assert.equal(reloaded.session(h.session.id).models.gpt.model, 'custom-gpt');
  assert.equal(reloaded.session(second.id).models.gpt.model, 'gpt-6.1-sol');
  assert.equal(reloaded.session(second.id).models.claude.model, 'claude-opus-5-5');
  assert.equal(reloaded.session(second.id).models.gemini.model, 'gemini-test');
  assert.equal(reloaded.session(second.id).messages.length, 0);
  assert.equal(reloaded.session(h.session.id).messages[0].text, '이 세션만의 요청');
  h.session.status = 'waiting'; h.session.pending = { command: 'node' }; h.bench.save();
  const recovered = new Workbench(h.args);
  assert.equal(recovered.session(h.session.id).status, 'interrupted');
  assert.equal(recovered.session(h.session.id).pending, null);
});

test('file scope rejects traversal, secrets, links, unread edits and external changes', async (t) => {
  const h = fixture(t), reads = new Map();
  for (const value of ['../outside', '/tmp/outside', '.git/config', '.GIT/config', '.env', 'x.key', 'src/../file', 'C:/outside', 'dir\\file', 'file.', 'NUL']) {
    assert.throws(() => h.bench.safe(h.project, value));
  }
  assert.throws(() => h.bench.addProject(path.parse(h.projectPath).root));
  assert.throws(() => h.bench.addProject(os.homedir()));
});

test('junctions, hardlinks and stale edits cannot escape or overwrite changes', async (t) => {
  const h = fixture(t), reads = new Map();
  const outside = path.join(h.base, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(h.projectPath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => h.bench.safe(h.project, 'linked/file'));
  const file = path.join(h.projectPath, 'file.txt'); fs.writeFileSync(file, 'before');
  fs.linkSync(file, path.join(outside, 'hard'));
  assert.throws(() => h.bench.read(h.project, { path: 'file.txt' }, reads));
  fs.unlinkSync(path.join(outside, 'hard'));
  assert.throws(() => h.bench.edit(h.session, h.project, { action: 'patch', path: 'file.txt', find: 'before', replace: 'after' }, reads, null));
  h.bench.read(h.project, { path: 'file.txt' }, reads);
  fs.writeFileSync(file, 'user edit');
  assert.throws(() => h.bench.edit(h.session, h.project, { action: 'patch', path: 'file.txt', find: 'before', replace: 'after' }, reads, null));
  assert.equal(fs.readFileSync(file, 'utf8'), 'user edit');
  assert.throws(() => h.bench.edit(h.session, h.project, { action: 'write', path: 'file.txt', content: 'overwrite' }, reads, null));
});

test('commands execute only after exact approval and record real exit/output', { timeout: 10000 }, async (t) => {
  const h = fixture(t, { gpt: [
    { action: 'command', command: process.execPath, args: ['sum-check.mjs'], reason: '프로젝트 테스트 실행' },
    { action: 'done', text: '실제 검사 결과를 확인했습니다.' },
  ] });
  fs.writeFileSync(path.join(h.projectPath, 'sum-check.mjs'), "import assert from 'node:assert/strict'; assert.equal(2 + 3, 5); process.stdout.write('sum verified');");
  const executed = [];
  h.bench.runner = async (...args) => { executed.push(args); return run(...args); };
  h.bench.start(h.session.id, '검사해줘');
  const done = h.bench.jobs.get(h.session.id).done;
  await h.waitFor(() => h.session.pending);
  assert.equal(executed.length, 0);
  assert.throws(() => h.bench.approve(h.session.id, 'stale', true));
  h.bench.approve(h.session.id, h.session.pending.id, true);
  await done;
  assert.equal(executed.length, 1);
  assert.equal(executed[0][2].cwd, h.projectPath);
  const result = h.session.messages.find((m) => m.phase === '명령 결과');
  assert.equal(JSON.parse(result.text).code, 0);
  assert.match(JSON.parse(result.text).stdout, /sum/);
});

test('refused commands stop without retry; cancellation drops late model writes', { timeout: 10000 }, async (t) => {
  const h = fixture(t, { gpt: [{ action: 'command', command: 'node', args: ['--version'] }] });
  let executed = 0; h.bench.runner = async () => { executed++; };
  h.bench.start(h.session.id, '확인');
  const done = h.bench.jobs.get(h.session.id).done;
  await h.waitFor(() => h.session.pending);
  h.bench.approve(h.session.id, h.session.pending.id, false);
  await done;
  assert.equal(executed, 0); assert.equal(h.calls.length, 1); assert.equal(h.session.status, 'declined');
  h.adapter.chat = async (_id, _brief, _prompt, opts) => {
    await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }));
    return { ok: true, text: JSON.stringify({ action: 'write', path: 'late.txt', content: 'late' }) };
  };
  h.bench.start(h.session.id, '다음 요청');
  const second = h.bench.createSession(h.project.id);
  assert.throws(() => h.bench.start(second.id, '중복 요청'), /같은 프로젝트/);
  assert.throws(() => h.bench.configure(h.session.id, { mode: 'divide' }), /진행 중/);
  await h.bench.cancel(h.session.id);
  assert.equal(fs.existsSync(path.join(h.projectPath, 'late.txt')), false);
  assert.equal(h.session.status, 'interrupted');
});

const plan = { action: 'plan', text: '파일별 분담', tasks: WORK_IDS.map((id) => ({ id, task: `${id} 파일 생성`, files: [`${id}.txt`] })) };
test('division assigns distinct files and integrates actual results', async (t) => {
  const queues = Object.fromEntries(WORK_IDS.map((id) => [id, [
    { action: 'write', path: `${id}.txt`, content: id }, { action: 'done', text: `${id} 담당 완료` },
  ]]));
  queues.gpt.unshift(plan); queues.gpt.push({ action: 'done', text: '세 담당 파일 확인. 실행 검사는 하지 않음.' });
  const h = fixture(t, queues);
  h.bench.configure(h.session.id, { mode: 'divide' }); await h.start();
  assert.equal(h.session.status, 'done');
  for (const id of WORK_IDS) assert.equal(fs.readFileSync(path.join(h.projectPath, `${id}.txt`), 'utf8'), id);
  assert.equal(h.session.changes.length, 3);
  assert.ok(h.session.messages.some((m) => m.phase === '종합 확인'));
  assert.throws(() => h.bench.plan({ project: h.project }, { tasks: [
    { id: 'gpt', task: 'a', files: ['shared.js'] }, { id: 'gemini', task: 'b', files: ['shared.js'] },
  ] }, ['gpt', 'gemini']), /같은 파일/);
  assert.throws(() => h.bench.edit(h.session, h.project, { action: 'write', path: 'other.txt', content: 'bad' }, new Map(), ['owned.txt']));
});

test('collaboration reaches real agreement before writing; disagreement pauses without edits', async (t) => {
  for (const agree of [true, false]) {
    const queues = Object.fromEntries(WORK_IDS.map((id) => [id, [
      { action: 'opinion', agree: false, text: `${id}의 독립 의견` },
      { action: 'opinion', agree: id !== 'claude' || agree, text: agree ? '합의' : '중요한 이견' },
      { action: 'write', path: `${id}.txt`, content: id }, { action: 'done', text: '담당 완료' },
    ]]));
    queues.gpt.splice(1, 0, plan); queues.gpt.push({ action: 'done', text: '종합 확인' });
    const h = fixture(t, queues);
    h.bench.configure(h.session.id, { mode: 'collaborate' }); await h.start();
    assert.equal(h.session.status, agree ? 'done' : 'needs_input');
    assert.equal(h.session.changes.length, agree ? 3 : 0);
    assert.equal(h.session.messages.filter((m) => m.phase === '의견').length, 3);
    if (!agree) assert.ok(WORK_IDS.every((id) => !fs.existsSync(path.join(h.projectPath, `${id}.txt`))));
  }
});

test('context reports actual input characters and omissions without invented token counts', async (t) => {
  const h = fixture(t, { gpt: [{ action: 'done', text: '확인' }] });
  for (let i = 0; i < 50; i++) h.bench.message(h.session, 'user', `이전 메시지 ${i} ${'가'.repeat(1000)}`);
  await h.start('짧은 새 요청');
  const context = h.session.context.gpt;
  assert.equal(context.tokens, null);
  assert.ok(context.omitted > 0);
  assert.equal(context.chars, h.calls[0].brief.length + h.calls[0].prompt.length);
  assert.ok(context.chars < 26000);
  assert.ok(h.session.messages.length >= 52);
});

test('workbench HTTP routes preserve chat settings and enforce same-origin access', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-http-'));
  const project = path.join(base, 'project'); fs.mkdirSync(project);
  const adapter = { available: () => ({ gpt: true, claude: true, gemini: true }), chat: async () => ({ ok: true, text: '{"action":"done","text":"완료"}' }) };
  const app = createAssistantServer({ root: path.join(base, 'app'), cfg: loadConfig(), adapter, greetings: false });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, body, origin) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const before = structuredClone(app.view().room.models);
  assert.equal((await post('/api/workbench/project', { path: project }, 'https://evil.example')).status, 403);
  const p = await post('/api/workbench/project', { path: project });
  const s = await post('/api/workbench/session', { projectId: p.value.id });
  assert.equal(s.value.models.gpt.model, 'gpt-6.1-sol');
  assert.equal(s.value.models.claude.model, 'claude-opus-5-5');
  assert.deepEqual(s.value.models.gemini, before.gemini);
  await post('/api/workbench/settings', { id: s.value.id, models: { gpt: { model: 'custom', effort: 'high' } } });
  assert.deepEqual(app.view().room.models, before);
  await post('/api/workbench/send', { id: s.value.id, text: '작업대 요청' });
  await app.workbench.jobs.get(s.value.id)?.done;
  assert.equal(app.store.messages.length, 0);
  assert.equal((await fetch(url + '/workbench.js')).status, 200);
  assert.equal((await fetch(url + '/workbench.css')).status, 200);
});
