import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { renderMarkdown, splitFold, extractLinks } from '../public/format.mjs';
import { roomFixture, IDS } from './helpers/room.mjs';
import { reviewEvaluation, rankSynthesizers, errorKind } from '../lib/discussion.mjs';

test('discussion still runs three independent opinions, three reviews and one synthesis', async (t) => {
  const s = await roomFixture(t, { discussionReply: ({ id, prompt }) => ({ ok: true, text: prompt.includes('<evaluation>')
    ? '검토 의견\n<evaluation>' + JSON.stringify({ ratings: IDS.filter(x => x !== id).map(x => ({ id: x, scores: Array(5).fill(x === 'gpt' ? 5 : 2), reason: '근거와 균형 있는 종합' })), recommend: id === 'gpt' ? 'claude' : 'gpt' }) + '</evaluation>'
    : '토론 의견과 근거' }) });
  await s.post('/api/room', { discussion: true, synthesizer: 'claude' });
  await s.send('세 가지 접근을 비교해 줘');
  await s.app.active?.done;
  assert.equal(s.calls.length, 7);
  const messages = s.app.store.messages;
  assert.equal(messages.filter((m) => m.phase === 'opinion').length, 3);
  assert.equal(messages.filter((m) => m.phase === 'review').length, 3);
  assert.equal(messages.find((m) => m.phase === 'final').from, 'gpt');
  assert.equal(s.app.room.auto.usage.asked, 7);
  assert.equal(s.app.runtime.suspended, false);
});

test('a discussion needs two named/available participants and never silently adds one', async (t) => {
  const s = await roomFixture(t);
  await s.post('/api/room', { discussion: true });
  assert.equal((await s.post('/api/send', { text: '@GPT 검토해줘' })).status, 400);
  assert.equal(s.calls.length, 0);
  await s.send('@GPT @Claude 같이 검토해줘'); await s.app.active?.done;
  assert.equal(s.calls.length, 5);
  assert.ok(s.calls.every((c) => c.id !== 'gemini'));
});

test('discussion keeps partial-failure reporting and does not retry a failed participant', async (t) => {
  const s = await roomFixture(t, { discussionReply: ({ id }) => id === 'gpt'
    ? { ok: false, detail: 'capacity token=SECRET123' } : { ok: true, text: '검토 의견' } });
  await s.post('/api/room', { discussion: true });
  await s.send('토론해 줘'); await s.app.active?.done;
  assert.equal(s.calls.filter((c) => c.id === 'gpt').length, 1);
  assert.equal(s.calls.length, 6);
  assert.ok(s.app.store.messages.some((m) => m.kind === 'error' && m.by === 'gpt'));
  assert.ok(!JSON.stringify(s.app.view()).includes('SECRET123'));
  assert.ok(s.app.store.messages.some((m) => m.phase === 'final'));
});

test('discussion suspends and cancels ordinary jobs, then resumes the same room without erasing data', async (t) => {
  const s = await roomFixture(t, { reply: ({ options }) => new Promise((resolve) => options.signal.addEventListener('abort', () => resolve({ action: 'pass' }), { once: true })) });
  await s.start(); await s.send('일반 대화'); await s.advance(); s.clock.now += 2000;
  const ordinary = s.app.tick();
  assert.equal(s.calls.length, 3);
  await s.post('/api/room', { discussion: true });
  await s.send('토론 요청'); await s.app.active?.done; await ordinary;
  assert.ok(s.calls.slice(0, 3).every((c) => c.options.signal.aborted));
  assert.equal(s.calls.filter((c) => c.options.independent).length, 7);
  assert.equal(s.app.runtime.suspended, false);
  assert.equal(s.app.view().room.auto.on, true);
});

test('existing history, both memory representations, models and world are backed up and preserved once', async (t) => {
  const s = await roomFixture(t, { seed: (store) => {
    store.addMessage({ from: 'user', text: '보존할 대화' });
    store.writeNote('gpt', '원본 파일 메모');
    store.state.assistant = { memos: { gpt: '개조본 메모' }, models: { gpt: { model: 'saved-model', effort: 'low' } } };
    fs.writeFileSync(path.join(store.dataDir, 'world.json'), JSON.stringify({ blocks: { '2,1,2': 'stone' } }));
  } });
  const backup = s.app.store.state.originalRuntimeMigration.backup;
  assert.equal(s.app.store.messages[0].text, '보존할 대화');
  assert.match(s.app.store.readNote('gpt'), /원본 파일 메모/);
  assert.match(s.app.store.readNote('gpt'), /개조본 메모/);
  assert.equal(s.app.room.models.gpt.model, 'saved-model');
  assert.equal(s.app.world.blocks.get('2,1,2'), 'stone');
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'state.json'))).assistant.memos.gpt, '개조본 메모');
  const note = s.app.store.readNote('gpt');
  await s.reopen();
  assert.equal(s.app.store.state.originalRuntimeMigration.backup, backup);
  assert.equal(s.app.store.readNote('gpt'), note);
});

test('connection checks do not schedule the room; model and discussion settings persist separately', async (t) => {
  const s = await roomFixture(t);
  assert.equal(s.calls.length, 0);
  await s.post('/api/check/login', {});
  assert.equal(s.calls.length, 0);
  await s.post('/api/room', { models: { gpt: { model: 'gpt-6-luna', effort: 'low' } }, debateModels: { gpt: { model: 'gpt-6-astra', effort: 'high' } } });
  await s.reopen();
  assert.deepEqual(s.app.room.models.gpt, { model: 'gpt-6-luna', effort: 'low' });
  assert.deepEqual(s.app.room.debateModels.gpt, { model: 'gpt-6-astra', effort: 'high' });
  assert.equal((await s.post('/api/room', { models: { gpt: { model: '../../bad' } } })).status, 400);
});

test('HTTP origin, rebinding, traversal and old feature endpoints stay protected', async (t) => {
  const s = await roomFixture(t);
  assert.equal((await fetch(s.base + '/api/room', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(s.base + '/api/room', { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const host = await new Promise((resolve, reject) => {
    const req = http.get(s.base + '/api/state', { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(host, 403);
  for (const url of ['/api/dev/state', '/config.json', '/vendor/addons/..%2f..%2fpackage.json']) assert.equal((await fetch(s.base + url)).status, 404, url);
  for (const url of ['/api/house', '/house.js']) assert.equal((await fetch(s.base + url)).status, 200, url);
  assert.equal((await fetch(s.base + '/world.html')).status, 200);
  for (const asset of ['/assistant.js', '/format.mjs', '/status.mjs', '/discussion-stage.mjs', '/dot-characters.mjs']) {
    const response = await fetch(s.base + asset);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get('content-type'), /javascript/);
  }
  assert.equal(s.app.view().members.length, IDS.length);
  for (const id of IDS) {
    const response = await fetch(s.base + `/sprites/discussion-${id}.svg`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
  }
  assert.equal((await fetch(s.base + '/sprites/other.svg')).status, 404);
});

test('rendering escapes executable markup while keeping folded discussion text and real HTTP citations', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> **안전**');
  assert.ok(!html.includes('<img src=x')); assert.match(html, /안전/);
  const text = '첫 문단 '.repeat(100) + '\n\n' + '둘째 문단 '.repeat(60);
  const folded = splitFold(text);
  assert.ok(folded.head && folded.tail);
  const links = extractLinks('https://example.com javascript:alert(1)');
  assert.ok(JSON.stringify(links).includes('https://example.com'));
  assert.ok(!JSON.stringify(links).includes('javascript:'));
});

const evaluatedReview = (id, best = 'gpt') => '반론을 검토하고 근거를 보완했습니다.\n<evaluation>' + JSON.stringify({
  ratings: IDS.filter(x => x !== id).map(x => ({ id: x, scores: Array(5).fill(x === best ? 5 : x === 'claude' ? 3 : 1), reason: '주제 이해와 근거, 균형 있는 종합을 검토함' })),
  recommend: id === best ? 'claude' : best,
}) + '</evaluation>';

test('peer evaluation excludes self promotion and rejects incomplete, duplicate or out-of-range ballots', () => {
  const parsed = reviewEvaluation(evaluatedReview('claude'), 'claude', IDS);
  assert.equal(parsed.evaluation.recommend, 'gpt');
  assert.ok(!parsed.text.includes('<evaluation>'));
  assert.equal(reviewEvaluation(evaluatedReview('claude').replace('<evaluation>', '[evaluation]'), 'claude', IDS).evaluation.recommend, 'gpt');
  for (const ratings of [[], [{ id: 'gpt', scores: [5, 5, 5, 5, 6], reason: 'bad' }],
    [{ id: 'gpt', scores: Array(5).fill(5), reason: 'one' }, { id: 'gpt', scores: Array(5).fill(5), reason: 'duplicate' }]]) {
    assert.equal(reviewEvaluation(`<evaluation>${JSON.stringify({ ratings })}</evaluation>`, 'claude', IDS).evaluation, null);
  }
  const self = evaluatedReview('gpt').replace('"recommend":"claude"', '"recommend":"gpt"');
  assert.equal(reviewEvaluation(self, 'gpt', IDS).evaluation.recommend, null);
  const reviews = IDS.map(id => ({ id, text: id, evaluation: reviewEvaluation(evaluatedReview(id), id, IDS).evaluation }));
  assert.equal(rankSynthesizers(reviews, reviews, '주제')[0].id, 'gpt');
  const missing = IDS.map(id => ({ id, text: `검토 ${id}` }));
  assert.deepEqual(rankSynthesizers(missing, missing, '주제').map(x => x.id), rankSynthesizers([...missing].reverse(), [], '주제').map(x => x.id));
});

test('automatic synthesis uses peer scores, hides evaluation JSON, preserves models and replaces a quota-failed winner once', async t => {
  const s = await roomFixture(t, { discussionReply: ({ id, prompt }) => {
    if (prompt.includes('<evaluation>')) return { ok: true, text: evaluatedReview(id) };
    if (prompt.includes('교차 검토:') && id === 'gpt') return { ok: false, detail: '429 usage limit reached' };
    return { ok: true, text: `${id}: 핵심 주장과 근거` };
  } });
  await s.post('/api/room', { discussion: true, synthesizer: 'gemini', debateModels: { claude: { model: 'test-claude' } } });
  await s.send('검토 후 종합해 줘'); await s.app.active?.done;
  assert.equal(s.calls.length, 8);
  const selections = s.app.store.messages.filter(m => m.kind === 'selection');
  assert.deepEqual(selections.map(m => m.synthesizer), ['gpt', 'claude']);
  const final = s.app.store.messages.find(m => m.phase === 'final' && m.from !== 'system');
  assert.equal(final.from, 'claude'); assert.equal(final.model, 'test-claude');
  assert.ok(s.app.store.messages.filter(m => m.phase === 'review').every(m => !m.text.includes('<evaluation>')));
  const prompt = s.calls.at(-1).prompt;
  for (const id of IDS) assert.ok(prompt.includes(`${id}:`));
  assert.match(prompt, /gpt\(실패\)/);
  assert.match(prompt, /이견.*미확인/);
  const summary = s.app.store.messages.findLast(m => m.kind === 'complete').summary;
  assert.equal(summary.synthesizer, 'claude'); assert.equal(summary.ok, true);
  assert.ok(summary.failed.some(f => f.id === 'gpt' && f.kind === 'quota'));
});

test('missing or malformed evaluations complete without voting calls and unavailable candidates cannot be selected', async t => {
  const s = await roomFixture(t, { discussionReply: ({ id, prompt }) => prompt.includes('<evaluation>')
    ? { ok: true, text: `${id} 검토\n<evaluation>{broken}</evaluation>` } : { ok: true, text: `${id} 근거` } });
  await s.post('/api/room', { discussion: true });
  await s.send('평가 형식 실패'); await s.app.active?.done;
  assert.equal(s.calls.length, 7);
  assert.match(s.app.store.messages.findLast(m => m.kind === 'complete').summary.selectionReason, /유효한 상호 평가가 없어/);
  assert.equal(rankSynthesizers([{ id: 'claude', text: '정상' }], [], 'topic')[0].id, 'claude');
});

test('provider failure badges distinguish quota, auth, timeout, model, capacity and invalid responses', () => {
  for (const [detail, kind] of [['RESOURCE_EXHAUSTED', 'quota'], ["You've hit your limit", 'quota'], ['401 login required', 'auth'],
    ['timed out', 'timeout'], ['model not found', 'model'], ['503 overloaded', 'capacity'], ['Invalid JSON action', 'response']]) assert.equal(errorKind(detail), kind);
});
