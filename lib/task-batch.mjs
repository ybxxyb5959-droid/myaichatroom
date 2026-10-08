import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireLock } from './task-safety.mjs';
import { stageTaskTextFile, commitStagedTaskFile, discardStagedTaskFile, inspectTaskTextFile, removeTaskTemp } from './task-folder.mjs';

// Multi-file apply / restore of one approved work plan. File systems cannot swap several files atomically, so the
// durable plan.batch record is written before any project change and updated before and after every swap.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HISTORY_LIMIT = 20;
// Unresolved batches keep their backups and block other writes to the same files.
export const UNRESOLVED = ['applying', 'restoring', 'partial', 'manual', 'restore_failed'];
const RESTORABLE = ['applied', 'partial', 'manual', 'restore_failed'];

// Cross-process guard around the write phase (see task-safety). A lock left by a dead process or an abandoned
// one older than ten minutes is taken over; a live second server is refused.
const acquireWriteLock = (file) => acquireLock(file, { maxAgeMs: 10 * 60000,
  busy: '다른 서버 프로세스가 같은 작업 데이터에서 파일을 쓰는 중입니다. 하나의 서버만 사용하세요.' }).release;

export class PlanBatch {
  constructor(plans) {
    this.plans = plans; this.proposals = plans.proposals; this.store = plans.store;
    this.lockFile = path.join(path.dirname(plans.file), 'task-write.lock');
    this.faultHook = null; // test-only fault injection point; never set by the server
  }
  now() { return this.store.clock(); }
  members(plan) { return plan.files.map((f) => this.proposals.data.proposals.find((p) => p.id === f.proposalId)); }
  hashOf(plan, relative) {
    try {
      const file = this.store.files({ action: 'read', projectId: plan.projectId, path: relative });
      return file.kind === 'text' ? file.hash : null;
    } catch { return null; }
  }
  // Whether another plan's unresolved batch or an active single-file change owns this file.
  targetBusy(plan, relative) {
    const key = (folder, p) => `${folder}\0${process.platform === 'win32' ? p.toLowerCase() : p}`;
    const mine = key(plan.folderPath, relative);
    if (this.proposals.data.proposals.some((p) => ['applying', 'restoring'].includes(p.status) && key(p.folderPath, p.path) === mine)) return true;
    return this.plans.data.plans.some((other) => other.id !== plan.id && UNRESOLVED.includes(other.batch?.status)
      && other.batch.files.some((f) => key(other.folderPath, f.path) === mine));
  }
  record(plan, entry) {
    plan.history = [...(plan.history || []), { at: this.now(), ...entry }].slice(-HISTORY_LIMIT);
  }
  save(plan) {
    const next = structuredClone(this.plans.data);
    next.plans[next.plans.findIndex((p) => p.id === plan.id)] = structuredClone(plan);
    this.plans.commit(next);
  }
  // Entries of a folder that legitimately change while this job works: its own temp files and every folder/file
  // name along its targets (a parent folder's timestamp moves when a nested file is replaced).
  ignoreNames(batch) {
    return batch.files.flatMap((f) => [f.tempName, f.restoreTemp, ...f.path.split('/')].filter(Boolean));
  }
  summaryOf(plan) {
    return plan.batch.files.map((f) => ({ path: f.path, state: f.state, beforeHash: f.beforeHash, afterHash: f.afterHash }));
  }

  // ---- verification (read-only) ----
  verifyApply(plan) {
    const blockers = [];
    const project = this.proposals.scope(plan.projectId, plan.sessionId);
    if (project.folderPath !== plan.folderPath) return ['프로젝트의 연결 폴더가 변경되거나 해제되었습니다.'];
    if (!plan.files.length) return ['수정 대상 파일이 없는 계획입니다.'];
    if (plan.batch && plan.batch.status !== 'apply_failed') {
      return [plan.batch.status === 'applied' ? '이미 적용된 계획입니다. 필요하면 전체 변경 복구를 사용하세요.'
        : `이전 적용·복구 작업이 정리되지 않았습니다(${plan.batch.status}). 먼저 상태를 확인하거나 전체 변경 복구를 하세요.`];
    }
    const members = this.members(plan);
    plan.files.forEach((f, i) => {
      const member = members[i];
      if (f.error) return blockers.push(`${f.path}: 수정안 생성에 실패한 파일이 있습니다.`);
      if (!member || member.planId !== plan.id || member.projectId !== plan.projectId || member.sessionId !== plan.sessionId) {
        return blockers.push(`${f.path}: 이 계획의 수정안을 찾을 수 없습니다.`);
      }
      if (member.status !== 'approved') return blockers.push(`${f.path}: 승인되지 않았습니다(${member.status}).`);
      if (member.folderPath !== plan.folderPath) return blockers.push(`${f.path}: 수정안의 프로젝트 폴더가 다릅니다.`);
      if (sha(Buffer.from(member.after, 'utf8')) !== member.afterHash || sha(Buffer.from(member.before, 'utf8')) !== member.beforeHash) {
        return blockers.push(`${f.path}: 저장된 수정안의 무결성 검증에 실패했습니다.`);
      }
      try {
        const current = inspectTaskTextFile(plan.folderPath, f.path);
        if (current.hash !== member.beforeHash) blockers.push(`${f.path}: 원본 파일이 수정안 생성 이후 변경되었습니다.`);
      } catch (error) { blockers.push(`${f.path}: ${error.message}`); }
      if (this.targetBusy(plan, f.path)) blockers.push(`${f.path}: 같은 파일에 다른 적용·복구 작업이 진행 중이거나 정리되지 않았습니다.`);
    });
    return blockers;
  }
  backupBytes(member) {
    let bytes;
    try { bytes = fs.readFileSync(this.proposals.backupFile(member)); } catch { return null; }
    return sha(bytes) === member.beforeHash ? bytes : null;
  }
  verifyRestore(plan) {
    const blockers = [];
    const project = this.proposals.scope(plan.projectId, plan.sessionId);
    if (project.folderPath !== plan.folderPath) return ['프로젝트의 연결 폴더가 변경되거나 해제되었습니다.'];
    if (!RESTORABLE.includes(plan.batch?.status)) return ['복구할 수 있는 적용 기록이 없습니다.'];
    const members = this.members(plan);
    let reverts = 0;
    plan.batch.files.forEach((f, i) => {
      const member = members[i];
      if (!member || member.id !== f.proposalId) return blockers.push(`${f.path}: 수정안 기록을 찾을 수 없습니다.`);
      if (!this.backupBytes(member)) return blockers.push(`${f.path}: 백업을 찾을 수 없거나 손상되어 복구할 수 없습니다.`);
      const current = this.hashOf(plan, f.path);
      if (current === f.afterHash) {
        reverts++;
        try { inspectTaskTextFile(plan.folderPath, f.path); } catch (error) { blockers.push(`${f.path}: ${error.message}`); }
      } else if (current !== f.beforeHash) blockers.push(`${f.path}: 적용 이후 외부에서 변경되었거나 확인할 수 없어 전체 복구를 차단했습니다.`);
      if (this.targetBusy(plan, f.path)) blockers.push(`${f.path}: 같은 파일에 다른 작업이 진행 중이거나 정리되지 않았습니다.`);
    });
    if (!blockers.length && !reverts) blockers.push('모든 파일이 이미 원본 내용과 같아 복구할 변경이 없습니다.');
    return blockers;
  }

  // ---- prepare (single-use confirmation; nothing is written) ----
  prepareApply(plan) {
    const blockers = this.verifyApply(plan);
    if (blockers.length) fail(`전체 적용을 할 수 없습니다.\n${blockers.join('\n')}`, 409);
    const members = this.members(plan);
    const files = plan.files.map((f, i) => {
      const diff = this.proposals.view(members[i]).diff;
      return { path: f.path, added: diff.added, removed: diff.removed, beforeBytes: Buffer.byteLength(members[i].before),
        afterBytes: Buffer.byteLength(members[i].after), beforeHash: members[i].beforeHash, afterHash: members[i].afterHash };
    });
    return { kind: 'plan.apply', ...this.proposals.issue('plan.apply', { id: plan.id, status: plan.batch?.status || 'ready' }),
      folderName: path.basename(plan.folderPath), goal: plan.goal, files,
      notes: ['여러 파일 교체는 하나의 원자적 작업이 아닙니다. 모든 백업·임시 파일 검증이 끝난 뒤에만 교체하며, 중간 실패 시 변경된 파일을 백업으로 되돌립니다.',
        '외부에서 바뀐 파일은 덮어쓰지 않고 수동 확인이 필요한 상태로 남깁니다.'] };
  }
  prepareRestore(plan) {
    const blockers = this.verifyRestore(plan);
    if (blockers.length) fail(`전체 변경 복구를 할 수 없습니다.\n${blockers.join('\n')}`, 409);
    const files = plan.batch.files.map((f) => ({ path: f.path, currentHash: this.hashOf(plan, f.path), restoredHash: f.beforeHash,
      changed: this.hashOf(plan, f.path) === f.afterHash }));
    return { kind: 'plan.restore', ...this.proposals.issue('plan.restore', { id: plan.id, status: plan.batch.status }),
      folderName: path.basename(plan.folderPath), goal: plan.goal, files,
      notes: ['현재 파일과 적용 후 SHA-256이 모두 일치하는 경우에만 백업으로 되돌립니다.', '외부 변경이 하나라도 있으면 전체 복구를 차단하고 파일을 건드리지 않습니다.'] };
  }

  // ---- apply ----
  apply(plan, confirmId) {
    const replay = (plan.history || []).findLast((h) => h.kind === 'apply' && h.confirmId === confirmId);
    if (replay) return { replayed: true, outcome: replay };
    if (plan.batch?.confirmId === confirmId && plan.batch.status === 'applying') fail('이 요청은 이미 처리 중입니다.', 409);
    this.proposals.take('plan.apply', { id: plan.id, status: plan.batch?.status || 'ready' }, confirmId);
    const blockers = this.verifyApply(plan);
    if (blockers.length) {
      this.record(plan, { kind: 'apply', result: 'blocked', confirmId, message: `적용 전 검증 실패: ${blockers.join(' / ')}`, files: [] });
      try { this.save(plan); } catch { /* the error below is still returned */ }
      fail(`전체 적용을 중단했습니다. 어떤 파일도 수정하지 않았습니다.\n${blockers.join('\n')}`, 409);
    }
    const release = acquireWriteLock(this.lockFile);
    try { return this.runApply(plan, confirmId); } finally { release(); }
  }
  runApply(plan, confirmId) {
    const members = this.members(plan);
    plan.batch = { id: randomUUID(), kind: 'apply', status: 'applying', confirmId, startedAt: this.now(), message: '',
      files: plan.files.map((f, i) => ({ proposalId: members[i].id, path: f.path, beforeHash: members[i].beforeHash, afterHash: members[i].afterHash,
        state: 'queued', tempName: `.chatroom-${randomUUID()}.tmp`, backup: null })) };
    this.save(plan); // durable "in progress" record exists before any project change
    const batch = plan.batch, staged = [], root = plan.folderPath;
    const ignoreNames = this.ignoreNames(batch);
    const abortClean = (message, status = 500) => {
      for (const s of staged) if (s) discardStagedTaskFile(s);
      batch.status = 'apply_failed'; batch.finishedAt = this.now(); batch.message = `${message} 실제 파일은 변경되지 않았습니다.`;
      this.record(plan, { kind: 'apply', result: 'failed', confirmId, message: batch.message, files: this.summaryOf(plan) });
      this.save(plan);
      fail(batch.message, status);
    };
    try {
      // 1. every backup is written and re-read before anything else happens
      batch.files.forEach((f, i) => {
        const bytes = inspectTaskTextFile(root, f.path).bytes;
        if (sha(bytes) !== f.beforeHash) fail(`${f.path}: 백업 직전에 원본이 변경되었습니다.`, 409);
        f.backup = this.proposals.writeBackup(members[i], bytes);
        if (f.backup.hash !== f.beforeHash || !this.backupBytes(members[i])) fail(`${f.path}: 백업 검증에 실패했습니다.`, 500);
        f.state = 'backed_up';
      });
      this.save(plan);
      // 2. every temp file is prepared and verified before the first swap
      batch.files.forEach((f, i) => {
        staged[i] = stageTaskTextFile(root, f.path, { expectedHash: f.beforeHash, content: Buffer.from(members[i].after, 'utf8'), tempName: f.tempName });
        f.state = 'staged';
      });
      this.save(plan);
    } catch (error) { abortClean(`백업 또는 임시 파일 준비에 실패하여 중단했습니다. (${error.message})`, error.status || 500); }
    // 3. swap one by one; a durable marker precedes each swap
    let failure = null;
    for (let i = 0; i < batch.files.length && !failure; i++) {
      const f = batch.files[i];
      try {
        f.state = 'replacing'; this.save(plan);
        this.faultHook?.('commit', i);
        const result = commitStagedTaskFile(staged[i], { ignoreNames });
        staged[i] = null;
        f.state = 'applied'; f.appliedHash = result.hash;
        this.save(plan);
      } catch (error) { failure = { file: f, error }; }
    }
    if (!failure) {
      batch.status = 'applied'; batch.finishedAt = this.now(); batch.message = `${batch.files.length}개 파일을 적용하고 해시를 검증했습니다.`;
      this.record(plan, { kind: 'apply', result: 'succeeded', confirmId, message: batch.message, files: this.summaryOf(plan) });
      this.save(plan);
      this.plans.syncMembers(plan);
      return { outcome: plan.history.at(-1) };
    }
    for (const s of staged) if (s) discardStagedTaskFile(s);
    return this.rollback(plan, confirmId, failure);
  }
  // Undo only what this job changed, and only when the file still holds exactly the applied content.
  rollback(plan, confirmId, failure) {
    const batch = plan.batch, root = plan.folderPath, members = this.members(plan);
    const done = [];
    for (let i = batch.files.length - 1; i >= 0; i--) {
      const f = batch.files[i];
      if (!['applied', 'replacing'].includes(f.state) && f !== failure.file) continue;
      // A swap that failed before replacing anything left the file exactly as it was, whatever else changed it.
      if (f === failure.file && !failure.error.replaced) { f.state = 'failed'; continue; }
      const current = this.hashOf(plan, f.path);
      if (current === f.beforeHash) { f.state = 'failed'; continue; }
      if (current !== f.afterHash) { f.state = 'unknown'; continue; }
      try {
        this.faultHook?.('revert', i);
        const bytes = this.backupBytes(members[i]);
        if (!bytes) throw new Error('백업을 확인할 수 없습니다.');
        const result = commitStagedTaskFile(stageTaskTextFile(root, f.path, { expectedHash: f.afterHash, content: bytes,
          tempName: `.chatroom-${randomUUID()}.tmp` }), { ignoreNames: this.ignoreNames(batch) });
        if (result.hash !== f.beforeHash) throw new Error('복구 후 해시가 원본과 일치하지 않습니다.');
        f.state = 'reverted'; done.push(f.path);
      } catch (error) { f.state = 'revert_failed'; f.message = error.message; }
    }
    const unknown = batch.files.filter((f) => f.state === 'unknown'), stuck = batch.files.filter((f) => f.state === 'revert_failed');
    batch.finishedAt = this.now();
    if (unknown.length) {
      batch.status = 'manual';
      batch.message = `적용 중 오류(${failure.error.message}) 후 일부 파일이 외부에서 변경되어 자동 복구를 하지 않았습니다. 수동 확인이 필요합니다: ${unknown.map((f) => f.path).join(', ')}`;
    } else if (stuck.length) {
      batch.status = 'partial';
      batch.message = `적용 중 오류(${failure.error.message}) 후 자동 복구에 실패한 파일이 있습니다: ${stuck.map((f) => f.path).join(', ')}. 백업은 보존되어 있으며 전체 변경 복구를 다시 시도할 수 있습니다.`;
    } else {
      batch.status = 'apply_failed';
      batch.message = `${failure.file.path} 적용 중 오류가 발생하여 중단했습니다(${failure.error.message}). ${done.length ? `먼저 적용된 ${done.join(', ')}을(를) 원본으로 되돌렸습니다.` : '이미 변경된 파일은 없습니다.'}`;
    }
    this.record(plan, { kind: 'apply', result: batch.status === 'apply_failed' ? 'failed' : 'partial', confirmId, message: batch.message, files: this.summaryOf(plan) });
    this.save(plan);
    fail(batch.message, 500);
  }

  // ---- restore ----
  restore(plan, confirmId) {
    const replay = (plan.history || []).findLast((h) => h.kind === 'restore' && h.confirmId === confirmId);
    if (replay) return { replayed: true, outcome: replay };
    if (plan.batch?.confirmId === confirmId && plan.batch.status === 'restoring') fail('이 요청은 이미 처리 중입니다.', 409);
    this.proposals.take('plan.restore', { id: plan.id, status: plan.batch?.status }, confirmId);
    const blockers = this.verifyRestore(plan);
    if (blockers.length) {
      this.record(plan, { kind: 'restore', result: 'blocked', confirmId, message: `복구 전 검증 실패: ${blockers.join(' / ')}`, files: plan.batch ? this.summaryOf(plan) : [] });
      try { this.save(plan); } catch { /* the error below is still returned */ }
      fail(`전체 변경 복구를 중단했습니다. 어떤 파일도 수정하지 않았습니다.\n${blockers.join('\n')}`, 409);
    }
    const release = acquireWriteLock(this.lockFile);
    try { return this.runRestore(plan, confirmId); } finally { release(); }
  }
  runRestore(plan, confirmId) {
    const batch = plan.batch, root = plan.folderPath, members = this.members(plan);
    batch.status = 'restoring'; batch.confirmId = confirmId; batch.restoreStartedAt = this.now(); batch.message = '';
    const targets = batch.files.filter((f) => this.hashOf(plan, f.path) === f.afterHash);
    for (const f of batch.files) { f.restoreTemp = targets.includes(f) ? `.chatroom-${randomUUID()}.tmp` : undefined; if (!targets.includes(f)) f.state = 'reverted'; }
    this.save(plan);
    const staged = new Map(), ignoreNames = this.ignoreNames(batch);
    const stop = (message) => {
      for (const s of staged.values()) if (s) discardStagedTaskFile(s);
      batch.status = batch.files.some((f) => f.state === 'unknown') ? 'manual' : 'restore_failed'; batch.finishedAt = this.now(); batch.message = message;
      this.record(plan, { kind: 'restore', result: 'failed', confirmId, message, files: this.summaryOf(plan) });
      this.save(plan);
      fail(message, 500);
    };
    try {
      for (const f of targets) {
        const member = members[batch.files.indexOf(f)];
        staged.set(f, stageTaskTextFile(root, f.path, { expectedHash: f.afterHash, content: this.backupBytes(member), tempName: f.restoreTemp }));
      }
    } catch (error) { stop(`복구 준비에 실패하여 중단했습니다. 실제 파일은 변경되지 않았습니다. (${error.message})`); }
    for (const f of targets) {
      try {
        f.state = 'reverting'; this.save(plan);
        this.faultHook?.('restore-commit', batch.files.indexOf(f));
        const result = commitStagedTaskFile(staged.get(f), { ignoreNames });
        staged.set(f, null);
        if (result.hash !== f.beforeHash) throw new Error('복구 후 해시가 원본과 일치하지 않습니다.');
        f.state = 'reverted'; this.save(plan);
      } catch (error) {
        f.message = error.message;
        const now = this.hashOf(plan, f.path);
        f.state = now === f.afterHash ? 'applied' : now === f.beforeHash ? 'reverted' : 'unknown';
        stop(`${f.path} 복구 중 오류가 발생해 중단했습니다(${error.message}). 일부 파일만 복구된 상태입니다. 복구된 파일: ${batch.files.filter((x) => x.state === 'reverted').map((x) => x.path).join(', ') || '없음'}. 백업은 보존되어 있으며 전체 변경 복구를 다시 시도할 수 있습니다.`);
      }
    }
    const wrong = batch.files.filter((f) => this.hashOf(plan, f.path) !== f.beforeHash);
    if (wrong.length) stop(`복구 후 검증에서 원본과 다른 파일이 있습니다: ${wrong.map((f) => f.path).join(', ')}.`);
    batch.status = 'restored'; batch.finishedAt = this.now(); batch.message = `${batch.files.length}개 파일이 원본 SHA-256과 일치하도록 복구되었습니다.`;
    this.record(plan, { kind: 'restore', result: 'succeeded', confirmId, message: batch.message, files: this.summaryOf(plan) });
    this.save(plan);
    this.plans.syncMembers(plan);
    return { outcome: plan.history.at(-1) };
  }

  // ---- startup recovery: decide from the bytes on disk, never from the record alone, and never write project files ----
  recover() {
    let changed = false;
    for (const plan of this.plans.data.plans) {
      const batch = plan.batch;
      if (!batch || !['applying', 'restoring'].includes(batch.status)) continue;
      changed = true;
      const restoring = batch.status === 'restoring';
      for (const f of batch.files) {
        try { removeTaskTemp(plan.folderPath, f.path, restoring ? f.restoreTemp || f.tempName : f.tempName); } catch { /* reported by hash state */ }
        const current = this.hashOf(plan, f.path);
        f.state = current === f.beforeHash ? (restoring ? 'reverted' : 'queued') : current === f.afterHash ? 'applied' : 'unknown';
      }
      const states = batch.files.map((f) => f.state);
      let status, message, result = 'failed';
      if (states.includes('unknown')) {
        status = 'manual';
        message = '서버 재시작으로 작업이 중단되었고 일부 파일이 예상과 다른 상태이거나 확인할 수 없습니다. 자동으로 덮어쓰지 않았습니다. 수동 확인이 필요합니다.';
      } else if (restoring) {
        if (states.every((s) => s === 'reverted')) { status = 'restored'; result = 'succeeded'; message = '서버 재시작 후 확인: 모든 파일이 원본 SHA-256과 일치하여 복구 완료로 처리했습니다.'; }
        else { status = 'restore_failed'; message = '서버 재시작으로 복구가 중단되었습니다. 일부 파일이 아직 적용된 상태입니다. 전체 변경 복구를 다시 실행할 수 있습니다.'; }
      } else if (states.every((s) => s === 'queued')) {
        status = 'apply_failed'; message = '서버 재시작으로 적용이 중단되었습니다. 모든 파일이 원본 그대로이므로 다시 적용할 수 있습니다.';
      } else {
        status = 'partial';
        message = states.every((s) => s === 'applied')
          ? '서버 재시작으로 적용 검증이 중단되었습니다. 모든 파일이 수정안과 일치하지만 전체 검증을 마치지 못해 적용 완료로 처리하지 않았습니다. 전체 변경 복구가 가능합니다.'
          : '서버 재시작으로 적용이 중단되어 일부 파일만 적용된 상태입니다. 전체 변경 복구로 원본으로 되돌릴 수 있습니다.';
      }
      batch.status = status; batch.message = message; batch.finishedAt = this.now();
      this.record(plan, { kind: restoring ? 'restore' : 'apply', result, confirmId: batch.confirmId, message, files: this.summaryOf(plan) });
    }
    if (!changed) return;
    try { this.plans.commit(structuredClone(this.plans.data)); } catch { this.plans.warnings.push('중단된 여러 파일 작업의 정리 결과를 저장하지 못했습니다. 저장 공간·권한을 확인한 뒤 서버를 다시 시작하세요.'); }
    try { for (const plan of this.plans.data.plans) if (plan.batch) this.plans.syncMembers(plan); } catch { /* retried on next start */ }
  }
}
