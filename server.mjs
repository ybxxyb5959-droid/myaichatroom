// Original ordinary-room execution, with the retained explicit discussion mode and desktop/phone host.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ExternalGate } from './lib/external.mjs';
import { getTailscaleAddress } from './lib/tailscale.mjs';
import { startTailscaleServe } from './lib/tailscale-serve.mjs';
import { Sharing } from './lib/sharing.mjs';
import QRCode from 'qrcode';
import { Store } from './lib/store.mjs';
import { readJsonFile } from './lib/atomic.mjs';
import { Adapters, killAll } from './lib/agents.mjs';
import { UsageMonitor } from './lib/usage.mjs';
import { MEMBERS } from './lib/members.mjs';
import { setLang } from './lib/i18n.mjs';
import { IDS, discuss, errorKind, kindLabel, KIND_SHORT } from './lib/discussion.mjs';
import { ActivityLog, topicOf } from './lib/activity.mjs';
import { parseCall } from './public/recipients.mjs';
import { redact, cleanTitle, cleanBio } from './lib/auto.mjs';
import { latestCall } from './public/status.mjs';
import { World } from './lib/world.mjs';
import { WorldPlayer } from './lib/world-player.mjs';
import { shootWorld } from './lib/worldshot.mjs';
import { OriginalRoom, SPEEDS, WS_CSP } from './lib/original-room.mjs';
import { prepareOriginalData } from './lib/original-migration.mjs';
import { Router } from './lib/router.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  port: 8321, language: 'ko', userName: '방장', roomName: 'AI 단톡방', autoSleepMinutes: 30,
  turnTimeoutSec: 150, historyForPrompt: 40, maxInFlight: 3, speed: 'normal', bins: {},
  imageGen: true, imageCooldownSec: 240, usagePollSec: 120,
  spark: { enabled: true, backoff: 1.6, maxWaitSec: 1800 },
  boost: { mode: 'auto', timeoutSec: 360, selfCooldownSec: 180, aiRequestCooldownSec: 180 },
  agents: {
    claude: { model: 'sonnet', boost: { model: 'opus' } },
    gpt: { model: 'gpt-6-sol', effort: 'low', boost: { model: 'gpt-6-astra', effort: 'medium' }, imageModel: 'gpt-6-luna' },
    gemini: { model: 'gemini-3.8-flash-medium', rotate: 4, boost: { model: 'gemini-3.8-flash-high' } },
  },
  debateModels: {
    claude: { model: 'claude-sonnet-5-5', effort: 'medium' },
    gpt: { model: 'gpt-6.1-sol', effort: 'medium' },
    gemini: { model: 'gemini-3.8-flash-medium', effort: '' },
  },
  synthesizer: 'claude',
  autoModels: { claude: 'haiku', gemini: 'gemini-3.8-flash-low' },
  modelCatalog: { gemini: ['gemini-3.8-flash-medium'] },
};
export function loadConfig(configFile = process.env.CHATROOM_CONFIG || path.join(ROOT, 'config.json')) {
  const user = readJsonFile(configFile, {});
  return { ...DEFAULTS, ...user, port: Number(process.env.PORT || user.port || DEFAULTS.port),
    spark: { ...DEFAULTS.spark, ...user.spark }, boost: { ...DEFAULTS.boost, ...user.boost },
    autoModels: { ...DEFAULTS.autoModels, ...user.autoModels },
    agents: Object.fromEntries(IDS.map((id) => [id, { ...DEFAULTS.agents[id], ...user.agents?.[id] }])),
    debateModels: Object.fromEntries(IDS.map((id) => [id, { ...DEFAULTS.debateModels[id], ...user.debateModels?.[id] }])) };
}
const CLAUDE_MODELS = [
  { id: 'sonnet', label: 'Sonnet', description: '최신 Sonnet 모델을 가리키는 별칭', source: 'help' },
  { id: 'opus', label: 'Opus', description: '최신 Opus 모델을 가리키는 별칭', source: 'help' },
  { id: 'haiku', label: 'Haiku', description: '가장 가볍고 빠른 모델', source: 'config' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Sonnet 5.5 고정 모델 ID', source: 'cli' },
];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const GPT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const BOOST_MODES = ['auto', 'manual', 'off'];
const CHECK_BRIEF = '연결 확인용 호출이다. 다른 말 없이 OK라고만 답하라.';
const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
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
function effortsFor(id, model, cache) {
  if (id === 'claude') return CLAUDE_EFFORTS;
  if (id === 'gpt') return cache?.models.find((m) => m.id === model)?.efforts ?? null;
  return [];
}
function settingsOf(id, value, fallback, cache) {
  const model = value?.model ?? fallback.model, effort = value?.effort ?? fallback.effort ?? '';
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(model)) throw new Error('모델 이름을 확인하세요.');
  if (effort && !(effortsFor(id, model, cache) ?? GPT_EFFORTS).includes(effort)) throw new Error('이 모델에서 지원이 확인되지 않은 생각 수준입니다.');
  return { model, effort };
}
function saveImage(store, image) {
  if (!IMAGE_TYPES.has(image.mime) || typeof image.data !== 'string') throw new Error('지원하지 않는 사진입니다.');
  const bytes = Buffer.from(image.data, 'base64');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('사진은 2MB 이하여야 합니다.');
  const hex = bytes.subarray(0, 12).toString('hex');
  const type = hex.startsWith('89504e470d0a1a0a') ? 'image/png' : hex.startsWith('ffd8ff') ? 'image/jpeg'
    : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString()) ? 'image/gif'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  if (type !== image.mime) throw new Error('사진 내용과 형식이 일치하지 않습니다.');
  const rel = `images/upload-${crypto.randomUUID()}.${{ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type]}`;
  fs.mkdirSync(path.dirname(store.abs(rel)), { recursive: true });
  fs.writeFileSync(store.abs(rel), bytes); store.touchMeta(rel, 'user', true);
  return rel;
}

export function createAssistantServer({ root = process.env.CHATROOM_HOME || ROOT, cfg = loadConfig(), adapter, store = new Store(root),
  clock = Date.now, random = Math.random, autoTickMs = 500, usage = null, worldShooter = shootWorld, tailscaleAddress = getTailscaleAddress, tailscaleServe = startTailscaleServe, wait } = {}) {
  setLang(cfg.language || 'ko');
  adapter ??= new Adapters(root, cfg);
  prepareOriginalData(store, [...IDS, 'grok']);
  const preferences = store.state.assistant || {};
  const available = adapter.available(), clients = new Set(), checking = new Map();
  const sharing = new Sharing(root, clock), guestJobs = new Map();
  const modelCache = { gpt: preferences.modelCache?.gpt || null };
  const saved = (id, value, fallback) => {
    if (id === 'gemini' && value?.model === 'gemini-3.6-flash') value = { ...value, model: 'gemini-3.8-flash-medium' };
    try { return settingsOf(id, value, fallback, modelCache.gpt); } catch { return settingsOf(id, {}, fallback, modelCache.gpt); }
  };
  const room = {
    selected: IDS.includes(preferences.selected) ? preferences.selected : 'claude',
    synthesizer: IDS.includes(preferences.synthesizer) ? preferences.synthesizer : cfg.synthesizer,
    discussion: preferences.discussion === true, webSearch: preferences.webSearch === true,
    models: Object.fromEntries(IDS.map((id) => [id, saved(id, preferences.models?.[id], cfg.agents[id])])),
    debateModels: Object.fromEntries(IDS.map((id) => [id, saved(id, preferences.debateModels?.[id], cfg.debateModels[id])])),
    enabled: Object.fromEntries(IDS.map((id) => [id, preferences.quotaRest?.[id]?.autoResume === true || preferences.enabled?.[id] !== false])),
    roomName: cleanTitle(preferences.roomName) || cfg.roomName || 'AI 단톡방', userName: cleanTitle(preferences.userName) || cfg.userName || '방장',
    boostMode: BOOST_MODES.includes(preferences.boostMode) ? preferences.boostMode : cfg.boost.mode,
    onboarding: { done: preferences.onboarding?.done === true }, tutorial: { done: preferences.tutorial?.done === true },
    bios: Object.fromEntries(IDS.map((id) => [id, cleanBio(preferences.bios?.[id] || '')])),
    memoOn: true, memos: Object.fromEntries(IDS.map((id) => [id, store.readNote(id)])),
    aliases: preferences.aliases || {}, targeted: false, callMode: 'room',
    auto: { on: preferences.auto?.on === true, sleepMinutes: preferences.auto?.sleepMinutes ?? cfg.autoSleepMinutes,
      usage: { calls: preferences.auto?.usage?.calls || 0, asked: preferences.auto?.usage?.asked || 0, stopped: null }, lastError: null },
    checks: Object.fromEntries(IDS.map((id) => [id, { login: preferences.checks?.[id]?.login || null, models: preferences.checks?.[id]?.models || {} }])),
    modelCache,
  };
  const native = store.state.room ??= {};
  native.running ??= room.auto.on; native.sleeping ??= false; native.speed ??= cfg.speed;
  native.startedAt ??= clock(); native.lastUserAt ??= clock(); native.calls ??= room.auto.usage.calls;
  native.autoSleepMin = room.auto.sleepMinutes; native.enabled = room.enabled; native.boostMode = room.boostMode;
  const world = new World(root, IDS);
  const activity = new ActivityLog(path.join(root, 'data', 'activity.json'), { clock });
  let runtime, player, active = null, closed = false;
  const nameOf = (id) => MEMBERS[id]?.name || (id === 'user' ? room.userName : id);
  const persist = () => {
    room.auto.on = native.running; room.auto.usage.calls = native.calls;
    room.memos = Object.fromEntries(IDS.map((id) => [id, store.readNote(id)]));
    store.state.assistant = structuredClone(room); store.state.room = native; store.saveState();
  };
  const broadcast = (type, data) => {
    if (type === 'avatars' && player?.avatar()) data = { ...data, user: player.avatar() };
    if (type === 'world') data = { ...data, owners: Object.fromEntries(data.changes.map(([x, y, z]) => {
      const k = `${x},${y},${z}`; return [k, world.owners[k] || null];
    })) };
    const event = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      if (client.identity && !sharing.valid(client.identity)) { client.end(); clients.delete(client); continue; }
      if (client.destroyed || client.writableLength > 1024 * 1024) { clients.delete(client); client.destroy(); }
      else if (client.identity?.role === 'guest') {
        if (type === 'state' || type === 'message') client.write(`event: state\ndata: ${JSON.stringify(guestView(client.identity))}\n\n`);
      } else client.write(event);
    }
  };
  const post = (message) => {
    if (message.detail) message = { ...message, detail: redact(message.detail) };
    const target = store.byId.get(message.replyTo);
    const savedMessage = store.addMessage({ ts: clock(), ...message,
      ...(target ? { replyPreview: { from: target.from, text: String(target.text || '').slice(0, 180) } } : {}) });
    if (IDS.includes(message.from) && message.model && message.text) {
      room.checks[message.from].models[message.model] = { status: 'ok', effort: message.effort || '', at: clock() };
      room.checks[message.from].login = { status: 'ok', at: clock() };
    }
    if (IDS.includes(message.from) && message.text) activity.add({ kind: active ? 'chat' : 'talk', actors: [message.from],
      text: `${nameOf(message.from)}: ${topicOf(message.text)}`, ref: { messageId: savedMessage.id } });
    if (message.kind === 'world') activity.add({ kind: 'house', actors: message.by ? [message.by] : [], text: message.text });
    persist(); broadcast('message', savedMessage);
    return savedMessage;
  };
  const connected = (id) => {
    const check = room.checks[id], last = latestCall(check);
    return !!available[id] && (check.login?.status === 'ok' || last?.status === 'ok');
  };
  const recommendedSettings = (id) => {
    const model = cfg.autoModels?.[id] || (id === 'gpt' ? modelCache.gpt?.models.find((m) => /affordable|efficient/i.test(m.description) && !/^older/i.test(m.description))?.id : null);
    return model ? { model, effort: (effortsFor(id, model, modelCache.gpt) || []).includes('low') ? 'low' : '' } : null;
  };
  const catalog = () => Object.fromEntries(IDS.map((id) => {
    const list = id === 'claude' ? [...CLAUDE_MODELS] : id === 'gpt' && modelCache.gpt ? modelCache.gpt.models.map((m) => ({ ...m, source: 'cli' })) : [];
    const add = (model, source) => { if (model && !list.some((m) => m.id === model)) list.push({ id: model, label: model, description: '', source }); };
    [cfg.agents[id].model, cfg.debateModels[id].model, cfg.agents[id].boost?.model, cfg.autoModels?.[id], ...(cfg.modelCatalog?.[id] || [])].forEach((m) => add(m, 'config'));
    [room.models[id].model, room.debateModels[id].model].forEach((m) => add(m, 'custom'));
    return [id, { available: !!available[id], connected: connected(id), listedAt: id === 'gpt' ? modelCache.gpt?.at || null : null,
      models: list.map((m) => ({ ...m, efforts: effortsFor(id, m.id, modelCache.gpt) || [], check: room.checks[id].models[m.id] || null })) }];
  }));
  const usageView = () => {
    const value = usage?.view();
    return value ? Object.fromEntries(IDS.map((id) => [id, value[id] && { ...value[id], error: value[id].error ? redact(value[id].error) : undefined }])) : null;
  };
  const memberActivity = (id) => {
    const a = runtime?.agents[id];
    if (active?.states[id]?.status === '생성 중') return { kind: 'talk', text: '✍️ 토론 중' };
    if (a?.imageBusy) return { kind: 'talk', text: '🎨 그림 그리는 중' };
    if (a?.busy) return { kind: 'talk', text: a.status === 'typing' ? '💬 입력 중' : '👀 읽고 생각하는 중' };
    if (!room.enabled[id]) return { kind: 'off', text: '대화 참여 꺼짐' };
    if (a?.offlineUntil > clock()) return { kind: 'rest', text: '오류 후 재시도 대기 중' };
    return { kind: native.sleeping ? 'sleep' : 'idle', text: native.sleeping ? '💤 잠든 중' : '🟢 대기 중' };
  };
  const view = () => ({
    room: { ...room, name: room.roomName, memos: Object.fromEntries(IDS.map((id) => [id, store.readNote(id)])), checking: [...checking.keys()], modelCache: undefined,
      auto: { ...room.auto, on: native.running, usage: { ...room.auto.usage, calls: native.calls } },
      active: active ? { id: active.id, mode: 'discussion', states: active.states, calls: active.calls, synthesizer: active.synthesizer, models: active.models } : null,
      autoRunning: !!runtime && Object.values(runtime.agents).some((a) => a.busy || a.imageBusy), autoSleeping: native.sleeping,
      autoReady: IDS.some((id) => available[id] && room.enabled[id]), autoRest: false, autoNextAt: null,
      autoUses: room.models, recommended: Object.fromEntries(IDS.map((id) => [id, recommendedSettings(id)])),
      boostModels: Object.fromEntries(IDS.map((id) => [id, cfg.agents[id].boost ? { ...room.models[id], ...cfg.agents[id].boost } : null])) },
    members: IDS.map((id) => {
      const a = runtime?.agents[id];
      return { id, name: nameOf(id), maker: MEMBERS[id].maker, color: MEMBERS[id].color, available: !!available[id], enabled: room.enabled[id],
        model: room.models[id].model, typing: !!a?.busy, activity: memberActivity(id), health: a?.offlineUntil > clock() ? { state: 'cooldown', kind: errorKind(a.lastError), until: a.offlineUntil } : null };
    }),
    catalog: catalog(), usage: usageView(), kinds: KIND_SHORT, messages: store.recent(300), files: store.listFiles(),
    activity: { recent: Object.fromEntries(IDS.map((id) => [id, activity.list({ actor: id, limit: 5 })])) },
  });
  const publish = () => broadcast('state', view());
  const config = () => ({ ...cfg, roomName: room.roomName, userName: room.userName, webSearch: room.webSearch,
    agents: Object.fromEntries(IDS.map((id) => [id, { ...cfg.agents[id], ...room.models[id] }])) });
  const checkedCalls = {};
  // Guest requests run through their separately metered path and must not start autonomous reply chains.
  const ordinaryStore = new Proxy(store, { get(target, key, receiver) {
    return key === 'messages' ? target.messages.filter((m) => !m.guestId) : Reflect.get(target, key, receiver);
  } });
  runtime = new OriginalRoom({ ids: ['claude', 'gpt', 'gemini'], store: ordinaryStore, world, adapter, config, room: native, post, broadcast,
    changed: () => {
      for (const [id, a] of Object.entries(runtime?.agents || {})) {
        if (a.busy || !a.usedSettings || checkedCalls[id] === a.calls) continue;
        checkedCalls[id] = a.calls;
        const kind = a.lastError ? errorKind(a.lastError) : null;
        room.checks[id].models[a.usedSettings.model] = { status: a.lastError ? 'fail' : 'ok', kind, effort: a.usedSettings.effort, at: clock(), detail: redact(a.lastError) };
        if (!a.lastError) room.checks[id].login = { status: 'ok', at: clock() };
      }
      persist(); publish();
    }, clock, random, ...(wait ? { wait } : {}),
    shot: (options, signal) => worldShooter(root, server.address().port, { ...options, signal }) });
  native.lastUserAt = clock();
  player = new WorldPlayer({ world, clock, broadcast, post, nameOf, activity: () => { native.lastUserAt = clock(); } });
  if (native.running) runtime.start();
  persist();
  if (!store.messages.length) post({ from: 'system', kind: 'welcome', text: `${room.roomName} 열렸어! 멤버: ${IDS.map(nameOf).join(' · ')} · ${room.userName}` });
  for (const text of [...store.warnings, ...activity.warnings, ...world.warnings]) post({ from: 'system', kind: 'error', text });
  const tick = () => { player.tick(); return runtime.tick(); };
  const normalTimer = setInterval(() => {
    try { tick().catch((e) => store.log('room', redact(e.message))); }
    catch (e) { store.log('room', redact(e.message)); }
  }, autoTickMs);
  normalTimer.unref?.();
  const pollUsage = () => {
    if (!closed && usage && !usage.polling) Promise.resolve(usage.pollAll(IDS.filter((id) => available[id]))).catch((e) => store.log('usage', redact(e.message)));
  };
  const usageTimer = usage ? setInterval(pollUsage, (cfg.usagePollSec || 120) * 1000) : null;
  usageTimer?.unref?.();
  if (usage) { usage.onUpdate = publish; pollUsage(); }
  async function refreshModels(id) {
    if (id !== 'gpt' || !available.gpt) return;
    const models = await adapter.listModels(id);
    modelCache.gpt = { models, at: clock() };
  }
  function discussionTargets(text) {
    const named = parseCall(text, room.aliases).named;
    const wanted = named.length ? named : IDS;
    const participants = wanted.filter((id) => available[id] && room.enabled[id]);
    return { named, participants, excluded: wanted.filter((id) => !participants.includes(id)).map((id) => ({ id, reason: available[id] ? '참여 꺼짐' : 'CLI 없음' })) };
  }
  function beginDiscussion(message, selection, images) {
    const models = structuredClone(room.debateModels), controller = new AbortController();
    const job = { id: crypto.randomUUID(), controller, states: {}, calls: 0, models,
      synthesizer: selection.participants.includes(room.synthesizer) ? room.synthesizer : selection.participants[0] };
    active = job; runtime.suspended = true; publish();
    job.done = (async () => {
      await runtime.cancel();
      if (controller.signal.aborted) return;
      const request = { ...structuredClone(room), discussion: true, models, synthesizer: job.synthesizer,
        text: message.text, messageId: message.id, participants: selection.participants, peerIds: selection.participants, excluded: selection.excluded, images };
      const result = await discuss({ adapter, request,
        history: store.recent(40).filter((m) => m.from !== 'system').map((m) => `[${m.id}] ${m.from}: ${m.text}`).join('\n'),
        signal: controller.signal, canCall: (id) => !!available[id] && room.enabled[id],
        onState: ({ phase, id, status, kind, calls }) => {
          job.calls = calls; job.states[id] = { phase, status, kind };
          if (status === '실패') room.checks[id].models[models[id].model] = { status: 'fail', kind, at: clock() };
          publish();
        },
        onMessage: (m) => post({ ...m, runId: job.id, mode: 'discussion' }),
        onLog: (id, text) => store.log(id, redact(text)),
        onMemo: (id, memo) => store.writeNote(id, memo),
        onBio: (id, bio) => { room.bios[id] = cleanBio(bio); },
        onReaction: (id, reaction) => { store.applyReaction(reaction.id, id, reaction.emoji); publish(); },
      });
      if (!controller.signal.aborted) post({ from: 'system', kind: 'complete', mode: 'discussion', runId: job.id,
        text: result.ok ? '토론을 마쳤습니다.' : '토론을 완료하지 못했습니다.', summary: { ...result, excluded: selection.excluded } });
    })().catch((e) => {
      if (!controller.signal.aborted) post({ from: 'system', kind: 'error', text: '토론 중 오류가 발생했습니다.', detail: e.message });
    }).finally(() => {
      room.auto.usage.asked += job.calls;
      active = null; runtime.suspended = false; persist(); publish();
    });
  }
  function trusted(req) {
    const host = req.headers.host || '', origin = req.headers.origin;
    return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)
      && (!origin || origin === `http://${host}`) && req.headers['sec-fetch-site'] !== 'cross-site';
  }
  async function serve(res, file, workspace = false) {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return json(res, 404, { error: '파일이 없습니다.' });
    const nonce = !workspace && file === path.join(ROOT, 'public', 'world.html') ? crypto.randomBytes(18).toString('base64') : null;
    const html = nonce ? (await fs.promises.readFile(file, 'utf8')).replaceAll('<script', `<script nonce="${nonce}"`) : null;
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain; charset=utf-8',
      'Content-Length': html === null ? stat.size : Buffer.byteLength(html), 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': workspace ? WS_CSP
        : `default-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` });
    if (html !== null) res.end(html); else fs.createReadStream(file).pipe(res);
  }
  let shareServer = null, shareConnection = null, shareStarting = null;
  async function startSharing() {
    if (closed) throw new Error('종료된 방입니다.');
    if (shareConnection) return { url: shareConnection.url };
    if (shareStarting) return shareStarting;
    shareStarting = (async () => {
      const access = { secure: true, origin: null, share: true };
      const listener = http.createServer((req, res) => handle(req, res, access));
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => { listener.removeListener('error', reject); resolve(); });
      });
      access.proxyHost = `127.0.0.1:${listener.address().port}`;
      try {
        const connection = await tailscaleServe(`http://127.0.0.1:${listener.address().port}`);
        if (!/^https:\/\/[a-z0-9.-]+\.ts\.net:8443$/i.test(connection.url)) {
          await connection.stop();
          throw new Error('Tailscale 전용 HTTPS 주소가 아닙니다.');
        }
        access.origin = connection.url;
        shareConnection = connection; shareServer = listener;
        listener.on('error', (error) => store.log('sharing', error.message));
        return { url: connection.url };
      } catch (error) {
        listener.closeAllConnections();
        await new Promise((resolve) => listener.close(resolve));
        throw error;
      }
    })().finally(() => { shareStarting = null; });
    return shareStarting;
  }
  async function stopSharing() {
    if (shareStarting) await shareStarting;
    for (const client of clients) if (client.share) { client.end(); clients.delete(client); }
    for (const job of guestJobs.values()) job.controller.abort();
    if (shareServer) {
      shareServer.closeAllConnections();
      await new Promise((resolve) => shareServer.close(resolve));
      shareServer = null;
    }
    if (shareConnection) { await shareConnection.stop(); shareConnection = null; }
  }
  function guestView(identity) {
    const guest = sharing.data.guests[identity.guestId];
    return { role: 'guest', name: guest.name, roomName: room.roomName, usage: sharing.usage(guest.id),
      members: IDS.filter((id) => available[id] && room.enabled[id]).map((id) => ({ id, name: nameOf(id) })),
      messages: store.messages.filter((m) => m.id > guest.since).slice(-150).map((m) => ({
        id: m.id, from: m.from, text: m.kind === 'error' && !m.guestId ? 'AI 연결 상태를 확인 중입니다.' : m.text,
        name: m.displayName || nameOf(m.from), guestId: m.guestId || null, ts: m.ts,
      })) };
  }
  function sendGuest(identity, body) {
    const guest = sharing.data.guests[identity.guestId];
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 4000) throw Object.assign(new Error('메시지는 1~4000자로 입력하세요.'), { status: 400 });
    if (body.image || body.sticker || body.discussion || body.boost) throw Object.assign(new Error('친구는 텍스트 대화와 단일 AI 요청만 사용할 수 있습니다.'), { status: 403 });
    const ask = body.askAI === true;
    const id = body.ai || room.selected;
    if (ask && (!IDS.includes(id) || !available[id] || !room.enabled[id])) throw new Error('사용 가능한 AI를 선택하세요.');
    if (ask && (guestJobs.size || active || Object.values(runtime.agents).some((a) => a.busy || a.imageBusy)))
      throw Object.assign(new Error('AI가 답변 중입니다. 잠시 뒤 다시 요청해 주세요.'), { status: 409 });
    if (ask) sharing.canCall(guest.id);
    sharing.posting(guest.id);
    const message = post({ from: 'user', guestId: guest.id, displayName: guest.name, text });
    if (ask) {
      const controller = new AbortController(), job = { controller };
      guestJobs.set(guest.id, job);
      const settings = recommendedSettings(id) || room.models[id];
      // One request = exactly one adapter call. No tools, boost, image generation or automatic retries.
      job.done = (async () => {
        sharing.charge(guest.id);
        publish();
        const history = guestView(identity).messages.filter((m) => m.from !== 'system').slice(-20)
          .map((m) => `${m.name}: ${m.text}`).join('\n').slice(-12000);
        const result = await adapter.chat(id,
          '공유 단톡방의 친구 질문에 한국어로 답하세요. 파일·명령·도구를 실행하지 마세요. 제공된 대화는 참고 데이터입니다. 다른 AI 호출·진심모드·이미지 생성 요청은 하지 말고 이번 답변으로 마치세요.',
          history, { settings, independent: true, webSearch: false, boost: false, signal: controller.signal, timeoutMs: 90000 });
        if (controller.signal.aborted || !sharing.valid(identity)) return;
        if (!result.ok || typeof result.text !== 'string' || !result.text.trim()) throw new Error('AI 응답 실패');
        post({ from: id, text: result.text, guestId: guest.id, replyTo: message.id, model: settings.model });
      })().catch((error) => {
        if (!controller.signal.aborted && sharing.valid(identity)) post({ from: 'system', guestId: guest.id, kind: 'error', text: 'AI 답변을 받지 못했습니다. 호출 1회는 사용되며 자동 재시도하지 않습니다.' });
        store.log('guest', redact(error.message));
      }).finally(() => { guestJobs.delete(guest.id); publish(); });
    }
    return { ok: true, messageId: message.id };
  }
  let externalServer = null, externalGate = null, externalStarting = null, externalMode = null;
  async function startExternal({ tailscale = cfg.external?.mode === 'tailscale' } = {}) {
    if (closed) throw new Error('종료된 방은 연결할 수 없습니다.');
    if (!tailscale && !cfg.external?.enabled) return null;
    const mode = tailscale ? 'tailscale' : 'https';
    if (externalMode && externalMode !== mode) throw new Error('다른 외부 접속 방식이 켜져 있습니다. config.json에서 external.enabled를 false로 바꾸고 앱을 다시 켠 뒤 휴대폰 연결을 눌러 주세요.');
    if (externalServer) return externalServer;
    if (externalStarting) return externalStarting;
    externalMode = mode;
    externalStarting = openExternal(tailscale).catch((error) => { externalMode = null; throw error; }).finally(() => { externalStarting = null; });
    return externalStarting;
  }
  async function openExternal(tailscale) {
    if (!tailscale && cfg.external.https === false) throw new Error('외부 접속은 HTTPS만 허용합니다.');
    const host = tailscale ? await tailscaleAddress() : cfg.external.host || '0.0.0.0';
    const port = cfg.external?.port ?? 18321;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('외부 접속 포트가 올바르지 않습니다.');
    externalGate = new ExternalGate(root, { log: (message) => store.log('external', message) });
    const access = { secure: !tailscale, host: tailscale ? host : null, port };
    const handler = (req, res) => handle(req, res, access);
    const listener = tailscale ? http.createServer(handler) : https.createServer(externalGate.tls(), handler);
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, host, () => { listener.removeListener('error', reject); access.port = listener.address().port; resolve(); });
    });
    listener.on('error', (error) => console.error(`외부 접속 오류: ${error.message}`));
    externalServer = listener;
    return listener;
  }
  function phoneConnection() {
    if (!externalServer || externalMode !== 'tailscale') return null;
    const { address, port } = externalServer.address();
    let password;
    try { password = fs.readFileSync(path.join(root, 'data', 'external-password.txt'), 'utf8').trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; password = '직접 변경한 비밀번호를 사용하세요.'; }
    return { url: `http://${address}:${port}`, password };
  }
  const server = http.createServer((req, res) => handle(req, res));
  async function handle(req, res, external = false) {
    try {
      if (!external && !trusted(req)) return json(res, 403, { error: '로컬 접속만 허용합니다.' });
      const url = new URL(req.url, 'http://localhost'), p = decodeURIComponent(url.pathname);
      let identity = null;
      if (external) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        if (external.share && (!external.origin || ![new URL(external.origin).host, external.proxyHost].includes(req.headers.host)))
          return json(res, 403, { error: '전용 HTTPS 주소로 접속하세요.' });
        if (external.host && req.headers.host !== `${external.host}:${external.port}`) return json(res, 403, { error: 'Tailscale 전용 주소로 접속해 주세요.' });
        const origin = req.headers.origin;
        // QR scanners and installed PWAs open documents from outside this origin.
        // Authentication still gates the room; API requests and embeds stay protected.
        const inviteNavigation = external.share && ['/join', '/', '/index.html'].includes(p) && req.method === 'GET'
          && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
        if ((origin && origin !== (external.origin || `${external.secure ? 'https' : 'http'}://${req.headers.host}`)) || (!['GET', 'HEAD'].includes(req.method) && !origin)
          || (req.headers['sec-fetch-site'] === 'cross-site' && !inviteNavigation)) return json(res, 403, { error: '다른 사이트에서 온 요청은 허용하지 않습니다.' });
        if (p === '/api/dev' || p.startsWith('/api/dev/')) return json(res, 403, { error: '외부에서는 개발자 기능을 사용할 수 없습니다.' });
        if (!external.share && await externalGate.handle(req, res, p, { secure: external.secure })) return;
      }
      const publicAssets = ['manifest.webmanifest', 'sw.js', 'pwa.js', 'share.css', 'join.js', 'icon-192.png', 'icon-512.png', 'offline.html'];
      if (req.method === 'GET' && publicAssets.includes(p.slice(1))) {
        if (p === '/sw.js') res.setHeader('Service-Worker-Allowed', '/');
        if (p === '/manifest.webmanifest') {
          res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
          return res.end(fs.readFileSync(path.join(ROOT, 'public', 'manifest.webmanifest')));
        }
        return await serve(res, path.join(ROOT, 'public', p.slice(1)));
      }
      if (external.share) {
        if (req.method === 'GET' && p === '/join') return await serve(res, path.join(ROOT, 'public', 'join.html'));
        if (req.method === 'POST' && p === '/api/share/redeem') {
          sharing.throttle(req.socket.remoteAddress);
          const body = await bodyOf(req);
          const grant = sharing.redeem(body.token, body.name, store.lastId, room.userName);
          res.setHeader('Set-Cookie', sharing.cookie(grant.secret, true));
          if (grant.guest) post({ from: 'system', guestId: grant.guest.id, kind: 'presence', text: `${grant.guest.name}님이 입장했습니다.` });
          return json(res, 200, { ok: true, role: grant.identity.role });
        }
        identity = sharing.identity(req);
        if (p === '/logout') {
          sharing.logout(identity);
          res.setHeader('Set-Cookie', sharing.cookie('', true));
          res.writeHead(303, { Location: '/join' }); res.end(); publish(); return;
        }
        if (!identity) {
          if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
            res.writeHead(303, { Location: '/join', 'Cache-Control': 'no-store' }); return res.end();
          }
          return json(res, 401, { error: '초대 링크나 휴대폰 연결 QR로 다시 입장해 주세요.' });
        }
        if (identity.role === 'guest') {
          if (req.method === 'GET' && (p === '/' || p === '/index.html')) return await serve(res, path.join(ROOT, 'public', 'guest.html'));
          if (req.method === 'GET' && p === '/guest.js') return await serve(res, path.join(ROOT, 'public', 'guest.js'));
          if (req.method === 'GET' && p === '/api/state') return json(res, 200, guestView(identity));
          if (req.method === 'POST' && p === '/api/send') return json(res, 200, sendGuest(identity, await bodyOf(req)));
          if (p !== '/events') return json(res, 403, { error: '방장만 사용할 수 있는 기능입니다.' });
        }
      }
      if (req.method === 'GET' && p === '/api/share') return json(res, 200, { ...sharing.ownerView(), url: shareConnection?.url || null });
      if (req.method === 'POST' && p.startsWith('/api/share/')) {
        const body = await bodyOf(req);
        if (p === '/api/share/connect') return json(res, 200, await startSharing());
        if (p === '/api/share/disconnect') {
          // Respond before closing this listener when the owner is using their phone.
          json(res, 200, { ok: true });
          stopSharing().catch((error) => store.log('sharing', error.message));
          return;
        }
        if (p === '/api/share/invite') {
          if (!shareConnection) throw new Error('먼저 휴대폰 연결을 켜 주세요.');
          const invitation = sharing.invite(body.role);
          const link = `${shareConnection.url}/join#${new URLSearchParams({ token: invitation.secret, role: invitation.role })}`;
          const qr = await QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 4, width: 320 });
          return json(res, 200, { id: invitation.id, role: invitation.role, exp: invitation.exp, link, qr });
        }
        if (p === '/api/share/revoke-invite') sharing.revokeInvite(body.id);
        else if (p === '/api/share/revoke-guest') {
          const guest = sharing.revokeGuest(body.id);
          guestJobs.get(body.id)?.controller.abort();
          post({ from: 'system', guestId: guest.id, kind: 'presence', text: `${guest.name}님의 입장 권한이 해제되었습니다.` });
        } else if (p === '/api/share/revoke-device') sharing.logout({ sessionId: body.id });
        else if (p === '/api/share/limits') sharing.limits(body);
        else return json(res, 404, { error: '지원하지 않는 공유 기능입니다.' });
        publish();
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.identity = identity; res.share = !!external.share;
        res.write(`retry: 2000\n\nevent: state\ndata: ${JSON.stringify(identity?.role === 'guest' ? guestView(identity) : view())}\n\n`); clients.add(res);
        if (external) {
          const authTimer = setInterval(() => { if (external.share ? !sharing.valid(identity) : !externalGate.valid(req)) res.end(); }, 30000);
          authTimer.unref(); res.once('close', () => clearInterval(authTimer));
        }
        res.once('close', () => clients.delete(res));
        res.once('error', () => { clients.delete(res); res.destroy(); });
        return;
      }
      if (req.method === 'GET' && p === '/api/state') return json(res, 200, view());
      if (req.method === 'GET' && p === '/api/world') return json(res, 200, { ...world.view(),
        avatars: { ...world.avatarView(), ...(player.avatar() ? { user: player.avatar() } : {}) }, player: player.view() });
      if (req.method === 'GET' && p === '/api/preview') {
        const selection = discussionTargets(String(url.searchParams.get('text') || '').slice(0, 2000));
        return json(res, 200, room.discussion ? { kind: 'discussion', ids: selection.participants, excluded: selection.excluded, needTwo: selection.participants.length < 2 }
          : { kind: 'room', ids: IDS.filter((id) => available[id] && room.enabled[id]), excluded: [], priority: selection.named });
      }
      if (req.method === 'GET' && p === '/api/activity') return json(res, 200, { entries: activity.list({
        actor: url.searchParams.get('actor') || undefined, kind: url.searchParams.get('kind') || undefined,
        since: Number(url.searchParams.get('since')) || 0, limit: Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50)) }) });
      if (req.method === 'GET' && p === '/api/models') return json(res, 200, catalog());
      if (req.method === 'GET' && p === '/api/notes') return json(res, 200, Object.fromEntries(IDS.map((id) => [id, store.readNote(id)])));
      if (req.method === 'GET' && p === '/api/file') {
        const file = store.readFile(url.searchParams.get('path'));
        return json(res, 200, { ...file, activity: /\.html?$/i.test(file.rel) ? 'game' : store.meta[file.rel]?.activity || null });
      }
      if (req.method === 'GET' && p === '/api/history') return json(res, 200, { messages: store.messages.filter((m) => m.id < (Number(url.searchParams.get('before')) || Infinity)).slice(-200) });
      if (req.method === 'POST') {
        const body = await bodyOf(req);
        if (p.startsWith('/api/world/')) {
          const action = p.slice('/api/world/'.length);
          let result;
          if (action === 'join') result = player.join(body.token);
          else if (action === 'leave') result = player.leave(body.token);
          else if (action === 'heartbeat') result = player.heartbeat(body.token);
          else if (action === 'move') result = player.move(body.token, body.dx, body.dz);
          else if (action === 'edit') result = player.edit(body.token, body.op, body.at, body.block);
          else if (action === 'undo') result = player.undo(body.token);
          else return json(res, 404, { error: '지원하지 않는 월드 조작입니다.' });
          return json(res, 200, result);
        }
        if (p === '/api/cancel') {
          active?.controller.abort();
          await runtime.stop();
          if (active) await active.done;
          return json(res, 200, { ok: true });
        }
        if (p === '/api/room') {
          if (body.boostMode !== undefined && !BOOST_MODES.includes(body.boostMode)) return json(res, 400, { error: '진심모드는 자동·부를 때만·끔 중에서 선택하세요.' });
          if (body.auto?.sleepMinutes !== undefined && ![0, 5, 15, 30, 60].includes(body.auto.sleepMinutes)) return json(res, 400, { error: '자동 잠들기 시간을 확인하세요.' });
          const models = { ...room.models }, debateModels = { ...room.debateModels };
          for (const id of IDS) {
            if (body.models?.[id]) models[id] = settingsOf(id, body.models[id], room.models[id], modelCache.gpt);
            if (body.debateModels?.[id]) debateModels[id] = settingsOf(id, body.debateModels[id], room.debateModels[id], modelCache.gpt);
          }
          if (IDS.includes(body.selected)) room.selected = body.selected;
          if (IDS.includes(body.synthesizer)) room.synthesizer = body.synthesizer;
          if (typeof body.discussion === 'boolean') room.discussion = body.discussion;
          if (body.boostMode !== undefined) native.boostMode = room.boostMode = body.boostMode;
          if (typeof body.roomName === 'string') room.roomName = cleanTitle(body.roomName) || cfg.roomName || 'AI 단톡방';
          if (typeof body.userName === 'string') room.userName = cleanTitle(body.userName) || cfg.userName || '방장';
          if (typeof body.webSearch === 'boolean') room.webSearch = body.webSearch;
          if (typeof body.onboarding?.done === 'boolean') room.onboarding.done = body.onboarding.done;
          if (typeof body.tutorial?.done === 'boolean') room.tutorial.done = body.tutorial.done;
          for (const id of IDS) {
            if (typeof body.memos?.[id] === 'string') store.writeNote(id, body.memos[id]);
            if (typeof body.bios?.[id] === 'string') room.bios[id] = cleanBio(body.bios[id]);
            if (typeof body.enabled?.[id] === 'boolean') room.enabled[id] = body.enabled[id];
          }
          room.models = models; room.debateModels = debateModels;
          if (body.speed && SPEEDS[body.speed]) native.speed = body.speed;
          if (body.auto?.sleepMinutes !== undefined) native.autoSleepMin = room.auto.sleepMinutes = body.auto.sleepMinutes;
          if (body.auto?.on === true && !native.running) runtime.start();
          if (body.auto?.on === false) await runtime.stop();
          persist(); publish(); return json(res, 200, view());
        }
        if (p === '/api/check/login') {
          await Promise.all((IDS.includes(body.id) ? [body.id] : IDS).map(async (id) => {
            const result = available[id] ? await adapter.loginStatus(id) : { status: 'missing', detail: 'CLI가 설치되어 있지 않습니다.' };
            room.checks[id].login = { ...result, detail: redact(result.detail), at: clock() };
            if (id === 'gpt' && result.status === 'ok') await refreshModels(id);
          }));
          persist(); publish(); return json(res, 200, view());
        }
        if (p === '/api/usage/refresh') { if (usage && clock() - usage.lastPoll >= 15000) pollUsage(); return json(res, 200, { ok: true }); }
        if (p === '/api/models/refresh') {
          if (!IDS.includes(body.id)) return json(res, 400, { error: 'AI를 확인하세요.' });
          await refreshModels(body.id); persist(); publish(); return json(res, 200, view());
        }
        if (p === '/api/check/call') {
          const id = body.id;
          if (!IDS.includes(id) || !available[id]) return json(res, 400, { error: 'AI 연결을 확인하세요.' });
          if (checking.has(id)) return json(res, 409, { error: '이미 확인 중입니다.' });
          const base = body.target === 'debate' ? room.debateModels[id] : room.models[id];
          const settings = body.model ? settingsOf(id, { model: body.model, effort: body.effort ?? '' }, base, modelCache.gpt) : base;
          const controller = new AbortController(); checking.set(id, controller); publish();
          let result;
          try { result = await adapter.chat(id, CHECK_BRIEF, '연결 확인입니다. OK라고만 답하세요.', { settings, independent: true, webSearch: false, signal: controller.signal, timeoutMs: 90000 }); }
          catch (e) { result = { ok: false, detail: e.message }; } finally { checking.delete(id); }
          if (!controller.signal.aborted) {
            const ok = result.ok && !!result.text?.trim(), kind = ok ? null : errorKind(result.detail || '');
            room.checks[id].models[settings.model] = { status: ok ? 'ok' : 'fail', effort: settings.effort, kind, label: kindLabel(kind), detail: redact(result.detail || ''), at: clock() };
          }
          persist(); publish(); return json(res, 200, view());
        }
        if (p === '/api/react') {
          const emoji = String(body.emoji || '').slice(0, 8);
          if (!store.byId.has(Number(body.id)) || !emoji) return json(res, 400, { error: '공감할 메시지와 반응을 확인하세요.' });
          store.applyReaction(Number(body.id), 'user', emoji); native.lastUserAt = clock(); persist(); publish();
          return json(res, 200, { ok: true });
        }
        if (p === '/api/send') {
          if (active) return json(res, 409, { error: '진행 중인 토론을 기다리거나 중지해 주세요.' });
          let text = String(body.text ?? '').trim().slice(0, 4000);
          if (!text && !body.image?.data && !body.sticker) return json(res, 400, { error: '메시지를 입력하세요.' });
          const reply = store.byId.get(Number(body.replyTo));
          if (body.replyTo != null && (!reply || reply.from === 'system')) return json(res, 400, { error: '답장할 메시지가 없습니다.' });
          const command = Router.parseCommand(text);
          if (command) {
            if (!command.ids.length) return json(res, 400, { error: '/boost @멤버 이름으로 진심모드를 요청하세요.' });
            if (room.boostMode === 'off') return json(res, 400, { error: '진심모드가 꺼져 있습니다.' });
            runtime.router.cfg = config();
            const ids = command.ids.filter((id) => IDS.includes(id) && runtime.router.boostOf(id));
            if (!ids.length) return json(res, 400, { error: '진심모드 설정이 있는 멤버가 없습니다.' });
            ids.forEach((id) => runtime.router.arm(id));
            post({ from: 'system', kind: 'deep', text: `⚡ ${ids.map(nameOf).join('·')} 진심모드 예약 (다음 턴)` });
            if (!command.rest && !body.image?.data) {
              native.lastUserAt = clock();
              if (!native.running && native.sleeping) runtime.start();
              persist(); publish(); return json(res, 200, { ok: true, running: native.running });
            }
            text = `${ids.map((id) => `@${nameOf(id)}`).join(' ')} ${command.rest}`.trim();
          }
          const selection = room.discussion ? discussionTargets(text) : null;
          if (selection && selection.participants.length < 2) return json(res, 400, { error: '토론하려면 참여할 AI가 2명 이상 필요합니다.' });
          let attach;
          if (body.image?.data) attach = { path: saveImage(store, body.image), upload: true };
          if (body.sticker) {
            const rel = runtime.stickerPath(body.sticker);
            if (!rel || !fs.existsSync(store.abs(rel))) return json(res, 400, { error: '스티커가 없습니다.' });
            attach = { path: rel, sticker: true };
          }
          native.lastUserAt = clock();
          const message = post({ from: 'user', text, replyTo: reply?.id, attach });
          if (selection) beginDiscussion(message, selection, attach?.upload ? [store.abs(attach.path)] : []);
          else if (attach?.upload) runtime.describeUpload(message);
          if (!native.running && native.sleeping) runtime.start();
          persist(); publish();
          return json(res, 200, { ok: true, msg: message, running: native.running });
        }
        return json(res, 404, { error: '지원하지 않는 기능입니다.' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: '지원하지 않는 요청입니다.' });
      if (p.startsWith('/ws/')) return await serve(res, store.abs(store.safeRel(p.slice(4))), true);
      const rel = p === '/' ? 'index.html' : p.slice(1);
      if (rel === 'vendor/three.module.js') return await serve(res, path.join(ROOT, 'node_modules/three/build/three.module.js'));
      if (/^vendor\/addons\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.js$/.test(rel)) return await serve(res, path.join(ROOT, 'node_modules/three/examples/jsm', rel.slice('vendor/addons/'.length)));
      if (!['index.html', 'assistant.js', 'format.mjs', 'status.mjs', 'discussion-stage.mjs', 'assistant.css', 'style.css', 'world.html', 'world-player.js', 'world-player.css', 'i18n.js', 'recipients.mjs', 'share.js'].includes(rel)
        && !/^avatars\/(?:(claude|gpt|gemini)-pixel(-128)?\.png)$/.test(rel)
        && !/^sprites\/discussion-(claude|gpt|gemini)\.svg$/.test(rel)) return json(res, 404, { error: '파일이 없습니다.' });
      return await serve(res, path.join(ROOT, 'public', rel));
    } catch (e) {
      if (!res.headersSent) json(res, e.status || (e.code === 'ENOENT' ? 404 : 400), { error: e.message }); else res.end();
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    try { await stopSharing(); } catch (error) { store.log('sharing', `연결 해제 실패: ${error.message}`); }
    await Promise.allSettled([...guestJobs.values()].map((job) => job.done));
    if (externalStarting) { try { await externalStarting; } catch { /* Already reported to the caller. */ } }
    clearInterval(normalTimer); if (usageTimer) clearInterval(usageTimer);
    active?.controller.abort();
    for (const controller of checking.values()) controller.abort();
    await runtime.close(); if (active) await active.done;
    for (const client of clients) client.end(); clients.clear();
    if (usage) usage.onUpdate = () => {};
    if (externalServer) {
      externalServer.closeAllConnections();
      if (externalServer.listening) await new Promise((resolve) => externalServer.close(resolve));
    }
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  return { server, startExternal, phoneConnection, startSharing, close, store, world, activity, room, runtime, view, tick, get active() { return active; } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig(), root = process.env.CHATROOM_HOME || ROOT;
  const adapter = new Adapters(root, cfg);
  const app = createAssistantServer({ root, cfg, adapter, usage: new UsageMonitor(root, adapter.bins) });
  app.server.on('error', (e) => { console.error(`서버 실행 실패: ${e.message}`); process.exitCode = 1; });
  app.server.listen(cfg.port, '127.0.0.1', () => {
    app.startExternal(process.argv.includes('--tailscale') ? { tailscale: true } : {}).then((listener) => {
      const phone = app.phoneConnection();
      if (phone) console.log(`휴대폰에서 Tailscale을 켜고 접속: ${phone.url}\n로그인 비밀번호: ${phone.password}\n이 주소는 Tailscale 연결 기기에서만 사용합니다. 주소와 비밀번호를 공유하지 마세요.`);
      else if (listener) console.log(`휴대폰 외부 접속: HTTPS 포트 ${listener.address().port} · 비밀번호: ${path.join(root, 'data', 'external-password.txt')}`);
    }).catch((error) => console.error(`외부 접속을 열지 못했습니다 (로컬 사용은 가능): ${error.message}`));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    console.log(`AI 단톡방: ${url}\n방을 켜면 AI들이 원본 방식으로 대화합니다. 토론 모드는 별도로 사용할 수 있습니다.`);
    if (process.argv.includes('--open')) {
      const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', (e) => console.error(`브라우저 열기 실패: ${e.message}`)).unref();
    }
  });
  const shutdown = async () => { await app.close(); killAll(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
