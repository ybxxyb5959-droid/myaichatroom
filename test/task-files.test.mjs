import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { roomFixture } from './helpers/room.mjs';
import { TASK_TEXT_BYTES } from '../lib/task-folder.mjs';

async function fixture(t) {
  let selected;
  const room = await roomFixture(t, { folderPicker: async () => selected });
  const root = path.join(room.root, 'project');
  fs.mkdirSync(root);
  const api = async (url, body, expected = 200, headers = {}) => {
    const response = await fetch(room.base + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: room.base, ...headers },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  const connect = async (folder, name) => {
    selected = folder;
    return api('/api/tasks', { action: 'project.createLinked', name });
  };
  const state = await connect(root, '파일 탐색 프로젝트');
  const projectId = state.selectedProjectId;
  return { room, root, projectId, state, api, connect,
    files: (action, relative, expected = 200, id = projectId) => api('/api/tasks/files', { action, projectId: id, path: relative }, expected) };
}

test('lazy directory listing, bounded UTF-8 previews and metadata never modify project files or stored conversations', async (t) => {
  const f = await fixture(t);
  const src = path.join(f.root, 'src'); fs.mkdirSync(src);
  const text = '한글 UTF-8\n<script>window.untrusted = true</script>\n';
  fs.writeFileSync(path.join(src, 'main.js'), text);
  for (const name of ['.git', 'node_modules', 'dist', 'build']) fs.mkdirSync(path.join(f.root, name));
  fs.writeFileSync(path.join(f.root, 'large.txt'), Buffer.alloc(TASK_TEXT_BYTES + 1, 65));
  fs.writeFileSync(path.join(f.root, 'binary.txt'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(f.root, 'non-utf8.txt'), Buffer.from([0xff, 0xfe, 0x61]));
  fs.writeFileSync(path.join(f.root, 'report.docx'), 'not parsed');
  fs.writeFileSync(path.join(f.root, 'empty.txt'), '');
  const opened = [];
  const opendir = fs.opendirSync;
  t.mock.method(fs, 'opendirSync', (dir, ...args) => { opened.push(dir); return opendir(dir, ...args); });
  const list = await f.files('list', '');
  assert.deepEqual(opened, [fs.realpathSync(f.root)], 'initial listing cannot recurse');
  assert.ok(list.entries.some((entry) => entry.name === 'src' && entry.type === 'folder'));
  for (const name of ['.git', 'node_modules', 'dist', 'build']) assert.ok(!list.entries.some((entry) => entry.name === name));
  const nested = await f.files('list', 'src');
  assert.equal(nested.entries[0].path, 'src/main.js');
  const before = fs.statSync(path.join(src, 'main.js'));
  const file = await f.files('read', 'src/main.js');
  assert.equal(file.kind, 'text'); assert.equal(file.text, text);
  assert.equal(file.size, Buffer.byteLength(text)); assert.equal(file.name, 'main.js');
  assert.equal(fs.statSync(path.join(src, 'main.js')).mtimeMs, before.mtimeMs);
  for (const name of ['large.txt', 'binary.txt', 'non-utf8.txt', 'report.docx']) {
    const value = await f.files('read', name);
    assert.equal(value.kind, 'metadata'); assert.equal(value.text, undefined); assert.ok(value.reason);
  }
  assert.equal((await f.files('read', 'empty.txt')).text, '');
  const selection = { projectId: f.projectId, sessionId: f.state.selectedSessionId };
  await f.api('/api/tasks', { action: 'draft.save', ...selection, revision: 0, text: '유지할 사용자 메시지' });
  await f.api('/api/tasks', { action: 'message.add', ...selection, revision: 1, messageId: randomUUID() });
  await f.api('/api/tasks', { action: 'draft.save', ...selection, revision: 2, text: '작성 중 초안' });
  const saved = fs.readFileSync(path.join(f.room.root, 'data/tasks-state.json'), 'utf8');
  f.room.app.store.addMessage({ from: 'user', text: '일반 대화 보존' });
  f.room.app.store.applyFileOp({ op: 'write', path: 'keep.md', content: '기존 창작물' }, 'gpt');
  await f.files('read', 'src/main.js');
  assert.equal(fs.readFileSync(path.join(f.room.root, 'data/tasks-state.json'), 'utf8'), saved);
  await f.room.reopen();
  assert.equal(fs.readFileSync(path.join(f.room.root, 'data/tasks-state.json'), 'utf8'), saved);
  assert.ok(f.room.app.store.messages.some((m) => m.text === '일반 대화 보존'));
  assert.equal(f.room.app.store.readFile('keep.md').text, '기존 창작물');
  assert.equal((await f.files('read', 'src/main.js')).text, text);
  assert.equal(f.room.calls.length, 0);
});

test('each request revalidates its project, folder connection, relative path and read-only operation', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'A');
  const second = path.join(f.room.root, 'second'); fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, 'b.txt'), 'B');
  const b = await f.connect(second, 'B');
  assert.deepEqual((await f.files('list', '', 200, b.selectedProjectId)).entries.map((e) => e.name), ['b.txt']);
  assert.deepEqual((await f.files('list', '')).entries.map((e) => e.name), ['a.txt']);
  await f.files('read', 'missing.txt', 404);
  for (const relative of ['../second/b.txt', '/etc/passwd', 'C:/Windows/win.ini', '..\\second\\b.txt', 'a.txt:secret',
    'a.txt\0', 'a.txt/../a.txt', 'a.txt ', 'a.txt.', '//server/share', 'NUL']) {
    await f.files('read', relative, 403);
  }
  await f.files('write', 'a.txt', 400);
  await f.files('list', '', 404, 'unknown');
  await f.api('/api/tasks/files', { action: 'read', projectId: f.projectId, path: 'a.txt' }, 403, { Origin: 'https://evil.example' });
  assert.equal((await f.room.post('/api/tasks/files', { action: 'read', projectId: f.projectId, path: 'a.txt' })).status, 403);
  await f.api('/api/tasks', { action: 'folder.disconnect', projectId: f.projectId });
  await f.files('list', '', 409);
  await f.files('read', 'a.txt', 409);
  assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'A');
});

test('sensitive names, excluded folders, symbolic links, junctions and hard links cannot expose contents', async (t) => {
  const f = await fixture(t);
  for (const name of ['.env', '.env.local', 'credentials.json', 'passwords.txt', 'api_key.json', 'id_rsa', 'server.pem', 'private.key']) {
    fs.writeFileSync(path.join(f.root, name), 'NEVER EXPOSE');
    await f.files('read', name, 403);
  }
  for (const name of ['.git', 'node_modules', 'dist', 'build', '.ssh', '.aws']) {
    fs.mkdirSync(path.join(f.root, name));
    fs.writeFileSync(path.join(f.root, name, 'config.txt'), 'NEVER EXPOSE');
    await f.files('list', name, 403);
    await f.files('read', `${name}/config.txt`, 403);
  }
  const outside = path.join(f.room.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'public.txt'), 'OUTSIDE');
  fs.symlinkSync(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.files('list', 'escape', 403);
  await f.files('read', 'escape/public.txt', 403);
  fs.linkSync(path.join(outside, 'public.txt'), path.join(f.root, 'alias.txt'));
  await f.files('read', 'alias.txt', 403);
  const listing = await f.files('list', '');
  assert.ok(listing.entries.find((e) => e.name === 'escape').blocked);
  assert.ok(listing.entries.find((e) => e.name === '.env').blocked);
  const old = path.join(f.room.root, 'previous-root');
  fs.renameSync(f.root, old);
  fs.symlinkSync(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  await f.files('read', 'public.txt', 403);
});

test('unreadable targets show errors, oversized files are not opened and directory output is bounded', async (t) => {
  const f = await fixture(t);
  const denied = path.join(f.root, 'denied.txt');
  const large = path.join(f.root, 'large.txt');
  fs.writeFileSync(denied, 'unreadable');
  fs.writeFileSync(large, Buffer.alloc(TASK_TEXT_BYTES + 1));
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (name, ...args) => {
    if (name === large) throw new Error('oversized contents must never be opened');
    if (name === denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return open(name, ...args);
  });
  await f.files('read', 'denied.txt', 403);
  assert.equal((await f.files('read', 'large.txt')).kind, 'metadata');
  for (let i = 0; i < 510; i++) fs.writeFileSync(path.join(f.root, `file-${i}.txt`), '');
  const list = await f.files('list', '');
  assert.equal(list.truncated, true); assert.equal(list.entries.length, list.limit);
  const opendir = fs.opendirSync;
  t.mock.method(fs, 'opendirSync', (name, ...args) => {
    if (name === fs.realpathSync(f.root)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return opendir(name, ...args);
  });
  await f.files('list', '', 403);
});
