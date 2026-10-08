// Ordinary-room execution ported from Moris-kr/ai-chatroom, abca310.
// The host supplies persistence/UI callbacks; scheduling, say/pass, actions and retry rules are upstream's.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { killAll } from './agents.mjs';
import { redact } from './auto.mjs';
import { MEMBERS, atMentions, mentions } from './members.mjs';
import { buildBrief, buildTurn, parseAction, modelLabel } from './prompt.mjs';
import { Router } from './router.mjs';
import { errorKind } from './discussion.mjs';
import { worldShotOptions } from './world-camera.mjs';

export const SPEEDS = {
  slow: { read: [8, 22], idle: [100, 220], spark: [300, 600], cooldown: 15, perMin: 6, typing: 1.3 },
  normal: { read: [4, 12], idle: [50, 120], spark: [150, 330], cooldown: 8, perMin: 10, typing: 1 },
  fast: { read: [1, 6], idle: [25, 60], spark: [70, 160], cooldown: 3, perMin: 18, typing: .6 },
};
export const WS_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; sandbox allow-scripts";
const pause = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

export class OriginalRoom {
  constructor({ ids, store, world, adapter, config, room, post, broadcast, changed, shot, clock = Date.now, random = Math.random, wait = pause }) {
    Object.assign(this, { ids, store, world, adapter, config, room, post, broadcast, changed, shot, clock, random, wait });
    this.available = adapter.available();
    this.router = new Router(config(), { clock });
    this.agents = Object.fromEntries(ids.map((id) => [id, {
      id, busy: false, status: 'idle', seen: store.state.seen?.[id] ?? store.lastId,
      wakeAt: null, reason: null, idleAt: null, idleStreak: 0, lastEnd: 0,
      fails: 0, offlineUntil: 0, lastError: '', calls: 0, callTimes: [], lastMs: 0,
      imageBusy: false, lastImageAt: 0, lastSelfBoostAt: 0, deepNow: false,
    }]));
    this.spark = { base: null, streak: 0, wait: null, lastEnd: 0, lastBy: null, who: null, quick: false };
    this.jobs = new Set();
    this.describing = new Set();
    this.descriptionControllers = new Set();
    this.suspended = false;
    this.closed = false;
    this.room.quotaRest ??= {};
  }
  rand(lo, hi) { return lo + this.random() * (hi - lo); }
  name(id) { return MEMBERS[id]?.name || (id === 'user' ? this.config().userName : id); }
  active(id) { return this.room.enabled[id] && this.available[id]; }
  presenceText() {
    return `현재 단톡방 참여 상태 (나간 멤버에게 답변을 요청하지 마):\n${this.ids.map((id) => `${this.name(id)}: ${this.active(id) ? '참여 중' : '잠깐 나감'}`).join('\n')}`;
  }
  setEnabled(id, enabled, rest = null) {
    const previous = this.room.enabled[id];
    this.room.enabled[id] = enabled;
    if (rest) this.room.quotaRest[id] = rest;
    else delete this.room.quotaRest[id];
    const a = this.agents[id];
    if (!enabled) { a.controller?.abort(); a.imageController?.abort(); a.wakeAt = null; }
    else { a.offlineUntil = 0; a.fails = 0; a.lastError = ''; }
    if (previous !== enabled) this.post({ from: 'system', kind: 'presence', by: id,
      text: `${this.name(id)}가 ${enabled ? '들어옴' : '잠깐 나감'}` });
    this.save();
  }
  restForQuota(id, source = 'error') {
    if (!this.room.enabled[id] && !this.room.quotaRest[id]) return;
    this.setEnabled(id, false, { autoResume: true, source, at: this.clock() });
  }
  syncUsage(reports) {
    for (const id of this.ids) {
      const report = reports?.[id];
      if (!report?.ok || report.restored || !Number.isFinite(report.at) || this.clock() - report.at > 5 * 60000) continue;
      const windows = (report.windows || []).filter((w) => !w.minor);
      if (!windows.length || windows.some((w) => !Number.isFinite(w.usedPct))) continue;
      if (windows.some((w) => w.usedPct >= 100)) this.restForQuota(id, 'usage');
      else if (this.room.quotaRest[id]?.autoResume && (this.room.quotaRest[id].source !== 'error' || report.at > this.room.quotaRest[id].at)) this.setEnabled(id, true);
    }
  }
  live(a) { return !this.closed && !this.suspended && this.room.running && !a.controller?.signal.aborted; }
  status(a, value) { a.status = value; this.changed(); }
  save() {
    this.store.state.seen = Object.fromEntries(this.ids.map((id) => [id, this.agents[id].seen]));
    this.changed();
  }
  start() {
    const now = this.clock();
    Object.assign(this.room, { running: true, sleeping: false, startedAt: now, lastUserAt: now });
    for (const a of Object.values(this.agents)) {
      a.offlineUntil = 0; a.fails = 0; a.idleStreak = 0;
      a.idleAt = now + this.rand(4, 25) * 1000;
    }
    const last = [...this.store.recent(60)].reverse().find((m) => m.from !== 'system');
    this.spark.quick = !last || now - last.ts > 10 * 60000;
    this.save();
  }
  async stop(sleeping = false) {
    this.room.running = false; this.room.sleeping = sleeping;
    await this.cancel();
    this.save();
  }
  async cancel() {
    for (const a of Object.values(this.agents)) { a.controller?.abort(); a.imageController?.abort(); }
    for (const controller of this.descriptionControllers) controller.abort();
    killAll();
    await Promise.allSettled([...this.jobs]);
  }
  async close() { this.closed = true; await this.cancel(); }
  isCalled(m, id) {
    if (m.from === 'system' || m.from === id) return false;
    if (this.store.byId.get(m.replyTo)?.from === id) return true;
    if (atMentions(m.text, id)) return true;
    if (m.from !== 'user') return false;
    const named = this.ids.filter((other) => mentions(m.text, other));
    if (this.ids.includes(this.store.byId.get(m.replyTo)?.from)) return false;
    return !named.length || named.includes(id);
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  sparkOn() { return this.config().spark.enabled !== false; }
  maybeSpark(now, sp) {
    if (!this.sparkOn()) return;
    const s = this.spark;
    const last = [...this.store.recent(60)].reverse().find((m) => m.from !== 'system');
    const activity = Math.max(last?.ts ?? 0, this.room.startedAt ?? 0);
    if (activity !== s.base) {
      s.base = activity; s.streak = 0; s.wait = s.quick ? this.rand(4, 25) * 1000 : null; s.quick = false;
    }
    if (s.who) {
      const a = this.agents[s.who];
      if (a.busy || a.wakeAt) return;
      s.who = null;
    }
    if (this.ids.some((id) => this.agents[id].busy || this.agents[id].wakeAt)) return;
    const cfg = this.config().spark;
    const after = Array.isArray(cfg.afterSec) ? cfg.afterSec : sp.spark;
    s.wait ??= Math.min(this.rand(...after) * cfg.backoff ** s.streak, cfg.maxWaitSec) * 1000;
    if (now < Math.max(s.base, s.lastEnd) + s.wait) return;
    const candidates = this.ids.filter((id) => this.active(id) && !this.agents[id].busy && !this.agents[id].wakeAt && now >= this.agents[id].offlineUntil);
    if (!candidates.length) return;
    const pool = candidates.length > 1 ? candidates.filter((id) => id !== s.lastBy) : candidates;
    const lastSaid = (id) => this.store.messages.findLast((m) => m.from === id)?.ts || 0;
    pool.sort((a, b) => lastSaid(a) - lastSaid(b));
    const top = pool.slice(0, 2);
    const a = this.agents[top[Math.floor(this.random() * top.length)]];
    s.who = a.id; a.wakeAt = now; a.reason = 'spark';
  }
  tick() {
    if (!this.room.running || this.suspended || this.closed) return Promise.resolve([]);
    const now = this.clock(), cfg = this.config(), sp = SPEEDS[this.room.speed] || SPEEDS.normal;
    if (this.room.autoSleepMin > 0 && now - this.room.lastUserAt > this.room.autoSleepMin * 60000) {
      this.post({ from: 'system', kind: 'sleep', text: '방장이 한동안 말이 없어서 방이 잠들었어. 말을 걸면 다시 깨어나.' });
      return this.stop(true);
    }
    let inflight = this.ids.filter((id) => this.agents[id].busy).length;
    const quietMs = now - Math.max(this.store.lastMessage()?.ts ?? 0, this.room.startedAt ?? 0);
    const bubbles = this.store.recent(60).filter((m) => this.ids.includes(m.from) && now - m.ts < 60000).length;
    this.maybeSpark(now, sp);
    const started = [];
    for (const id of this.shuffle([...this.ids])) {
      const a = this.agents[id];
      const probe = this.room.quotaRest[id]?.source === 'error' && this.available[id];
      if ((!this.active(id) && !probe) || a.busy || now < a.offlineUntil) continue;
      if (probe) {
        if (inflight >= cfg.maxInFlight) continue;
        inflight++;
        a.quotaProbe = true; a.reason = 'new';
        const job = this.runTurn(a);
        this.track(job); started.push(job);
        continue;
      }
      const fresh = this.store.after(a.seen).filter((m) => m.from !== id);
      if (!this.adapter.canSee?.(id) && fresh.some((m) => this.describing.has(m.id) && now - m.ts < 45000)) continue;
      if (fresh.length) {
        a.idleStreak = 0; a.idleAt = null;
        const urgent = fresh.some((m) => this.isCalled(m, id));
        if (!a.wakeAt || urgent && a.reason !== 'urgent') {
          a.wakeAt = now + this.rand(...(urgent ? [1, 3] : sp.read)) * 1000;
          a.reason = urgent ? 'urgent' : 'new';
        }
      } else if (!a.wakeAt && !this.sparkOn()) {
        a.idleAt ??= now + this.rand(...sp.idle) * 1000 * 1.7 ** Math.min(a.idleStreak, 5);
        if (now >= a.idleAt && quietMs > sp.idle[0] * 500) { a.wakeAt = now; a.reason = 'idle'; }
      }
      if (!a.wakeAt || now < a.wakeAt || now - a.lastEnd < sp.cooldown * 1000 || inflight >= cfg.maxInFlight) continue;
      if (a.reason !== 'urgent' && bubbles >= sp.perMin) continue;
      if (a.reason === 'idle' && this.ids.some((other) => this.agents[other].busy && this.agents[other].turnReason === 'idle')) {
        a.wakeAt = null; a.idleAt = now + 15000; continue;
      }
      inflight++;
      const job = this.runTurn(a);
      this.track(job);
      started.push(job);
    }
    return Promise.all(started);
  }
  track(job) {
    this.jobs.add(job);
    job.finally(() => this.jobs.delete(job)).catch(() => {});
    return job;
  }
  deepWait(a) { return Math.max(0, this.config().boost.selfCooldownSec * 1000 - (this.clock() - a.lastSelfBoostAt)); }
  startDeep(a, deep) {
    a.deepNow = true;
    if (deep.by === 'self') a.lastSelfBoostAt = this.clock();
    const cfg = this.config();
    this.post({ from: 'system', kind: 'deep', by: a.id, text: `⚡ 진심모드 → ${modelLabel({ ...cfg.agents[a.id], ...cfg.agents[a.id].boost })} · ${deep.reason}` });
    this.changed();
  }
  meta(a, deep) {
    const settings = this.config().agents[a.id];
    const used = deep ? { ...settings, ...settings.boost } : settings;
    return { model: used.model, effort: used.effort || '', ...(deep ? { deep: true, boostWhy: deep.reason } : {}) };
  }
  async ask(a, reason, opened, deep) {
    const cfg = this.config(), canSee = !!this.adapter.canSee?.(a.id);
    const uploads = canSee && !opened ? this.store.after(a.seen).filter((m) => m.attach?.upload && fs.existsSync(this.store.abs(m.attach.path))).slice(-3) : [];
    const images = opened?.image ? [opened.image] : uploads.map((m) => this.store.abs(m.attach.path));
    const brief = buildBrief(a.id, cfg, { deep, mode: this.room.boostMode, ids: this.ids, canSee });
    const max = (this.adapter.maxPromptChars?.(a.id) || 120000) - brief.length - 200;
    let hist = cfg.historyForPrompt, prompt;
    for (;;) {
      prompt = buildTurn(a.id, { store: this.store, cfg: { ...cfg, historyForPrompt: hist }, agent: a, reason, openFile: opened,
        presence: this.presenceText(),
        deepWait: !deep && this.router.boostOf(a.id) && this.room.boostMode === 'auto' ? this.deepWait(a) : 0,
        canSee, attached: new Set(uploads.map((m) => m.id)), world: this.world.summary(a.id, (id) => this.name(id)), now: this.clock() });
      if (prompt.length <= max || hist <= 8) break;
      hist -= 8;
    }
    if (!this.live(a)) throw new Error('cancelled');
    a.calls++; this.room.calls++;
    a.callTimes = a.callTimes.filter((at) => this.clock() - at < 3600000);
    a.callTimes.push(this.clock());
    this.changed();
    const used = deep ? { ...cfg.agents[a.id], ...cfg.agents[a.id].boost } : cfg.agents[a.id];
    a.usedSettings = { model: used.model, effort: used.effort || '' };
    const response = await this.adapter.chat(a.id, brief, prompt, { settings: used, boost: !!deep, images, webSearch: cfg.webSearch,
      signal: a.controller.signal, timeoutMs: (deep ? cfg.boost.timeoutSec : cfg.turnTimeoutSec) * 1000 });
    if (!this.live(a)) throw new Error('cancelled');
    a.lastMs = response.ms;
    if (!response.ok) throw new Error(response.detail || 'empty reply');
    if (a.quotaProbe && this.room.quotaRest[a.id]?.autoResume) this.setEnabled(a.id, true);
    const action = parseAction(response.text);
    if (!action) this.store.log(a.id, 'could not parse a JSON action');
    return action;
  }
  async askRouted(a, reason, opened, deep) {
    if (!deep) return { act: await this.ask(a, reason, opened, null), deep: null };
    try { return { act: await this.ask(a, reason, opened, deep), deep }; }
    catch (e) {
      if (!this.live(a)) throw e;
      a.deepNow = false;
      this.post({ from: 'system', kind: 'error', by: a.id, text: '진심모드 호출이 실패해서 평소 모델로 다시 답할게.' });
      return { act: await this.ask(a, reason, opened, null), deep: null };
    }
  }
  async runTurn(a) {
    const reason = a.reason;
    Object.assign(a, { busy: true, turnReason: reason, wakeAt: null, reason: null, controller: new AbortController() });
    this.status(a, 'reading');
    const snapshot = this.store.lastId;
    let spoke = false;
    this.router.cfg = this.config();
    let deep = this.room.boostMode !== 'off' && this.router.boostOf(a.id) ? this.router.decide(a.id, this.store, a.seen, this.room.boostMode) : null;
    try {
      if (deep) this.startDeep(a, deep);
      let result = await this.askRouted(a, reason, null, deep);
      let act = result.act; deep = result.deep;
      const request = act?.boost ?? act?.deep;
      if (!deep && request && this.router.boostOf(a.id) && this.room.boostMode === 'auto' && this.live(a) && !this.deepWait(a)) {
        deep = { by: 'self', reason: String(request).replace(/\s+/g, ' ').slice(0, 100) };
        const lead = Array.isArray(act.messages) ? act.messages.filter(Boolean).slice(0, 1) : [];
        if (lead.length) spoke = await this.perform(a, { action: 'say', messages: lead, reply_to: act.reply_to }, snapshot, 'urgent', this.meta(a, null));
        this.startDeep(a, deep);
        result = await this.askRouted(a, reason, null, deep); act = result.act; deep = result.deep;
      }
      if (act?.world_shot && this.live(a)) {
        const file = await this.takeShot(a, act.world_shot);
        if (file) {
          result = await this.askRouted(a, 'open', this.adapter.canSee?.(a.id) ? { rel: file, image: this.store.abs(file) }
            : { rel: file, text: '사진은 채팅에 올렸지만 너는 직접 볼 수 없어.' }, deep);
          act = result.act || act; deep = result.deep;
        }
        if (act) delete act.world_shot;
      }
      if (act?.world_look && this.live(a)) {
        result = await this.askRouted(a, 'open', { rel: '건축 월드 지도', text: this.world.look(act.world_look) }, deep);
        act = result.act || act; deep = result.deep;
        if (act) delete act.world_look;
      }
      if (act?.open && this.live(a)) {
        try {
          const file = this.store.readFile(act.open);
          const opened = !file.image ? { rel: file.rel, text: file.text.slice(0, a.id === 'gemini' ? 12000 : 40000) }
            : this.adapter.canSee?.(a.id) ? { rel: file.rel, image: this.store.abs(file.rel) }
              : { rel: file.rel, text: this.store.messages.findLast((m) => m.attach?.path === file.rel)?.attach?.desc || '직접 볼 수 없는 이미지이며 설명이 없어.' };
          result = await this.askRouted(a, 'open', opened, deep); act = result.act || act; deep = result.deep;
        } catch (e) { this.store.log(a.id, `open failed: ${e.message}`); }
      }
      if (act && this.live(a)) spoke = await this.perform(a, act, snapshot, deep ? 'urgent' : reason, this.meta(a, deep)) || spoke;
      a.fails = 0; a.lastError = '';
    } catch (e) {
      if (a.controller.signal.aborted) return;
      a.fails++; a.lastError = redact(e.message || e).slice(0, 300);
      a.offlineUntil = this.clock() + Math.min(20000 * 2 ** (a.fails - 1), 300000);
      if (errorKind(a.lastError) === 'quota') this.restForQuota(a.id);
      this.store.log(a.id, `ERROR ${a.lastError}`);
    } finally {
      if (reason === 'idle' && !spoke) a.idleStreak++;
      if (reason === 'spark') Object.assign(this.spark, { lastEnd: this.clock(), lastBy: a.id, wait: null, streak: spoke ? 0 : this.spark.streak + 1 });
      if (this.spark.who === a.id) this.spark.who = null;
      a.seen = Math.max(a.seen, snapshot);
      Object.assign(a, { lastEnd: this.clock(), idleAt: null, busy: false, deepNow: false, turnReason: null, status: 'idle', quotaProbe: false });
      this.save();
    }
  }
  async perform(a, act, snapshot, reason, meta) {
    if (!this.live(a)) return false;
    const id = a.id;
    let visible = false;
    if (act.react && Number(act.react.id) && act.react.emoji) {
      this.store.applyReaction(Number(act.react.id), id, String(act.react.emoji).slice(0, 8));
      visible = true; this.changed();
    }
    if (typeof act.note_replace === 'string' && act.note_replace.trim()) this.store.writeNote(id, act.note_replace);
    if (typeof act.note_add === 'string' && act.note_add.trim()) this.store.appendNote(id, act.note_add);
    let messages = (Array.isArray(act.messages) ? act.messages : typeof act.messages === 'string' ? [act.messages] : [])
      .map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 4).map((s) => s.slice(0, 2000));
    if (act.action === 'pass' && !act.show) messages = [];
    const movedOn = this.store.after(snapshot).filter((m) => m.from !== id && m.from !== 'system').length;
    if (messages.length && movedOn >= 3 && reason !== 'urgent') messages = [];
    let first = true;
    for (const text of messages) {
      this.status(a, 'typing');
      await this.wait(Math.min(700 + text.length * 40, 4000) * (SPEEDS[this.room.speed] || SPEEDS.normal).typing, a.controller.signal);
      if (!this.live(a)) return visible;
      this.post({ from: id, text, ...(first && this.store.byId.has(Number(act.reply_to)) ? { replyTo: Number(act.reply_to) } : {}), ...meta });
      first = false; visible = true;
    }
    if (!this.live(a)) return visible;
    for (const op of (Array.isArray(act.files) ? act.files : []).slice(0, 6)) {
      if (!op || typeof op !== 'object') continue;
      try {
        const result = this.store.applyFileOp(op, id);
        this.post({ from: 'system', kind: 'file', by: id, file: result.op === 'delete' ? undefined : result.rel, text: `${this.name(id)} → ${result.rel} ${result.op}` });
        visible = true;
      } catch (e) { this.post({ from: 'system', kind: 'error', by: id, text: e.message }); }
    }
    if (act.files) this.broadcast('ws', this.store.listFiles());
    if (act.show) {
      try {
        const file = this.store.readFile(act.show);
        this.post({ from: id, text: '', attach: { path: file.rel }, ...meta }); visible = true;
      } catch (e) { this.post({ from: 'system', kind: 'error', by: id, text: e.message }); }
    }
    for (const def of (Array.isArray(act.block_define) ? act.block_define : act.block_define ? [act.block_define] : []).slice(0, 4)) {
      try {
        const name = this.world.define(def, id);
        this.broadcast('worldblocks', this.world.custom);
        this.post({ from: 'system', kind: 'world', by: id, text: `새 블록 ${name}` }); visible = true;
      } catch (e) { this.post({ from: 'system', kind: 'error', by: id, text: e.message }); }
    }
    let moved = false;
    if (act.build) {
      const result = this.world.apply(act.build, id);
      if (result.changes.length) {
        this.broadcast('world', { by: id, changes: result.changes });
        const last = result.changes.at(-1);
        if (!act.move) moved = this.world.move(id, { x: last[0], z: last[2] + 1 });
      }
      if (result.signs) this.broadcast('signs', this.world.signs);
      if (result.changes.length || result.signs) {
        this.post({ from: 'system', kind: 'world', by: id, text: `🧱 ${this.name(id)} ${this.world.log.at(-1).text}` }); visible = true;
      }
      if (result.notes.length) this.post({ from: 'system', kind: 'error', by: id, text: result.notes.slice(0, 3).join(' / ') });
    }
    if (act.move) moved = this.world.move(id, act.move) || moved;
    if (moved) this.broadcast('avatars', this.world.avatarView());
    if (act.sticker_save && typeof act.sticker_save === 'object') {
      try {
        const file = this.saveSticker(act.sticker_save.from, act.sticker_save.to, id);
        this.post({ from: 'system', kind: 'file', by: id, file, text: `${this.name(id)} 스티커 저장: ${file}` }); visible = true;
      } catch (e) { this.post({ from: 'system', kind: 'error', by: id, text: e.message }); }
    }
    if (act.sticker) {
      const file = this.stickerPath(act.sticker);
      if (file && fs.existsSync(this.store.abs(file))) { this.post({ from: id, text: '', attach: { path: file, sticker: true }, ...meta }); visible = true; }
    }
    if (act.image && MEMBERS[id].imageGen && this.config().imageGen) {
      const value = typeof act.image === 'string' ? { prompt: act.image } : act.image;
      if (value && String(value.prompt || '').trim()) {
        this.track(this.startImage(a, { prompt: String(value.prompt).slice(0, 1200), ref: value.ref, saveAs: value.save_as })); visible = true;
      }
    }
    this.changed();
    return visible;
  }
  stickerPath(value) {
    try { const rel = this.store.safeRel(value); return rel.startsWith('stickers/') && this.store.isImage(rel) ? rel : null; }
    catch { return null; }
  }
  saveSticker(from, to, by) {
    const source = this.store.safeRel(from), target = this.stickerPath(to);
    if (!this.store.isImage(source) || !target || path.posix.extname(source).toLowerCase() !== path.posix.extname(target).toLowerCase()) throw new Error('스티커 경로와 확장자를 확인하세요.');
    const existed = fs.existsSync(this.store.abs(target));
    if (!existed && this.store.listFiles().length >= 300) throw new Error('작업공간 파일은 최대 300개입니다.');
    fs.mkdirSync(path.dirname(this.store.abs(target)), { recursive: true });
    fs.copyFileSync(this.store.abs(source), this.store.abs(target));
    this.store.touchMeta(target, by, !existed);
    this.broadcast('ws', this.store.listFiles());
    return target;
  }
  async takeShot(a, request) {
    try {
      const png = await this.shot(worldShotOptions(this.world, request), a.controller.signal);
      if (!this.live(a)) return null;
      const rel = `images/world-${a.id}-${crypto.randomUUID()}.png`;
      fs.mkdirSync(path.dirname(this.store.abs(rel)), { recursive: true });
      fs.writeFileSync(this.store.abs(rel), png); this.store.touchMeta(rel, a.id, true);
      this.post({ from: a.id, text: '', attach: { path: rel, shot: true } });
      this.broadcast('ws', this.store.listFiles()); return rel;
    } catch (e) {
      if (this.live(a)) this.post({ from: 'system', kind: 'error', by: a.id, text: `월드 사진을 찍지 못했어: ${e.message}` });
      return null;
    }
  }
  async startImage(a, request) {
    const remaining = this.config().imageCooldownSec * 1000 - (this.clock() - a.lastImageAt);
    if (a.imageBusy || remaining > 0) {
      this.post({ from: 'system', kind: 'error', by: a.id, text: a.imageBusy ? '이미 그림을 그리고 있어.' : `${Math.ceil(remaining / 1000)}초 뒤에 그림을 그릴 수 있어.` }); return;
    }
    a.imageBusy = true; a.imageController = new AbortController(); this.changed();
    this.post({ from: 'system', kind: 'drawing', by: a.id, text: `${this.name(a.id)} 그림 그리는 중` });
    try {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const who = String(request.ref || '').toLowerCase();
      const refId = this.ids.find((id) => id === who || this.name(id).toLowerCase() === who);
      const refSheet = refId ? [path.join(root, 'assets', 'sheets', `${refId}_sheet.png`),
        path.join(root, 'public', 'avatars', `${refId}.png`), path.join(root, 'public', 'avatars', `${refId}.webp`),
        path.join(root, 'public', 'avatars', `${refId}-pixel.png`)].find((file) => fs.existsSync(file)) || null : null;
      const result = await this.adapter.image(a.id, request.prompt, { signal: a.imageController.signal, refSheet });
      if (a.imageController.signal.aborted || this.closed) return;
      if (!result.ok) throw new Error(result.detail || '이미지 생성 실패');
      const rel = `images/${a.id}-${crypto.randomUUID()}${path.extname(result.file).toLowerCase() || '.png'}`;
      fs.mkdirSync(path.dirname(this.store.abs(rel)), { recursive: true });
      fs.copyFileSync(result.file, this.store.abs(rel)); this.store.touchMeta(rel, a.id, true);
      this.post({ from: a.id, text: '', attach: { path: rel, prompt: request.prompt } });
      if (request.saveAs) this.saveSticker(rel, String(request.saveAs).replace(/\.(png|jpe?g|webp|gif)$/i, '') + path.posix.extname(rel), a.id);
      this.broadcast('ws', this.store.listFiles());
    } catch (e) {
      if (!a.imageController.signal.aborted && !this.closed) this.post({ from: 'system', kind: 'error', by: a.id, text: '그림을 만들지 못했어.', detail: e.message });
    } finally { a.imageBusy = false; a.lastImageAt = this.clock(); this.changed(); }
  }
  describeUpload(message) {
    this.describing.add(message.id);
    const controller = new AbortController();
    this.descriptionControllers.add(controller);
    return this.track((async () => {
      try {
        const result = await this.adapter.describeImage(this.store.abs(message.attach.path), { signal: controller.signal });
        if (!this.closed && !controller.signal.aborted && result.ok && this.store.setAttachDesc(message.id, result.text)) this.changed();
      } catch (e) { this.store.log('describe', e.message); }
      finally { this.describing.delete(message.id); this.descriptionControllers.delete(controller); }
    })());
  }
}
