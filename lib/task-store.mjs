import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFile } from './atomic.mjs';
import { validateTaskFolder, taskFolderStatus, taskProjectFiles } from './task-folder.mjs';

const TEXT_LIMIT = 16000;
export const PROVIDERS = ['claude', 'codex', 'gemini'];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const textOK = (value) => typeof value === 'string' && value.length <= TEXT_LIMIT;
const nameOK = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
const idOK = (value) => typeof value === 'string' && ID.test(value);
const timeOK = (value) => Number.isSafeInteger(value) && value >= 0;
const fresh = () => ({ version: 1, projects: [], selectedProjectId: null, selectedSessionId: null });
const session = (now) => ({ id: randomUUID(), createdAt: now, draft: '', revision: 0, messages: [] });

function valid(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.projects)) return false;
  const ids = new Set();
  const unique = (id) => idOK(id) && !ids.has(id) && !!ids.add(id);
  for (const project of data.projects) {
    if (!project || !unique(project.id) || !nameOK(project.name) || !timeOK(project.createdAt)
      || !Array.isArray(project.sessions) || !project.sessions.length) return false;
    if (project.folderPath != null && typeof project.folderPath !== 'string') return false;
    for (const entry of project.sessions) {
      if (!entry || !unique(entry.id) || !timeOK(entry.createdAt) || !textOK(entry.draft)
        || !timeOK(entry.revision) || !Array.isArray(entry.messages)) return false;
      for (const message of entry.messages) {
        if (!message || !unique(message.id) || !['user', 'assistant'].includes(message.role) || !textOK(message.text)
          || !message.text.trim() || !timeOK(message.at)) return false;
        if (message.role === 'assistant' && (!PROVIDERS.includes(message.provider) || !idOK(message.runId))) return false;
      }
      if (entry.analysis && (!idOK(entry.analysis.id) || !PROVIDERS.includes(entry.analysis.provider)
        || !['preparing', 'running', 'completed', 'failed', 'cancelled'].includes(entry.analysis.status))) return false;
    }
    if (!project.sessions.some((entry) => entry.id === project.selectedSessionId)) return false;
  }
  if (!data.projects.length) return data.selectedProjectId === null && data.selectedSessionId === null;
  const selected = data.projects.find((project) => project.id === data.selectedProjectId);
  return !!selected && selected.selectedSessionId === data.selectedSessionId;
}

// Separate from room state and shared creations. Existing atomic I/O preserves damaged originals.
export class TaskStore {
  constructor(dataDir, clock = Date.now) {
    this.file = path.join(dataDir, 'tasks-state.json');
    this.clock = clock;
    this.warnings = [];
    this.data = readJsonFile(this.file, fresh(), { validate: valid, onRecovery: (message) => this.warnings.push(message) });
    let interrupted = false;
    for (const project of this.data.projects) for (const entry of project.sessions) {
      if (['preparing', 'running'].includes(entry.analysis?.status)) {
        entry.analysis.status = 'failed';
        entry.analysis.error = '서버가 재시작되어 이전 실행이 중단되었습니다. 자동으로 다시 실행하지 않습니다.';
        interrupted = true;
      }
    }
    if (interrupted) writeJsonFile(this.file, this.data);
  }

  view() {
    const data = structuredClone(this.data);
    for (const project of data.projects) project.folder = taskFolderStatus(project.folderPath);
    return { ...data, warnings: [...this.warnings] };
  }

  files(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('올바른 파일 조회 요청이 아닙니다.');
    const project = this.data.projects.find((item) => item.id === body.projectId);
    if (!project) fail('프로젝트를 찾을 수 없습니다.', 404);
    return taskProjectFiles(project.folderPath, body.path, body.action);
  }

  commit(next) {
    if (Buffer.byteLength(JSON.stringify(next)) > 16 * 1024 * 1024) fail('작업대 저장 용량(16MB)을 초과했습니다.', 413);
    writeJsonFile(this.file, next);
    this.data = next;
    return this.view();
  }

  beginAnalysis({ projectId, sessionId, revision, consent, mode = 'analysis', provider = 'claude' }, files, requestText = null) {
    if (!PROVIDERS.includes(provider)) fail('지원하지 않는 AI입니다.');
    const next = structuredClone(this.data);
    const project = next.projects.find((p) => p.id === projectId);
    const entry = project?.sessions.find((s) => s.id === sessionId);
    if (!entry) fail('프로젝트의 세션을 찾을 수 없습니다.', 404);
    if (consent !== true) fail('AI 서비스로 자료를 전송하는 데 동의해야 합니다.', 403);
    // A plan-based run has its own stored request; the session draft is neither required nor consumed.
    if (requestText === null) {
      if (revision !== entry.revision) fail('초안이 변경되었습니다. 새로고침 후 다시 확인하세요.', 409);
      if (!entry.draft.trim()) fail('AI에게 요청할 내용을 입력하세요.');
    }
    if (entry.messages.length > 1998) fail('세션의 메시지 한도에 도달했습니다.');
    const id = randomUUID();
    project.analysisConsent = true;
    entry.messages.push({ id: randomUUID(), role: 'user', text: requestText ?? entry.draft, at: this.clock(), runId: id, files });
    if (requestText === null) { entry.draft = ''; entry.revision++; }
    entry.analysis = { id, provider, mode, status: 'preparing', at: this.clock(), error: '' };
    this.commit(next);
    return id;
  }

  // Progress of a read-only autonomous exploration; files actually read are recorded on the request message.
  recordExploration(projectId, sessionId, id, explore) {
    const next = structuredClone(this.data);
    const entry = next.projects.find((p) => p.id === projectId)?.sessions.find((s) => s.id === sessionId);
    if (!entry || entry.analysis?.id !== id || !['preparing', 'running'].includes(entry.analysis.status)) fail('유효하지 않은 AI 실행입니다.', 409);
    entry.analysis.explore = explore;
    const message = entry.messages.find((m) => m.runId === id && m.role === 'user');
    if (message) message.files = explore.files.map((file) => file.path);
    return this.commit(next);
  }

  finishAnalysis(projectId, sessionId, id, status, text = '', proposalId = null, planId = null, changeId = null) {
    const next = structuredClone(this.data);
    const entry = next.projects.find((p) => p.id === projectId)?.sessions.find((s) => s.id === sessionId);
    if (!entry || entry.analysis?.id !== id || !['preparing', 'running'].includes(entry.analysis.status)) fail('유효하지 않은 AI 실행입니다.', 409);
    if (!['running', 'completed', 'failed', 'cancelled'].includes(status)) fail('유효하지 않은 AI 상태입니다.');
    if (status === 'completed') {
      if (!textOK(text) || !text.trim()) fail('유효한 AI 답변을 받지 못했습니다.');
      entry.messages.push({ id: randomUUID(), role: 'assistant', provider: entry.analysis.provider, runId: id, text, at: this.clock(),
        ...(proposalId ? { proposalId } : {}), ...(planId ? { planId } : {}), ...(changeId ? { changeId } : {}) });
      if (changeId) entry.analysis.changeId = changeId;
      if (planId) entry.analysis.planId = planId;
      if (proposalId) entry.analysis.proposalId = proposalId;
    }
    entry.analysis.status = status;
    entry.analysis.error = status === 'failed' || status === 'cancelled' ? text : '';
    return this.commit(next);
  }

  apply(body, selectedFolder) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('올바른 작업대 요청이 아닙니다.');
    const next = structuredClone(this.data);
    const now = this.clock();
    if (body.action === 'project.create' || body.action === 'project.createLinked') {
      const folderPath = body.action === 'project.createLinked' ? validateTaskFolder(selectedFolder) : null;
      const name = body.name?.trim() || (folderPath ? path.basename(folderPath) : '');
      if (!nameOK(name)) fail('프로젝트 이름은 1~100자로 입력하세요.');
      if (next.projects.length >= 100) fail('프로젝트는 최대 100개까지 저장할 수 있습니다.');
      const first = session(now);
      const project = { id: randomUUID(), name, createdAt: now, sessions: [first], selectedSessionId: first.id };
      if (folderPath) project.folderPath = folderPath;
      next.projects.push(project);
      next.selectedProjectId = project.id;
      next.selectedSessionId = first.id;
    } else {
      const project = next.projects.find((item) => item.id === body.projectId);
      if (!project) fail('프로젝트를 찾을 수 없습니다.', 404);
      if (body.action === 'folder.pick') {
        project.folderPath = validateTaskFolder(selectedFolder);
      } else if (body.action === 'folder.disconnect') {
        project.folderPath = null;
      } else if (body.action === 'folder.check') {
        return this.view();
      } else if (body.action === 'project.rename') {
        if (!nameOK(body.name)) fail('프로젝트 이름은 1~100자로 입력하세요.');
        project.name = body.name.trim();
      } else if (body.action === 'session.create') {
        if (project.sessions.length >= 200) fail('프로젝트마다 세션은 최대 200개까지 저장할 수 있습니다.');
        const created = session(now);
        project.sessions.push(created);
        project.selectedSessionId = next.selectedSessionId = created.id;
        next.selectedProjectId = project.id;
      } else if (body.action === 'select') {
        const selected = body.sessionId ?? project.selectedSessionId;
        if (!project.sessions.some((item) => item.id === selected)) fail('이 프로젝트의 세션이 아닙니다.', 404);
        project.selectedSessionId = next.selectedSessionId = selected;
        next.selectedProjectId = project.id;
      } else if (body.action === 'draft.save' || body.action === 'message.add') {
        const entry = project.sessions.find((item) => item.id === body.sessionId);
        if (!entry) fail('이 프로젝트의 세션이 아닙니다.', 404);
        if (body.action === 'message.add') {
          if (!idOK(body.messageId) || body.role !== undefined) fail('사용자 메시지만 저장할 수 있습니다.');
          // A repeated request after a lost response must not add a second message.
          if (entry.messages.some((message) => message.id === body.messageId)) return this.view();
          if (next.projects.some((p) => p.id === body.messageId || p.sessions.some((s) => s.id === body.messageId || s.messages.some((m) => m.id === body.messageId)))) {
            fail('이미 사용된 메시지 ID입니다.', 409);
          }
        }
        if (!Number.isSafeInteger(body.revision) || body.revision !== entry.revision) {
          fail('다른 창에서 이 세션이 변경되었습니다. 입력 내용을 복사한 뒤 새로고침해 주세요.', 409);
        }
        if (body.action === 'draft.save') {
          if (!textOK(body.text)) fail(`입력은 ${TEXT_LIMIT}자까지 저장할 수 있습니다.`);
          entry.draft = body.text;
        } else {
          if (!entry.draft.trim()) fail('저장할 메시지를 입력하세요.');
          if (entry.messages.length >= 2000) fail('한 세션에 메시지는 최대 2,000개까지 저장할 수 있습니다.');
          entry.messages.push({ id: body.messageId, role: 'user', text: entry.draft, at: now });
          entry.draft = '';
        }
        entry.revision++;
      } else fail('지원하지 않는 작업대 기능입니다.');
    }
    // Only publish state after a durable write; a failed disk write cannot acknowledge unsaved data.
    return this.commit(next);
  }
}
