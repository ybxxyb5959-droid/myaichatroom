import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { roomFixture } from './helpers/room.mjs';
import { exploreBudget, EXPLORE_LIMITS } from '../lib/task-explore.mjs';
import { validateChanges } from '../lib/task-ai.mjs';
import { makePdf } from './helpers/pdf.mjs';

const json = JSON.stringify;
async function fixture(t, script) {
  let dir;
  const inputs = [];
  const provider = { available: () => true, prepare: async () => 'test',
    analyze: async (input, options) => { const value = JSON.parse(input); inputs.push({ value, options }); return script(value, inputs.length, options); } };
  const room = await roomFixture(t, { taskProvider: provider, folderPicker: async () => dir });
  dir = path.join(room.root, 'proj');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# 데모\n로그인은 src/login.js 에 있습니다.\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo","main":"src/login.js"}');
  fs.writeFileSync(path.join(dir, 'src', 'login.js'), 'export const login = () => true;\n');
  const post = async (url, body, status = 200) => {
    const response = await fetch(room.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: room.base }, body: json(body) });
    const value = await response.json(); assert.equal(response.status, status, json(value)); return value;
  };
  const state = await post('/api/tasks', { action: 'project.createLinked', name: '효율' });
  const ids = { projectId: state.selectedProjectId, sessionId: state.selectedSessionId };
  const get = async () => (await fetch(room.base + '/api/tasks/ai')).json();
  const wait = async () => { const end = Date.now() + 8000; while (Date.now() < end) { const v = await get(); if (!v.running) return v; await delay(10); } assert.fail('timeout'); };
  const run = async (text, mode = 'explore') => {
    const s = (await get()).state.projects[0].sessions[0];
    const saved = await post('/api/tasks', { action: 'draft.save', ...ids, revision: s.revision, text });
    return post('/api/tasks/ai', { action: 'start', ...ids, mode, provider: 'claude', consent: true, files: [], revision: saved.projects[0].sessions[0].revision }, 202);
  };
  const runs = async () => (await (await fetch(`${room.base}/api/tasks/runs?projectId=${ids.projectId}&sessionId=${ids.sessionId}`)).json()).runs;
  return { room, dir, ids, inputs, post, get, wait, run, runs };
}

test('README and the manifest are read before the first AI call, so a simple question needs one call instead of two', async (t) => {
  const f = await fixture(t, (v) => json({ action: 'answer', text: v.files.some((x) => x.path === 'README.md') ? '로그인은 src/login.js 입니다.' : '모르겠어요' }));
  await f.run('로그인 어디 있어?');
  const view = await f.wait();
  assert.equal(view.state.projects[0].sessions[0].analysis.status, 'completed');
  assert.equal(f.inputs.length, 1, 'one AI call');
  assert.deepEqual(f.inputs[0].value.files.map((x) => x.path), ['README.md', 'package.json']);
  assert.deepEqual(f.inputs[0].value.listings[0].entries.sort(), ['README.md', 'package.json', 'src/']);
  const run = (await f.runs()).at(-1);
  assert.equal(run.stats.aiCalls, 1);
  assert.ok(run.stats.sent > 100 && run.stats.received > 0, 'bytes sent and received are accounted per run');
  assert.equal(run.stats.sent, Buffer.byteLength(JSON.stringify(f.inputs[0].value)));
});

test('files read earlier in the session are marked known only while their bytes are unchanged', async (t) => {
  const f = await fixture(t, (v, n) => (n === 1 ? json({ action: 'read', paths: ['src/login.js'] }) : json({ action: 'answer', text: `답 ${n}` })));
  await f.run('로그인 코드를 읽어줘');
  await f.wait();
  f.inputs.length = 0;
  await f.run('다시 확인해줘: 이전 내용 그대로야?');
  await f.wait();
  assert.deepEqual(f.inputs[0].value.known.sort(), ['README.md', 'package.json', 'src/login.js']);
  f.inputs.length = 0;
  fs.writeFileSync(path.join(f.dir, 'src', 'login.js'), 'export const login = () => false; // 바뀜\n');
  await f.run('이제는?');
  await f.wait();
  assert.ok(!f.inputs[0].value.known.includes('src/login.js'), 'a changed file is not presented as known');
  assert.ok(f.inputs[0].value.known.includes('README.md'));
});

test('call budgets follow the difficulty of the request and never exceed the hard limits', async (t) => {
  assert.deepEqual(exploreBudget('explore', '로그인 어디 있어?'), { aiCalls: 5, operations: 9, files: 6 });
  assert.deepEqual(exploreBudget('explore', '프로젝트 전체 구조를 분석해줘'), {});
  assert.deepEqual(exploreBudget('explore', 'x'.repeat(300)), {});
  assert.deepEqual(exploreBudget('changes', '짧은 요청'), { aiCalls: 10, operations: 18, files: 14 });
  const f = await fixture(t, () => json({ action: 'answer', text: 'ok' }));
  await f.run('짧은 질문');
  await f.wait();
  assert.equal(f.inputs[0].value.budget.aiCallsLeft, 4);
  const endless = await fixture(t, (v) => (v.mustAnswer ? json({ action: 'answer', text: '끝' }) : json({ action: 'list', path: 'src' })));
  await endless.run('계속');
  await endless.wait();
  assert.ok(endless.inputs.length <= 5, `a short question used ${endless.inputs.length} calls`);
  assert.ok(EXPLORE_LIMITS.aiCalls <= 8);
});

test('listings are compact strings and a folder path with a trailing slash is understood', async (t) => {
  const f = await fixture(t, (v, n) => (n === 1 ? json({ action: 'list', path: 'src/' }) : json({ action: 'answer', text: 'ok' })));
  await f.run('src 폴더에는 뭐가 있어?');
  await f.wait();
  assert.deepEqual(f.inputs[1].value.listings.map((l) => l.path), ['', 'src']);
  assert.deepEqual(f.inputs[1].value.listings[1].entries, ['src/login.js']);
});

test('documents and big text files reach the model as bounded excerpts that cannot be rewritten', async (t) => {
  const f = await fixture(t, (v, n) => (n === 1 ? json({ action: 'read', paths: ['보고서.pdf', 'big.log'] }) : json({ action: 'answer', text: 'ok' })));
  fs.writeFileSync(path.join(f.dir, '보고서.pdf'), makePdf(['첫 쪽 내용입니다', '로그인 정책은 두 번째 쪽에 있습니다'], { cid: true, compress: true }));
  let log = '';
  for (let i = 0; i < 20000; i++) log += `2026-10-08 INFO line ${i} ${i === 15000 ? 'LOGINFAILURE-MARKER' : 'ok'}\n`;
  fs.writeFileSync(path.join(f.dir, 'big.log'), log);
  assert.ok(Buffer.byteLength(log) > 256 * 1024);
  await f.run('LOGINFAILURE-MARKER 가 있는 로그와 로그인 정책 PDF를 살펴봐줘');
  await f.wait();
  const files = f.inputs[1].value.files;
  assert.deepEqual(files.map((x) => [x.path, x.partial]), [['README.md', undefined], ['package.json', undefined], ['보고서.pdf', true], ['big.log', true]].filter(([p]) => files.some((x) => x.path === p)));
  const pdf = files.find((x) => x.path === '보고서.pdf'), big = files.find((x) => x.path === 'big.log');
  assert.match(pdf.content, /로그인 정책은 두 번째 쪽에 있습니다/);
  assert.ok(big.content.includes('LOGINFAILURE-MARKER'), 'the excerpt of the big log is chosen by relevance');
  assert.ok(Buffer.byteLength(big.content) <= 25000, 'the excerpt stays small');
  assert.ok(Buffer.byteLength(JSON.stringify(f.inputs[1].value)) < 100000);
  assert.match(f.inputs[1].value.notices.join('\n'), /발췌본/);
  // an excerpt is never a basis for rewriting the file
  const reads = new Map([['big.log', big.content]]), hashes = new Map([['big.log', 'x']]);
  assert.throws(() => validateChanges({ version: 1, title: 't', summary: 's', ops: [{ type: 'modify', path: 'big.log', content: '새 내용\n' }] },
    { reads, hashes, listed: new Set(['big.log']), partials: new Set(['big.log']) }, f.dir), /발췌본/);
  // Office files cannot be written as text either
  assert.throws(() => validateChanges({ version: 1, title: 't', summary: 's', ops: [{ type: 'create', path: 'a.docx', content: '가짜 문서' }] },
    { reads: new Map(), hashes: new Map(), listed: new Set() }, f.dir), /document|항목이 올바르지/);
});
