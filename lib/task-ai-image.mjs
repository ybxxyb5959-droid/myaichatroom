import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeImage, validateImageEdit, siblingName, IMAGE_MIME, IMAGE_LIMITS } from './task-image.mjs';
import { taskFolderStatus, resolveTaskEntry } from './task-folder.mjs';
import { imageInfo } from './task-office-common.mjs';

// Image features of the workbench (a mixin for TaskAI): metadata, local edits, AI analysis, and generation/edit through the
// image-capable CLIs the chat room already uses (Codex, Gemini/agy, Grok). Results are never written straight into the
// project: they become a pending change set the user previews and approves, and originals are never modified.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const IMAGE_PROVIDERS = {
  gpt: { name: 'ChatGPT · Codex 이미지 생성', cli: 'codex', note: 'ChatGPT 구독 로그인(codex login)의 이미지 생성 사용량을 사용합니다. 편집은 원본을 참조로 새 이미지를 만듭니다.', edit: true },
  gemini: { name: 'Gemini · agy 이미지 생성', cli: 'agy', note: 'agy 로그인의 이미지 생성 기능을 사용합니다. 편집은 원본을 참조로 새 이미지를 만듭니다.', edit: true },
  grok: { name: 'Grok 이미지 생성', cli: 'grok', note: 'Grok 로그인을 사용합니다. 생성만 지원합니다(참조 편집은 별도 설정 필요).', edit: false },
};
// Whether a project-relative path is already taken (a missing parent folder counts as free).
const taken = (root, relative) => { try { fs.lstatSync(path.join(root, ...relative.split('/'))); return true; } catch (error) { return !['ENOENT', 'ENOTDIR'].includes(error.code); } };
const unique = (relative, isTaken) => {
  if (!isTaken(relative)) return relative;
  const dot = relative.lastIndexOf('.');
  for (let n = 2; n < 1000; n++) { const candidate = `${relative.slice(0, dot)}-${n}${relative.slice(dot)}`; if (!isTaken(candidate)) return candidate; }
  return fail('새 파일 이름을 정하지 못했습니다.');
};
const slug = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'image';

export const imageMethods = {
  // Installed CLIs only; whether the login works is reported by a free status call where the CLI has one.
  imageProviders() {
    const have = this.adapter?.available?.() || {};
    return Object.entries(IMAGE_PROVIDERS).map(([id, info]) => ({ id, name: info.name, note: info.note, canEdit: info.edit, installed: !!have[id] }));
  },
  async imageProviderStatus(signal) {
    const out = [];
    for (const item of this.imageProviders()) {
      let login = { status: item.installed ? 'unknown' : 'missing', detail: item.installed ? '이 CLI는 사용량 없이 로그인 상태를 확인할 수 없습니다. 실제 생성 시 확인됩니다.' : 'CLI가 설치되어 있지 않습니다.' };
      if (item.installed && this.adapter.loginStatus) { try { login = await this.adapter.loginStatus(item.id) || login; } catch { /* keep unknown */ } }
      out.push({ ...item, login: login.status, detail: login.detail, ready: item.installed && login.status !== 'fail' });
    }
    void signal;
    return { providers: out, costNote: '이미지 생성·편집은 각 구독의 사용량을 사용합니다. 별도 API 키나 추가 결제는 사용하지 않으며, 실행 전에 동의를 받습니다.' };
  },

  // A project image or an attachment, read with the same policies as everything else.
  imageSource(project, source) {
    if (!source || typeof source !== 'object') fail('이미지 출처가 필요합니다.');
    if (source.kind === 'attachment') {
      const item = this.attachments.get(project.id, source.id);
      if (item.kind !== 'image') fail('이미지 첨부가 아닙니다.');
      if (item.size > IMAGE_LIMITS.sourceBytes) fail('이미지가 너무 큽니다.');
      return { bytes: fs.readFileSync(this.attachments.blobPath(item)), name: item.name, relative: null, ref: `att:${item.id}` };
    }
    if (source.kind === 'file') {
      if (taskFolderStatus(project.folderPath).state !== 'connected') fail('프로젝트 폴더가 연결되어 있지 않습니다.');
      let entry;
      try { entry = resolveTaskEntry(project.folderPath, source.path); } catch (error) { fail(error.message, error.status || 403); }
      if (!entry.stat.isFile() || entry.stat.nlink > 1) fail('일반 이미지 파일이 아닙니다.', 403);
      if (!IMAGE_MIME[path.extname(entry.target).toLowerCase()]) fail('PNG·JPEG·GIF·WebP 이미지만 지원합니다.');
      if (entry.stat.size > IMAGE_LIMITS.sourceBytes) fail('이미지가 너무 큽니다.');
      return { bytes: fs.readFileSync(entry.target), name: path.basename(entry.target), relative: source.path, ref: source.path };
    }
    return fail('이미지 출처는 file 또는 attachment여야 합니다.');
  },
  describeImageSource(body) {
    const project = this.store.data.projects.find((p) => p.id === body.projectId);
    if (!project) fail('프로젝트를 찾을 수 없습니다.', 404);
    const { bytes, name } = this.imageSource(project, body.source);
    return { name, ...describeImage(bytes) };
  },

  // Deterministic edit (crop/resize/rotate/flip/grayscale/brightness/contrast/invert) -> new PNG as a pending change set.
  localImage(body) {
    const project = this.store.data.projects.find((p) => p.id === body.projectId);
    const entry = project?.sessions.find((s) => s.id === body.sessionId);
    if (!entry) fail('프로젝트의 세션을 찾을 수 없습니다.', 404);
    if (taskFolderStatus(project.folderPath).state !== 'connected') fail('결과를 저장할 프로젝트 폴더를 먼저 연결하세요.');
    if (this.job) fail('AI 실행이 끝난 뒤 편집하세요.', 409);
    const source = this.imageSource(project, body.source);
    const facts = describeImage(source.bytes);
    if (!facts.editable) fail(`${facts.format} 이미지는 로컬 편집을 지원하지 않습니다(PNG만 가능). AI 이미지 편집을 사용하거나 PNG로 변환하세요.`);
    const edit = validateImageEdit({ source: source.ref, ops: body.ops });
    const base = source.relative || `images/${source.name}`;
    const target = siblingName(base, (relative) => taken(project.folderPath, relative), 'edited', '.png');
    const set = this.changes.create({ projectId: project.id, sessionId: entry.id, runId: randomUUID(), folderPath: project.folderPath, title: `이미지 편집: ${source.name}`,
      summary: edit.ops.map((o) => o.op).join(' → ') }, [{ type: 'create', path: target, image: edit, reason: `원본(${source.name})은 그대로 두고 편집한 새 PNG` }]);
    return { setId: set.id, path: target };
  },

  // generate / edit through an image CLI. The run is cancellable and every outcome is reported as it really was.
  startImage(body, project, entry) {
    const provider = IMAGE_PROVIDERS[body.imageProvider];
    if (!provider) fail('지원하는 이미지 생성 AI를 선택하세요.');
    const action = body.imageAction === 'edit' ? 'edit' : 'generate';
    if (body.consentImage !== true) fail('이미지 생성 요청(과 참조 이미지)이 외부 AI 서비스로 전송되고 구독 사용량을 쓰는 데 동의해야 합니다.', 403);
    const have = this.adapter?.available?.() || {};
    if (!have[body.imageProvider] || typeof this.adapter.image !== 'function') fail(`${provider.name} CLI가 설치되어 있지 않아 사용할 수 없습니다.`);
    if (action === 'edit' && !provider.edit) fail(`${provider.name}은(는) 참조 이미지 편집을 지원하지 않습니다. 생성만 가능합니다.`);
    if (taskFolderStatus(project.folderPath).state !== 'connected') fail('결과를 저장할 프로젝트 폴더를 먼저 연결하세요.');
    this.changes.capacity(project.id, entry.id);
    const reference = action === 'edit' ? this.imageSource(project, body.source) : null;
    if (reference) describeImage(reference.bytes);
    const prompt = entry.draft.trim();
    const id = this.store.beginAnalysis({ ...body, mode: 'image' }, reference ? [reference.name] : []);
    const controller = new AbortController();
    const job = this.job = { id, projectId: project.id, sessionId: entry.id, controller, done: null };
    this.storageError = '';
    this.runs.begin({ id, projectId: project.id, sessionId: entry.id, mode: 'image', provider: 'claude', request: prompt });
    const ev = (e) => this.runs.event(id, e);
    job.done = (async () => {
      let refDir = null;
      try {
        this.store.finishAnalysis(job.projectId, job.sessionId, id, 'running');
        ev({ kind: 'step', text: `${provider.name} 연결 확인 완료(설치됨)`, state: 'done' });
        let refSheet = null;
        if (reference) {
          refDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-image-ref-'));
          refSheet = path.join(refDir, `reference${path.extname(reference.name) || '.png'}`);
          fs.writeFileSync(refSheet, reference.bytes);
          ev({ kind: 'file', text: `참조 이미지 준비: ${reference.name} (원본은 수정하지 않음)`, state: 'done' });
        }
        ev({ kind: 'ai', text: `${provider.name}에 이미지 ${action === 'edit' ? '편집' : '생성'} 요청 중 (최대 4분)`, state: 'active', key: 'ai:1' });
        const asked = action === 'edit' ? `Edit the attached image as requested and keep everything that was not mentioned unchanged: ${prompt}` : prompt;
        const result = await this.adapter.image(body.imageProvider, asked, { signal: controller.signal, refSheet, refMode: action === 'edit' ? 'edit' : 'look' });
        if (controller.signal.aborted) throw new Error('AI 실행을 취소했습니다.');
        if (!result?.ok || !result.file || !fs.existsSync(result.file)) {
          ev({ kind: 'ai', text: '이미지가 만들어지지 않았습니다', state: 'failed', key: 'ai:1' });
          throw new Error(`${provider.name}이(가) 이미지를 만들지 못했습니다. 로그인·사용량 한도·이미지 생성 지원 여부를 확인하세요. (${String(result?.detail || '').replace(/\s+/g, ' ').slice(0, 160)})`);
        }
        const stat = fs.statSync(result.file);
        if (stat.size > IMAGE_LIMITS.sourceBytes) throw new Error('생성된 이미지가 너무 커서 사용하지 않았습니다.');
        const bytes = fs.readFileSync(result.file);
        const info = imageInfo(bytes);
        if (!info) throw new Error('생성된 파일이 올바른 이미지(PNG·JPEG·GIF)가 아니라 사용하지 않았습니다.');
        ev({ kind: 'ai', text: `이미지 수신 (${info.width}×${info.height} ${info.ext.toUpperCase()}, ${(bytes.length / 1024).toFixed(0)}KB)`, state: 'done', key: 'ai:1' });
        const ext = info.ext === 'jpeg' ? '.jpg' : `.${info.ext}`;
        const when = new Date(this.clock()), pad = (n) => String(n).padStart(2, '0');
        const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
        const target = unique(`images/${slug(prompt)}-${stamp}${ext}`, (relative) => taken(project.folderPath, relative));
        const set = this.changes.create({ projectId: job.projectId, sessionId: job.sessionId, runId: id, folderPath: project.folderPath, title: `AI 이미지 ${action === 'edit' ? '편집' : '생성'}`,
          summary: prompt.slice(0, 300) }, [{ type: 'create', path: target, bytes, reason: `${provider.name}이(가) ${action === 'edit' ? '원본을 참조해 만든 편집본' : '만든 이미지'}` }]);
        try { if (result.file.startsWith(path.join(this.adapter.root || '', 'data'))) fs.rmSync(path.dirname(result.file), { recursive: true, force: true }); } catch { /* left for maintenance */ }
        ev({ kind: 'save', text: `이미지 변경안 저장 (${target})`, state: 'done' });
        const text = `${provider.name}으로 이미지를 ${action === 'edit' ? '편집' : '생성'}했습니다.\n저장 예정 위치: ${set.ops[0].path}\n\n아직 프로젝트 폴더에는 저장되지 않았습니다. 변경안 보기에서 미리보기를 확인하고 승인하면 저장됩니다. 원본 이미지는 바뀌지 않습니다.`;
        this.store.finishAnalysis(job.projectId, job.sessionId, id, 'completed', text, null, null, set.id);
        this.runs.finish(id, 'completed');
      } catch (error) {
        const reason = controller.signal.aborted ? 'AI 실행을 취소했습니다.' : error.message;
        this.runs.finish(id, controller.signal.aborted ? 'cancelled' : 'failed', reason);
        try { this.store.finishAnalysis(job.projectId, job.sessionId, id, controller.signal.aborted ? 'cancelled' : 'failed', reason); } catch { this.storageError = 'AI 실행 결과를 디스크에 저장하지 못했습니다. 저장 공간·권한을 확인하세요.'; }
      } finally {
        if (refDir) fs.rmSync(refDir, { recursive: true, force: true });
        if (this.job === job) this.job = null;
      }
    })();
    return this.view();
  },

  // Looking at pictures: Claude (stream-json image blocks) or Codex (--image). Nothing is written.
  startImageAnalysis(body, project, entry, provider) {
    const sources = Array.isArray(body.sources) ? body.sources : [];
    if (!sources.length || sources.length > 4) fail('분석할 이미지를 1~4개 선택하세요.');
    if (typeof provider.analyze !== 'function' || !provider.imageCapable) fail(`${provider.shortName || '이 AI'}은(는) 이미지 분석을 지원하지 않습니다. Claude 또는 Codex를 선택하세요.`);
    if (body.consentAttachments !== true) fail('이미지 내용이 AI 서비스로 전송되는 데 동의해야 합니다.', 403);
    const images = sources.map((src) => { const item = this.imageSource(project, src); const facts = describeImage(item.bytes); return { ...item, facts, mime: imageInfo(item.bytes)?.mime || 'image/png' }; });
    for (const image of images) if (image.bytes.length > 8 * 1024 * 1024) fail(`${image.name}: 분석에는 8MB 이하 이미지를 사용하세요(또는 로컬 편집으로 크기를 줄이세요).`);
    const request = entry.draft;
    const id = this.store.beginAnalysis({ ...body, mode: 'image.analyze' }, images.map((i) => i.name));
    const controller = new AbortController();
    const job = this.job = { id, projectId: project.id, sessionId: entry.id, controller, done: null };
    this.storageError = '';
    this.runs.begin({ id, projectId: project.id, sessionId: entry.id, mode: 'image.analyze', provider: body.provider, request });
    const ev = (e) => this.runs.event(id, e);
    job.done = (async () => {
      try {
        ev({ kind: 'step', text: `${provider.shortName} CLI 로그인·안전 설정 확인 중`, state: 'active', key: 'prepare' });
        await provider.prepare(controller.signal);
        ev({ kind: 'step', text: `${provider.shortName} CLI 로그인·안전 설정 확인 완료`, state: 'done', key: 'prepare' });
        this.store.finishAnalysis(job.projectId, job.sessionId, id, 'running');
        ev({ kind: 'file', text: `이미지 ${images.length}개 준비 (${images.map((i) => `${i.name} ${i.facts.width}×${i.facts.height}`).join(', ')})`, state: 'done' });
        ev({ kind: 'ai', text: `${provider.shortName} 이미지 분석 응답 대기 중`, state: 'active', key: 'ai:1' });
        const text = await provider.analyze(JSON.stringify({ request, images: images.map((i) => ({ name: i.name, facts: { format: i.facts.format, width: i.facts.width, height: i.facts.height } })) }),
          { signal: controller.signal, mode: 'image', images: images.map((i) => ({ mime: i.mime, bytes: i.bytes, name: i.name })) });
        ev({ kind: 'ai', text: `${provider.shortName} 응답 수신`, state: 'done', key: 'ai:1' });
        this.store.finishAnalysis(job.projectId, job.sessionId, id, 'completed', String(text).slice(0, 15900));
        ev({ kind: 'save', text: '이미지 분석 결과 저장', state: 'done' });
        this.runs.finish(id, 'completed');
      } catch (error) {
        const reason = controller.signal.aborted ? 'AI 실행을 취소했습니다.' : this.named(provider, error.message);
        this.runs.finish(id, controller.signal.aborted ? 'cancelled' : 'failed', reason);
        try { this.store.finishAnalysis(job.projectId, job.sessionId, id, controller.signal.aborted ? 'cancelled' : 'failed', reason); } catch { this.storageError = 'AI 실행 결과를 디스크에 저장하지 못했습니다. 저장 공간·권한을 확인하세요.'; }
      } finally { if (this.job === job) this.job = null; }
    })();
    return this.view();
  },
};
