import crypto from 'node:crypto';
import { SIZE, parseBlock } from './world.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const cellKey = (at) => at.join(',');

// One owner character, controlled by one tab/device at a time. No movement calls an AI.
export class WorldPlayer {
  constructor({ world, clock, broadcast, post, nameOf, activity }) {
    Object.assign(this, { world, clock, broadcast, post, nameOf, activity });
    this.session = null;
    this.position = null;
    this.history = [];
    this.pending = [];
    this.nextNotice = 0;
  }
  solid(x, y, z) {
    if (y <= 0) return true;
    const block = this.world.blocks.get(`${x},${y},${z}`);
    return !!block && parseBlock(block).type !== 'door';
  }
  standingY(x, z, maxY) {
    for (let y = Math.min(SIZE.y - 3, maxY); y >= 0; y--) {
      if (this.solid(x, y, z) && !this.solid(x, y + 1, z) && !this.solid(x, y + 2, z)) return y;
    }
    return null;
  }
  spawn() {
    const cells = [];
    for (let x = 0; x < SIZE.x; x++) for (let z = 0; z < SIZE.z; z++) cells.push({ x, z });
    cells.sort((a, b) => Math.hypot(a.x - 24, a.z - 30) - Math.hypot(b.x - 24, b.z - 30));
    for (const { x, z } of cells) {
      const y = this.standingY(x, z, 0);
      if (y !== null) return { x, y, z };
    }
    fail('입장할 빈 땅이 없어요. 먼저 자리를 비워 주세요.', 409);
  }
  avatar() {
    if (!this.session || this.clock() >= this.expires) return null;
    return { ...this.position, y: this.position.y + 1 };
  }
  view() {
    return { active: !!this.avatar(), position: this.avatar() };
  }
  state() {
    return { ...this.view(), canUndo: this.history.length > 0 };
  }
  publish() { this.broadcast('avatars', this.world.avatarView()); }
  authorize(token) {
    if (!this.session || token !== this.session || this.clock() >= this.expires) fail('입장이 만료됐어요. 다시 입장해 주세요.', 409);
    this.expires = this.clock() + 30000;
  }
  join(token) {
    if (this.avatar()) {
      if (token !== this.session) fail('다른 창이나 기기에서 조작 중이에요. 그쪽에서 관람 모드로 바꿔 주세요.', 409);
    } else {
      this.position = this.spawn();
      this.session = crypto.randomUUID();
      this.history = [];
      this.lastMove = this.lastEdit = -Infinity;
    }
    this.expires = this.clock() + 30000;
    this.publish();
    return { token: this.session, ...this.state() };
  }
  leave(token) {
    if (token === this.session) {
      this.session = null;
      this.history = [];
      this.publish();
    }
    return { active: false };
  }
  heartbeat(token) {
    this.authorize(token);
    return this.state();
  }
  move(token, dx, dz) {
    this.authorize(token);
    if (![dx, dz].every(Number.isInteger) || Math.abs(dx) + Math.abs(dz) !== 1) fail('한 번에 한 칸씩 이동해 주세요.');
    if (this.clock() - this.lastMove < 150) fail('잠깐만요. 너무 빠르게 이동하고 있어요.', 429);
    this.lastMove = this.clock();
    const x = this.position.x + dx, z = this.position.z + dz;
    if (x < 0 || x >= SIZE.x || z < 0 || z >= SIZE.z) return { ...this.state(), blocked: true };
    const y = this.standingY(x, z, this.position.y + 1);
    if (y === null || (y > this.position.y && this.solid(this.position.x, this.position.y + 3, this.position.z)))
      return { ...this.state(), blocked: true };
    this.position = { x, y, z };
    this.activity();
    this.publish();
    return this.state();
  }
  checkEdit(token, at) {
    this.authorize(token);
    if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isInteger)
      || at[0] < 0 || at[0] >= SIZE.x || at[1] < 1 || at[1] >= SIZE.y || at[2] < 0 || at[2] >= SIZE.z)
      fail('잔디 땅은 지울 수 없고, 월드 안의 블록만 바꿀 수 있어요.');
    if (Math.hypot(at[0] - this.position.x, at[1] - (this.position.y + 1), at[2] - this.position.z) > 4)
      fail('블록에 더 가까이 가 주세요. 4칸 안에서 조작할 수 있어요.');
    if (this.clock() - this.lastEdit < 250 || this.pending.length >= 64) fail('잠깐 쉬었다가 조작해 주세요.', 429);
  }
  emit(changes) {
    const owners = Object.fromEntries(changes.map(([x, y, z]) => {
      const k = `${x},${y},${z}`;
      return [k, this.world.owners[k] || null];
    }));
    this.broadcast('world', { by: 'user', changes, owners });
    this.broadcast('signs', this.world.signs);
    this.settle();
    return { changes, owners, signs: this.world.signs, ...this.state() };
  }
  notice(op, at, owner) {
    if (!this.pending.length) this.nextNotice = Math.max(this.nextNotice, this.clock() + 1500);
    this.pending.push({ op, at, owner });
    this.lastEdit = this.clock();
    this.activity();
  }
  edit(token, op, at, block) {
    this.checkEdit(token, at);
    if (!['place', 'remove'].includes(op)) fail('놓기 또는 부수기를 선택해 주세요.');
    const k = cellKey(at), before = this.world.cell(k);
    if (op === 'remove' && !before.block && !before.sign) fail('이미 비어 있는 칸이에요.', 409);
    if (op === 'place') {
      if (before.block || before.sign) fail('빈칸에만 놓을 수 있어요.', 409);
      if (typeof block !== 'string' || !this.world.isBlock(block)) fail('재료를 선택해 주세요.');
      if (at[0] === this.position.x && at[2] === this.position.z && at[1] > this.position.y && at[1] <= this.position.y + 2)
        fail('내 캐릭터가 서 있는 칸에는 놓을 수 없어요.');
    }
    const result = this.world.apply({ op, at, block }, 'user');
    if (!result.changes.length && !result.signs) fail(result.notes[0] || '블록을 바꿀 수 없어요.');
    this.history.push({ k, at, before, revision: this.world.cell(k).revision });
    if (this.history.length > 40) this.history.shift();
    this.notice(op, at, before.owner || before.sign?.by || null);
    return this.emit(result.changes.length ? result.changes : [[...at, this.world.blocks.get(k) || null]]);
  }
  undo(token) {
    this.authorize(token);
    const entry = this.history.at(-1);
    if (!entry) fail('되돌릴 작업이 없어요.');
    this.checkEdit(token, entry.at);
    if (this.world.cell(entry.k).revision !== entry.revision) {
      this.history.pop();
      fail('다른 작업이 이 칸을 바꿔서 되돌릴 수 없어요. 그 작업은 건너뛰었어요.', 409);
    }
    const change = this.world.restoreCell(entry.k, entry.before, entry.revision);
    this.history.pop();
    // Consecutive edits on the same cell remain undoable after our own undo.
    const previous = this.history.findLast((item) => item.k === entry.k);
    if (previous && previous.revision === entry.before.revision) previous.revision = this.world.cell(entry.k).revision;
    this.notice('undo', entry.at, entry.before.owner);
    return this.emit([change]);
  }
  settle() {
    if (!this.avatar()) return;
    const { x, y, z } = this.position;
    const floor = this.standingY(x, z, y);
    const next = floor === null ? this.spawn() : { x, y: floor, z };
    if (next.x !== x || next.y !== y || next.z !== z) {
      this.position = next;
      this.publish();
    }
  }
  tick() {
    if (this.session && this.clock() >= this.expires) this.leave(this.session);
    this.settle();
    if (!this.pending.length || this.clock() < this.nextNotice) return;
    const edits = this.pending.splice(0), counts = { place: 0, remove: 0, undo: 0 }, owners = new Set();
    for (const e of edits) { counts[e.op]++; if (e.op === 'remove' && e.owner) owners.add(e.owner); }
    const actions = [counts.remove && `${counts.remove}칸 부숨`, counts.place && `${counts.place}칸 놓음`, counts.undo && `${counts.undo}번 되돌림`].filter(Boolean).join(' · ');
    const makers = owners.size ? ` · 부순 블록 제작자: ${[...owners].map(this.nameOf).join(', ')}` : '';
    this.post({ from: 'system', kind: 'world-player', by: 'user',
      text: `🎮 ${this.nameOf('user')} 월드 조작: ${actions}${makers} · 최근 위치 ${edits.slice(-6).map((e) => `(${e.at.join(',')})`).join(' ')}. 실제 사용자의 행동이며 대사는 아님.` });
    this.nextNotice = this.clock() + 10000;
  }
}
