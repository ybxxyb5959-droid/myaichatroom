import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoff, HANDOFF_MAX } from '../public/format.mjs';
import { quotaOf, recommendByQuota, quotaCheck, LOW_QUOTA } from '../public/status.mjs';

const nameOf = (id) => ({ gpt: 'GPT', claude: 'Claude', gemini: 'Gemini' }[id] || id);

test('a chat answer hands over its own question and the answers of that run only', () => {
  const messages = [
    { id: 1, from: 'user', text: '예전 질문: 점심 뭐 먹지?' },
    { id: 2, from: 'gpt', text: '김밥', runId: 'old', replyTo: 1 },
    { id: 3, from: 'user', text: '로그인 후 /home으로 가는 버그 어떻게 고쳐?' },
    { id: 4, from: 'gpt', text: 'navigate 경로를 /dashboard로 바꿔.', runId: 'r1', replyTo: 3, phase: 'answer', intent: 'work' },
    { id: 5, from: 'claude', text: '라우터 가드도 확인해.', runId: 'r1', replyTo: 3, phase: 'answer', intent: 'work' },
    { id: 6, from: 'system', text: '완료', runId: 'r1', kind: 'complete' },
  ];
  const text = buildHandoff(messages, 5, nameOf);
  assert.equal(text.split('\n')[0], '채팅에서 이어온 작업: 로그인 후 /home으로 가는 버그 어떻게 고쳐?', 'the first line names the task');
  assert.match(text, /\[사용자 질문\]\n로그인 후 \/home으로 가는 버그/);
  assert.match(text, /\[AI 답변 · GPT\]\nnavigate 경로를/);
  assert.match(text, /\[AI 답변 · Claude\]\n라우터 가드도/);
  assert.doesNotMatch(text, /점심|김밥|완료/);
  // A peer's follow-up reply walks back to the user's question.
  const reply = [...messages, { id: 7, from: 'gemini', text: '@claude 맞아', runId: 'r1', replyTo: 5 }];
  assert.match(buildHandoff(reply, 7, nameOf), /\[사용자 질문\]\n로그인 후/);
  assert.equal(buildHandoff(messages, 999, nameOf), '');
});

test('a discussion hands over the final summary first and short opinions, within the request limit', () => {
  const long = 'x'.repeat(30000);
  const messages = [
    { id: 10, from: 'user', text: `캐시 전략 정해줘 ${long}` },
    ...['gpt', 'claude', 'gemini'].map((id, i) => ({ id: 11 + i, from: id, text: `${id} 의견 ${long}`, runId: 'd1', replyTo: 10, phase: 'opinion', mode: 'discussion' })),
    { id: 14, from: 'gpt', text: '검토 내용', runId: 'd1', replyTo: 10, phase: 'review', mode: 'discussion' },
    { id: 15, from: 'claude', text: `# 결론\nRedis를 쓰자 ${long}`, runId: 'd1', replyTo: 10, phase: 'final', mode: 'discussion' },
  ];
  const text = buildHandoff(messages, 15, nameOf);
  assert.ok(text.length <= HANDOFF_MAX);
  assert.ok(text.indexOf('[최종 정리 · Claude]') < text.indexOf('[AI별 핵심 의견]'));
  assert.match(text, /- GPT: gpt 의견/); assert.match(text, /- Gemini: gemini 의견/);
  assert.doesNotMatch(text, /검토 내용/);
  assert.match(text, /이하 생략/);
  assert.match(text, /\[요청\]/);
});

test('usage is shown only when the report is fresh, and low or unknown shares are never guessed', () => {
  const now = Date.UTC(2026, 9, 7, 4);
  const report = (pcts, extra = {}) => ({ ok: true, at: now - 60000, windows: pcts.map(([id, used]) => ({ id, usedPct: used, remainingPct: 100 - used })), ...extra });
  assert.deepEqual(quotaOf('claude', report([['5h', 82], ['week', 40]]), now), { known: true, pct: 18, level: 'low', low: true });
  assert.deepEqual(quotaOf('gpt', report([['5h', 21]]), now), { known: true, pct: 79, level: 'ok', low: false });
  for (const bad of [undefined, null, report([['5h', 10]], { ok: false }), report([['5h', 10]], { restored: true }), report([['5h', 10]], { at: now - 31 * 60000 }), report([])]) {
    assert.deepEqual(quotaOf('gpt', bad, now), { known: false });
  }
  const usage = { claude: report([['5h', 82]]), gpt: report([['week', 21]]), gemini: report([['week', 37]]) };
  assert.deepEqual(recommendByQuota(['claude', 'gpt', 'gemini'], usage, now), { id: 'gpt', pct: 79 });
  assert.equal(recommendByQuota(['claude'], usage, now), null, 'a low share is never recommended');
  assert.equal(recommendByQuota(['gpt'], {}, now), null);
  assert.equal(LOW_QUOTA, 20);

  assert.equal(quotaCheck({ mode: 'solo', lead: 'gpt', usage, available: ['gpt'], now }), null);
  assert.equal(quotaCheck({ mode: 'solo', lead: 'gpt', usage: {}, available: ['gpt'], now }), null, 'unknown usage gives no warning');
  const solo = quotaCheck({ mode: 'solo', lead: 'claude', usage, available: ['claude', 'gpt', 'gemini'], now });
  assert.deepEqual([solo.low, solo.pct.claude, solo.leadLow, solo.alternative, solo.canExclude], [['claude'], 18, true, { id: 'gpt', pct: 79 }, false]);
  const team = quotaCheck({ mode: 'collaborate', lead: 'gpt', participants: ['gpt', 'gemini', 'claude'], usage, available: ['claude', 'gpt', 'gemini'], now });
  assert.deepEqual([team.low, team.leadLow, team.canExclude], [['claude'], false, true]);
  const pair = quotaCheck({ mode: 'divide', lead: 'gpt', participants: ['gpt', 'claude'], usage, available: ['claude', 'gpt'], now });
  assert.equal(pair.canExclude, false, 'excluding would leave a single member');
  const leadLow = quotaCheck({ mode: 'collaborate', lead: 'claude', participants: ['claude', 'gpt', 'gemini'], usage, available: ['claude', 'gpt', 'gemini'], now });
  assert.deepEqual([leadLow.leadLow, leadLow.canExclude, leadLow.alternative.id], [true, false, 'gpt']);
});
