import test from 'node:test';
import assert from 'node:assert/strict';
import { discussionScene } from '../public/discussion-stage.mjs';

const room = (states, extra = {}) => ({
  discussion: true,
  enabled: { gpt: true, gemini: true, claude: true },
  active: states ? { id: 'run', mode: 'discussion', states } : null,
  ...extra,
});
const busy = (phase = 'opinion') => ({ status: '생성 중', phase });

test('stage appears on enabling discussion without an active call and hides on disabling', () => {
  assert.equal(discussionScene(room(null)).visible, true);
  assert.equal(discussionScene(room(null)).running, false);
  assert.equal(discussionScene(room(null)).speaker, null);
  assert.equal(discussionScene(room(null, { discussion: false })).visible, false);
});

test('spotlight stays with an actual generating member and transfers only when it finishes', () => {
  const states = { gpt: busy(), gemini: busy(), claude: busy() };
  assert.equal(discussionScene(room(states)).speaker, 'gpt');
  assert.equal(discussionScene(room(states), 'gemini').speaker, 'gemini');
  states.gpt = { status: '완료', phase: 'opinion' };
  assert.equal(discussionScene(room(states), 'gpt').speaker, 'gemini');
  states.gemini = { status: '실패', phase: 'opinion' };
  assert.equal(discussionScene(room(states), 'gemini').speaker, 'claude');
  states.claude = { status: '완료', phase: 'opinion' };
  assert.equal(discussionScene(room(states), 'claude').speaker, null);
  assert.equal(discussionScene(room(states)).running, false);
});

test('review and synthesis use real phases; excluded characters never speak', () => {
  const scene = discussionScene(room({ gpt: { status: '제외' }, gemini: busy('review'), claude: { status: '완료' } }));
  assert.equal(scene.speaker, 'gemini');
  assert.equal(scene.characters[0].muted, true);
  assert.equal(scene.characters[1].status, '서로 검토 중');
  assert.equal(scene.characters[1].phase, 'review');
  assert.equal(scene.characters[2].phase, 'idle');
  const final = discussionScene(room({ claude: busy('final') }), 'gemini');
  assert.equal(final.speaker, 'claude');
  assert.equal(final.characters[2].status, '최종 정리 중');
  assert.equal(final.characters[2].phase, 'final');
});

test('cancellation, completion and ordinary chat do not leave a thinking bubble', () => {
  for (const active of [null, { mode: 'chat', states: { gpt: busy() } }]) {
    const scene = discussionScene(room(null, { active }), 'gpt');
    assert.equal(scene.speaker, null);
    assert.equal(scene.running, false);
    assert.ok(scene.characters.every((character) => character.phase === 'idle'));
  }
  const scene = discussionScene(room({ gpt: busy() }, { discussion: false }));
  assert.equal(scene.visible, true);
  assert.equal(scene.characters[0].phase, 'opinion');
});
