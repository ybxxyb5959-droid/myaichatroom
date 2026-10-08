import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { House } from '../lib/house.mjs';
import { advanceStory, cast, counts, storyPrompt } from '../lib/house-story.mjs';
import { acceptProposal, advanceVotes } from '../lib/house-votes.mjs';

function house(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'house-beta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new House(path.join(dir, 'house.json'), { ids: ['gpt', 'claude', 'gemini'], names: {} });
}
test('shared episode records one ballot per human/AI, persists reconnects and applies majority once', t => {
  let h = house(t);
  const humans = ['owner', 'friend'], ai = h.ids;
  advanceStory(h, 100, humans, ai);
  const v = h.s.story.current, allowed = { humans, ai };
  cast(v, 'human:owner', 1, 101, allowed);
  cast(v, 'human:friend', 1, 102, allowed);
  cast(v, 'ai:gpt', 0, 103, { ...allowed, opinion: '정원을 선택할게' });
  assert.throws(() => cast(v, 'human:friend', 0, 104, allowed), /이미 투표/);
  assert.throws(() => cast(v, 'human:intruder', 0, 104, allowed), /접속/);
  h.save(); h = new House(h.file, { ids: ai, names: {} });
  assert.deepEqual(counts(h.s.story.current), [1, 2]);
  assert.throws(() => cast(h.s.story.current, 'human:owner', 0, 105, allowed), /이미 투표/);
  assert.throws(() => cast(h.s.story.current, 'ai:claude', 0, v.deadline, allowed), /마감/);
  assert.ok(advanceStory(h, v.deadline, humans, ai)); h.save();
  assert.equal(h.s.story.environment.yard, 'bbq');
  assert.equal(h.s.story.history.length, 1);
  assert.equal(advanceStory(h, v.deadline + 1, humans, ai), false);
  assert.equal(h.s.story.history.length, 1);
  assert.match(storyPrompt(h), /bbq/);
});
test('no humans preserves autonomy; ties choose declared A and prior environment changes later episodes', t => {
  const h = house(t);
  assert.equal(advanceStory(h, 1, [], h.ids), false);
  advanceStory(h, 2, ['owner'], h.ids);
  const v = h.s.story.current;
  advanceStory(h, v.deadline, [], h.ids);
  assert.equal(h.s.story.environment.yard, 'garden');
  h.s.story.environment.roof = 30;
  advanceStory(h, h.s.story.nextAt, ['owner'], h.ids);
  assert.equal(h.s.story.current.key, 'rain');
  assert.deepEqual(h.s.story.current.ballots, {}, 'never synthesize AI choices');
});
test('real decor proposals seed only their authors; shared majority waits for deadline and commits once', t => {
  const h = house(t); h.s.mode = 'auto';
  h.s.floors = { '1,1': 'wood', '2,1': 'wood' };
  h.act('gpt', { type: 'define', name: 'chair', parts: [{ s: 'box', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, c: 'blue' }] });
  const actions = x => [{ type: 'place', def: 'chair', x, z: 1, rot: 0 }];
  assert.ok(acceptProposal(h, 'gpt', { say: '왼쪽에 놓자', proposal: { label: '왼쪽', actions: actions(1) } }, 1, ['owner', 'friend']));
  const id = h.s.decorProposal.id;
  acceptProposal(h, 'claude', { say: '오른쪽이 편해', counter: { proposalId: id, label: '오른쪽', actions: actions(2) } }, 2, ['owner', 'friend']);
  const v = h.s.decorVote;
  assert.equal(v.status, 'open'); assert.equal(h.s.items.length, 0);
  assert.equal(v.ballots['ai:gemini'], undefined);
  for (const user of ['owner', 'friend']) cast(v, `human:${user}`, 1, 3, { humans: ['owner', 'friend'], ai: h.ids });
  assert.equal(advanceVotes(h, v.deadline - 1), false);
  advanceVotes(h, v.deadline);
  assert.equal(h.s.items[0].x, 2); assert.equal(h.s.voteHistory.length, 1);
  assert.equal(advanceVotes(h, v.deadline + 1), false);
  assert.equal(h.s.items.length, 1);
});
