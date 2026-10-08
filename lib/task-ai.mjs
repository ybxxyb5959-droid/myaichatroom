import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './agents.mjs';
import { RunLog } from './task-runs.mjs';
import { ChangeStore, CHANGE_LIMITS, buildOps } from './task-changes.mjs';
import { readChunks } from './task-extract.mjs';
import { TaskDocs, DOC_LIMITS, CHUNK_SYSTEM, REDUCE_SYSTEM, FINAL_SYSTEM, documentKind } from './task-docs.mjs';
import { AttachmentStore } from './task-attachments.mjs';
import { imageMethods } from './task-ai-image.mjs';
import { taskSystem } from './task-prompts.mjs';
import { resolveTaskEntry } from './task-folder.mjs';
import { scanBackups, pruneBackups } from './task-safety.mjs';
import { taskFolderStatus } from './task-folder.mjs';
import { exploreProject, EXPLORE_SYSTEM, EXPLORE_LIMITS, exploreBudget } from './task-explore.mjs';
import { PlanStore, validatePlan, renderPlan, PLAN_LIMITS } from './task-plans.mjs';
import { ProposalStore, PROPOSAL_LIMITS, validateProposalSource } from './task-proposals.mjs';

export const ANALYSIS_LIMITS = { files: 5, fileBytes: 32768, filesBytes: 65536, inputBytes: 98304, historyBytes: 16384, timeoutMs: 150000, outputBytes: 524288 };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const REQUIRED_FLAGS = ['--tools', '--safe-mode', '--restricted', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config',
  '--setting-sources', '--no-session-persistence', '--permission-mode', '--permission-prompts', '--output-format', '--system-prompt'];
const ACTION = { create: '새 파일', modify: '수정', rename: '이름·위치 변경', delete: '삭제' };
const OP_KEYS = { create: 'content,document,image,path,reason,type', modify: 'content,edit,path,reason,type', rename: 'path,reason,to,type', delete: 'path,reason,type' };
const sortedKeys = (o) => Object.keys(o).sort().join(',');
// The model proposes; the server verifies every path against what this run actually saw and against the disk right now.
export function validateChanges(changes, { reads, hashes, listed, partials = new Set() }, folderPath, { resolveImage } = {}) {
  if (sortedKeys(changes) !== 'ops,summary,title,version' || changes.version !== 1) throw new Error('changes 형식이 올바르지 않습니다.');
  if (typeof changes.title !== 'string' || !changes.title.trim() || typeof changes.summary !== 'string') throw new Error('changes의 title·summary가 올바르지 않습니다.');
  if (!Array.isArray(changes.ops) || !changes.ops.length || changes.ops.length > CHANGE_LIMITS.ops) throw new Error(`ops는 1~${CHANGE_LIMITS.ops}개여야 합니다.`);
  const ops = changes.ops.map((op) => {
    if (!op || typeof op !== 'object' || !OP_KEYS[op.type]) throw new Error('지원하지 않는 작업 종류입니다.');
    const allowed = OP_KEYS[op.type].split(',');
    const keys = Object.keys(op).filter((k) => op[k] !== undefined);
    const payload = op.type === 'create' ? [op.document !== undefined, op.image !== undefined, typeof op.content === 'string'].filter(Boolean).length === 1 : op.type === 'modify' ? (op.edit !== undefined) !== (typeof op.content === 'string') : true;
    if (keys.some((k) => !allowed.includes(k)) || !payload || (op.type === 'rename' && typeof op.to !== 'string')) {
      throw new Error(`${op.path}: ${ACTION[op.type]} 작업의 항목이 올바르지 않습니다.`);
    }
    if (op.type === 'modify' && op.edit === undefined && !reads.has(op.path)) throw new Error(`읽지 않은 파일은 수정할 수 없습니다: ${op.path}`);
    if (op.type === 'modify' && op.edit === undefined && partials.has(op.path)) throw new Error(`발췌본만 읽은 파일은 content로 수정할 수 없습니다: ${op.path}`);
    if (op.type === 'modify' && op.edit !== undefined && !reads.has(op.path) && !listed.has(op.path)) throw new Error(`폴더 조회에 나오지 않은 문서는 수정할 수 없습니다: ${op.path}`);
    if ((op.type === 'rename' || op.type === 'delete') && !reads.has(op.path) && !listed.has(op.path)) throw new Error(`폴더 조회에 나오지 않은 파일은 ${ACTION[op.type]}할 수 없습니다: ${op.path}`);
    return op;
  });
  const built = buildOps(folderPath, ops, resolveImage ? { resolveImage } : undefined);
  built.forEach((op, i) => {
    if (ops[i].type === 'modify' && ops[i].edit === undefined && hashes.get(ops[i].path) !== op.beforeHash) throw new Error(`읽은 뒤 파일이 변경되었습니다: ${op.path}`);
  });
  return { title: changes.title.trim().slice(0, CHANGE_LIMITS.titleChars), summary: changes.summary.slice(0, 2000), ops };
}
const renderChanges = (set, value) => `${set.title}\n${value.summary}\n\n${set.ops.map((op, i) => `${i + 1}. [${ACTION[op.type]}] ${op.path}${op.to ? ` → ${op.to}` : ''}${op.reason ? `\n   이유: ${op.reason}` : ''}`).join('\n')}\n\n아직 실제 파일은 바뀌지 않았습니다. 변경안 보기에서 검토·승인한 뒤 적용하세요.`;

// Reuse the existing process runner and installed CLI resolution, not the ordinary room scheduler.
export class ClaudeTaskProvider {
  constructor(adapter, { runner = run } = {}) {
    this.bin = adapter.bins?.claude;
    this.runner = runner;
    this.id = 'claude'; this.label = 'Claude Code · Sonnet'; this.shortName = 'Claude'; this.imageCapable = true;
    this.modes = new Set(['analysis', 'proposal', 'explore', 'plan', 'plan.proposals', 'changes', 'docs']); this.maxInputChars = 1_000_000;
    this.note = 'Claude 구독 로그인(claude auth login)을 사용합니다. 도구·MCP·세션 저장을 모두 끄고 실행합니다.';
  }
  available() { return !!this.bin && fs.existsSync(this.bin); }
  verified() { return this.available(); }
  async check(signal) { try { return { ok: true, state: 'ready', detail: await this.prepare(signal) }; } catch (error) { return { ok: false, state: 'login', detail: error.message }; } }

  async prepare(signal) {
    if (!this.available()) fail('Claude Code가 설치되어 있지 않습니다. 기존 연결 설정을 확인하세요.');
    const options = { timeoutMs: 20000, signal, maxOutputBytes: ANALYSIS_LIMITS.outputBytes };
    const version = await this.runner(this.bin, ['--version'], options);
    const help = await this.runner(this.bin, ['--help'], options);
    if (version.code !== 0 || help.code !== 0 || !/\d+\.\d+\.\d+/.test(version.stdout)
      || !REQUIRED_FLAGS.every((flag) => help.stdout.includes(flag))) {
      fail('이 Claude Code 버전의 도구 차단 기능을 확인하지 못해 실행을 차단했습니다.');
    }
    const auth = await this.runner(this.bin, ['auth', 'status', '--json'], options);
    let credentials;
    try { credentials = JSON.parse(auth.stdout); } catch { fail('Claude CLI 인증 상태를 확인하지 못했습니다. claude auth login을 확인하세요.'); }
    if (auth.code !== 0 || !credentials.loggedIn || credentials.authMethod !== 'claude.ai') {
      fail('Claude 구독 계정 로그인이 필요합니다. claude auth login을 실행하세요. API 키 인증은 사용하지 않습니다.');
    }
    return version.stdout.trim();
  }

  // images: [{mime, bytes}] are sent as image blocks of one stream-json message (tools stay off, as in the chat room's photo turns).
  async analyze(input, { signal, timeoutMs = ANALYSIS_LIMITS.timeoutMs, mode = 'analysis', images = [] } = {}) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-readonly-ai-'));
    try {
      const args = ['-p', '--model', 'sonnet', '--safe-mode', '--restricted', '--tools', '',
        '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--setting-sources', '', '--no-session-persistence', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
        '--output-format', 'stream-json', '--verbose', '--system-prompt', taskSystem(mode)];
      if (images.length) args.push('--input-format', 'stream-json');
      const payload = images.length ? `${JSON.stringify({ type: 'user', message: { role: 'user', content: [...images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.bytes.toString('base64') } })), { type: 'text', text: input }] } })}
` : input;
      const result = await this.runner(this.bin, args, {
        input: payload, cwd, signal, timeoutMs, maxOutputBytes: mode === 'changes' ? 8 * 1024 * 1024 : ANALYSIS_LIMITS.outputBytes,
        env: { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined,
          CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined },
      });
      if (result.code === -3 || signal?.aborted) fail('AI 실행을 취소했습니다.');
      if (result.code === -2) fail('AI 실행 시간이 초과되어 프로세스를 종료했습니다.');
      if (result.code === -4) fail('AI 출력 크기 제한을 초과하여 프로세스를 종료했습니다.');
      if (result.code !== 0) fail('Claude CLI 실행에 실패했습니다. 로그인·사용량 한도·네트워크 상태를 확인하세요.');
      let events;
      try { events = result.stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)); }
      catch { fail('Claude CLI 응답 형식을 확인하지 못했습니다.'); }
      const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
      if (!Array.isArray(init?.tools) || init.tools.length || !Array.isArray(init.mcp_servers) || init.mcp_servers.length
        || events.some((event) => event.message?.content?.some((block) => ['tool_use', 'server_tool_use'].includes(block.type)))) {
        fail('CLI의 도구 비활성화 상태를 확인하지 못했습니다. 답변을 저장하지 않습니다.');
      }
      const final = events.findLast((event) => event.type === 'result');
      if (final?.subtype !== 'success' || final.is_error || typeof final.result !== 'string' || !final.result.trim()) {
        fail('Claude가 성공한 최종 답변을 반환하지 않았습니다. 인증·사용량 한도를 확인하세요.');
      }
      if (mode === 'changes' ? Buffer.byteLength(final.result) > 3 * 1024 * 1024 : mode === 'multi' ? Buffer.byteLength(final.result) > PLAN_LIMITS.responseBytes : mode === 'proposal' ? Buffer.byteLength(final.result) > PROPOSAL_LIMITS.responseBytes : final.result.length > 16000) {
        fail('AI 답변이 저장 크기 제한을 초과했습니다.');
      }
      return final.result;
    } finally {
      // Only the unique, app-created scratch directory is removed; never a project path.
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
}

export class TaskAI {
  // image features live in task-ai-image.mjs (installed below)
  constructor(store, provider, clock = Date.now, notices = [], { providers = {}, adapter = null } = {}) {
    this.notices = notices; this.adapter = adapter;
    this.clock = clock;
    this.store = store; this.providers = { claude: provider, ...providers }; this.job = null; this.storageError = '';
    this.runs = new RunLog(path.dirname(store.file), clock);
    this.proposals = new ProposalStore(store);
    this.plans = new PlanStore(store, this.proposals);
    this.changes = new ChangeStore(store);
    this.docs = new TaskDocs(path.dirname(store.file), clock);
    this.exploreOptions = { prefetch: true };
    this.attachments = new AttachmentStore(store, clock);
    this.changes.attachmentBytes = (projectId, id) => { try { return fs.readFileSync(this.attachments.blobPath(this.attachments.get(projectId, id))); } catch { return null; } };
  }
  view() {
    return { providers: Object.entries(this.providers).map(([id, provider]) => ({ id, name: provider.label || 'Claude Code · Sonnet', short: provider.shortName || 'Claude', available: provider.available(),
      verified: provider.verified ? provider.verified() : provider.available(), modes: [...(provider.modes || [])], maxInput: provider.maxInputChars || null, note: provider.note || '' })),
      limits: ANALYSIS_LIMITS, running: this.job ? { projectId: this.job.projectId, sessionId: this.job.sessionId, id: this.job.id } : null,
      storageError: this.storageError, notices: this.notices, state: this.store.view(), proposals: this.proposals.summaries(), proposalWarnings: this.proposals.warnings,
      plans: this.plans.summaries(), planWarnings: this.plans.warnings, changes: this.changes.summaries(), changeWarnings: this.changes.warnings, attachments: this.attachments.list(), docDepths: DOC_LIMITS.depth, imageProviders: this.imageProviders(), runs: this.runs.recent(40), now: this.clock() };
  }

  start(body) {
    if (this.job) fail('작업대에서 이미 AI가 실행 중입니다. 완료하거나 취소한 뒤 다시 요청하세요.', 409);
    if (!body || !Object.hasOwn(this.providers, body.provider) || body.consent !== true) fail('지원하는 AI 선택과 자료 전송 동의가 필요합니다.', 403);
    const mode = body.mode ?? 'analysis';
    if (!['analysis', 'proposal', 'explore', 'plan', 'plan.proposals', 'changes', 'docs', 'image', 'image.analyze'].includes(mode)) fail('지원하지 않는 AI 작업 모드입니다.');
    const project = this.store.data.projects.find((p) => p.id === body.projectId);
    const entry = project?.sessions.find((s) => s.id === body.sessionId);
    if (!entry) fail('프로젝트의 세션을 찾을 수 없습니다.', 404);
    const chosen = this.providers[body.provider];
    if (!chosen.available()) fail(`${chosen.shortName || 'AI'} CLI가 설치되어 있지 않거나 연결되지 않았습니다.`);
    if (mode === 'image') return this.startImage(body, project, entry);
    if (mode === 'image.analyze') return this.startImageAnalysis(body, project, entry, chosen);
    if (chosen.modes && !chosen.modes.has(mode)) fail(`${chosen.shortName}은(는) 이 작업(${mode})을 지원하지 않습니다. ${chosen.note || ''} 다른 AI를 선택하세요.`);
    if (mode === 'docs') return this.startDocs(body, project, entry);
    if (taskFolderStatus(project.folderPath).state !== 'connected') fail('접근 가능한 프로젝트 폴더를 먼저 연결하세요.');
    if (mode === 'plan.proposals') return this.startGeneration(body, project, entry);
    const roam = mode === 'explore' || mode === 'plan' || mode === 'changes';
    if (roam && !(body.files === undefined || (Array.isArray(body.files) && !body.files.length))) fail('자동 탐색 모드에서는 파일을 직접 지정하지 않습니다.');
    if (mode === 'plan') this.plans.capacity(project.id, entry.id);
    if (mode === 'changes') this.changes.capacity(project.id, entry.id);
    if (!roam && (!Array.isArray(body.files) || body.files.length > ANALYSIS_LIMITS.files || new Set(body.files).size !== body.files.length)) {
      fail('분석할 파일은 중복 없이 최대 5개까지 선택하세요.');
    }
    if (mode === 'proposal') {
      if (body.files.length !== 1) fail('수정안은 텍스트 파일을 정확히 1개 선택해야 합니다.');
      this.proposals.capacity(project.id, entry.id);
    }
    let source;
    const folderPath = project.folderPath;
    let bytes = 0;
    const files = (roam ? [] : body.files).map((relative) => {
      const file = this.store.files({ action: 'read', projectId: project.id, path: relative });
      if (file.kind !== 'text' || file.size > ANALYSIS_LIMITS.fileBytes) fail('분석 파일은 각각 32KB 이하의 지원되는 UTF-8 텍스트여야 합니다.');
      if (mode === 'proposal') { validateProposalSource(file); source = file; }
      bytes += Buffer.byteLength(file.text);
      return { path: file.path, content: file.text };
    });
    if (bytes > ANALYSIS_LIMITS.filesBytes) fail('선택한 파일 내용의 합계는 64KB 이하여야 합니다.');
    const history = [];
    let historyBytes = 0;
    for (const message of (mode === 'proposal' ? [] : entry.messages.slice(-8)).reverse()) {
      const item = { role: message.role, text: message.text };
      const size = Buffer.byteLength(JSON.stringify(item));
      if (historyBytes + size > ANALYSIS_LIMITS.historyBytes) break;
      history.unshift(item); historyBytes += size;
    }
    const input = JSON.stringify({ request: entry.draft, history, files });
    if (!roam && Buffer.byteLength(input) > ANALYSIS_LIMITS.inputBytes) fail('요청·선택 파일·최근 대화의 합계가 96KB를 초과합니다.');
    const priorSnapshot = this.priorReads(project.id, entry.id); // before the new run replaces the session's analysis record
    const id = this.store.beginAnalysis({ ...body, mode }, files.map((file) => file.path));
    const request = entry.draft;
    const controller = new AbortController();
    const job = this.job = { id, projectId: project.id, sessionId: entry.id, controller, done: null };
    this.storageError = '';
    const provider = this.providers[body.provider];
    this.runs.begin({ id, projectId: project.id, sessionId: entry.id, mode, provider: body.provider, request: request });
    const ev = (e) => this.runs.event(id, provider.shortName && provider.shortName !== 'Claude' ? { ...e, text: e.text.replaceAll('Claude', provider.shortName) } : e);
    job.done = (async () => {
      try {
        ev({ kind: 'step', text: `${provider.shortName} CLI 로그인·안전 설정 확인 중`, state: 'active', key: 'prepare' });
        await provider.prepare(controller.signal);
        if (controller.signal.aborted) throw new Error('AI 실행을 취소했습니다.');
        ev({ kind: 'step', text: `${provider.shortName} CLI 로그인·안전 설정 확인 완료`, state: 'done', key: 'prepare' });
        this.store.finishAnalysis(job.projectId, job.sessionId, id, 'running');
        let text;
        let planId = null;
        if (roam) {
          // Every step re-checks that this job's project still exists with the same linked folder.
          const guard = () => {
            const now = this.store.data.projects.find((p) => p.id === job.projectId);
            if (!now || now.folderPath !== folderPath) throw new Error('프로젝트 또는 폴더 연결이 바뀌어 탐색을 중단했습니다.');
          };
          // Files an earlier run of this session read: their hashes are re-checked against the disk before they are called "known".
          const priorFiles = priorSnapshot;
          const prior = [...new Set(entry.messages.flatMap((m) => m.files || []))].slice(-10);
          const hints = prior.length ? [`이 세션의 이전 탐색에서 읽은 파일(필요하면 다시 요청): ${prior.join(', ')}`] : [];
          const accept = mode === 'changes' ? (reply, ctx) => {
            if (!reply.changes) throw new Error('answer에는 changes 객체가 필요합니다.');
            return validateChanges(reply.changes, ctx, folderPath, { resolveImage: this.changes.resolverFor(project.id, folderPath) });
          } : mode === 'plan' ? (reply, ctx) => {
            if (!reply.plan) throw new Error('answer에는 plan 객체가 필요합니다.');
            return validatePlan(reply.plan, ctx);
          } : (reply) => { if (!reply.text.trim()) throw new Error('answer에는 text가 필요합니다.'); };
          const usage = {};
          const result = await exploreProject({ request, history, hints, accept, signal: controller.signal, clock: this.clock, guard,
            prior: priorFiles, limits: exploreBudget(mode, request), prefetch: this.exploreOptions.prefetch, usage,
            canReadDoc: (relative) => /\.(pdf|docx|pptx|xlsx)$/i.test(relative) || /\.(txt|md|csv|tsv|json|jsonl|log|xml|html?|ya?ml)$/i.test(relative),
            readDoc: (relative, ask) => this.readDocExcerpt(project, relative, ask, controller.signal),
            files: (action, relative) => { guard(); return this.store.files({ projectId: job.projectId, action, path: relative }); },
            ask: (stepInput, options) => provider.analyze(stepInput, { ...options, mode }),
            event: ev, report: (explore) => { if (!controller.signal.aborted) this.store.recordExploration(job.projectId, job.sessionId, id, explore); } });
          if (mode === 'changes') {
            const set = this.changes.create({ projectId: job.projectId, sessionId: job.sessionId, runId: id, folderPath, title: result.value.title, summary: result.value.summary }, result.value.ops);
            job.changeId = set.id; ev({ kind: 'save', text: `파일 변경안 저장 (작업 ${set.ops.length}개)`, state: 'done' });
            result.text = renderChanges(set, result.value);
          }
          if (mode === 'plan') {
            const plan = this.plans.create({ projectId: job.projectId, sessionId: job.sessionId, runId: id, folderPath }, result.value);
            planId = plan.id; result.text = renderPlan(plan);
            ev({ kind: 'save', text: '작업 계획 저장', state: 'done' });
          }
          text = result.text.length > 15900 ? result.text.slice(0, 15900) + '\n…(저장 길이 제한으로 잘림)' : result.text;
        } else {
          if (files.length) ev({ kind: 'file', text: `선택한 파일 ${files.length}개를 서버가 읽어 전달 준비`, state: 'done', detail: { bytes } });
          ev({ kind: 'ai', text: mode === 'proposal' ? 'Claude 수정안 생성 대기 중' : 'Claude 분석 응답 대기 중', state: 'active', key: 'ai:1' });
          text = await provider.analyze(input, { signal: controller.signal, mode });
          ev({ kind: 'ai', text: 'Claude 응답 수신', state: 'done', key: 'ai:1' });
        }
        if (controller.signal.aborted) throw new Error('AI 실행을 취소했습니다.');
        if (mode === 'proposal') {
          const proposal = this.proposals.create({ projectId: job.projectId, sessionId: job.sessionId, runId: id, folderPath, source }, text);
          this.store.finishAnalysis(job.projectId, job.sessionId, id, 'completed', proposal.reason, proposal.id);
          ev({ kind: 'save', text: '수정안 1개 검증·저장', state: 'done' });
        } else {
          this.store.finishAnalysis(job.projectId, job.sessionId, id, 'completed', text, null, planId, job.changeId || null);
          if (!planId && !job.changeId) ev({ kind: 'save', text: '분석 결과 저장', state: 'done' });
        }
        this.runs.finish(id, 'completed');
      } catch (error) {
        const reason = controller.signal.aborted ? 'AI 실행을 취소했습니다.' : this.named(provider, error.message);
        this.runs.finish(id, controller.signal.aborted ? 'cancelled' : 'failed', reason);
        try {
          this.store.finishAnalysis(job.projectId, job.sessionId, id, controller.signal.aborted ? 'cancelled' : 'failed',
            reason);
        } catch {
          this.storageError = 'AI 실행 결과를 디스크에 저장하지 못했습니다. 저장 공간·권한을 확인하세요.';
        }
      } finally { if (this.job === job) this.job = null; }
    })();
    return this.view();
  }

  // Turns the requested sources into readable files. Project files go through the same path policy as browsing;
  // attachments come from the app's own store. Nothing is read here beyond a few header bytes.
  resolveDocSources(body, project) {
    const list = body.sources;
    if (!Array.isArray(list) || !list.length || list.length > DOC_LIMITS.sources) fail(`분석할 문서를 1~${DOC_LIMITS.sources}개 선택하세요.`);
    const seen = new Set();
    return list.map((item) => {
      if (!item || typeof item !== 'object') fail('문서 선택 형식이 올바르지 않습니다.');
      let file, name, cacheId, size, attachment = null;
      if (item.kind === 'attachment') {
        const record = this.attachments.get(project.id, item.id);
        file = this.attachments.blobPath(record); name = record.name; cacheId = record.hash; size = record.size; attachment = record;
      } else if (item.kind === 'file') {
        if (taskFolderStatus(project.folderPath).state !== 'connected') fail('프로젝트 폴더가 연결되어 있지 않아 폴더의 파일을 분석할 수 없습니다.');
        let entry;
        try { entry = resolveTaskEntry(project.folderPath, item.path); } catch (error) { fail(error.message, error.status || 403); }
        if (!entry.stat.isFile()) fail('파일이 아닌 경로입니다.');
        if (entry.stat.nlink > 1) fail('다른 경로와 연결된 하드 링크 파일은 읽을 수 없습니다.', 403);
        file = entry.target; name = item.path.split('/').at(-1); cacheId = `${project.id}:${item.path}`; size = entry.stat.size;
      } else fail('문서 출처는 file 또는 attachment여야 합니다.');
      const head = Buffer.alloc(Math.min(8192, size)); const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
      const { kind, supported } = documentKind(name, head);
      if (!supported) fail(`${name}: 분석할 수 없는 형식입니다(${kind === 'legacy' ? '구형 Office·HWP는 .docx/.pptx/.xlsx/PDF로 저장해 주세요' : kind === 'image' ? '이미지는 이미지 기능을 사용하세요' : '텍스트·PDF·DOCX·PPTX·XLSX만 지원'}).`);
      const key = `${item.kind}:${cacheId}`;
      if (seen.has(key)) fail('같은 문서가 중복 선택되었습니다.');
      seen.add(key);
      return { file, name, cacheId, size, kind, attachment: attachment ? attachment.id : null };
    });
  }

  // Converts the chosen documents (cached) and reports what an analysis would cost, without calling any AI.
  async prepareDocs(body, signal) {
    if (this.job) fail('AI 실행이 끝난 뒤 문서를 확인하세요.', 409);
    const project = this.store.data.projects.find((p) => p.id === body.projectId);
    if (!project) fail('프로젝트를 찾을 수 없습니다.', 404);
    const sources = this.resolveDocSources(body, project);
    const result = [];
    for (const source of sources) {
      const spool = await this.docs.spool(source, { signal });
      result.push({ name: source.name, kind: source.kind, size: source.size, chars: spool.chars, chunks: spool.chunks, pages: spool.info.pages ?? null, textPages: spool.info.textPages ?? null,
        scannedPages: spool.info.scannedPages?.length ?? 0, estimates: Object.fromEntries(Object.keys(DOC_LIMITS.depth).map((depth) => [depth, this.docs.estimate([spool], depth)[0]])) });
    }
    return { sources: result };
  }

  // Hashes of the files the latest explore/plan/changes run of this session read, for the "known, unchanged" hint.
  priorReads(projectId, sessionId) {
    const entry = this.store.data.projects.find((p) => p.id === projectId)?.sessions.find((s) => s.id === sessionId);
    const explore = entry?.analysis?.explore;
    const seen = new Set(), out = [];
    for (const f of [...(explore?.files || []).filter((x) => x.hash && !x.partial), ...(explore?.known || [])]) if (!seen.has(f.path)) { seen.add(f.path); out.push({ path: f.path, hash: f.hash }); }
    return out.slice(-10);
  }

  // A bounded excerpt of a document or a big text file: the chunks that matter for the request, never the whole file.
  async readDocExcerpt(project, relative, request, signal) {
    const [source] = this.resolveDocSources({ sources: [{ kind: 'file', path: relative }] }, project);
    const spool = await this.docs.spool(source, { signal });
    const budget = Math.max(1, Math.floor(EXPLORE_LIMITS.excerptBytes / 12000));
    const { ids } = await this.docs.select(spool, request, Math.max(budget, 2), { signal });
    const picked = ids.slice(0, Math.max(budget, 2)), parts = readChunks(spool, picked);
    let text = '';
    for (const part of parts) {
      const label = part.loc.length ? `[${part.loc.join(', ')}]` : `[구간 ${part.id + 1}/${spool.chunks}]`;
      if (Buffer.byteLength(text + part.text) > EXPLORE_LIMITS.excerptBytes) break;
      text += `${label}\n${part.text}\n`;
    }
    const coverage = this.docs.describe(spool, picked);
    text += `\n(발췌: 문서 ${spool.chars.toLocaleString('ko-KR')}자 중 약 ${coverage.percent}%만 제공됨)`;
    return { path: relative, kind: 'text', size: source.size, text, hash: spool.textHash };
  }

  startDocs(body, project, entry) {
    if (!['quick', 'normal', 'thorough'].includes(body.depth ?? 'normal')) fail('분석 깊이가 올바르지 않습니다.');
    const depth = body.depth ?? 'normal';
    const sources = this.resolveDocSources(body, project);
    if (sources.some((src) => src.attachment) && body.consentAttachments !== true) fail('첨부 파일의 내용이 AI 서비스로 전송되는 데 동의해야 합니다.', 403);
    const id = this.store.beginAnalysis({ ...body, mode: 'docs' }, sources.map((src) => src.name));
    const request = entry.draft;
    const history = entry.messages.slice(-6).slice(0, -1).map((m) => ({ role: m.role, text: m.text.slice(0, 1500) }));
    const controller = new AbortController();
    const job = this.job = { id, projectId: project.id, sessionId: entry.id, controller, done: null };
    this.storageError = '';
    const provider = this.providers[body.provider];
    this.runs.begin({ id, projectId: project.id, sessionId: entry.id, mode: 'docs', provider: body.provider, request });
    const ev = (e) => this.runs.event(id, provider.shortName && provider.shortName !== 'Claude' ? { ...e, text: e.text.replaceAll('Claude', provider.shortName) } : e);
    job.done = (async () => {
      try {
        ev({ kind: 'step', text: `${provider.shortName} CLI 로그인·안전 설정 확인 중`, state: 'active', key: 'prepare' });
        await provider.prepare(controller.signal);
        if (controller.signal.aborted) throw new Error('AI 실행을 취소했습니다.');
        ev({ kind: 'step', text: `${provider.shortName} CLI 로그인·안전 설정 확인 완료`, state: 'done', key: 'prepare' });
        if (sources.some((src) => src.attachment)) ev({ kind: 'step', text: `첨부 ${sources.filter((src) => src.attachment).length}개의 내용 전송에 동의함을 확인`, state: 'done' });
        this.store.finishAnalysis(job.projectId, job.sessionId, id, 'running');
        const result = await this.docs.analyze({ request, sources, depth, signal: controller.signal, history, event: ev, clock: this.clock, limits: provider.docLimits,
          ask: (input, options) => provider.analyze(input, options) });
        if (controller.signal.aborted) throw new Error('AI 실행을 취소했습니다.');
        // The stored message limit is 16,000 characters; the server-written coverage report always stays whole.
        const split = result.text.lastIndexOf('\n\n── 분석 범위 ──');
        let answer = result.text.slice(0, split), coverage = result.text.slice(split);
        if (coverage.length > 3800) coverage = `${coverage.slice(0, 3800)}\n…`;
        if (answer.length + coverage.length > 15900) answer = `${answer.slice(0, 15900 - coverage.length - 40)}\n…(저장 길이 제한으로 잘림)`;
        this.store.finishAnalysis(job.projectId, job.sessionId, id, 'completed', answer + coverage);
        ev({ kind: 'save', text: `분석 결과 저장 (AI 호출 ${result.calls}회)`, state: 'done' });
        this.runs.finish(id, 'completed');
      } catch (error) {
        const reason = controller.signal.aborted ? 'AI 실행을 취소했습니다.' : this.named(provider, error.message);
        this.runs.finish(id, controller.signal.aborted ? 'cancelled' : 'failed', reason);
        try {
          this.store.finishAnalysis(job.projectId, job.sessionId, id, controller.signal.aborted ? 'cancelled' : 'failed',
            reason);
        } catch { this.storageError = 'AI 실행 결과를 디스크에 저장하지 못했습니다. 저장 공간·권한을 확인하세요.'; }
      } finally { if (this.job === job) this.job = null; }
    })();
    return this.view();
  }

  async checkProvider(body, signal) {
    const provider = this.providers[body.provider];
    if (!provider) fail('알 수 없는 AI입니다.', 404);
    if (this.job) fail('AI 실행 중에는 연결을 확인하지 않습니다.', 409);
    return { provider: body.provider, ...(await provider.check(signal)) };
  }

  // One AI call for all planned files. The server re-reads each file, so contents/hashes never come from the plan or the model.
  startGeneration(body, project, entry) {
    const { plan, sources } = this.plans.prepareGeneration(body);
    const request = `계획의 수정안 생성: ${plan.goal}`.slice(0, 200);
    const input = this.plans.generationInput(plan, sources, request);
    if (Buffer.byteLength(input) > ANALYSIS_LIMITS.inputBytes + PLAN_LIMITS.files * 4096) fail('계획된 파일과 계획 설명의 합계가 입력 크기 제한을 초과합니다.');
    const id = this.store.beginAnalysis({ ...body, mode: 'plan.proposals' }, plan.files.map((f) => f.path), request);
    const controller = new AbortController();
    const job = this.job = { id, projectId: project.id, sessionId: entry.id, controller, done: null };
    this.storageError = '';
    const provider = this.providers[body.provider];
    this.runs.begin({ id, projectId: project.id, sessionId: entry.id, mode: 'plan.proposals', provider: body.provider, request: request });
    const ev = (e) => this.runs.event(id, provider.shortName && provider.shortName !== 'Claude' ? { ...e, text: e.text.replaceAll('Claude', provider.shortName) } : e);
    job.done = (async () => {
      try {
        ev({ kind: 'step', text: `${provider.shortName} CLI 로그인·안전 설정 확인 중`, state: 'active', key: 'prepare' });
        await provider.prepare(controller.signal);
        if (controller.signal.aborted) throw new Error('AI 실행을 취소했습니다.');
        ev({ kind: 'step', text: `${provider.shortName} CLI 로그인·안전 설정 확인 완료`, state: 'done', key: 'prepare' });
        this.store.finishAnalysis(job.projectId, job.sessionId, id, 'running');
        ev({ kind: 'file', text: `계획된 파일 ${plan.files.length}개를 서버가 다시 읽어 전달 준비`, state: 'done' });
        ev({ kind: 'ai', text: 'Claude 수정안 생성 대기 중', state: 'active', key: 'ai:1' });
        const raw = await provider.analyze(input, { signal: controller.signal, mode: 'multi' });
        ev({ kind: 'ai', text: 'Claude 응답 수신', state: 'done', key: 'ai:1' });
        if (controller.signal.aborted) throw new Error('AI 실행을 취소했습니다.');
        // Re-check just before saving: same folder, and every file still has the hash the proposals are based on.
        const { plan: again, sources: fresh } = this.plans.prepareGeneration({ ...body, planId: plan.id });
        const result = this.plans.complete(again, fresh, raw, id);
        const summary = result.invalid ? `수정안 ${result.created}개를 생성했고 ${result.invalid}개 파일은 검증에 실패했습니다. 작업 계획 화면에서 확인하세요.`
          : `수정안 ${result.created}개를 생성했습니다. 작업 계획 화면에서 검토·승인하세요. 이번 단계에서는 실제 파일에 적용되지 않습니다.`;
        this.store.finishAnalysis(job.projectId, job.sessionId, id, 'completed', summary, null, plan.id);
        ev({ kind: 'save', text: `수정안 ${result.created}개 생성·저장${result.invalid ? ` (검증 실패 ${result.invalid}개)` : ''}`, state: 'done' });
        this.runs.finish(id, 'completed');
      } catch (error) {
        const reason = controller.signal.aborted ? 'AI 실행을 취소했습니다.' : this.named(provider, error.message);
        this.runs.finish(id, controller.signal.aborted ? 'cancelled' : 'failed', reason);
        try {
          this.store.finishAnalysis(job.projectId, job.sessionId, id, controller.signal.aborted ? 'cancelled' : 'failed',
            reason);
        } catch { this.storageError = 'AI 실행 결과를 디스크에 저장하지 못했습니다. 저장 공간·권한을 확인하세요.'; }
      } finally { if (this.job === job) this.job = null; }
    })();
    return this.view();
  }

  // Backups of unfinished, applied or restorable work are always kept; only orphans (7 days) and finished
  // (restored/rejected, 30 days) backups inside the app's own backup folder can be pruned.
  maintenance(body) {
    if (this.job) fail('AI 실행이 끝난 뒤 백업을 정리하세요.', 409);
    const refs = new Map();
    for (const p of this.proposals.data.proposals) {
      const finished = ['restored', 'rejected'].includes(p.status) && !this.plans.unresolvedFor(p.projectId);
      refs.set(path.resolve(this.proposals.backupFile(p)).toLowerCase(), { keep: !finished });
    }
    for (const [file, ref] of this.changes.backupRefs()) refs.set(file, ref);
    const report = scanBackups([this.proposals.backupDir, this.changes.blobDir], refs, { now: this.clock() });
    const removed = body.action === 'maintenance.prune' ? pruneBackups(report, this.proposals.backupDir).length + pruneBackups(report, this.changes.blobDir).length : 0;
    const cache = this.docs.prune({ dry: body.action !== 'maintenance.prune' });
    return { total: report.files.length, totalBytes: report.totalBytes, prunable: report.prunableCount, prunableBytes: report.prunableBytes, removed,
      cache: { removable: cache.removed, bytes: cache.bytes, total: cache.total }, orphanAttachments: this.attachments.orphans().length };
  }

  named(provider, text) { return provider.shortName && provider.shortName !== 'Claude' ? String(text).replaceAll('Claude', provider.shortName) : String(text); }

  cancel(body) {
    if (!this.job || body.id !== this.job.id || body.projectId !== this.job.projectId || body.sessionId !== this.job.sessionId) {
      fail('취소할 실행을 찾을 수 없습니다.', 404);
    }
    this.runs.event(this.job.id, { kind: 'step', text: '취소 요청을 받아 진행 중인 Claude CLI를 종료하는 중', state: 'active', key: 'cancel' });
    this.job.controller.abort();
    return this.view();
  }
  async close() { if (this.job) { this.job.controller.abort(); await this.job.done; } this.runs.flush(); }
}

Object.assign(TaskAI.prototype, imageMethods);
