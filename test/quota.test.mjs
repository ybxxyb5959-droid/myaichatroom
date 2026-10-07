import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantServer, loadConfig } from '../server.mjs';
import { discuss } from '../lib/discussion.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-quota-'));
const initialTime = () => new Date(2026, 9, 6, 8).getTime();
async function start(root, clock = { t: initialTime() }, extra = {}) {
  const calls = [];
  const reports = {};
  const usage = {
    polling: false, lastPoll: clock.t, onUpdate: () => {},
    view: () => reports,
    pollAll: async () => { usage.lastPoll = clock.t; usage.onUpdate(); },
  };
  const adapter = {
    available: () => ({ gpt: true, claude: true, gemini: false }),
    listModels: async () => [],
    chat: async (id, brief, prompt, options) => {
      calls.push({ id, brief, prompt });
      return extra.reply ? extra.reply(id, brief, prompt, options) : { ok: true, text: `${id} 응답` };
    },
  };
  const app = createAssistantServer({ root, cfg: { ...loadConfig(), autoSleepMinutes: 0 }, adapter, usage,
    clock: () => clock.t, random: () => .5, greetings: extra.greetings ?? false, autoTickMs: 3600000, pairDelayMs: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, body) => {
    const res = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const report = (id, windows, options = {}) => {
    reports[id] = { ok: true, at: clock.t, windows: Object.entries(windows).map(([id, usedPct]) => ({ id, usedPct })), ...options };
    usage.onUpdate();
  };
  return { app, clock, calls, post, report, view: () => app.view() };
}
const notices = (s, id) => s.view().messages.filter((m) => m.from === id && m.text === '나 잠깐 쉬러간다 ㅋㅋ');

test('5시간·주간 한도 소진은 일반 말풍선과 퇴장을 한 번만 남기고, 모두 회복된 새 조회에만 복귀한다', async () => {
  const root = temp(); const s = await start(root);
  try {
    s.report('gpt', { '5h': 100, week: 100 });
    const v = s.view();
    assert.equal(v.room.enabled.gpt, false);
    assert.equal(v.room.enabled.claude, true);
    assert.equal(v.room.quotaRest.gpt.autoResume, true);
    assert.equal(notices(s, 'gpt').length, 1);
    assert.equal(notices(s, 'gpt')[0].kind, undefined);
    assert.equal(notices(s, 'gpt')[0].model, undefined);
    assert.equal(v.messages.at(-1).text, 'ChatGPT가 잠깐 나감');
    assert.equal(v.messages.at(-1).kind, 'presence');
    s.report('gpt', { '5h': 100, week: 100 });
    assert.equal(notices(s, 'gpt').length, 1);
    s.report('gpt', { '5h': 0, week: 0 }); // a report from before the rest cannot recover it
    assert.equal(s.view().room.enabled.gpt, false);
    s.clock.t += 1000;
    s.report('gpt', { '5h': 0, week: 100 });
    assert.equal(s.view().room.enabled.gpt, false);
    s.report('gpt', { '5h': 0 }); // missing the exhausted weekly window
    assert.equal(s.view().room.enabled.gpt, false);
    for (const options of [{ ok: false }, { restored: true }, { at: s.clock.t - 700000 }]) {
      s.report('gpt', { '5h': 0, week: 0 }, options);
      assert.equal(s.view().room.enabled.gpt, false);
    }
    s.report('gpt', {});
    assert.equal(s.view().room.enabled.gpt, false);
    s.report('gpt', { '5h': 0, week: 30 });
    assert.equal(s.view().room.enabled.gpt, true);
    assert.equal(s.view().room.quotaRest.gpt, null);
    assert.equal(s.view().messages.at(-1).text, 'ChatGPT 들어옴');
    s.report('gpt', { '5h': 0, week: 30 });
    assert.equal(s.view().messages.filter((m) => m.text === 'ChatGPT 들어옴').length, 1);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('한도 휴식 중 수동 끄기는 재시작 뒤에도 자동 복귀를 금지하고, 원래 꺼 둔 AI도 켜지 않는다', async () => {
  const root = temp(); const clock = { t: initialTime() }; let s = await start(root, clock);
  try {
    await s.post('/api/room', { enabled: { claude: false } });
    s.report('gpt', { week: 100 });
    await s.post('/api/room', { enabled: { gpt: false } });
    assert.equal(s.view().room.quotaRest.gpt.autoResume, false);
    await s.app.close(); s = await start(root, clock);
    assert.equal(s.view().room.quotaRest.gpt.autoResume, false);
    clock.t += 1000;
    s.report('gpt', { week: 10 });
    s.report('claude', { '5h': 0, week: 0 });
    assert.equal(s.view().room.enabled.gpt, false);
    assert.equal(s.view().room.enabled.claude, false);
    assert.equal(s.view().room.quotaRest.gpt, null);
    assert.equal(s.view().messages.filter((m) => m.text === 'ChatGPT 들어옴').length, 0);
    await s.post('/api/room', { enabled: { gpt: true } });
    assert.equal(s.view().room.enabled.gpt, true);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('자동 복귀 예약은 재시작 후 유지되고, 한도 휴식 중 켜기를 눌러도 회복 전에는 호출하지 않는다', async () => {
  const root = temp(); const clock = { t: initialTime() }; let s = await start(root, clock);
  try {
    s.report('gpt', { '5h': 100 });
    await s.post('/api/room', { enabled: { gpt: true } });
    assert.equal(s.view().room.enabled.gpt, false);
    await s.app.close(); s = await start(root, clock);
    assert.equal(s.view().room.quotaRest.gpt.autoResume, true);
    assert.equal(notices(s, 'gpt').length, 1);
    clock.t += 1000;
    s.report('gpt', { '5h': 20 });
    assert.equal(s.view().room.enabled.gpt, true);
    assert.equal(s.calls.length, 0);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('자동 대화 한도 오류는 해당 AI만 쉬게 하고 나머지 대화와 사용자 응답은 계속한다', async () => {
  const root = temp();
  const s = await start(root, undefined, { reply: (id) => id === 'gpt'
    ? { ok: false, detail: 'usage limit reached token=SECRET123' } : { ok: true, text: '계속 이야기할게' } });
  try {
    await s.post('/api/room', { auto: { on: true } });
    s.clock.t += 20000; await s.app.tick();
    assert.equal(s.calls.filter((c) => c.id === 'gpt').length, 1);
    assert.ok(s.calls.some((c) => c.id === 'claude'));
    assert.equal(s.view().room.auto.usage.stopped, null);
    assert.equal(notices(s, 'gpt').length, 1);
    assert.ok(!JSON.stringify(s.view()).includes('SECRET123'));
    const before = s.calls.length;
    const sent = await s.post('/api/send', { text: '계속해' });
    assert.equal(sent.status, 200); await s.app.active?.done;
    assert.deepEqual(s.calls.slice(before).map((c) => c.id), ['claude']);
    assert.equal((await s.post('/api/send', { text: '@ChatGPT 대답해' })).status, 400);
    s.clock.t += 1000;
    s.report('gpt', { '5h': 10, week: 10 });
    assert.equal(s.view().room.enabled.gpt, true);
    assert.ok(Object.values(s.view().room.checks.gpt.models).every((c) => c.kind !== 'quota'));
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('일반 채팅에서 한도가 소진되어도 동료 응답은 완료되고 이후 토론에는 휴식 멤버를 제외한다', async () => {
  const root = temp();
  const s = await start(root, undefined, { reply: (id) => id === 'gpt'
    ? { ok: false, detail: 'usage limit reached' } : { ok: true, text: '응답' } });
  try {
    assert.equal((await s.post('/api/send', { text: '얘들아 안녕' })).status, 200); // both AIs answer, so one can run out while the other completes
    await s.app.active?.done;
    assert.equal(s.view().room.quotaRest.gpt.autoResume, true);
    assert.ok(s.view().messages.some((m) => m.from === 'claude' && m.text === '응답'));
    await s.post('/api/room', { discussion: true });
    const before = s.calls.length;
    await s.post('/api/send', { text: '토론해 줘' }); await s.app.active?.done;
    assert.deepEqual(s.calls.slice(before).map((c) => c.id), ['claude']);
    assert.ok(s.view().messages.some((m) => m.summary?.excluded.some((x) => x.id === 'gpt' && x.reason === '한도 휴식')));
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('교차 검토에서 한도가 소진된 종합 담당은 다시 호출하지 않고 성공한 동료가 최종 정리한다', async () => {
  const calls = []; const messages = [];
  const request = { text: '비교해 줘', discussion: true, selected: 'gpt', synthesizer: 'gpt',
    participants: ['gpt', 'claude'], models: { gpt: {}, claude: {} } };
  const result = await discuss({ request, history: '', signal: new AbortController().signal,
    adapter: { chat: async (id) => {
      calls.push(id);
      return id === 'gpt' && calls.filter((x) => x === id).length === 2
        ? { ok: false, detail: 'usage limit reached' } : { ok: true, text: '의견' };
    } }, onState: () => {}, onMessage: (m) => messages.push(m), onLog: () => {} });
  assert.equal(result.synthesizer, 'claude');
  assert.deepEqual(calls, ['gpt', 'claude', 'gpt', 'claude', 'claude']);
  assert.equal(result.ok, true);
  assert.ok(messages.some((m) => m.text.includes('Claude이(가) 최종 정리')));
});

async function finishGreeting(s) {
  for (let i = 0; i < 200 && s.view().room.autoRunning; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(s.view().room.autoRunning, false, '복귀 인사가 완료되어야 한다');
}
const returned = (s) => s.view().messages.filter((m) => m.returnTo);

test('수동 재활성화는 10분 미만이면 조용하고 정확히 10분 쉬면 동료 한 명만 친근하게 인사한다', async () => {
  const root = temp(); const s = await start(root, undefined, { greetings: true,
    reply: () => ({ ok: true, text: '@ChatGPT 어서오고 ㅋㅋ' }) });
  try {
    await s.post('/api/room', { enabled: { gpt: false } });
    s.clock.t += 10 * 60000 - 1;
    await s.post('/api/room', { enabled: { gpt: true } });
    await finishGreeting(s);
    assert.equal(s.calls.length, 0);
    await s.post('/api/room', { enabled: { gpt: false } });
    s.clock.t += 10 * 60000;
    await s.post('/api/room', { enabled: { gpt: true } });
    await finishGreeting(s);
    assert.deepEqual(s.calls.map((c) => c.id), ['claude']);
    assert.equal(returned(s)[0].text, '@ChatGPT 어서오고 ㅋㅋ');
    assert.equal(returned(s)[0].returnTo, 'gpt');
    assert.equal(returned(s)[0].auto, 'greet');
    assert.match(s.calls[0].prompt, /@ChatGPT에게 친구처럼/);
    assert.match(s.calls[0].prompt, /어서오고 ㅋㅋ/);
    assert.match(s.calls[0].prompt, /잘 쉬다 왔누/);
    assert.match(s.calls[0].brief, /사용자의 새 메시지에 답하는 턴이 아니다/);
    assert.equal(s.view().room.auto.usage.calls, 1);
    await s.post('/api/room', { enabled: { gpt: true } });
    await s.app.tick();
    assert.equal(s.calls.length, 1);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('한도 자동 복귀도 동료만 한 번 반기고, 사용자가 복귀를 막으면 인사하지 않는다', async () => {
  const root = temp(); const s = await start(root, undefined, { greetings: true });
  try {
    s.report('gpt', { week: 100 });
    s.clock.t += 10 * 60000;
    s.report('gpt', { week: 10 });
    await finishGreeting(s);
    assert.deepEqual(s.calls.map((c) => c.id), ['claude']);
    assert.equal(returned(s).length, 1);
    s.report('gpt', { week: 10 });
    assert.equal(s.calls.length, 1);
    s.report('gpt', { week: 100 });
    await s.post('/api/room', { enabled: { gpt: false } });
    s.clock.t += 20 * 60000;
    s.report('gpt', { week: 10 });
    await finishGreeting(s);
    assert.equal(s.view().room.enabled.gpt, false);
    assert.equal(s.calls.length, 1);
    await s.post('/api/room', { enabled: { gpt: true } });
    await finishGreeting(s);
    assert.equal(returned(s).length, 2);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('휴식 시작은 재시작과 중복 끄기에도 유지되고 이미 마친 복귀 인사는 재시작 시 반복하지 않는다', async () => {
  const root = temp(); const clock = { t: initialTime() };
  let s = await start(root, clock, { greetings: true });
  try {
    await s.post('/api/room', { enabled: { gpt: false } });
    clock.t += 9 * 60000;
    await s.post('/api/room', { enabled: { gpt: false } });
    await s.app.close(); s = await start(root, clock, { greetings: true });
    clock.t += 60000;
    await s.post('/api/room', { enabled: { gpt: true } });
    await finishGreeting(s);
    assert.equal(returned(s).length, 1);
    await s.app.close(); s = await start(root, clock, { greetings: true });
    await s.app.tick(); await s.post('/api/room', { enabled: { gpt: true } });
    assert.equal(s.calls.length, 0);
    assert.equal(returned(s).length, 1);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('남아 있던 AI가 없으면 스스로에게 복귀 인사를 하지 않는다', async () => {
  const root = temp(); const s = await start(root, undefined, { greetings: true });
  try {
    await s.post('/api/room', { enabled: { gpt: false, claude: false } });
    s.clock.t += 20 * 60000;
    await s.post('/api/room', { enabled: { gpt: true } });
    await s.app.tick();
    assert.equal(s.calls.length, 0);
    assert.equal(returned(s).length, 0);
  } finally { await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('복귀 인사 생성 중 다시 끄면 늦은 인사는 버리고 빠른 재활성화로 되살리지 않는다', async () => {
  const root = temp(); let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const s = await start(root, undefined, { greetings: true,
    reply: async () => { await waiting; return { ok: true, text: '늦은 환영' }; } });
  try {
    await s.post('/api/room', { enabled: { gpt: false } });
    s.clock.t += 10 * 60000;
    await s.post('/api/room', { enabled: { gpt: true } });
    assert.equal(s.calls.length, 1);
    await s.post('/api/room', { enabled: { gpt: false } });
    await s.post('/api/room', { enabled: { gpt: true } });
    release(); await finishGreeting(s);
    assert.equal(returned(s).length, 0);
    await s.app.tick();
    assert.equal(s.calls.length, 1);
  } finally { release(); await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('사용자 답변 중 돌아온 AI의 환영은 답변 뒤에 한 번만 실행하고 실패해도 재시도하지 않는다', async () => {
  const root = temp(); let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const s = await start(root, undefined, { greetings: true,
    reply: async (_id, _brief, prompt) => {
      if (prompt.includes('[AI 동료 복귀]')) return { ok: false, detail: 'timeout' };
      await waiting; return { ok: true, text: '사용자 답변' };
    } });
  try {
    await s.post('/api/room', { enabled: { gpt: false }, targeted: true, selected: 'claude' });
    s.clock.t += 10 * 60000;
    await s.post('/api/send', { text: '질문' });
    await s.post('/api/room', { enabled: { gpt: true } });
    assert.equal(s.calls.length, 1);
    release(); await s.app.active?.done;
    assert.equal(await s.app.tick(), 'greet');
    assert.equal(s.calls.length, 2);
    assert.match(s.calls[1].prompt, /\[AI 동료 복귀\]/);
    assert.equal(returned(s).length, 0);
    assert.equal(s.view().room.auto.usage.stopped, null);
    await s.app.tick();
    assert.equal(s.calls.length, 2);
  } finally { release(); await s.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
