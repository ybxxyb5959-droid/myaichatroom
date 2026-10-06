// Personal group chat. While the app runs it mixes scripted mood lines (no AI call) with rare,
// capped, short real AI calls (lib/auto.mjs) and bounded, sandboxed game collaborations.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { Adapters, killAll } from './lib/agents.mjs';
import { UsageMonitor } from './lib/usage.mjs';
import { MEMBERS } from './lib/members.mjs';
import { setLang } from './lib/i18n.mjs';
import { IDS, discuss, errorKind, kindLabel, KIND_SHORT, mentionedTargets } from './lib/discussion.mjs';
import { LIMITS, LEVELS, DEFAULT_LEVEL, freshUsage, usageFor, redact, pickScript, decide, AUTO_BRIEF, topicCount, autoHistory, autoPrompt, tidy, cleanMemo, cleanBio, splitMemo, memoBlock, cleanTitle, userLine, greetPrompt, absentText } from './lib/auto.mjs';
import { ACTIVITY_LIMITS, ACTIVITY_PROMPT, parseActivity, postcard } from './lib/activities.mjs';
import { GAME_LIMITS, GAME_CSP, GAME_BRIEF, gamePrompt, parseDraft, applyGamePatches, gameDocument } from './lib/game.mjs';
import { checkGame } from './lib/gamecheck.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  port: 8321, language: 'ko', userName: '방장', roomName: 'AI 단톡방', autoSleepMinutes: 30,
  turnTimeoutSec: 150, bins: {},
  // General chat: the AI the user picked answers alone.
  agents: {
    claude: { model: 'sonnet', boost: { model: 'opus' } },
    gpt: { model: 'gpt-6.1-sol', effort: 'medium', boost: { model: 'gpt-6-astra' } },
    gemini: { model: 'gemini-3.8-flash-medium', boost: { model: 'gemini-3.8-flash-high' } },
  },
  // Discussion participants have settings of their own.
  debateModels: {
    claude: { model: 'claude-sonnet-5-5', effort: 'medium' },
    gpt: { model: 'gpt-6.1-sol', effort: 'medium' },
    gemini: { model: 'gemini-3.8-flash-medium', effort: '' },
  },
  synthesizer: 'claude',
  // Auto chat between the AIs uses these models. claude: checked with a real call on this account.
  // gpt is not listed on purpose: the lightest model the Codex CLI itself describes as affordable is picked.
  // gemini: the lowest "flash" level listed by `agy models` (the level is part of the model name).
  autoModels: { claude: 'haiku', gemini: 'gemini-3.8-flash-low' },
  modelCatalog: { gemini: ['gemini-3.8-flash-medium'] },
};
export function loadConfig() {
  const configFile = process.env.CHATROOM_CONFIG || path.join(ROOT, 'config.json');
  const user = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  return { ...DEFAULTS, ...user, port: Number(process.env.PORT || user.port || DEFAULTS.port),
    autoModels: { ...DEFAULTS.autoModels, ...user.autoModels },
    agents: Object.fromEntries(IDS.map((id) => [id, { ...DEFAULTS.agents[id], ...user.agents?.[id] }])),
    debateModels: Object.fromEntries(IDS.map((id) => [id, { ...DEFAULTS.debateModels[id], ...user.debateModels?.[id] }])) };
}
// Claude Code has no model list command. Aliases come from `claude --help`, the fixed ID
// from the installed CLI. Effort levels are the ones `claude --help` lists for --effort.
const CLAUDE_MODELS = [
  { id: 'sonnet', label: 'Sonnet', description: '최신 Sonnet 모델을 가리키는 별칭', source: 'help' },
  { id: 'opus', label: 'Opus', description: '최신 Opus 모델을 가리키는 별칭', source: 'help' },
  // Not in `claude --help`, but a real call with it worked on this account; it is the lightest one.
  { id: 'haiku', label: 'Haiku', description: '가장 가볍고 빠른 모델 · 사용량을 가장 덜 써요', source: 'config' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Sonnet 5.5 고정 모델 ID', source: 'cli' },
];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const GPT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CHECK_BRIEF = '연결 확인용 호출이다. 다른 말 없이 OK라고만 답하라.';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function bodyOf(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 3000000) throw new Error('요청이 너무 큽니다.');
  }
  return JSON.parse(text || '{}');
}
// Effort levels a model accepts: Codex's own catalog when it lists the model, the levels
// `claude --help` lists for Claude, none for Gemini (its model names carry the level).
function effortsFor(id, model, cache) {
  if (id === 'claude') return CLAUDE_EFFORTS;
  if (id === 'gpt') return cache?.models.find((m) => m.id === model)?.efforts ?? null;
  return [];
}
function settingsOf(id, value, fallback, cache) {
  const model = value?.model ?? fallback.model;
  const effort = value?.effort ?? fallback.effort ?? '';
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(model)) throw new Error('모델 이름을 확인하세요.');
  const allowed = effortsFor(id, model, cache) ?? GPT_EFFORTS;
  if (effort && !allowed.includes(effort)) throw new Error('이 모델에서 지원이 확인되지 않은 생각 수준입니다.');
  return { model, effort };
}
function saveImage(store, image) {
  if (!IMAGE_TYPES.has(image.mime) || typeof image.data !== 'string') throw new Error('지원하지 않는 사진입니다.');
  const bytes = Buffer.from(image.data, 'base64');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('사진은 2MB 이하여야 합니다.');
  const hex = bytes.subarray(0, 12).toString('hex');
  const type = hex.startsWith('89504e470d0a1a0a') ? 'image/png'
    : hex.startsWith('ffd8ff') ? 'image/jpeg'
    : bytes.subarray(0, 6).toString().match(/^GIF8[79]a$/) ? 'image/gif'
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';
  if (type !== image.mime) throw new Error('사진 형식이 맞지 않습니다.');
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type];
  const rel = `uploads/${crypto.randomUUID()}.${ext}`;
  fs.mkdirSync(path.join(store.wsDir, 'uploads'), { recursive: true });
  fs.writeFileSync(store.abs(rel), bytes);
  store.touchMeta(rel, 'user', true);
  return rel;
}

// clock/random/autoTickMs/pairDelayMs exist so tests can drive the auto chat without waiting.
export function createAssistantServer({ root = process.env.CHATROOM_HOME || ROOT, cfg = loadConfig(), adapter, store = new Store(root),
  clock = Date.now, random = Math.random, autoTickMs = 30000, pairDelayMs = 6000, usage = null, greetings = true, gameChecker = checkGame } = {}) {
  setLang(cfg.language || 'ko');
  adapter ??= new Adapters(root, cfg);
  const available = adapter.available();
  const clients = new Set();
  const preferences = store.state.assistant || {};
  const modelCache = { gpt: preferences.modelCache?.gpt || null };
  // Saved choices win; defaults only fill what was never saved.
  // 'gemini-3.6-flash' was an earlier default that `agy models` does not list; it is replaced.
  const LEGACY = { gemini: { 'gemini-3.6-flash': 'gemini-3.8-flash-medium' } };
  const saved = (id, value, fallback) => {
    const fixed = value && LEGACY[id]?.[value.model] ? { ...value, model: LEGACY[id][value.model] } : value;
    try { return settingsOf(id, fixed, fallback, modelCache.gpt); } catch { return settingsOf(id, {}, fallback, modelCache.gpt); }
  };
  const room = {
    selected: IDS.includes(preferences.selected) ? preferences.selected : 'claude',
    // targeted: send to the selected AI only. Otherwise every AI that is on answers (discussion aside).
    discussion: preferences.discussion === true, targeted: preferences.targeted === true, webSearch: preferences.webSearch === true,
    models: Object.fromEntries(IDS.map((id) => [id, saved(id, preferences.models?.[id], cfg.agents[id])])),
    debateModels: Object.fromEntries(IDS.map((id) => [id, saved(id, preferences.debateModels?.[id], cfg.debateModels[id])])),
    synthesizer: IDS.includes(preferences.synthesizer) ? preferences.synthesizer : cfg.synthesizer,
    enabled: Object.fromEntries(IDS.map((id) => [id, preferences.enabled?.[id] !== false])),
    onboarding: { done: preferences.onboarding?.done === true },
    // The welcome (a "열렸어" line, "○○ 들어옴" and a short hello from the AIs) happens once, right after the
    // first-start guide. Rooms that already finished the guide never get it. lastVisitAt: when the page was last opened.
    welcome: { done: preferences.welcome?.done === true || preferences.onboarding?.done === true },
    lastVisitAt: Number(preferences.lastVisitAt) || 0,
    tutorial: { done: preferences.tutorial?.done === true },
    // Names the user can edit: the room's title and the user's own name (the AIs call the user by it).
    roomName: cleanTitle(preferences.roomName) || cfg.roomName || 'AI 단톡방',
    userName: cleanTitle(preferences.userName) || cfg.userName || '방장',
    // Each AI's own short memo (speech style, how it calls people, relations). It writes it itself.
    // bios: the one-line intro each AI shows on its profile (written by the AI itself, like a status message).
    bios: Object.fromEntries(IDS.map((id) => [id, typeof preferences.bios?.[id] === 'string' ? cleanBio(preferences.bios[id]) : ''])),
    memoOn: preferences.memoOn !== false,
    memos: Object.fromEntries(IDS.map((id) => [id, typeof preferences.memos?.[id] === 'string' ? cleanMemo(preferences.memos[id]) : ''])),
    // on: the room power button (off until pressed). level: 낮음/중간/높음 → effort, pace, daily limit.
    auto: {
      on: preferences.auto?.on === true, level: LEVELS[preferences.auto?.level] ? preferences.auto.level : DEFAULT_LEVEL,
      usage: { ...freshUsage(clock()), ...preferences.auto?.usage }, lastError: preferences.auto?.lastError || null,
      sleepMinutes: [0, 5, 15, 30, 60].includes(preferences.auto?.sleepMinutes) ? preferences.auto.sleepMinutes
        : [0, 5, 15, 30, 60].includes(cfg.autoSleepMinutes) ? cfg.autoSleepMinutes : 30,
      lastWakeAt: Number(preferences.auto?.lastWakeAt) || clock(),
      lastCreationAt: Number(preferences.auto?.lastCreationAt) || 0,
    },
    checks: Object.fromEntries(IDS.map((id) => [id, { login: preferences.checks?.[id]?.login || null, models: preferences.checks?.[id]?.models || {} }])),
    modelCache,
  };
  const checking = new Map();
  let active = null;
  let autoJob = null;
  const persist = () => { store.state.assistant = structuredClone(room); store.saveState(); };
  const broadcast = (type, data) => {
    for (const client of clients) client.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const post = (message) => {
    if (message.detail) message = { ...message, detail: redact(message.detail) };
    const saved = store.addMessage({ ts: clock(), ...message });
    broadcast('message', saved);
    return saved;
  };
  // Each entry says where it comes from; only the Codex list is reported by the CLI itself,
  // and none of them proves the account can use the model (a test call does).
  const catalog = () => Object.fromEntries(IDS.map((id) => {
    const list = id === 'claude' ? [...CLAUDE_MODELS]
      : id === 'gpt' && modelCache.gpt ? modelCache.gpt.models.map((m) => ({ ...m, source: 'cli' })) : [];
    const add = (model, source) => { if (model && !list.some((m) => m.id === model)) list.push({ id: model, label: model, description: '', source }); };
    [cfg.agents[id].model, cfg.debateModels[id].model, cfg.agents[id].boost?.model, cfg.autoModels?.[id], ...(cfg.modelCatalog?.[id] || [])].forEach((m) => add(m, 'config'));
    [room.models[id].model, room.debateModels[id].model].forEach((m) => add(m, 'custom'));
    return [id, {
      available: !!available[id],
      listedAt: id === 'gpt' ? modelCache.gpt?.at || null : null,
      models: list.map((m) => ({ ...m, efforts: effortsFor(id, m.id, modelCache.gpt) || [], check: room.checks[id].models[m.id] || null })),
    }];
  }));
  const view = () => ({
    room: { ...room, modelCache: undefined, name: room.roomName, userName: room.userName, checking: [...checking.keys()],
      active: active ? { id: active.id, mode: active.mode, states: active.states, calls: active.calls, synthesizer: active.synthesizer, models: active.models } : null,
      autoRunning: !!autoJob, autoSleeping: autoSleeping(), autoDaily: LEVELS[room.auto.level].daily, autoReady: eligibleAuto().length > 0,
      autoUses: Object.fromEntries(IDS.map((id) => [id, autoSettings(id)])),
      recommended: Object.fromEntries(IDS.map((id) => [id, recommendedSettings(id)])),
      autoNextAt: autoNextAt(),
      autoRest: room.auto.on && eligibleAuto().length > 0 && (!!usageFor(room.auto, clock()).stopped || usageFor(room.auto, clock()).calls >= LEVELS[room.auto.level].daily) },
    members: IDS.map((id) => ({ id, name: MEMBERS[id].name, maker: MEMBERS[id].maker, color: MEMBERS[id].color,
      available: !!available[id], enabled: room.enabled[id], model: room.models[id].model })),
    usage: usageView(), catalog: catalog(), kinds: KIND_SHORT, messages: store.recent(300), files: store.listFiles(),
  });
  const publish = () => broadcast('state', view());
  // Remaining limits come from each CLI's own usage report (lib/usage.mjs). Error text is cleaned of secrets.
  function usageView() {
    const v = usage?.view();
    if (!v) return null;
    return Object.fromEntries(IDS.map((id) => [id, v[id] && { ...v[id], error: v[id].error ? redact(v[id].error) : undefined }]));
  }
  const pollUsage = () => {
    const ids = IDS.filter((id) => available[id]);
    if (usage && !usage.polling && ids.length) usage.pollAll(ids).catch((e) => store.log('usage', redact(e.message)));
  };
  if (usage) { usage.onUpdate = () => publish(); pollUsage(); }
  // Refresh every 10 minutes, and only while a browser is open.
  const usageTimer = usage ? setInterval(() => { if (clients.size && clock() - usage.lastPoll >= 600000) pollUsage(); }, 60000) : null;
  usageTimer?.unref?.();
  const nameOf = (id) => MEMBERS[id]?.name || id;
  function begin(request, runId) {
    const mode = request.discussion ? 'discussion' : 'answer';
    const job = { id: runId, controller: new AbortController(), states: {}, calls: 0, mode,
      synthesizer: request.discussion ? request.synthesizer : null,
      models: Object.fromEntries(request.participants.map((id) => [id, request.models[id]])) };
    for (const id of request.participants) job.states[id] = { phase: request.discussion ? 'opinion' : 'answer', status: '대기' };
    for (const { id, reason } of request.excluded) job.states[id] = { phase: '', status: '제외', reason };
    active = job;
    publish();
    const history = store.recent(40).filter((m) => m.from !== 'system' && m.auto !== 'ambient' && !m.phase?.match(/opinion|review/))
      .map((m) => `${m.from === 'user' ? room.userName : m.from}: ${m.text}`).join('\n').slice(-18000);
    job.done = discuss({
      adapter, request, history, signal: job.controller.signal,
      onState: ({ phase, id, status, kind, calls }) => {
        job.calls = calls;
        job.states[id] = { phase, status, kind };
        publish();
      },
      onMessage: (m) => post({ ...m, runId: job.id, mode }),
      onLog: (id, text) => store.log(id, redact(text)),
      onMemo: (id, memo) => { room.memos[id] = memo; persist(); },
      onBio: (id, bio) => { room.bios[id] = bio; persist(); publish(); },
    }).then((result) => {
      if (job.controller.signal.aborted) return;
      // A plain answer needs no closing note unless something failed or someone was left out.
      if (mode === 'answer' && result.ok && !result.failed.length && !request.excluded.length) return;
      const parts = [result.ok ? '완료' : '답변을 완료하지 못했습니다'];
      if (result.failed.length) parts.push(`실패: ${result.failed.map((f) => `${nameOf(f.id)}(${KIND_SHORT[f.kind]})`).join(', ')}`);
      if (request.excluded.length) parts.push(`빠짐: ${request.excluded.map((e) => `${nameOf(e.id)}(${e.reason})`).join(', ')}`);
      post({ from: 'system', runId: job.id, kind: 'complete', mode, text: parts.join(' · '),
        summary: { ok: result.ok, calls: result.calls, failed: result.failed, excluded: request.excluded, synthesizer: result.synthesizer || null } });
    }).catch((e) => {
      if (!job.controller.signal.aborted) post({ from: 'system', runId: job.id, mode, kind: 'error', errorKind: 'unknown', text: '처리 중 오류가 발생했습니다.', detail: e.message });
    }).finally(() => {
      usageFor(room.auto, clock()).asked += job.calls;
      if (active === job) active = null;
      persist(); publish();
    });
  }
  // ---------- auto chat: mood lines (no AI call) + rare short real AI calls ----------
  const sched = { chatterAt: 0, callAt: 0, lastUserAt: 0 };
  function autoSleeping() {
    return room.auto.on && room.auto.sleepMinutes > 0 && clock() - room.auto.lastWakeAt >= room.auto.sleepMinutes * 60000;
  }
  const timers = new Set();
  const between = ([lo, hi]) => lo + random() * (hi - lo);
  const arm = (now = clock()) => { sched.chatterAt = now + between(LIMITS.chatterMs); sched.callAt = now + between(LEVELS[room.auto.level].callMs); };
  arm();
  // Switched on before the app started: the first round comes soon, not after a full gap.
  if (room.auto.on) { sched.callAt = clock() + 20000; sched.chatterAt = clock() + 5 * 60000; }
  const shuffled = (list) => list.map((x) => [random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  // Model and reasoning effort of one auto turn. The model is a light one chosen for the user
  // (config autoModels, or for GPT the lightest model the Codex list calls affordable); the effort
  // comes from the level, only where the model is known to list it.
  const cheapGpt = () => modelCache.gpt?.models.find((m) => /affordable|efficient/i.test(m.description) && !/^older/i.test(m.description))?.id;
  // The model suggested for everyone: the lightest one, which uses the least of the subscription.
  // null when it is not known yet (GPT before the Codex list is loaded).
  function recommendedSettings(id) {
    const model = cfg.autoModels?.[id] || (id === 'gpt' ? cheapGpt() : null);
    return model ? { model, effort: (effortsFor(id, model, modelCache.gpt) || []).includes('low') ? 'low' : '' } : null;
  }
  function autoSettings(id) {
    const model = cfg.autoModels?.[id] || (id === 'gpt' && cheapGpt()) || room.models[id].model;
    const wanted = LEVELS[room.auto.level].effort;
    return { model, effort: (effortsFor(id, model, modelCache.gpt) || []).includes(wanted) ? wanted : '' };
  }
  // No setup needed: an AI takes part if it is on, connected, not known to be signed out, and its
  // auto model did not fail in the last 30 minutes. The first auto call is the real test.
  function eligibleAuto() {
    return IDS.filter((id) => {
      const call = room.checks[id].models[autoSettings(id).model];
      return room.enabled[id] && available[id] && room.checks[id].login?.status !== 'fail'
        && !(call?.status === 'fail' && clock() - call.at < 30 * 60000);
    });
  }
  // Counts of auto messages since the user last spoke (today only), and when that was.
  function sinceUser(now) {
    const dayStart = new Date(now).setHours(0, 0, 0, 0);
    const since = { calls: 0, chatter: 0, lastUser: 0 };
    for (let i = store.messages.length - 1; i >= 0; i--) {
      const m = store.messages[i];
      if (m.from === 'user') { since.lastUser = m.ts; break; }
      if (m.ts < dayStart) break;
      if (m.auto === 'call') since.calls++; else if (m.auto === 'ambient') since.chatter++;
    }
    return since;
  }
  function postChatter(now, usage) {
    const speakers = IDS.filter((id) => room.enabled[id]);
    const recent = store.messages.filter((m) => m.auto === 'ambient').slice(-LIMITS.repeatWindow).map((m) => m.text);
    const script = pickScript({ recent, speakers: shuffled(speakers), names: Object.fromEntries(IDS.map((id) => [id, nameOf(id)])), rand: random, userName: room.userName });
    if (!script) return false;
    const say = (line) => { usage.chatter++; post({ from: line.id, text: line.text, auto: 'ambient' }); persist(); };
    say(script[0]);
    if (script[1]) {
      const asked = sched.lastUserAt;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (sched.lastUserAt === asked && room.auto.on && !autoSleeping() && room.enabled[script[1].id]
          && usage.chatter < LIMITS.chatterPerDay && sinceUser(clock()).chatter < LIMITS.maxChatterSinceUser) say(script[1]);
      }, pairDelayMs);
      timer.unref?.();
      timers.add(timer);
    }
    sched.chatterAt = now + between(LIMITS.chatterMs);
    return true;
  }
  async function createActivity(id, activity, usage, job) {
    // Count attempts too. Failed image generation must never cause an automatic retry.
    usage.creations++; room.auto.lastCreationAt = clock(); persist();
    if (activity.kind === 'photo' && ['gpt', 'gemini'].includes(id) && cfg.imageGen !== false
      && usage.photos < ACTIVITY_LIMITS.photoDaily && usage.calls < LEVELS[room.auto.level].daily) {
      usage.photos++; usage.calls++; persist();
      const result = await adapter.image(id, activity.prompt || `${activity.title}, fictional AI character scene, ${activity.theme}`,
        { signal: job.controller.signal });
      if (job.controller.signal.aborted || autoSleeping()) return null;
      if (!result.ok || !result.file) throw new Error(result.detail || '사진을 생성하지 못했습니다.');
      if (fs.statSync(result.file).size > 2 * 1024 * 1024) throw new Error('생성된 사진이 2MB를 넘습니다.');
      const ext = path.extname(result.file).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
      const rel = saveImage(store, { mime, data: fs.readFileSync(result.file).toString('base64') });
      store.touchMeta(rel, id, true);
      return { attach: { path: rel, generated: true, label: 'AI가 생성한 가상 사진' } };
    }
    const rel = `activities/${crypto.randomUUID()}.svg`;
    store.applyFileOp({ op: 'write', path: rel, content: postcard(activity) }, id);
    store.meta[rel].activity = 'postcard';
    store.touchMeta(rel, id, true);
    return { attach: { path: rel, generated: true, label: 'AI가 고른 가상 장면 · 자동 그림' } };
  }
  async function createGame(a, b, activity, usage, job) {
    usage.games++; usage.creations++; room.auto.lastCreationAt = clock(); persist();
    let code; let title = activity.title; let check = null;
    const cancelled = () => job.controller.signal.aborted || autoSleeping();
    try {
      for (const [stage, id] of [a, b, a].entries()) {
        if (cancelled()) return;
        if (usage.calls >= LEVELS[room.auto.level].daily) throw new Error('오늘의 자동 호출 예산을 다 썼습니다.');
        usage.calls++; persist(); publish();
        const settings = autoSettings(id);
        const result = await adapter.chat(id, GAME_BRIEF + userLine(room.userName),
          gamePrompt(stage, activity.prompt || activity.title, code, check),
          { settings, independent: true, webSearch: false, signal: job.controller.signal, timeoutMs: LIMITS.callTimeoutMs });
        if (cancelled()) return;
        if (!result.ok) { usage.stopped = errorKind(result.detail || ''); throw new Error(result.detail || '게임 제작 AI 호출에 실패했습니다.'); }
        const reply = stage === 0 ? parseDraft(result.text) : applyGamePatches(code, result.text);
        code = reply.code;
        if (stage === 0) title = reply.title;
        check = await gameChecker({ title, code, signal: job.controller.signal });
        if (cancelled()) return;
        // Only the final, checked artifact is placed in the workspace.
        let artifact;
        if (stage === GAME_LIMITS.turns - 1) {
          if (!check.ok) throw new Error(`게임 실행 확인 실패: ${check.errors.join(' · ')}`);
          const rel = `activities/${crypto.randomUUID()}.html`;
          store.applyFileOp({ op: 'write', path: rel, content: gameDocument(title, code) }, id);
          Object.assign(store.meta[rel], { activity: 'game', creators: [a, b] });
          store.touchMeta(rel, id, true);
          artifact = { game: { path: rel, title, creators: [a, b], checked: true } };
        }
        post({ from: id, text: reply.text, ...artifact, auto: 'call', gameStage: stage,
          model: settings.model, effort: settings.effort || '' });
      }
    } catch (e) {
      if (cancelled()) return;
      const detail = redact(e.message).slice(-400);
      room.auto.lastError = { id: a, kind: errorKind(detail), detail, at: clock() };
      post({ from: 'system', kind: 'error', errorKind: errorKind(detail),
        text: '게임 제작을 완료하지 못해 오늘의 게임 제작은 쉬어요. 완성되지 않은 게임은 올리지 않았어요.', detail });
    }
  }
  // plan.kind: 'chat' (a normal round), 'first' (welcome the user's first entry) or 'back' (welcome them back
  // after a long absence). Greetings are soft: a failure is logged and skipped, it does not rest the day.
  async function autoBurst(now, usage, plan = { kind: 'chat' }) {
    // The Codex model list (no usage) tells which GPT model is the light one.
    if (!modelCache.gpt && available.gpt) { try { await refreshModels('gpt'); } catch { /* falls back to the normal model */ } }
    // Speakers alternate: nobody speaks twice in a row while someone else is available.
    const pool = eligibleAuto();
    const picks = [];
    const lastSpeaker = store.messages.at(-1)?.from;
    const turns = plan.kind === 'chat' ? LEVELS[room.auto.level].turns : Math.min(2, pool.length);
    for (let i = 0; i < turns; i++) {
      const prev = picks.at(-1) ?? lastSpeaker;
      const others = pool.length > 1 ? pool.filter((id) => id !== prev) : pool;
      picks.push(shuffled(others)[0]);
    }
    const job = { controller: new AbortController() };
    autoJob = job;
    const sleepTimer = room.auto.on && room.auto.sleepMinutes > 0
      ? setTimeout(() => job.controller.abort(), Math.max(0, room.auto.lastWakeAt + room.auto.sleepMinutes * 60000 - clock())) : null;
    sleepTimer?.unref?.();
    publish();
    job.done = (async () => {
      const topic = Math.floor(random() * topicCount);
      const lines = [];
      for (const [index, id] of picks.entries()) {
        if (job.controller.signal.aborted || autoSleeping()) return;
        if (usage.calls >= LEVELS[room.auto.level].daily) break;
        usage.calls++; persist(); // counted before the call, so a stopped call still counts
        const settings = autoSettings(id);
        const history = autoHistory(store.recent(40), nameOf, room.userName);
        const prompt = plan.kind === 'chat'
          ? autoPrompt({ topic, history, previous: lines.slice(-3).join('\n'), index, total: picks.length, hour: new Date(clock()).getHours() })
          : greetPrompt({ kind: plan.kind, userName: room.userName, history, previous: lines.at(-1) || '', absent: plan.absent, index });
        const creative = plan.kind === 'chat' && index === 0 && usage.creations < ACTIVITY_LIMITS.daily
          && clock() - room.auto.lastCreationAt >= ACTIVITY_LIMITS.gapMs;
        const gameAllowed = pool.length >= 2 && usage.games < GAME_LIMITS.daily
          && LEVELS[room.auto.level].daily - usage.calls >= GAME_LIMITS.turns;
        let result;
        try {
          result = await adapter.chat(id, AUTO_BRIEF + userLine(room.userName), prompt + (creative ? ACTIVITY_PROMPT
            + (gameAllowed ? '\n이번 턴 game을 제안해도 된다.' : '\n이번 턴 game은 선택하지 않는다. 동료·일일 게임 제한·호출 예산 조건이 맞지 않는다.') : '') + memoBlock(room.memos[id], room.memoOn, room.bios[id]),
            { settings, independent: true, webSearch: false, signal: job.controller.signal, timeoutMs: LIMITS.callTimeoutMs });
        } catch (e) { result = { ok: false, detail: e.message }; }
        if (job.controller.signal.aborted || autoSleeping()) return; // the user spoke first: drop this answer
        const split = result.ok ? splitMemo(result.text || '') : null;
        const parsed = creative && split ? parseActivity(split.text) : null;
        const text = split ? tidy(parsed?.text || split.text) : '';
        if (!text) {
          // No retry and no other model: auto calls rest for the rest of the day.
          // Keep only the CLI's last lines: its error output can echo the whole prompt.
          const detail = redact(result.detail || 'AI가 답변을 반환하지 않았습니다.').split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ').slice(-400);
          const kind = errorKind(detail);
          store.log(id, `auto ${detail}`);
          if (plan.kind !== 'chat') return; // a greeting that fails is simply skipped
          usage.stopped = kind;
          room.auto.lastError = { id, kind, detail: detail.slice(-400), at: clock() };
          room.checks[id].models[settings.model] = { status: 'fail', kind, label: kindLabel(kind), detail: detail.slice(-400), effort: settings.effort, at: clock() };
          return;
        }
        if (split.memo && room.memoOn) { room.memos[id] = split.memo; persist(); }
        if (split.bio && room.memoOn) { room.bios[id] = split.bio; persist(); }
        let artifact;
        if (parsed?.activity?.kind === 'game') {
          post({ from: id, text, auto: 'call', model: settings.model, effort: settings.effort || '' });
          if (gameAllowed) await createGame(id, pool.find((other) => other !== id), parsed.activity, usage, job);
          else post({ from: 'system', kind: 'complete', text: '공동 게임 제작에는 AI 두 명과 남은 호출 3회가 필요해요. 게임은 하루 1개만 시도해요.' });
          return;
        }
        if (parsed?.activity) {
          try { artifact = await createActivity(id, parsed.activity, usage, job); }
          catch (e) {
            if (job.controller.signal.aborted || autoSleeping()) return;
            const detail = redact(e.message).slice(-400);
            const kind = errorKind(detail);
            usage.stopped = kind;
            room.auto.lastError = { id, kind, detail, at: clock() };
            post({ from: 'system', kind: 'error', errorKind: kind, text: '자동 창작을 완료하지 못해 오늘의 자동 호출을 쉬어요.', detail });
            return;
          }
        }
        if (job.controller.signal.aborted || autoSleeping()) return;
        post({ from: id, text, ...artifact, auto: plan.kind === 'chat' ? 'call' : 'greet', model: settings.model, effort: settings.effort || '' });
        lines.push(`${nameOf(id)}: ${text}`);
      }
    })().catch((e) => { store.log('auto', redact(e.message)); })
      .finally(() => { clearTimeout(sleepTimer); if (autoJob === job) autoJob = null; arm(clock()); persist(); publish(); });
    await job.done;
  }
  // When the next auto message is due (the earlier of a real round and a mood line), after the user's pause.
  function autoNextAt() {
    if (!room.auto.on || autoSleeping() || sched.callAt === undefined) return null;
    const now = clock();
    const usage = usageFor(room.auto, now);
    const free = Math.max(sched.lastUserAt, sinceUser(now).lastUser) + LIMITS.userPauseMs;
    const real = eligibleAuto().length > 0 && !usage.stopped && usage.calls < LEVELS[room.auto.level].daily ? Math.max(sched.callAt, free) : Infinity;
    const chat = usage.chatter < LIMITS.chatterPerDay ? Math.max(sched.chatterAt, free) : Infinity;
    const next = Math.min(real, chat);
    return Number.isFinite(next) ? next : null;
  }
  // ---------- welcoming the user ----------
  const RETURN_MS = 60 * 60000; // a visit after this long without the user counts as coming back
  function lastUserTs() {
    for (let i = store.messages.length - 1; i >= 0; i--) if (store.messages[i].from === 'user') return store.messages[i].ts;
    return 0;
  }
  const canGreet = () => {
    const u = usageFor(room.auto, clock());
    return !active && !autoJob && !autoSleeping() && eligibleAuto().length > 0 && !u.stopped && u.calls < LEVELS[room.auto.level].daily;
  };
  // "○○ 들어옴" is stage dressing only: it has nothing to do with a login.
  const userJoined = () => post({ from: 'system', kind: 'presence', presence: true, by: 'user', text: `${room.userName} 들어옴` });
  // Once, right after the first-start guide: an opening line, the user joining, then a short hello from the AIs.
  function welcomeUser() {
    const names = IDS.filter((id) => room.enabled[id] && available[id]).map(nameOf);
    post({ from: 'system', kind: 'welcome', text: `${room.roomName} 열렸어! 멤버: ${[...names, room.userName].join(', ')}` });
    userJoined();
    if (canGreet()) autoBurst(clock(), usageFor(room.auto, clock()), { kind: 'first' }).catch(() => {});
  }
  // The page was opened again after a long time (and the room's Talk is on): welcome the user back once.
  // lastVisitAt is saved before anything else, so reloads and reconnects within the hour never repeat it.
  function noteVisit() {
    const now = clock();
    const last = Math.max(room.lastVisitAt, lastUserTs());
    room.lastVisitAt = now;
    persist();
    if (!greetings || !room.onboarding.done || !room.auto.on || !last || now - last < RETURN_MS || !canGreet()) return;
    userJoined();
    autoBurst(now, usageFor(room.auto, now), { kind: 'back', absent: absentText(now - last) }).catch(() => {});
  }
  async function autoTick() {
    const now = clock();
    const usage = usageFor(room.auto, now);
    if (autoSleeping()) { await stopAuto(); publish(); return null; }
    const since = sinceUser(now);
    const action = decide({ auto: room.auto, usage, now, busy: !!active || !!autoJob, since, eligible: eligibleAuto().length, daily: LEVELS[room.auto.level].daily,
      lastUserAt: Math.max(sched.lastUserAt, since.lastUser), chatterAt: sched.chatterAt, callAt: sched.callAt });
    if (action === 'chatter' && !postChatter(now, usage)) return null;
    if (action === 'call') await autoBurst(now, usage);
    if (action) { persist(); publish(); }
    return action;
  }
  const stopAuto = async () => { if (autoJob) { autoJob.controller.abort(); await autoJob.done; } };
  const autoTimer = setInterval(() => { autoTick().catch((e) => store.log('auto', redact(e.message))); }, autoTickMs);
  autoTimer.unref?.();
  async function refreshModels(id) {
    const models = await adapter.listModels(id);
    if (models?.length) modelCache[id] = { at: Date.now(), models };
  }
  function trusted(req) {
    const host = req.headers.host || '';
    const port = server.address()?.port;
    if (![ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ].includes(host)) return false;
    return !req.headers.origin || req.headers.origin === `http://${host}`;
  }
  async function serve(res, file, workspace = false) {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) { json(res, 404, { error: '파일이 없습니다.' }); return; }
    const game = workspace && store.meta[path.relative(store.wsDir, file).replaceAll('\\', '/')]?.activity === 'game';
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': workspace ? game ? GAME_CSP : "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"
        : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    fs.createReadStream(file).pipe(res);
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (!trusted(req)) return json(res, 403, { error: '로컬 접속만 허용합니다.' });
      const url = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(url.pathname);
      if (req.method === 'GET' && p === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        res.write(`event: state\ndata: ${JSON.stringify(view())}\n\n`);
        req.on('close', () => clients.delete(res));
        noteVisit();
        return;
      }
      if (req.method === 'GET' && p === '/api/state') return json(res, 200, view());
      if (req.method === 'GET' && p === '/api/models') return json(res, 200, catalog());
      if (req.method === 'GET' && p === '/api/file') {
        const file = store.readFile(url.searchParams.get('path'));
        return json(res, 200, { ...file, activity: store.meta[file.rel]?.activity || null });
      }
      if (req.method === 'GET' && p === '/api/history') {
        const before = Number(url.searchParams.get('before')) || Infinity;
        return json(res, 200, { messages: store.messages.filter((m) => m.id < before).slice(-200) });
      }
      if (req.method === 'POST') {
        const body = await bodyOf(req);
        if (p === '/api/cancel') {
          const job = active;
          sched.lastUserAt = clock();
          await stopAuto();
          if (job) {
            job.controller.abort();
            await job.done;
            post({ from: 'system', kind: 'cancelled', mode: job.mode, runId: job.id,
              text: '중지했습니다. 이미 받은 답변은 남아 있어요.' });
          }
          return json(res, 200, { ok: true });
        }
        if (p === '/api/room') {
          if (body.auto?.sleepMinutes !== undefined && ![0, 5, 15, 30, 60].includes(body.auto.sleepMinutes))
            return json(res, 400, { error: '자동 잠들기 시간을 확인하세요.' });
          let firstEntry = false;
          const models = { ...room.models };
          const debateModels = { ...room.debateModels };
          for (const id of IDS) if (body.models?.[id]) models[id] = settingsOf(id, body.models[id], room.models[id], modelCache.gpt);
          for (const id of IDS) if (body.debateModels?.[id]) debateModels[id] = settingsOf(id, body.debateModels[id], room.debateModels[id], modelCache.gpt);
          if (IDS.includes(body.selected)) room.selected = body.selected;
          if (IDS.includes(body.synthesizer)) room.synthesizer = body.synthesizer;
          if (typeof body.discussion === 'boolean') room.discussion = body.discussion;
          if (typeof body.targeted === 'boolean') room.targeted = body.targeted;
          if (typeof body.memoOn === 'boolean') room.memoOn = body.memoOn;
          // An empty name goes back to the default.
          if (typeof body.roomName === 'string') room.roomName = cleanTitle(body.roomName) || cfg.roomName || 'AI 단톡방';
          if (typeof body.userName === 'string') room.userName = cleanTitle(body.userName) || cfg.userName || '방장';
          for (const id of IDS) if (typeof body.memos?.[id] === 'string') room.memos[id] = cleanMemo(body.memos[id]);
          for (const id of IDS) if (typeof body.bios?.[id] === 'string') room.bios[id] = cleanBio(body.bios[id]);
          if (typeof body.webSearch === 'boolean') room.webSearch = body.webSearch;
          if (typeof body.onboarding?.done === 'boolean') {
            firstEntry = greetings && body.onboarding.done && !room.onboarding.done && !room.welcome.done;
            room.onboarding.done = body.onboarding.done;
            if (body.onboarding.done) room.welcome.done = true; // the welcome happens once, ever
          }
          if (typeof body.tutorial?.done === 'boolean') room.tutorial.done = body.tutorial.done;
          room.models = models;
          room.debateModels = debateModels;
          // Join/leave notes are posted only when the switch really changes, so a reload or a
          // reconnect never repeats them. They are show only, not a login or logout.
          for (const id of IDS) {
            const on = body.enabled?.[id];
            if (typeof on !== 'boolean' || room.enabled[id] === on) continue;
            room.enabled[id] = on;
            post({ from: 'system', kind: 'presence', presence: true, by: id, text: `${nameOf(id)} ${on ? '들어옴' : '잠깐 나감'}` });
          }
          const auto = body.auto;
          if (auto) {
            if (auto.level !== undefined && !LEVELS[auto.level]) return json(res, 400, { error: '대화 수준을 확인하세요.' });
            if (auto.level !== undefined && auto.level !== room.auto.level) { room.auto.level = auto.level; arm(); }
            if (auto.sleepMinutes !== undefined) room.auto.sleepMinutes = auto.sleepMinutes;
            if (typeof auto.on === 'boolean') {
              // Turning it on starts the first round soon, so the user sees it work.
              if (auto.on && !room.auto.on) { room.auto.lastWakeAt = clock(); sched.callAt = clock() + 10000; sched.chatterAt = clock() + 5 * 60000; }
              room.auto.on = auto.on;
              if (!auto.on) await stopAuto();
            }
            if (autoSleeping()) await stopAuto();
          }
          persist(); publish();
          if (firstEntry) welcomeUser();
          return json(res, 200, view());
        }
        // Connection checks run only on the user's button press.
        if (p === '/api/check/login') {
          const ids = IDS.includes(body.id) ? [body.id] : IDS;
          await Promise.all(ids.map(async (id) => {
            const result = available[id] ? await adapter.loginStatus(id) : { status: 'missing', detail: 'CLI가 설치되어 있지 않습니다.' };
            room.checks[id].login = { ...result, detail: redact(result.detail), at: Date.now() };
            if (id === 'gpt' && result.status === 'ok') await refreshModels(id);
          }));
          persist(); publish();
          return json(res, 200, view());
        }
        if (p === '/api/usage/refresh') {
          if (usage && clock() - usage.lastPoll >= 15000) pollUsage();
          return json(res, 200, { ok: true });
        }
        if (p === '/api/models/refresh') {
          if (!IDS.includes(body.id)) return json(res, 400, { error: 'AI를 확인하세요.' });
          await refreshModels(body.id);
          persist(); publish();
          return json(res, 200, view());
        }
        if (p === '/api/check/call') {
          const id = body.id;
          if (!IDS.includes(id)) return json(res, 400, { error: 'AI를 확인하세요.' });
          if (!available[id]) return json(res, 400, { error: `${nameOf(id)} CLI가 설치되어 있지 않습니다.` });
          if (checking.has(id)) return json(res, 409, { error: '이미 확인 중입니다.' });
          const base = body.target === 'debate' ? room.debateModels[id] : room.models[id];
          const settings = body.model ? settingsOf(id, { model: body.model, effort: body.effort ?? '' }, base, modelCache.gpt) : base;
          const controller = new AbortController();
          checking.set(id, controller);
          publish();
          let result;
          try {
            result = await adapter.chat(id, CHECK_BRIEF, '연결 확인입니다. OK라고만 답하세요.',
              { settings, independent: true, webSearch: false, signal: controller.signal, timeoutMs: 90000 });
          } catch (e) { result = { ok: false, detail: e.message }; } finally { checking.delete(id); }
          if (controller.signal.aborted) return json(res, 200, view());
          const ok = result.ok && !!result.text?.trim();
          const kind = ok ? null : errorKind(result.detail || '');
          room.checks[id].models[settings.model] = ok ? { status: 'ok', effort: settings.effort, at: Date.now() }
            : { status: 'fail', kind, label: kindLabel(kind), detail: redact(result.detail || '').slice(-400), effort: settings.effort, at: Date.now() };
          // A successful test of the auto model lets auto calls start again after an earlier stop.
          if (ok && autoSettings(id).model === settings.model) room.auto.usage.stopped = null;
          persist(); publish();
          return json(res, 200, view());
        }
        if (p === '/api/send') {
          // The user comes first: stop any auto call, drop its answer, and pause auto chat.
          sched.lastUserAt = clock();
          await stopAuto();
          if (active) return json(res, 409, { error: '현재 답변을 기다리거나 중지한 뒤 보내세요.' });
          const text = String(body.text || '').trim();
          if ((!text && !body.image) || text.length > 20000) return json(res, 400, { error: '질문을 입력하세요. 최대 20,000자입니다.' });
          // Who answers: AIs named with @ (only them, even in discussion), else the discussion group,
          // else the selected AI when "특정 AI" is on, else every AI that is on and connected.
          const named = mentionedTargets(text);
          const discussion = room.discussion && !named.length;
          const wanted = named.length ? named : discussion ? IDS : room.targeted ? [room.selected] : IDS;
          const participants = wanted.filter((id) => room.enabled[id] && available[id]);
          if (!participants.length) return json(res, 400, { error: '답할 수 있는 AI가 없습니다. 연결 설정을 확인하거나 쉬는 중인 AI를 켜 주세요.' });
          let attach;
          if (body.image) attach = { path: saveImage(store, body.image), upload: true };
          room.auto.lastWakeAt = clock();
          // Everyone left out is listed, except in the default all-AI chat where it would be noise.
          const excluded = named.length || discussion || room.targeted ? wanted.filter((id) => !participants.includes(id))
            .map((id) => ({ id, reason: room.enabled[id] ? '연결 설정 필요' : '쉬는 중' })) : [];
          const runId = crypto.randomUUID();
          const msg = post({ from: 'user', text, attach });
          begin({ ...structuredClone(room), discussion, models: structuredClone(discussion ? room.debateModels : room.models),
            text: text || '첨부한 사진을 살펴봐 주세요.', participants, excluded,
            images: attach ? [store.abs(attach.path)] : [] }, runId);
          return json(res, 200, { ok: true, msg });
        }
        return json(res, 404, { error: '지원하지 않는 기능입니다.' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: '지원하지 않는 요청입니다.' });
      if (p.startsWith('/ws/')) return await serve(res, store.abs(store.safeRel(p.slice(4))), true);
      const rel = p === '/' ? 'index.html' : p.slice(1);
      // Only current UI assets are served. Old game and developer pages are disabled.
      if (!['index.html', 'assistant.js', 'format.mjs', 'status.mjs', 'assistant.css', 'style.css'].includes(rel)
        && !/^avatars\/(?:(claude|gpt|gemini)(?:(-128)?\.webp|-pixel(-128)?\.png))$/.test(rel)) return json(res, 404, { error: '파일이 없습니다.' });
      return await serve(res, path.join(ROOT, 'public', rel));
    } catch (e) {
      if (!res.headersSent) json(res, e.code === 'ENOENT' ? 404 : 400, { error: e.message });
      else res.end();
    }
  });
  async function close() {
    const job = active;
    clearInterval(autoTimer);
    clearInterval(usageTimer);
    for (const timer of timers) clearTimeout(timer);
    job?.controller.abort();
    for (const controller of checking.values()) controller.abort();
    await stopAuto();
    if (job) await job.done;
    for (const client of clients) client.end();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  return { server, close, store, view, tick: autoTick, get active() { return active; } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const root = process.env.CHATROOM_HOME || ROOT;
  const adapter = new Adapters(root, cfg);
  const app = createAssistantServer({ root, cfg, adapter, usage: new UsageMonitor(root, adapter.bins) });
  app.server.on('error', (e) => { console.error(`서버 실행 실패: ${e.message}`); process.exitCode = 1; });
  app.server.listen(cfg.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${app.server.address().port}`;
    console.log(`AI 단톡방: ${url}\n이 앱이 켜져 있는 동안에만 가끔 자동 대화를 합니다. 화면 위쪽 [잡담] 버튼으로 끌 수 있습니다.`);
    console.log(app.view().members.map((m) => `${m.name}: ${m.available ? 'CLI 발견 (로그인은 호출 시 확인)' : 'CLI 없음'}`).join('\n'));
    if (process.argv.includes('--open')) {
      const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', (e) => console.error(`브라우저 열기 실패: ${e.message}`)).unref();
    }
  });
  const shutdown = async () => { await app.close(); killAll(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
