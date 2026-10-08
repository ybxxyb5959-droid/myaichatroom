import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { House } from '../lib/house.mjs';
import { acceptProposal, advanceVotes, settleVote } from '../lib/house-votes.mjs';
import { roomAt, workerPath } from '../public/house-view.mjs';
import { dayKey } from '../lib/auto.mjs';
import { roomFixture } from './helpers/room.mjs';

const options = { ids: ['claude', 'gpt', 'gemini'], names: { claude: 'Claude', gpt: 'ChatGPT', gemini: 'Gemini' } };
function seed(h) {
  h.apply('claude', { say: '기존 가구 배치',
    design: { title: '소파 배치', rooms: [{ name: '거실', owner: 'claude', x1: 1, z1: 1, x2: 6, z2: 6, min: 1, uses: ['sit'] }], entry: [1, 1] },
    actions: [
    { type: 'floor', x1: 1, z1: 1, x2: 6, z2: 6, color: 'wood' },
    { type: 'define', name: '소파', use: 'sit', parts: [{ s: 'box', x: 0, y: 0, z: 0, w: 1, h: .5, d: 1, c: 'blue' }] },
    { type: 'place', def: '소파', x: 2, z: 2 },
  ] }, 1, ['claude']);
}
function make(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-simulation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = new House(path.join(root, 'house.json'), options); seed(h); return h;
}
const move = (x, z = 3) => [{ type: 'relocate', itemId: 1, x, z, rot: 0 }];
function propose(h, now) {
  assert.equal(acceptProposal(h, 'claude', { say: '소파를 왼쪽에 두자', proposal: { label: '왼쪽 배치', actions: move(3) } }, now), true);
  return h.s.decorProposal.id;
}
function vote(h, now) {
  const id = propose(h, now);
  assert.equal(acceptProposal(h, 'gpt', { say: '나는 오른쪽이 좋아', counter: { proposalId: id, label: '오른쪽 배치', actions: move(4) } }, now + 1), true);
  return id;
}

test('relocation preserves furniture identity and rolls back invalid destinations', (t) => {
  const h = make(t), original = structuredClone(h.s.items[0]), nextId = h.s.nextId;
  assert.equal(h.apply('gpt', { actions: move(4) }, 2).errors.length, 0);
  assert.equal(h.s.items[0].id, original.id); assert.equal(h.s.items[0].by, 'claude');
  assert.equal(h.s.items[0].lastBy, 'gpt'); assert.equal(h.s.nextId, nextId);
  const before = structuredClone(h.s.items);
  assert.equal(h.apply('gpt', { actions: move(25) }, 3).errors.length, 1);
  assert.deepEqual(h.s.items, before); assert.equal(h.s.nextId, nextId);
});

test('a vote requires actual speech by two distinct AIs, and equivalent options do not create a conflict', (t) => {
  const h = make(t), id = propose(h, 1000);
  assert.equal(acceptProposal(h, 'claude', { say: '반대', counter: { proposalId: id, label: '대안', actions: move(4) } }, 1001), false);
  assert.equal(acceptProposal(h, 'gpt', { counter: { proposalId: id, label: '대안', actions: move(4) } }, 1002), false);
  assert.equal(acceptProposal(h, 'gpt', { say: '같은 안', counter: { proposalId: id, label: '같음', actions: [{ ...move(3)[0], rot: 4 }] } }, 1003), false);
  assert.equal(h.s.decorVote, null);
  assert.throws(() => acceptProposal(h, 'gpt', { say: '밖으로', counter: { proposalId: id, label: '잘못된 안', actions: move(30) } }, 1004));
  assert.deepEqual([h.s.items[0].x, h.s.items[0].z], [2, 2]);
});

test('votes persist, apply the chosen real placement once, and preserve undo state', (t) => {
  let h = make(t); const id = vote(h, 1000); h.save();
  h = new House(h.file, options);
  settleVote(h, id, 1, 1002);
  assert.deepEqual([h.s.items[0].x, h.s.items[0].z], [4, 3]);
  assert.equal(h.s.decorVote.status, 'applied');
  assert.equal(h.s.undo.before.items[0].x, 2);
  assert.throws(() => settleVote(h, id, 0, 1003), /이미/);
  assert.equal(new House(h.file, options).s.items[0].x, 4);
  assert.equal(acceptProposal(h, 'gemini', { say: '또', proposal: { label: '반복', actions: move(5) } }, 1004), false);
});

test('abstention proceeds automatically without claiming AI agreement; changed targets expire safely', (t) => {
  const h = make(t); vote(h, 1000);
  assert.equal(advanceVotes(h, 302000), true);
  assert.equal(h.s.items[0].x, 3);
  assert.match(h.s.decorVote.result, /기본안 자동 적용/);
  assert.equal(advanceVotes(h, 303000), false);
  const other = make(t); vote(other, 1000);
  other.apply('gemini', { actions: move(5) }, 2000);
  settleVote(other, other.s.decorVote.id, 1, 3000);
  assert.equal(other.s.decorVote.status, 'expired'); assert.equal(other.s.items[0].x, 5);
});

test('autonomous mode, proposal expiry, vote cooldown and daily vote limit need no model calls', (t) => {
  const h = make(t); h.s.mode = 'auto'; vote(h, 1000);
  assert.equal(h.s.decorVote.status, 'applied');
  const other = make(t); propose(other, 1000);
  advanceVotes(other, 302000); assert.equal(other.s.items[0].x, 3);
  other.s.voteMeta.day = new Date(302001).toLocaleDateString('en-CA'); other.s.voteMeta.count = 3;
  assert.equal(acceptProposal(other, 'gpt', { say: '새 제안', proposal: { label: '다음', actions: move(4) } }, 302001), false);
});

test('failed vote persistence restores in-memory layout and keeps a vote retryable', (t) => {
  const h = make(t), id = vote(h, 1000), before = structuredClone(h.s);
  h.save = () => { throw new Error('disk failure'); };
  assert.throws(() => settleVote(h, id, 1, 1002), /disk failure/);
  assert.deepEqual(h.s, before);
});

test('room picking respects boundaries and visual workers do not route through walls or furniture', () => {
  const rooms = [{ x1: 1, z1: 1, x2: 3, z2: 3 }];
  assert.equal(roomAt(rooms, 3.99, 2), 0); assert.equal(roomAt(rooms, 4, 2), -1);
  const data = { floors: [], walls: [[2, 1, 'white', false]], defs: {}, items: [] };
  for (let x = 1; x <= 4; x++) for (let z = 1; z <= 3; z++) data.floors.push([x, z, 'wood']);
  const route = workerPath(data, { x: 1.5, z: 1.5 }, { x: 3.5, z: 1.5 });
  assert.ok(route.length > 2);
  assert.ok(route.every((p) => !(p.x === 2.5 && p.z === 1.5)));
  assert.deepEqual(route.at(-1), { x: 3.5, z: 1.5 });
});

test('house work has no interval or daily quota, retains sequential calls, and OFF blocks new calls', async (t) => {
  let finish;
  const s = await roomFixture(t, { ids: ['gpt'], discussionReply: () => new Promise((resolve) => { finish = resolve; }) });
  await s.start();
  await s.post('/api/house/continue-solo', {});
  s.app.store.state.houseUsage = { day: dayKey(s.clock.now), calls: 1000 };
  const first = s.app.houseRuntime.tick();
  await s.app.houseRuntime.tick();
  assert.equal(s.calls.length, 1);
  finish({ ok: true, text: '{"say":"작업 계속","actions":[]}' }); await first;
  const second = s.app.houseRuntime.tick();
  assert.equal(s.calls.length, 2);
  finish({ ok: true, text: '{"say":"다음 작업","actions":[]}' }); await second;
  assert.equal(s.app.store.state.houseUsage.calls, 1002);
  assert.ok(s.app.store.messages.some((m) => m.kind === 'house-say'), 'shared chat is deliberately retained');
  assert.ok(s.app.house.s.log.some((m) => m.source === 'ai' && m.speechId));
  await s.post('/api/room', { auto: { on: false } });
  await s.post('/api/house/active', { active: false });
  await s.app.houseRuntime.tick(); assert.equal(s.calls.length, 2);
});

test('failed house calls keep bounded backoff rather than an unbounded retry loop', async (t) => {
  const s = await roomFixture(t, { ids: ['gpt'], discussionReply: () => ({ ok: false, detail: 'offline' }) });
  await s.start(); await s.post('/api/house/continue-solo', {}); await s.app.houseRuntime.tick();
  assert.equal(s.app.houseRuntime.buildAt, s.clock.now + 20000);
  await s.app.houseRuntime.tick(); assert.equal(s.calls.length, 1);
  s.clock.now += 20000; await s.app.houseRuntime.tick();
  assert.equal(s.app.houseRuntime.buildAt, s.clock.now + 40000);
});

test('vote API changes the house without AI calls, repeated clicks or main-chat messages', async (t) => {
  const s = await roomFixture(t); seed(s.app.house);
  const id = vote(s.app.house, s.clock.now), messages = s.app.store.messages.length;
  const result = await s.post('/api/house/vote', { voteId: id, choice: 1 });
  assert.equal(result.status, 200); assert.equal(result.value.items[0].x, 4);
  assert.equal(s.calls.length, 0); assert.equal(s.app.store.messages.length, messages);
  assert.equal((await s.post('/api/house/vote', { voteId: id, choice: 0 })).status, 409);
  await s.reopen(); assert.equal(s.app.house.s.items[0].x, 4);
});
