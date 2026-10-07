// Personal group chat. While the app runs it mixes scripted mood lines (no AI call) with rare,
// capped, short real AI calls (lib/auto.mjs) and bounded, sandboxed game collaborations.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { readJsonFile, writeFileAtomic } from './lib/atomic.mjs';
import { Adapters, killAll } from './lib/agents.mjs';
import { UsageMonitor } from './lib/usage.mjs';
import { MEMBERS } from './lib/members.mjs';
import { setLang } from './lib/i18n.mjs';
import { IDS, discuss, errorKind, kindLabel, KIND_SHORT } from './lib/discussion.mjs';
import { ActivityLog, topicOf } from './lib/activity.mjs';
import { pickPrimary } from './lib/callpick.mjs';
import { parseCall, parseNickname } from './public/recipients.mjs';
import { WAVE, INTERJECT_MIN_PCT } from './lib/auto.mjs';
import { mentionedTargets } from './lib/discussion.mjs';
import { heavyReason } from './lib/router.mjs';
import { LIMITS, LEVELS, DEFAULT_LEVEL, dayKey, freshUsage, usageFor, redact, pickScript, decide, AUTO_BRIEF, topicCount, autoHistory, autoPrompt, tidy, cleanMemo, cleanBio, splitMemo, memoBlock, cleanTitle, userLine, peerContext, greetPrompt, memberGreetPrompt, absentText } from './lib/auto.mjs';
import { ACTIVITY_LIMITS, ACTIVITY_PROMPT, parseActivity, postcard } from './lib/activities.mjs';
import { GAME_LIMITS, GAME_CSP, GAME_BRIEF, gamePrompt, parseDraft, applyGamePatches, gameDocument } from './lib/game.mjs';
import { checkGame } from './lib/gamecheck.mjs';
import { EMOJIS, BIO_INTERVAL } from './lib/social.mjs';
import { latestCall, quotaOf } from './public/status.mjs';
import { House, HOUSE_BRIEF, parseHouseReply } from './lib/house.mjs';
import { playerView, playerAction } from './lib/house-player.mjs';
import { isComplete, enterLife, lifeBeat, lifeEvent, drift, snapshot, markUndo, undo as undoHouse, decide as decideHouse, setMode as setHouseMode, relationHint, eventChatter, LIFE_PACE, EVENT_GAP } from './lib/life.mjs';
import { chooseShare, captionFor, renderShare, SHARE_GAP } from './lib/lifeshare.mjs';
import { todayDigest, buildNote, NOTE_GAP, TODAY_QUESTION } from './lib/digest.mjs';

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
export function loadConfig(configFile = process.env.CHATROOM_CONFIG || path.join(ROOT, 'config.json')) {
  const user = readJsonFile(configFile, {});
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
  writeFileAtomic(store.abs(rel), bytes);
  store.touchMeta(rel, 'user', true);
  return rel;
}

// clock/random/autoTickMs/pairDelayMs exist so tests can drive the auto chat without waiting.
// A busy model, a timeout or an unclear failure usually passes in minutes: the member that hit it sits out
// automatic calls for a short while and the others go on. Only lasting problems (sign-in, a wrong model
// name) stop automatic chat for the rest of the day.
const TRANSIENT = new Set(['capacity', 'timeout', 'unknown']);
const BRIEF_REST_MS = 10 * 60000;
const LASTING_REST_MS = 30 * 60000;

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
  const cleanAliases = (list) => (Array.isArray(list) ? [...new Set(list.filter((a) => typeof a === 'string' && /^[A-Za-z0-9가-힣]{2,10}$/.test(a.trim())).map((a) => a.trim()))].slice(-10) : []);
  const room = {
    selected: IDS.includes(preferences.selected) ? preferences.selected : 'claude',
    // callMode/targeted are read only for older saved rooms and clients; who answers is now decided per message
    // from the text itself (resolveCall). Nicknames the user gave the AIs are kept in `aliases`.
    aliases: Object.fromEntries(IDS.map((id) => [id, cleanAliases(preferences.aliases?.[id])])),
    discussion: preferences.discussion === true, webSearch: preferences.webSearch === true,
    callMode: ['auto', 'all', 'pick'].includes(preferences.callMode) ? preferences.callMode : preferences.targeted === true ? 'pick' : 'auto',
    models: Object.fromEntries(IDS.map((id) => [id, saved(id, preferences.models?.[id], cfg.agents[id])])),
    debateModels: Object.fromEntries(IDS.map((id) => [id, saved(id, preferences.debateModels?.[id], cfg.debateModels[id])])),
    synthesizer: IDS.includes(preferences.synthesizer) ? preferences.synthesizer : cfg.synthesizer,
    enabled: Object.fromEntries(IDS.map((id) => [id, preferences.enabled?.[id] !== false])),
    quotaRest: Object.fromEntries(IDS.map((id) => [id, preferences.quotaRest?.[id] || null])),
    awaySince: Object.fromEntries(IDS.map((id) => [id, Number(preferences.awaySince?.[id]) || preferences.quotaRest?.[id]?.at || 0])),
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
    bioChangedAt: { ...preferences.bioChangedAt },
    reactionAt: { ...preferences.reactionAt },
    memoOn: preferences.memoOn !== false,
    memos: Object.fromEntries(IDS.map((id) => [id, typeof preferences.memos?.[id] === 'string' ? cleanMemo(preferences.memos[id]) : ''])),
    // on: the room power button (off until pressed). level: 낮음/중간/높음 → effort, pace, daily limit.
    auto: {
      on: preferences.auto?.on === true, level: LEVELS[preferences.auto?.level] ? preferences.auto.level : DEFAULT_LEVEL,
      // A day stop saved by an older version for a passing error (e.g. "capacity") is lifted on start.
      usage: (({ stopped = null, ...rest }) => ({ ...rest, stopped: TRANSIENT.has(stopped) ? null : stopped }))({ ...freshUsage(clock()), ...preferences.auto?.usage }),
      lastError: preferences.auto?.lastError || null,
      sleepMinutes: [0, 5, 15, 30, 60].includes(preferences.auto?.sleepMinutes) ? preferences.auto.sleepMinutes
        : [0, 5, 15, 30, 60].includes(cfg.autoSleepMinutes) ? cfg.autoSleepMinutes : 30,
      lastWakeAt: Number(preferences.auto?.lastWakeAt) || clock(),
      lastCreationAt: Number(preferences.auto?.lastCreationAt) || 0,
    },
    checks: Object.fromEntries(IDS.map((id) => [id, { login: preferences.checks?.[id]?.login || null, models: preferences.checks?.[id]?.models || {} }])),
    modelCache,
    // Life sharing and helpful notes (no AI call): their next times and what was shared last.
    life: { shareAt: preferences.life?.shareAt ?? clock() + 20 * 60000, noteAt: preferences.life?.noteAt ?? clock() + 60 * 60000, lastNoteAt: preferences.life?.lastNoteAt ?? 0, last: preferences.life?.last ?? {} },
  };
  // Resume from now, not from overdue appointments; never replay missed automatic actions.
  for (const [key, minutes] of [['shareAt', 20], ['noteAt', 60]]) {
    room.life[key] = Math.max(Number(room.life[key]) || 0, clock() + minutes * 60000);
  }
  room.targeted = room.callMode === 'pick';
  const checking = new Map();
  // The shared activity timeline (data/activity.json): one-line summaries with refs, capped by count and age.
  const activity = new ActivityLog(path.join(root, 'data', 'activity.json'), { clock });
  const record = (entry) => { try { return activity.add(entry); } catch (e) { store.log('activity', redact(e.message)); return null; } };
  let activityHook = () => {};
  const connected = (id) => {
    const check = room.checks[id];
    const call = latestCall(check);
    if (!available[id] || check.login?.status === 'fail' || (call?.status === 'fail' && call.kind === 'auth')) return false;
    return check.login?.status === 'ok' || call?.status === 'ok';
  };
  const changeBio = (id, bio) => {
    if (!bio || bio === room.bios[id]) return;
    if (room.bios[id] && (clock() - (room.bioChangedAt[id] || 0) < BIO_INTERVAL || random() >= 0.08)) return;
    room.bios[id] = bio; room.bioChangedAt[id] = clock(); persist();
  };
  let active = null;
  let autoJob = null;
  let houseJob = null;
  let closed = false;
  const memberReturns = new Map();
  const persist = () => { store.state.assistant = structuredClone(room); store.saveState(); };
  const recordSuccess = (message) => {
    if (!IDS.includes(message.from) || !message.model || !message.text?.trim() || message.kind === 'error' || message.auto === 'ambient') return;
    const check = room.checks[message.from];
    const at = message.ts;
    if (!check.models[message.model] || at > check.models[message.model].at) {
      check.models[message.model] = { status: 'ok', effort: message.effort || '', at };
    }
    if (!check.login || at > check.login.at) check.login = { status: 'ok', at };
  };
  // Recover real successes from older versions that only recorded explicit test calls.
  for (const message of store.messages) recordSuccess(message);
  persist();
  const broadcast = (type, data) => {
    const event = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      // A stalled tab reconnects from persisted state instead of buffering forever.
      if (client.destroyed || client.writableLength > 1024 * 1024) { clients.delete(client); client.destroy(); }
      else client.write(event);
    }
  };
  const post = (message) => {
    if (message.detail) message = { ...message, detail: redact(message.detail) };
    const saved = store.addMessage({ ts: clock(), ...message });
    recordSuccess(saved);
    persist();
    broadcast('message', saved);
    // The house conversation shows what the owner and the AIs say in the chat (house lines are already there).
    if ((saved.from === 'user' || IDS.includes(saved.from)) && saved.kind !== 'house-say' && saved.text) {
      house.s.log.push({ kind: 'say', id: saved.from, text: saved.text.slice(0, 200), at: saved.ts });
      house.save(); broadcast('house', {});
    }
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
      connected: connected(id),
      listedAt: id === 'gpt' ? modelCache.gpt?.at || null : null,
      models: list.map((m) => ({ ...m, efforts: effortsFor(id, m.id, modelCache.gpt) || [], check: room.checks[id].models[m.id] || null })),
    }];
  }));
  const view = () => ({
    // Life bookkeeping stays on the server.
    room: { ...room, modelCache: undefined, life: undefined, name: room.roomName, userName: room.userName, checking: [...checking.keys()],
      active: active ? { id: active.id, mode: active.mode, states: active.states, calls: active.calls, synthesizer: active.synthesizer, models: active.models } : null,
      autoRunning: !!autoJob, autoSleeping: autoSleeping(), autoDaily: LEVELS[room.auto.level].daily, autoReady: eligibleAuto().length > 0,
      autoUses: Object.fromEntries(IDS.map((id) => [id, autoSettings(id)])),
      recommended: Object.fromEntries(IDS.map((id) => [id, recommendedSettings(id)])),
      autoNextAt: autoNextAt(),
      autoRest: room.auto.on && eligibleAuto().length > 0 && (!!usageFor(room.auto, clock()).stopped || usageFor(room.auto, clock()).calls >= LEVELS[room.auto.level].daily) },
    members: IDS.map((id) => ({ id, name: MEMBERS[id].name, maker: MEMBERS[id].maker, color: MEMBERS[id].color,
      available: !!available[id], enabled: room.enabled[id], model: room.models[id].model, activity: memberActivity(id), health: memberHealth(id) })),
    usage: usageView(), catalog: catalog(), kinds: KIND_SHORT, messages: store.recent(300), files: store.listFiles(),
    activity: { recent: Object.fromEntries(IDS.map((id) => [id, activity.list({ actor: id, limit: 5 })])) },
  });
  const publish = () => broadcast('state', view());
  // What each member is doing right now, only from facts the server holds (no AI is asked). When it is
  // otherwise idle in a lived-in house, its house life ("☕ 소파에서 쉬는 중") is shown.
  function memberActivity(id) {
    const now = appActivity(id);
    const doing = house.s.phase === 'life' && house.s.agents[id]?.doing;
    return now.kind === 'idle' && doing ? { kind: 'home', text: doing } : now;
  }
  function appActivity(id) {
    const name = (x) => nameOf(x);
    if (active?.states[id]?.status === '생성 중') return { kind: 'reply', text: '✍️ 답변 작성 중' };
    if (autoJob?.speaker === id) return { kind: 'talk', text: '💬 Talk에서 말하는 중' };
    if (autoJob?.members?.includes(id)) {
      const others = autoJob.members.filter((x) => x !== id).map(name);
      return { kind: 'talk', text: others.length ? `💬 ${others.join('·')}와 대화 중` : '💬 Talk 대화 중' };
    }
    if (houseJob?.actor === id) return { kind: 'house', text: '🏠 집 짓는 중' };
    if (room.quotaRest[id]) return { kind: 'rest', text: '😴 한도 회복 중' };
    if (!room.enabled[id]) return { kind: 'off', text: '☕ 쉬는 중' };
    if (room.auto.on && autoSleeping()) return { kind: 'sleep', text: '💤 잠든 중' };
    return { kind: 'idle', text: '🟢 대기 중' };
  }
  // The room state is re-sent only when a member's house activity changes.
  let activityKey = '';
  activityHook = () => {
    const key = JSON.stringify(IDS.map((id) => memberActivity(id).text));
    if (key !== activityKey) { activityKey = key; publish(); }
  };
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
  // Resting members must recover even when no browser is open.
  const usageTimer = usage ? setInterval(() => {
    if ((clients.size || IDS.some((id) => room.quotaRest[id]?.autoResume)) && clock() - usage.lastPoll >= 600000) pollUsage();
  }, 60000) : null;
  usageTimer?.unref?.();
  const nameOf = (id) => MEMBERS[id]?.name || id;
  function memberLeft(id) {
    room.awaySince[id] = clock();
    memberReturns.delete(id);
  }
  function memberReturned(id) {
    const since = room.awaySince[id];
    room.awaySince[id] = 0; // consume this absence before any asynchronous call or reload
    if (!greetings || !available[id] || !since || clock() - since < 10 * 60000) return;
    const peers = eligibleAuto().filter((other) => other !== id && !memberReturns.has(other));
    if (peers.length) memberReturns.set(id, {
      kind: 'member-back', memberId: id, peers, absent: absentText(clock() - since), started: false,
    });
  }
  function restForQuota(id, windows = []) {
    if (room.quotaRest[id]) return;
    const wasOn = room.enabled[id];
    room.quotaRest[id] = { at: clock(), autoResume: wasOn, windows };
    room.enabled[id] = false;
    if (wasOn) {
      memberLeft(id);
      post({ from: id, text: '나 잠깐 쉬러간다 ㅋㅋ', quotaNotice: true });
      post({ from: 'system', kind: 'presence', presence: true, by: id, text: `${nameOf(id)}가 잠깐 나감` });
      record({ kind: 'system', actors: [id], text: `${nameOf(id)} 사용량 한도로 휴식 시작` });
    }
    persist(); publish();
  }
  function recoverQuota(id) {
    const rest = room.quotaRest[id];
    if (!rest) return;
    room.quotaRest[id] = null;
    for (const [model, call] of Object.entries(room.checks[id].models)) {
      if (call.kind === 'quota') delete room.checks[id].models[model];
    }
    if (rest.autoResume) {
      room.enabled[id] = true;
      post({ from: 'system', kind: 'presence', presence: true, by: id, text: `${nameOf(id)} 들어옴` });
      record({ kind: 'system', actors: [id], text: `${nameOf(id)} 사용량 회복 후 복귀` });
      memberReturned(id);
    }
    persist(); publish();
  }
  function reconcileQuota() {
    const reports = usage?.view();
    for (const id of IDS) {
      const report = reports?.[id];
      // A cached, failed or stale lookup cannot prove exhaustion or recovery.
      if (!available[id] || !report?.ok || report.restored || !Number.isFinite(report.at)
        || report.at > clock() || clock() - report.at > 600000) continue;
      const windows = (report.windows || []).filter((w) => !w.minor && ['5h', 'week'].includes(w.id));
      if (!windows.length || windows.some((w) => !Number.isFinite(w.usedPct) || w.usedPct < 0)) continue;
      const exhausted = windows.filter((w) => w.usedPct >= 100).map((w) => w.id);
      const rest = room.quotaRest[id];
      if (rest) {
        if (report.at <= rest.at) continue;
        if (exhausted.length) {
          rest.windows = [...new Set([...rest.windows, ...exhausted])];
          persist();
        } else if (rest.windows.every((key) => windows.some((w) => w.id === key))) recoverQuota(id);
      } else if (room.enabled[id] && exhausted.length) restForQuota(id, exhausted);
    }
  }
  function begin(request, runId) {
    const mode = request.discussion ? 'discussion' : 'answer';
    const job = { id: runId, controller: new AbortController(), states: {}, calls: 0, mode, speakers: new Set(),
      synthesizer: request.discussion ? request.synthesizer : null,
      models: Object.fromEntries(request.participants.map((id) => [id, request.models[id]])) };
    if (request.discussion) for (const id of request.participants) job.states[id] = { phase: 'opinion', status: '대기' };
    for (const { id, reason } of request.excluded) job.states[id] = { phase: '', status: '제외', reason };
    active = job;
    publish();
    const history = store.recent(40).filter((m) => m.from !== 'system' && m.auto !== 'ambient' && !m.phase?.match(/opinion|review/))
      .map((m) => `[${m.id}] ${m.from === 'user' ? room.userName : m.from}${m.replyTo ? ` → 답장 #${m.replyTo}` : ''}: ${m.text}`).join('\n').slice(-18000);
    job.done = discuss({
      adapter, request, history, signal: job.controller.signal,
      canCall: (id) => room.enabled[id] && available[id] && !room.quotaRest[id] && room.checks[id].login?.status !== 'fail',
      onState: ({ phase, id, status, kind, calls }) => {
        job.calls = calls;
        job.states[id] = { phase, status, kind };
        if (status === '실패') {
          room.checks[id].models[request.models[id].model] = { status: 'fail', kind, label: kindLabel(kind), at: clock() };
          if (kind === 'quota') restForQuota(id);
          persist();
        }
        publish();
      },
      onMessage: (m) => {
        const target = store.byId.get(m.replyTo);
        if (IDS.includes(m.from) && m.kind !== 'error') job.speakers.add(m.from);
        return post({ ...m, replyPreview: target ? { from: target.from, text: target.text.slice(0, 180) } : undefined, runId: job.id, mode });
      },
      onLog: (id, text) => store.log(id, redact(text)),
      onMemo: (id, memo) => { room.memos[id] = memo; persist(); },
      onBio: (id, bio) => { changeBio(id, bio); publish(); },
      onReaction: (id, reaction) => {
        const target = store.byId.get(reaction.id);
        if (!target || target.from === id || target.from === 'system' || clock() - (room.reactionAt[id] || 0) < 5 * 60000 || random() >= 0.2) return;
        if (store.applyReaction(target.id, id, reaction.emoji)) {
          room.reactionAt[id] = clock(); persist(); publish();
        }
      },
      onImageRequest: (id, prompt) => { request.imageRequest ??= { id, prompt }; },
    }).then(async (result) => {
      if (job.speakers.size) {
        const names = [...job.speakers].map(nameOf).join('·');
        record({ kind: 'chat', actors: [...job.speakers], ref: { messageId: request.messageId, runId: job.id },
          text: `${names}${mode === 'discussion' ? ' 토론 · ' : '가 '}"${topicOf(store.byId.get(request.messageId)?.text || '사진')}"${mode === 'discussion' ? '' : '에 답함'}` });
      }
      if (job.controller.signal.aborted) return;
      if (request.imageRequest) {
        const { id: planner, prompt } = request.imageRequest;
        const maker = [planner, ...IDS].find((id) => ['gpt', 'gemini'].includes(id)
          && connected(id) && room.enabled[id] && !room.quotaRest[id]);
        if (!maker || cfg.imageGen === false) {
          post({ from: 'system', kind: 'error', runId, text: '이미지를 제작할 수 있는 GPT 또는 Gemini 연결이 필요합니다. 이미지 생성 설정도 확인해 주세요.' });
        } else {
          job.states[maker] = { phase: 'answer', status: '생성 중' }; job.calls++; publish();
          try {
            const generated = await adapter.image(maker, prompt, { signal: job.controller.signal, refSheet: request.images?.[0] });
            if (job.controller.signal.aborted) return;
            if (!generated.ok || !generated.file) throw new Error(generated.detail || '이미지 생성 실패');
            if (fs.statSync(generated.file).size > 2 * 1024 * 1024) throw new Error('생성된 사진이 2MB를 넘습니다.');
            const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(generated.file).toLowerCase()];
            const rel = saveImage(store, { mime, data: fs.readFileSync(generated.file).toString('base64') });
            const shown = post({ from: maker, runId, replyTo: request.messageId, text: `기획 ${nameOf(planner)} · 이미지 생성 ${nameOf(maker)}`,
              attach: { path: rel, generated: true, label: `이미지 생성 ${nameOf(maker)}` } });
            record({ kind: 'creation', actors: [planner, maker], text: `${nameOf(maker)}가 요청받은 이미지 생성`, ref: { messageId: shown.id, path: rel } });
            job.states[maker] = { phase: 'answer', status: '완료' };
          } catch (e) {
            if (job.controller.signal.aborted) return;
            job.states[maker] = { phase: 'answer', status: '실패' };
            post({ from: 'system', kind: 'error', runId, text: '이미지를 생성하지 못했습니다.', detail: e.message });
          }
          publish();
        }
      }
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
  // A member whose known remaining usage is under 20% starts no new spontaneous call (Talk, house turns);
  // it still answers the user and still lives in the house with no-call actions.
  // `headroom: false` (house turns) skips the extra minPct of 활발하게, so the whole family builds together.
  function eligibleAuto({ headroom = true } = {}) {
    const reports = usageView();
    const minPct = LEVELS[room.auto.level].minPct || 0; // the freest level wants more headroom (known usage only)
    return IDS.filter((id) => {
      const call = room.checks[id].models[autoSettings(id).model];
      const quota = quotaOf(id, reports?.[id], clock());
      return room.enabled[id] && !room.quotaRest[id] && available[id] && room.checks[id].login?.status !== 'fail'
        && !(call?.status === 'fail' && clock() - call.at < (TRANSIENT.has(call.kind) ? BRIEF_REST_MS : LASTING_REST_MS))
        && !quota.low && !(headroom && minPct && quota.known && quota.pct < minPct);
    });
  }
  // What the server is actually doing about a member's errors, for the UI to show as is (it keeps no
  // timers of its own): resting for quota, a sign-in or model problem, or a short cooldown after a passing
  // error (the same window eligibleAuto applies). null when nothing holds the member back.
  function memberHealth(id) {
    if (!available[id]) return null;
    if (room.quotaRest[id]) return { state: 'quota' };
    const check = room.checks[id], last = latestCall(check);
    if (check.login?.status === 'fail' || (last?.status === 'fail' && last.kind === 'auth')) return { state: 'auth' };
    if (last?.status === 'fail' && last.kind === 'model') return { state: 'model' };
    const auto = check.models[autoSettings(id).model];
    const until = auto?.status === 'fail' && TRANSIENT.has(auto.kind) ? auto.at + BRIEF_REST_MS : 0;
    return until > clock() ? { state: 'cooldown', kind: auto.kind, until } : null;
  }
  // The member sits out automatic calls for BRIEF_REST_MS (see eligibleAuto); nothing else stops.
  function restBriefly(id, kind, detail) {
    room.checks[id].models[autoSettings(id).model] = { status: 'fail', kind, label: kindLabel(kind), detail, effort: autoSettings(id).effort, at: clock() };
    room.auto.lastError = { id, kind, detail, at: clock() };
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
  // Reply link for an automatic line that answers the line before it (the existing replyTo / replyPreview fields).
  const replyFields = (to) => (to ? { replyTo: to.id, replyPreview: { from: to.from, text: String(to.text || '').slice(0, 180) } } : {});
  function postChatter(now, usage) {
    const speakers = IDS.filter((id) => room.enabled[id]);
    const recent = store.messages.filter((m) => m.auto === 'ambient').slice(-LIMITS.repeatWindow).map((m) => m.text);
    // Now and then the scripted lines follow a recent house event between two members (still no AI call).
    const special = house.s.phase === 'life' && random() < 0.3 ? eventChatter(house, speakers, { names: houseNames, now, rand: random }) : null;
    const script = special && !recent.includes(special[0].text) ? special : pickScript({ recent, speakers: shuffled(speakers), names: Object.fromEntries(IDS.map((id) => [id, nameOf(id)])), rand: random, userName: room.userName });
    if (!script) return false;
    // The second scripted line answers the first, so it is shown as a reply to it.
    const say = (line, to) => { usage.chatter++; const m = post({ from: line.id, text: line.text, auto: 'ambient', ...replyFields(to) }); persist(); return m; };
    const first = say(script[0]);
    if (script[1]) {
      const asked = sched.lastUserAt;
      const timer = setTimeout(() => {
        timers.delete(timer);
        try {
          if (!closed && sched.lastUserAt === asked && room.auto.on && !autoSleeping() && room.enabled[script[1].id]
            && usage.chatter < LIMITS.chatterPerDay && sinceUser(clock()).chatter < LIMITS.maxChatterSinceUser) say(script[1], first);
        } catch (e) { store.log('auto', redact(e.message)); }
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
      Object.assign(store.meta[rel], { activity: 'photo', title: activity.title });
      store.touchMeta(rel, id, true);
      return { attach: { path: rel, generated: true, label: 'AI가 생성한 가상 사진' } };
    }
    const rel = `activities/${crypto.randomUUID()}.svg`;
    store.applyFileOp({ op: 'write', path: rel, content: postcard(activity) }, id);
    Object.assign(store.meta[rel], { activity: 'postcard', title: activity.title });
    store.touchMeta(rel, id, true);
    return { attach: { path: rel, generated: true, label: 'AI가 고른 가상 장면 · 자동 그림' } };
  }
  async function createGame(a, b, activity, usage, job) {
    usage.games++; usage.creations++; room.auto.lastCreationAt = clock(); persist();
    let code; let title = activity.title; let check = null;
    let worker = a;
    const lines = [];
    const cancelled = () => job.controller.signal.aborted || autoSleeping();
    try {
      for (const [stage, id] of [a, b, a].entries()) {
        if (cancelled()) return;
        if (!room.enabled[a] || !room.enabled[b]) throw new Error('게임 제작 참여자가 쉬는 중입니다.');
        worker = id; job.speaker = id; publish();
        if (usage.calls >= LEVELS[room.auto.level].daily) throw new Error('오늘의 자동 호출 예산을 다 썼습니다.');
        usage.calls++; persist(); publish();
        const settings = autoSettings(id);
        const result = await adapter.chat(id, GAME_BRIEF + userLine(room.userName) + peerContext(nameOf(id), [nameOf(id === a ? b : a)]),
          gamePrompt(stage, activity.prompt || activity.title, code, check)
            + `\n\n[이번 게임 제작 대화 — 참고 자료]\n${lines.join('\n') || '(아직 없음)'}`,
          { settings, independent: true, webSearch: false, signal: job.controller.signal, timeoutMs: LIMITS.callTimeoutMs });
        if (cancelled()) return;
        if (!result.ok) {
          const kind = errorKind(result.detail || '');
          if (TRANSIENT.has(kind)) restBriefly(id, kind, redact(result.detail || '').slice(-400));
          else if (kind !== 'quota') usage.stopped = kind;
          throw new Error(result.detail || '게임 제작 AI 호출에 실패했습니다.');
        }
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
          Object.assign(store.meta[rel], { activity: 'game', title, creators: [a, b] });
          store.touchMeta(rel, id, true);
          artifact = { game: { path: rel, title, creators: [a, b], checked: true } };
        }
        const said = post({ from: id, text: reply.text, ...artifact, auto: 'call', gameStage: stage,
          model: settings.model, effort: settings.effort || '' });
        if (artifact) record({ kind: 'creation', actors: [a, b], text: `${nameOf(a)}·${nameOf(b)}가 게임 "${topicOf(title, 20)}" 완성`, ref: { messageId: said.id, path: artifact.game.path } });
        lines.push(`${nameOf(id)}: ${reply.text}`);
      }
    } catch (e) {
      if (cancelled()) return;
      const detail = redact(e.message).slice(-400);
      if (errorKind(detail) === 'quota') restForQuota(worker);
      room.auto.lastError = { id: worker, kind: errorKind(detail), detail, at: clock() };
      post({ from: 'system', kind: 'error', errorKind: errorKind(detail),
        text: '게임 제작을 완료하지 못해 오늘의 게임 제작은 쉬어요. 완성되지 않은 게임은 올리지 않았어요.', detail });
    }
  }
  // Greetings cover the user ('first'/'back') or one returning AI ('member-back').
  // A greeting failure is logged and skipped rather than resting the whole room for the day.
  async function autoBurst(now, usage, plan = { kind: 'chat' }) {
    const job = { controller: new AbortController(), members: [], speaker: null, posted: [] };
    autoJob = job;
    const invalidReturn = () => plan.kind === 'member-back'
      && (memberReturns.get(plan.memberId) !== plan || !room.enabled[plan.memberId] || !room.enabled[plan.speaker]);
    const sleepTimer = room.auto.on && room.auto.sleepMinutes > 0
      ? setTimeout(() => job.controller.abort(), Math.max(0, room.auto.lastWakeAt + room.auto.sleepMinutes * 60000 - clock())) : null;
    sleepTimer?.unref?.();
    publish();
    job.done = (async () => {
      // Reserve the job before the asynchronous model lookup, so another greeting cannot overlap it.
      if (!modelCache.gpt && available.gpt) { try { await refreshModels('gpt'); } catch { /* falls back to the normal model */ } }
      const pool = eligibleAuto();
      const picks = [];
      const lastSpeaker = store.messages.at(-1)?.from;
      const turns = plan.kind === 'member-back' ? 1 : plan.kind === 'chat' ? LEVELS[room.auto.level].turns : Math.min(2, pool.length);
      for (let i = 0; i < turns; i++) {
        const prev = picks.at(-1) ?? lastSpeaker;
        const others = pool.length > 1 ? pool.filter((id) => id !== prev) : pool;
        picks.push(plan.kind === 'member-back' ? plan.speaker : shuffled(others)[0]);
      }
      job.members = [...new Set(picks)];
      const topic = Math.floor(random() * topicCount);
      const lines = [];
      for (const [index, id] of picks.entries()) {
        if (job.controller.signal.aborted || autoSleeping() || invalidReturn()) return;
        if (!eligibleAuto().includes(id)) continue;
        const peers = eligibleAuto().filter((other) => other !== id);
        if (usage.calls >= LEVELS[room.auto.level].daily) break;
        usage.calls++; persist(); // counted before the call, so a stopped call still counts
        job.speaker = id; publish();
        const settings = autoSettings(id);
        const history = autoHistory(store.recent(40), nameOf, room.userName);
        // One or two short lines about this member's latest house events: a light flavour, not a script.
        const hint = plan.kind === 'chat' && house.s.phase === 'life' ? relationHint(house, id, { names: houseNames, now: clock() }) : [];
        const prompt = plan.kind === 'chat'
          ? autoPrompt({ topic, history, previous: lines.slice(-3).join('\n'), index, total: picks.length, hour: new Date(clock()).getHours() })
            + (hint.length ? `\n\n[최근 집 소식 — 참고만. 말투에 아주 약하게만 반영하고 다투지 마]\n${hint.map((l) => `- ${l}`).join('\n')}` : '')
          : plan.kind === 'member-back' ? memberGreetPrompt({ name: nameOf(plan.memberId), absent: plan.absent, history })
          : greetPrompt({ kind: plan.kind, userName: room.userName, history, previous: lines.at(-1) || '', absent: plan.absent, index });
        // The app selects creations automatically within the shared cooldowns and call budget.
        const creative = plan.kind === 'chat' && index === 0 && usage.creations < ACTIVITY_LIMITS.daily
          && clock() - room.auto.lastCreationAt >= ACTIVITY_LIMITS.gapMs;
        const gameAllowed = peers.length > 0 && usage.games < GAME_LIMITS.daily
          && LEVELS[room.auto.level].daily - usage.calls >= GAME_LIMITS.turns;
        let result;
        try {
          result = await adapter.chat(id, AUTO_BRIEF + userLine(room.userName)
            + (plan.kind === 'chat' || plan.kind === 'member-back' ? peerContext(nameOf(id), peers.map(nameOf)) : ''), prompt + (creative ? ACTIVITY_PROMPT
            + (gameAllowed ? '\n이번 턴 game을 제안해도 된다.' : '\n이번 턴 game은 선택하지 않는다. 동료·일일 게임 제한·호출 예산 조건이 맞지 않는다.') : '') + memoBlock(room.memos[id], room.memoOn, room.bios[id]),
            { settings, independent: true, webSearch: false, signal: job.controller.signal, timeoutMs: LIMITS.callTimeoutMs });
        } catch (e) { result = { ok: false, detail: e.message }; }
        if (job.controller.signal.aborted || autoSleeping() || invalidReturn()) return; // drop cancelled or outdated greetings too
        const split = result.ok ? splitMemo(result.text || '') : null;
        const parsed = creative && split ? parseActivity(split.text) : null;
        const text = split ? tidy(parsed?.text || split.text) : '';
        if (!text) {
          // Quota failures rest only this member; other failures retain the daily stop.
          // Keep only the CLI's last lines: its error output can echo the whole prompt.
          const detail = redact(result.detail || 'AI가 답변을 반환하지 않았습니다.').split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ').slice(-400);
          const kind = errorKind(detail);
          store.log(id, `auto ${detail}`);
          if (kind === 'quota') {
            room.checks[id].models[settings.model] = { status: 'fail', kind, label: kindLabel(kind), detail, effort: settings.effort, at: clock() };
            room.auto.lastError = { id, kind, detail, at: clock() };
            restForQuota(id);
            continue;
          }
          if (plan.kind !== 'chat') return; // a greeting that fails is simply skipped
          if (TRANSIENT.has(kind)) { restBriefly(id, kind, detail); persist(); continue; } // the round goes on with the others
          usage.stopped = kind;
          room.auto.lastError = { id, kind, detail: detail.slice(-400), at: clock() };
          room.checks[id].models[settings.model] = { status: 'fail', kind, label: kindLabel(kind), detail: detail.slice(-400), effort: settings.effort, at: clock() };
          return;
        }
        if (split.memo && room.memoOn) { room.memos[id] = split.memo; persist(); }
        if (split.bio && room.memoOn) changeBio(id, split.bio);
        let artifact;
        if (parsed?.activity?.kind === 'game') {
          job.posted.push(post({ from: id, text, auto: 'call', model: settings.model, effort: settings.effort || '', ...replyFields(job.posted.at(-1)) }));
          if (gameAllowed) await createGame(id, peers[0], parsed.activity, usage, job);
          else post({ from: 'system', kind: 'complete', text: '공동 게임 제작에는 AI 두 명과 남은 호출 3회가 필요해요. 게임은 하루 1개만 시도해요.' });
          return;
        }
        if (parsed?.activity) {
          try { artifact = await createActivity(id, parsed.activity, usage, job); }
          catch (e) {
            if (job.controller.signal.aborted || autoSleeping()) return;
            const detail = redact(e.message).slice(-400);
            const kind = errorKind(detail);
            const passing = TRANSIENT.has(kind);
            if (kind === 'quota') restForQuota(id);
            else if (passing) restBriefly(id, kind, detail);
            else usage.stopped = kind;
            room.auto.lastError = { id, kind, detail, at: clock() };
            post({ from: 'system', kind: 'error', errorKind: kind,
              text: kind === 'quota' ? '한도에 도달한 AI가 쉬러 가서 자동 창작을 완료하지 못했어요.'
                : passing ? '자동 창작을 완료하지 못했어요. 해당 AI만 잠깐 쉬고 다른 AI는 계속해요.' : '자동 창작을 완료하지 못해 오늘의 자동 호출을 쉬어요.', detail });
            if (kind === 'quota' || passing) continue;
            return;
          }
        }
        if (job.controller.signal.aborted || autoSleeping()) return;
        // Later turns of a Talk round answer the line before them, so they are linked as replies.
        const said = post({ from: id, text, ...artifact, auto: plan.kind === 'chat' ? 'call' : 'greet',
          ...(plan.kind === 'member-back' ? { returnTo: plan.memberId } : {}), model: settings.model, effort: settings.effort || '',
          // Not every line is a reply to the one before it: about half are, the rest just join the conversation.
          ...(plan.kind === 'chat' && random() < 0.5 ? replyFields(job.posted.at(-1)) : {}) });
        job.posted.push(said);
        if (artifact) record({ kind: 'creation', actors: [id], ref: { messageId: said.id, path: artifact.attach.path },
          text: `${nameOf(id)}가 ${parsed.activity.kind === 'photo' ? '가상 사진' : '그림'} 공유: ${topicOf(parsed.activity.title, 20)}` });
        lines.push(`${nameOf(id)}: ${text}`);
      }
    })().catch((e) => { store.log('auto', redact(e.message)); })
      .finally(() => {
        const spoke = [...new Set(job.posted.map((m) => m.from))];
        if (spoke.length) record({ kind: 'talk', actors: spoke, ref: { messageId: job.posted[0].id },
          text: plan.kind === 'chat' ? `${spoke.map(nameOf).join('·')} Talk 대화 (${job.posted.length}마디)`
            : plan.kind === 'member-back' ? `${spoke.map(nameOf).join('·')}가 ${nameOf(plan.memberId)} 복귀 인사` : `${spoke.map(nameOf).join('·')}가 ${room.userName}에게 인사` });
        clearTimeout(sleepTimer);
        if (memberReturns.get(plan.memberId) === plan) memberReturns.delete(plan.memberId);
        if (autoJob === job) autoJob = null;
        arm(clock()); persist(); publish();
      });
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
  // ---------- the house: members build it slowly, one short turn at a time, only while Talk is on ----------
  const MIN = 60000;
  // 활발하게: a house turn every 30 seconds, up to 100 a day (each also counts against the level's shared daily call cap).
  const HOUSE_PACE = { low: { gap: [30 * MIN, 60 * MIN], daily: 3 }, medium: { gap: [8 * MIN, 15 * MIN], daily: 12 }, high: { gap: [30 * 1000, 30 * 1000], daily: 100 } };
  const house = new House(path.join(root, 'data', 'house.json'), { ids: IDS, names: Object.fromEntries(IDS.map((id) => [id, nameOf(id)])) });
  let houseNext = null; // set when a builder @mentions a teammate in its house line
  let houseAt = clock() + MIN; // after a restart the unfinished work resumes soon (if Talk is on)
  function houseTurn() {
    const now = clock();
    if (closed || houseJob || now < houseAt || !room.auto.on || autoSleeping() || active || autoJob) return Promise.resolve();
    const pace = HOUSE_PACE[room.auto.level];
    const usage = usageFor(room.auto, now);
    const order = eligibleAuto({ headroom: false });
    if (!order.length || usage.stopped || usage.calls >= LEVELS[room.auto.level].daily || (usage.house || 0) >= pace.daily) return Promise.resolve();
    // The teammate the last builder called with @ goes next; otherwise they take turns.
    const id = houseNext && houseNext !== house.s.lastActor && order.includes(houseNext) ? houseNext : order[(order.indexOf(house.s.lastActor) + 1) % order.length];
    houseNext = null;
    const job = { controller: new AbortController(), actor: id };
    houseJob = job; publish();
    usage.house = (usage.house || 0) + 1; usage.calls++; persist(); // counted before the call, so a stopped call still counts
    // A lived-in house needs only small touches: its AI turns come half as often.
    houseAt = now + between(pace.gap) * (house.s.phase === 'life' ? 2 : 1);
    const before = house.s.phase === 'life' ? snapshot(house) : null;
    job.done = (async () => { try {
      const settings = autoSettings(id);
      const result = await adapter.chat(id, HOUSE_BRIEF, house.prompt(id, { resumedAfterMs: house.s.lastTurnAt ? now - house.s.lastTurnAt : 0, resting: IDS.filter((other) => other !== id && !order.includes(other)) }),
        { settings, independent: true, webSearch: false, signal: job.controller.signal, timeoutMs: LIMITS.callTimeoutMs * 2 });
      if (job.controller.signal.aborted || !room.auto.on || autoSleeping()) return;
      const reply = result.ok ? parseHouseReply(result.text) : null;
      if (!reply) {
        const detail = redact(result.detail || 'AI가 집 작업 JSON을 반환하지 않았습니다.').split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ').slice(-400);
        store.log(id, `house ${detail}`);
        if (errorKind(detail) === 'quota') restForQuota(id);
        return;
      }
      const turn = house.apply(id, reply, clock());
      const summary = turn.done.filter(Boolean).join(', ').slice(0, 80);
      // In the life phase an automatic change is shown with an undo, instead of being asked about first.
      if (before && summary) { markUndo(house, before, id, `${nameOf(id)}: ${summary}`, clock()); house.save(); }
      broadcast('house', {});
      if (turn.notice) post({ from: 'system', kind: 'house-build', by: id, text: turn.notice });
      // What the builder says is shared in the chat too (no extra AI call); an @mention picks who builds next.
      // Only now and then: a line that hands the work to a teammate is usually shared, a plain one rarely. A shared line
      // is sometimes a reply to the teammate's last shared line and sometimes not.
      if (turn.say) {
        // Nobody is called who is resting (limit, off, sign-in): that @ would go unanswered, so it is shown as a plain name.
        const awake = eligibleAuto({ headroom: false });
        turn.say = turn.say.replace(/@([A-Za-z가-힣]+)/g, (m, word) => (mentionedTargets(m).some((target) => !awake.includes(target)) ? word : m));
        const called = mentionedTargets(turn.say).find((target) => target !== id && awake.includes(target)) || null;
        houseNext = called;
        // Every line is shared as a reply to the teammate's last line, so the builders' discussion reads as a conversation.
        const last = store.messages.findLast((m) => m.kind === 'house-say');
        const reply = last && last.from !== id && clock() - last.ts < 10 * 60000 ? last : null;
        post({ from: id, kind: 'house-say', auto: 'house', text: turn.say, ...replyFields(reply) });
      }
      if (turn.done.length || turn.say) record({ kind: 'house', actors: [id], ref: { houseTurn: house.s.turns },
        text: turn.done.length ? `${nameOf(id)} 집 작업: ${summary || '이동'}` : `${nameOf(id)}가 집에서 한마디` });
      if (house.s.phase === 'build' && isComplete(house)) startLife();
    } catch (e) { store.log('house', redact(e.message)); }
    finally { houseJob = null; persist(); publish(); }
    })();
    return job.done;
  }
  // ---------- life in the finished house: rules only, no AI call (lib/life.mjs) ----------
  const houseNames = Object.fromEntries(IDS.map((id) => [id, nameOf(id)]));
  for (const text of [...store.warnings, ...activity.warnings, ...house.warnings]) {
    post({ from: 'system', kind: 'error', text });
  }
  function startLife() {
    if (!enterLife(house, clock())) return;
    house.save();
    post({ from: 'system', kind: 'notice', text: '🏠 AI들의 집이 기본적으로 완성됐어요. 이제 AI들이 이곳에서 생활합니다.' });
    record({ kind: 'house', actors: IDS.filter((id) => room.enabled[id]), text: '기본 집 완성 · 생활 시작' });
    broadcast('house', {});
  }
  // Which life mode the real app state asks for: working at the desk, talking next to a Talk partner, resting.
  const MIRROR = { reply: 'work', talk: 'talk', rest: 'rest', off: 'off', sleep: 'sleep' };
  const lifeSched = { beatAt: clock() + MIN, eventAt: clock() + 15 * MIN };
  const userAway = (now) => now - Math.max(sched.lastUserAt, lastUserTs()) > 3 * 3600000;
  function announceHouseEvent(event) {
    record({ kind: 'house', actors: event.actors, text: event.text, ref: { houseEvent: event.id } });
    post({ from: 'system', kind: 'house-event', text: event.text,
      houseEvent: { id: event.id, actors: event.actors, tone: event.tone } });
  }
  // While the house is being built, members who are not building right now stroll around it, so nobody stands still.
  const strollAt = {};
  function buildStroll(now) {
    let moved = false;
    for (const id of IDS) {
      if (!room.enabled[id] || now < (strollAt[id] ?? 0)) continue;
      strollAt[id] = now + between([8000, 20000]);
      if (houseJob?.actor === id) continue;
      if (house.wander(id, random)) moved = true;
    }
    if (!moved) return null;
    house.save(); broadcast('house', {});
    return null;
  }
  function lifeTick() {
    const now = clock();
    if (closed || !room.auto.on || autoSleeping()) return null;
    if (house.s.phase !== 'life') {
      if (!isComplete(house)) return buildStroll(now);
      startLife();
    }
    const done = [];
    for (const id of IDS) {
      const mode = MIRROR[appActivity(id).kind] || 'free';
      const agent = house.s.agents[id];
      if (agent.mirror === mode) continue;
      const partner = mode === 'talk' ? autoJob?.members?.find((x) => x !== id) : null;
      done.push(lifeBeat(house, id, { mode: mode === 'free' ? (agent.mirror === 'work' ? 'after-work' : 'free') : mode, partner, names: houseNames, rand: random, now }));
      agent.mirror = mode;
    }
    // Ordinary beats and events follow the activity level's cooldowns; a long absence of the user slows them.
    const slow = userAway(now) ? 2 : 1;
    const free = IDS.filter((id) => house.s.agents[id].mirror === 'free' && room.enabled[id]);
    if (now >= lifeSched.beatAt && free.length) {
      const pool = free.length > 1 ? free.filter((id) => id !== house.s.lastLife) : free;
      const id = pool[Math.floor(random() * pool.length)];
      done.push(lifeBeat(house, id, { names: houseNames, rand: random, now }));
      house.s.lastLife = id;
      lifeSched.beatAt = now + between(LIFE_PACE[room.auto.level]) * slow;
    }
    let event = null;
    if (now >= lifeSched.eventAt) {
      event = lifeEvent(house, { ids: IDS.filter((id) => room.enabled[id] && available[id]), names: houseNames, rand: random, now });
      const gap = EVENT_GAP[room.auto.level] * (house.s.open ? 0.5 : 1) * slow;
      lifeSched.eventAt = now + between([gap * 0.7, gap * 1.3]);
      if (event) {
        announceHouseEvent(event);
      }
    }
    if (drift(house, dayKey(now))) done.push(null);
    if (!done.length && !event) return null;
    house.save(); broadcast('house', {}); activityHook();
    return { beats: done.filter(Boolean), event };
  }
  // ---------- life sharing, mini games and helpful notes: templates and rules, no AI call ----------
  const LIFE_FILES = 80;  // older app-drawn scenes are removed beyond this many
  const startOfDay = (ms) => new Date(ms).setHours(0, 0, 0, 0);
  const jitter = (gap) => between([gap * 0.7, gap * 1.3]);
  function shareLife(now, present) {
    const choice = chooseShare({ house, entries: activity.list({ since: now - 2 * 3600000, limit: 60 }), ids: present, now, rand: random, last: room.life.last });
    if (!choice) return null;
    const last = room.life.last;
    const caption = captionFor(choice.theme, { a: nameOf(choice.actor), b: choice.friends[0] ? nameOf(choice.friends[0]) : '', recent: last.captions || [], rand: random });
    const rel = `life/${dayKey(now)}-${crypto.randomUUID().slice(0, 8)}.svg`;
    store.applyFileOp({ op: 'write', path: rel, content: renderShare({ ...choice, house, names: houseNames, caption }) }, choice.actor);
    Object.assign(store.meta[rel], { activity: 'life', title: caption });
    store.touchMeta(rel, choice.actor, true);
    const old = store.listFiles().filter((f) => f.path.startsWith('life/')).sort((a, b) => (store.meta[a.path]?.at || 0) - (store.meta[b.path]?.at || 0));
    for (const f of old.slice(0, Math.max(0, old.length - LIFE_FILES))) store.applyFileOp({ op: 'delete', path: f.path }, 'system');
    const msg = post({ from: choice.actor, text: caption, auto: 'life', attach: { path: rel, generated: true, label: '앱이 그린 장면 · AI 호출 없음' } });
    record({ kind: 'creation', actors: [choice.actor, ...choice.friends], text: `${nameOf(choice.actor)}가 일상 공유: ${caption}`, ref: { messageId: msg.id, path: rel } });
    room.life.last = { theme: choice.theme, actor: choice.actor, captions: [...(last.captions || []), caption].slice(-20), refs: [...(last.refs || []), ...(choice.ref ? [choice.ref] : [])].slice(-30) };
    return { ...choice, caption, messageId: msg.id };
  }
  function writeNote(now, present) {
    room.life.noteAt = now + 30 * 60000; // looked at again later either way
    if (now - room.life.lastNoteAt < NOTE_GAP) return null;
    const entries = activity.list({ since: Math.max(startOfDay(now), room.life.lastNoteAt), limit: 500 }).filter((e) => e.kind !== 'note');
    const note = buildNote(entries, { now });
    if (!note) return null;
    const counts = {};
    for (const e of entries) for (const a of e.actors) if (present.includes(a)) counts[a] = (counts[a] || 0) + 1;
    const author = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || present[0];
    const stamp = new Date(now);
    const rel = `notes/${dayKey(now)}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}.md`;
    store.applyFileOp({ op: 'write', path: rel, content: note.markdown }, author);
    Object.assign(store.meta[rel], { activity: 'note', title: note.title });
    store.touchMeta(rel, author, true);
    const msg = post({ from: author, text: `오늘 있었던 거 짧게 정리해봤어. 메모는 작업공간에 저장했고 프로젝트 파일은 안 건드렸어.${note.short ? `\n${note.short}` : ''}`, auto: 'note', note: { path: rel, title: note.title } });
    record({ kind: 'note', actors: [author], text: `${nameOf(author)}가 도움 메모 작성: ${note.title}`, ref: { messageId: msg.id, path: rel } });
    room.life.lastNoteAt = now;
    return { author, path: rel, messageId: msg.id };
  }
  // One look per tick: new shares and notes wait for their cooldowns,
  // stay quiet while the user is talking, and slow down when the user has been away for long.
  function funTick() {
    const now = clock();
    if (closed || !room.auto.on || autoSleeping()) return null;
    const out = {};
    if (active || autoJob || houseJob || now - Math.max(sched.lastUserAt, lastUserTs()) < LIMITS.userPauseMs) return out;
    const slow = userAway(now) ? 2 : 1;
    const present = IDS.filter((id) => room.enabled[id] && available[id] && !room.quotaRest[id]);
    if (present.length && now >= room.life.shareAt) {
      out.share = shareLife(now, present);
      room.life.shareAt = now + jitter(SHARE_GAP[room.auto.level]) * slow;
    }
    if (present.length && now >= room.life.noteAt) out.note = writeNote(now, present);
    if (Object.keys(out).length) { persist(); publish(); }
    return out;
  }
  // ---------- who answers a chat message: rules only, never an AI call (used by /api/send and /api/preview) ----------
  // Names/nicknames → those AIs; a room-wide phrase → everyone active; otherwise one AI by the smart choice
  // (the AI the user was just talking to, the last one who answered, the question, remaining usage, the default).
  const AFFINITY_MS = 15 * 60000;
  const whyOut = (id) => (room.quotaRest[id] ? '한도 휴식' : room.enabled[id] ? '연결 설정 필요' : '쉬는 중');
  function resolveCall(text, reply = null) {
    const call = parseCall(text, room.aliases);
    let named = call.named;
    if (!named.length && !call.all && !room.discussion && IDS.includes(reply?.from)) named = [reply.from];
    const peerIds = IDS.filter((id) => room.enabled[id] && available[id] && !room.quotaRest[id] && room.checks[id].login?.status !== 'fail');
    const out = (kind, wanted, extra = {}) => ({ kind, named, peerIds, wanted, participants: wanted.filter((id) => peerIds.includes(id)),
      excluded: wanted.filter((id) => !peerIds.includes(id)).map((id) => ({ id, reason: whyOut(id) })), ...extra });
    if (room.discussion) return out('discussion', named.length ? named : IDS, { needTwo: named.length === 1 });
    if (named.length) return out('named', named);
    if (call.all) return out('all', IDS, { excluded: [] });
    // The user's last message keeps a single AI only for a short while (a time and nothing-newer limit).
    const last = [...store.messages].reverse().find((m) => m.from === 'user');
    const partner = last?.callTo?.length === 1 && clock() - last.ts <= AFFINITY_MS ? last.callTo[0] : null;
    const reports = usageView();
    const pick = pickPrimary({ candidates: peerIds, text, selected: room.selected, partner,
      recent: store.messages.slice(-30).reverse().filter((m) => IDS.includes(m.from) && !m.auto && m.kind !== 'error').map((m) => m.from),
      quota: Object.fromEntries(peerIds.map((id) => [id, quotaOf(id, reports?.[id], clock())])) });
    return out('auto', pick ? [pick.id] : [], { pick });
  }
  // A short "reading" pause before an AI reacts; a stop or shutdown ends it at once.
  const readWait = (ms, signal) => new Promise((resolve) => {
    if (!ms || signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
  const houseView = () => ({ ...house.view(), player: playerView(house), talk: room.auto.on && !autoSleeping(), level: room.auto.level, nextAt: houseAt, busy: !!houseJob, names: houseNames, userName: room.userName });
  const houseTimer = setInterval(() => {
    try { lifeTick(); } catch (e) { store.log('house', redact(e.message)); }
    try { funTick(); } catch (e) { store.log('life', redact(e.message)); }
    try { houseTurn().catch((e) => store.log('house', redact(e.message))); }
    catch (e) { store.log('house', redact(e.message)); }
  }, autoTickMs);
  houseTimer.unref?.();
  // ---------- welcoming the user ----------
  const RETURN_MS = 60 * 60000; // a visit after this long without the user counts as coming back
  function lastUserTs() {
    for (let i = store.messages.length - 1; i >= 0; i--) if (store.messages[i].from === 'user') return store.messages[i].ts;
    return 0;
  }
  const canGreet = () => {
    const u = usageFor(room.auto, clock());
    return !closed && !active && !autoJob && !houseJob && !autoSleeping() && eligibleAuto().length > 0 && !u.stopped && u.calls < LEVELS[room.auto.level].daily;
  };
  async function greetReturnedMember() {
    if (active || autoJob) return false; // the next tick will handle the pending return
    for (const plan of memberReturns.values()) {
      if (plan.started) continue;
      const peers = plan.peers.filter((id) => eligibleAuto().includes(id) && !memberReturns.has(id));
      if (!room.enabled[plan.memberId] || !canGreet() || !peers.length) {
        memberReturns.delete(plan.memberId);
        continue;
      }
      plan.started = true;
      plan.speaker = shuffled(peers)[0];
      await autoBurst(clock(), usageFor(room.auto, clock()), plan);
      return true;
    }
    return false;
  }
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
    if (closed) return null;
    const now = clock();
    const usage = usageFor(room.auto, now);
    if (autoSleeping()) { await stopAuto(); publish(); return null; }
    if (await greetReturnedMember()) return 'greet';
    const since = sinceUser(now);
    const action = decide({ auto: room.auto, usage, now, busy: !!active || !!autoJob || !!houseJob, since, eligible: eligibleAuto().length, daily: LEVELS[room.auto.level].daily,
      lastUserAt: Math.max(sched.lastUserAt, since.lastUser), chatterAt: sched.chatterAt, callAt: sched.callAt });
    if (action === 'chatter' && !postChatter(now, usage)) return null;
    if (action === 'call') await autoBurst(now, usage);
    if (action) { persist(); publish(); }
    return action;
  }
  const stopAuto = async () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    houseJob?.controller.abort();
    if (autoJob) { autoJob.controller.abort(); await autoJob.done; }
  };
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
        res.once('close', () => clients.delete(res));
        res.once('error', () => { clients.delete(res); res.destroy(); });
        noteVisit();
        return;
      }
      if (req.method === 'GET' && p === '/api/state') return json(res, 200, view());
      if (req.method === 'GET' && p === '/api/preview') {
        const r = resolveCall(String(url.searchParams.get('text') || '').slice(0, 2000));
        return json(res, 200, { kind: r.kind, ids: r.kind === 'named' || r.kind === 'discussion' && r.named.length ? r.wanted : r.participants,
          excluded: r.excluded, needTwo: !!r.needTwo, reason: r.pick?.reason || null });
      }
      if (req.method === 'GET' && p === '/api/house') return json(res, 200, houseView());
      // The shared timeline, newest first: ?actor=gpt&kind=talk&since=<ms>&limit=50
      if (req.method === 'GET' && p === '/api/activity') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        return json(res, 200, { entries: activity.list({ actor: url.searchParams.get('actor') || undefined, kind: url.searchParams.get('kind') || undefined,
          since: Number(url.searchParams.get('since')) || 0, limit }) });
      }
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
          if (body.callMode !== undefined && !['auto', 'all', 'pick'].includes(body.callMode)) return json(res, 400, { error: '호출 방식을 확인하세요.' });
          // Older clients send only `targeted`: on means 'pick', off leaves the automatic choice.
          if (typeof body.targeted === 'boolean' && body.callMode === undefined) room.callMode = body.targeted ? 'pick' : room.callMode === 'pick' ? 'auto' : room.callMode;
          if (body.callMode) room.callMode = body.callMode;
          room.targeted = room.callMode === 'pick';
          for (const id of IDS) if (Array.isArray(body.aliases?.[id])) room.aliases[id] = cleanAliases(body.aliases[id]);
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
            if (typeof on !== 'boolean') continue;
            if (room.quotaRest[id]) {
              // Even an explicit OFF on an already-resting member cancels auto-return.
              room.quotaRest[id].autoResume = on;
              continue;
            }
            if (room.enabled[id] === on) continue;
            room.enabled[id] = on;
            if (!on) memberLeft(id);
            post({ from: 'system', kind: 'presence', presence: true, by: id, text: `${nameOf(id)} ${on ? '들어옴' : '잠깐 나감'}` });
            if (on) memberReturned(id);
          }
          const auto = body.auto;
          if (auto) {
            if (auto.level !== undefined && !LEVELS[auto.level]) return json(res, 400, { error: '대화 수준을 확인하세요.' });
            if (auto.level !== undefined && auto.level !== room.auto.level) { room.auto.level = auto.level; arm(); }
            if (auto.sleepMinutes !== undefined) room.auto.sleepMinutes = auto.sleepMinutes;
            if (typeof auto.on === 'boolean') {
              // Turning it on starts the first round soon, so the user sees it work.
              if (auto.on && !room.auto.on) { room.auto.lastWakeAt = clock(); sched.callAt = clock() + 10000; sched.chatterAt = clock() + 5 * 60000; houseAt = Math.min(houseAt, clock() + MIN); }
              room.auto.on = auto.on;
              if (!auto.on) await stopAuto();
            }
            if (autoSleeping()) await stopAuto();
          }
          persist(); publish();
          if (firstEntry) welcomeUser();
          else greetReturnedMember().catch((e) => store.log('auto', redact(e.message)));
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
          if (kind === 'quota') restForQuota(id);
          // A successful test of the auto model lets auto calls start again after an earlier stop.
          if (ok && autoSettings(id).model === settings.model) room.auto.usage.stopped = null;
          persist(); publish();
          return json(res, 200, view());
        }
        // The owner steps into house life only when they want to: answer an open matter, undo the latest
        // automatic change, or choose how often the house asks. Nothing here calls an AI.
        if (p === '/api/house/player') {
          playerAction(house, body, houseNames, clock());
          broadcast('house', {});
          return json(res, 200, houseView());
        }
        if (p === '/api/house/decide') {
          decideHouse(house, body.choice, body.note, body.eventId ?? null);
          const event = lifeEvent(house, { ids: IDS.filter((id) => room.enabled[id] && available[id]), names: houseNames, rand: random, now: clock() });
          if (event) announceHouseEvent(event);
          house.save(); broadcast('house', {});
          return json(res, 200, houseView());
        }
        if (p === '/api/house/undo') {
          const done = undoHouse(house, clock());
          record({ kind: 'house', actors: [], text: `방장이 집 변경을 되돌림: ${done.text}`.slice(0, 160) });
          house.save(); broadcast('house', {});
          return json(res, 200, houseView());
        }
        if (p === '/api/house/mode') {
          setHouseMode(house, body.mode);
          house.save(); broadcast('house', {});
          return json(res, 200, houseView());
        }
        if (p === '/api/react') {
          const target = store.byId.get(body.id);
          if (!target || target.from === 'system' || !EMOJIS.includes(body.emoji)) return json(res, 400, { error: '공감할 메시지와 반응을 확인하세요.' });
          store.applyReaction(target.id, 'user', body.emoji);
          publish();
          return json(res, 200, { ok: true });
        }
        if (p === '/api/send') {
          // The user comes first: stop any auto call, drop its answer, and pause auto chat.
          sched.lastUserAt = clock();
          await stopAuto();
          if (active) return json(res, 409, { error: '현재 답변을 기다리거나 중지한 뒤 보내세요.' });
          const text = String(body.text || '').trim();
          const reply = body.replyTo == null ? null : store.byId.get(body.replyTo);
          if (body.replyTo != null && (!reply || reply.from === 'system')) return json(res, 400, { error: '답장할 메시지가 없습니다.' });
          if ((!text && !body.image) || text.length > 20000) return json(res, 400, { error: '질문을 입력하세요. 최대 20,000자입니다.' });
          // Who answers: AIs named with @ (only them, even in discussion), else the discussion group,
          // else the selected AI when "특정 AI" is on, else every AI that is on and connected.
          // A nickname the user gives ("클로드를 클롱이라고 부를게") is remembered for later messages.
          const nick = parseNickname(text, room.aliases);
          if (nick) room.aliases[nick.id] = cleanAliases([...room.aliases[nick.id], nick.alias]);
          const call = resolveCall(text, reply);
          const { named, peerIds, participants, excluded } = call;
          const discussion = call.kind === 'discussion';
          // "오늘 AI들 뭐 했어?" / "나 없는 동안 뭐 했어?": answered from the activity log, with no AI call.
          if (!named.length && !body.image && !reply && TODAY_QUESTION.test(text)) {
            const away = /없는\s*동안|자리\s*비운|그동안/.test(text);
            // "while I was away" starts at the user's previous message; otherwise at midnight.
            const since = (away && lastUserTs()) || startOfDay(clock());
            room.auto.lastWakeAt = clock();
            const msg = post({ from: 'user', text });
            post({ from: 'system', kind: 'digest', replyTo: msg.id, text: todayDigest(activity.list({ since, limit: 200 }), { since, label: away && since !== startOfDay(clock()) ? '자리 비운 동안' : '오늘' }) });
            persist(); publish();
            return json(res, 200, { ok: true, msg });
          }
          // A discussion needs two or more AIs; nobody is added behind the user's back.
          if (call.needTwo) return json(res, 400, { error: '토론하려면 AI를 2명 이상 불러주세요.' });
          if (discussion && named.length && participants.length < 2) return json(res, 400, { error: '토론하려면 답할 수 있는 AI가 2명 이상 필요해요.' });
          const pick = call.pick;
          if (!participants.length) return json(res, 400, { error: '답할 수 있는 AI가 없습니다. 연결 설정을 확인하거나 쉬는 중인 AI를 켜 주세요.' });
          let attach;
          if (body.image) attach = { path: saveImage(store, body.image), upload: true };
          room.auto.lastWakeAt = clock();
          // Chiming in (casual chat only, one AI answered by the smart pick): who may add a line and how likely.
          // Rules and quota only; nothing is called here. Never for named/all calls, discussions, photos or work requests.
          let chime;
          const level = LEVELS[room.auto.level].chime;
          if (call.kind === 'auto' && pick && !attach && !heavyReason(text)) {
            const reports = usageView();
            const rank = (id) => { const q = quotaOf(id, reports?.[id], clock()); return q.known ? q.pct : 50; };
            const roomy = peerIds.filter((id) => !quotaOf(id, reports?.[id], clock()).low && rank(id) >= INTERJECT_MIN_PCT)
              .sort((a, b) => rank(b) - rank(a));
            // A wave lets everyone (even the first AI) react to the others; a single chime-in takes one other AI.
            const candidates = level.wave ? roomy : roomy.filter((id) => id !== pick.id);
            const aiMessages = store.messages.filter((m) => IDS.includes(m.from) && !m.auto && m.kind !== 'error');
            let chance = level.chance;
            if (aiMessages.length >= 3 && aiMessages.slice(-3).every((m) => m.from === pick.id)) chance += 0.15; // always the same voice
            if (!level.wave && aiMessages.at(-1)?.interjected) chance *= 0.5; // not twice in a row
            // Pacing for a wave: a minute's cap on AI lines and a short wait before the same AI speaks again.
            const allow = (id) => {
              const now = clock();
              const recent = store.messages.filter((m) => IDS.includes(m.from) && m.kind !== 'error' && now - m.ts < 60000);
              return recent.length < WAVE.perMinute && !recent.some((m) => m.from === id && now - m.ts < WAVE.cooldownMs);
            };
            if (candidates.length) chime = { ...level, candidates, chance: Math.min(chance, 0.9), rand: random, allow,
              wait: (signal) => readWait(pairDelayMs === 0 ? 0 : WAVE.readMs[0] + random() * (WAVE.readMs[1] - WAVE.readMs[0]), signal) };
          }
          const runId = crypto.randomUUID();
          // callTo: the one AI this message was for; the next message continues with it for a short while.
          const callTo = named.length === 1 ? named : pick?.reason === '대화를 이어서' ? [pick.id] : undefined;
          const msg = post({ from: 'user', text, attach, replyTo: reply?.id, callTo,
            replyPreview: reply ? { from: reply.from, text: reply.text.slice(0, 180) } : undefined, ...(pick ? { autoPick: pick } : {}) });
          begin({ ...structuredClone(room), discussion, models: structuredClone(discussion ? room.debateModels : room.models),
            synthesizer: participants.includes(room.synthesizer) ? room.synthesizer : participants[0],
            text: (reply ? `답장 대상 [${reply.id}] ${reply.from}: ${reply.text}\n\n` : '') + (text || '첨부한 사진을 살펴봐 주세요.'),
            messageId: msg.id, participants, peerIds, excluded,
            // Only the chosen members answer (discussions use their own flow).
            only: discussion ? undefined : participants, chime,
            images: attach ? [store.abs(attach.path)] : [] }, runId);
          return json(res, 200, { ok: true, msg });
        }
        return json(res, 404, { error: '지원하지 않는 기능입니다.' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: '지원하지 않는 요청입니다.' });
      if (p.startsWith('/ws/')) return await serve(res, store.abs(store.safeRel(p.slice(4))), true);
      const rel = p === '/' ? 'index.html' : p.slice(1);
      if (rel === 'vendor/three.module.js') return await serve(res, path.join(ROOT, 'node_modules/three/build/three.module.js'));
      // Only current UI assets are served. Old game and developer pages are disabled.
      if (!['index.html', 'assistant.js', 'format.mjs', 'status.mjs', 'assistant.css', 'style.css', 'house.js', 'house.css', 'house-shape.mjs', 'house-view.mjs', 'house-scene.mjs', 'house-avatar.mjs', 'house-pose.mjs', 'house-controls.mjs', 'recipients.mjs'].includes(rel)
        && !/^avatars\/(?:(claude|gpt|gemini)-pixel(-128)?\.png)$/.test(rel)) return json(res, 404, { error: '파일이 없습니다.' });
      return await serve(res, path.join(ROOT, 'public', rel));
    } catch (e) {
      if (!res.headersSent) json(res, e.code === 'ENOENT' ? 404 : 400, { error: e.message });
      else res.end();
    }
  });
  async function close() {
    closed = true;
    const job = active;
    const pendingHouse = houseJob?.done;
    clearInterval(autoTimer);
    clearInterval(usageTimer);
    clearInterval(houseTimer);
    for (const timer of timers) clearTimeout(timer);
    job?.controller.abort();
    for (const controller of checking.values()) controller.abort();
    await stopAuto();
    await pendingHouse;
    if (job) await job.done;
    for (const client of clients) client.end();
    clients.clear();
    if (usage) usage.onUpdate = () => {};
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  if (usage) {
    usage.onUpdate = () => {
      reconcileQuota(); publish();
      greetReturnedMember().catch((e) => store.log('auto', redact(e.message)));
    };
    pollUsage();
  }
  return { server, close, store, view, house, activity, room, tick: autoTick, lifeTick, funTick, get active() { return active; } };
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
