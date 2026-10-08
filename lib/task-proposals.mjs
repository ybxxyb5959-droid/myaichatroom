import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFile, writeFileAtomic } from './atomic.mjs';
import { replaceTaskTextFile, removeTaskTemp, TASK_TEMP_NAME } from './task-folder.mjs';

export const PROPOSAL_LIMITS = { fileBytes: 32768, lines: 2000, reasonChars: 2000, count: 50, perSession: 10, storeBytes: 4 * 1024 * 1024, responseBytes: 98304 };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
const uuid = (id) => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const sourceOK = (text) => typeof text === 'string' && text.isWellFormed() && Buffer.byteLength(text) <= PROPOSAL_LIMITS.fileBytes
  && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) && lines(text).length <= PROPOSAL_LIMITS.lines;

export function validateProposalSource(file) {
  if (file.kind !== 'text' || file.size > PROPOSAL_LIMITS.fileBytes || !sourceOK(file.text) || file.hash !== hash(file.text)) {
    fail('수정안 대상은 32KB·2,000줄 이하의 UTF-8 텍스트 파일 1개여야 합니다.');
  }
}

export function parseProposal(raw, relative, before) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > PROPOSAL_LIMITS.responseBytes) fail('수정안 응답 크기가 제한을 초과했습니다.');
  let result;
  try { result = JSON.parse(raw); } catch { fail('Claude 수정안이 올바른 JSON 형식이 아닙니다.'); }
  if (!result || Array.isArray(result) || typeof result !== 'object'
    || Object.keys(result).sort().join(',') !== 'after,path,reason,version'
    || result.version !== 1) fail('수정안 형식 또는 대상 파일이 요청과 일치하지 않습니다.');
  return checkProposal(result, relative, before);
}

export function checkProposal(result, relative, before) {
  if (result.path !== relative) fail('수정안 형식 또는 대상 파일이 요청과 일치하지 않습니다.');
  if (!sourceOK(result.after)) fail('제안 내용은 32KB·2,000줄 이하의 UTF-8 텍스트여야 합니다.');
  if (typeof result.reason !== 'string' || !result.reason.trim() || result.reason.length > PROPOSAL_LIMITS.reasonChars) fail('수정 이유가 없거나 너무 깁니다.');
  if (result.after === before) fail('원본과 동일하여 변경된 내용이 없습니다.');
  return result;
}

// Exact line LCS, bounded to 2,000 lines per side (at most ~8 MB of working memory).
// Keep line endings and BOM intact; reconstructing either side from the rows is lossless.
export function proposalDiff(before, after) {
  if (!sourceOK(before) || !sourceOK(after)) fail('비교할 수정안의 크기 제한을 초과했습니다.');
  const a = lines(before), b = lines(after), width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i * width + j] = a[i] === b[j] ? 1 + table[(i + 1) * width + j + 1]
      : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const rows = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ kind: 'same', before: i + 1, after: j + 1, text: a[i] }); i++; j++;
    } else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      rows.push({ kind: 'removed', before: ++i, after: null, text: a[i - 1] }); removed++;
    } else {
      rows.push({ kind: 'added', before: null, after: ++j, text: b[j - 1] }); added++;
    }
  }
  return { rows, added, removed };
}

// applying/restoring are durable "in progress" markers written before any file change; startup resolves them.
const STATUSES = ['pending', 'approved', 'rejected', 'conflict', 'applying', 'applied', 'apply_failed', 'restoring', 'restored', 'restore_failed'];
const ACTIVE = ['applying', 'restoring'];
const HISTORY_LIMIT = 20;
const CONFIRM_MS = 5 * 60000;
const HEX = /^[0-9a-f]{64}$/;
const hashOrNull = (value) => value === null || (typeof value === 'string' && HEX.test(value));
const timeOrNull = (value) => value == null || Number.isSafeInteger(value);
const historyOK = (list) => list === undefined || (Array.isArray(list) && list.length <= HISTORY_LIMIT && list.every((h) => h
  && ['apply', 'restore'].includes(h.kind) && ['succeeded', 'failed', 'blocked'].includes(h.result) && Number.isSafeInteger(h.at)
  && typeof h.path === 'string' && hashOrNull(h.beforeHash) && hashOrNull(h.afterHash) && (h.confirmId === null || uuid(h.confirmId))
  && typeof h.message === 'string' && h.message.length <= 4000 && typeof h.recoverable === 'string' && h.recoverable.length <= 1000));
const operationOK = (p) => ACTIVE.includes(p.status)
  ? !!p.operation && p.operation.kind === (p.status === 'applying' ? 'apply' : 'restore') && uuid(p.operation.confirmId)
    && TASK_TEMP_NAME.test(p.operation.tempName) && Number.isSafeInteger(p.operation.startedAt)
  : p.operation == null;
const backupOK = (b) => b == null || (HEX.test(b.hash) && Number.isSafeInteger(b.size) && Number.isSafeInteger(b.createdAt));

function valid(data) {
  if (data?.version !== 1 || !Array.isArray(data.proposals) || data.proposals.length > PROPOSAL_LIMITS.count) return false;
  const ids = new Set();
  return data.proposals.every((p) => {
    if (!p || !uuid(p.id) || ids.has(p.id) || !uuid(p.projectId) || !uuid(p.sessionId) || !uuid(p.runId)
      || typeof p.folderPath !== 'string' || typeof p.path !== 'string' || !sourceOK(p.before) || !sourceOK(p.after)
      || (p.planId !== undefined && !uuid(p.planId)) || p.beforeHash !== hash(p.before) || p.afterHash !== hash(p.after) || p.hashAlgorithm !== 'sha256'
      || typeof p.reason !== 'string' || p.reason.length > PROPOSAL_LIMITS.reasonChars
      || !Number.isSafeInteger(p.createdAt) || !STATUSES.includes(p.status)
      || !historyOK(p.history) || !operationOK(p) || !backupOK(p.backup) || !timeOrNull(p.appliedAt) || !timeOrNull(p.restoredAt)) return false;
    ids.add(p.id); return true;
  });
}

const lineEnding = (text) => {
  const crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/\n/g) || []).length - crlf;
  return crlf && lf ? '혼합' : crlf ? 'CRLF' : lf ? 'LF' : '없음';
};
function formatNotes(before, after) {
  const bom = before.startsWith('\ufeff'), nextBom = after.startsWith('\ufeff');
  const eol = lineEnding(before), nextEol = lineEnding(after);
  return ['인코딩: UTF-8 (원본과 동일)',
    bom === nextBom ? `BOM: ${bom ? '있음' : '없음'} · 유지` : `주의: 승인된 수정안에서 BOM이 ${bom ? '제거' : '추가'}됩니다.`,
    eol === nextEol ? `줄바꿈: ${eol} · 유지` : `주의: 승인된 수정안의 줄바꿈 형식이 ${eol}에서 ${nextEol}(으)로 바뀝니다.`,
    '파일 권한: 기존 파일의 권한 모드(읽기 전용 여부 포함)를 그대로 적용합니다.'];
}
const FORBIDDEN_KEYS = ['path', 'folderPath', 'after', 'before', 'content', 'text', 'file', 'files', 'target', 'backup', 'hash'];

export class ProposalStore {
  constructor(store) {
    this.store = store;
    this.file = path.join(path.dirname(store.file), 'task-proposals.json');
    this.warnings = [];
    this.data = readJsonFile(this.file, { version: 1, proposals: [] }, { validate: valid, onRecovery: (message) => this.warnings.push(message) });
    this.backupDir = path.join(path.dirname(store.file), 'task-backups');
    // Single-use final-confirmation tickets. Memory only: a restart always requires confirming again.
    this.confirmations = new Map();
    this.recoverInterrupted();
  }
  scope(projectId, sessionId) {
    const project = this.store.data.projects.find((p) => p.id === projectId);
    if (!project?.sessions.some((s) => s.id === sessionId)) fail('프로젝트의 세션을 찾을 수 없습니다.', 404);
    return project;
  }
  capacity(projectId, sessionId, add = 1) {
    this.scope(projectId, sessionId);
    if (this.data.proposals.length + add > PROPOSAL_LIMITS.count
      || this.data.proposals.filter((p) => p.projectId === projectId && p.sessionId === sessionId).length + add > PROPOSAL_LIMITS.perSession) {
      fail('수정안 보관 한도(전체 50개·세션당 10개)에 도달했습니다. 기존 수정안은 자동 삭제하지 않습니다.');
    }
  }
  summaries() {
    return this.data.proposals.map(({ id, projectId, sessionId, path, createdAt, status, reason, planId }) => ({ id, projectId, sessionId, path, createdAt, status, reason, ...(planId ? { planId } : {}) }));
  }
  commit(next) {
    if (Buffer.byteLength(JSON.stringify(next)) > PROPOSAL_LIMITS.storeBytes) fail('수정안 저장 용량(4MB)을 초과했습니다.');
    writeJsonFile(this.file, next);
    this.data = next;
  }
  originalConflict(proposal) {
    const project = this.scope(proposal.projectId, proposal.sessionId);
    if (project.folderPath !== proposal.folderPath) return '프로젝트의 연결 폴더가 변경되거나 해제되었습니다.';
    try {
      const source = this.store.files({ action: 'read', projectId: proposal.projectId, path: proposal.path });
      if (source.kind !== 'text' || source.hash !== proposal.beforeHash) return '원본 파일 내용이 변경되었습니다. 새 수정안을 생성하세요.';
    } catch (error) { return `원본을 확인할 수 없습니다: ${error.message}`; }
    return '';
  }
  create({ projectId, sessionId, runId, folderPath, source }, raw) {
    this.capacity(projectId, sessionId);
    validateProposalSource(source);
    const parsed = parseProposal(raw, source.path, source.text);
    const proposal = this.buildProposal({ projectId, sessionId, runId, folderPath }, source, parsed);
    const next = structuredClone(this.data);
    next.proposals.push(proposal);
    this.commit(next);
    return structuredClone(proposal);
  }
  locate(body) {
    this.scope(body.projectId, body.sessionId);
    const proposal = this.data.proposals.find((p) => p.id === body.id && p.projectId === body.projectId && p.sessionId === body.sessionId);
    if (!proposal) fail('이 세션의 수정안을 찾을 수 없습니다.', 404);
    return proposal;
  }
  recheck(body) {
    let proposal = this.locate(body);
    // Plan members are judged through their plan's batch record once a multi-file job exists.
    if (proposal.planId && this.planHooks?.hasBatch(proposal.planId)) return proposal;
    if (['pending', 'approved'].includes(proposal.status)) {
      const reason = this.originalConflict(proposal);
      if (reason) {
        const next = structuredClone(this.data);
        proposal = next.proposals.find((p) => p.id === proposal.id);
        proposal.status = 'conflict'; proposal.conflictReason = reason;
        this.commit(next);
      }
    }
    return proposal;
  }
  get(body) {
    return this.view(this.recheck(body));
  }
  // Hash of the file now on disk, only through the project's current link and the read-only path policy.
  currentHash(proposal) {
    const project = this.scope(proposal.projectId, proposal.sessionId);
    if (project.folderPath !== proposal.folderPath) fail('프로젝트의 연결 폴더가 변경되거나 해제되었습니다.', 409);
    const file = this.store.files({ action: 'read', projectId: proposal.projectId, path: proposal.path });
    if (file.kind !== 'text') fail(file.reason || '대상 파일을 텍스트로 확인할 수 없습니다.', 409);
    return file.hash;
  }
  fileState(proposal) {
    if (!['applied', 'apply_failed', 'restored', 'restore_failed'].includes(proposal.status)) return null;
    try {
      const current = this.currentHash(proposal);
      return current === proposal.afterHash ? 'after' : current === proposal.beforeHash ? 'before' : 'changed';
    } catch { return 'unavailable'; }
  }
  view(proposal) {
    return { ...structuredClone(proposal), history: structuredClone(proposal.history || []),
      diff: proposalDiff(proposal.before, proposal.after), fileState: this.fileState(proposal) };
  }
  mutate(id, change) {
    const next = structuredClone(this.data);
    const target = next.proposals.find((p) => p.id === id);
    change(target);
    this.commit(next);
    return target;
  }
  record(target, entry) {
    target.history = [...(target.history || []), { at: this.store.clock(), path: target.path, ...entry }].slice(-HISTORY_LIMIT);
  }
  // Persist an outcome; if that write fails the durable applying/restoring marker remains for startup recovery.
  finish(id, status, entry, change = () => {}) {
    try {
      return this.mutate(id, (target) => { target.status = status; target.operation = null; change(target); this.record(target, entry); });
    } catch {
      fail(`${entry.message} 단, 결과 기록을 저장하지 못했습니다. 서버를 다시 시작하면 실제 파일 상태를 확인해 기록을 정리합니다.`, 500);
    }
  }
  sameTarget(a, b) {
    const key = (p) => `${p.folderPath}\0${process.platform === 'win32' ? p.path.toLowerCase() : p.path}`;
    return key(a) === key(b);
  }
  ensureTargetFree(proposal) {
    if (this.planHooks?.targetBusy(proposal.folderPath, proposal.path)) fail('같은 파일에 여러 파일 적용·복구 작업이 진행 중이거나 정리되지 않았습니다.', 409);
    if (this.data.proposals.some((p) => p.id !== proposal.id && ACTIVE.includes(p.status) && this.sameTarget(p, proposal))) {
      fail('같은 파일에 다른 적용·복구 작업이 진행 중입니다. 완료된 뒤 다시 시도하세요.', 409);
    }
  }
  issue(kind, proposal) {
    const now = this.store.clock();
    for (const [id, ticket] of this.confirmations) if (ticket.expiresAt < now) this.confirmations.delete(id);
    if (this.confirmations.size >= 100) fail('확인 대기 중인 요청이 너무 많습니다. 잠시 후 다시 시도하세요.', 429);
    const confirmId = randomUUID();
    this.confirmations.set(confirmId, { kind, id: proposal.id, status: proposal.status, expiresAt: now + CONFIRM_MS });
    return { confirmId, expiresAt: now + CONFIRM_MS };
  }
  take(kind, proposal, confirmId) {
    if (!uuid(confirmId)) fail('실제 파일을 변경하려면 최종 확인 절차가 필요합니다.');
    const ticket = this.confirmations.get(confirmId);
    this.confirmations.delete(confirmId);
    if (!ticket || ticket.kind !== kind || ticket.id !== proposal.id || ticket.status !== proposal.status || ticket.expiresAt < this.store.clock()) {
      fail('최종 확인이 만료되었거나 이미 사용되었거나 수정안 상태가 바뀌었습니다. 다시 확인하세요.', 409);
    }
  }
  // A resent request with an already-processed confirmation returns the recorded result instead of writing again.
  replay(kind, proposal, confirmId) {
    if (!uuid(confirmId)) return null;
    if (proposal.operation?.confirmId === confirmId) fail('이 요청은 이미 처리 중입니다.', 409);
    const done = (proposal.history || []).findLast((h) => h.kind === kind && h.confirmId === confirmId);
    return done ? { ...this.view(proposal), outcome: done, replayed: true } : null;
  }
  backupFile(proposal) { return path.join(this.backupDir, proposal.projectId, `${proposal.id}.bak`); }
  writeBackup(proposal, bytes) {
    const file = this.backupFile(proposal);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, bytes);
      if (!fs.readFileSync(file).equals(bytes)) throw new Error('저장된 백업 내용이 원본과 다릅니다.');
    } catch (error) {
      fail(`원본 백업을 저장하지 못해 실제 파일 수정을 진행하지 않았습니다. (${error.code || error.message})`, 500);
    }
    return { hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, createdAt: this.store.clock() };
  }
  readBackup(proposal) {
    let bytes;
    try { bytes = fs.readFileSync(this.backupFile(proposal)); } catch { fail('백업 파일을 찾을 수 없어 복구할 수 없습니다.', 409); }
    if (createHash('sha256').update(bytes).digest('hex') !== proposal.beforeHash) fail('백업 파일이 손상되어 복구할 수 없습니다.', 409);
    return bytes;
  }
  // Multi-file work proposals are review/approve only in this stage; real writes stay single-file proposals.
  noPlanApply(proposal) {
    if (proposal.planId) fail('여러 파일 작업의 수정안은 개별 적용·복구할 수 없습니다. 작업 계획의 전체 적용·전체 변경 복구를 사용하세요.', 409);
  }
  // Statuses of a plan's member proposals after a multi-file apply/restore (single commit, idempotent).
  setPlanStatuses(ids, status, backups, at) {
    const next = structuredClone(this.data);
    let changed = false;
    for (const id of ids) {
      const target = next.proposals.find((p) => p.id === id);
      if (!target || target.status === status) continue;
      target.status = status; target.operation = null;
      if (status === 'applied') { target.appliedAt = at ?? this.store.clock(); if (backups?.get(id)) target.backup = backups.get(id); }
      if (status === 'restored') { target.restoredAt = at ?? this.store.clock(); if (backups?.get(id)) target.backup = backups.get(id); }
      changed = true;
    }
    if (changed) this.commit(next);
  }
  buildProposal({ projectId, sessionId, runId, folderPath, planId }, source, parsed) {
    const proposal = { id: randomUUID(), projectId, sessionId, runId, folderPath, path: source.path,
      before: source.text, after: parsed.after, reason: parsed.reason, beforeHash: source.hash, afterHash: hash(parsed.after),
      hashAlgorithm: 'sha256', createdAt: this.store.clock(), decidedAt: null, status: 'pending', conflictReason: '' };
    if (planId) proposal.planId = planId;
    proposal.conflictReason = this.originalConflict(proposal);
    if (proposal.conflictReason) proposal.status = 'conflict';
    return proposal;
  }
  // Several already-validated file proposals of one work plan, committed together.
  createMany(context, items) {
    this.capacity(context.projectId, context.sessionId, items.length);
    const next = structuredClone(this.data);
    const created = items.map(({ source, parsed }) => {
      validateProposalSource(source);
      const proposal = this.buildProposal(context, source, parsed);
      next.proposals.push(proposal);
      return proposal;
    });
    this.commit(next);
    return created.map((p) => structuredClone(p));
  }
  decideMany(scope, ids, decision) {
    if (!['approved', 'rejected'].includes(decision)) fail('승인 또는 거절만 선택할 수 있습니다.');
    const items = ids.map((id) => decision === 'approved' ? this.recheck({ ...scope, id }) : this.locate({ ...scope, id }));
    for (const p of items) {
      if (decision === 'approved' && p.status === 'conflict') fail('원본 충돌이 있어 전체 승인을 차단했습니다. 어떤 파일도 승인되지 않았습니다.', 409);
      if (!(decision === 'approved' ? ['pending', 'approved'] : ['pending', 'approved', 'conflict']).includes(p.status)) fail('이미 결정되었거나 처리할 수 없는 수정안이 있습니다.', 409);
    }
    const next = structuredClone(this.data), now = this.store.clock();
    for (const p of items) {
      const target = next.proposals.find((item) => item.id === p.id);
      if (target.status !== decision) { target.status = decision; target.decidedAt = now; }
    }
    this.commit(next);
  }
  prepareApply(body) {
    const proposal = this.recheck(body);
    this.noPlanApply(proposal);
    if (proposal.status === 'conflict') fail(`원본 충돌로 적용할 수 없습니다. ${proposal.conflictReason}`, 409);
    if (proposal.status === 'apply_failed') {
      const current = this.currentHash(proposal);
      if (current === proposal.afterHash) fail('파일에 이미 수정안 내용이 반영되어 있습니다. 필요하면 이전 버전으로 복구하세요.', 409);
      if (current !== proposal.beforeHash) fail('원본 파일이 수정안 생성 당시와 달라 다시 적용할 수 없습니다.', 409);
    } else if (proposal.status !== 'approved') {
      fail(proposal.status === 'pending' ? '먼저 수정안을 승인하세요.' : '승인된 수정안만 실제 파일에 적용할 수 있습니다.', 409);
    }
    this.ensureTargetFree(proposal);
    const view = this.view(proposal);
    return { ...view, confirmation: { kind: 'apply', ...this.issue('apply', proposal), path: proposal.path,
      folderName: path.basename(proposal.folderPath), added: view.diff.added, removed: view.diff.removed,
      beforeHash: proposal.beforeHash, afterHash: proposal.afterHash, beforeBytes: Buffer.byteLength(proposal.before),
      afterBytes: Buffer.byteLength(proposal.after), notes: formatNotes(proposal.before, proposal.after) } };
  }
  apply(body) {
    let proposal = this.locate(body);
    this.noPlanApply(proposal);
    const replayed = this.replay('apply', proposal, body.confirmId);
    if (replayed) return replayed;
    this.take('apply', proposal, body.confirmId);
    // Re-verify the stored approval and the original's hash; nothing has been written yet.
    proposal = this.recheck(body);
    if (proposal.status === 'conflict') fail(`원본 충돌로 적용을 중단했습니다. ${proposal.conflictReason}`, 409);
    if (!['approved', 'apply_failed'].includes(proposal.status)) fail('승인된 수정안만 실제 파일에 적용할 수 있습니다.', 409);
    if (this.scope(proposal.projectId, proposal.sessionId).folderPath !== proposal.folderPath) fail('프로젝트의 연결 폴더가 변경되었습니다.', 409);
    this.ensureTargetFree(proposal);
    const previous = proposal.status, confirmId = body.confirmId, tempName = `.chatroom-${randomUUID()}.tmp`;
    this.mutate(proposal.id, (target) => {
      target.status = 'applying';
      target.operation = { kind: 'apply', confirmId, tempName, startedAt: this.store.clock() };
    });
    let backup = null, result;
    try {
      result = replaceTaskTextFile(proposal.folderPath, proposal.path, { expectedHash: proposal.beforeHash,
        content: Buffer.from(proposal.after, 'utf8'), tempName, beforeWrite: (bytes) => { backup = this.writeBackup(proposal, bytes); } });
    } catch (error) {
      let actual = null;
      try { actual = this.currentHash(proposal); } catch { /* recorded as unknown */ }
      const status = error.conflict && !error.replaced ? (previous === 'approved' ? 'conflict' : previous) : 'apply_failed';
      this.finish(proposal.id, status, { kind: 'apply', result: error.conflict ? 'blocked' : 'failed', confirmId,
        beforeHash: proposal.beforeHash, afterHash: actual, message: error.message,
        recoverable: error.replaced ? '파일이 교체되었지만 검증에 실패했습니다. 원본 백업이 보존되어 있어 이전 버전으로 복구할 수 있습니다.'
          : '실제 파일은 변경되지 않았습니다.' }, (target) => {
        if (backup) target.backup = backup;
        if (status === 'conflict') target.conflictReason = error.message;
      });
      throw error;
    }
    const outcome = { kind: 'apply', result: 'succeeded', confirmId, beforeHash: result.previousHash, afterHash: result.hash,
      message: `적용 완료 · 검증: ${result.checks.join(', ')}`, recoverable: '원본이 백업되어 있어 이전 버전으로 복구할 수 있습니다.' };
    const saved = this.finish(proposal.id, 'applied', outcome, (target) => { target.backup = backup; target.appliedAt = this.store.clock(); });
    return { ...this.view(saved), outcome: saved.history.at(-1), size: result.size };
  }
  restorable(proposal) {
    if (!['applied', 'apply_failed', 'restore_failed'].includes(proposal.status)) fail('적용된 수정안만 이전 버전으로 복구할 수 있습니다.', 409);
    if (!proposal.backup) fail('이 수정안에는 원본 백업이 없어 복구할 수 없습니다.', 409);
    const bytes = this.readBackup(proposal);
    const current = this.currentHash(proposal);
    if (current === proposal.beforeHash) fail('파일이 이미 이전 버전과 같습니다.', 409);
    if (current !== proposal.afterHash) fail('적용 이후 파일이 다시 변경되어 자동 덮어쓰기를 차단했습니다. 현재 파일을 직접 확인하세요.', 409);
    this.ensureTargetFree(proposal);
    return bytes;
  }
  prepareRestore(body) {
    const proposal = this.locate(body);
    this.noPlanApply(proposal);
    this.restorable(proposal);
    return { ...this.view(proposal), confirmation: { kind: 'restore', ...this.issue('restore', proposal), path: proposal.path,
      folderName: path.basename(proposal.folderPath), appliedAt: proposal.appliedAt ?? null,
      currentHash: proposal.afterHash, restoredHash: proposal.beforeHash, backupBytes: proposal.backup.size } };
  }
  restore(body) {
    const proposal = this.locate(body);
    this.noPlanApply(proposal);
    const replayed = this.replay('restore', proposal, body.confirmId);
    if (replayed) return replayed;
    this.take('restore', proposal, body.confirmId);
    const confirmId = body.confirmId;
    let bytes;
    try { bytes = this.restorable(proposal); } catch (error) {
      if (ACTIVE.includes(proposal.status)) throw error;
      let actual = null;
      try { actual = this.currentHash(proposal); } catch { /* recorded as unknown */ }
      this.finish(proposal.id, proposal.status, { kind: 'restore', result: 'blocked', confirmId, beforeHash: actual, afterHash: actual,
        message: error.message, recoverable: '현재 파일은 변경하지 않았습니다. 백업은 보존되어 있습니다.' });
      throw error;
    }
    const tempName = `.chatroom-${randomUUID()}.tmp`;
    this.mutate(proposal.id, (target) => {
      target.status = 'restoring';
      target.operation = { kind: 'restore', confirmId, tempName, startedAt: this.store.clock() };
    });
    let result;
    try {
      result = replaceTaskTextFile(proposal.folderPath, proposal.path, { expectedHash: proposal.afterHash, content: bytes, tempName });
      if (result.hash !== proposal.beforeHash) fail('복구 후 해시가 원본과 일치하지 않습니다.', 500);
    } catch (error) {
      let actual = null;
      try { actual = this.currentHash(proposal); } catch { /* recorded as unknown */ }
      this.finish(proposal.id, 'restore_failed', { kind: 'restore', result: error.conflict ? 'blocked' : 'failed', confirmId,
        beforeHash: proposal.afterHash, afterHash: actual, message: error.message,
        recoverable: error.replaced ? '파일이 교체되었지만 검증에 실패했습니다. 현재 파일을 확인하세요. 백업은 보존되어 있습니다.'
          : '현재 파일은 변경되지 않았습니다. 백업이 보존되어 있어 다시 복구할 수 있습니다.' });
      throw error;
    }
    const saved = this.finish(proposal.id, 'restored', { kind: 'restore', result: 'succeeded', confirmId, beforeHash: result.previousHash,
      afterHash: result.hash, message: `복구 완료 · 원본 SHA-256과 일치 · 검증: ${result.checks.join(', ')}`,
      recoverable: '백업은 기록 보존을 위해 그대로 유지됩니다.' }, (target) => { target.restoredAt = this.store.clock(); });
    return { ...this.view(saved), outcome: saved.history.at(-1) };
  }
  // A restart during a write leaves applying/restoring. Decide from the bytes on disk; never write project files here.
  recoverInterrupted() {
    if (!this.data.proposals.some((p) => ACTIVE.includes(p.status))) return;
    const next = structuredClone(this.data);
    for (const target of next.proposals.filter((p) => ACTIVE.includes(p.status))) {
      const { kind, confirmId, tempName } = target.operation, apply = kind === 'apply';
      let current = null, note = '';
      try {
        current = this.currentHash(target);
        removeTaskTemp(target.folderPath, target.path, tempName);
      } catch (error) { note = ` (${error.message})`; }
      if (apply && !target.backup) {
        try {
          const bytes = fs.readFileSync(this.backupFile(target));
          if (createHash('sha256').update(bytes).digest('hex') === target.beforeHash) {
            target.backup = { hash: target.beforeHash, size: bytes.length, createdAt: Math.trunc(fs.statSync(this.backupFile(target)).mtimeMs) };
          }
        } catch { /* no usable backup was written before the interruption */ }
      }
      let status, result = 'failed', message, recoverable;
      if (apply && current === target.afterHash) {
        status = 'apply_failed';
        message = '서버 재시작으로 적용 검증이 중단되었습니다. 파일 내용은 수정안과 일치(SHA-256)하지만 전체 검증을 마치지 못해 적용 완료로 처리하지 않았습니다.';
        recoverable = target.backup ? '원본 백업이 있어 이전 버전으로 복구할 수 있습니다.' : '원본 백업을 확인하지 못해 자동 복구할 수 없습니다.';
      } else if (apply && current === target.beforeHash) {
        status = 'apply_failed';
        message = '서버 재시작으로 적용이 중단되었습니다.';
        recoverable = '원본 파일은 변경되지 않았습니다. 다시 적용할 수 있습니다.';
      } else if (!apply && current === target.beforeHash) {
        status = 'restored'; result = 'succeeded'; target.restoredAt = this.store.clock();
        message = '서버 재시작 후 확인: 파일이 원본 SHA-256과 일치하여 복구 완료로 처리했습니다.';
        recoverable = '백업은 기록 보존을 위해 그대로 유지됩니다.';
      } else if (!apply && current === target.afterHash) {
        status = 'restore_failed';
        message = '서버 재시작으로 복구가 중단되었습니다.';
        recoverable = '파일은 적용된 상태 그대로입니다. 백업이 보존되어 있어 다시 복구할 수 있습니다.';
      } else {
        status = apply ? 'apply_failed' : 'restore_failed';
        message = `서버 재시작으로 작업이 중단되었고 파일이 예상과 다른 상태이거나 확인할 수 없습니다${note}.`;
        recoverable = '자동으로 덮어쓰지 않습니다. 현재 파일을 직접 확인하세요. 백업은 보존되어 있습니다.';
      }
      target.status = status; target.operation = null;
      this.record(target, { kind, result, confirmId, beforeHash: null, afterHash: current, message, recoverable });
    }
    try { this.commit(next); } catch {
      this.warnings.push('중단된 적용·복구 작업의 정리 결과를 저장하지 못했습니다. 저장 공간·권한을 확인한 뒤 서버를 다시 시작하세요.');
    }
  }
  decide(body) {
    if (!['approved', 'rejected'].includes(body.decision)) fail('승인 또는 거절만 선택할 수 있습니다.');
    const proposal = body.decision === 'approved' ? this.recheck(body) : this.locate(body);
    if (body.decision === 'approved' && proposal.status === 'conflict') fail('원본 충돌로 승인을 차단했습니다.', 409);
    if (!['pending', 'conflict'].includes(proposal.status)) fail('이미 결정된 수정안입니다.', 409);
    const next = structuredClone(this.data);
    const target = next.proposals.find((p) => p.id === proposal.id);
    target.status = body.decision; target.decidedAt = this.store.clock();
    this.commit(next);
    return this.view(target);
  }
  // All file writes run synchronously inside one request, so no two applies/restores interleave in this process.
  handle(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('올바른 수정안 요청이 아닙니다.');
    if (FORBIDDEN_KEYS.some((key) => Object.hasOwn(body, key))) fail('수정할 파일 경로나 내용은 요청으로 지정할 수 없습니다. 저장된 수정안만 적용합니다.');
    if (body.action === 'get') return this.get(body);
    if (body.action === 'decide') return this.decide(body);
    if (body.action === 'apply.prepare') return this.prepareApply(body);
    if (body.action === 'apply') return this.apply(body);
    if (body.action === 'restore.prepare') return this.prepareRestore(body);
    if (body.action === 'restore') return this.restore(body);
    fail('지원하지 않는 수정안 요청입니다.');
  }
}
