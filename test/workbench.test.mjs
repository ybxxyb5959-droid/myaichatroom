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

test('a request becomes a task that records steps, current file, commands and its outcome', async (t) => {
  const seen = [], holder = {};
  const h = fixture(t, { gpt: [
    { action: 'read', path: 'sum.mjs' },
    { action: 'patch', path: 'sum.mjs', find: 'a - b', replace: 'a + b' },
    { action: 'command', command: 'node', args: ['--test'], reason: '검사' },
    { action: 'done', text: '수정과 검사 완료' },
  ] }, { onChange: () => { const task = holder.h?.session.tasks?.at(-1); if (task) seen.push(structuredClone(task.current)); } });
  holder.h = h;
  fs.writeFileSync(path.join(h.projectPath, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
  h.bench.configure(h.session.id, { approval: 'auto' });
  h.bench.runner = async () => { seen.push(structuredClone(h.session.tasks[0].current)); return { code: 0, stdout: 'ok', stderr: '' }; };
  await h.start('합산 버그 고쳐줘\n자세한 설명');
  const [task] = h.session.tasks;
  assert.equal(h.session.tasks.length, 1);
  assert.equal(task.title, '합산 버그 고쳐줘');
  assert.equal(task.status, 'done');
  assert.equal(task.stopReason, null);
  assert.deepEqual(task.current, { actor: null, action: null, file: null });
  assert.ok(task.endedAt >= task.startedAt);
  assert.deepEqual(task.commands.map((c) => [c.command, c.code, c.timedOut]), [[['node', '--test'], 0, false]]);
  for (const current of [{ actor: 'gpt', action: 'think', file: null }, { actor: 'gpt', action: 'read', file: 'sum.mjs' },
    { actor: 'gpt', action: 'patch', file: 'sum.mjs' }, { actor: 'gpt', action: 'command', file: null }]) assert.ok(seen.some((c) => JSON.stringify(c) === JSON.stringify(current)), JSON.stringify(current));
  assert.ok(seen.every((c) => Object.keys(c).join() === 'actor,action,file'));
  assert.ok(h.session.messages.every((m) => m.taskId === task.id));
  assert.equal(h.session.messages.find((m) => m.phase === 'read').path, 'sum.mjs');
  assert.equal(h.session.changes[0].taskId, task.id);
  assert.equal(h.bench.view().sessions[0].tasks, undefined);
});

test('task status ends as failed or interrupted with a fixed reason', async (t) => {
  const h = fixture(t, { gpt: [{ action: 'unknown' }, { action: 'ask', text: '어느 파일인가요?' }, { action: 'command', command: 'node', args: ['-v'] }] });
  await h.start('잘못된 행동');
  await h.start('질문할 요청');
  h.bench.configure(h.session.id, { approval: 'deny' });
  await h.start('명령 요청');
  h.adapter.chat = async (_id, _brief, _prompt, opts) => {
    await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }));
    return { ok: false, detail: 'cancelled' };
  };
  h.bench.start(h.session.id, '중지할 요청');
  await h.bench.cancel(h.session.id);
  assert.deepEqual(h.session.tasks.map((x) => [x.status, x.stopReason]),
    [['failed', null], ['interrupted', 'needs_input'], ['interrupted', 'declined'], ['interrupted', 'cancelled']]);
  assert.equal(h.session.tasks[2].stoppedAt, 'command');
  assert.ok(h.session.tasks.every((x) => ['running', 'done', 'interrupted', 'failed'].includes(x.status) && x.endedAt && x.current.actor === null));
});

test('older sessions without tasks still load, and running tasks stop on restart', async (t) => {
  const h = fixture(t, { gpt: [{ action: 'done', text: '완료' }] });
  delete h.session.tasks; h.bench.message(h.session, 'user', '예전 메시지'); h.bench.save();
  const legacy = new Workbench(h.args);
  assert.equal(legacy.session(h.session.id).tasks, undefined);
  assert.equal(legacy.view(h.session.id).session.messages[0].taskId, undefined);
  await h.start('새 요청');
  assert.equal(h.session.tasks.length, 1);
  assert.equal(h.session.messages[0].taskId, undefined);
  h.session.tasks[0].status = 'running'; h.session.tasks[0].endedAt = null; h.bench.save();
  const reloaded = new Workbench(h.args).session(h.session.id).tasks[0];
  assert.equal(reloaded.status, 'interrupted');
  assert.equal(reloaded.stopReason, 'restart');
  assert.deepEqual(reloaded.current, { actor: null, action: null, file: null });
});

const two = (file, steps) => steps.flatMap(([find, replace]) => [{ action: 'read', path: file }, { action: 'patch', path: file, find, replace }]);
test('views carry change metadata only; details are fetched one change at a time', async (t) => {
  const h = fixture(t, { gpt: [...two('a.txt', [['one', 'ONE'], ['two', 'TWO\nthree']]), { action: 'write', path: 'new.txt', content: 'n1\nn2\n' }, { action: 'done', text: '완료' }] });
  fs.writeFileSync(path.join(h.projectPath, 'a.txt'), 'one\ntwo\n');
  await h.start();
  const view = h.bench.view(h.session.id).session;
  assert.ok(view.changes.every((c) => !('before' in c) && !('after' in c)));
  assert.deepEqual(view.changes.map((c) => [c.path, c.kind, c.added, c.removed]), [['a.txt', 'patch', 1, 1], ['a.txt', 'patch', 2, 1], ['new.txt', 'create', 2, 0]]);
  assert.deepEqual(view.tasks[0].files.map((f) => [f.path, f.changeIds.length, f.added, f.removed, f.status]), [['a.txt', 2, 3, 2], ['new.txt', 1, 2, 0]].map((x) => [...x, 'applied']));
  assert.ok(h.session.changes[0].before, 'the saved record keeps the original text');
  const detail = h.bench.changeDetail(h.session.id, h.session.changes[1].id);
  assert.deepEqual(detail.hunks[0].rows.map((r) => r[0] + r[1]), [' ONE', '-two', '+TWO', '+three']);
  assert.throws(() => h.bench.changeDetail(h.session.id, 'missing'), /변경 기록/);
  delete h.session.changes[0].added; delete h.session.changes[0].removed; delete h.session.changes[0].taskId;
  assert.deepEqual(h.bench.view(h.session.id).session.changes[0], { id: h.session.changes[0].id, path: 'a.txt', status: 'applied', taskId: null, kind: 'patch', added: 1, removed: 1 });
});

test('reverting a task restores repeated edits newest first and reports files it must leave alone', async (t) => {
  const h = fixture(t, { gpt: [...two('a.txt', [['one', 'ONE'], ['ONE', 'uno']]), ...two('b.txt', [['b', 'B']]), { action: 'write', path: 'c.txt', content: 'new' }, { action: 'done', text: '완료' }] });
  fs.writeFileSync(path.join(h.projectPath, 'a.txt'), 'one\n'); fs.writeFileSync(path.join(h.projectPath, 'b.txt'), 'b\n');
  await h.start();
  const taskId = h.session.tasks[0].id;
  fs.writeFileSync(path.join(h.projectPath, 'b.txt'), 'user edit\n');
  const preview = h.bench.revertPreview(h.session.id, taskId);
  assert.deepEqual(preview.files.map((f) => [f.path, f.ok, f.changes.length, f.deletes]), [['a.txt', true, 2, false], ['b.txt', false, 1, false], ['c.txt', true, 1, true]]);
  assert.match(preview.files[1].reason, /이후에 파일이 바뀌어/);
  assert.equal(fs.readFileSync(path.join(h.projectPath, 'a.txt'), 'utf8'), 'uno\n', 'preview writes nothing');
  assert.throws(() => h.bench.revert(h.session.id, taskId), /가능한 파일만/);
  const { results } = h.bench.revert(h.session.id, taskId, undefined, true);
  assert.deepEqual(results.map((r) => [r.path, r.ok, r.restored]), [['a.txt', true, 2], ['b.txt', false, 0], ['c.txt', true, 1]]);
  assert.equal(fs.readFileSync(path.join(h.projectPath, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(fs.readFileSync(path.join(h.projectPath, 'b.txt'), 'utf8'), 'user edit\n');
  assert.equal(fs.existsSync(path.join(h.projectPath, 'c.txt')), false);
  assert.deepEqual(h.session.changes.map((c) => c.status), ['restored', 'restored', 'applied', 'restored']);
  assert.match(h.session.messages.at(-1).text, /2개 파일 성공, 1개 파일 실패[\s\S]*✕ b\.txt/);
  assert.throws(() => h.bench.revert(h.session.id, taskId, 'b.txt'), /되돌릴 수 있는 파일이 없어요/);
});

test('one file can be reverted alone; a broken chain or a running job is refused', async (t) => {
  const h = fixture(t, { gpt: [...two('a.txt', [['one', 'ONE'], ['ONE', 'uno']]), ...two('b.txt', [['b', 'B']]), { action: 'done', text: '완료' }] });
  fs.writeFileSync(path.join(h.projectPath, 'a.txt'), 'one\n'); fs.writeFileSync(path.join(h.projectPath, 'b.txt'), 'b\n');
  await h.start();
  const taskId = h.session.tasks[0].id;
  h.bench.restore(h.session.id, h.session.changes[1].id); // the existing single restore still works
  assert.equal(fs.readFileSync(path.join(h.projectPath, 'a.txt'), 'utf8'), 'ONE\n');
  h.bench.revert(h.session.id, taskId, 'a.txt');
  assert.equal(fs.readFileSync(path.join(h.projectPath, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(fs.readFileSync(path.join(h.projectPath, 'b.txt'), 'utf8'), 'B\n');
  assert.equal(h.bench.revertPreview(h.session.id, taskId, 'a.txt').files[0].reason, '이미 되돌렸어요.');
  h.adapter.chat = async (_id, _brief, _prompt, opts) => {
    await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }));
    return { ok: false, detail: 'cancelled' };
  };
  h.bench.start(h.session.id, '진행 중 작업');
  assert.throws(() => h.bench.revert(h.session.id, taskId, 'b.txt'), /먼저 중지/);
  assert.throws(() => h.bench.revertPreview(h.session.id, taskId), /먼저 중지/);
  await h.bench.cancel(h.session.id);
});

test('automatic approval still stops for a destructive command until the user confirms', { timeout: 10000 }, async (t) => {
  const h = fixture(t, { gpt: [
    { action: 'command', command: 'node', args: ['--test'] },
    { action: 'command', command: 'git', args: ['reset', '--hard', 'HEAD~1'], reason: '되돌리기' },
    { action: 'command', command: 'git', args: ['clean', '-fd'] },
  ] });
  const executed = [];
  h.bench.runner = async (...args) => { executed.push(args[1]); return { code: 0, stdout: '', stderr: '' }; };
  h.bench.configure(h.session.id, { approval: 'auto' });
  h.bench.start(h.session.id, '정리');
  const done = h.bench.jobs.get(h.session.id).done;
  await h.waitFor(() => h.session.pending);
  assert.deepEqual(executed, [['--test']]);
  assert.equal(h.session.pending.command, 'git');
  assert.equal(h.session.pending.risk.auto, true);
  assert.match(h.session.pending.risk.reasons[0], /작업 내용이 삭제/);
  assert.equal(h.session.tasks[0].current.action, 'approval');
  h.bench.approve(h.session.id, h.session.pending.id, true);
  await h.waitFor(() => h.session.pending?.args?.[0] === 'clean');
  assert.deepEqual(executed, [['--test'], ['reset', '--hard', 'HEAD~1']]);
  h.bench.approve(h.session.id, h.session.pending.id, false);
  await done;
  assert.deepEqual(executed.length, 2);
  assert.deepEqual([h.session.status, h.session.tasks[0].status, h.session.tasks[0].stopReason, h.session.tasks[0].stoppedAt], ['declined', 'interrupted', 'declined', 'approval']);
});

test('a save retries a briefly locked state file and still reports a lasting failure', async (t) => {
  const h = fixture(t);
  const original = fs.renameSync;
  let calls = 0;
  t.after(() => { fs.renameSync = original; });
  fs.renameSync = (...args) => { if (++calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' }); return original(...args); };
  h.bench.message(h.session, 'user', '저장 확인');
  assert.equal(calls, 3);
  assert.equal(new Workbench(h.args).session(h.session.id).messages.at(-1).text, '저장 확인');
  fs.renameSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  assert.throws(() => h.bench.save(), /denied/);
  fs.renameSync = () => { throw Object.assign(new Error('broken'), { code: 'EIO' }); };
  assert.throws(() => h.bench.save(), /broken/);
  fs.renameSync = original;
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
  assert.deepEqual([h.session.tasks[0].status, h.session.tasks[0].phase, h.session.tasks[0].participants], ['done', '종합 확인', WORK_IDS]);
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
    h.bench.configure(h.session.id, { mode: 'collaborate' });
    h.bench.start(h.session.id, '요청한 파일만 수정해줘');
    const done = h.bench.jobs.get(h.session.id).done;
    if (agree) {
      // Agreement alone no longer edits: the plan waits for the user.
      await h.waitFor(() => h.session.pending?.kind === 'plan');
      assert.equal(h.session.status, 'waiting');
      assert.ok(WORK_IDS.every((id) => !fs.existsSync(path.join(h.projectPath, `${id}.txt`))));
      assert.deepEqual(h.session.pending.tasks.map((x) => [x.id, x.files, x.role]), WORK_IDS.map((id) => [id, [`${id}.txt`], h.session.tasks[0].roles[id]]));
      assert.equal(h.session.tasks[0].current.action, 'plan_approval');
      assert.deepEqual([h.session.phase, h.session.speaker], ['계획 승인', 'gpt']);
      h.bench.approve(h.session.id, h.session.pending.id, true);
    }
    await done;
    assert.equal(h.session.status, agree ? 'done' : 'needs_input');
    assert.deepEqual(Object.keys(h.session.tasks[0].roles).sort(), [...WORK_IDS].sort());
    assert.ok(h.calls.filter((c) => /역할은 "/.test(c.prompt)).length === 3, 'each opinion call carries its role; no extra call');
    assert.deepEqual(h.session.tasks[0].working, []);
    assert.equal(h.session.changes.length, agree ? 3 : 0);
    assert.equal(h.session.messages.filter((m) => m.phase === '의견').length, 3);
    if (!agree) assert.ok(WORK_IDS.every((id) => !fs.existsSync(path.join(h.projectPath, `${id}.txt`))));
    assert.deepEqual([h.session.tasks[0].status, h.session.tasks[0].stopReason], agree ? ['done', null] : ['interrupted', 'needs_input']);
  }
});

test('a declined plan edits nothing, and after approval a risky command is still asked separately', async (t) => {
  const collab = (tail) => {
    const queues = Object.fromEntries(WORK_IDS.map((id) => [id, [{ action: 'opinion', agree: false, text: `${id} 의견` }, { action: 'opinion', agree: true, text: '합의' }, ...tail(id)]]));
    queues.gpt.splice(1, 0, plan);
    return queues;
  };
  const declined = fixture(t, collab(() => []));
  declined.bench.configure(declined.session.id, { mode: 'collaborate' });
  declined.bench.start(declined.session.id, '수정해줘');
  let done = declined.bench.jobs.get(declined.session.id).done;
  await declined.waitFor(() => declined.session.pending?.kind === 'plan');
  declined.bench.approve(declined.session.id, declined.session.pending.id, false);
  await done;
  assert.deepEqual([declined.session.status, declined.session.tasks[0].status, declined.session.tasks[0].stopReason], ['interrupted', 'interrupted', 'plan_declined']);
  assert.equal(declined.session.changes.length, 0);
  assert.ok(WORK_IDS.every((id) => !fs.existsSync(path.join(declined.projectPath, `${id}.txt`))));
  assert.deepEqual(Object.keys(declined.session.tasks[0].assignments).sort(), [...WORK_IDS].sort());

  const risky = fixture(t, collab((id) => (id === 'gpt' ? [{ action: 'command', command: 'git', args: ['reset', '--hard'] }] : [])));
  let executed = 0; risky.bench.runner = async () => { executed++; return { code: 0, stdout: '', stderr: '' }; };
  risky.bench.configure(risky.session.id, { mode: 'collaborate', approval: 'auto' });
  risky.bench.start(risky.session.id, '수정해줘');
  done = risky.bench.jobs.get(risky.session.id).done;
  await risky.waitFor(() => risky.session.pending?.kind === 'plan');
  risky.bench.approve(risky.session.id, risky.session.pending.id, true);
  await risky.waitFor(() => risky.session.pending?.risk);
  assert.equal(risky.session.pending.kind, undefined, 'the command approval is a different request from the plan approval');
  assert.equal(executed, 0);
  risky.bench.approve(risky.session.id, risky.session.pending.id, false);
  await done;
  assert.equal(executed, 0);
  assert.deepEqual([risky.session.status, risky.session.tasks[0].stopReason], ['declined', 'declined']);
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
