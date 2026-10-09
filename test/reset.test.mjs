import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { roomFixture } from './helpers/room.mjs';

// Fill every place a reset can touch, so each test can check what was cleared and what stayed.
async function seeded(t) {
  const s = await roomFixture(t);
  await s.send('안녕 다들');
  s.app.runtime.post({ from: 'gpt', text: '반가워 방장!' });
  s.app.store.writeNote('claude', '방장은 반말을 좋아함');
  s.app.room.bios.claude = '단톡방 분위기 메이커';
  const h = s.app.house.s;
  h.floors['2,2'] = 'wood';
  h.log.push({ kind: 'say', id: 'claude', text: '거실부터 짓자', at: s.clock.now });
  h.relations['claude|gpt'] = 70;
  h.events.push({ id: 1, at: s.clock.now, type: 'chat', tone: 'positive', actors: ['claude', 'gpt'], text: '같이 웃었다' });
  s.app.house.save();
  s.app.play.data.polls.p1 = { id: 'p1', question: '저녁 뭐 먹지?', options: ['피자', '치킨'], ballots: {}, by: 'owner', status: 'open' };
  s.app.play.save();
  fs.writeFileSync(path.join(s.root, 'workspace', 'poem.md'), '시');
  return s;
}

test('reset asks for the typed confirmation and at least one item', async (t) => {
  const s = await seeded(t);
  const count = s.app.store.messages.length;
  assert.equal((await s.post('/api/reset', { items: { chat: true } })).status, 400);
  assert.equal((await s.post('/api/reset', { items: {}, confirm: '초기화' })).status, 400);
  assert.equal(s.app.store.messages.length, count, 'nothing is cleared without a valid request');
});

test('the default reset clears chat, AI memory and house history, keeps the rest, and backs everything up first', async (t) => {
  const s = await seeded(t);
  const lastId = s.app.store.messages.at(-1).id;
  const r = await s.post('/api/reset', { items: { chat: true, memory: true, houseLog: true }, confirm: '초기화' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.value.items, ['chat', 'memory', 'houseLog']);
  // Chat: only the reset notice is left, and its id continues from the old history.
  assert.equal(s.app.store.messages.length, 1);
  const notice = s.app.store.messages[0];
  assert.match(notice.text, /^채팅방을 새로 시작했어요/);
  assert.ok(notice.id > lastId);
  assert.equal(s.app.activity.entries.length, 0);
  // Memory: notes and self-introductions are empty.
  assert.equal(s.app.store.readNote('claude'), '');
  assert.equal(s.app.room.bios.claude, '');
  // House history is gone, the building stays.
  const h = s.app.house.s;
  assert.deepEqual([h.log.length, h.events.length, Object.keys(h.relations).length], [0, 0, 0]);
  assert.equal(h.floors['2,2'], 'wood');
  // Unchosen parts are untouched.
  assert.ok(s.app.play.data.polls.p1);
  assert.ok(fs.existsSync(path.join(s.root, 'workspace', 'poem.md')));
  // The backup holds the old chat, memory and house.
  const backup = path.join(s.root, r.value.backup);
  assert.match(fs.readFileSync(path.join(backup, 'data', 'messages.jsonl'), 'utf8'), /반가워 방장!/);
  assert.equal(fs.readFileSync(path.join(backup, 'data', 'notes', 'claude.md'), 'utf8'), '방장은 반말을 좋아함');
  assert.match(fs.readFileSync(path.join(backup, 'data', 'house.json'), 'utf8'), /거실부터 짓자/);
  // A restart keeps the empty history and the id counter.
  await s.reopen();
  assert.deepEqual(s.app.store.messages.map((m) => m.id), [notice.id]);
  const next = await s.send('다시 시작!');
  assert.ok(next.id > notice.id);
});

test('tearing the house down also clears its history; play and workspace clear only when chosen', async (t) => {
  const s = await seeded(t);
  const r = await s.post('/api/reset', { items: { houseBuild: true, play: true, workspace: true }, confirm: '초기화' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.value.items, ['houseLog', 'houseBuild', 'play', 'workspace']);
  const h = s.app.house.s;
  assert.deepEqual([Object.keys(h.floors).length, h.log.length, h.phase], [0, 0, 'build']);
  assert.ok(h.agents.claude && Number.isFinite(h.agents.claude.x));
  assert.deepEqual(s.app.play.data.polls, {});
  assert.equal(fs.existsSync(path.join(s.root, 'workspace', 'poem.md')), false);
  assert.ok(fs.existsSync(path.join(s.root, r.value.backup, 'workspace', 'poem.md')), 'the workspace is backed up before it is cleared');
  // Chat and memory were not chosen: the old messages stay and a notice is added.
  assert.ok(s.app.store.messages.some((m) => m.text === '안녕 다들'));
  assert.equal(s.app.store.readNote('claude'), '방장은 반말을 좋아함');
  assert.match(s.app.store.messages.at(-1).text, /초기화했어요\.$/);
});
