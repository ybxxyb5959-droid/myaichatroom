import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { roomFixture } from './helpers/room.mjs';
import { buildOps, lineDiff } from '../lib/task-changes.mjs';
import { validateChanges } from '../lib/task-ai.mjs';

const json = JSON.stringify;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const FILES = { 'src/a.js': 'export const a = 1;\n', 'old.txt': '옛 파일\n', 'tmp/trash.log': '지워도 되는 로그\n', 'README.md': '# 안내\n' };

const answer = (ops) => json({ action: 'answer', changes: { version: 1, title: '정리 작업', summary: '파일을 정리합니다', ops } });
const defaultOps = () => [
  { type: 'create', path: 'docs/guide.md', content: '# 새 안내서\n내용\n', reason: '문서 추가' },
  { type: 'modify', path: 'src/a.js', content: 'export const a = 2;\n', reason: '값 수정' },
  { type: 'rename', path: 'old.txt', to: 'archive/old.txt', reason: '보관 폴더로 이동' },
  { type: 'delete', path: 'tmp/trash.log', reason: '불필요한 로그' },
];

async function fixture(t, { ops = defaultOps } = {}) {
  let dir, turn = 0;
  const provider = { available: () => true, prepare: async () => 'test',
    analyze: async () => { turn++; return turn === 1 ? json({ action: 'list', path: 'tmp' }) : turn === 2 ? json({ action: 'read', paths: ['src/a.js', 'README.md'] }) : answer(typeof ops === 'function' ? ops() : ops); } };
  const room = await roomFixture(t, { taskProvider: provider, folderPicker: async () => dir });
  dir = path.join(room.root, 'proj');
  for (const [file, text] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); }
  const post = async (url, body, status = 200) => {
    const response = await fetch(room.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: room.base }, body: json(body) });
    const value = await response.json(); assert.equal(response.status, status, json(value)); return value;
  };
  const state = await post('/api/tasks', { action: 'project.createLinked', name: '변경' });
  const ids = { projectId: state.selectedProjectId, sessionId: state.selectedSessionId };
  const get = async () => (await fetch(room.base + '/api/tasks/ai')).json();
  const wait = async () => { const end = Date.now() + 8000; while (Date.now() < end) { const v = await get(); if (!v.running) return v; await delay(10); } assert.fail('timeout'); };
  const propose = async () => {
    turn = 0;
    const s = (await get()).state.projects[0].sessions[0];
    const saved = await post('/api/tasks', { action: 'draft.save', ...ids, revision: s.revision, text: '프로젝트를 정리해줘' });
    await post('/api/tasks/ai', { action: 'start', ...ids, mode: 'changes', provider: 'claude', consent: true, files: [], revision: saved.projects[0].sessions[0].revision }, 202);
    return wait();
  };
  const changes = (body, status = 200) => post('/api/tasks/changes', { ...ids, ...body }, status);
  const snapshot = () => {
    const out = {};
    const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) { out[`${r}/`] = null; walk(path.join(d, e.name), r); } else out[r] = fs.readFileSync(path.join(d, e.name), 'utf8'); } };
    walk(dir); return out;
  };
  const applyFlow = async (setId, kind = 'apply') => {
    const prepared = await changes({ action: `${kind}.prepare`, setId });
    return changes({ action: kind, setId, confirmId: prepared.confirmation.confirmId });
  };
  return { room, dir, ids, post, get, wait, propose, changes, snapshot, applyFlow, read: (p) => fs.readFileSync(path.join(dir, p), 'utf8'), exists: (p) => fs.existsSync(path.join(dir, p)) };
}

test('AI proposes create/modify/rename/delete; nothing changes until approval and a final confirmation; restore returns everything', async (t) => {
  const f = await fixture(t);
  const original = f.snapshot();
  const view = await f.propose();
  assert.equal(view.changes.length, 1);
  const set = view.changes[0];
  assert.equal(set.status, 'pending');
  assert.deepEqual(set.ops.map((o) => o.type), ['create', 'modify', 'rename', 'delete']);
  assert.deepEqual(f.snapshot(), original, 'proposal alone never touches the project');
  const entry = view.state.projects[0].sessions[0];
  assert.equal(entry.messages.at(-1).changeId, set.id);

  await f.changes({ action: 'apply.prepare', setId: set.id }, 409);
  await f.changes({ action: 'decide', setId: set.id, decision: 'approved' });
  const forged = await f.changes({ action: 'apply', setId: set.id, confirmId: '00000000-0000-4000-8000-000000000000' }, 409);
  assert.match(forged.error, /최종 확인/);
  assert.deepEqual(f.snapshot(), original, 'approval alone changes nothing');

  const done = await f.applyFlow(set.id);
  assert.equal(done.status, 'applied');
  assert.equal(f.read('docs/guide.md'), '# 새 안내서\n내용\n');
  assert.equal(f.read('src/a.js'), 'export const a = 2;\n');
  assert.equal(f.read('archive/old.txt'), FILES['old.txt']);
  assert.equal(f.exists('old.txt'), false);
  assert.equal(f.exists('tmp/trash.log'), false);
  assert.ok(fs.existsSync(path.join(f.room.root, 'data', 'task-changes', set.id)), 'deleted original stays in backups');
  assert.ok(!fs.readdirSync(f.dir).some((n) => n.endsWith('.tmp')));

  // replay of the same confirmation never writes twice
  const prepared = await f.changes({ action: 'restore.prepare', setId: set.id });
  const restored = await f.changes({ action: 'restore', setId: set.id, confirmId: prepared.confirmation.confirmId });
  assert.equal(restored.status, 'restored');
  const replay = await f.changes({ action: 'restore', setId: set.id, confirmId: prepared.confirmation.confirmId });
  assert.equal(replay.replayed, true);
  assert.deepEqual(f.snapshot(), original, 'create removed with its folder, rename moved back, delete recovered, modify reverted');
});

test('plans survive a restart and backups restore a deleted file byte for byte', async (t) => {
  const f = await fixture(t, { ops: () => [{ type: 'delete', path: 'tmp/trash.log', reason: '삭제' }] });
  const set = (await f.propose()).changes[0];
  await f.changes({ action: 'decide', setId: set.id, decision: 'approved' });
  await f.applyFlow(set.id);
  assert.equal(f.exists('tmp/trash.log'), false);
  await f.room.reopen();
  const after = (await f.get()).changes[0];
  assert.equal(after.status, 'applied');
  await f.applyFlow(set.id, 'restore');
  assert.equal(f.read('tmp/trash.log'), FILES['tmp/trash.log']);
});

test('a file changed after the proposal makes it a conflict and blocks approval and application', async (t) => {
  const f = await fixture(t);
  const set = (await f.propose()).changes[0];
  fs.writeFileSync(path.join(f.dir, 'src/a.js'), '외부에서 수정\n');
  const checked = await f.changes({ action: 'get', setId: set.id });
  assert.equal(checked.status, 'conflict');
  assert.match(checked.conflictReason, /src\/a\.js/);
  await f.changes({ action: 'decide', setId: set.id, decision: 'approved' }, 409);
  assert.equal(f.read('src/a.js'), '외부에서 수정\n');
  assert.equal(f.exists('docs/guide.md'), false);
  // a created path that appeared meanwhile is a conflict too
  fs.writeFileSync(path.join(f.dir, 'src/a.js'), FILES['src/a.js']);
  assert.equal((await f.changes({ action: 'get', setId: set.id })).status, 'pending');
  fs.mkdirSync(path.join(f.dir, 'docs')); fs.writeFileSync(path.join(f.dir, 'docs/guide.md'), '이미 있음');
  assert.equal((await f.changes({ action: 'get', setId: set.id })).status, 'conflict');
});

test('a failure in the middle rolls back what was applied; a failed rollback is partial and can be restored later', async (t) => {
  const f = await fixture(t);
  const original = f.snapshot();
  const set = (await f.propose()).changes[0];
  await f.changes({ action: 'decide', setId: set.id, decision: 'approved' });
  const store = f.room.app.taskAI.changes;
  store.faultHook = (stage, index) => { if (stage === 'apply' && index === 2) throw Object.assign(new Error('디스크 오류(테스트)'), { code: 'EIO' }); };
  const prepared = await f.changes({ action: 'apply.prepare', setId: set.id });
  const failed = await f.changes({ action: 'apply', setId: set.id, confirmId: prepared.confirmation.confirmId }, 500);
  assert.match(failed.error, /디스크 오류/);
  assert.deepEqual(f.snapshot(), original, 'the two applied operations were rolled back');
  const viewed = (await f.get()).changes[0];
  assert.equal(viewed.status, 'apply_failed');
  assert.deepEqual(viewed.ops.map((o) => o.state), ['reverted', 'reverted', 'failed', 'backed_up']);

  // second attempt: the rollback itself fails -> partial, backups kept
  store.faultHook = (stage, index) => {
    if (stage === 'apply' && index === 3) throw new Error('다시 실패(테스트)');
    if (stage === 'revert' && index === 1) throw new Error('복구 실패(테스트)');
  };
  const again = await f.changes({ action: 'apply.prepare', setId: set.id });
  await f.changes({ action: 'apply', setId: set.id, confirmId: again.confirmation.confirmId }, 500);
  const partial = (await f.get()).changes[0];
  assert.equal(partial.status, 'partial');
  assert.equal(f.read('src/a.js'), 'export const a = 2;\n', 'the file whose rollback failed is still in the applied state');
  await f.post('/api/tasks', { action: 'folder.disconnect', ...f.ids }, 409);
  store.faultHook = null;
  const restored = await f.applyFlow(set.id, 'restore');
  assert.equal(restored.status, 'restored');
  assert.deepEqual(f.snapshot(), original);
});

test('restore refuses when a file changed after the apply, and touches nothing', async (t) => {
  const f = await fixture(t);
  const set = (await f.propose()).changes[0];
  await f.changes({ action: 'decide', setId: set.id, decision: 'approved' });
  await f.applyFlow(set.id);
  fs.writeFileSync(path.join(f.dir, 'src/a.js'), '적용 이후 사용자가 직접 수정\n');
  const before = f.snapshot();
  const blocked = await f.changes({ action: 'restore.prepare', setId: set.id }, 409);
  assert.match(blocked.error, /차단/);
  assert.deepEqual(f.snapshot(), before);
});

test('restart in the middle of an apply is judged from the bytes on disk and never writes project files', async (t) => {
  const f = await fixture(t);
  const set = (await f.propose()).changes[0];
  await f.changes({ action: 'decide', setId: set.id, decision: 'approved' });
  const store = f.room.app.taskAI.changes;
  store.faultHook = (stage, index) => { if (stage === 'apply' && index === 2) throw new Error('중단'); if (stage === 'revert') throw new Error('복구 불가(테스트)'); };
  const prepared = await f.changes({ action: 'apply.prepare', setId: set.id });
  await f.changes({ action: 'apply', setId: set.id, confirmId: prepared.confirmation.confirmId }, 500);
  const afterCrash = f.snapshot();
  // pretend the process died while "applying"
  const file = path.join(f.room.root, 'data', 'task-changes.json');
  await f.room.app.close();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.sets[0].status = 'applying';
  fs.writeFileSync(file, json(data));
  await f.room.reopen();
  const recovered = (await f.get()).changes[0];
  assert.equal(recovered.status, 'partial');
  assert.match(recovered.batch.message, /재시작/);
  assert.deepEqual(f.snapshot(), afterCrash, 'recovery does not change project files');
  const restored = await f.applyFlow(set.id, 'restore');
  assert.equal(restored.status, 'restored');
  assert.equal(f.exists('docs/guide.md'), false);
});

test('path policy: outside, absolute, links, private, executables, existing names, duplicates and unread files are refused', async (t) => {
  const f = await fixture(t);
  const root = f.dir;
  const build = (...ops) => buildOps(root, ops);
  const bad = (op, pattern) => assert.throws(() => build(op), pattern);
  bad({ type: 'create', path: '../outside.txt', content: 'x' }, /허용하지 않는|상대경로/);
  bad({ type: 'create', path: 'C:/Windows/x.txt', content: 'x' }, /상대경로/);
  bad({ type: 'create', path: '.env', content: 'x' }, /민감/);
  bad({ type: 'create', path: 'config/secrets.json', content: 'x' }, /민감/);
  bad({ type: 'create', path: 'run.bat', content: 'x' }, /실행·설치/);
  bad({ type: 'create', path: 'tool.ps1', content: 'x' }, /실행·설치/);
  bad({ type: 'create', path: 'node_modules/x.js', content: 'x' }, /제외/);
  bad({ type: 'create', path: 'src/a.js', content: 'x' }, /이미 있어/);
  bad({ type: 'create', path: 'con.txt', content: 'x' }, /허용하지 않는/);
  bad({ type: 'create', path: 'bin.dat', content: 'x' }, /지원하는/);
  bad({ type: 'modify', path: 'src/missing.js', content: 'x' }, /찾을 수 없/);
  bad({ type: 'modify', path: 'src/a.js', content: 'export const a = 1;\n' }, /변경이 없습니다/);
  bad({ type: 'rename', path: 'old.txt', to: 'src/a.js' }, /이미 있습니다/);
  bad({ type: 'rename', path: 'old.txt', to: 'x/y.exe' }, /실행·설치/);
  bad({ type: 'delete', path: 'tmp' }, /찾을 수 없/);
  bad({ type: 'create', path: 'big.txt', content: 'x'.repeat(600 * 1024) }, /너무 큽니다/);
  bad({ type: 'create', path: 'nul.txt', content: '\u0000' }, /허용하지 않는|올바르지 않은/);
  assert.throws(() => build({ type: 'create', path: 'A.md', content: 'x' }, { type: 'create', path: 'a.md', content: 'y' }), process.platform === 'win32' ? /같은 경로/ : /./);
  assert.throws(() => build({ type: 'delete', path: 'old.txt' }, { type: 'rename', path: 'old.txt', to: 'z.txt' }), /같은 경로/);
  assert.throws(() => buildOps(root, Array.from({ length: 21 }, (_, i) => ({ type: 'create', path: `n${i}.txt`, content: 'x' }))), /최대 20개/);
  if (process.platform === 'win32' || true) {
    const outside = path.join(f.room.root, 'outside'); fs.mkdirSync(outside);
    try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); bad({ type: 'create', path: 'link/x.txt', content: 'x' }, /링크|허용|연결 지점/); } catch (error) { if (!['EPERM', 'EEXIST'].includes(error.code)) throw error; }
  }
  // model-level validation: modify only what was read, delete/rename only what was listed, strict keys
  const reads = new Map([['src/a.js', FILES['src/a.js']]]), hashes = new Map([['src/a.js', sha(FILES['src/a.js'])]]), listed = new Set(['old.txt', 'tmp/trash.log']);
  const ctx = { reads, hashes, listed };
  const check = (ops, pattern) => assert.throws(() => validateChanges({ version: 1, title: 't', summary: 's', ops }, ctx, root), pattern);
  check([{ type: 'modify', path: 'old.txt', content: 'x' }], /읽지 않은/);
  check([{ type: 'delete', path: 'README.md' }], /폴더 조회에 나오지 않은/);
  check([{ type: 'create', path: 'n.txt', content: 'x', extra: 1 }], /항목이 올바르지/);
  check([{ type: 'create', path: 'n.txt' }], /항목이 올바르지/);
  check([{ type: 'rename', path: 'old.txt' }], /항목이 올바르지/);
  check([{ type: 'chmod', path: 'old.txt' }], /지원하지 않는/);
  fs.writeFileSync(path.join(root, 'src/a.js'), '읽은 뒤 바뀜\n');
  check([{ type: 'modify', path: 'src/a.js', content: 'new\n' }], /읽은 뒤 파일이 변경/);
  assert.throws(() => validateChanges({ version: 1, title: 't', summary: 's', ops: [], x: 1 }, ctx, root), /형식/);
});

test('line diff is exact and bounded', () => {
  const diff = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.deepEqual([diff.added, diff.removed], [2, 1]);
  assert.deepEqual(diff.rows.map((r) => r.kind), ['same', 'removed', 'added', 'same', 'added']);
  assert.equal(lineDiff('x\n'.repeat(2500), 'y\n').tooLarge, true);
});

test('requests cannot choose paths or contents; other sessions cannot reach a change set', async (t) => {
  const f = await fixture(t);
  const set = (await f.propose()).changes[0];
  for (const extra of [{ path: 'x' }, { to: 'x' }, { content: 'x' }, { ops: [] }, { folderPath: 'C:/' }]) {
    await f.changes({ action: 'decide', setId: set.id, decision: 'approved', ...extra }, 400);
  }
  const second = await f.post('/api/tasks', { action: 'session.create', projectId: f.ids.projectId });
  await f.post('/api/tasks/changes', { action: 'get', projectId: f.ids.projectId, sessionId: second.selectedSessionId, setId: set.id }, 404);
  // external (non-origin) POST is refused
  const response = await fetch(f.room.base + '/api/tasks/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ action: 'get', ...f.ids, setId: set.id }) });
  assert.equal(response.status, 403);
});
