import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import childProcess, { spawn } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { Store } from '../lib/store.mjs';
import { writeJsonFile, readJsonFile } from '../lib/atomic.mjs';
import { run, running, Adapters } from '../lib/agents.mjs';
import { createAssistantServer, loadConfig } from '../server.mjs';
import { House, HOUSE_LIMITS, HOUSE_BRIEF } from '../lib/house.mjs';
import { LEVELS } from '../lib/auto.mjs';
import { noteEvent } from '../lib/life.mjs';
import { ACTIVITY_MAX } from '../lib/activity.mjs';
import { UsageMonitor } from '../lib/usage.mjs';

const IDS = ['gpt', 'claude', 'gemini'];
const MIN = 60000, DAY = 86400000;
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-stability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const cfg = () => ({ ...loadConfig(path.join(os.tmpdir(), 'chat-stability-no-config.json')), autoSleepMinutes: 0 });
function fake() {
  const calls = [];
  return {
    calls, available: () => Object.fromEntries(IDS.map((id) => [id, true])),
    loginStatus: async () => ({ status: 'ok' }), listModels: async () => [],
    chat: async (id, brief, prompt, options) => {
      calls.push({ id, brief, prompt, options });
      return { ok: true, text: '테스트 답변' };
    },
  };
}
async function appAt(t, root, clock, adapter = fake()) {
  const app = createAssistantServer({ root, cfg: cfg(), clock: () => clock.now, adapter, greetings: false, random: () => 0.25, autoTickMs: 3600000, pairDelayMs: 20 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, value) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(res.status, 200);
    return res.json();
  };
  return { app, post, base, adapter };
}

test('Store retries Windows open/rename locks, commits memory only after append, and preserves lasting failures', (t) => {
  const root = temp(t), store = new Store(root);
  const open = fs.openSync, rename = fs.renameSync;
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    let n = 0;
    t.mock.method(fs, 'openSync', (...args) => {
      if (++n < 3) throw Object.assign(new Error(code), { code });
      return open(...args);
    });
    store.addMessage({ from: 'user', text: code });
    assert.equal(n, 3);
    t.mock.restoreAll();
    let replacements = 0;
    t.mock.method(fs, 'renameSync', (...args) => {
      if (++replacements < 3) throw Object.assign(new Error(code), { code });
      return rename(...args);
    });
    store.state = { assistant: { roomName: code, auto: { features: { photos: false } } } };
    store.saveState();
    assert.equal(replacements, 3);
    t.mock.restoreAll();
    assert.equal(new Store(root).state.assistant.roomName, code);
  }
  const before = store.messages.length, nextId = store.nextId;
  t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  assert.throws(() => store.addMessage({ text: 'not saved' }), /disk full/);
  assert.equal(store.messages.length, before);
  assert.equal(store.nextId, nextId);
  t.mock.restoreAll();
  const original = fs.readFileSync(store.stateFile, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('still locked'), { code: 'EBUSY' }); });
  store.state.assistant.roomName = 'not committed';
  assert.throws(() => store.saveState(), /still locked/);
  assert.equal(fs.readFileSync(store.stateFile, 'utf8'), original);
  t.mock.restoreAll();
  assert.equal(fs.readdirSync(store.dataDir).filter((f) => f.endsWith('.tmp')).length, 1);
  const write = fs.writeSync;
  let writes = 0;
  t.mock.method(fs, 'writeSync', (fd, buffer, offset, length) => {
    if (++writes === 2) throw Object.assign(new Error('temporary write lock'), { code: 'EACCES' });
    return write(fd, buffer, offset, Math.min(length, 12));
  });
  store.addMessage({ from: 'user', text: 'partial write is not duplicated' });
  t.mock.restoreAll();
  const restored = new Store(root);
  assert.equal(restored.messages.length, before + 1);
  assert.equal(restored.messages.at(-1).text, 'partial write is not duplicated');
});

test('corrupt JSON and incomplete JSONL are preserved, repaired and visibly reported without blocking startup', async (t) => {
  const root = temp(t), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const files = ['state.json', 'workspace-meta.json', 'house.json', 'activity.json'];
  for (const file of files) fs.writeFileSync(path.join(data, file), '{"broken":');
  const good = JSON.stringify({ id: 7, from: 'user', text: 'keep me', ts: 1 });
  fs.writeFileSync(path.join(data, 'messages.jsonl'), good + '\n{"id":8');
  const { app } = await appAt(t, root, { now: Date.now() });
  assert.equal(app.store.messages.find((m) => m.id === 7).text, 'keep me');
  assert.equal(app.store.messages.filter((m) => /원본 보존/.test(m.text)).length, files.length + 1);
  for (const file of [...files, 'messages.jsonl']) {
    const full = path.join(data, file);
    const backups = fs.readdirSync(path.dirname(full)).filter((name) => name.startsWith(path.basename(file) + '.unreadable-'));
    assert.equal(backups.length, 1);
    assert.ok(fs.readFileSync(path.join(path.dirname(full), backups[0]), 'utf8').includes(file === 'messages.jsonl' ? 'keep me' : '"broken"'));
    if (file !== 'messages.jsonl') assert.doesNotThrow(() => JSON.parse(fs.readFileSync(full, 'utf8')));
  }
  app.store.addMessage({ from: 'user', text: 'after repair' });
  assert.equal(new Store(root).messages.at(-1).text, 'after repair');
  const invalid = path.join(root, 'null.json');
  fs.writeFileSync(invalid, 'null');
  assert.deepEqual(readJsonFile(invalid, {}), {});
  t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('denied read'), { code: 'EACCES' }); });
  assert.throws(() => readJsonFile(invalid, {}), /denied read/);
  t.mock.restoreAll();
});

test('a forcibly terminated writer leaves committed chats, settings and house recoverable', async (t) => {
  const root = temp(t);
  const code = `
    import { Store } from ${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)};
    import { House } from ${JSON.stringify(new URL('../lib/house.mjs', import.meta.url).href)};
    import fs from 'node:fs'; import path from 'node:path';
    const root = process.argv[1], store = new Store(root);
    store.addMessage({ from: 'user', text: 'crash recovery' });
    store.state.assistant = { roomName: 'saved room', auto: { on: true, features: { notes: false } } }; store.saveState();
    const house = new House(path.join(root, 'data/house.json'), { ids: ['gpt'], names: {} });
    house.s.phase = 'life'; house.s.relations = { 'claude:gpt': 75 };
    house.s.events = [{ id: 1, at: 1, actors: ['gpt'], text: 'saved event' }]; house.save();
    process.stdout.write('READY\\n'); setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exit) => reject(new Error(`writer exited: ${exit}`)));
    child.stdout.once('data', resolve);
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL'); await exited;
  const { app, adapter } = await appAt(t, root, { now: Date.now() });
  assert.equal(app.store.messages[0].text, 'crash recovery');
  assert.equal(app.room.roomName, 'saved room');
  assert.equal(app.room.auto.features, undefined, 'legacy individual switches are no longer settings');
  assert.equal(app.house.s.phase, 'life');
  assert.equal(app.house.s.relations['claude:gpt'], 75);
  assert.equal(app.house.s.events[0].text, 'saved event');
  assert.equal(adapter.calls.length, 0);
});

test('restart defers overdue activity, discards an old chat game and OFF drops pending chatter', async (t) => {
  const root = temp(t), clock = { now: new Date(2026, 9, 7, 10).getTime() };
  const store = new Store(root);
  store.state.assistant = { auto: { on: true, sleepMinutes: 0 }, life: { shareAt: 1, gameAt: 1, noteAt: 1 },
    game: { id: 'legacy-game', kind: 'quiz', players: IDS, done: false, joined: true, waitingSince: clock.now - DAY } };
  store.saveState();
  const { app, post, adapter } = await appAt(t, root, clock);
  assert.equal(app.room.game, undefined);
  assert.equal(app.room.life.gameAt, undefined);
  for (let i = 0; i < 50; i++) app.funTick();
  assert.equal(app.store.messages.length, 0);
  app.room.auto.usage.stopped = 'test';
  clock.now += 16 * MIN;
  await app.tick();
  await post('/api/room', { auto: { on: false } });
  const before = app.store.messages.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(app.store.messages.length, before);
  assert.equal(adapter.calls.length, 0);
});

test('accelerated 12-day life keeps events, house logs, activities and SVG files bounded without AI calls', async (t) => {
  const root = temp(t), clock = { now: new Date(2026, 9, 7, 10).getTime() };
  const house = new House(path.join(root, 'data/house.json'), { ids: IDS, names: {} });
  house.s.phase = 'life'; house.save();
  const { app, post, adapter } = await appAt(t, root, clock);
  await post('/api/room', { auto: { on: true, level: 'high' } });
  const seen = new Set();
  for (let i = 0; i < 576; i++) {
    clock.now += 30 * MIN;
    app.lifeTick();
    noteEvent(app.house, { type: 'game', actors: IDS, text: `event ${i}` }, clock.now);
    app.activity.add({ kind: 'task', actors: ['gpt'], text: `작업 ${i} 완료` });
    const out = app.funTick();
    if (out.share) {
      assert.ok(!seen.has(out.share.messageId)); seen.add(out.share.messageId);
    }
    assert.ok(app.house.s.log.length <= HOUSE_LIMITS.log);
    assert.ok(app.house.s.events.length <= 30);
    assert.ok(app.activity.entries.length <= ACTIVITY_MAX);
  }
  assert.ok(seen.size > 80, `generated ${seen.size}`);
  assert.equal(app.store.listFiles().filter((f) => f.path.startsWith('life/')).length, 80);
  assert.ok(app.room.life.last.refs.length <= 30);
  assert.ok(app.room.life.last.captions.length <= 20);
  assert.equal(adapter.calls.length, 0);
  assert.ok(JSON.parse(fs.readFileSync(app.activity.file)).entries.length <= ACTIVITY_MAX);
  await post('/api/room', { auto: { on: false } });
  const count = app.store.messages.length;
  clock.now += DAY;
  assert.equal(app.lifeTick(), null);
  assert.equal(app.funTick(), null);
  assert.equal(await app.tick(), null);
  assert.equal(app.store.messages.length, count);
});

test('repeated SSE reconnects and shutdown leave no delayed posts or duplicate connection handlers', async (t) => {
  const root = temp(t), clock = { now: Date.now() };
  const { app, base } = await appAt(t, root, clock);
  const listeners = app.server.listenerCount('connection');
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve, reject) => {
      const req = http.get(base + '/events', (res) => {
        res.once('data', () => { res.destroy(); resolve(); });
      });
      req.once('error', reject);
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.server.listenerCount('connection'), listeners);
  const connections = await new Promise((resolve, reject) => app.server.getConnections((error, n) => error ? reject(error) : resolve(n)));
  assert.ok(connections <= 1, `remaining connections: ${connections}`);
  await app.close();
  clock.now += DAY;
  assert.equal(await app.tick(), null);
  assert.equal(app.lifeTick(), null);
  assert.equal(app.funTick(), null);
});

test('CLI missing, timeout, nonzero exit, cancellation and excessive output clean up children and abort listeners', async () => {
  const baseline = running.size, controller = new AbortController();
  const missing = await run(path.join(os.tmpdir(), 'no-such-cli-stability.exe'), [], { timeoutMs: 2000 });
  assert.notEqual(missing.code, 0); // libuv uses a platform-specific negative code for ENOENT.
  assert.match(missing.stderr, /ENOENT/);
  const failed = await run(process.execPath, ['-e', 'process.stderr.write("Not logged in"); process.exit(7)']);
  assert.equal(failed.code, 7);
  const timed = await run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(timed.code, -2);
  for (let i = 0; i < 12; i++) {
    const result = await run(process.execPath, ['-e', 'process.stdout.write("ok")'], { signal: controller.signal });
    assert.equal(result.stdout, 'ok');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  const pending = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).code, -3);
  const flood = await run(process.execPath, ['-e', 'process.stdout.write("x".repeat(9*1024*1024))']);
  assert.equal(flood.code, -4);
  assert.ok(Buffer.byteLength(flood.stdout) <= 8 * 1024 * 1024);
  assert.equal(running.size, baseline);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('usage retention is applied during polling without a restart or provider call', async (t) => {
  const root = temp(t);
  const monitor = new UsageMonitor(root, {});
  const old = { id: 'gpt', at: Date.now() - 9 * DAY, w: {} };
  monitor.hist.gpt.push(old);
  fs.writeFileSync(monitor.file, JSON.stringify(old) + '\n');
  monitor.gpt = async () => ({ windows: [{ id: 'h5', usedPct: 20 }] });
  await monitor.pollOne('gpt');
  assert.equal(monitor.hist.gpt.length, 1);
  assert.equal(fs.readFileSync(monitor.file, 'utf8').trim().split('\n').length, 1);
});

test('Gemini malformed JSON, wrong response types and error statuses are failures, not chat messages', async (t) => {
  const adapter = Object.assign(Object.create(Adapters.prototype), { root: temp(t), cfg: cfg(), bins: { agy: 'mock-agy' }, sessions: {} });
  let output = '';
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    queueMicrotask(() => { child.stdout.end(output); child.emit('close', 0); });
    return child;
  });
  syncBuiltinESMExports();
  try {
    for (const value of ['not JSON', 'null', '{"response":42}', '{"status":"ERROR","response":"failure"}']) {
      output = value;
      const result = await adapter.chat('gemini', 'brief', 'test', { independent: true });
      assert.equal(result.ok, false, value);
      assert.equal(result.text, '');
    }
    output = '{"status":"SUCCESS","response":"valid answer","conversation_id":"fixture"}';
    assert.equal((await adapter.chat('gemini', 'brief', 'test', { independent: true })).text, 'valid answer');
    output = '{"status":"ERROR","response":"429 usage limit reached"}';
    const quota = await adapter.chat('gemini', 'brief', 'test', { independent: true });
    assert.equal(quota.ok, false);
    assert.match(quota.detail, /429 usage limit reached/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(running.size, 0);
});

test('all automatic features share bounded timers and budgets over two accelerated days, then stop immediately', async (t) => {
  const root = temp(t), clock = { now: new Date(2026, 9, 7, 0).getTime() };
  const intervals = new Map();
  t.mock.method(globalThis, 'setInterval', (fn) => {
    const timer = { unref() {} };
    intervals.set(timer, fn); return timer;
  });
  t.mock.method(globalThis, 'clearInterval', (timer) => intervals.delete(timer));
  const adapter = fake();
  adapter.chat = async (id, brief, prompt, options) => {
    adapter.calls.push({ id, at: clock.now, options });
    return { ok: true, text: brief === HOUSE_BRIEF ? '{"say":"집에서 쉬는 중","actions":[]}' : '잠깐 쉬고 있어' };
  };
  const app = createAssistantServer({ root, cfg: cfg(), clock: () => clock.now, random: () => 0.3, adapter, greetings: false });
  try {
    assert.equal(intervals.size, 2);
    app.room.auto.on = true; app.room.auto.level = 'high'; app.house.s.phase = 'life';
    for (let i = 0; i < 576; i++) {
      clock.now += 5 * MIN;
      for (const callback of intervals.values()) callback();
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(app.room.auto.usage.calls <= LEVELS.high.daily);
      assert.equal(intervals.size, 2);
    }
    assert.ok(adapter.calls.length > 0);
    assert.ok(app.store.messages.some((m) => m.auto === 'life'));
    assert.ok(!app.activity.entries.some((entry) => entry.kind === 'game'), 'chat games are no longer automatic activities');
    const count = adapter.calls.length, messages = app.store.messages.length;
    app.room.auto.on = false;
    clock.now += DAY;
    for (const callback of intervals.values()) callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(adapter.calls.length, count);
    assert.equal(app.store.messages.length, messages);
    await app.close();
    assert.equal(intervals.size, 0);
    let started = false, finished = false;
    adapter.chat = (_id, _brief, _prompt, options) => new Promise((resolve) => {
      started = true;
      options.signal.addEventListener('abort', () => setTimeout(() => {
        finished = true; resolve({ ok: true, text: '{"say":"late reply","actions":[]}' });
      }, 5), { once: true });
    });
    const reopened = createAssistantServer({ root, cfg: cfg(), adapter, clock: () => clock.now, greetings: false });
    assert.equal(intervals.size, 2);
    reopened.room.auto.on = true;
    clock.now += MIN;
    const turns = reopened.house.s.turns;
    [...intervals.values()][0]();
    assert.equal(started, true);
    await reopened.close();
    assert.equal(finished, true, 'close waits for the aborted house turn to settle');
    assert.equal(reopened.house.s.turns, turns, 'late house replies are not applied');
    assert.equal(intervals.size, 0);
  } finally { await app.close(); t.mock.restoreAll(); }
});
