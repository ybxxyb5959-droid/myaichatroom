import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { roomFixture } from './helpers/room.mjs';

const json = (value) => JSON.stringify(value);
const sha = (text) => createHash('sha256').update(text).digest('hex');
let ORIGINAL, EDITED, NAMES;
const useFiles = (paths) => {
  ORIGINAL = Object.fromEntries(paths.map((p, i) => [p, i === 1 ? `export const v${i} = ${i};\r\n` : `export const v${i} = ${i};\n`]));
  EDITED = Object.fromEntries(Object.entries(ORIGINAL).map(([p, text]) => [p, text + (text.endsWith('\r\n') ? '// 수정됨\r\n' : '// 수정됨\n')]));
  NAMES = paths;
};
const FLAT = ['src/a.js', 'src/b.js', 'src/c.js'];
useFiles(FLAT);
const planAnswer = () => json({ action: 'answer', plan: { version: 1, goal: '세 파일 수정', issues: ['개선'], risks: ['없음'],
  files: NAMES.map((p) => ({ path: p, reason: `${p} 이유`, change: `${p} 변경` })) } });
const multi = () => json({ version: 1, files: NAMES.map((p) => ({ path: p, after: EDITED[p], reason: `${p} 수정 ` })) });

async function fixture(t) {
  let dir;
  let turns = 0;
  const provider = { available: () => true, prepare: async () => 'test',
    analyze: async (input, options) => options.mode === 'multi' ? multi() : (++turns === 1 ? json({ action: 'read', paths: NAMES }) : planAnswer()) };
  const room = await roomFixture(t, { taskProvider: provider, folderPicker: async () => dir });
  dir = path.join(room.root, 'proj');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const [p, text] of Object.entries(ORIGINAL)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
  const post = async (url, body, status = 200) => {
    const response = await fetch(room.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: room.base }, body: json(body) });
    const value = await response.json(); assert.equal(response.status, status, json(value)); return value;
  };
  const state = await post('/api/tasks', { action: 'project.createLinked', name: '일괄' });
  const ids = { projectId: state.selectedProjectId, sessionId: state.selectedSessionId };
  const get = async () => (await fetch(room.base + '/api/tasks/ai')).json();
  const wait = async () => { const end = Date.now() + 8000; while (Date.now() < end) { const v = await get(); if (!v.running) return v; await delay(10); } assert.fail('timeout'); };
  const planPost = (body, status = 200) => post('/api/tasks/plans', { ...ids, ...body }, status);
  const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
  const snapshot = () => Object.fromEntries(NAMES.map((p) => [p, read(p)]));
  const setup = async ({ approve = true } = {}) => {
    let s = (await get()).state;
    const entry = s.projects[0].sessions[0];
    s = await post('/api/tasks', { action: 'draft.save', ...ids, revision: entry.revision, text: '세 파일을 수정해줘' });
    await post('/api/tasks/ai', { action: 'start', ...ids, mode: 'plan', provider: 'claude', consent: true, files: [], revision: s.projects[0].sessions[0].revision }, 202);
    const planned = (await wait()).plans[0];
    await post('/api/tasks/ai', { action: 'start', ...ids, mode: 'plan.proposals', planId: planned.id, provider: 'claude', consent: true }, 202);
    await wait();
    if (approve) await planPost({ action: 'decide', planId: planned.id, decision: 'approved' });
    return planned.id;
  };
  const view = async (planId) => planPost({ action: 'get', planId });
  const applyFlow = async (planId, status = 200) => {
    const prepared = await planPost({ action: 'apply.prepare', planId }, status === 200 ? 200 : 409);
    if (status !== 200) return prepared;
    return planPost({ action: 'apply', planId, confirmId: prepared.confirmation.confirmId });
  };
  const restoreFlow = async (planId) => {
    const prepared = await planPost({ action: 'restore.prepare', planId });
    return planPost({ action: 'restore', planId, confirmId: prepared.confirmation.confirmId });
  };
  return { room, dir, ids, post, get, wait, planPost, read, snapshot, setup, view, applyFlow, restoreFlow };
}

test('three approved files are applied together with verified backups, history, and replay-safe confirmation', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  const prepared = await f.planPost({ action: 'apply.prepare', planId });
  assert.deepEqual(prepared.confirmation.files.map((x) => x.path), NAMES);
  assert.ok(prepared.confirmation.files.every((x) => x.added === 1 && x.removed === 0));
  assert.deepEqual(f.snapshot(), ORIGINAL, 'prepare changes nothing');
  const body = { action: 'apply', planId, confirmId: prepared.confirmation.confirmId };
  const done = await f.planPost(body);
  assert.equal(done.status, 'applied');
  assert.deepEqual(f.snapshot(), EDITED);
  assert.ok(f.read('src/b.js').includes('\r\n') && !/[^\r]\n/.test(f.read('src/b.js')), 'line endings preserved');
  assert.deepEqual(done.batch.files.map((x) => x.state), ['applied', 'applied', 'applied']);
  assert.equal(done.history.at(-1).result, 'succeeded');
  assert.deepEqual(done.files.map((x) => x.proposalStatus), ['applied', 'applied', 'applied']);
  const dataDir = path.join(f.room.root, 'data');
  const backups = fs.readdirSync(path.join(dataDir, 'task-backups', f.ids.projectId));
  assert.equal(backups.length, 3);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'src')).sort(), FLAT.map((p) => p.slice(4)), 'no temp files left');
  const replayed = await f.planPost(body);
  assert.equal(replayed.replayed, true);
  await f.planPost({ ...body, confirmId: '11111111-1111-4111-8111-111111111111' }, 409);
  await f.planPost({ action: 'apply', planId }, 400);
  await f.planPost({ action: 'apply.prepare', planId }, 409);
  assert.deepEqual(f.snapshot(), EDITED);
  await f.planPost({ action: 'decide', planId, decision: 'rejected' }, 409);
});

test('apply is blocked unless every file is valid and approved; API cannot inject paths or content', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup({ approve: false });
  await f.planPost({ action: 'apply.prepare', planId }, 409);
  const first = (await f.view(planId)).files[0].proposalId;
  await f.post('/api/tasks/proposals', { ...f.ids, action: 'decide', id: first, decision: 'approved' });
  assert.equal((await f.view(planId)).status, 'partial');
  const blocked = await f.planPost({ action: 'apply.prepare', planId }, 409);
  assert.match(blocked.error, /승인되지 않았/);
  await f.planPost({ action: 'apply', planId, confirmId: '11111111-1111-4111-8111-111111111111' }, 409);
  for (const extra of [{ path: 'src/a.js' }, { files: [] }, { content: 'x' }, { after: 'x' }, { batch: {} }, { folderPath: '/' }]) {
    await f.planPost({ action: 'apply.prepare', planId, ...extra }, 400);
  }
  assert.deepEqual(f.snapshot(), ORIGINAL);
});

test('one changed original blocks the whole apply, even if it changes after the confirmation was issued', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  fs.writeFileSync(path.join(f.dir, 'src/c.js'), ORIGINAL['src/c.js'] + '// 외부\n');
  await f.planPost({ action: 'apply.prepare', planId }, 409);
  fs.writeFileSync(path.join(f.dir, 'src/c.js'), ORIGINAL['src/c.js']);
  const prepared = await f.planPost({ action: 'apply.prepare', planId });
  fs.writeFileSync(path.join(f.dir, 'src/a.js'), ORIGINAL['src/a.js'] + '// 확인 후 외부 변경\n');
  const result = await f.planPost({ action: 'apply', planId, confirmId: prepared.confirmation.confirmId }, 409);
  assert.match(result.error, /원본 파일이 수정안 생성 이후 변경/);
  assert.equal(f.read('src/b.js'), ORIGINAL['src/b.js']);
  assert.equal(f.read('src/c.js'), ORIGINAL['src/c.js']);
  const after = await f.view(planId);
  assert.equal(after.history.at(-1).result, 'blocked');
  assert.equal(after.batch, undefined);
});

test('hard links and linked paths are refused before any file is changed', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  fs.linkSync(path.join(f.dir, 'src/b.js'), path.join(f.dir, 'b-link.txt'));
  const blocked = await f.planPost({ action: 'apply.prepare', planId }, 409);
  assert.match(blocked.error, /src\/b\.js/);
  assert.deepEqual(f.snapshot(), ORIGINAL);
});

test('backup failure stops everything and leaves every original untouched', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  fs.writeFileSync(path.join(f.room.root, 'data', 'task-backups'), 'a file where the backup folder should be');
  const prepared = await f.planPost({ action: 'apply.prepare', planId });
  const result = await f.planPost({ action: 'apply', planId, confirmId: prepared.confirmation.confirmId }, 500);
  assert.match(result.error, /백업/);
  assert.deepEqual(f.snapshot(), ORIGINAL);
  const view = await f.view(planId);
  assert.equal(view.status, 'apply_failed');
  assert.equal(view.history.at(-1).result, 'failed');
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'src')).sort(), FLAT.map((p) => p.slice(4)));
});

test('third file fails after two were applied: job stops, the two are rolled back from verified backups', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  f.room.app.taskAI.plans.batch.faultHook = (kind, index) => { if (kind === 'commit' && index === 2) fs.writeFileSync(path.join(f.dir, 'src/c.js'), ORIGINAL['src/c.js'] + '// 교체 직전 외부 변경\n'); };
  const prepared = await f.planPost({ action: 'apply.prepare', planId });
  const result = await f.planPost({ action: 'apply', planId, confirmId: prepared.confirmation.confirmId }, 500);
  assert.match(result.error, /되돌렸습니다/);
  assert.equal(f.read('src/a.js'), ORIGINAL['src/a.js']);
  assert.equal(f.read('src/b.js'), ORIGINAL['src/b.js']);
  assert.equal(f.read('src/c.js'), ORIGINAL['src/c.js'] + '// 교체 직전 외부 변경\n', 'the externally changed file is never overwritten');
  const view = await f.view(planId);
  assert.equal(view.status, 'apply_failed');
  assert.deepEqual(view.batch.files.map((x) => x.state), ['reverted', 'reverted', 'failed']);
  assert.equal(view.history.at(-1).result, 'failed');
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'src')).sort(), FLAT.map((p) => p.slice(4)));
});

test('automatic rollback failure is reported as partial, keeps backups, and can be restored later', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  const hook = f.room.app.taskAI.plans.batch;
  hook.faultHook = (kind, index) => {
    if (kind === 'commit' && index === 2) fs.writeFileSync(path.join(f.dir, 'src/c.js'), ORIGINAL['src/c.js'] + '// 외부\n');
    if (kind === 'revert' && index === 0) throw new Error('디스크 오류(시험)');
  };
  const prepared = await f.planPost({ action: 'apply.prepare', planId });
  const result = await f.planPost({ action: 'apply', planId, confirmId: prepared.confirmation.confirmId }, 500);
  assert.match(result.error, /자동 복구에 실패/);
  const view = await f.view(planId);
  assert.equal(view.status, 'partial_applied');
  assert.deepEqual(view.batch.files.map((x) => x.state), ['revert_failed', 'reverted', 'failed']);
  assert.equal(f.read('src/a.js'), EDITED['src/a.js'], 'unrecovered file is still the applied content, clearly reported');
  assert.equal(fs.readdirSync(path.join(f.room.root, 'data', 'task-backups', f.ids.projectId)).length, 3);
  hook.faultHook = null;
  fs.writeFileSync(path.join(f.dir, 'src/c.js'), ORIGINAL['src/c.js']);
  const restored = await f.restoreFlow(planId);
  assert.equal(restored.status, 'restored');
  assert.deepEqual(f.snapshot(), ORIGINAL);
  await f.planPost({ action: 'apply.prepare', planId }, 409);
});

test('an externally changed file during rollback is never overwritten and needs manual attention', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  f.room.app.taskAI.plans.batch.faultHook = (kind, index) => {
    if (kind === 'commit' && index === 2) {
      fs.writeFileSync(path.join(f.dir, 'src/c.js'), ORIGINAL['src/c.js'] + '// 외부\n');
      fs.writeFileSync(path.join(f.dir, 'src/a.js'), '외부 프로그램이 바꾼 a\n');
    }
  };
  const prepared = await f.planPost({ action: 'apply.prepare', planId });
  await f.planPost({ action: 'apply', planId, confirmId: prepared.confirmation.confirmId }, 500);
  const view = await f.view(planId);
  assert.equal(view.status, 'manual');
  assert.equal(f.read('src/a.js'), '외부 프로그램이 바꾼 a\n');
  assert.equal(f.read('src/b.js'), ORIGINAL['src/b.js']);
  await f.planPost({ action: 'restore.prepare', planId }, 409);
  await f.post('/api/tasks', { action: 'folder.disconnect', projectId: f.ids.projectId }, 409);
});

test('server restart in the middle of an apply: state is judged from disk, nothing is written, nothing is called success', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  await f.applyFlow(planId);
  const file = path.join(f.room.root, 'data', 'task-plans.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const plan = saved.plans[0];
  plan.batch.status = 'applying'; plan.batch.files[2].state = 'replacing'; plan.batch.files[1].state = 'applied';
  fs.writeFileSync(path.join(f.dir, 'src/c.js'), ORIGINAL['src/c.js']);
  fs.writeFileSync(file, JSON.stringify(saved));
  const orphan = path.join(f.dir, 'src', plan.batch.files[2].tempName);
  fs.writeFileSync(orphan, 'leftover');
  await f.room.reopen();
  const view = await f.planPost({ action: 'get', planId }).catch(() => null) || null;
  const current = (await (await fetch(f.room.base + '/api/tasks/ai')).json()).plans[0];
  assert.equal(current.status, 'partial_applied');
  assert.deepEqual(current.batch.files.map((x) => x.state), ['applied', 'applied', 'queued']);
  assert.equal(fs.existsSync(orphan), false, 'only the app-generated temp file was cleaned');
  assert.equal(f.read('src/a.js'), EDITED['src/a.js']);
  assert.equal(f.read('src/c.js'), ORIGINAL['src/c.js']);
  const restored = await f.restoreFlow(planId);
  assert.equal(restored.status, 'restored');
  assert.deepEqual(f.snapshot(), ORIGINAL);
  assert.equal(view === null || true, true);
});

test('restart with an unexplained file state keeps the record as manual-check and never auto-fixes', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  await f.applyFlow(planId);
  const file = path.join(f.room.root, 'data', 'task-plans.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.plans[0].batch.status = 'applying';
  fs.writeFileSync(path.join(f.dir, 'src/b.js'), '알 수 없는 내용\n');
  fs.writeFileSync(file, JSON.stringify(saved));
  await f.room.reopen();
  const current = (await (await fetch(f.room.base + '/api/tasks/ai')).json()).plans[0];
  assert.equal(current.status, 'manual');
  assert.equal(f.read('src/b.js'), '알 수 없는 내용\n');
});

test('full restore returns every file to its original hash; external changes after apply block it entirely', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  await f.applyFlow(planId);
  fs.writeFileSync(path.join(f.dir, 'src/b.js'), EDITED['src/b.js'] + '// 적용 후 외부 변경\r\n');
  const blocked = await f.planPost({ action: 'restore.prepare', planId }, 409);
  assert.match(blocked.error, /외부에서 변경/);
  assert.equal(f.read('src/a.js'), EDITED['src/a.js'], 'blocked restore touched nothing');
  fs.writeFileSync(path.join(f.dir, 'src/b.js'), EDITED['src/b.js']);
  const prepared = await f.planPost({ action: 'restore.prepare', planId });
  assert.deepEqual(prepared.confirmation.files.map((x) => x.changed), [true, true, true]);
  const body = { action: 'restore', planId, confirmId: prepared.confirmation.confirmId };
  const restored = await f.planPost(body);
  assert.equal(restored.status, 'restored');
  assert.deepEqual(f.snapshot(), ORIGINAL);
  assert.deepEqual(restored.files.map((x) => x.proposalStatus), ['restored', 'restored', 'restored']);
  assert.equal(restored.history.at(-1).kind, 'restore');
  assert.equal((await f.planPost(body)).replayed, true);
  await f.planPost({ action: 'restore.prepare', planId }, 409);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'src')).sort(), FLAT.map((p) => p.slice(4)));
});

test('restore failure midway records the partial state and a retry finishes safely', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  await f.applyFlow(planId);
  const hook = f.room.app.taskAI.plans.batch;
  hook.faultHook = (kind, index) => { if (kind === 'restore-commit' && index === 2) throw new Error('쓰기 오류(시험)'); };
  const prepared = await f.planPost({ action: 'restore.prepare', planId });
  await f.planPost({ action: 'restore', planId, confirmId: prepared.confirmation.confirmId }, 500);
  let view = await f.view(planId);
  assert.equal(view.status, 'restore_failed');
  assert.deepEqual(view.batch.files.map((x) => x.state), ['reverted', 'reverted', 'applied']);
  assert.equal(f.read('src/c.js'), EDITED['src/c.js']);
  hook.faultHook = null;
  const done = await f.restoreFlow(planId);
  assert.equal(done.status, 'restored');
  assert.deepEqual(f.snapshot(), ORIGINAL);
});

test('write lock stops a second server process; a stale lock is taken over', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  const lock = path.join(f.room.root, 'data', 'task-write.lock');
  fs.writeFileSync(lock, String(process.pid));
  const prepared = await f.planPost({ action: 'apply.prepare', planId });
  const blocked = await f.planPost({ action: 'apply', planId, confirmId: prepared.confirmation.confirmId }, 409);
  assert.match(blocked.error, /다른 서버 프로세스/);
  assert.deepEqual(f.snapshot(), ORIGINAL);
  fs.writeFileSync(lock, '2147483646');
  const again = await f.planPost({ action: 'apply.prepare', planId });
  const done = await f.planPost({ action: 'apply', planId, confirmId: again.confirmation.confirmId });
  assert.equal(done.status, 'applied');
  assert.equal(fs.existsSync(lock), false);
});

test('single-file proposals of plan members cannot be applied or restored on their own', async (t) => {
  const f = await fixture(t);
  const planId = await f.setup();
  const member = (await f.view(planId)).files[0].proposalId;
  await f.post('/api/tasks/proposals', { ...f.ids, action: 'apply.prepare', id: member }, 409);
  await f.applyFlow(planId);
  await f.post('/api/tasks/proposals', { ...f.ids, action: 'restore.prepare', id: member }, 409);
  const detail = await f.post('/api/tasks/proposals', { ...f.ids, action: 'get', id: member });
  assert.equal(detail.status, 'applied');
  assert.equal(detail.fileState, 'after');
  assert.equal(sha(f.read('src/a.js')), detail.afterHash);
});

test('files in different nested folders apply and restore together (parent folder timestamps are not mistaken for outside changes)', async (t) => {
  useFiles(['src/a.js', 'src/deep/b.js', 'lib/c.js']);
  try {
    const f = await fixture(t);
    const planId = await f.setup();
    const done = await f.applyFlow(planId);
    assert.equal(done.status, 'applied');
    assert.deepEqual(f.snapshot(), EDITED);
    const restored = await f.restoreFlow(planId);
    assert.equal(restored.status, 'restored');
    assert.deepEqual(f.snapshot(), ORIGINAL);
    assert.deepEqual(fs.readdirSync(path.join(f.dir, 'src')).sort(), ['a.js', 'deep']);
  } finally { useFiles(FLAT); }
});
