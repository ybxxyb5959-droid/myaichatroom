import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { roomFixture } from './helpers/room.mjs';
import { ATTACH_LIMITS } from '../lib/task-attachments.mjs';
import { buildDocx } from '../lib/task-docx.mjs';
import { buildXlsx } from '../lib/task-xlsx.mjs';
import { makePdf } from './helpers/pdf.mjs';
import { previewTextSync } from '../lib/task-extract.mjs';

const json = JSON.stringify;
const calls = [];
async function fixture(t, { reply } = {}) {
  let dir;
  const provider = { available: () => true, prepare: async () => 'test',
    analyze: async (input, options) => {
      calls.push({ input, mode: options.mode, signal: options.signal });
      if (reply) return reply(input, options);
      return options.mode === 'docs.chunk' ? '구간 요약' : '최종 답변입니다.';
    } };
  calls.length = 0;
  const room = await roomFixture(t, { taskProvider: provider, folderPicker: async () => dir });
  dir = path.join(room.root, 'proj'); fs.mkdirSync(dir, { recursive: true });
  const post = async (url, body, status = 200) => {
    const response = await fetch(room.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: room.base }, body: json(body) });
    const value = await response.json(); assert.equal(response.status, status, json(value)); return value;
  };
  const state = await post('/api/tasks', { action: 'project.createLinked', name: '문서' });
  const ids = { projectId: state.selectedProjectId, sessionId: state.selectedSessionId };
  const get = async () => (await fetch(room.base + '/api/tasks/ai')).json();
  const wait = async () => { const end = Date.now() + 20000; while (Date.now() < end) { const v = await get(); if (!v.running) return v; await delay(10); } assert.fail('timeout'); };
  const upload = async (name, bytes, { origin = room.base, status = 201, project = ids.projectId } = {}) => {
    const response = await fetch(`${room.base}/api/tasks/attachments?projectId=${project}&sessionId=${ids.sessionId}`, { method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), ...(origin ? { Origin: origin } : {}) }, body: bytes });
    const value = await response.json(); assert.equal(response.status, status, json(value)); return value;
  };
  const draft = async (text) => {
    const s = (await get()).state.projects[0].sessions[0];
    return post('/api/tasks', { action: 'draft.save', ...ids, revision: s.revision, text });
  };
  const run = async (sources, extra = {}, status = 202) => {
    const s = (await get()).state.projects[0].sessions[0];
    return post('/api/tasks/ai', { action: 'start', ...ids, mode: 'docs', provider: 'claude', consent: true, consentAttachments: true, sources, depth: 'quick', revision: s.revision, files: [], ...extra }, status);
  };
  const runs = async () => (await (await fetch(`${room.base}/api/tasks/runs?projectId=${ids.projectId}&sessionId=${ids.sessionId}`)).json()).runs;
  return { room, dir, ids, post, get, wait, upload, draft, run, runs };
}
const paragraph = (i) => `단락 ${i}: 이 문서는 분기 보고서의 일부이며 번호는 ${i}입니다. 매출과 비용과 일정에 대한 설명이 이어집니다. ${'가나다라마바사 '.repeat(20)}\n`;

test('attachments: explicit upload, size/type shown, dedupe, sanitised names, same-origin only, removal, restart restore', async (t) => {
  const f = await fixture(t);
  const text = Buffer.from('첫 줄\n두 번째 줄\n');
  const first = await f.upload('../../위험한 이름?.txt', text);
  assert.equal(first.duplicate, false);
  assert.equal(first.item.kind, 'text');
  assert.equal(first.item.size, text.length);
  assert.ok(!/[\\/?]/.test(first.item.name), `sanitised: ${first.item.name}`);
  assert.equal(first.item.name, '위험한 이름_.txt');
  const again = await f.upload('다른이름.txt', text);
  assert.equal(again.duplicate, true);
  assert.equal(again.item.id, first.item.id, 'identical bytes are stored once');
  assert.equal(fs.readdirSync(path.join(f.room.root, 'data', 'task-attachments', f.ids.projectId)).length, 1);
  await f.upload('x.txt', text, { origin: null, status: 403 });
  await f.upload('x.txt', text, { origin: 'http://evil.example', status: 403 });
  await f.upload('x.txt', text, { project: '00000000-0000-4000-8000-000000000000', status: 404 });
  await f.upload('empty.txt', Buffer.alloc(0), { status: 400 });
  const pdf = await f.upload('보고서.pdf', makePdf(['안녕'], { cid: true }));
  assert.equal(pdf.item.kind, 'pdf');
  const bin = await f.upload('data.bin', Buffer.from([0, 1, 2, 3]));
  assert.equal(bin.item.kind, 'binary');
  assert.deepEqual(fs.readdirSync(f.dir), [], 'attachments never land in the project folder');
  await f.room.reopen();
  const info = await f.get();
  assert.deepEqual(info.attachments.map((a) => a.name).sort(), ['위험한 이름_.txt', 'data.bin', '보고서.pdf'].sort());
  const removed = await fetch(`${f.room.base}/api/tasks/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.room.base }, body: json({ action: 'remove', projectId: f.ids.projectId, id: first.item.id }) });
  assert.equal(removed.status, 200);
  assert.equal(fs.readdirSync(path.join(f.room.root, 'data', 'task-attachments', f.ids.projectId)).length, 2);
});

test('attachment limits stop a transfer as soon as it exceeds the cap and leave nothing behind', async (t) => {
  const f = await fixture(t);
  const saved = ATTACH_LIMITS.fileBytes;
  ATTACH_LIMITS.fileBytes = 1000;
  t.after(() => { ATTACH_LIMITS.fileBytes = saved; });
  const response = await fetch(`${f.room.base}/api/tasks/attachments?projectId=${f.ids.projectId}`, { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'big.txt', Origin: f.room.base }, body: Buffer.alloc(50000, 65) });
  assert.equal(response.status, 413);
  assert.equal((await f.get()).attachments.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.room.root, 'data', 'task-attachments', '.incoming')), []);
});

test('a large attached document is analysed in budgeted chunks: only chosen chunks reach the model, coverage is reported by the server', async (t) => {
  const f = await fixture(t);
  let body = '';
  for (let i = 1; i <= 3000; i++) body += i === 1500 ? `${paragraph(i)}핵심 키워드 고유식별자 ZEBRA-9000 이 문단에만 있습니다.\n` : paragraph(i);
  const size = Buffer.byteLength(body);
  assert.ok(size > 1_500_000);
  const att = (await f.upload('긴 보고서.txt', Buffer.from(body))).item;
  const prepared = await f.post('/api/tasks/ai', { action: 'docs.prepare', ...f.ids, sources: [{ kind: 'attachment', id: att.id }] });
  const info = prepared.sources[0];
  assert.ok(info.chunks > 100, `chunks ${info.chunks}`);
  assert.equal(info.estimates.quick.chunks, 8);
  assert.ok(info.estimates.quick.calls < info.estimates.normal.calls && info.estimates.normal.calls < info.estimates.thorough.calls);
  assert.equal(calls.length, 0, 'preparing never calls the AI');

  await f.draft('ZEBRA-9000 이 들어 있는 부분을 중심으로 쉽게 요약해줘');
  await f.run([{ kind: 'attachment', id: att.id }]);
  const view = await f.wait();
  const entry = view.state.projects[0].sessions[0];
  assert.equal(entry.analysis.status, 'completed', entry.analysis.error);
  const sent = calls.map((c) => c.input);
  const total = sent.reduce((n, s) => n + Buffer.byteLength(s), 0);
  assert.ok(total < size / 8, `the model received ${total} bytes of a ${size} byte document`);
  assert.ok(sent.some((s) => s.includes('ZEBRA-9000')), 'the chunk containing the keyword was chosen by relevance');
  assert.deepEqual(calls.map((c) => c.mode), ['docs.chunk', 'docs.chunk', 'docs.chunk', 'docs.reduce']);
  const text = entry.messages.at(-1).text;
  assert.match(text, /최종 답변입니다\./);
  assert.match(text, /── 분석 범위 ──/);
  assert.match(text, /긴 보고서\.txt: 전체 [\d,]+자 중 [\d.]+% 분석 \(8\/\d+개 구간\)/);
  assert.match(text, /분석하지 않은 구간: /);
  const run = (await f.runs()).at(-1);
  assert.equal(run.status, 'completed');
  assert.ok(run.events.some((e) => /문서 변환 (완료|결과 재사용)/.test(e.text)));
  assert.ok(run.events.some((e) => /구간 요약 수신 \(3\/3\)/.test(e.text)));

  // the extraction is cached: a second run reuses it
  await f.draft('다른 질문: 결론만 알려줘');
  await f.run([{ kind: 'attachment', id: att.id }]);
  await f.wait();
  assert.ok((await f.runs()).at(-1).events.some((e) => /문서 변환 결과 재사용/.test(e.text)));
});

test('small documents take one call; consent, unsupported formats, scanned PDFs, cancellation and bad sources are handled', async (t) => {
  let hang = false;
  const f = await fixture(t, { reply: async (input, options) => { if (hang) await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); return '짧은 답'; } });
  const small = (await f.upload('메모.txt', Buffer.from('회의 메모: 다음 주 화요일에 출시한다.'))).item;
  await f.draft('요약해줘');
  await f.run([{ kind: 'attachment', id: small.id }]);
  await f.wait();
  assert.deepEqual(calls.map((c) => c.mode), ['docs.final']);
  assert.match(JSON.parse(calls[0].input).parts[0].text, /화요일/);
  assert.match((await f.get()).state.projects[0].sessions[0].messages.at(-1).text, /분석하지 않은 구간 없음/);

  await f.draft('또 요약해줘');
  await f.run([{ kind: 'attachment', id: small.id }], { consentAttachments: false }, 403);
  const legacy = (await f.upload('옛문서.doc', Buffer.from('D0CF11E0'))).item;
  const unsupported = await f.run([{ kind: 'attachment', id: legacy.id }], {}, 400);
  assert.match(unsupported.error, /구형 Office/);
  await f.run([{ kind: 'attachment', id: '00000000-0000-4000-8000-000000000000' }], {}, 404);
  await f.run([{ kind: 'file', path: '../secret.txt' }], {}, 403);
  await f.run([{ kind: 'file', path: '.env' }], {}, 403);
  await f.run([], {}, 400);
  await f.run([{ kind: 'attachment', id: small.id }, { kind: 'attachment', id: small.id }], {}, 400);

  await f.draft('스캔 문서 요약');
  const scan = (await f.upload('스캔.pdf', makePdf(['', ''], { scanned: [0, 1] }))).item;
  await f.run([{ kind: 'attachment', id: scan.id }]);
  const failed = (await f.wait()).state.projects[0].sessions[0].analysis;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /OCR|읽을 수 있는 텍스트/);

  hang = true;
  await f.draft('멈추는 요청');
  await f.run([{ kind: 'attachment', id: small.id }]);
  await delay(100);
  await f.post('/api/tasks/ai', { action: 'cancel', ...(await f.get()).running });
  const cancelled = (await f.wait()).state.projects[0].sessions[0].analysis;
  assert.equal(cancelled.status, 'cancelled');
});

test('project folder documents go through the same path policy, including sensitive names and links', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.dir, 'notes.md'), '# 프로젝트 노트\n출시일은 10월 31일입니다.\n');
  fs.writeFileSync(path.join(f.dir, 'password.txt'), '비밀');
  await f.draft('요약');
  await f.run([{ kind: 'file', path: 'password.txt' }], {}, 403);
  await f.run([{ kind: 'file', path: 'notes.md' }], { consentAttachments: false });
  const view = await f.wait();
  assert.equal(view.state.projects[0].sessions[0].analysis.status, 'completed');
  assert.match(JSON.parse(calls[0].input).parts[0].text, /10월 31일/);
});

test('documents generated by the AI are created, previewed, applied and restored through change sets', async (t) => {
  let turn = 0;
  const docx = { type: 'docx', title: '보고서', blocks: [{ type: 'title', text: '분기 보고서' }, { type: 'bullets', items: ['항목 하나', '항목 둘'] }] };
  const xlsxEdit = { type: 'xlsx', setCells: [{ sheet: '매출', ref: 'B2', value: 999 }, { sheet: '매출', ref: 'D2', formula: 'B2*2' }], addSheets: [{ name: '요약', columns: [{ header: '합계' }], rows: [[{ formula: "SUM('매출'!B2:B3)" }]] }] };
  const f = await fixture(t, { reply: async () => {
    turn++;
    if (turn === 1) return json({ action: 'list', path: '' });
    return json({ action: 'answer', changes: { version: 1, title: '문서 작업', summary: '보고서 생성과 엑셀 수정', ops: [
      { type: 'create', path: 'out/보고서.docx', document: docx, reason: '보고서' },
      { type: 'modify', path: '표.xlsx', edit: xlsxEdit, reason: '수치 수정과 요약' }] } });
  } });
  const original = buildXlsx({ type: 'xlsx', sheets: [{ name: '매출', columns: [{ header: '지점' }, { header: '값', format: 'integer' }], rows: [['서울', 1], ['부산', 2]] }] });
  fs.writeFileSync(path.join(f.dir, '표.xlsx'), original);
  await f.draft('보고서를 만들고 엑셀 요약 시트를 추가해줘');
  const s = (await f.get()).state.projects[0].sessions[0];
  await f.post('/api/tasks/ai', { action: 'start', ...f.ids, mode: 'changes', provider: 'claude', consent: true, files: [], revision: s.revision }, 202);
  const view = await f.wait();
  const set = view.changes[0];
  assert.equal(view.state.projects[0].sessions[0].analysis.status, 'completed', view.state.projects[0].sessions[0].analysis.error);
  assert.deepEqual(set.ops.map((o) => [o.type, o.kind]), [['create', 'binary'], ['modify', 'binary']]);
  assert.ok(!fs.existsSync(path.join(f.dir, 'out')), 'nothing is written before approval');
  const changes = (body, status = 200) => f.post('/api/tasks/changes', { ...f.ids, setId: set.id, ...body }, status);
  const detail = await changes({ action: 'detail', opId: set.ops[0].id });
  assert.match(detail.after, /# 분기 보고서\n- 항목 하나/);
  const diff = await changes({ action: 'detail', opId: set.ops[1].id });
  assert.ok(diff.diff.added > 0 && diff.diff.rows.some((r) => r.kind === 'added' && /999/.test(r.text)), 'the preview shows the edited cell');
  await changes({ action: 'decide', decision: 'approved' });
  const prepared = await changes({ action: 'apply.prepare' });
  const done = await changes({ action: 'apply', confirmId: prepared.confirmation.confirmId });
  assert.equal(done.status, 'applied');
  const made = fs.readFileSync(path.join(f.dir, 'out', '보고서.docx'));
  assert.equal(made.subarray(0, 2).toString(), 'PK');
  assert.match(previewTextSync(made, 'docx'), /분기 보고서/);
  assert.match(previewTextSync(fs.readFileSync(path.join(f.dir, '표.xlsx')), 'xlsx'), /999/);
  const restore = await changes({ action: 'restore.prepare' });
  await changes({ action: 'restore', confirmId: restore.confirmation.confirmId });
  assert.ok(!fs.existsSync(path.join(f.dir, 'out')), 'the created folder and file are gone again');
  assert.ok(fs.readFileSync(path.join(f.dir, '표.xlsx')).equals(original), 'the edited workbook is back to the original bytes');
});
