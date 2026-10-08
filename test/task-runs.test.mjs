import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { roomFixture } from './helpers/room.mjs';
import { RunLog } from '../lib/task-runs.mjs';

const json = JSON.stringify;
async function fixture(t, analyze) {
  let selected;
  const provider = { available: () => true, prepare: async () => 'test', analyze };
  const room = await roomFixture(t, { taskProvider: provider, folderPicker: async () => selected });
  selected = path.join(room.root, 'project'); fs.mkdirSync(path.join(selected, 'src'), { recursive: true });
  fs.writeFileSync(path.join(selected, 'README.md'), '# 안내\n설명');
  fs.writeFileSync(path.join(selected, 'src', 'a.js'), 'export const a = 1;\n');
  const post = async (url, body, status = 200) => {
    const response = await fetch(room.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: room.base }, body: json(body) });
    const value = await response.json(); assert.equal(response.status, status, json(value)); return value;
  };
  const state = await post('/api/tasks', { action: 'project.createLinked', name: '진행 테스트' });
  const ids = { projectId: state.selectedProjectId, sessionId: state.selectedSessionId };
  const get = async () => (await fetch(room.base + '/api/tasks/ai')).json();
  const wait = async () => { const end = Date.now() + 6000; while (Date.now() < end) { const v = await get(); if (!v.running) return v; await delay(10); } assert.fail('timeout'); };
  const start = async (mode, text, status = 202) => {
    const s = (await get()).state.projects[0].sessions[0];
    await post('/api/tasks', { action: 'draft.save', ...ids, revision: s.revision, text });
    const rev = (await get()).state.projects[0].sessions[0].revision;
    return post('/api/tasks/ai', { action: 'start', ...ids, mode, provider: 'claude', consent: true, files: [], revision: rev }, status);
  };
  const runs = async () => (await fetch(`${room.base}/api/tasks/runs?projectId=${ids.projectId}&sessionId=${ids.sessionId}`)).json();
  return { room, ids, post, get, wait, start, runs };
}

// Reads the real SSE stream until `until` returns true (or times out).
async function listen(base, query, until, ms = 6000) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/tasks/events?${query}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  const timer = setTimeout(() => controller.abort(), ms);
  let buffer = '';
  try {
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const name = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
        if (name && data) events.push({ name, data: JSON.parse(data) });
      }
      if (until(events)) break;
    }
  } catch (error) { if (error.name !== 'AbortError') throw error; } finally { clearTimeout(timer); controller.abort(); }
  return events;
}

test('real server events stream over SSE and are stored: folder listing, file reads, AI calls, result, durations', async (t) => {
  let turns = 0;
  const f = await fixture(t, async () => {
    await delay(40);
    return ++turns === 1 ? json({ action: 'read', paths: ['README.md', 'src/a.js'] }) : json({ action: 'answer', text: 'README.md와 src/a.js를 확인했습니다.' });
  });
  const stream = listen(f.room.base, `projectId=${f.ids.projectId}&sessionId=${f.ids.sessionId}`,
    (events) => events.some((e) => e.name === 'run' && e.data.run.status === 'completed'));
  await delay(50);
  await f.start('explore', '프로젝트를 분석해 줘');
  const events = await stream;
  assert.equal(events[0].name, 'snapshot');
  const finalRun = events.findLast((e) => e.name === 'run').data.run;
  assert.equal(finalRun.status, 'completed');
  assert.ok(finalRun.endedAt >= finalRun.startedAt);
  const texts = finalRun.events.map((e) => e.text);
  assert.ok(texts.some((x) => /로그인·안전 설정 확인 완료/.test(x)));
  assert.ok(texts.some((x) => /폴더 조회 완료: \(루트\)/.test(x)));
  assert.ok(texts.some((x) => /README\.md/.test(x)) && texts.some((x) => /src\/a\.js/.test(x)));
  assert.equal(finalRun.stats.files, 2);
  assert.equal(finalRun.stats.aiCalls, 2);
  assert.ok(texts.some((x) => /Claude 응답 수신 \(2번째/.test(x)));
  assert.ok(texts.some((x) => /분석 결과 저장/.test(x)));
  assert.ok(finalRun.events.every((e) => e.state === 'done'), 'a completed run leaves no spinner behind');
  // The active states were really observed while it ran.
  assert.ok(events.some((e) => e.name === 'run' && e.data.run.events.some((x) => x.state === 'active' && /응답 대기 중/.test(x.text))));

  // reload: the stored history comes back from the server, also after a restart
  assert.equal((await f.runs()).runs.at(-1).status, 'completed');
  await f.room.reopen();
  const after = await f.runs();
  assert.equal(after.runs.length, 1);
  assert.equal(after.runs[0].events.length, finalRun.events.length);
  assert.equal(after.runs[0].status, 'completed');
});

test('failure reason and cancellation are recorded; a run left running by a crash becomes failed', async (t) => {
  let mode = 'fail';
  const f = await fixture(t, async (input, options) => {
    if (mode === 'fail') throw new Error('Claude 사용량 한도를 초과했습니다.');
    await new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  await f.start('explore', '첫 요청');
  await f.wait();
  let runs = (await f.runs()).runs;
  assert.equal(runs[0].status, 'failed');
  assert.match(runs[0].error, /사용량 한도/);
  assert.ok(runs[0].events.some((e) => e.state === 'failed'));

  mode = 'hang';
  await f.start('explore', '두 번째 요청');
  await delay(80);
  const running = (await f.get()).running;
  await f.post('/api/tasks/ai', { action: 'cancel', ...running });
  await f.wait();
  runs = (await f.runs()).runs;
  assert.equal(runs[1].status, 'cancelled');
  assert.ok(runs[1].events.some((e) => /취소 요청/.test(e.text)));
  assert.ok(runs[1].endedAt);
  // other sessions never see this session's runs
  const other = await fetch(`${f.room.base}/api/tasks/runs?projectId=${f.ids.projectId}&sessionId=00000000-0000-4000-8000-000000000000`);
  assert.deepEqual((await other.json()).runs, []);
});

test('RunLog marks an interrupted running record as failed and keeps bounded events', (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || '/tmp'), 'runlog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1000;
  const log = new RunLog(dir, () => now++);
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  log.begin({ id: ids[0], projectId: ids[1], sessionId: ids[2], mode: 'explore', provider: 'claude' });
  for (let i = 0; i < 400; i++) log.event(ids[0], { kind: 'notice', text: `n${i}` });
  assert.ok(log.find(ids[0]).events.length <= 160);
  log.persist(true);
  const again = new RunLog(dir, () => 9999);
  const run = again.find(ids[0]);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /재시작/);
  assert.equal(run.endedAt, 9999);
});
