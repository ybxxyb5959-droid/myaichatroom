// One shared timeline of what the AI members did: chat answers, Talk rounds, workbench tasks, house turns,
// creations and a few room events. Each entry is a one-line summary plus a ref to the original record —
// never a copy of chat text or file contents. The log is capped by count and age, so it never grows forever.
// Later features (house life, photos, games, notes, a "what did the AIs do today" summary) reuse it.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFile, readJsonFile } from './atomic.mjs';

export const ACTIVITY_MAX = 500;
export const ACTIVITY_DAYS = 30;
export const ACTIVITY_KINDS = ['chat', 'talk', 'task', 'house', 'creation', 'game', 'note', 'system'];
const TEXT_CHARS = 160;
const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
// A short topic from a longer text (a user's question, a task title) for the one-line summary.
export const topicOf = (text, max = 30) => {
  const t = clean(text, 400);
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

export class ActivityLog {
  constructor(file, { clock = Date.now, max = ACTIVITY_MAX, days = ACTIVITY_DAYS } = {}) {
    this.file = file; this.clock = clock; this.max = max; this.days = days;
    this.warnings = [];
    const saved = readJsonFile(file, { entries: [], nextId: 1 }, {
      validate: (v) => v && Array.isArray(v.entries) && v.entries.every((e) => e && Number.isFinite(e.at) && Array.isArray(e.actors)),
      onRecovery: (message) => this.warnings.push(message),
    });
    this.entries = saved.entries;
    this.nextId = Number(saved.nextId) || (this.entries.at(-1)?.id || 0) + 1;
    this.prune();
  }
  prune() {
    const oldest = this.clock() - this.days * 86400000;
    this.entries = this.entries.filter((e) => e.at >= oldest).slice(-this.max);
  }
  // { kind, actors, text, ref } -> the stored entry. No AI call is ever needed to add one.
  add({ kind, actors = [], text, ref = null }) {
    if (!ACTIVITY_KINDS.includes(kind)) throw new Error(`알 수 없는 활동 종류: ${kind}`);
    const entry = { id: this.nextId++, at: this.clock(), kind, actors: [...new Set(actors.filter((a) => typeof a === 'string'))], text: clean(text, TEXT_CHARS), ref };
    this.entries.push(entry);
    this.prune();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonFile(this.file, { nextId: this.nextId, entries: this.entries });
    return entry;
  }
  // Newest first, optionally for one member, one kind or since a time.
  list({ actor, kind, since = 0, limit = 50 } = {}) {
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (e.at < since) break;
      if ((!actor || e.actors.includes(actor)) && (!kind || e.kind === kind)) out.push(e);
    }
    return out;
  }
}
