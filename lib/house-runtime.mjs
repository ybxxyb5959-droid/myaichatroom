// Reconnect the retained house without replacing the ordinary chat engine or its prompts.
import path from 'node:path';
import { House, HOUSE_BRIEF, HOUSE_LIMITS, SIZE, parseHouseReply } from './house.mjs';
import { playerView, playerAction } from './house-player.mjs';
import { enterLife, isComplete, lifeBeat, lifeEvent, drift, snapshot, markUndo, noteEvent,
  decide, undo, setMode, LIFE_PACE, EVENT_GAP } from './life.mjs';
import { prepareHouseData } from './original-migration.mjs';
import { dayKey, redact } from './auto.mjs';
import { mentions } from './members.mjs';
import { acceptProposal, advanceVotes, settleVote, votePrompt } from './house-votes.mjs';
import { rectangleCells } from './house-project.mjs';

const MIN = 60000;

export class HouseRuntime {
  constructor({ root, ids, store, runtime, config, post, broadcast, activity, nameOf, clock, random }) {
    Object.assign(this, { ids, store, runtime, config, post, broadcast, activity, nameOf, clock, random });
    prepareHouseData(store);
    this.names = Object.fromEntries(ids.map((id) => [id, nameOf(id)]));
    this.house = new House(path.join(root, 'data', 'house.json'), { ids, names: this.names });
    if (!this.house.s.planning) {
      this.house.s.planning = { design: null, pending: null, nextId: 1, feedback: '',
        previousPlan: this.house.s.plan, legacyComplete: isComplete(this.house) };
      // Persist with the next actual house change, not merely on startup.
    }
    this.level = LIFE_PACE[config().house?.level] ? config().house.level : 'medium';
    this.buildAt = clock(); this.beatAt = clock() + MIN; this.eventAt = clock() + 15 * MIN;
    this.failures = 0;
    this.strollAt = clock() + 15000;
    this.job = null; this.nextActor = null;
    const crew = this.house.s.crew;
    if (crew.members === null) {
      crew.members = this.present();
      if (crew.members.length === 1) crew.soloActor = crew.members[0];
    }
  }
  present() { return this.ids.filter(id => this.runtime.active(id)); }
  eligible() {
    return this.ids.filter((id) => this.runtime.active(id) && this.clock() >= this.runtime.agents[id].offlineUntil);
  }
  running() { return this.runtime.room.running && !this.runtime.room.sleeping && !this.runtime.suspended && !this.runtime.closed; }
  between([lo, hi]) { return lo + this.random() * (hi - lo); }
  changed() { this.broadcast('house', {}); }
  syncCrew() {
    const h = this.house, crew = h.s.crew, members = this.present(), previous = crew.members;
    const before = JSON.stringify(crew);
    const entering = members.filter(id => !previous.includes(id));
    if (entering.length) playerView(h);
    for (const id of previous) if (!members.includes(id) && this.job?.actor === id) this.job.controller.abort();
    for (const id of entering) h.spawnMember(id, members, this.random);
    crew.members = members;
    if (members.length === 1 && crew.soloActor !== members[0]) {
      crew.soloActor = members[0]; crew.turns = 0; crew.waiting = false; crew.override = false;
      this.nextActor = members[0]; this.buildAt = this.clock();
    }
    const returning = this.eligible().find(id => id !== crew.soloActor);
    if (crew.waiting && returning) {
      crew.waiting = false; crew.turns = 0; crew.override = false;
      this.nextActor = returning; this.buildAt = this.clock();
    }
    if (members.length > 1 && !crew.waiting) {
      crew.soloActor = null; crew.turns = 0; crew.override = false;
    }
    if (members.length === 1 && !crew.override && !this.job
      && (crew.turns >= 2 || !h.s.planning?.design)) {
      crew.waiting = true;
      if (!crew.handoff?.pending) this.saveHandoff(members[0]);
    }
    if (entering.length || JSON.stringify(crew) !== before) { h.save(); this.changed(); }
  }
  saveHandoff(id, reply = null, turn = null) {
    const h = this.house, progress = h.view(this.present()).progress;
    const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 300) : '';
    const log = h.s.log.findLast(entry => entry.kind === 'build');
    const at = h.s.agents[id], proposed = reply?.handoff;
    const validLocation = Number.isInteger(proposed?.x) && Number.isInteger(proposed?.z)
      && proposed.x >= 0 && proposed.z >= 0 && proposed.x < SIZE && proposed.z < SIZE;
    h.s.crew.handoff = {
      by: id, at: this.clock(), pending: true,
      completed: turn?.done.length ? turn.done.join(' · ').slice(0, 300) : log?.text || '아직 완료한 건축 작업이 없습니다.',
      remaining: text(proposed?.remaining) || (progress?.stage === 'planning' ? '현재 집을 바탕으로 공동 설계부터 검토'
        : (progress?.rooms || []).map(r => `${r.name}: 바닥 ${r.floor}/${r.floorTotal}, 가구 ${r.count}/${r.min}`).join(' · ').slice(0, 300)),
      next: text(proposed?.next) || '저장된 집과 현재 참가자를 확인하고 미완료 목표를 이어서 진행',
      location: validLocation ? { x: proposed.x, z: proposed.z } : { x: at.x, z: at.z },
      source: text(proposed?.next) ? 'ai' : 'saved-state',
    };
  }
  finishingActions(id, actions) {
    const h = this.house, design = h.s.planning?.design;
    if (!design || !Array.isArray(actions)) return [];
    const list = actions.slice(0, HOUSE_LIMITS.actions);
    const first = list.find(a => ['floor', 'wall', 'door', 'define', 'place', 'relocate'].includes(a?.type));
    if (!first) return list.filter(a => a?.type === 'move').slice(0, 1);
    const chosen = first.type === 'define'
      ? [first, list.find(a => a?.type === 'place' && a.def === first.name)].filter(Boolean) : [first];
    if (first.type === 'define' && (chosen.length !== 2 || h.def(first.name))) return [];
    const copy = Object.create(Object.getPrototypeOf(h));
    Object.assign(copy, h, { s: structuredClone(h.s), painted: 0 });
    try { for (const a of chosen) copy.act(id, a); } catch { return []; }
    const key = (x, z) => `${x},${z}`;
    const floor = new Set([...design.rooms, ...design.corridors].flatMap(rectangleCells).map(p => key(...p)));
    const walls = new Set(design.walls.flatMap(([x1, z1, x2, z2]) => rectangleCells({ x1, z1, x2, z2 })).map(p => key(...p)));
    const doors = new Set(design.doors.map(p => key(...p)));
    if (Object.entries(copy.s.floors).some(([k, c]) => h.s.floors[k] !== c && !floor.has(k))) return [];
    if (Object.entries(copy.s.walls).some(([k, w]) => JSON.stringify(h.s.walls[k]) !== JSON.stringify(w)
      && (!walls.has(k) || (w.door && !h.s.walls[k]?.door && !doors.has(k))))) return [];
    if (copy.s.items.some(item => {
      const before = h.s.items.find(old => old.id === item.id);
      if (JSON.stringify(before) === JSON.stringify(item)) return false;
      return !design.rooms.some(room => copy.cellsOf(item).every(([x, z]) => x >= room.x1 && x <= room.x2 && z >= room.z1 && z <= room.z2));
    })) return [];
    return chosen;
  }
  view() {
    const present = this.present(), base = this.house.view(this.eligible()), crew = this.house.s.crew;
    return { ...base, agents: Object.fromEntries(Object.entries(base.agents).filter(([id]) => present.includes(id))),
      player: playerView(this.house), names: this.names, userName: this.nameOf('user'),
      talk: this.running(), level: this.level, nextAt: this.buildAt, busy: !!this.job, workingActor: this.job?.actor || null,
      buildLimit: null, crew: { waiting: crew.waiting, soloActor: crew.soloActor,
        remaining: Math.max(0, 2 - crew.turns), override: crew.override, handoff: crew.handoff } };
  }
  observe(message) {
    if (message.guestId || message.kind === 'house-say' || !message.text || ![...this.ids, 'user'].includes(message.from)) return;
    this.house.s.log.push({ kind: 'say', id: message.from, text: message.text.slice(0, 200), at: message.ts,
      source: message.from === 'user' ? 'user' : 'ai', speechId: `chat-${message.id}` });
    this.house.save(); this.changed();
  }
  record(event) {
    if (!event) return;
    this.activity.add({ kind: 'house', actors: event.actors, text: event.text, ref: { houseEvent: event.id } });
    this.post({ from: 'system', kind: 'house-event', text: event.text,
      houseEvent: { id: event.id, actors: event.actors, tone: event.tone } });
  }
  startLife() {
    const retainedCompletion = this.house.s.planning?.legacyComplete && !this.house.s.planning.design;
    if (this.house.s.phase === 'life' || (!retainedCompletion && !isComplete(this.house))) return false;
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
    this.syncCrew();
    if (this.running() && !this.job && advanceVotes(this.house, this.clock())) this.changed();
    this.lifeTick();
    const r = this.runtime, now = this.clock();
    if (!this.running() || this.job || this.house.s.crew.waiting || now < this.buildAt) return Promise.resolve();
    const cfg = this.config(), count = Object.values(r.agents).filter((a) => a.busy || a.imageBusy).length;
    if (count >= cfg.maxInFlight) return Promise.resolve();
    let ids = this.eligible().filter((id) => !r.agents[id].busy && !r.agents[id].imageBusy && !r.agents[id].wakeAt);
    const pending = this.house.s.planning?.pending;
    if (pending && this.eligible().length > 1) ids = ids.filter(id => id !== pending.by);
    if (!ids.length) return Promise.resolve();
    const day = dayKey(now);
    const usage = this.store.state.houseUsage?.day === day ? this.store.state.houseUsage : { day, calls: 0 };
    const id = ids.includes(this.nextActor) ? this.nextActor : ids[(ids.indexOf(this.house.s.lastActor) + 1) % ids.length];
    this.nextActor = null;
    const a = r.agents[id], controller = new AbortController();
    const solo = this.present().length === 1 && !this.house.s.crew.override;
    if (solo) { this.house.s.crew.turns++; this.house.save(); }
    this.job = { actor: id, controller, solo };
    a.busy = true; a.controller = controller; a.status = 'building';
    usage.calls++; this.store.state.houseUsage = usage; r.room.calls++;
    this.buildAt = now; // Sequential work while Talk is on; usage is accounting, not a quota.
    r.changed(); this.changed();
    const done = this.build(id, controller, solo).finally(() => {
      a.busy = false; a.controller = null; a.status = 'idle';
      this.job = null; this.syncCrew(); r.changed(); this.changed();
    });
    this.job.done = done;
    r.track(done); // OFF, discussion and shutdown abort and await the same job registry.
    return done;
  }
  async build(id, controller, solo = false) {
    const cfg = this.config(), h = this.house;
    const before = h.s.phase === 'life' ? snapshot(h) : null;
    const revision = h.s.rev;
    const participants = this.eligible();
    const handoff = h.s.crew.handoff;
    const context = (handoff?.pending ? `\n[저장된 작업 인계]\n${JSON.stringify(handoff)}\n현재 집에서 완료 여부를 확인하고 이미 끝난 작업은 반복하지 않는다.\n` : '')
      + (solo ? `\n[혼자 마무리하는 턴 ${h.s.crew.turns}/2]\n새 설계·새 방·철거를 시작하지 않는다. 승인된 목표 안에서 가구 1개 또는 벽·바닥·문 한 구간만 마무리하고, 이번 응답에 "handoff":{"remaining":"남은 일","next":"다음 작은 작업","x":작업좌표,"z":작업좌표}를 함께 적는다. 이 응답 이후 동료 복귀를 기다릴 수 있다. 완료한 일은 서버가 실제 적용 결과로 기록한다.\n` : '');
    try {
      const response = await this.runtime.adapter.chat(id, HOUSE_BRIEF,
        h.prompt(id, { resumedAfterMs: h.s.lastTurnAt ? this.clock() - h.s.lastTurnAt : 0,
          resting: this.ids.filter((other) => !participants.includes(other)) }) + votePrompt(h) + context,
        { settings: cfg.agents[id], independent: true, webSearch: false, signal: controller.signal, timeoutMs: cfg.turnTimeoutSec * 1000 });
      if (controller.signal.aborted || !this.running()) return;
      const reply = response.ok ? parseHouseReply(response.text) : null;
      if (!reply) throw new Error(response.detail || 'AI가 집 작업 JSON을 반환하지 않았습니다.');
      if (h.s.rev !== revision) return; // A user's vote/undo won while this call was in flight.
      if (JSON.stringify(participants) !== JSON.stringify(this.eligible())) return; // Do not publish a handoff based on a stale roster.
      const work = solo ? { say: reply.say, plan: reply.plan, actions: this.finishingActions(id, reply.actions) } : reply;
      const turn = h.apply(id, work, this.clock(), participants);
      if (solo) { this.saveHandoff(id, reply, turn); h.save(); }
      else if (handoff?.pending) { handoff.pending = false; handoff.resumedBy = id; handoff.resumedAt = this.clock(); h.save(); }
      this.failures = 0;
      try { if (!solo && acceptProposal(h, id, reply, this.clock())) h.save(); }
      catch (error) { this.store.log('house', redact(error.message)); }
      const summary = turn.done.join(' · ').slice(0, 160);
      if (before && (summary || turn.planChanged)) {
        markUndo(h, before, id, `${this.nameOf(id)}: ${summary || '공동 계획 변경'}`, this.clock());
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
      if (h.s.planning?.pending) this.nextActor = participants.find(other => other !== h.s.planning.pending.by) || null;
      if (summary) this.activity.add({ kind: 'house', actors: [id], text: `${this.nameOf(id)} 집 작업: ${summary}` });
      if (turn.errors.length) this.store.log('house', turn.errors.join(' / '));
      this.startLife();
    } catch (error) {
      if (!controller.signal.aborted) {
        this.buildAt = this.clock() + Math.min(20000 * 2 ** Math.min(this.failures++, 4), 300000);
        this.store.log('house', redact(error.message));
      }
    }
  }
  action(action, body) {
    const h = this.house, now = this.clock();
    this.syncCrew();
    if (action === 'continue-solo') {
      if (this.present().length !== 1) throw new Error('참가 AI가 한 명일 때만 혼자 계속할 수 있어요.');
      h.s.crew.waiting = false; h.s.crew.override = true;
      this.nextActor = this.present()[0]; this.buildAt = now;
    } else if (action === 'player') playerAction(h, body, this.names, now, this.present());
    else if (action === 'vote') settleVote(h, body.voteId, body.choice, now);
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
