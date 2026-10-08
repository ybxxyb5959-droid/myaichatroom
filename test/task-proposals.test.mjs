import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { roomFixture } from './helpers/room.mjs';
import { TaskStore } from '../lib/task-store.mjs';
import { ProposalStore, proposalDiff, parseProposal, PROPOSAL_LIMITS } from '../lib/task-proposals.mjs';
import { replaceTaskTextFile } from '../lib/task-folder.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const original = '// ORIGINAL_FILE_ONLY\nexport const count = 1;\n';
const after = original.replace('count = 1', 'count = 2');
const response = (overrides = {}) => JSON.stringify({ version: 1, path: 'code.js', after, reason: 'count 값을 2로 제안합니다. (테스트 공급자)', ...overrides });

async function fixture(t, analyze) {
  let selected;
  const calls = [];
  const room = await roomFixture(t, {
    folderPicker: async () => selected,
    taskProvider: { available: () => true, prepare: async () => 'test',
      analyze: async (input, options) => { calls.push({ input: JSON.parse(input), options }); return analyze ? analyze(input, options) : response(); } },
  });
  selected = path.join(room.root, 'project'); fs.mkdirSync(selected);
  fs.writeFileSync(path.join(selected, 'code.js'), original);
  fs.writeFileSync(path.join(selected, 'other.txt'), 'UNSELECTED-CONTENT');
  fs.writeFileSync(path.join(selected, '.env'), 'SECRET-CONTENT');
  const post = async (url, body, expected = 200) => {
    const r = await fetch(room.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: room.base }, body: JSON.stringify(body) });
    const value = await r.json(); assert.equal(r.status, expected, JSON.stringify(value)); return value;
  };
  const state = await post('/api/tasks', { action: 'project.createLinked', name: '수정안 테스트' });
  const ids = { projectId: state.selectedProjectId, sessionId: state.selectedSessionId };
  const get = async () => (await fetch(room.base + '/api/tasks/ai')).json();
  const entry = (state) => state.projects.find((p) => p.id === ids.projectId).sessions.find((s) => s.id === ids.sessionId);
  const draft = async () => post('/api/tasks', { action: 'draft.save', ...ids, revision: entry((await get()).state).revision, text: 'count 값을 2로 바꾸는 수정안을 제안해 줘.' });
  const start = async (extra = {}, expected = 202) => post('/api/tasks/ai', { action: 'start', mode: 'proposal', provider: 'claude', consent: true, ...ids,
    files: ['code.js'], revision: entry((await get()).state).revision, ...extra }, expected);
  const wait = async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const v = await get(); if (!v.running) return v; await delay(10); }
    assert.fail('proposal job did not finish');
  };
  const generate = async () => { await draft(); await start(); return wait(); };
  const detail = async (id) => post('/api/tasks/proposals', { action: 'get', ...ids, id });
  const decide = async (id, decision, expected = 200) => post('/api/tasks/proposals', { action: 'decide', ...ids, id, decision }, expected);
  return { room, root: selected, ids, entry, calls, post, get, draft, start, wait, generate, detail, decide };
}

test('structured single-file proposals, approval and rejection persist separately without changing project files', async (t) => {
  const f = await fixture(t);
  const beforeBytes = fs.readFileSync(path.join(f.root, 'code.js'));
  let result = await f.generate();
  assert.equal(f.entry(result.state).analysis.status, 'completed');
  assert.equal(f.calls[0].options.mode, 'proposal');
  assert.deepEqual(f.calls[0].input.files, [{ path: 'code.js', content: original }]);
  assert.deepEqual(f.calls[0].input.history, []);
  assert.ok(!JSON.stringify(f.calls).includes('UNSELECTED-CONTENT'));
  assert.ok(!JSON.stringify(f.calls).includes('SECRET-CONTENT'));
  const id = result.proposals[0].id;
  let proposal = await f.detail(id);
  assert.equal(proposal.before, original); assert.equal(proposal.after, after);
  assert.equal(proposal.beforeHash, sha(beforeBytes));
  assert.equal(proposal.afterHash, sha(Buffer.from(after)));
  assert.equal(proposal.diff.added, 1); assert.equal(proposal.diff.removed, 1);
  assert.equal(proposal.status, 'pending');
  assert.ok(!JSON.stringify(result.state).includes('ORIGINAL_FILE_ONLY'), 'source snapshots must not bloat conversation storage');
  assert.equal(f.entry(result.state).messages.at(-1).proposalId, id);
  const conversation = fs.readFileSync(path.join(f.room.root, 'data/tasks-state.json'), 'utf8');
  proposal = await f.decide(id, 'approved');
  assert.equal(proposal.status, 'approved'); assert.ok(proposal.decidedAt);
  assert.equal(fs.readFileSync(path.join(f.room.root, 'data/tasks-state.json'), 'utf8'), conversation, 'approval changes only proposal data');
  assert.equal(sha(fs.readFileSync(path.join(f.root, 'code.js'))), sha(beforeBytes));
  await f.room.reopen();
  assert.equal((await f.detail(id)).status, 'approved');
  assert.equal((await f.detail(id)).after, after);
  result = await f.generate();
  const second = result.proposals.find((p) => p.id !== id);
  assert.equal((await f.decide(second.id, 'rejected')).status, 'rejected');
  await f.room.reopen();
  assert.equal((await f.detail(second.id)).status, 'rejected');
  await f.decide(second.id, 'approved', 409);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'code.js')), beforeBytes);
  assert.equal(fs.readFileSync(path.join(f.root, 'other.txt'), 'utf8'), 'UNSELECTED-CONTENT');
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['.env', 'code.js', 'other.txt']);
  assert.equal(f.room.calls.length, 0, 'ordinary chat CLI was not invoked');
});

test('server diff is derived from exact contents and preserves CRLF, BOM and missing final newlines', () => {
  for (const [before, next] of [
    ['a\nb\nc\n', 'a\nB\nc\nx\n'], ['', 'new\n'], ['remove\n', ''], ['a\n', 'a'],
    ['\ufeffa\r\nb\r\n', '\ufeffa\r\nB\r\n'], ['a\na\nb\n', 'a\nb\na\n'],
  ]) {
    const diff = proposalDiff(before, next);
    assert.equal(diff.rows.filter((r) => r.kind !== 'added').map((r) => r.text).join(''), before);
    assert.equal(diff.rows.filter((r) => r.kind !== 'removed').map((r) => r.text).join(''), next);
    assert.equal(diff.added, diff.rows.filter((r) => r.kind === 'added').length);
    assert.equal(diff.removed, diff.rows.filter((r) => r.kind === 'removed').length);
  }
  const diff = proposalDiff('a\nb\nc\n', 'a\nB\nc\nx\n');
  assert.equal(diff.added, 2); assert.equal(diff.removed, 1);
});

test('changes during generation are stored as conflicts and approval rechecks original hash', async (t) => {
  let finish, entered;
  const gate = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, () => new Promise((resolve) => { finish = resolve; entered(); }));
  await f.draft(); await f.start(); await gate;
  fs.writeFileSync(path.join(f.root, 'code.js'), original + '// changed during generation\n');
  finish(response());
  let result = await f.wait();
  assert.equal(result.proposals[0].status, 'conflict');
  await f.decide(result.proposals[0].id, 'approved', 409);
  const detail = await f.detail(result.proposals[0].id);
  assert.equal(detail.before, original, 'snapshot must not be replaced by newer disk contents');
  assert.equal((await f.decide(detail.id, 'rejected')).status, 'rejected');

  const g = await fixture(t);
  result = await g.generate();
  const id = result.proposals[0].id;
  await g.detail(id); // User sees a valid pending diff, then the file changes before clicking approve.
  fs.writeFileSync(path.join(g.root, 'code.js'), '// new original\n');
  await g.decide(id, 'approved', 409);
  assert.equal((await g.detail(id)).status, 'conflict');
  assert.equal(fs.readFileSync(path.join(g.root, 'code.js'), 'utf8'), '// new original\n');
});

test('project/session scope, folder disconnect and external requests cannot approve the wrong proposal', async (t) => {
  const f = await fixture(t);
  const result = await f.generate(), id = result.proposals[0].id;
  const other = await f.post('/api/tasks', { action: 'project.create', name: '다른 프로젝트' });
  await f.post('/api/tasks/proposals', { action: 'get', id, projectId: other.selectedProjectId, sessionId: other.selectedSessionId }, 404);
  await f.post('/api/tasks/proposals', { action: 'decide', decision: 'approved', id, projectId: other.selectedProjectId, sessionId: other.selectedSessionId }, 404);
  const newSession = await f.post('/api/tasks', { action: 'session.create', projectId: f.ids.projectId });
  await f.post('/api/tasks/proposals', { action: 'get', id, projectId: f.ids.projectId, sessionId: newSession.selectedSessionId }, 404);
  const denied = await fetch(f.room.base + '/api/tasks/proposals', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get', ...f.ids, id }) });
  assert.equal(denied.status, 403);
  await f.post('/api/tasks/proposals', { action: 'apply', ...f.ids, id }, 400);
  await f.post('/api/tasks', { action: 'folder.disconnect', projectId: f.ids.projectId });
  await f.decide(id, 'approved', 409);
  assert.equal(fs.readFileSync(path.join(f.root, 'code.js'), 'utf8'), original);
});

test('invalid model JSON and unrelated targets are rejected, not stored as successful proposals', async (t) => {
  for (const raw of [
    'not JSON', '```json\n' + response() + '\n```', response({ path: 'other.txt' }), response({ version: 2 }),
    response({ files: ['other.txt'] }), response({ after: null }), response({ after: original }),
    response({ after: 'x'.repeat(PROPOSAL_LIMITS.fileBytes + 1) }), response({ after: '\n'.repeat(2001) }),
    response({ after: 'bad\0text' }), response({ after: '\ud800' }), response({ reason: '' }), response({ reason: 'x'.repeat(2001) }),
  ]) assert.throws(() => parseProposal(raw, 'code.js', original));
  const f = await fixture(t, async () => response({ path: 'other.txt' }));
  const result = await f.generate();
  assert.equal(f.entry(result.state).analysis.status, 'failed');
  assert.equal(result.proposals.length, 0);
  assert.deepEqual(f.entry(result.state).messages.map((m) => m.role), ['user']);
  assert.equal(fs.existsSync(path.join(f.room.root, 'data/task-proposals.json')), false);
});

test('proposal limits and sensitive/link policies are enforced before an AI call', async (t) => {
  const f = await fixture(t);
  await f.draft();
  await f.start({ files: [] }, 400);
  await f.start({ files: ['code.js', 'other.txt'] }, 400);
  await f.start({ files: ['.env'] }, 403);
  await f.start({ files: ['../outside.txt'] }, 403);
  fs.writeFileSync(path.join(f.root, 'long.txt'), '\n'.repeat(2001));
  await f.start({ files: ['long.txt'] }, 400);
  const outside = path.join(f.room.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'code.js'), original);
  fs.symlinkSync(outside, path.join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.start({ files: ['link/code.js'] }, 403);
  assert.equal(f.calls.length, 0);
});

test('raw UTF-8 hash includes BOM, and bounded proposal retention never evicts older approvals', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from('\ufefffirst\r\nsecond\r\n', 'utf8');
  fs.writeFileSync(path.join(f.root, 'bom.txt'), bytes);
  const store = new TaskStore(path.join(f.room.root, 'data')), proposals = new ProposalStore(store);
  const source = store.files({ action: 'read', projectId: f.ids.projectId, path: 'bom.txt' });
  assert.equal(source.hash, sha(bytes)); assert.equal(Buffer.from(source.text).equals(bytes), true);
  const create = (target = f.ids) => proposals.create({ ...target, runId: randomUUID(), folderPath: f.root, source },
    response({ path: 'bom.txt', after: '\ufefffirst\r\nchanged\r\n' }));
  const first = create();
  proposals.decide({ ...f.ids, id: first.id, decision: 'approved' });
  for (let i = 1; i < 10; i++) create();
  assert.throws(() => create(), /보관 한도/);
  for (let s = 1; s < 5; s++) {
    const state = store.apply({ action: 'session.create', projectId: f.ids.projectId });
    for (let i = 0; i < 10; i++) create({ projectId: f.ids.projectId, sessionId: state.selectedSessionId });
  }
  const state = store.apply({ action: 'session.create', projectId: f.ids.projectId });
  assert.throws(() => create({ projectId: f.ids.projectId, sessionId: state.selectedSessionId }), /보관 한도/);
  assert.equal(proposals.data.proposals.length, 50);
  assert.equal(proposals.get({ ...f.ids, id: first.id }).status, 'approved');
  assert.equal(fs.readFileSync(path.join(f.root, 'bom.txt')).equals(bytes), true);
  assert.throws(() => proposals.commit({ ...proposals.data, excess: 'x'.repeat(PROPOSAL_LIMITS.storeBytes) }), /저장 용량/);
});

// ---- Stage 6: applying approved proposals to real files, backups and restore ----
const backupOf = (f, id) => path.join(f.room.root, 'data/task-backups', f.ids.projectId, `${id}.bak`);
const approved = async (f) => { const id = (await f.generate()).proposals.at(-1).id; await f.decide(id, 'approved'); return id; };
const prepare = (f, id, kind = 'apply', expected = 200) => f.post('/api/tasks/proposals', { action: `${kind}.prepare`, ...f.ids, id }, expected);
const run = (f, id, confirmId, kind = 'apply', expected = 200) => f.post('/api/tasks/proposals', { action: kind, ...f.ids, id, confirmId }, expected);
const temps = (f) => fs.readdirSync(f.root).filter((name) => name.startsWith('.chatroom-'));
async function tamper(f, change) {
  const file = path.join(f.room.root, 'data/task-proposals.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(data.proposals);
  fs.writeFileSync(file, JSON.stringify(data));
  await f.room.reopen();
}

test('an approved proposal changes the real file only after final confirmation, with backup, verification and restore across restarts', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'code.js'), originalBytes = fs.readFileSync(file);
  const id = (await f.generate()).proposals[0].id;
  await prepare(f, id, 'apply', 409); // not approved: no confirmation is issued
  await run(f, id, randomUUID(), 'apply', 409);
  await f.decide(id, 'approved');
  await run(f, id, undefined, 'apply', 400); // approved, but no final confirmation
  const ready = await prepare(f, id);
  assert.equal(ready.confirmation.path, 'code.js');
  assert.equal(ready.confirmation.added, 1); assert.equal(ready.confirmation.removed, 1);
  assert.equal(ready.confirmation.beforeHash, sha(originalBytes)); assert.equal(ready.confirmation.afterHash, sha(Buffer.from(after)));
  assert.deepEqual(fs.readFileSync(file), originalBytes, 'preparing the confirmation never writes');
  assert.equal(fs.existsSync(path.join(f.room.root, 'data/task-backups')), false);

  const applied = await run(f, id, ready.confirmation.confirmId);
  assert.equal(applied.status, 'applied'); assert.equal(applied.fileState, 'after');
  assert.equal(fs.readFileSync(file, 'utf8'), after);
  assert.equal(sha(fs.readFileSync(file)), applied.afterHash);
  assert.equal(applied.outcome.beforeHash, sha(originalBytes)); assert.equal(applied.outcome.afterHash, sha(Buffer.from(after)));
  assert.deepEqual(fs.readFileSync(backupOf(f, id)), originalBytes, 'backup holds the exact original bytes');
  assert.equal(applied.backup.hash, sha(originalBytes));
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['.env', 'code.js', 'other.txt']);
  assert.equal(fs.readFileSync(path.join(f.root, 'other.txt'), 'utf8'), 'UNSELECTED-CONTENT');
  assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), 'SECRET-CONTENT');

  const again = await run(f, id, ready.confirmation.confirmId);
  assert.equal(again.replayed, true); assert.equal(again.history.length, 1, 'a resent request is not applied twice');
  await f.room.reopen();
  let detail = await f.detail(id);
  assert.equal(detail.status, 'applied'); assert.equal(detail.history[0].result, 'succeeded'); assert.equal(detail.fileState, 'after');

  const restoreReady = await prepare(f, id, 'restore');
  assert.equal(fs.readFileSync(file, 'utf8'), after, 'restore confirmation never writes');
  await run(f, id, ready.confirmation.confirmId, 'restore', 409); // an apply confirmation cannot restore
  const restored = await run(f, id, restoreReady.confirmation.confirmId, 'restore');
  assert.equal(restored.status, 'restored');
  assert.deepEqual(fs.readFileSync(file), originalBytes);
  assert.equal(sha(fs.readFileSync(file)), restored.beforeHash);
  assert.equal(restored.outcome.afterHash, sha(originalBytes));
  await f.room.reopen();
  detail = await f.detail(id);
  assert.equal(detail.status, 'restored');
  assert.deepEqual(detail.history.map((h) => [h.kind, h.result]), [['apply', 'succeeded'], ['restore', 'succeeded']]);
  await prepare(f, id, 'apply', 409);
  await prepare(f, id, 'restore', 409);
  assert.equal(f.room.calls.length, 0, 'ordinary chat CLI was not invoked');
});

test('original changes block application, and edits made after applying block restore overwrites', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'code.js');
  let id = await approved(f);
  fs.writeFileSync(file, original + '// edited before apply\n');
  await prepare(f, id, 'apply', 409);
  assert.equal((await f.detail(id)).status, 'conflict');

  fs.writeFileSync(file, original);
  id = await approved(f);
  const ready = await prepare(f, id);
  fs.writeFileSync(file, original + '// edited after confirmation\n');
  await run(f, id, ready.confirmation.confirmId, 'apply', 409);
  assert.equal(fs.readFileSync(file, 'utf8'), original + '// edited after confirmation\n');
  assert.equal((await f.detail(id)).status, 'conflict');
  assert.equal(fs.existsSync(backupOf(f, id)), false);

  fs.writeFileSync(file, original);
  id = await approved(f);
  await run(f, id, (await prepare(f, id)).confirmation.confirmId);
  const userEdit = after + '// user edit after apply\n';
  fs.writeFileSync(file, userEdit);
  await prepare(f, id, 'restore', 409);
  fs.writeFileSync(file, after);
  const restoreReady = await prepare(f, id, 'restore');
  fs.writeFileSync(file, userEdit);
  await run(f, id, restoreReady.confirmation.confirmId, 'restore', 409);
  assert.equal(fs.readFileSync(file, 'utf8'), userEdit, 'a re-edited file is never overwritten');
  const detail = await f.detail(id);
  assert.equal(detail.status, 'applied'); assert.equal(detail.fileState, 'changed');
  assert.equal(detail.history.at(-1).kind, 'restore'); assert.equal(detail.history.at(-1).result, 'blocked');
  assert.deepEqual(temps(f), []);
});

test('duplicate clicks, resent requests and competing proposals for one file write at most once', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'code.js');
  const first = await approved(f), second = await approved(f);
  const local = new ProposalStore(new TaskStore(path.join(f.room.root, 'data')));
  const busy = local.data.proposals.find((p) => p.id === first);
  Object.assign(busy, { status: 'applying', operation: { kind: 'apply', confirmId: randomUUID(), tempName: `.chatroom-${randomUUID()}.tmp`, startedAt: 1 } });
  assert.throws(() => local.prepareApply({ ...f.ids, id: second }), (e) => e.status === 409 && /진행 중/.test(e.message));

  const a = await prepare(f, first), b = await prepare(f, first), c = await prepare(f, second);
  const send = (id, confirmId) => fetch(f.room.base + '/api/tasks/proposals', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: f.room.base }, body: JSON.stringify({ action: 'apply', ...f.ids, id, confirmId }) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  const results = await Promise.all([send(first, a.confirmation.confirmId), send(first, a.confirmation.confirmId),
    send(first, b.confirmation.confirmId), send(second, c.confirmation.confirmId)]);
  assert.equal(results.filter((r) => r.status === 200 && !r.body.replayed).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.ok(results.every((r) => r.status === 200 || r.status === 409));
  assert.equal(fs.readFileSync(file, 'utf8'), after);
  const history = [...(await f.detail(first)).history, ...(await f.detail(second)).history];
  assert.equal(history.filter((h) => h.result === 'succeeded').length, 1);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['.env', 'code.js', 'other.txt']);
});

test('permission, backup, replacement and record failures keep originals intact or recoverable, including after restarts', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'code.js'), realFile = fs.realpathSync(file).toLowerCase(), originalBytes = fs.readFileSync(file);
  const id = await approved(f);
  const rename = fs.renameSync;

  fs.chmodSync(file, 0o444);
  let failed = await run(f, id, (await prepare(f, id)).confirmation.confirmId, 'apply', 403);
  assert.match(failed.error, /읽기 전용|권한/);
  fs.chmodSync(file, 0o666);
  let detail = await f.detail(id);
  assert.equal(detail.status, 'apply_failed'); assert.equal(detail.fileState, 'before');
  assert.match(detail.history.at(-1).recoverable, /변경되지 않았습니다/);
  assert.deepEqual(fs.readFileSync(file), originalBytes);

  const backups = path.join(f.room.root, 'data/task-backups');
  fs.writeFileSync(backups, 'not a directory');
  failed = await run(f, id, (await prepare(f, id)).confirmation.confirmId, 'apply', 500);
  assert.match(failed.error, /백업/);
  fs.rmSync(backups);
  assert.deepEqual(fs.readFileSync(file), originalBytes);
  assert.deepEqual(temps(f), []);

  const lock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(to).toLowerCase() === realFile) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rename(from, to);
  });
  failed = await run(f, id, (await prepare(f, id)).confirmation.confirmId, 'apply', 409);
  lock.mock.restore();
  assert.match(failed.error, /사용 중/);
  assert.deepEqual(fs.readFileSync(file), originalBytes);
  assert.deepEqual(temps(f), [], 'the temp file is removed when the swap fails');
  assert.equal((await f.detail(id)).status, 'apply_failed');

  const record = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to.endsWith('task-proposals.json') && fs.readFileSync(file, 'utf8') === after) throw Object.assign(new Error('disk'), { code: 'EIO' });
    return rename(from, to);
  });
  failed = await run(f, id, (await prepare(f, id)).confirmation.confirmId, 'apply', 500);
  record.mock.restore();
  assert.match(failed.error, /결과 기록을 저장하지 못했습니다/);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
  await f.room.reopen();
  detail = await f.detail(id);
  assert.equal(detail.status, 'apply_failed'); assert.equal(detail.fileState, 'after');
  assert.match(detail.history.at(-1).message, /재시작/);
  assert.equal(detail.backup.hash, sha(originalBytes));
  await run(f, id, (await prepare(f, id, 'restore')).confirmation.confirmId, 'restore');
  assert.deepEqual(fs.readFileSync(file), originalBytes);

  const next = await approved(f);
  const temp = `.chatroom-${randomUUID()}.tmp`;
  fs.writeFileSync(path.join(f.root, temp), 'partial');
  await tamper(f, (list) => {
    Object.assign(list.find((p) => p.id === next), { status: 'applying', operation: { kind: 'apply', confirmId: randomUUID(), tempName: temp, startedAt: 1 } });
  });
  detail = await f.detail(next);
  assert.equal(detail.status, 'apply_failed'); assert.equal(detail.fileState, 'before');
  assert.deepEqual(temps(f), [], 'startup removes the interrupted temp file');
  assert.deepEqual(fs.readFileSync(file), originalBytes);
  assert.equal((await run(f, next, (await prepare(f, next)).confirmation.confirmId)).status, 'applied');
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

test('requests cannot choose paths or contents, and stored targets outside the policy are never written', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'code.js');
  const id = await approved(f);
  for (const extra of [{ path: '../outside.txt' }, { after: 'owned' }, { content: 'x' }, { folderPath: f.room.root }]) {
    await f.post('/api/tasks/proposals', { action: 'apply.prepare', ...f.ids, id, ...extra }, 400);
    await f.post('/api/tasks/proposals', { action: 'apply', ...f.ids, id, confirmId: randomUUID(), ...extra }, 400);
  }
  const ready = await prepare(f, id);
  const denied = await fetch(f.room.base + '/api/tasks/proposals', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'apply', ...f.ids, id, confirmId: ready.confirmation.confirmId }) });
  assert.equal(denied.status, 403);
  assert.equal(fs.readFileSync(file, 'utf8'), original);

  const outside = path.join(f.room.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'code.js'), original);
  fs.symlinkSync(outside, path.join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.linkSync(path.join(outside, 'code.js'), path.join(f.root, 'hard.js'));
  fs.writeFileSync(path.join(f.root, '.env'), original);
  const root = fs.realpathSync(f.root);
  const targets = ['../outside/code.js', 'link/code.js', '.env', 'hard.js', path.join(outside, 'code.js').replaceAll('\\', '/')];
  for (const target of targets) {
    assert.throws(() => replaceTaskTextFile(root, target, { expectedHash: sha(original), content: Buffer.from('owned'), tempName: `.chatroom-${randomUUID()}.tmp` }),
      (e) => e.status === 403 && !e.replaced, target);
    await tamper(f, (list) => { Object.assign(list.find((p) => p.id === id), { path: target, status: 'approved' }); });
    await prepare(f, id, 'apply', 409);
    assert.equal((await f.detail(id)).status, 'conflict');
  }
  await tamper(f, (list) => { Object.assign(list.find((p) => p.id === id), { path: 'code.js', status: 'approved' }); });
  await f.post('/api/tasks', { action: 'folder.disconnect', projectId: f.ids.projectId });
  await prepare(f, id, 'apply', 409);
  assert.equal(fs.readFileSync(path.join(outside, 'code.js'), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), original);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.room.root, 'data/task-backups')), false);
  assert.deepEqual(temps(f), []);
});
