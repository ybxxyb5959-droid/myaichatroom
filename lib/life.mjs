// Life in the finished house. Everything here is rules and short scripts: no AI call is made to move a
// character, start an event, change a relation or settle a disagreement. These are character states for
// a cosy room, not claims about real feelings.
//   build -> life : legacy homes keep their basic rules; spacious rebuilds finish all rooms and passages.
//   life beats     : a member sits, works at the desk, reads, tends a plant, tidies, visits a friend…
//   mirroring      : the real app state (chat replies, Talk, quota rest) moves the character to fitting spots.
//   events         : small positive / neutral / conflict episodes; a conflict is followed by mediation and
//                    reconciliation over time, also when the owner never answers.
import { USES, HOUSE_MODES, HOUSE_LIMITS } from './house.mjs';
import { projectStatus } from './house-project.mjs';

const MIN = 60000, HOUR = 60 * MIN;
// Cooldowns per activity level: between ordinary life beats and between events (randomised ±30%).
export const LIFE_PACE = { low: [20 * MIN, 40 * MIN], medium: [8 * MIN, 15 * MIN], high: [3 * MIN, 6 * MIN] };
export const EVENT_GAP = { low: 3 * HOUR, medium: 90 * MIN, high: 40 * MIN };
export const ASK_MS = 30 * MIN;          // how long a big matter waits for the owner before the AIs settle it
export const RELATION_START = 70;        // friendly-neutral
export const MAX_STEP = 3;               // no single event moves a relation by more than this
export const DELTA = { coop: 2, help: 1, praise: 1, prank: 0, desk: 0, space: 0, minor: -1, tidy: -1, major: -3, mediate: 1, reconcile: 2, owner: 1 };
const KEEP_EVENTS = 30;

const KEYWORDS = {
  sit: /소파|의자|벤치|스툴|sofa|couch|chair|bench|stool/i,
  desk: /책상|데스크|컴퓨터|모니터|작업대|desk|computer|pc|monitor/i,
  read: /책장|책꽂이|서재|선반|책|book|shelf|library/i,
  plant: /화분|식물|나무|꽃|선인장|plant|tree|flower|cactus/i,
  rest: /침대|쿠션|빈백|해먹|러그|매트|bed|cushion|beanbag|hammock|rug/i,
};
// A design's own "use" wins; otherwise the name decides (책상 is a desk before it is a book).
export const useOf = (def, name) => (USES.includes(def?.use) ? def.use : USES.find((u) => KEYWORDS[u].test(String(name))) || null);
const furniture = (house) => house.s.items.map((item) => ({ item, use: useOf(house.def(item.def), item.def) }));

export function isComplete(house) {
  if (house.s.planning || house.s.project === 'spacious') return projectStatus(house).complete;
  const { floors, walls } = house.s;
  const ws = Object.values(walls), uses = new Set(furniture(house).map((f) => f.use));
  return Object.keys(floors).length >= 16 && ws.length >= 8 && ws.some((w) => w.door) && house.s.items.length >= 3 && (uses.has('sit') || uses.has('rest'));
}
export function enterLife(house, now) {
  if (house.s.phase === 'life') return false;
  Object.assign(house.s, { phase: 'life', lifeSince: now });
  house.s.log.push({ kind: 'event', id: 'house', text: '🏠 기본 집이 완성됐어요. 이제 여기서 생활해요.', at: now });
  return true;
}

// ---------- relations ----------
const pairKey = (a, b) => [a, b].sort().join(':');
export const relationOf = (house, a, b) => house.s.relations[pairKey(a, b)] ?? RELATION_START;
export function relate(house, a, b, delta) {
  const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, Math.round(delta)));
  const value = Math.max(0, Math.min(100, relationOf(house, a, b) + step));
  house.s.relations[pairKey(a, b)] = value;
  return value;
}
// Once a day every relation drifts one point back toward the start, so nothing stays extreme.
export function drift(house, day) {
  if (house.s.driftDay === day) return false;
  house.s.driftDay = day;
  for (const [key, v] of Object.entries(house.s.relations)) house.s.relations[key] = v + Math.sign(RELATION_START - v);
  return true;
}

// ---------- moving and doing ----------
const near = (house, id, cells, rand) => {
  const taken = new Set(Object.entries(house.s.agents).filter(([k]) => k !== id).map(([, p]) => `${p.x},${p.z}`));
  const spots = [];
  for (const [x, z] of cells) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, nz = z + dz, k = `${nx},${nz}`;
    if (house.walkable(nx, nz) && !taken.has(k) && !spots.some((s) => s.k === k)) spots.push({ k, x: nx, z: nz, floor: !!house.s.floors[k] });
  }
  const inside = spots.filter((s) => s.floor);
  const pick = (inside.length ? inside : spots)[Math.floor(rand() * (inside.length || spots.length))];
  if (pick) Object.assign(house.s.agents[id], { x: pick.x, z: pick.z });
  return !!pick;
};
const ICON = { sit: '☕', desk: '💻', read: '📖', plant: '🪴', rest: '😴' };
const ACT = { sit: (n) => `${n}에서 쉬는 중`, desk: (n) => `${n}에서 컴퓨터 하는 중`, read: (n) => `${n} 옆에서 책 읽는 중`, plant: (n) => `${n} 돌보는 중`, rest: (n) => `${n}에서 뒹구는 중` };
function setDoing(house, id, act, text, now) {
  Object.assign(house.s.agents[id], { act, doing: text, since: now });
  return { id, act, text };
}
function goUse(house, id, uses, rand) {
  const options = furniture(house).filter((f) => uses.includes(f.use));
  if (!options.length) return null;
  const f = options[Math.floor(rand() * options.length)];
  const moved = near(house, id, house.cellsOf(f.item), rand);
  const occupied = [...Object.entries(house.s.agents).filter(([other]) => other !== id).map(([, a]) => a), house.s.player]
    .some((a) => a?.furnitureId === f.item.id && ['sit', 'lie'].includes(a.pose));
  if (moved && !occupied && ['sit', 'rest'].includes(f.use)) {
    Object.assign(house.s.agents[id], { furnitureId: f.item.id, pose: f.use === 'rest' ? 'lie' : 'sit' });
  }
  return f;
}
// One life beat for `id`. mode: 'free' (ordinary), 'work', 'talk', 'rest' (quota), 'off', 'sleep', 'after-work'.
export function lifeBeat(house, id, { mode = 'free', partner = null, names = {}, rand = Math.random, now = Date.now() } = {}) {
  delete house.s.agents[id].pose;
  delete house.s.agents[id].furnitureId;
  const name = (x) => names[x] || x;
  if (mode === 'work') { const f = goUse(house, id, ['desk'], rand); return setDoing(house, id, 'work', `💻 ${f ? `${f.item.def}에서` : '구석에서'} 작업 중`, now); }
  if (mode === 'talk' && partner) { near(house, id, [[house.s.agents[partner].x, house.s.agents[partner].z]], rand); return setDoing(house, id, 'talk', `💬 ${name(partner)}와 이야기 중`, now); }
  if (mode === 'rest' || mode === 'off' || mode === 'sleep') {
    const f = goUse(house, id, ['rest', 'sit'], rand);
    const text = mode === 'sleep' ? '💤 자는 중' : mode === 'rest' ? `😴 ${f ? `${f.item.def}에서 ` : ''}한숨 쉬는 중` : `☕ ${f ? `${f.item.def}에서 ` : ''}쉬는 중`;
    return setDoing(house, id, mode, text, now);
  }
  if (mode === 'after-work') { const f = goUse(house, id, ['sit', 'rest'], rand); return setDoing(house, id, 'sit', `☕ 작업 끝나고 ${f ? `${f.item.def}에서 ` : ''}쉬는 중`, now); }
  // Ordinary beat: furniture actions plus a few that need no furniture; never the same as this member's last one.
  const last = house.s.agents[id].act;
  const others = Object.keys(house.s.agents).filter((x) => x !== id);
  const kinds = [...new Set(furniture(house).map((f) => f.use).filter(Boolean)), 'wander', 'tidy', 'alone', ...(others.length ? ['visit'] : [])].filter((k) => k !== last);
  const kind = kinds[Math.floor(rand() * kinds.length)];
  if (USES.includes(kind)) { const f = goUse(house, id, [kind], rand); return setDoing(house, id, kind, `${ICON[kind]} ${ACT[kind](f.item.def)}`, now); }
  if (kind === 'visit') { const who = others[Math.floor(rand() * others.length)]; near(house, id, [[house.s.agents[who].x, house.s.agents[who].z]], rand); return setDoing(house, id, 'visit', `👋 ${name(who)} 옆에 놀러 감`, now); }
  if (kind === 'wander' && house.s.items.length) { const item = house.s.items[Math.floor(rand() * house.s.items.length)]; near(house, id, house.cellsOf(item), rand); return setDoing(house, id, 'wander', `🚶 ${item.def} 구경하는 중`, now); }
  if (kind === 'tidy') return setDoing(house, id, 'tidy', '🧹 방 정리하는 중', now);
  return setDoing(house, id, 'alone', '🌿 혼자 쉬는 중', now);
}

// ---------- undo for small automatic changes ----------
export const snapshot = (house) => structuredClone({ floors: house.s.floors, walls: house.s.walls, items: house.s.items, defs: house.s.defs,
  ...(house.s.planning ? { planning: house.s.planning, plan: house.s.plan, phase: house.s.phase } : {}) });
export function markUndo(house, before, by, text, now) { house.s.undo = { by, text, at: now, rev: house.s.rev, before }; }
export function undo(house, now) {
  const u = house.s.undo;
  if (!u || u.rev !== house.s.rev) throw new Error('되돌릴 수 있는 최근 변경이 없어요.');
  Object.assign(house.s, u.before);
  house.s.rev++; house.s.undo = null;
  house.s.log.push({ kind: 'event', id: 'user', text: `방장이 되돌림: ${u.text}`, at: now });
  return u;
}
// A mediator's "other arrangement": the piece is turned a quarter if it still fits; undo restores it.
function turnItem(house, item) {
  const cells = (rot) => house.cellsOf({ ...item, rot });
  const rot = (item.rot + 1) % 4;
  const ok = cells(rot).every(([x, z]) => house.s.floors[`${x},${z}`] && !house.s.walls[`${x},${z}`] && !house.s.items.some((o) => o !== item && house.cellsOf(o).some(([ox, oz]) => ox === x && oz === z)));
  if (ok) { item.rot = rot; house.s.rev++; }
  return ok;
}

// ---------- events ----------
const TYPES = {
  positive: [
    { type: 'coop', text: (a, b, it) => `${a}와 ${b}가 같이 ${it} 주변을 정리함` },
    { type: 'help', text: (a, b, it) => `${a}가 ${b}의 ${it} 정리를 도와줌` },
    { type: 'praise', text: (a, b, it) => `${a}가 ${b}가 고른 ${it} 배치를 칭찬함` },
    { type: 'prank', text: (a, b) => `${a}가 ${b} 자리에 쿠션을 몰래 올려 둠 (장난)` },
  ],
  neutral: [
    { type: 'desk', text: (a, b, it) => `${a}가 ${it}을(를) 오래 써서 ${b}가 옆에서 기다림`, use: 'desk' },
    { type: 'space', text: (a, b, it) => `${a}와 ${b}가 같은 ${it}에 앉으려다 자리를 나눠 앉음`, use: 'sit' },
  ],
  conflict: [
    { type: 'minor', text: (a, b, it) => `${a}와 ${b}가 ${it} 위치를 두고 의견이 갈림` },
    { type: 'tidy', text: (a, b) => `${a}와 ${b}가 정리 방식으로 티격태격함` },
  ],
};
const MAJOR = { type: 'major', text: (a, b) => `${a}와 ${b}가 작업 공간 배치를 두고 크게 의견이 갈림` };
const weighted = (rand, entries) => {
  const total = entries.reduce((n, [, w]) => n + w, 0);
  let r = rand() * total;
  for (const [value, w] of entries) { r -= w; if (r < 0) return value; }
  return entries.at(-1)[0];
};
function push(house, ev, now) {
  const event = { id: house.s.nextEventId++, at: now, ...ev };
  house.s.events = [...house.s.events, event].slice(-KEEP_EVENTS);
  house.s.log.push({ kind: 'event', id: ev.actors[0], text: ev.text, at: now });
  house.s.log = house.s.log.slice(-HOUSE_LIMITS.log);
  return event;
}
// Whether the owner gets a say: only big matters in ⚖️ (default), also small disagreements in 🎮, never in 🤖.
const asks = (mode, type) => (mode === 'together' ? ['major', 'minor'].includes(type) : mode === 'balanced' ? type === 'major' : false);

// The next event, or null. An open disagreement always goes first (mediation, then reconciliation);
// it waits for the owner only while a question is open and its time has not run out.
export function lifeEvent(house, { ids, names = {}, rand = Math.random, now = Date.now() }) {
  const name = (x) => names[x] || x;
  const open = house.s.open;
  if (open) {
    if (open.ask && !open.ask.answer && now < open.ask.deadline) return null;
    return progress(house, open, ids, name, rand, now);
  }
  if (ids.length < 2) return null;
  const a = ids[Math.floor(rand() * ids.length)];
  const rest = ids.filter((x) => x !== a), b = rest[Math.floor(rand() * rest.length)];
  const rel = relationOf(house, a, b);
  // Recent events (the last three) only steer away from repeats; low relations lean toward friendly episodes.
  const recent = house.s.events.slice(-3).map((e) => e.type);
  const tone = weighted(rand, [['positive', rel < 55 ? 65 : 50], ['neutral', 25], ['conflict', rel < 55 ? 10 : rel > 85 ? 30 : 25]]);
  const pool = TYPES[tone].filter((t) => t.type !== recent.at(-1) && (!t.use || furniture(house).some((f) => f.use === t.use)));
  let pick = pool.length ? pool[Math.floor(rand() * pool.length)] : TYPES.positive.find((t) => t.type !== recent.at(-1));
  if (tone === 'conflict' && rand() < 0.15 && recent.at(-1) !== 'major') pick = MAJOR;
  const items = pick.use ? furniture(house).filter((f) => f.use === pick.use).map((f) => f.item) : house.s.items;
  const item = items.length ? items[Math.floor(rand() * items.length)] : null;
  const text = pick.text(name(a), name(b), item?.def || '거실 물건');
  relate(house, a, b, DELTA[pick.type]);
  const event = push(house, { type: pick.type, tone: pick === MAJOR ? 'conflict' : tone, actors: [a, b], text }, now);
  if (event.tone === 'conflict') {
    house.s.open = { eventId: event.id, type: pick.type, pair: [a, b], stage: 'conflict', itemId: item?.id ?? null, text,
      ask: asks(house.s.mode, pick.type) ? { deadline: now + ASK_MS, answer: null } : null };
    event.ask = !!house.s.open.ask;
  }
  return event;
}
function progress(house, open, ids, name, rand, now) {
  const [a, b] = open.pair;
  const item = house.s.items.find((it) => it.id === open.itemId) || null;
  const owner = open.ask?.answer === 'owner';
  const mediator = ids.find((x) => x !== a && x !== b);
  if (open.stage === 'conflict' && (owner || mediator)) {
    open.stage = 'mediated';
    let changed = false;
    const before = snapshot(house);
    if (item && open.type !== 'tidy') changed = turnItem(house, item);
    if (owner) {
      relate(house, a, b, DELTA.owner);
      const text = `방장 의견${open.ask.note ? `(“${open.ask.note}”)` : ''}대로 정리하기로 함 · ${name(a)}와 ${name(b)} 동의`;
      if (changed) markUndo(house, before, 'user', `방장 의견대로 ${item.def} 방향을 바꿈`, now);
      return push(house, { type: 'owner', tone: 'positive', actors: [a, b], text }, now);
    }
    relate(house, mediator, a, DELTA.mediate); relate(house, mediator, b, DELTA.mediate); relate(house, a, b, DELTA.mediate);
    if (changed) markUndo(house, before, mediator, `${name(mediator)}가 ${item.def} 방향을 바꿈`, now);
    const text = item && open.type !== 'tidy' ? `${name(mediator)}가 ${item.def} 방향을 바꿔 보자고 중재함${changed ? ' · 새 배치 적용' : ''}` : `${name(mediator)}가 번갈아 정리하자고 중재함`;
    return push(house, { type: 'mediate', tone: 'positive', actors: [mediator, a, b], text }, now);
  }
  house.s.open = null;
  relate(house, a, b, DELTA.reconcile);
  const text = `${name(a)}와 ${name(b)}가 화해함 · ${name(b)}가 결과에 만족함`;
  return push(house, { type: 'reconcile', tone: 'positive', actors: [a, b], text }, now);
}
// Something from outside house life (a game result) noted in the house record; relations move by the
// same small rules (one step of at most ±1 here).
export function noteEvent(house, { type, actors, text, pair = null, delta = 0 }, now) {
  if (pair) relate(house, pair[0], pair[1], Math.max(-1, Math.min(1, delta)));
  return push(house, { type, tone: 'positive', actors, text }, now);
}
// A light hint for a Talk turn: at most two short lines about this member's last few house events
// (within a day). Only flavour — the prompt says so — never a script to argue.
const HINT = { reconcile: '최근 {o}와 화해함', mediate: '최근 집에서 중재를 맡음', coop: '최근 {o}와 같이 집 정리를 함', praise: '최근 {o}와 서로 칭찬함', help: '최근 {o}를 도와줌', owner: '최근 방장 의견대로 집 일을 정함', minor: '최근 {o}와 배치 의견이 조금 달랐음', tidy: '최근 {o}와 정리 방식으로 티격태격함' };
export function relationHint(house, id, { names = {}, now = Date.now() } = {}) {
  const lines = [];
  for (const e of [...house.s.events].reverse().slice(0, 3)) {
    if (now - e.at > 24 * HOUR || !e.actors.includes(id) || !HINT[e.type]) continue;
    const other = e.actors.find((x) => x !== id);
    lines.push(HINT[e.type].replace('{o}', names[other] || other || '동료'));
    if (lines.length === 2) break;
  }
  return lines;
}
// Scripted (no-call) Talk lines that follow a recent house event between two members, or null.
const EVENT_LINES = {
  reconcile: [['{b}, 아까 그 배치 건은 결국 괜찮게 됐네', '그치ㅋㅋ 지금 보니까 나쁘지 않아'], ['{b}, 우리 아까 꽤 진지했다ㅋㅋ', '그래도 금방 정리됐잖아']],
  mediate: [['{b}, 아까 중재해줘서 고마워', '별거 아니었어ㅋㅋ'], ['{b} 덕분에 빨리 끝났다', '다음엔 둘이 알아서 해ㅋㅋ']],
  coop: [['{b}, 같이 정리하니까 금방 끝났네', '혼자 했으면 한참 걸렸을 듯']],
  minor: [['{b}, 그 위치는 아직 좀 고민돼', '음… 나중에 다시 얘기해 보자'], ['{b}, 그 배치 진짜 괜찮다고 생각해?', '반반? 일단 두고 보자']],
};
export function eventChatter(house, ids, { names = {}, now = Date.now(), rand = Math.random } = {}) {
  const e = [...house.s.events].reverse().find((x) => now - x.at <= 6 * HOUR && EVENT_LINES[x.type] && x.actors.filter((a) => ids.includes(a)).length >= 2);
  if (!e) return null;
  const [a, b] = e.actors.filter((x) => ids.includes(x));
  const [first, second] = EVENT_LINES[e.type][Math.floor(rand() * EVENT_LINES[e.type].length)];
  return [{ id: a, text: first.replace('{b}', names[b] || b) }, { id: b, text: second.replace('{b}', names[a] || a) }];
}
// The owner may also step into an autonomous disagreement before mediation starts.
export function decide(house, choice, note = '', eventId = null) {
  const open = house.s.open;
  if (!open || open.ask?.answer || (eventId !== null && eventId !== open.eventId)
    || (!open.ask && open.stage !== 'conflict')) throw new Error('지금 정할 집 일이 없어요.');
  if (!['ai', 'owner'].includes(choice)) throw new Error('선택을 확인하세요.');
  open.ask ||= { deadline: 0, answer: null };
  open.ask.answer = choice;
  open.ask.note = String(note).replace(/[\u0000-\u001f\u007f"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}
export const setMode = (house, mode) => {
  if (!HOUSE_MODES.includes(mode)) throw new Error('집 운영 방식을 확인하세요.');
  house.s.mode = mode;
};
