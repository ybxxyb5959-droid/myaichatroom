// Reconnect the retained house without replacing the ordinary chat engine or its prompts.
import path from 'node:path';
import { House, HOUSE_BRIEF, HOUSE_LIMITS, parseHouseReply } from './house.mjs';
import { playerView, playerAction } from './house-player.mjs';
import { enterLife, isComplete, lifeBeat, lifeEvent, drift, snapshot, markUndo, noteEvent,
  decide, undo, setMode, LIFE_PACE, EVENT_GAP } from './life.mjs';
import { prepareHouseData } from './original-migration.mjs';
import { dayKey, redact } from './auto.mjs';
import { mentions } from './members.mjs';

const MIN = 60000;
const PACE = { low: { gap: [30 * MIN, 60 * MIN], daily: 3 },
  medium: { gap: [8 * MIN, 15 * MIN], daily: 12 }, high: { gap: [30000, 30000], daily: 100 } };

export class HouseRuntime {
  constructor({ root, ids, store, runtime, config, post, broadcast, activity, nameOf, clock, random }) {
    Object.assign(this, { ids, store, runtime, config, post, broadcast, activity, nameOf, clock, random });
    prepareHouseData(store);
    this.names = Object.fromEntries(ids.map((id) => [id, nameOf(id)]));
    this.house = new House(path.join(root, 'data', 'house.json'), { ids, names: this.names });
    this.level = PACE[config().house?.level] ? config().house.level : 'medium';
    this.buildAt = clock() + MIN; this.beatAt = clock() + MIN; this.eventAt = clock() + 15 * MIN;
    this.strollAt = clock() + 15000;
    this.job = null; this.nextActor = null;
  }
  eligible() {
    return this.ids.filter((id) => this.runtime.active(id) && this.clock() >= this.runtime.agents[id].offlineUntil);
  }
  running() { return this.runtime.room.running && !this.runtime.room.sleeping && !this.runtime.suspended && !this.runtime.closed; }
  between([lo, hi]) { return lo + this.random() * (hi - lo); }
  changed() { this.broadcast('house', {}); }
  view() {
    return { ...this.house.view(), player: playerView(this.house), names: this.names, userName: this.nameOf('user'),
      talk: this.running(), level: this.level, nextAt: this.buildAt, busy: !!this.job };
  }
  observe(message) {
    if (message.guestId || message.kind === 'house-say' || !message.text || ![...this.ids, 'user'].includes(message.from)) return;
    this.house.s.log.push({ kind: 'say', id: message.from, text: message.text.slice(0, 200), at: message.ts });
    this.house.save(); this.changed();
  }
  record(event) {
    if (!event) return;
    this.activity.add({ kind: 'house', actors: event.actors, text: event.text, ref: { houseEvent: event.id } });
    this.post({ from: 'system', kind: 'house-event', text: event.text,
      houseEvent: { id: event.id, actors: event.actors, tone: event.tone } });
  }
  startLife() {
    if (this.house.s.phase === 'life' || !isComplete(this.house)) return false;
    enterLife(this.house, this.clock());
    this.record(noteEvent(this.house, { type: 'complete', actors: this.ids, text: '기본 집 완성 · 생활 시작' }, this.clock()));
    this.house.save(); this.changed();
    return true;
  }
  lifeTick() {
    const ids = this.eligible(), now = this.clock(), h = this.house;
    if (!this.running() || !ids.length) return;
    this.startLife();
    if (h.s.phase !== 'life') {
      if (now < this.strollAt) return;
      this.strollAt = now + 15000;
      if (ids.filter((id) => id !== this.job?.actor).map((id) => h.wander(id, this.random)).some(Boolean)) {
        h.save(); this.changed();
      }
      return;
    }
    let changed = false;
    for (const id of this.ids) {
      const a = this.runtime.agents[id], actor = h.s.agents[id];
      const mode = !this.runtime.active(id) ? 'off' : a.busy ? 'work' : 'free';
      if (actor.mirror === mode) continue;
      lifeBeat(h, id, { mode, names: this.names, now, rand: this.random });
      actor.mirror = mode; changed = true;
    }
    if (now >= this.beatAt) {
      const free = ids.filter((id) => !this.runtime.agents[id].busy);
      const pool = free.length > 1 ? free.filter((id) => id !== h.s.lastLife) : free;
      if (pool.length) {
        const id = pool[Math.floor(this.random() * pool.length)];
        lifeBeat(h, id, { names: this.names, now, rand: this.random });
        h.s.lastLife = id; changed = true;
      }
      this.beatAt = now + this.between(LIFE_PACE[this.level]);
    }
    if (now >= this.eventAt) {
      const event = lifeEvent(h, { ids, names: this.names, rand: this.random, now });
      this.record(event); changed ||= !!event;
      this.eventAt = now + EVENT_GAP[this.level] * (h.s.open ? .5 : 1) * this.between([.7, 1.3]);
    }
    changed = drift(h, dayKey(now)) || changed;
    if (changed) { h.save(); this.changed(); }
  }
  tick() {
    this.lifeTick();
    const r = this.runtime, now = this.clock();
    if (!this.running() || this.job || now < this.buildAt) return Promise.resolve();
    const cfg = this.config(), count = Object.values(r.agents).filter((a) => a.busy || a.imageBusy).length;
    if (count >= cfg.maxInFlight) return Promise.resolve();
    const ids = this.eligible().filter((id) => !r.agents[id].busy && !r.agents[id].imageBusy && !r.agents[id].wakeAt);
    if (!ids.length) return Promise.resolve();
    const day = dayKey(now);
    const usage = this.store.state.houseUsage?.day === day ? this.store.state.houseUsage : { day, calls: 0 };
    if (usage.calls >= PACE[this.level].daily) return Promise.resolve();
    const id = ids.includes(this.nextActor) ? this.nextActor : ids[(ids.indexOf(this.house.s.lastActor) + 1) % ids.length];
    this.nextActor = null;
    const a = r.agents[id], controller = new AbortController();
    this.job = { actor: id, controller };
    a.busy = true; a.controller = controller; a.status = 'building';
    usage.calls++; this.store.state.houseUsage = usage; r.room.calls++;
    this.buildAt = now + this.between(PACE[this.level].gap) * (this.house.s.phase === 'life' ? 2 : 1);
    r.changed(); this.changed();
    const done = this.build(id, controller).finally(() => {
      a.busy = false; a.controller = null; a.status = 'idle';
      this.job = null; r.changed(); this.changed();
    });
    this.job.done = done;
    r.track(done); // OFF, discussion and shutdown abort and await the same job registry.
    return done;
  }
  async build(id, controller) {
    const cfg = this.config(), h = this.house;
    const before = h.s.phase === 'life' ? snapshot(h) : null;
    try {
      const response = await this.runtime.adapter.chat(id, HOUSE_BRIEF,
        h.prompt(id, { resumedAfterMs: h.s.lastTurnAt ? this.clock() - h.s.lastTurnAt : 0,
          resting: this.ids.filter((other) => !this.eligible().includes(other)) }),
        { settings: cfg.agents[id], independent: true, webSearch: false, signal: controller.signal, timeoutMs: cfg.turnTimeoutSec * 1000 });
      if (controller.signal.aborted || !this.running()) return;
      const reply = response.ok ? parseHouseReply(response.text) : null;
      if (!reply) throw new Error(response.detail || 'AI가 집 작업 JSON을 반환하지 않았습니다.');
      const turn = h.apply(id, reply, this.clock());
      const summary = turn.done.join(' · ').slice(0, 160);
      if (before && summary) {
        markUndo(h, before, id, `${this.nameOf(id)}: ${summary}`, this.clock());
        this.record(noteEvent(h, { type: 'decorate', actors: [id], text: `${this.nameOf(id)} 집 꾸미기: ${summary}` }, this.clock()));
        h.save();
      }
      if (turn.notice) this.post({ from: 'system', kind: 'house-build', by: id, text: turn.notice });
      if (turn.say) {
        this.nextActor = this.eligible().find((other) => other !== id && mentions(turn.say, other)) || null;
        const last = this.store.messages.findLast((m) => m.kind === 'house-say');
        this.post({ from: id, kind: 'house-say', text: turn.say,
          ...(last && last.from !== id && this.clock() - last.ts < 10 * MIN ? { replyTo: last.id } : {}) });
      }
      if (summary) this.activity.add({ kind: 'house', actors: [id], text: `${this.nameOf(id)} 집 작업: ${summary}` });
      if (turn.errors.length) this.store.log('house', turn.errors.join(' / '));
      this.startLife();
    } catch (error) {
      if (!controller.signal.aborted) this.store.log('house', redact(error.message));
    }
  }
  action(action, body) {
    const h = this.house, now = this.clock();
    if (action === 'player') playerAction(h, body, this.names, now);
    else if (action === 'mode') setMode(h, body.mode);
    else if (action === 'decide') {
      decide(h, body.choice, body.note, body.eventId ?? null);
      this.record(lifeEvent(h, { ids: this.eligible(), names: this.names, rand: this.random, now }));
    } else if (action === 'undo') {
      const result = undo(h, now);
      this.record(noteEvent(h, { type: 'undo', actors: ['user'], text: `방장이 집 변경을 되돌림: ${result.text}` }, now));
    } else throw Object.assign(new Error('지원하지 않는 집 기능입니다.'), { status: 404 });
    h.s.log = h.s.log.slice(-HOUSE_LIMITS.log); h.save(); this.changed();
    return this.view();
  }
}
