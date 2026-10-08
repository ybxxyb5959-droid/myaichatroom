import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../lib/task-store.mjs';
import { validateTaskFolder } from '../lib/task-folder.mjs';
import { roomFixture } from './helpers/room.mjs';

const current = (state) => state.projects.find((p) => p.id === state.selectedProjectId).sessions.find((s) => s.id === state.selectedSessionId);
const selection = (state) => ({ projectId: state.selectedProjectId, sessionId: state.selectedSessionId });
const get = async (room) => {
  const response = await fetch(room.base + '/api/tasks');
  assert.equal(response.status, 200);
  return response.json();
};
const command = async (room, body) => {
  const response = await room.post('/api/tasks', body);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};

test('projects, independent sessions, user messages, drafts and selection survive reload and restart', async (t) => {
  const room = await roomFixture(t);
  const chat = room.app.store.addMessage({ from: 'user', text: '기존 단톡방 기록' });
  room.app.store.applyFileOp({ op: 'write', path: 'keep.md', content: '기존 창작물' }, 'gpt');
  assert.equal((await get(room)).projects.length, 0);
  let state = await command(room, { action: 'project.create', name: '프로젝트 A' });
  const a1 = selection(state);
  state = await command(room, { action: 'draft.save', ...a1, revision: 0, text: '실제 사용자 요청\n두 번째 줄' });
  state = await command(room, { action: 'message.add', ...a1, revision: 1, messageId: randomUUID() });
  assert.deepEqual(current(state).messages.map((m) => [m.role, m.text]), [['user', '실제 사용자 요청\n두 번째 줄']]);
  state = await command(room, { action: 'draft.save', ...a1, revision: 2, text: 'A 첫 세션 초안' });
  state = await command(room, { action: 'session.create', projectId: a1.projectId });
  const a2 = selection(state);
  assert.notEqual(a1.sessionId, a2.sessionId);
  assert.deepEqual(current(state).messages, []);
  await command(room, { action: 'draft.save', ...a2, revision: 0, text: 'A 둘째 세션 초안' });
  state = await command(room, { action: 'project.create', name: '프로젝트 B' });
  const b1 = selection(state);
  await command(room, { action: 'draft.save', ...b1, revision: 0, text: 'B 초안' });
  await command(room, { action: 'project.rename', projectId: b1.projectId, name: 'B 이름 수정' });
  state = await command(room, { action: 'select', projectId: a1.projectId });
  assert.equal(state.selectedSessionId, a2.sessionId);
  state = await command(room, { action: 'select', ...a1 });
  assert.equal(current(state).draft, 'A 첫 세션 초안');
  assert.deepEqual(await get(room), state, 'a fresh client reload receives the same state');
  await room.reopen();
  assert.deepEqual(await get(room), state, 'server restart preserves exact stored state');
  const persisted = JSON.parse(fs.readFileSync(path.join(room.root, 'data/tasks-state.json'), 'utf8'));
  assert.equal(persisted.projects[1].name, 'B 이름 수정');
  state = await command(room, { action: 'select', ...b1 });
  assert.equal(current(state).draft, 'B 초안');
  assert.deepEqual(current(state).messages, [], 'no fake AI or execution messages');
  assert.ok(room.app.store.messages.some((m) => m.id === chat.id && m.text === chat.text));
  assert.equal(room.app.store.readFile('keep.md').text, '기존 창작물');
  assert.equal(room.calls.length, 0);
  assert.equal(room.images.length, 0);
});

test('stale drafts, cross-project sessions, forged AI messages and invalid inputs are rejected', async (t) => {
  const room = await roomFixture(t);
  let state = await command(room, { action: 'project.create', name: 'A' });
  const a = selection(state);
  state = await command(room, { action: 'draft.save', ...a, revision: 0, text: '<script>alert(1)</script>' });
  const saved = await get(room);
  assert.equal((await room.post('/api/tasks', { action: 'draft.save', ...a, revision: 0, text: '덮어쓰기' })).status, 409);
  assert.equal((await room.post('/api/tasks', { action: 'draft.save', ...a, revision: 1, text: 'x'.repeat(16001) })).status, 400);
  assert.equal((await room.post('/api/tasks', { action: 'message.add', ...a, revision: 1, role: 'assistant', messageId: randomUUID() })).status, 400);
  assert.equal((await room.post('/api/tasks', { action: 'message.add', ...a, revision: 1, messageId: a.projectId })).status, 409);
  assert.equal((await room.post('/api/tasks', { action: 'project.create', name: ' ' })).status, 400);
  assert.deepEqual(await get(room), saved);
  const messageId = randomUUID();
  state = await command(room, { action: 'message.add', ...a, revision: 1, messageId });
  assert.equal(current(state).messages[0].text, '<script>alert(1)</script>');
  state = await command(room, { action: 'message.add', ...a, revision: 1, messageId });
  assert.equal(current(state).messages.length, 1, 'lost-response retry is idempotent');
  state = await command(room, { action: 'project.create', name: 'B' });
  assert.equal((await room.post('/api/tasks', { action: 'select', projectId: state.selectedProjectId, sessionId: a.sessionId })).status, 404);
  assert.equal((await room.post('/api/tasks', { action: 'execute', ...a })).status, 400);
  const denied = await fetch(room.base + '/api/tasks', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(denied.status, 403);
  const ordinary = await (await fetch(room.base + '/api/state')).json();
  assert.ok(!JSON.stringify(ordinary).includes('<script>alert(1)</script>'));
});

test('disk failures do not acknowledge changes, and corrupt originals are preserved', async (t) => {
  const room = await roomFixture(t);
  const dir = path.join(room.root, 'data');
  const store = new TaskStore(dir);
  store.apply({ action: 'project.create', name: '보존' });
  const before = store.view();
  const file = store.file;
  store.file = path.join(dir, 'missing-parent', 'tasks-state.json');
  assert.throws(() => store.apply({ action: 'project.create', name: '저장 실패' }), /ENOENT/);
  assert.deepEqual(store.view(), before);
  store.file = file;
  fs.writeFileSync(file, '{broken');
  const recovered = new TaskStore(dir);
  assert.equal(recovered.view().projects.length, 0);
  assert.equal(recovered.warnings.length, 1);
  const backup = fs.readdirSync(dir).find((name) => name.startsWith('tasks-state.json.unreadable-'));
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), '{broken');
});

async function folderCommand(room, body, expected = 200, headers = {}) {
  const response = await fetch(room.base + '/api/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: room.base, ...headers }, body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}

test('native selections link separate projects, survive restart and preserve sessions and real files', async (t) => {
  let picked = null, picks = 0;
  const room = await roomFixture(t, { folderPicker: async () => { picks++; return picked; } });
  const folderA = path.join(room.root, '프로젝트 자료 A');
  const folderB = path.join(room.root, '다른 폴더 B');
  fs.mkdirSync(folderA); fs.mkdirSync(folderB);
  fs.writeFileSync(path.join(folderA, 'keep.txt'), '사용자 파일 보존');
  let state = await command(room, { action: 'project.create', name: '실제 폴더와 다른 이름' });
  const a = selection(state);
  await command(room, { action: 'draft.save', ...a, revision: 0, text: '연결 전 대화' });
  await command(room, { action: 'message.add', ...a, revision: 1, messageId: randomUUID() });
  state = await command(room, { action: 'draft.save', ...a, revision: 2, text: '연결 전 초안' });
  const sessions = structuredClone(state.projects[0].sessions);
  const beforeCancel = await get(room);
  state = await folderCommand(room, { action: 'folder.pick', projectId: a.projectId });
  assert.equal(state.folderSelectionCancelled, true);
  assert.deepEqual(await get(room), beforeCancel);
  picked = folderA;
  state = await folderCommand(room, { action: 'folder.pick', projectId: a.projectId });
  assert.equal(state.projects[0].folderPath, fs.realpathSync(folderA));
  assert.equal(state.projects[0].folder.state, 'connected');
  assert.equal(state.projects[0].name, '실제 폴더와 다른 이름');
  assert.deepEqual(state.projects[0].sessions, sessions);
  picked = folderB;
  state = await folderCommand(room, { action: 'project.createLinked', name: '' });
  const b = selection(state);
  assert.equal(state.projects[1].name, path.basename(folderB));
  assert.equal(state.projects[1].folderPath, fs.realpathSync(folderB));
  const saved = state;
  assert.deepEqual(await get(room), saved, 'fresh browser receives persisted folder connections');
  await room.reopen();
  assert.deepEqual(await get(room), saved);
  picked = null;
  state = await folderCommand(room, { action: 'project.createLinked', name: '취소된 프로젝트' });
  assert.equal(state.folderSelectionCancelled, true);
  assert.deepEqual(await get(room), saved, 'cancelled new project must not be created');
  picked = folderB;
  state = await folderCommand(room, { action: 'folder.pick', projectId: a.projectId });
  assert.equal(state.projects[0].folderPath, fs.realpathSync(folderB));
  state = await folderCommand(room, { action: 'folder.disconnect', projectId: a.projectId });
  assert.equal(state.projects[0].folder.state, 'unlinked');
  assert.equal(state.projects[0].folderPath, null);
  assert.deepEqual(state.projects[0].sessions, sessions);
  assert.equal(state.projects[1].id, b.projectId);
  assert.equal(state.projects[1].folder.state, 'connected');
  assert.equal(fs.readFileSync(path.join(folderA, 'keep.txt'), 'utf8'), '사용자 파일 보존');
  assert.ok(fs.statSync(folderB).isDirectory());
  assert.equal(room.calls.length, 0);
  assert.equal(room.images.length, 0);
  assert.equal(picks, 5);
});

test('missing, inaccessible, file and overly broad paths cannot become usable folder connections', async (t) => {
  let picked;
  const room = await roomFixture(t, { folderPicker: async () => picked });
  let state = await command(room, { action: 'project.create', name: '오류 확인' });
  const target = selection(state);
  const dir = path.join(room.root, 'selected');
  fs.mkdirSync(dir);
  picked = dir;
  await folderCommand(room, { action: 'folder.pick', projectId: target.projectId });
  const sessions = structuredClone(current(await get(room)));
  const moved = path.join(room.root, 'moved');
  fs.renameSync(dir, moved);
  state = await folderCommand(room, { action: 'folder.check', projectId: target.projectId });
  assert.equal(state.projects[0].folder.state, 'unavailable');
  assert.match(state.projects[0].folder.error, /존재하지/);
  await room.reopen();
  assert.equal((await get(room)).projects[0].folder.state, 'unavailable');
  picked = dir;
  await folderCommand(room, { action: 'folder.pick', projectId: target.projectId }, 400);
  assert.deepEqual(current(await get(room)), sessions);
  picked = path.join(room.root, 'file.txt');
  fs.writeFileSync(picked, '파일');
  assert.match((await folderCommand(room, { action: 'folder.pick', projectId: target.projectId }, 400)).error, /파일이 아닌/);
  assert.throws(() => validateTaskFolder(path.parse(room.root).root), /드라이브 전체/);
  assert.throws(() => validateTaskFolder('relative-folder'), /절대/);
  if (process.platform === 'win32') assert.throws(() => validateTaskFolder('\\\\server\\share'), /네트워크/);
  const access = fs.accessSync;
  t.mock.method(fs, 'accessSync', (value, mode) => {
    if (value === fs.realpathSync(moved)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return access(value, mode);
  });
  picked = moved;
  assert.match((await folderCommand(room, { action: 'folder.pick', projectId: target.projectId }, 400)).error, /권한/);
});

test('folder API rejects arbitrary client paths and cross-site requests before opening a picker', async (t) => {
  let count = 0;
  const room = await roomFixture(t, { folderPicker: async () => { count++; return null; } });
  const state = await command(room, { action: 'project.create', name: '보안 확인' });
  const body = { action: 'folder.pick', projectId: state.selectedProjectId };
  await folderCommand(room, { ...body, path: room.root }, 400);
  await folderCommand(room, { ...body, folderPath: room.root }, 400);
  await folderCommand(room, body, 403, { Origin: 'https://external.example' });
  await folderCommand(room, body, 403, { Origin: 'null' });
  await folderCommand(room, body, 403, { 'Sec-Fetch-Site': 'cross-site' });
  await folderCommand(room, body, 403, { 'Content-Type': 'text/plain' });
  assert.equal((await room.post('/api/tasks', body)).status, 403, 'missing Origin cannot open a dialog');
  await folderCommand(room, { ...body, projectId: 'unknown' }, 404);
  assert.equal(count, 0);
  assert.ok(!JSON.stringify((await get(room)).projects[0]).includes('"folderPath"'), 'old schema remains unlinked without destructive migration');
});
