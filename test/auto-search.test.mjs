import test from 'node:test';
import assert from 'node:assert/strict';
import { roomFixture } from './helpers/room.mjs';
import { needsFresh } from '../lib/router.mjs';

const notices = (s) => s.app.store.messages.filter((m) => m.kind === 'auto-search');

test('fresh-fact words are recognised; ordinary questions are not', () => {
  for (const text of ['오늘 비트코인 시세 알려줘', '요즘 아이폰 최신 모델 뭐야?', '2026년 일정 정리해줘', '이번 주 경기 일정 알려줘', "what's the latest news", '今日の天気は？']) assert.ok(needsFresh(text), text);
  for (const text of ['파이썬 리스트 정렬 방법 알려줘', '이 문장 맞춤법 봐 줘', '안녕', '오늘 AI들 뭐 했어?', '요즘 기분 어때?']) assert.equal(needsFresh(text), false, text);
});

test('a question needing fresh facts turns web search on with a notice, and it turns off once the question is answered', async (t) => {
  const s = await roomFixture(t);
  await s.start();
  const question = await s.send('오늘 비트코인 시세 알려줘');
  assert.equal(s.app.room.webSearch, true);
  assert.deepEqual(s.app.room.autoSearch.messageId, question.id);
  assert.equal(notices(s).length, 1);
  assert.ok(s.app.runtime.active(notices(s)[0].by), 'announced by a member who will answer');
  assert.match(notices(s)[0].text, /웹 검색을 켤게요/);
  await s.advance(0); await s.advance(12000);
  assert.ok(s.calls.length > 0 && s.calls.every((call) => call.options.webSearch === true), 'the answering turns search');
  await s.advance(500);
  assert.equal(s.app.room.webSearch, false, 'off again after the answer');
  assert.equal(s.app.room.autoSearch, null);
  // The next ordinary question does not search.
  const before = s.calls.length;
  await s.turn('고마워!');
  assert.ok(s.calls.slice(before).every((call) => !call.options.webSearch));
});

test('a switch turned on by hand is never turned off automatically, and plain questions never switch it on', async (t) => {
  const s = await roomFixture(t);
  await s.start();
  await s.turn('파이썬 리스트 정렬 방법 알려줘');
  assert.equal(s.app.room.webSearch, false);
  assert.equal(notices(s).length, 0);
  await s.post('/api/room', { webSearch: true });
  await s.turn('오늘 날씨 어때?');
  await s.advance(500);
  assert.equal(s.app.room.webSearch, true);
  assert.equal(notices(s).length, 0);
});

test('a discussion about fresh facts searches in every step and switches off when it ends; a restart never leaves it on', async (t) => {
  const s = await roomFixture(t, { discussionReply: () => ({ ok: true, text: '의견과 근거' }) });
  await s.post('/api/room', { discussion: true });
  await s.send('요즘 AI 뉴스 정리해줘');
  assert.equal(notices(s).length, 1);
  await s.app.active?.done;
  const steps = s.calls.filter((call) => call.options.usageKind === 'discussion');
  assert.ok(steps.length >= 3 && steps.every((call) => call.options.webSearch === true), 'every discussion step searches');
  assert.equal(s.app.room.webSearch, false);
  // Switched on automatically and the app closed before the answer: it comes back off.
  await s.post('/api/room', { discussion: false });
  await s.start();
  await s.send('최신 아이폰 가격 알려줘');
  assert.equal(s.app.room.webSearch, true);
  await s.reopen();
  assert.equal(s.app.room.webSearch, false);
});
