import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFile } from './atomic.mjs';
import { PlanBatch, UNRESOLVED } from './task-batch.mjs';
import { PROPOSAL_LIMITS, checkProposal, proposalDiff, validateProposalSource } from './task-proposals.mjs';

// Work plans group several per-file proposals (the existing ProposalStore records) into one reviewable job.
export const PLAN_LIMITS = { files: 3, count: 30, perSession: 5, goalChars: 500, itemChars: 500, items: 10, reasonChars: 1000, changeChars: 2000,
  responseBytes: PROPOSAL_LIMITS.fileBytes * 3 + 24576, storeBytes: 2 * 1024 * 1024 };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const uuid = (id) => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const HEX = /^[0-9a-f]{64}$/;
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const list = (v, max) => Array.isArray(v) && v.length <= PLAN_LIMITS.items && v.every((x) => text(x, max));
const keys = (o, expected) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === expected;

// The plan may only name files this run actually read (path + hash come from the server's read, never from the model).
export function validatePlan(plan, { reads, hashes, partials = new Set() }) {
  if (!keys(plan, 'files,goal,issues,risks,version') || plan.version !== 1) fail('작업 계획의 형식이 올바르지 않습니다.');
  if (!text(plan.goal, PLAN_LIMITS.goalChars) || !list(plan.issues, PLAN_LIMITS.itemChars) || !list(plan.risks, PLAN_LIMITS.itemChars)) {
    fail('작업 계획의 목표·문제점·위험 요소가 비었거나 너무 깁니다.');
  }
  if (!Array.isArray(plan.files) || plan.files.length > PLAN_LIMITS.files) fail(`수정 대상 파일은 최대 ${PLAN_LIMITS.files}개입니다.`);
  const seen = new Set();
  const files = plan.files.map((file) => {
    if (!keys(file, 'change,path,reason') || !text(file.path, 4096) || !text(file.reason, PLAN_LIMITS.reasonChars) || !text(file.change, PLAN_LIMITS.changeChars)) {
      fail('수정 대상 파일 항목의 형식이 올바르지 않습니다.');
    }
    if (seen.has(file.path)) fail(`수정 대상이 중복되었습니다: ${file.path}`);
    seen.add(file.path);
    if (!reads.has(file.path)) fail(`읽지 않은 파일은 수정 대상으로 확정할 수 없습니다: ${file.path}`);
    if (partials.has(file.path)) fail(`발췌본만 읽은 파일은 수정 대상으로 확정할 수 없습니다: ${file.path}`);
    validateProposalSource({ kind: 'text', size: Buffer.byteLength(reads.get(file.path)), text: reads.get(file.path), hash: hashes.get(file.path) });
    return { path: file.path, reason: file.reason, change: file.change, hash: hashes.get(file.path) };
  });
  return { goal: plan.goal, issues: plan.issues, risks: plan.risks, files };
}

export function renderPlan(plan) {
  const bullets = (items) => items.length ? items.map((x) => `- ${x}`).join('\n') : '- 없음';
  const files = plan.files.length
    ? plan.files.map((f, i) => `${i + 1}. ${f.path}\n   이유: ${f.reason}\n   변경: ${f.change}`).join('\n') : '수정이 필요한 파일이 없습니다.';
  return `작업 목표\n${plan.goal}\n\n발견한 문제·개선 대상\n${bullets(plan.issues)}\n\n수정 대상 파일\n${files}\n\n위험 요소\n${bullets(plan.risks)}`;
}

// The model may only answer with the planned paths; any extra path rejects the whole response.
export function parseMultiProposals(raw, plan) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > PLAN_LIMITS.responseBytes) fail('수정안 응답 크기가 제한을 초과했습니다.');
  let result;
  try { result = JSON.parse(raw); } catch { fail('Claude 수정안이 올바른 JSON 형식이 아닙니다.'); }
  if (!keys(result, 'files,version') || result.version !== 1 || !Array.isArray(result.files) || result.files.length > plan.files.length) {
    fail('수정안 형식이 올바르지 않습니다.');
  }
  const planned = new Set(plan.files.map((f) => f.path)), seen = new Set();
  for (const file of result.files) {
    if (!file || typeof file.path !== 'string' || !planned.has(file.path)) fail('계획에 없는 파일의 수정안이 포함되어 응답 전체를 거부했습니다.');
    if (seen.has(file.path)) fail('같은 파일의 수정안이 중복되었습니다.');
    seen.add(file.path);
  }
  return new Map(result.files.map((file) => [file.path, file]));
}

function valid(data) {
  if (data?.version !== 1 || !Array.isArray(data.plans) || data.plans.length > PLAN_LIMITS.count) return false;
  const ids = new Set();
  return data.plans.every((p) => {
    if (!p || !uuid(p.id) || ids.has(p.id) || !uuid(p.projectId) || !uuid(p.sessionId) || !uuid(p.runId) || typeof p.folderPath !== 'string'
      || !text(p.goal, PLAN_LIMITS.goalChars) || !list(p.issues, PLAN_LIMITS.itemChars) || !list(p.risks, PLAN_LIMITS.itemChars)
      || !Number.isSafeInteger(p.createdAt) || !Array.isArray(p.files) || p.files.length > PLAN_LIMITS.files) return false;
    ids.add(p.id);
    return p.files.every((f) => f && text(f.path, 4096) && text(f.reason, PLAN_LIMITS.reasonChars) && text(f.change, PLAN_LIMITS.changeChars)
      && HEX.test(f.hash) && (f.proposalId === undefined || uuid(f.proposalId)) && (f.error === undefined || typeof f.error === 'string'));
  });
}

export class PlanStore {
  constructor(store, proposals) {
    this.store = store; this.proposals = proposals;
    this.file = path.join(path.dirname(store.file), 'task-plans.json');
    this.warnings = [];
    this.data = readJsonFile(this.file, { version: 1, plans: [] }, { validate: valid, onRecovery: (message) => this.warnings.push(message) });
    this.batch = new PlanBatch(this);
    // Single-file proposals must not run on a file that a multi-file job owns, and must not judge plan members by "original unchanged".
    proposals.planHooks = {
      hasBatch: (planId) => !!this.data.plans.find((p) => p.id === planId)?.batch,
      targetBusy: (folderPath, relative) => this.data.plans.some((p) => p.folderPath === folderPath && UNRESOLVED.includes(p.batch?.status)
        && p.batch.files.some((f) => (process.platform === 'win32' ? f.path.toLowerCase() === relative.toLowerCase() : f.path === relative))),
    };
    this.batch.recover();
  }
  // Member proposal statuses follow the batch result; idempotent so a restart can re-run it.
  syncMembers(plan) {
    const wanted = { applied: 'applied', restored: 'restored', apply_failed: 'approved' }[plan.batch?.status];
    if (!wanted) return;
    const backups = new Map(plan.batch.files.map((f) => [f.proposalId, f.backup]));
    this.proposals.setPlanStatuses(plan.files.map((f) => f.proposalId).filter(Boolean), wanted, backups, plan.batch.finishedAt);
  }
  unresolvedFor(projectId) {
    return this.data.plans.some((p) => p.projectId === projectId && UNRESOLVED.includes(p.batch?.status));
  }
  commit(next) {
    if (Buffer.byteLength(JSON.stringify(next)) > PLAN_LIMITS.storeBytes) fail('작업 계획 저장 용량(2MB)을 초과했습니다.', 413);
    writeJsonFile(this.file, next);
    this.data = next;
  }
  capacity(projectId, sessionId) {
    this.proposals.scope(projectId, sessionId);
    if (this.data.plans.length >= PLAN_LIMITS.count || this.data.plans.filter((p) => p.projectId === projectId && p.sessionId === sessionId).length >= PLAN_LIMITS.perSession) {
      fail('작업 계획 보관 한도(전체 30개·세션당 5개)에 도달했습니다. 기존 계획은 자동 삭제하지 않습니다.');
    }
  }
  create({ projectId, sessionId, runId, folderPath }, plan) {
    this.capacity(projectId, sessionId);
    const record = { id: randomUUID(), projectId, sessionId, runId, folderPath, createdAt: this.store.clock(), ...plan };
    const next = structuredClone(this.data);
    next.plans.push(record);
    this.commit(next);
    return structuredClone(record);
  }
  locate(body) {
    this.proposals.scope(body.projectId, body.sessionId);
    const plan = this.data.plans.find((p) => p.id === body.planId && p.projectId === body.projectId && p.sessionId === body.sessionId);
    if (!plan) fail('이 세션의 작업 계획을 찾을 수 없습니다.', 404);
    return plan;
  }
  members(plan) {
    return plan.files.map((f) => f.proposalId && this.proposals.data.proposals.find((p) => p.id === f.proposalId)).filter(Boolean);
  }
  status(plan) {
    if (plan.batch) return { applying: 'applying', applied: 'applied', apply_failed: 'apply_failed', partial: 'partial_applied', restoring: 'restoring',
      restored: 'restored', restore_failed: 'restore_failed', manual: 'manual' }[plan.batch.status];
    const members = this.members(plan);
    if (!members.length) return plan.files.some((f) => f.error) ? 'invalid' : 'planned';
    const states = new Set(members.map((p) => p.status));
    if (states.has('conflict')) return 'conflict';
    if (states.size === 1) return { pending: 'proposed', approved: 'approved', rejected: 'rejected' }[[...states][0]] || 'partial';
    return 'partial';
  }
  view(plan) {
    return { ...structuredClone(plan), status: this.status(plan), history: structuredClone(plan.history || []),
      files: plan.files.map((f) => ({ ...f, proposalStatus: this.proposals.data.proposals.find((p) => p.id === f.proposalId)?.status || null })) };
  }
  summaries() { return this.data.plans.map((plan) => this.view(plan)); }

  // Re-read each planned file through the read-only policy; a file that changed since planning is never sent for editing.
  prepareGeneration(body) {
    const plan = this.locate(body);
    if (plan.generatedAt) fail('이 계획의 수정안은 이미 생성되었습니다.', 409);
    if (plan.batch) fail('이미 적용·복구 기록이 있는 계획입니다.', 409);
    if (!plan.files.length) fail('수정 대상 파일이 없는 계획입니다.');
    const project = this.proposals.scope(plan.projectId, plan.sessionId);
    if (project.folderPath !== plan.folderPath) fail('프로젝트의 연결 폴더가 변경되어 이 계획으로는 수정안을 만들 수 없습니다.', 409);
    this.proposals.capacity(plan.projectId, plan.sessionId, plan.files.length);
    const sources = plan.files.map((f) => {
      const source = this.store.files({ action: 'read', projectId: plan.projectId, path: f.path });
      validateProposalSource(source);
      if (source.hash !== f.hash) fail(`계획 수립 이후 파일이 변경되었습니다: ${f.path}. 새 계획을 만드세요.`, 409);
      return source;
    });
    return { plan, sources };
  }
  generationInput(plan, sources, request) {
    return JSON.stringify({ request, goal: plan.goal, risks: plan.risks,
      files: plan.files.map((f, i) => ({ path: f.path, reason: f.reason, change: f.change, content: sources[i].text })) });
  }
  // Files that fail validation are recorded as invalid; the others become pending proposals. Nothing is auto-approved.
  complete(plan, sources, raw, runId) {
    const answers = parseMultiProposals(raw, plan);
    const items = [], errors = new Map();
    plan.files.forEach((f, i) => {
      const answer = answers.get(f.path);
      if (!answer) return errors.set(f.path, 'Claude가 이 파일의 수정안을 반환하지 않았습니다.');
      try {
        if (!keys(answer, 'after,path,reason') ) fail('파일 수정안 항목의 형식이 올바르지 않습니다.');
        const parsed = checkProposal({ ...answer }, f.path, sources[i].text);
        items.push({ path: f.path, source: sources[i], parsed });
      } catch (error) { errors.set(f.path, error.message); }
    });
    const created = items.length ? this.proposals.createMany({ projectId: plan.projectId, sessionId: plan.sessionId, runId, folderPath: plan.folderPath, planId: plan.id },
      items) : [];
    const next = structuredClone(this.data);
    const target = next.plans.find((p) => p.id === plan.id);
    if (created.length) target.generatedAt = this.store.clock();
    target.files.forEach((f) => {
      const index = items.findIndex((item) => item.path === f.path);
      if (index >= 0) {
        const diff = proposalDiff(items[index].source.text, items[index].parsed.after);
        Object.assign(f, { proposalId: created[index].id, added: diff.added, removed: diff.removed });
        delete f.error;
      } else f.error = errors.get(f.path);
    });
    this.commit(next);
    return { created: created.length, invalid: errors.size };
  }

  handle(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('올바른 작업 계획 요청이 아닙니다.');
    if (['path', 'folderPath', 'after', 'before', 'content', 'files', 'hash', 'batch', 'backup', 'tempName', 'target'].some((key) => Object.hasOwn(body, key))) {
      fail('수정할 파일 경로나 내용은 요청으로 지정할 수 없습니다.');
    }
    const plan = this.locate(body);
    if (body.action === 'get') {
      // Re-verify originals so a file changed since generation shows up as a conflict, never as approvable.
      if (!plan.batch) for (const f of plan.files) if (f.proposalId) this.proposals.recheck({ projectId: plan.projectId, sessionId: plan.sessionId, id: f.proposalId });
      return this.view(plan);
    }
    if (body.action === 'apply.prepare') return { ...this.view(plan), confirmation: this.batch.prepareApply(plan) };
    if (body.action === 'restore.prepare') return { ...this.view(plan), confirmation: this.batch.prepareRestore(plan) };
    if (body.action === 'apply' || body.action === 'restore') {
      if (typeof body.confirmId !== 'string' || !uuid(body.confirmId)) fail('실제 파일을 변경하려면 최종 확인 절차가 필요합니다.');
      const result = body.action === 'apply' ? this.batch.apply(plan, body.confirmId) : this.batch.restore(plan, body.confirmId);
      return { ...this.view(this.locate(body)), outcome: result.outcome, ...(result.replayed ? { replayed: true } : {}) };
    }
    if (body.action === 'decide') {
      if (plan.batch) fail('적용·복구 기록이 있는 계획의 승인 상태는 변경할 수 없습니다.', 409);
      if (!['approved', 'rejected'].includes(body.decision)) fail('승인 또는 거절만 선택할 수 있습니다.');
      const ids = plan.files.map((f) => f.proposalId).filter(Boolean);
      if (!ids.length) fail('아직 수정안이 생성되지 않은 계획입니다.', 409);
      if (body.decision === 'approved' && plan.files.some((f) => f.error)) {
        fail('검증에 실패한 파일이 있어 전체 승인할 수 없습니다. 유효한 파일만 개별 승인하거나 새 계획을 만드세요.', 409);
      }
      this.proposals.decideMany({ projectId: plan.projectId, sessionId: plan.sessionId }, ids, body.decision);
      return this.view(plan);
    }
    fail('지원하지 않는 작업 계획 요청입니다.');
  }
}
