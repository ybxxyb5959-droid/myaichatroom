import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLock, cleanAtomicTemps, readLock, scanBackups, pruneBackups } from '../lib/task-safety.mjs';
import { roomFixture } from './helpers/room.mjs';

const temp = (t, prefix = 'task-safety-') => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('a live owner blocks a second lock; dead, abandoned and legacy bare-pid locks are taken over', (t) => {
  const file = path.join(temp(t), 'x.lock');
  const first = acquireLock(file);
  assert.throws(() => acquireLock(file), { status: 409 });
  assert.equal(readLock(file).pid, process.pid);
  first.release();
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, JSON.stringify({ pid: 2147483646, token: 'dead', at: Date.now() }));
  const second = acquireLock(file);
  assert.equal(second.tookOver, true);
  second.release();

  fs.writeFileSync(file, '2147483646');
  acquireLock(file).release();

  // A live PID whose lock is far older than any real operation is treated as abandoned (recycled PID).
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'old', at: Date.now() - 3 * 3600000 }));
  const third = acquireLock(file, { maxAgeMs: 60000 });
  assert.equal(third.tookOver, true);
  third.release();
});

test('release never deletes a lock that another owner took over', (t) => {
  const file = path.join(temp(t), 'x.lock');
  const mine = acquireLock(file);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'someone-else', at: Date.now() }));
  mine.release();
  assert.equal(readLock(file).token, 'someone-else');
});

test('only old atomic-save temp files are cleaned; real data and recent temps stay', (t) => {
  const dir = temp(t);
  const oldTemp = path.join(dir, `tasks-state.json.${randomUUID()}.tmp`);
  const freshTemp = path.join(dir, `tasks-plans.json.${randomUUID()}.tmp`);
  const nested = path.join(dir, 'task-backups', 'p'); fs.mkdirSync(nested, { recursive: true });
  const nestedTemp = path.join(nested, `a.bak.${randomUUID()}.tmp`);
  const data = path.join(dir, 'tasks-state.json'); fs.writeFileSync(data, '{}');
  const user = path.join(dir, 'notes.tmp'); fs.writeFileSync(user, 'mine');
  for (const f of [oldTemp, freshTemp, nestedTemp]) fs.writeFileSync(f, 'x');
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(oldTemp, old, old); fs.utimesSync(nestedTemp, old, old);
  const removed = cleanAtomicTemps(dir);
  assert.deepEqual(removed.map((r) => r.replaceAll('\\', '/')).sort(), ['task-backups/p/' + path.basename(nestedTemp), path.basename(oldTemp)].sort());
  assert.ok(fs.existsSync(freshTemp) && fs.existsSync(data) && fs.existsSync(user));
});

test('backup pruning keeps referenced needed backups and only removes old orphans or finished ones', (t) => {
  const dir = temp(t);
  const make = (name, ageDays) => {
    const f = path.join(dir, name); fs.writeFileSync(f, 'backup');
    const when = new Date(Date.now() - ageDays * 86400000); fs.utimesSync(f, when, when); return f;
  };
  const needed = make('needed.bak', 90), finished = make('finished.bak', 90), recentFinished = make('recent.bak', 2), orphan = make('orphan.bak', 30), freshOrphan = make('fresh.bak', 1);
  const refs = new Map([[path.resolve(needed).toLowerCase(), { keep: true }], [path.resolve(finished).toLowerCase(), { keep: false }], [path.resolve(recentFinished).toLowerCase(), { keep: false }]]);
  const report = scanBackups([dir], refs);
  assert.deepEqual(report.files.filter((f) => f.prunable).map((f) => path.basename(f.file)).sort(), ['finished.bak', 'orphan.bak']);
  const outside = path.join(temp(t), 'outside.bak'); fs.writeFileSync(outside, 'x');
  const removed = pruneBackups({ files: [...report.files, { file: outside, prunable: true }] }, dir);
  assert.equal(removed.length, 2);
  assert.ok(fs.existsSync(needed) && fs.existsSync(recentFinished) && fs.existsSync(freshOrphan) && fs.existsSync(outside));
});

test('a second server on the same data folder is refused; closing releases it; a dead owner is replaced', async (t) => {
  const room = await roomFixture(t);
  const response = await fetch(room.base + '/api/tasks');
  assert.equal(response.status, 200);
  const lockFile = path.join(room.root, 'data', 'task-instance.lock');
  assert.equal(readLock(lockFile).pid, process.pid);
  // Simulate a second server object on the same folder in this process.
  const { createAssistantServer, loadConfig } = await import('../server.mjs');
  const other = createAssistantServer({ root: room.root, cfg: loadConfig(path.join(room.root, 'none.json')), adapter: room.adapter, greetings: false, autoTickMs: 3600000 });
  await new Promise((resolve) => other.server.listen(0, '127.0.0.1', resolve));
  const blocked = await fetch(`http://127.0.0.1:${other.server.address().port}/api/tasks`);
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /하나의 서버/);
  await other.close();
  assert.equal(fs.existsSync(lockFile), true, 'the blocked server must not remove the owner lock');
  await room.app.close();
  assert.equal(fs.existsSync(lockFile), false);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483646, token: 'crashed', at: Date.now() }));
  const third = createAssistantServer({ root: room.root, cfg: loadConfig(path.join(room.root, 'none.json')), adapter: room.adapter, greetings: false, autoTickMs: 3600000 });
  await new Promise((resolve) => third.server.listen(0, '127.0.0.1', resolve));
  const ok = await fetch(`http://127.0.0.1:${third.server.address().port}/api/tasks/ai`);
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).notices.join(' '), /비정상 종료/);
  await third.close();
});

test('maintenance reports and prunes only unneeded backups and refuses while an AI job runs', async (t) => {
  const room = await roomFixture(t);
  const report = await room.post('/api/tasks/ai', { action: 'maintenance.report' });
  assert.equal(report.status, 403, 'same-origin JSON requests only');
  const post = async (body) => {
    const response = await fetch(room.base + '/api/tasks/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: room.base }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const dir = path.join(room.root, 'data', 'task-backups', randomUUID()); fs.mkdirSync(dir, { recursive: true });
  const orphan = path.join(dir, `${randomUUID()}.bak`); fs.writeFileSync(orphan, 'old backup');
  const old = new Date(Date.now() - 20 * 86400000); fs.utimesSync(orphan, old, old);
  const first = await post({ action: 'maintenance.report' });
  assert.equal(first.status, 200);
  assert.deepEqual([first.value.total, first.value.prunable, first.value.removed], [1, 1, 0]);
  assert.ok(fs.existsSync(orphan));
  const pruned = await post({ action: 'maintenance.prune' });
  assert.equal(pruned.value.removed, 1);
  assert.equal(fs.existsSync(orphan), false);
});
