import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readJsonFile, writeJsonFile } from './atomic.mjs';

// Durable log of AI runs. Every event is something the server actually did or observed (CLI check, folder list,
// file read, an AI call starting/finishing, a result being saved); no model reasoning is invented or shown.
export const RUN_LIMITS = { runs: 120, events: 160, textChars: 300, storeBytes: 3 * 1024 * 1024 };
const STATUS = ['running', 'completed', 'failed', 'cancelled'];
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const valid = (data) => data?.version === 1 && Array.isArray(data.runs) && data.runs.every((r) => r && ID.test(r.id) && ID.test(r.projectId)
  && ID.test(r.sessionId) && STATUS.includes(r.status) && Number.isSafeInteger(r.startedAt) && Array.isArray(r.events));
const clip = (text) => String(text ?? '').slice(0, RUN_LIMITS.textChars);

export class RunLog extends EventEmitter {
  constructor(dataDir, clock = Date.now) {
    super();
    this.clock = clock;
    this.file = path.join(dataDir, 'task-runs.json');
    this.warnings = [];
    this.data = readJsonFile(this.file, { version: 1, runs: [] }, { validate: valid, onRecovery: (m) => this.warnings.push(m) });
    let changed = false;
    for (const run of this.data.runs) {
      if (run.status !== 'running') continue;
      run.status = 'failed'; run.endedAt = this.clock(); changed = true;
      run.error = '서버가 재시작되어 이전 실행이 중단되었습니다.';
      run.events.push({ at: run.endedAt, kind: 'error', text: run.error });
    }
    if (changed) this.persist(true);
    this.timer = null;
  }

  persist(now = false) {
    const write = () => {
      this.timer = null;
      try {
        let text = JSON.stringify(this.data);
        // Oldest runs go first if the file would grow too large.
        while (Buffer.byteLength(text) > RUN_LIMITS.storeBytes && this.data.runs.length > 1) { this.data.runs.shift(); text = JSON.stringify(this.data); }
        writeJsonFile(this.file, this.data);
      } catch (error) { this.warnings.push(`실행 기록을 저장하지 못했습니다: ${error.code || error.message}`); }
    };
    if (now) { clearTimeout(this.timer); write(); return; }
    this.timer ??= setTimeout(write, 750);
    this.timer.unref?.();
  }

  begin({ id, projectId, sessionId, mode, provider, request = '' }) {
    const run = { id, projectId, sessionId, mode, provider, request: clip(request), status: 'running', startedAt: this.clock(), endedAt: null,
      error: '', events: [], stats: { aiCalls: 0, folders: 0, files: 0, bytes: 0, sent: 0, received: 0 } };
    this.data.runs.push(run);
    while (this.data.runs.length > RUN_LIMITS.runs) this.data.runs.shift();
    this.persist(true);
    this.emit('run', this.view(run));
    return run;
  }

  find(id) { return this.data.runs.find((r) => r.id === id); }

  // kind: step | folder | file | ai | save | notice | error. state: active | done | failed. `key` lets a later event
  // update an earlier one in place (e.g. an AI call waiting -> finished).
  event(id, { kind, text, state = 'done', key = null, detail = {} }) {
    const run = this.find(id);
    if (!run || run.status !== 'running') return;
    const at = this.clock();
    const existing = key && run.events.find((e) => e.key === key);
    const wasDone = existing?.state === 'done';
    if (existing) Object.assign(existing, { text: clip(text), state, ...detail, updatedAt: at });
    else {
      if (run.events.length >= RUN_LIMITS.events) run.events.splice(1, 1);
      run.events.push({ at, kind, text: clip(text), state, ...(key ? { key } : {}), ...detail });
    }
    if (!existing) {
      if (kind === 'ai') run.stats.aiCalls++;
      if (kind === 'folder') run.stats.folders++;
    }
    if (kind === 'ai' && state === 'done' && !wasDone) { run.stats.sent = (run.stats.sent || 0) + (detail.sent || 0); run.stats.received = (run.stats.received || 0) + (detail.received || 0); }
    if (kind === 'file' && state === 'done' && !wasDone) { run.stats.files++; run.stats.bytes += detail.bytes || 0; }
    this.persist();
    this.emit('run', this.view(run));
  }

  finish(id, status, error = '') {
    const run = this.find(id);
    if (!run || run.status !== 'running') return;
    run.status = status; run.endedAt = this.clock(); run.error = clip(error);
    for (const event of run.events) if (event.state === 'active') event.state = status === 'completed' ? 'done' : 'failed';
    this.persist(true);
    this.emit('run', this.view(run));
  }

  view(run) { return structuredClone(run); }
  summary(run) { const { events, ...rest } = run; return structuredClone(rest); }
  forSession(projectId, sessionId, limit = 20) {
    return this.data.runs.filter((r) => r.projectId === projectId && r.sessionId === sessionId).slice(-limit).map((r) => this.view(r));
  }
  recent(limit = 40) { return this.data.runs.slice(-limit).map((r) => this.summary(r)); }
  flush() { if (this.timer) this.persist(true); }
}
