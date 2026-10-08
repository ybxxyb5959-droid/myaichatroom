import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { House, HOUSE_LIMITS, USES } from '../lib/house.mjs';
import { projectProgress, validateDesign } from '../lib/house-project.mjs';
import { isComplete, snapshot, markUndo, undo } from '../lib/life.mjs';
import { roomFixture } from './helpers/room.mjs';

const options = { ids: ['claude', 'gpt', 'gemini'], names: { claude: 'Claude', gpt: 'GPT', gemini: 'Gemini' } };
const design = (owner = 'gpt') => ({ title: '책을 읽는 작은 공간', rooms: [
  { name: '독서방', x1: 2, z1: 2, x2: 5, z2: 4, owner, min: 1, uses: ['read'] },
], corridors: [{ x1: 2, z1: 5, x2: 2, z2: 7 }], walls: [], doors: [], entry: [2, 7] });
function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-planning-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = new House(path.join(root, 'house.json'), options);
  h.s.planning = { design: null, pending: null, nextId: 1, feedback: '' };
  return h;
}

test('a sole AI chooses its own rooms and goals; progress follows real saved work, not fixed rooms or a done claim', (t) => {
  const h = home(t);
  h.s.floors['20,20'] = 'blue';
  const before = snapshot(h);
  assert.equal(h.view(['gpt']).progress.percent, null);
  assert.equal(isComplete(h), false);
  const result = h.apply('gpt', { say: '혼자서 독서방을 만들게', design: design(), plan: '독서방 바닥부터' }, 1, ['gpt']);
  assert.equal(result.planChanged, true); assert.deepEqual(result.errors, []);
  assert.deepEqual(h.s.floors, before.floors, 'a plan never erases or constructs the existing home');
  assert.equal(h.view(['gpt']).progress.rooms.length, 1);
  assert.equal(h.view(['gpt']).progress.percent, 0);
  h.apply('gpt', { say: '다 완성했다고 말해도 실제 작업이 기준', actions: [] }, 2, ['gpt']);
  assert.equal(isComplete(h), false);
  h.apply('gpt', { say: '책장을 놓았어', actions: [
    { type: 'floor', x1: 2, z1: 2, x2: 5, z2: 4, color: 'wood' },
    { type: 'floor', x1: 2, z1: 5, x2: 2, z2: 7, color: 'wood' },
    { type: 'define', name: '책장', use: 'read', parts: [{ s: 'box', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, c: 'wood' }] },
    { type: 'place', def: '책장', x: 4, z: 3 },
  ] }, 3, ['gpt']);
  assert.equal(isComplete(h), true);
  assert.equal(projectProgress(h, ['gpt']).percent, 100);
  assert.equal(h.s.floors['20,20'], 'blue');
  assert.deepEqual(new House(h.file, options).s.planning.design, h.s.planning.design);
  delete h.s.floors['2,6'];
  assert.equal(isComplete(h), false, 'the actual connecting passage remains required');
});

test('multiple AIs review an actual proposal, cannot self-approve, and cannot build an unapproved new design', (t) => {
  const h = home(t), team = ['gpt', 'claude'];
  h.apply('gpt', { say: '이런 독서방은 어때?', design: design(), actions: [{ type: 'floor', x1: 2, z1: 2, x2: 3, z2: 3, color: 'wood' }] }, 1, team);
  assert.equal(h.s.planning.design, null); assert.deepEqual(h.s.floors, {});
  const id = h.s.planning.pending.id;
  assert.ok(h.apply('gpt', { say: '내가 승인', designDecision: { id, choice: 'approve' } }, 2, team).errors.length);
  assert.equal(h.s.planning.design, null);
  const result = h.apply('claude', { say: '통로가 연결되어 있으니 이 안으로 하자', designDecision: { id, choice: 'approve' } }, 3, team);
  assert.equal(result.planChanged, true); assert.equal(h.s.planning.pending, null);
  assert.equal(h.s.planning.design.rooms.length, 1);
  assert.ok(h.apply('claude', { say: '이전 ID 재사용', designDecision: { id, choice: 'approve' } }, 4, team).errors.length);
});

test('absent owners are delegated only to current participants, without changing furniture authorship or fabricating approvals', (t) => {
  const h = home(t);
  h.apply('claude', { say: '독서방을 맡을게', design: design('claude') }, 1, ['claude']);
  h.s.defs['기존 책장'] = { by: 'claude', parts: [{ s: 'box', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, c: 'wood' }] };
  const stored = structuredClone(h.s.planning.design);
  assert.ok(h.view(['gpt']).progress.rooms.every(r => r.owner === 'gpt'));
  assert.ok(h.view([]).progress.rooms.every(r => r.owner === null));
  const prompt = h.prompt('gpt', { resting: ['claude', 'gemini'] });
  assert.match(prompt, /현재 작업 가능한 참가 AI 1명/);
  assert.match(prompt, /지금은 GPT 혼자다/);
  assert.match(prompt, /"owner":"gpt"/);
  assert.doesNotMatch(prompt, /"owner":"claude"/);
  assert.deepEqual(h.s.planning.design, stored);
  assert.equal(h.s.defs['기존 책장'].by, 'claude');
  assert.ok(h.view(['claude', 'gpt']).progress.rooms.every(r => r.owner === 'claude'));
});

test('unsafe AI room plans are rejected without changing the accepted plan or existing geometry', (t) => {
  const h = home(t); h.apply('gpt', { say: '진행하자', design: design() }, 1, ['gpt']);
  h.s.floors['8,8'] = 'blue';
  const original = structuredClone(h.s.planning.design);
  const bad = [
    { ...design(), entry: [30, 30] },
    { ...design(), rooms: [{ ...design().rooms[0], x2: 32 }] },
    { ...design(), rooms: [{ ...design().rooms[0], owner: 'claude' }] },
    { ...design(), rooms: [design().rooms[0], { ...design().rooms[0], name: '겹치는 방' }] },
    { ...design(), walls: [[2, 3, 5, 3]] },
    { ...design(), doors: [[1, 1]] },
    { ...design(), rooms: [{ ...design().rooms[0], min: 101 }] },
    { ...design(), corridors: [{ x1: 25, z1: 25, x2: 25, z2: 26 }] },
  ];
  for (const proposal of bad) {
    assert.throws(() => validateDesign(proposal, ['gpt'], HOUSE_LIMITS, USES));
    const result = h.apply('gpt', { say: '설계를 바꿔 볼게', design: proposal, actions: [{ type: 'erase', x: 8, z: 8 }] }, 2, ['gpt']);
    assert.ok(result.errors.length);
    assert.deepEqual(h.s.planning.design, original);
    assert.equal(h.s.floors['8,8'], 'blue');
  }
});

test('undo restores both the AI goals and the house, with live role assignment derived afterwards', (t) => {
  const h = home(t); h.apply('gpt', { say: '독서방으로', design: design() }, 1, ['gpt']);
  const before = snapshot(h), original = structuredClone(h.s.planning.design);
  h.apply('gpt', { say: '소파도 추가하자', design: { ...design(), title: '책과 휴식', rooms: [{ ...design().rooms[0], min: 2, uses: ['read', 'sit'] }] } }, 2, ['gpt']);
  markUndo(h, before, 'gpt', '목표 변경', 2);
  undo(h, 3);
  assert.deepEqual(h.s.planning.design, original);
  assert.equal(h.s.plan, before.plan);
});

test('the live runtime preserves legacy homes, drops stale-roster replies, and includes the current solo participant in the next call', async (t) => {
  let release, first = true;
  const s = await roomFixture(t, { ids: ['gpt', 'claude'], seed(store) {
    const h = new House(path.join(store.dataDir, 'house.json'), { ...options, rebuild: true });
    h.s.floors['20,20'] = 'wood'; h.s.plan = '예전에는 Claude가 담당'; h.save();
  }, discussionReply: () => {
    if (first) { first = false; return new Promise(resolve => { release = resolve; }); }
    return { ok: true, text: JSON.stringify({ say: '혼자서 이어갈게', design: design() }) };
  } });
  assert.equal(s.app.house.s.floors['20,20'], 'wood');
  assert.equal(s.app.house.s.planning.previousPlan, '예전에는 Claude가 담당');
  assert.equal(s.app.houseRuntime.view().progress.stage, 'planning');
  await s.start(); s.app.houseRuntime.nextActor = 'gpt';
  const running = s.app.houseRuntime.tick();
  s.app.runtime.setEnabled('claude', false);
  release({ ok: true, text: JSON.stringify({ say: 'Claude가 다음에 해줘', design: design() }) });
  await running;
  assert.equal(s.app.house.s.planning.design, null);
  assert.ok(!s.app.store.messages.some(m => m.text === 'Claude가 다음에 해줘'));
  await s.post('/api/house/continue-solo', {});
  await s.app.houseRuntime.tick();
  assert.equal(s.calls.length, 2);
  assert.match(s.calls[1].prompt, /현재 작업 가능한 참가 AI 1명/);
  assert.ok(s.app.houseRuntime.view().progress.rooms.every(r => r.owner === 'gpt'));
  assert.equal(s.app.house.s.floors['20,20'], 'wood');
});
