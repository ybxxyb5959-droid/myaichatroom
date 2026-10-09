import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { roomFixture } from './helpers/room.mjs';

const current = (state, ids) => state.projects.find((p) => p.id === ids.projectId).sessions.find((s) => s.id === ids.sessionId);
function fakeProvider(id, shortName, calls, modes = ['analysis', 'proposal', 'explore', 'plan', 'plan.proposals', 'changes', 'docs'], reply = null) {
  return { id, shortName, label: shortName, modes: new Set(modes), available: () => true, prepare: async () => 'v',
    analyze: async (input, { mode }) => {
      const value = JSON.parse(input);
      calls.push({ id, mode, value });
      if (reply) return reply(value, mode);
      if (mode === 'explore') return JSON.stringify({ action: 'answer', text: `${shortName} 최종 통합 결과` });
      return `${shortName} 답변 ${calls.length}`;
    } };
}
async function fixture(t, { reply } = {}) {
  const calls = [];
  let selected;
  const room = await roomFixture(t, { taskProvider: fakeProvider('claude', 'Claude', calls, undefined, reply),
    taskProviders: { codex: fakeProvider('codex', 'Codex', calls, undefined, reply), gemini: fakeProvider('gemini', 'Gemini', calls, ['analysis', 'docs'], reply) },
    folderPicker: async () => selected });
  selected = path.join(room.root, 'project'); fs.mkdirSync(selected);
  fs.writeFileSync(path.join(selected, 'notes.txt'), '발표 자료 메모');
  const post = async (url, body, status = 200) => {
    const response = await fetch(room.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: room.base }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const state = await post('/api/tasks', { action: 'project.createLinked', name: '팀 테스트' });
  const ids = { projectId: state.selectedProjectId, sessionId: state.selectedSessionId };
  const get = async () => (await fetch(room.base + '/api/tasks/ai')).json();
  const wait = async () => {
    const end = Date.now() + 5000;
    while (Date.now() < end) { await delay(15); const value = await get(); if (!value.running) { await delay(30); const again = await get(); if (!again.running) return again; } }
    assert.fail('job did not finish');
  };
  const draft = async (text) => post('/api/tasks', { action: 'draft.save', ...ids, revision: current((await get()).state, ids).revision, text });
  const start = async (extra, status = 202) => post('/api/tasks/ai', { action: 'start', ...ids, provider: 'claude', consent: true,
    revision: current((await get()).state, ids).revision, ...extra }, status);
  return { room, calls, ids, post, get, wait, draft, start };
}

test('phase 6: split mode runs each AI once in its role, then the lead produces one integrated result', async (t) => {
  const f = await fixture(t);
  await f.draft('notes.txt로 발표 자료를 만들어 줘');
  await f.start({ mode: 'team', provider: 'gemini', files: [], team: { style: 'split', providers: ['gemini', 'codex', 'claude'], final: 'explore' } });
  const done = await f.wait();
  const entry = current(done.state, f.ids);
  const team = entry.messages.filter((m) => m.team === true && m.role === 'assistant');
  // Gemini cannot lead an explore run, so Codex (first capable) leads and takes the first role.
  assert.deepEqual(team.map((m) => [m.provider, m.work, m.phase]), [['codex', '자료 분석·구성 설계', 'role'], ['gemini', '내용 초안 작성', 'role'], ['claude', '검토·보완', 'role']]);
  const final = entry.messages.at(-1);
  assert.equal(final.provider, 'codex'); assert.equal(final.text, 'Codex 최종 통합 결과');
  const finalRequest = entry.messages.findLast((m) => m.role === 'user');
  assert.equal(finalRequest.teamFinal, true); assert.match(finalRequest.text, /분담 작업 결과/);
  assert.match(finalRequest.text, /### Gemini · 내용 초안 작성/);
  assert.equal(f.calls.filter((c) => c.mode === 'analysis').length, 3, 'one call per role, no loops');
  assert.ok(f.calls.filter((c) => c.mode === 'analysis').every((c) => c.value.files.some((file) => file.path === 'notes.txt' && file.content.includes('발표 자료 메모'))),
    'every role reads the same project material (server excerpt, no extra AI call)');
  assert.match(f.calls[1].value.history.at(-1).text, /\[Codex · 자료 분석·구성 설계\]/, 'each role sees the previous steps');
  assert.equal(entry.messages.filter((m) => m.role === 'user' && !m.teamFinal).length, 1);
});

test('phase 6: collab mode is independent opinions, one cross-review round, then a single final result', async (t) => {
  const f = await fixture(t);
  await f.draft('보고서 구성을 같이 정해 줘');
  await f.start({ mode: 'team', files: [], team: { style: 'collab', providers: ['claude', 'codex'], final: 'explore' } });
  const done = await f.wait();
  const entry = current(done.state, f.ids);
  assert.deepEqual(entry.messages.filter((m) => m.team && m.role === 'assistant').map((m) => [m.provider, m.phase]),
    [['claude', 'opinion'], ['codex', 'opinion'], ['claude', 'review'], ['codex', 'review']]);
  const opinions = f.calls.filter((c) => /협업 1단계/.test(c.value.request));
  assert.equal(opinions.length, 2);
  assert.ok(opinions.every((c) => !c.value.history.some((h) => /독립 의견\]/.test(h.text))), 'opinions are written independently');
  const reviews = f.calls.filter((c) => /교차 검토/.test(c.value.request));
  assert.match(reviews[0].value.history.at(-1).text, /\[Codex · 독립 의견\]/);
  assert.equal(entry.messages.at(-1).text, 'Claude 최종 통합 결과');
  assert.equal(f.calls.length, 5);
});

test('phase 6: team requests are validated on the server', async (t) => {
  const f = await fixture(t);
  await f.draft('검증');
  await f.start({ mode: 'team', files: [], team: { style: 'split', providers: ['claude'] } }, 400);
  await f.start({ mode: 'team', files: [], team: { style: 'party', providers: ['claude', 'codex'] } }, 400);
  await f.start({ mode: 'team', files: [], team: { style: 'collab', providers: ['claude', 'codex'], final: 'image' } }, 400);
  await f.start({ mode: 'team', files: [], team: { style: 'collab', providers: ['gemini', 'gemini'] } }, 400);
  assert.equal(f.calls.length, 0);
});

test('phase 6: execution permission is a server policy the AI cannot raise; auto never applies files', async (t) => {
  const f = await fixture(t);
  await f.post('/api/tasks', { action: 'project.permission', ...f.ids, permission: 'root' }, 400);
  await f.post('/api/tasks', { action: 'project.permission', ...f.ids, permission: 'auto' }, 403);
  // ask: every run needs an explicit confirmation.
  await f.post('/api/tasks', { action: 'project.permission', ...f.ids, permission: 'ask' });
  await f.draft('요약');
  await f.start({ mode: 'analysis', files: ['notes.txt'] }, 428);
  await f.start({ mode: 'analysis', files: ['notes.txt'], confirmed: true });
  await f.wait();
  // auto: saved consent covers read-only and draft runs without the checkbox.
  await f.post('/api/tasks', { action: 'project.permission', ...f.ids, permission: 'auto', consent: true });
  await f.draft('다시 요약');
  await f.start({ mode: 'analysis', files: ['notes.txt'], consent: false });
  const done = await f.wait();
  assert.equal(current(done.state, f.ids).messages.at(-1).role, 'assistant');
  assert.equal(done.state.projects[0].permission, 'auto');
  assert.ok(done.permissions.auto.scope.includes('최종 확인'));
  // Image transfer is outside the auto scope and still needs the per-run consent.
  await f.draft('이미지');
  await f.start({ mode: 'image', consent: false, files: [] }, 403);
  // An AI reply that asks for more permission changes nothing.
  assert.equal((await f.get()).state.projects[0].permission, 'auto');
  // Back to default: the checkbox consent is required again.
  await f.post('/api/tasks', { action: 'project.permission', ...f.ids, permission: 'default' });
  await f.draft('기본');
  await f.start({ mode: 'analysis', files: ['notes.txt'], consent: false }, 403);
});

test('phase 6: compression stores a session summary without removing history, links real ids, and feeds later calls', async (t) => {
  let answer = JSON.stringify({ goal: '발표 자료 완성', done: ['자료 분석'], decisions: ['10장 구성'], todo: ['PPTX 생성'], uncertain: ['발표 날짜'] });
  const f = await fixture(t, { reply: (value, mode) => /session-history/.test(JSON.stringify(value.files)) ? answer : mode === 'explore' ? JSON.stringify({ action: 'answer', text: '결과' }) : '분석 답변' });
  for (const text of ['첫 요청', '둘째 요청']) { await f.draft(text); await f.start({ mode: 'analysis', files: ['notes.txt'] }); await f.wait(); }
  const before = current((await f.get()).state, f.ids).messages.length;
  await f.post('/api/tasks/ai', { action: 'context.compress', ...f.ids, provider: 'claude', consent: false }, 403);
  await f.post('/api/tasks/ai', { action: 'context.compress', ...f.ids, provider: 'claude', consent: true }, 202);
  let state = (await f.wait()).state;
  let entry = current(state, f.ids);
  assert.equal(entry.messages.length, before, 'history is kept');
  assert.equal(entry.summary.goal, '발표 자료 완성'); assert.deepEqual(entry.summary.uncertain, ['발표 날짜']);
  assert.deepEqual(entry.summary.files, ['notes.txt']); assert.equal(entry.summary.upTo, entry.messages.at(-1).id);
  assert.match(entry.summary.text, /확인 필요\(사실로 단정하지 않음\):\n- 발표 날짜/);
  await f.draft('셋째 요청');
  await f.start({ mode: 'analysis', files: ['notes.txt'] }); await f.wait();
  const last = f.calls.at(-1).value;
  assert.equal(last.history[0].role, 'summary'); assert.match(last.history[0].text, /발표 자료 완성/);
  assert.ok(!last.history.some((h) => h.text === '첫 요청'), 'messages folded into the summary are not resent');
  // A failed compression keeps the previous summary.
  answer = '형식이 틀린 답';
  await f.post('/api/tasks/ai', { action: 'context.compress', ...f.ids, provider: 'claude', consent: true }, 202);
  const failed = await f.wait();
  assert.equal(current(failed.state, f.ids).summary.goal, '발표 자료 완성');
  assert.match(failed.compressError, /기존 요약은 그대로/);
});

test('phase 6: documents attached in the session reach every team step only with the attachment consent', async (t) => {
  const f = await fixture(t);
  const upload = await fetch(`${f.room.base}/api/tasks/attachments?projectId=${f.ids.projectId}&sessionId=${f.ids.sessionId}`, { method: 'POST',
    headers: { Origin: f.room.base, 'X-File-Name': encodeURIComponent('brief.md') }, body: '# 첨부 자료\n첨부에만 있는 핵심 문장' });
  assert.equal(upload.status, 201);
  for (const consentAttachments of [false, true]) {
    f.calls.length = 0;
    await f.draft('첨부 자료로 구성안을 만들어 줘');
    await f.start({ mode: 'team', files: [], consentAttachments, team: { style: 'split', providers: ['claude', 'codex'], final: 'explore' } });
    await f.wait();
    const steps = f.calls.filter((c) => c.mode === 'analysis');
    assert.equal(steps.length, 2);
    for (const step of steps) assert.equal(step.value.files.some((file) => file.path === '첨부:brief.md' && file.content.includes('첨부에만 있는 핵심 문장')), consentAttachments);
  }
});

test('phase 6: cancelling a team run stops the remaining steps and never starts the final integration', async (t) => {
  let release, held = false;
  // Only the very first step waits (until cancelled); later runs answer at once.
  const f = await fixture(t, { reply: (value, mode) => mode === 'explore' ? JSON.stringify({ action: 'answer', text: '최종' })
    : held ? '의견' : (held = true, new Promise((resolve) => { release = resolve; })) });
  await f.draft('취소 확인');
  await f.start({ mode: 'team', files: [], team: { style: 'collab', providers: ['claude', 'codex'], final: 'explore' } });
  const end = Date.now() + 3000;
  while (!release && Date.now() < end) await delay(10);
  const running = (await f.get()).running;
  await f.post('/api/tasks/ai', { action: 'cancel', ...running });
  release('늦게 온 의견');
  const done = await f.wait();
  const entry = current(done.state, f.ids);
  assert.equal(entry.analysis.status, 'cancelled');
  assert.ok(!entry.messages.some((m) => m.role === 'assistant'), 'no late team note is saved after cancel');
  assert.ok(!entry.messages.some((m) => m.teamFinal), 'the final integration is never started');
  assert.equal(f.calls.length, 1);
  // The workbench is free again and another session's run is unaffected.
  await f.draft('다시 실행');
  await f.start({ mode: 'team', files: [], team: { style: 'split', providers: ['claude', 'codex'], final: 'explore' } });
  assert.equal(current((await f.wait()).state, f.ids).messages.at(-1).text, '최종');
});

test('phase 6: a team member that hits its quota is left out and recorded; the lead still delivers one result', async (t) => {
  const f = await fixture(t, { reply: (value, mode) => {
    if (mode === 'explore') return JSON.stringify({ action: 'answer', text: '최종 통합 결과' });
    return '의견';
  } });
  await f.get(); // the workbench AI is created on first use
  const gemini = f.room.app.taskAI.providers.gemini;
  gemini.analyze = async () => { throw new Error('RESOURCE_EXHAUSTED (code 429): Individual quota reached.'); };
  await f.draft('세 AI 협업');
  await f.start({ mode: 'team', files: [], team: { style: 'collab', providers: ['claude', 'codex', 'gemini'], final: 'explore' } });
  const done = await f.wait();
  const entry = current(done.state, f.ids);
  assert.deepEqual(entry.messages.filter((m) => m.team && m.role === 'assistant').map((m) => [m.provider, m.phase]),
    [['claude', 'opinion'], ['codex', 'opinion'], ['claude', 'review'], ['codex', 'review']]);
  assert.match(entry.messages.findLast((m) => m.teamFinal).text, /참여하지 못한 AI: Gemini — RESOURCE_EXHAUSTED/);
  assert.equal(entry.messages.at(-1).text, '최종 통합 결과');
  const run = f.room.app.taskAI.runs.data.runs.find((r) => r.mode === 'team.collab');
  assert.equal(run.status, 'completed');
  assert.ok(run.events.some((e) => e.state === 'failed' && /Gemini · 독립 의견 실패 → 이번 팀 작업에서 제외/.test(e.text)));
  // If the lead itself fails, the run fails instead of pretending to finish.
  f.room.app.taskAI.providers.claude.analyze = async () => { throw new Error('lead down'); };
  await f.draft('리더 실패');
  await f.start({ mode: 'team', files: [], team: { style: 'split', providers: ['claude', 'codex'], final: 'explore' } });
  const failed = await f.wait();
  assert.equal(current(failed.state, f.ids).analysis.status, 'failed');
  assert.ok(!current(failed.state, f.ids).messages.slice(-2).some((m) => m.teamFinal));
});
