// The shared house: a small grid the AI members build together, slowly, one short turn at a time.
// Everything the models send is data: it is validated and clamped here, never run.
// State lives in data/house.json, so building continues after the app was closed and reopened.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { rotateParts, footprintOf, MAX_SIDE } from '../public/house-shape.mjs';
import { writeJsonFile, readJsonFile } from './atomic.mjs';

export const SIZE = 20;
export const PALETTE = {
  white: '#f4f1ea', cream: '#efe3c8', beige: '#d8c3a0', wood: '#b98550', darkwood: '#7a4e2d', brown: '#5e3b22',
  gray: '#9ea3ab', darkgray: '#4f545e', black: '#23262d', red: '#d9534f', orange: '#e8914a', yellow: '#ecc94b',
  green: '#5fa660', lime: '#a6cf5a', teal: '#3aa6a0', blue: '#4f8fe0', navy: '#2f4a8a', purple: '#8b6bd1', pink: '#ee93b4',
};
export const HOUSE_LIMITS = { cellsPerTurn: 40, areaCells: 36, wallLine: 12, actions: 6, parts: 12, defs: 40, items: 100, walls: 300, log: 40, plan: 400, say: 120, name: 16 };
const SHAPES = ['box', 'cyl', 'ball'];
// What a piece of furniture is for once the AIs live in the house (optional in a design; see lib/life.mjs).
export const USES = ['sit', 'desk', 'read', 'plant', 'rest'];
// How much the owner is asked about house matters: fully autonomous, only big decisions (default), together.
export const HOUSE_MODES = ['auto', 'balanced', 'together'];
const GLYPH = { claude: 'C', gpt: 'P', gemini: 'G' };

export const HOUSE_BRIEF = `너희는 단톡방 AI 멤버들이고, 같이 "집"을 아주 천천히 지어 간다. 한국어 반말로 짧게 말한다.
집은 ${SIZE}x${SIZE} 격자(x 가로 0~${SIZE - 1}, z 세로 0~${SIZE - 1})다. 처음엔 빈 풀밭이고, 구조(바닥·벽·문)부터 가구까지 전부 너희가 정한다.
한 턴에 작은 일만 한다. 동료가 만든 것을 존중하고 이어서 짓는다. 계획(plan)을 갱신해서 다음 사람이 이어갈 수 있게 한다.
반드시 JSON 객체 하나로만 답한다. 설명이나 코드펜스는 쓰지 않는다.
{"say":"한마디(120자 이내, 생략 가능. 작업을 꼭 넘겨야 할 때만 가끔 @Claude, @GPT, @Gemini처럼 동료를 부른다)","plan":"공동 계획과 다음 할 일(400자 이내, 생략 가능)","actions":[...]}
actions는 최대 ${HOUSE_LIMITS.actions}개, 한 턴에 칠하는 칸은 합쳐서 ${HOUSE_LIMITS.cellsPerTurn}칸까지. 종류:
- {"type":"floor","x1":2,"z1":2,"x2":6,"z2":5,"color":"wood"}  사각형 바닥(최대 ${HOUSE_LIMITS.areaCells}칸)
- {"type":"wall","x1":2,"z1":2,"x2":8,"z2":2,"color":"cream"}  가로 또는 세로 한 줄 벽(최대 ${HOUSE_LIMITS.wallLine}칸)
- {"type":"door","x":4,"z":2}  이미 있는 벽 칸을 문으로(지나다닐 수 있음)
- {"type":"erase","x":4,"z":2}  그 칸의 가구, 없으면 벽, 없으면 바닥을 지움
- {"type":"define","name":"소파","parts":[{"s":"box","x":0,"y":0,"z":0,"w":2,"h":0.5,"d":1,"c":"blue"}, ...]}  가구 설계. 부품 최대 ${HOUSE_LIMITS.parts}개, s는 box/cyl/ball, 위치·크기는 칸 단위(각 변 최대 ${MAX_SIDE}), c는 색 이름
  define에 "use"를 붙이면 생활할 때 그 용도로 쓴다(생략 가능): sit 앉기, desk 책상·컴퓨터, read 책, plant 식물, rest 눕기·쉬기
- {"type":"place","def":"소파","x":3,"z":3,"rot":0}  설계한 가구 배치(rot 0~3은 90도씩 회전). 바닥이 깔린 칸에만, 벽·다른 가구와 겹치지 않게
- {"type":"move","x":3,"z":4}  내 캐릭터가 걸어갈 곳(벽·가구 칸 제외)
색 이름: ${Object.keys(PALETTE).join(', ')}
좌표는 정수. 지도 글자: . 풀밭, , 바닥, # 벽, + 문, F 가구, C/P/G 캐릭터.`;

const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f<>"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const key = (x, z) => `${x},${z}`;
const inGrid = (x, z) => Number.isInteger(x) && Number.isInteger(z) && x >= 0 && z >= 0 && x < SIZE && z < SIZE;
const fail = (message) => { throw new Error(message); };
const num = (v, lo, hi, what) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) fail(`${what} 값이 범위(${lo}~${hi})를 벗어났어요.`);
  return n;
};
const cell = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n >= SIZE) fail(`${what} 좌표는 0~${SIZE - 1}의 정수여야 해요.`);
  return n;
};
const colorOf = (v) => {
  const c = String(v ?? '').toLowerCase();
  if (PALETTE[c]) return c;
  fail(`색 이름(${Object.keys(PALETTE).join(', ')}) 중에서 골라요.`);
};

export class House {
  constructor(file, { ids, names }) {
    this.file = file; this.ids = ids; this.names = names;
    this.warnings = [];
    const saved = readJsonFile(file, {}, {
      validate: (v) => v && typeof v === 'object' && !Array.isArray(v)
        && ['items', 'log', 'events'].every((k) => v[k] === undefined || Array.isArray(v[k]))
        && ['floors', 'walls', 'defs', 'agents', 'relations'].every((k) => v[k] === undefined || (v[k] && typeof v[k] === 'object' && !Array.isArray(v[k]))),
      onRecovery: (message) => this.warnings.push(message),
    });
    this.s = {
      floors: saved.floors || {}, walls: saved.walls || {}, defs: saved.defs || {}, items: saved.items || [],
      agents: saved.agents || {}, plan: saved.plan || '', log: saved.log || [], turns: saved.turns || 0,
      lastTurnAt: saved.lastTurnAt || 0, lastActor: saved.lastActor || null, nextId: saved.nextId || 1,
      // Life after building (lib/life.mjs). Older house files have none of these and start in 'build'.
      phase: saved.phase === 'life' ? 'life' : 'build', lifeSince: saved.lifeSince || 0,
      mode: HOUSE_MODES.includes(saved.mode) ? saved.mode : 'balanced',
      relations: saved.relations || {}, events: saved.events || [], open: saved.open || null,
      undo: saved.undo || null, rev: saved.rev || 0, nextEventId: saved.nextEventId || 1, driftDay: saved.driftDay || '',
    };
    ids.forEach((id, i) => { if (!this.s.agents[id]) this.s.agents[id] = { x: 8 + i * 2, z: 17 }; });
  }

  save() {
    this.s.log = this.s.log.slice(-HOUSE_LIMITS.log);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonFile(this.file, this.s); // temp file + rename, retried briefly while Windows holds the file
  }

  view() {
    const { floors, walls, defs, items, agents, plan, log, turns, lastTurnAt, phase, mode, events, open, undo, rev } = this.s;
    return {
      size: SIZE, palette: PALETTE, defs, items, agents, plan, log, turns, lastTurnAt, phase, mode, events: events.slice(-15),
      // Relation values stay internal; the view only says whether the owner can step into an open matter.
      open: open && { text: open.text, pair: open.pair, ask: open.ask && !open.ask.answer ? { deadline: open.ask.deadline } : null },
      undo: undo && undo.rev === rev ? { by: undo.by, text: undo.text, at: undo.at } : null,
      floors: Object.entries(floors).map(([k, c]) => [...k.split(',').map(Number), c]),
      walls: Object.entries(walls).map(([k, w]) => [...k.split(',').map(Number), w.c, !!w.door]),
    };
  }

  def(name) { return Object.hasOwn(this.s.defs, name) ? this.s.defs[name] : undefined; }
  cellsOf(item) {
    const def = this.def(item.def);
    if (!def) return [];
    const { fw, fd } = rotateParts(def.parts, item.rot);
    const out = [];
    for (let dx = 0; dx < fw; dx++) for (let dz = 0; dz < fd; dz++) out.push([item.x + dx, item.z + dz]);
    return out;
  }
  itemAt(x, z) { return this.s.items.find((it) => this.cellsOf(it).some(([cx, cz]) => cx === x && cz === z)); }
  walkable(x, z) {
    const w = this.s.walls[key(x, z)];
    return inGrid(x, z) && (!w || w.door) && !this.itemAt(x, z);
  }

  // Apply one model reply for `actor`. Returns what was done and what was refused.
  apply(actor, reply, now = Date.now()) {
    const { s } = this;
    const before = structuredClone({ floors: s.floors, walls: s.walls, defs: s.defs, items: s.items });
    const done = [], errors = [];
    this.painted = 0;
    const actions = Array.isArray(reply?.actions) ? reply.actions.slice(0, HOUSE_LIMITS.actions) : [];
    for (const a of actions) {
      try { const result = this.act(actor, a); if (result) done.push(result); } catch (e) { errors.push(e.message); }
    }
    const say = clean(reply?.say, HOUSE_LIMITS.say);
    const plan = clean(reply?.plan, HOUSE_LIMITS.plan);
    if (plan) s.plan = plan;
    const push = (entry) => { s.log.push({ ...entry, id: actor, at: now }); };
    if (done.length) { push({ kind: 'build', text: done.join(' · ').slice(0, 200) }); s.rev++; }
    if (say) push({ kind: 'say', text: say });
    s.log = s.log.slice(-HOUSE_LIMITS.log);
    s.turns++; s.lastTurnAt = now; s.lastActor = actor;
    this.save();
    return { done, errors, say, notice: this.buildNotice(before) };
  }

  // Describe net changes, not requested actions (including partial changes before an error).
  buildNotice(before) {
    const parts = [], points = [];
    const add = (label, cells) => {
      if (!cells.length) return;
      parts.push(`${label} ${cells.length}칸`);
      points.push(...cells.map((k) => k.split(',').map(Number)));
    };
    for (const [field, label] of [['floors', '바닥'], ['walls', '벽']]) {
      const old = before[field], current = this.s[field];
      add(`${label} 놓음`, Object.keys(current).filter((k) => !Object.hasOwn(old, k)));
      add(`${label} 변경`, Object.keys(current).filter((k) => Object.hasOwn(old, k)
        && (field === 'floors' ? old[k] !== current[k] : old[k].c !== current[k].c)));
      add(`${label} 지움`, Object.keys(old).filter((k) => !Object.hasOwn(current, k)));
    }
    const doors = Object.keys(this.s.walls).filter((k) => this.s.walls[k].door && !before.walls[k]?.door);
    if (doors.length) { parts.push(`문 ${doors.length}개 만듦`); points.push(...doors.map((k) => k.split(',').map(Number))); }
    for (const [items, other, label] of [[this.s.items, before.items, '배치'], [before.items, this.s.items, '치움']]) {
      for (const item of items.filter((it) => !other.some((old) => old.id === it.id))) {
        parts.push(`${item.def} ${label}`);
        const defs = label === '배치' ? this.s.defs : before.defs;
        const { fw, fd } = rotateParts(defs[item.def].parts, item.rot);
        points.push([item.x, item.z], [item.x + fw - 1, item.z + fd - 1]);
      }
    }
    const designs = Object.keys(this.s.defs).filter((name) => !isDeepStrictEqual(before.defs[name], this.s.defs[name]));
    if (designs.length) parts.push(`가구 설계 ${designs.length}개`);
    if (!parts.length) return '';
    const span = points.length ? ` (${Math.min(...points.map((p) => p[0]))},${Math.min(...points.map((p) => p[1]))}–${Math.max(...points.map((p) => p[0]))},${Math.max(...points.map((p) => p[1]))})` : '';
    return parts.join(', ') + span;
  }

  paint(n) {
    this.painted += n;
    if (this.painted > HOUSE_LIMITS.cellsPerTurn) fail(`한 턴에 칠할 수 있는 칸(${HOUSE_LIMITS.cellsPerTurn})을 넘었어요.`);
  }

  act(actor, a) {
    const { s } = this;
    switch (a?.type) {
      case 'floor': {
        const [x1, x2] = [cell(a.x1, 'x1'), cell(a.x2, 'x2')].sort((p, q) => p - q);
        const [z1, z2] = [cell(a.z1, 'z1'), cell(a.z2, 'z2')].sort((p, q) => p - q);
        const count = (x2 - x1 + 1) * (z2 - z1 + 1);
        if (count > HOUSE_LIMITS.areaCells) fail(`바닥은 한 번에 ${HOUSE_LIMITS.areaCells}칸까지예요.`);
        const color = colorOf(a.color);
        this.paint(count);
        for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) s.floors[key(x, z)] = color;
        return `바닥 ${count}칸(${color})`;
      }
      case 'wall': {
        const x1 = cell(a.x1, 'x1'), x2 = cell(a.x2, 'x2'), z1 = cell(a.z1, 'z1'), z2 = cell(a.z2, 'z2');
        if (x1 !== x2 && z1 !== z2) fail('벽은 가로 또는 세로 한 줄만 쌓을 수 있어요.');
        const color = colorOf(a.color);
        const cells = [];
        for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) cells.push([x, z]);
        if (cells.length > HOUSE_LIMITS.wallLine) fail(`벽은 한 번에 ${HOUSE_LIMITS.wallLine}칸까지예요.`);
        this.paint(cells.length);
        let n = 0;
        for (const [x, z] of cells) {
          if (this.itemAt(x, z)) continue;
          if (!s.walls[key(x, z)] && Object.keys(s.walls).length >= HOUSE_LIMITS.walls) fail('벽이 너무 많아요.');
          s.walls[key(x, z)] = { c: color, door: s.walls[key(x, z)]?.door || false }; n++;
        }
        return `벽 ${n}칸(${color})`;
      }
      case 'door': {
        const x = cell(a.x, 'x'), z = cell(a.z, 'z');
        const w = s.walls[key(x, z)] || fail('문은 이미 있는 벽 칸에만 만들 수 있어요.');
        w.door = true;
        return `문 (${x},${z})`;
      }
      case 'erase': {
        const x = cell(a.x, 'x'), z = cell(a.z, 'z');
        const item = this.itemAt(x, z);
        if (item) { s.items = s.items.filter((it) => it !== item); return `${item.def} 치움`; }
        if (s.walls[key(x, z)]) { delete s.walls[key(x, z)]; return `벽 (${x},${z}) 철거`; }
        if (s.floors[key(x, z)]) { delete s.floors[key(x, z)]; return `바닥 (${x},${z}) 걷음`; }
        fail('지울 것이 없어요.');
        return '';
      }
      case 'define': {
        const name = clean(a.name, HOUSE_LIMITS.name);
        if (!name) fail('가구 이름이 필요해요.');
        const old = this.def(name);
        if (old && old.by !== actor) fail(`"${name}"은 ${this.names[old.by] || old.by}가 이미 만들었어요. 다른 이름을 써요.`);
        if (!old && Object.keys(s.defs).length >= HOUSE_LIMITS.defs) fail('가구 설계가 너무 많아요.');
        if (!Array.isArray(a.parts) || !a.parts.length || a.parts.length > HOUSE_LIMITS.parts) fail(`부품은 1~${HOUSE_LIMITS.parts}개예요.`);
        const parts = a.parts.map((p) => {
          const q = { s: SHAPES.includes(p?.s) ? p.s : 'box', x: num(p?.x ?? 0, 0, MAX_SIDE, 'x'), y: num(p?.y ?? 0, 0, MAX_SIDE, 'y'), z: num(p?.z ?? 0, 0, MAX_SIDE, 'z'),
            w: num(p?.w, 0.1, MAX_SIDE, 'w'), h: num(p?.h, 0.1, MAX_SIDE, 'h'), d: num(p?.d, 0.1, MAX_SIDE, 'd'), c: colorOf(p?.c) };
          if (q.x + q.w > MAX_SIDE || q.z + q.d > MAX_SIDE || q.y + q.h > MAX_SIDE) fail(`가구는 ${MAX_SIDE}x${MAX_SIDE}x${MAX_SIDE} 칸 안에 들어가야 해요.`);
          return q;
        });
        s.defs[name] = { by: actor, parts, ...(USES.includes(a.use) ? { use: a.use } : {}) };
        const { fw, fd } = footprintOf(parts);
        return `가구 설계 "${name}" (${fw}x${fd}칸)`;
      }
      case 'place': {
        if (!this.def(a.def)) fail(`"${clean(a.def, 20)}" 설계가 아직 없어요.`);
        const x = cell(a.x, 'x'), z = cell(a.z, 'z');
        const rot = Number.isInteger(Number(a.rot)) ? ((Number(a.rot) % 4) + 4) % 4 : 0;
        if (s.items.length >= HOUSE_LIMITS.items) fail('가구가 너무 많아요.');
        const item = { id: s.nextId, def: String(a.def), x, z, rot, by: actor };
        for (const [cx, cz] of this.cellsOf(item)) {
          if (!inGrid(cx, cz)) fail('가구가 집 밖으로 나가요.');
          if (!s.floors[key(cx, cz)]) fail(`(${cx},${cz})에는 바닥이 없어요. 바닥이 깔린 곳에만 놓아요.`);
          if (s.walls[key(cx, cz)]) fail(`(${cx},${cz})는 벽이에요.`);
          if (this.itemAt(cx, cz)) fail(`(${cx},${cz})에는 이미 가구가 있어요.`);
        }
        s.nextId++; s.items.push(item);
        return `${a.def} 배치 (${x},${z})`;
      }
      case 'move': {
        const x = cell(a.x, 'x'), z = cell(a.z, 'z');
        if (!this.walkable(x, z)) fail('거기로는 갈 수 없어요.');
        s.agents[actor] = { x, z };
        return '';
      }
      default: return fail('알 수 없는 행동이에요.');
    }
  }

  // The text one member sees: map, furniture, plan and the latest talk.
  prompt(actor, { resumedAfterMs = 0, resting = [] } = {}) {
    const { s } = this;
    const at = (x, z) => {
      for (const [id, p] of Object.entries(s.agents)) if (p.x === x && p.z === z) return GLYPH[id] || '?';
      const w = s.walls[key(x, z)];
      if (w) return w.door ? '+' : '#';
      if (this.itemAt(x, z)) return 'F';
      return s.floors[key(x, z)] ? ',' : '.';
    };
    const header = '   ' + Array.from({ length: SIZE }, (_, x) => x % 10).join('');
    const rows = Array.from({ length: SIZE }, (_, z) => `${String(z).padStart(2)} ${Array.from({ length: SIZE }, (_, x) => at(x, z)).join('')}`);
    const defs = Object.entries(s.defs).map(([name, d]) => { const { fw, fd } = footprintOf(d.parts); return `${name}(${fw}x${fd}, ${this.names[d.by] || d.by})`; });
    const items = s.items.map((it) => `${it.def}@${it.x},${it.z}/${it.rot}`);
    const log = s.log.slice(-10).map((l) => `${this.names[l.id] || l.id}${l.kind === 'build' ? ' 작업' : ''}: ${l.text}`);
    const me = s.agents[actor];
    // Once the house is lived in: small decorating only, with the last few life events as light context.
    const life = s.phase === 'life'
      ? `\n집은 기본적으로 완성되어 지금은 다 같이 생활하는 중이다. 벽·바닥을 크게 바꾸거나 철거하지 말고, 작은 꾸미기(가구 하나 설계·배치)나 say만 한다. 바꿀 게 없으면 actions를 비워도 된다.\n최근 생활 사건:\n${s.events.slice(-3).map((e) => `- ${e.text}`).join('\n') || '(없음)'}` : '';
    const resumed = resumedAfterMs > 2 * 3600000
      ? `\n오랜만에 다시 모였다(마지막 작업 후 ${Math.round(resumedAfterMs / 3600000)}시간). say로 먼저 "지난번에 여기까지 했으니 이어서 하자"는 식으로 계획을 짚으며 말을 꺼내고, 동료와 이어서 협업한다.` : '';
    return `[집 지도]\n${header}\n${rows.join('\n')}\n내 이름: ${this.names[actor]} (${GLYPH[actor]}), 위치 (${me.x},${me.z})\n`
      + `동료: ${this.ids.filter((id) => id !== actor && !resting.includes(id)).map((id) => `${this.names[id]}(${GLYPH[id]})`).join(', ') || '(지금 없음)'}\n`
      + (resting.length ? `지금 쉬는 동료(@로 부르지 않는다): ${resting.map((id) => this.names[id]).join(', ')}\n` : '')
      + `가구 설계: ${defs.join(', ') || '없음'}\n배치(이름@x,z/회전): ${items.join(', ') || '없음'}\n`
      + `공동 계획: ${s.plan || '아직 없음 — 어떤 집을 지을지 같이 정해서 plan에 적어라.'}\n최근 기록:\n${log.join('\n') || '(없음)'}${resumed}${life}\n`
      + '이번 턴에 할 일을 JSON으로 답해라.';
  }
}

// One reply -> object (or null). Accepts a fenced or chatty reply by taking the outermost braces.
export function parseHouseReply(text = '') {
  const t = String(text);
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const o = JSON.parse(t.slice(a, b + 1)); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}
