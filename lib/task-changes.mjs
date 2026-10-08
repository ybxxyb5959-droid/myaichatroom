import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFile, writeFileAtomic, writeToFd, retryFile, replaceFile } from './atomic.mjs';
import { relativeParts, resolveTaskEntry, TEXT_EXTENSIONS, TASK_TEMP_NAME, fileFail } from './task-folder.mjs';
import { acquireLock } from './task-safety.mjs';
import { renderDocument, editDocument, officeKind } from './task-office.mjs';
import { previewTextSync } from './task-extract.mjs';
import { validateImageEdit, applyImageEdit } from './task-image.mjs';

// Change sets: approved batches of file operations (create / modify / rename-move / delete) on one project folder.
// Every operation is validated by the same path policy as browsing, backed up before it touches anything,
// journaled before and after each step, verified by SHA-256, and undoable from the stored backups.
// A "delete" never loses data: the original bytes stay in the app's backup folder until pruned.
export const CHANGE_LIMITS = { ops: 20, textBytes: 512 * 1024, fileBytes: 32 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, sets: 40, perSession: 10,
  storeBytes: 2 * 1024 * 1024, titleChars: 200, reasonChars: 500, diffLines: 2000 };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const uuid = (id) => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const HEX = /^[0-9a-f]{64}$/;
const win = process.platform === 'win32';
const norm = (p) => (win ? p.toLowerCase() : p);
const TYPES = ['create', 'modify', 'rename', 'delete'];
const OFFICE = new Set(['.docx', '.pptx', '.xlsx']);
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const EXTRA_TEXT = new Set(['.toml', '.ini', '.cfg', '.log', '.rst', '.tex', '.sql', '.svg', '.vue', '.svelte', '.scss', '.less', '.sh', '.gitignore']);
// Files that can run or install code are never created, renamed to, or modified by the workbench.
const DANGEROUS = new Set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.vbs', '.vbe', '.wsf', '.wsh', '.lnk', '.scr', '.msi', '.msp', '.com',
  '.jar', '.reg', '.hta', '.cpl', '.pif', '.gadget', '.appx', '.msix', '.sys', '.drv', '.ocx', '.lib', '.so', '.dylib', '.app', '.apk', '.dmg']);
export const WRITABLE = new Set([...TEXT_EXTENSIONS, ...EXTRA_TEXT, ...OFFICE, ...IMAGES]);
const isText = (relative) => { const ext = path.extname(relative).toLowerCase(); return TEXT_EXTENSIONS.has(ext) || EXTRA_TEXT.has(ext) || relative.toLowerCase().endsWith('.gitignore'); };
const extOf = (relative) => path.extname(relative).toLowerCase();
export const UNRESOLVED_CHANGES = ['applying', 'restoring', 'partial', 'manual', 'restore_failed'];
const STATUSES = ['pending', 'approved', 'rejected', 'conflict', 'applying', 'applied', 'apply_failed', 'partial', 'restoring', 'restored', 'restore_failed', 'manual'];
const HISTORY_LIMIT = 20;
const CONFIRM_MS = 5 * 60000;

function checkWriteName(relative, what) {
  const ext = extOf(relative), base = path.posix.basename(relative);
  if (DANGEROUS.has(ext)) fail(`${what}: 실행·설치 파일 형식(${ext})은 작업대에서 만들거나 바꿀 수 없습니다.`);
  if (TASK_TEMP_NAME.test(base)) fail(`${what}: 앱 내부 임시 파일 이름은 사용할 수 없습니다.`);
  if (!WRITABLE.has(ext) && !base.toLowerCase().endsWith('.gitignore')) fail(`${what}: 지원하는 텍스트·문서·이미지 형식만 만들 수 있습니다 (${ext || '확장자 없음'}).`);
}

// Walks an existing-or-new relative path inside the project without following links.
function probe(root, relative) {
  const parts = relativeParts(relative);
  if (!parts.length) fileFail('경로가 비어 있습니다.', 400);
  let current = root, missing = [];
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(current, parts[i]);
    let stat = null;
    try { stat = fs.lstatSync(next); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!stat) { missing = parts.slice(i); break; }
    if (stat.isSymbolicLink()) fileFail('심볼릭 링크와 연결 지점은 사용할 수 없습니다.');
    if (i < parts.length - 1 && !stat.isDirectory()) fileFail('경로의 중간 항목이 폴더가 아닙니다.', 400);
    current = next;
  }
  const exists = !missing.length;
  const real = fs.realpathSync(exists ? current : current);
  const inside = path.relative(root, real);
  if (path.isAbsolute(inside) || inside === '..' || inside.startsWith(`..${path.sep}`)) fileFail('프로젝트 외부 경로에는 접근할 수 없습니다.');
  return { exists, missing, parent: exists ? path.dirname(current) : current, target: path.join(current, ...missing), isFile: exists && fs.lstatSync(current).isFile() };
}

function readFileBytes(root, relative, limit = CHANGE_LIMITS.fileBytes) {
  const entry = resolveTaskEntry(root, relative);
  if (!entry.stat.isFile()) fileFail('파일이 아닌 경로입니다.', 400);
  if (entry.stat.size > limit) fileFail(`${Math.round(limit / 1048576)}MB를 초과한 파일은 이 작업에서 처리하지 않습니다.`, 400);
  const bytes = fs.readFileSync(entry.target);
  const again = fs.lstatSync(entry.target);
  if (bytes.length !== again.size) fileFail('읽는 동안 파일이 변경되었습니다.', 409);
  return { target: entry.target, bytes, stat: again };
}
const currentHash = (root, relative) => { try { return sha(readFileBytes(root, relative).bytes); } catch { return null; } };
const absent = (root, relative) => { try { return !probe(root, relative).exists; } catch { return false; } };

// Exclusive create: the final name only ever appears with complete content, and an existing file is never replaced.
function createExclusive(temp, final, bytes) {
  const fd = retryFile(() => fs.openSync(temp, 'wx', 0o666));
  try { writeToFd(fd, bytes); } finally { fs.closeSync(fd); }
  try { fs.linkSync(temp, final); fs.unlinkSync(temp); return; } catch (error) {
    if (error.code === 'EEXIST') { try { fs.unlinkSync(temp); } catch { /* cleaned by recovery */ } fail('같은 이름의 파일이 이미 있어 만들지 않았습니다.', 409); }
    if (!['EPERM', 'ENOSYS', 'EINVAL', 'ENOTSUP', 'EXDEV', 'EMLINK'].includes(error.code)) throw error;
  }
  // File systems without hard links: exclusive open of the final name instead.
  const fd2 = fs.openSync(final, 'wx', 0o666);
  try { writeToFd(fd2, bytes); } catch (error) { fs.closeSync(fd2); try { fs.unlinkSync(final); } catch { /* reported by verify */ } throw error; }
  fs.closeSync(fd2);
  try { fs.unlinkSync(temp); } catch { /* cleaned by recovery */ }
}
function moveExclusive(from, to) {
  try { fs.linkSync(from, to); fs.unlinkSync(from); return; } catch (error) {
    if (error.code === 'EEXIST') fail('이동할 위치에 같은 이름의 파일이 이미 있습니다.', 409);
    if (!['EPERM', 'ENOSYS', 'EINVAL', 'ENOTSUP', 'EXDEV', 'EMLINK'].includes(error.code)) throw error;
  }
  if (fs.existsSync(to)) fail('이동할 위치에 같은 이름의 파일이 이미 있습니다.', 409);
  retryFile(() => fs.renameSync(from, to));
}
function mkdirs(root, relative, created) {
  const parts = relativeParts(relative).slice(0, -1);
  let dir = root;
  for (const part of parts) {
    dir = path.join(dir, part);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir); created.push(path.relative(root, dir).split(path.sep).join('/')); }
  }
}
function rmCreatedDirs(root, created) {
  for (const rel of [...created].reverse()) { try { fs.rmdirSync(path.join(root, ...rel.split('/'))); } catch { /* not empty or gone: left alone */ } }
}

// Project pictures a document may embed: a validated project path, never an arbitrary location.
export function projectImageResolver(root, extra = () => null) {
  return (source) => {
    const other = extra(source);
    if (other) return other;
    if (typeof source !== 'string' || source.startsWith('att:')) return null;
    try { return readFileBytes(root, source, 8 * 1024 * 1024).bytes; } catch { return null; }
  };
}

// ---- validation and construction ----
// raw op: {type, path, to?, bytes?|content?, reason?}. Disk state is read now; nothing is written.
export function buildOps(root, rawOps, { blobBytes = (op) => (op.bytes ?? (typeof op.content === 'string' ? Buffer.from(op.content, 'utf8') : null)), resolveImage = projectImageResolver(root) } = {}) {
  if (!Array.isArray(rawOps) || !rawOps.length) fail('변경할 작업이 없습니다.');
  if (rawOps.length > CHANGE_LIMITS.ops) fail(`한 번에 최대 ${CHANGE_LIMITS.ops}개 작업까지 제안할 수 있습니다.`);
  const used = new Set();
  const claim = (relative) => {
    const key = norm(relative);
    if (used.has(key)) fail(`같은 경로가 여러 작업에 쓰였습니다: ${relative}`);
    used.add(key);
  };
  let total = 0;
  const ops = rawOps.map((rawIn, index) => {
    const label = `작업 ${index + 1}(${rawIn?.path})`;
    let raw = rawIn, previewBefore = null;
    // Office documents are rendered or edited by the server from a validated spec; the model never writes binary.
    if (raw && typeof raw === 'object' && typeof raw.path === 'string' && officeKind(raw.path) && raw.document === undefined && raw.edit === undefined && (raw.type === 'create' || raw.type === 'modify') && raw.bytes === undefined) {
      fail(`${label}: Office 문서(.docx·.xlsx·.pptx)는 content가 아니라 document(생성) 또는 edit(수정)로 지정해야 합니다.`);
    }
    if (raw && typeof raw === 'object' && raw.image !== undefined) {
      try {
        if (raw.type !== 'create' || raw.content !== undefined || raw.document !== undefined) fail('image는 create 작업에서만, 다른 내용 항목 없이 쓸 수 있습니다.');
        if (extOf(raw.path) !== '.png') fail('편집한 이미지는 .png 파일로 저장합니다.');
        const spec = validateImageEdit(raw.image);
        const source = resolveImage(spec.source);
        if (!Buffer.isBuffer(source)) fail('원본 이미지를 찾을 수 없습니다.');
        raw = { ...raw, bytes: applyImageEdit(source, spec.ops) };
      } catch (error) { fail(`${label}: ${error.message}`, error.status || 400); }
    }
    if (raw && typeof raw === 'object' && (raw.document !== undefined || raw.edit !== undefined)) {
      try {
        if (raw.content !== undefined) fail('content와 document/edit를 함께 쓸 수 없습니다.');
        if (raw.type === 'create' && raw.document !== undefined) raw = { ...raw, bytes: renderDocument(raw.path, raw.document, { resolveImage }) };
        else if (raw.type === 'modify' && raw.edit !== undefined) {
          const current = readFileBytes(root, raw.path);
          if (!officeKind(raw.path)) fail('document/edit는 .docx·.xlsx·.pptx 파일에만 쓸 수 있습니다.');
          previewBefore = previewTextSync(current.bytes, officeKind(raw.path));
          raw = { ...raw, bytes: editDocument(raw.path, current.bytes, raw.edit, { resolveImage }) };
        } else fail('document는 create, edit는 modify 작업에서만 쓸 수 있습니다.');
      } catch (error) { fail(`${label}: ${error.message}`, error.status || 400); }
    }
    if (!raw || !TYPES.includes(raw.type) || typeof raw.path !== 'string') fail(`${label}: 형식이 올바르지 않습니다.`);
    if (raw.reason !== undefined && (typeof raw.reason !== 'string' || raw.reason.length > CHANGE_LIMITS.reasonChars)) fail(`${label}: 이유가 너무 깁니다.`);
    let state;
    try { state = probe(root, raw.path); } catch (error) { fail(`${label}: ${error.message}`, error.status || 400); }
    claim(raw.path);
    const op = { id: randomUUID(), type: raw.type, path: raw.path, reason: (raw.reason || '').slice(0, CHANGE_LIMITS.reasonChars), state: 'queued' };
    if (raw.type === 'create' || raw.type === 'modify') {
      const bytes = blobBytes(raw);
      if (!Buffer.isBuffer(bytes)) fail(`${label}: 내용이 없습니다.`);
      const limit = isText(raw.path) ? CHANGE_LIMITS.textBytes : CHANGE_LIMITS.fileBytes;
      if (bytes.length > limit) fail(`${label}: 내용이 너무 큽니다 (최대 ${Math.round(limit / 1024)}KB).`);
      if (isText(raw.path)) {
        const text = bytes.toString('utf8');
        if (!text.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail(`${label}: 텍스트 파일에 올바르지 않은 문자가 있습니다.`);
      }
      total += bytes.length;
      op.afterHash = sha(bytes); op.afterBytes = bytes.length; op.kind = isText(raw.path) ? 'text' : 'binary';
      op.after = bytes;
      if (officeKind(raw.path)) {
        try { op.previewAfter = previewTextSync(bytes, officeKind(raw.path)); } catch (error) { fail(`${label}: 생성한 문서를 다시 읽지 못했습니다(${error.message})`, 500); }
        if (previewBefore !== null) op.previewBefore = previewBefore;
      }
    }
    if (raw.type === 'create') {
      checkWriteName(raw.path, label);
      if (state.exists) fail(`${label}: 같은 이름의 파일이나 폴더가 이미 있어 새로 만들 수 없습니다.`, 409);
    } else {
      if (!state.exists || !state.isFile) fail(`${label}: 대상 파일을 찾을 수 없습니다.`, 404);
      let current;
      try { current = readFileBytes(root, raw.path); } catch (error) { fail(`${label}: ${error.message}`, error.status || 400); }
      op.beforeHash = sha(current.bytes); op.beforeBytes = current.bytes.length; op.kind ??= isText(raw.path) ? 'text' : 'binary';
      op.before = current.bytes;
      total += raw.type === 'delete' || raw.type === 'modify' ? current.bytes.length : 0;
      if (raw.type === 'modify') {
        checkWriteName(raw.path, label);
        if (op.afterHash === op.beforeHash) fail(`${label}: 원본과 같은 내용이라 변경이 없습니다.`);
      }
      if (raw.type === 'rename') {
        if (typeof raw.to !== 'string' || norm(raw.to) === norm(raw.path)) fail(`${label}: 새 이름·위치가 올바르지 않습니다.`);
        checkWriteName(raw.to, `${label} → 대상`);
        if (extOf(raw.to) !== extOf(raw.path) && !WRITABLE.has(extOf(raw.path))) fail(`${label}: 이 형식은 확장자를 바꿀 수 없습니다.`);
        let dest;
        try { dest = probe(root, raw.to); } catch (error) { fail(`${label} → 대상: ${error.message}`, error.status || 400); }
        if (dest.exists) fail(`${label}: 이동할 위치에 같은 이름이 이미 있습니다.`, 409);
        claim(raw.to);
        op.to = raw.to;
      }
    }
    return op;
  });
  if (total > CHANGE_LIMITS.totalBytes) fail('이번 변경의 전체 크기가 제한(64MB)을 초과합니다.');
  return ops;
}

function valid(data) {
  if (data?.version !== 1 || !Array.isArray(data.sets) || data.sets.length > CHANGE_LIMITS.sets) return false;
  const ids = new Set();
  return data.sets.every((s) => {
    if (!s || !uuid(s.id) || ids.has(s.id) || !uuid(s.projectId) || !uuid(s.sessionId) || typeof s.folderPath !== 'string' || !STATUSES.includes(s.status)
      || typeof s.title !== 'string' || !Number.isSafeInteger(s.createdAt) || !Array.isArray(s.ops) || !s.ops.length) return false;
    ids.add(s.id);
    return s.ops.every((op) => op && uuid(op.id) && TYPES.includes(op.type) && typeof op.path === 'string'
      && (op.afterHash === undefined || HEX.test(op.afterHash)) && (op.beforeHash === undefined || HEX.test(op.beforeHash)));
  });
}

export class ChangeStore {
  constructor(store, { limitsOverride = {} } = {}) {
    this.store = store;
    this.dataDir = path.dirname(store.file);
    this.file = path.join(this.dataDir, 'task-changes.json');
    this.blobDir = path.join(this.dataDir, 'task-changes');
    this.lockFile = path.join(this.dataDir, 'task-write.lock');
    this.warnings = [];
    this.limits = { ...CHANGE_LIMITS, ...limitsOverride };
    this.confirmations = new Map();
    this.attachmentBytes = () => null; // set by the workbench: (projectId, id) -> Buffer | null
    this.faultHook = null; // test-only fault injection point; never set by the server
    this.data = readJsonFile(this.file, { version: 1, sets: [] }, { validate: valid, onRecovery: (m) => this.warnings.push(m) });
    this.recover();
  }
  now() { return this.store.clock(); }
  scope(projectId, sessionId) {
    const project = this.store.data.projects.find((p) => p.id === projectId);
    if (!project?.sessions.some((s) => s.id === sessionId)) fail('프로젝트의 세션을 찾을 수 없습니다.', 404);
    return project;
  }
  blob(set, op, kind) { return path.join(this.blobDir, set.id, `${op.id}.${kind}`); }
  commit(next) {
    if (Buffer.byteLength(JSON.stringify(next)) > this.limits.storeBytes) fail('변경안 저장 용량(2MB)을 초과했습니다.', 413);
    writeJsonFile(this.file, next);
    this.data = next;
  }
  save(set) {
    const next = structuredClone(this.data);
    next.sets[next.sets.findIndex((s) => s.id === set.id)] = structuredClone(set);
    this.commit(next);
  }
  locate(body) {
    this.scope(body.projectId, body.sessionId);
    const set = this.data.sets.find((s) => s.id === body.setId && s.projectId === body.projectId && s.sessionId === body.sessionId);
    if (!set) fail('이 세션의 변경안을 찾을 수 없습니다.', 404);
    return set;
  }
  capacity(projectId, sessionId) {
    this.scope(projectId, sessionId);
    if (this.data.sets.length >= this.limits.sets || this.data.sets.filter((s) => s.projectId === projectId && s.sessionId === sessionId).length >= this.limits.perSession) {
      fail('변경안 보관 한도(전체 40개·세션당 10개)에 도달했습니다. 기존 변경안은 자동 삭제하지 않습니다.');
    }
  }
  resolverFor(projectId, folderPath) {
    return projectImageResolver(folderPath, (source) => (typeof source === 'string' && source.startsWith('att:') ? this.attachmentBytes(projectId, source.slice(4)) : null));
  }
  unresolvedFor(projectId) { return this.data.sets.some((s) => s.projectId === projectId && UNRESOLVED_CHANGES.includes(s.status)); }

  // Stores a validated set. Contents are written as blob files (not in the JSON) and re-read before the record exists.
  create({ projectId, sessionId, runId, folderPath, title, summary = '' }, rawOps) {
    this.capacity(projectId, sessionId);
    const project = this.scope(projectId, sessionId);
    if (project.folderPath !== folderPath) fail('프로젝트의 연결 폴더가 변경되었습니다.', 409);
    const ops = buildOps(folderPath, rawOps, { resolveImage: this.resolverFor(projectId, folderPath) });
    const set = { id: randomUUID(), projectId, sessionId, runId, folderPath, title: String(title || '파일 변경안').slice(0, this.limits.titleChars),
      summary: String(summary || '').slice(0, 2000), createdAt: this.now(), status: 'pending', history: [], ops: [] };
    fs.mkdirSync(path.join(this.blobDir, set.id), { recursive: true });
    try {
      for (const op of ops) {
        const { after, before, previewAfter, previewBefore, ...meta } = op;
        if (previewAfter !== undefined) { writeFileAtomic(this.blob(set, op, 'pvafter'), previewAfter); meta.hasPreview = true; }
        if (previewBefore !== undefined) writeFileAtomic(this.blob(set, op, 'pvbefore'), previewBefore);
        if (after) { writeFileAtomic(this.blob(set, op, 'after'), after); if (sha(fs.readFileSync(this.blob(set, op, 'after'))) !== op.afterHash) fail('변경 내용을 저장하지 못했습니다.', 500); }
        set.ops.push(meta);
      }
      const next = structuredClone(this.data);
      next.sets.push(set);
      this.commit(next);
    } catch (error) { fs.rmSync(path.join(this.blobDir, set.id), { recursive: true, force: true }); throw error; }
    return structuredClone(set);
  }

  // ---- state of one operation on disk ----
  opState(set, op) {
    const root = set.folderPath;
    const here = currentHash(root, op.path);
    const exists = (p) => !absent(root, p);
    if (op.type === 'create') return !exists(op.path) ? 'before' : here === op.afterHash ? 'after' : 'unknown';
    if (op.type === 'modify') return here === op.beforeHash ? 'before' : here === op.afterHash ? 'after' : 'unknown';
    if (op.type === 'delete') return here === op.beforeHash ? 'before' : !exists(op.path) ? 'after' : 'unknown';
    const there = currentHash(root, op.to);
    if (here === op.beforeHash && !exists(op.to)) return 'before';
    if (!exists(op.path) && there === op.beforeHash) return 'after';
    return 'unknown';
  }
  backupBytes(set, op) {
    let bytes;
    try { bytes = fs.readFileSync(this.blob(set, op, 'before')); } catch { return null; }
    return sha(bytes) === op.beforeHash ? bytes : null;
  }
  afterBytes(set, op) {
    let bytes;
    try { bytes = fs.readFileSync(this.blob(set, op, 'after')); } catch { return null; }
    return sha(bytes) === op.afterHash ? bytes : null;
  }

  // ---- read-only verification ----
  verifyApply(set) {
    const blockers = [];
    const project = this.scope(set.projectId, set.sessionId);
    if (project.folderPath !== set.folderPath) return ['프로젝트의 연결 폴더가 변경되거나 해제되었습니다.'];
    if (set.status !== 'approved' && set.status !== 'apply_failed') {
      return [set.status === 'applied' ? '이미 적용된 변경안입니다. 필요하면 복구를 사용하세요.' : `적용할 수 없는 상태입니다(${set.status}).`];
    }
    const busy = (op) => this.data.sets.some((o) => o.id !== set.id && o.folderPath === set.folderPath && UNRESOLVED_CHANGES.includes(o.status)
      && o.ops.some((x) => [x.path, x.to].filter(Boolean).some((p) => [op.path, op.to].filter(Boolean).some((q) => norm(p) === norm(q)))));
    for (const op of set.ops) {
      const name = op.to ? `${op.path} → ${op.to}` : op.path;
      if (op.type !== 'delete' && op.type !== 'rename' && op.type !== 'create' && !this.afterBytes(set, op)) blockers.push(`${name}: 저장된 변경 내용이 손상되었습니다.`);
      if (op.type === 'create' && !this.afterBytes(set, op)) blockers.push(`${name}: 저장된 변경 내용이 손상되었습니다.`);
      const state = this.opState(set, op);
      if (state !== 'before') blockers.push(`${name}: ${state === 'after' ? '이미 변경된 상태입니다.' : '변경안 생성 이후 파일이나 폴더가 외부에서 바뀌었습니다.'}`);
      if (busy(op)) blockers.push(`${name}: 다른 변경 작업이 같은 파일을 사용 중입니다.`);
    }
    return blockers;
  }
  verifyRestore(set) {
    const blockers = [];
    const project = this.scope(set.projectId, set.sessionId);
    if (project.folderPath !== set.folderPath) return ['프로젝트의 연결 폴더가 변경되거나 해제되었습니다.'];
    if (!['applied', 'partial', 'manual', 'restore_failed', 'apply_failed'].includes(set.status)) return ['복구할 수 있는 적용 기록이 없습니다.'];
    let changes = 0;
    for (const op of set.ops) {
      const name = op.to ? `${op.path} → ${op.to}` : op.path;
      const state = this.opState(set, op);
      if (state === 'unknown') { blockers.push(`${name}: 적용 이후 외부에서 변경되었거나 확인할 수 없어 전체 복구를 차단했습니다.`); continue; }
      if (state === 'after') {
        changes++;
        if ((op.type === 'modify' || op.type === 'delete') && !this.backupBytes(set, op)) blockers.push(`${name}: 백업을 찾을 수 없거나 손상되어 복구할 수 없습니다.`);
      }
    }
    if (!blockers.length && !changes) blockers.push('모든 항목이 이미 원래 상태라 복구할 변경이 없습니다.');
    return blockers;
  }
  describe(set) {
    return set.ops.map((op) => ({ type: op.type, path: op.path, ...(op.to ? { to: op.to } : {}), beforeBytes: op.beforeBytes ?? null, afterBytes: op.afterBytes ?? null,
      beforeHash: op.beforeHash ?? null, afterHash: op.afterHash ?? null }));
  }

  // ---- views ----
  textOf(bytes) { try { const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t) ? null : t; } catch { return null; } }
  view(set) {
    const out = structuredClone(set);
    out.ops = out.ops.map((op) => {
      const { tempName, restoreTemp, ...rest } = op;
      return rest;
    });
    return out;
  }
  summaries() { return this.data.sets.map((s) => this.view(s)); }
  detail(set, opId) {
    const op = set.ops.find((o) => o.id === opId);
    if (!op) fail('변경 항목을 찾을 수 없습니다.', 404);
    const result = { id: op.id, type: op.type, path: op.path, to: op.to ?? null, kind: op.kind };
    const after = op.afterHash ? this.afterBytes(set, op) : null;
    let before = null;
    if (op.beforeHash) {
      before = this.backupBytes(set, op);
      if (!before && ['pending', 'approved', 'conflict'].includes(set.status)) { try { const cur = readFileBytes(set.folderPath, op.path); if (sha(cur.bytes) === op.beforeHash) before = cur.bytes; } catch { /* unavailable */ } }
    }
    if (op.kind === 'text') {
      const a = before && this.textOf(before), b = after && this.textOf(after);
      if (a !== null && a !== undefined) result.before = a.slice(0, 200000);
      if (b !== null && b !== undefined) result.after = b.slice(0, 200000);
      if (typeof a === 'string' && typeof b === 'string') result.diff = lineDiff(a, b);
    } else if (op.hasPreview) {
      const read = (kind) => { try { return fs.readFileSync(this.blob(set, op, kind), 'utf8'); } catch { return null; } };
      const a = read('pvbefore'), b = read('pvafter');
      result.office = true;
      if (b !== null) result.after = b;
      if (a !== null) result.before = a;
      if (a !== null && b !== null) result.diff = lineDiff(a, b);
    } else if (IMAGES.has(extOf(op.path)) && extOf(op.path) !== '.svg') {
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }[extOf(op.path)];
      if (after && after.length <= 6 * 1048576) result.afterImage = `data:${mime};base64,${after.toString('base64')}`;
      if (before && before.length <= 6 * 1048576) result.beforeImage = `data:${mime};base64,${before.toString('base64')}`;
    }
    return result;
  }
  // A file changed since the set was made: it can no longer be approved or applied.
  recheck(set) {
    if (!['pending', 'approved', 'conflict'].includes(set.status)) return set;
    let reason = '';
    if (this.scope(set.projectId, set.sessionId).folderPath !== set.folderPath) reason = '프로젝트의 연결 폴더가 변경되었습니다.';
    else {
      for (const op of set.ops) {
        if (this.opState(set, op) !== 'before') { reason = `${op.to ? `${op.path} → ${op.to}` : op.path}: 변경안 생성 이후 파일이나 폴더가 바뀌었습니다.`; break; }
      }
    }
    const status = reason ? 'conflict' : (set.status === 'conflict' ? 'pending' : set.status);
    if (status !== set.status || (reason && set.conflictReason !== reason)) {
      set.status = status; set.conflictReason = reason;
      this.save(set);
    }
    return set;
  }

  // ---- confirmations: single use, five minutes, memory only (a restart always asks again) ----
  issue(kind, set) {
    const confirmId = randomUUID();
    this.confirmations.set(confirmId, { kind, setId: set.id, status: set.status, expires: Date.now() + CONFIRM_MS });
    for (const [key, value] of this.confirmations) if (value.expires < Date.now()) this.confirmations.delete(key);
    return { confirmId, expiresAt: this.now() + CONFIRM_MS };
  }
  take(kind, set, confirmId) {
    const ticket = this.confirmations.get(confirmId);
    if (!ticket || ticket.kind !== kind || ticket.setId !== set.id || ticket.expires < Date.now()) fail('최종 확인이 없거나 만료되었습니다. 다시 확인 절차를 진행하세요.', 409);
    this.confirmations.delete(confirmId);
  }
  record(set, entry) { set.history = [...(set.history || []), { at: this.now(), ...entry }].slice(-HISTORY_LIMIT); }

  prepareApply(set) {
    this.recheck(set);
    const blockers = this.verifyApply(set);
    if (blockers.length) fail(`변경안을 적용할 수 없습니다.\n${blockers.join('\n')}`, 409);
    return { kind: 'changes.apply', ...this.issue('apply', set), folderName: path.basename(set.folderPath), title: set.title, files: this.describe(set),
      deletes: set.ops.filter((o) => o.type === 'delete').length,
      notes: ['적용 전에 수정·삭제될 모든 원본이 백업되고 해시로 검증됩니다. 삭제된 파일도 백업에서 복구할 수 있습니다.',
        '중간에 실패하면 이미 적용된 항목을 자동으로 되돌리고, 외부에서 바뀐 파일은 덮어쓰지 않고 수동 확인 상태로 남깁니다.'] };
  }
  prepareRestore(set) {
    const blockers = this.verifyRestore(set);
    if (blockers.length) fail(`복구할 수 없습니다.\n${blockers.join('\n')}`, 409);
    return { kind: 'changes.restore', ...this.issue('restore', set), folderName: path.basename(set.folderPath), title: set.title,
      files: this.describe(set).map((f, i) => ({ ...f, willRevert: this.opState(set, set.ops[i]) === 'after' })),
      notes: ['현재 상태가 적용 직후와 정확히 같은 항목만 되돌립니다.', '외부 변경이 하나라도 있으면 전체 복구를 차단하고 아무것도 바꾸지 않습니다.'] };
  }

  decide(set, decision) {
    if (!['approved', 'rejected'].includes(decision)) fail('승인 또는 거절만 선택할 수 있습니다.');
    this.recheck(set);
    if (decision === 'approved' && set.status === 'conflict') fail(`원본 충돌로 승인할 수 없습니다. ${set.conflictReason}`, 409);
    if (!['pending', 'approved', 'conflict'].includes(set.status)) fail('이미 처리된 변경안입니다.', 409);
    set.status = decision; set.decidedAt = this.now();
    this.save(set);
  }

  // ---- apply ----
  apply(set, confirmId) {
    const replay = (set.history || []).findLast((h) => h.kind === 'apply' && h.confirmId === confirmId);
    if (replay) return { replayed: true, outcome: replay };
    if (set.batch?.confirmId === confirmId && set.status === 'applying') fail('이 요청은 이미 처리 중입니다.', 409);
    this.take('apply', set, confirmId);
    this.recheck(set);
    const blockers = this.verifyApply(set);
    if (blockers.length) {
      this.record(set, { kind: 'apply', result: 'blocked', confirmId, message: `적용 전 검증 실패: ${blockers.join(' / ')}` });
      try { this.save(set); } catch { /* the error below is still returned */ }
      fail(`변경 적용을 중단했습니다. 어떤 파일도 바꾸지 않았습니다.\n${blockers.join('\n')}`, 409);
    }
    const lock = acquireLock(this.lockFile, { maxAgeMs: 10 * 60000, busy: '다른 서버 프로세스가 같은 작업 데이터에서 파일을 쓰는 중입니다. 하나의 서버만 사용하세요.' });
    try { return this.runApply(set, confirmId); } finally { lock.release(); }
  }
  runApply(set, confirmId) {
    const root = set.folderPath;
    set.status = 'applying';
    set.batch = { id: randomUUID(), confirmId, startedAt: this.now(), message: '' };
    for (const op of set.ops) { op.state = 'queued'; op.tempName = `.chatroom-${randomUUID()}.tmp`; op.createdDirs = []; delete op.message; }
    this.save(set); // the durable "in progress" record exists before any project change
    const abort = (message) => {
      set.status = 'apply_failed'; set.batch.finishedAt = this.now(); set.batch.message = `${message} 실제 파일은 변경되지 않았습니다.`;
      this.record(set, { kind: 'apply', result: 'failed', confirmId, message: set.batch.message });
      this.save(set);
      fail(set.batch.message, 500);
    };
    try {
      // 1. every backup is written and re-read before the first change
      for (const op of set.ops) {
        if (op.type === 'create') { op.state = 'backed_up'; continue; }
        const bytes = readFileBytes(root, op.path).bytes;
        if (sha(bytes) !== op.beforeHash) fail(`${op.path}: 백업 직전에 원본이 변경되었습니다.`, 409);
        fs.mkdirSync(path.dirname(this.blob(set, op, 'before')), { recursive: true });
        writeFileAtomic(this.blob(set, op, 'before'), bytes);
        if (!this.backupBytes(set, op)) fail(`${op.path}: 백업 검증에 실패했습니다.`, 500);
        op.state = 'backed_up';
      }
      this.save(set);
    } catch (error) { abort(`백업에 실패하여 중단했습니다. (${error.message})`); }
    let failure = null;
    for (let i = 0; i < set.ops.length && !failure; i++) {
      const op = set.ops[i];
      try {
        op.state = 'applying'; this.save(set);
        this.faultHook?.('apply', i);
        this.applyOp(set, op);
        op.state = 'applied'; this.save(set);
      } catch (error) { failure = { op, error }; }
    }
    if (!failure) {
      set.status = 'applied'; set.batch.finishedAt = this.now(); set.batch.message = `${set.ops.length}개 작업을 적용하고 SHA-256으로 검증했습니다.`;
      this.record(set, { kind: 'apply', result: 'succeeded', confirmId, message: set.batch.message });
      this.save(set);
      return { outcome: set.history.at(-1) };
    }
    return this.rollback(set, confirmId, failure);
  }
  applyOp(set, op) {
    const root = set.folderPath;
    if (this.opState(set, op) !== 'before') fail(`${op.path}: 적용 직전에 파일이 변경되어 중단했습니다.`, 409);
    if (op.type === 'create') {
      const bytes = this.afterBytes(set, op);
      if (!bytes) fail('저장된 변경 내용이 손상되었습니다.', 500);
      mkdirs(root, op.path, op.createdDirs);
      const { target } = probe(root, op.path);
      createExclusive(path.join(path.dirname(target), op.tempName), target, bytes);
      if (currentHash(root, op.path) !== op.afterHash) fail(`${op.path}: 생성 후 내용 검증에 실패했습니다.`, 500);
    } else if (op.type === 'modify') {
      const bytes = this.afterBytes(set, op);
      if (!bytes) fail('저장된 변경 내용이 손상되었습니다.', 500);
      const entry = resolveTaskEntry(root, op.path);
      const temp = path.join(path.dirname(entry.target), op.tempName);
      const mode = entry.stat.mode & 0o777;
      const fd = retryFile(() => fs.openSync(temp, 'wx', mode));
      try { writeToFd(fd, bytes); } finally { fs.closeSync(fd); }
      try {
        if (!fs.readFileSync(temp).equals(bytes)) fail('임시 파일 내용이 변경안과 일치하지 않아 중단했습니다.', 500);
        if (currentHash(root, op.path) !== op.beforeHash) fail(`${op.path}: 교체 직전에 파일이 변경되어 중단했습니다.`, 409);
        replaceFile(temp, entry.target);
      } catch (error) { try { fs.rmSync(temp, { force: true }); } catch { /* recovery removes it */ } throw error; }
      if (currentHash(root, op.path) !== op.afterHash) fail(`${op.path}: 교체 후 내용 검증에 실패했습니다.`, 500);
    } else if (op.type === 'rename') {
      mkdirs(root, op.to, op.createdDirs);
      const from = resolveTaskEntry(root, op.path).target, to = probe(root, op.to).target;
      moveExclusive(from, to);
      if (currentHash(root, op.to) !== op.beforeHash || !absent(root, op.path)) fail(`${op.path}: 이동 후 검증에 실패했습니다.`, 500);
    } else {
      const entry = resolveTaskEntry(root, op.path);
      if (sha(fs.readFileSync(entry.target)) !== op.beforeHash) fail(`${op.path}: 삭제 직전에 파일이 변경되어 중단했습니다.`, 409);
      fs.unlinkSync(entry.target);
      if (!absent(root, op.path)) fail(`${op.path}: 삭제를 확인하지 못했습니다.`, 500);
    }
  }
  // Inverse of applyOp. Requires the operation to be in its applied state, so it never overwrites outside changes.
  undoOp(set, op) {
    const root = set.folderPath;
    if (op.type === 'create') {
      const entry = resolveTaskEntry(root, op.path);
      if (sha(fs.readFileSync(entry.target)) !== op.afterHash) fail('생성된 파일이 바뀌어 삭제하지 않았습니다.', 409);
      fs.unlinkSync(entry.target);
      rmCreatedDirs(root, op.createdDirs || []);
    } else if (op.type === 'modify') {
      const bytes = this.backupBytes(set, op);
      if (!bytes) fail('백업을 확인할 수 없습니다.', 500);
      const entry = resolveTaskEntry(root, op.path);
      const tempName = `.chatroom-${randomUUID()}.tmp`;
      op.restoreTemp = tempName;
      const temp = path.join(path.dirname(entry.target), tempName);
      const fd = retryFile(() => fs.openSync(temp, 'wx', entry.stat.mode & 0o777));
      try { writeToFd(fd, bytes); } finally { fs.closeSync(fd); }
      try {
        if (currentHash(root, op.path) !== op.afterHash) fail('복구 직전에 파일이 변경되어 중단했습니다.', 409);
        replaceFile(temp, entry.target);
      } catch (error) { try { fs.rmSync(temp, { force: true }); } catch { /* cleaned on restart */ } throw error; }
      if (currentHash(root, op.path) !== op.beforeHash) fail('복구 후 해시가 원본과 일치하지 않습니다.', 500);
    } else if (op.type === 'rename') {
      const from = resolveTaskEntry(root, op.to).target, to = probe(root, op.path).target;
      moveExclusive(from, to);
      rmCreatedDirs(root, op.createdDirs || []);
      if (currentHash(root, op.path) !== op.beforeHash) fail('복구 후 해시가 원본과 일치하지 않습니다.', 500);
    } else {
      const bytes = this.backupBytes(set, op);
      if (!bytes) fail('백업을 확인할 수 없습니다.', 500);
      const { target, exists } = probe(root, op.path);
      if (exists) fail('같은 이름의 파일이 생겨 복구하지 않았습니다.', 409);
      mkdirs(root, op.path, []);
      createExclusive(path.join(path.dirname(target), `.chatroom-${randomUUID()}.tmp`), target, bytes);
      if (currentHash(root, op.path) !== op.beforeHash) fail('복구 후 해시가 원본과 일치하지 않습니다.', 500);
    }
  }
  rollback(set, confirmId, failure) {
    const done = [];
    for (let i = set.ops.length - 1; i >= 0; i--) {
      const op = set.ops[i];
      if (!['applied', 'applying'].includes(op.state)) continue;
      const state = this.opState(set, op);
      if (state === 'before') { op.state = op === failure.op ? 'failed' : 'reverted'; continue; }
      if (state !== 'after') { op.state = 'unknown'; continue; }
      try { this.faultHook?.('revert', i); this.undoOp(set, op); op.state = 'reverted'; done.push(op.path); } catch (error) { op.state = 'revert_failed'; op.message = error.message; }
    }
    if (failure.op.state === 'applying') failure.op.state = 'failed';
    const unknown = set.ops.filter((o) => o.state === 'unknown'), stuck = set.ops.filter((o) => o.state === 'revert_failed');
    set.batch.finishedAt = this.now();
    if (unknown.length) {
      set.status = 'manual';
      set.batch.message = `적용 중 오류(${failure.error.message}) 후 일부 항목이 외부에서 변경되어 자동 복구를 하지 않았습니다. 수동 확인이 필요합니다: ${unknown.map((o) => o.path).join(', ')}`;
    } else if (stuck.length) {
      set.status = 'partial';
      set.batch.message = `적용 중 오류(${failure.error.message}) 후 자동 복구에 실패한 항목이 있습니다: ${stuck.map((o) => o.path).join(', ')}. 백업은 보존되어 있으며 전체 복구를 다시 시도할 수 있습니다.`;
    } else {
      set.status = 'apply_failed';
      set.batch.message = `${failure.op.path} 적용 중 오류가 발생하여 중단했습니다(${failure.error.message}). ${done.length ? `먼저 적용된 ${done.join(', ')}을(를) 원래대로 되돌렸습니다.` : '이미 변경된 항목은 없습니다.'}`;
    }
    this.record(set, { kind: 'apply', result: set.status === 'apply_failed' ? 'failed' : 'partial', confirmId, message: set.batch.message });
    this.save(set);
    fail(set.batch.message, 500);
  }

  // ---- restore ----
  restore(set, confirmId) {
    const replay = (set.history || []).findLast((h) => h.kind === 'restore' && h.confirmId === confirmId);
    if (replay) return { replayed: true, outcome: replay };
    if (set.batch?.confirmId === confirmId && set.status === 'restoring') fail('이 요청은 이미 처리 중입니다.', 409);
    this.take('restore', set, confirmId);
    const blockers = this.verifyRestore(set);
    if (blockers.length) {
      this.record(set, { kind: 'restore', result: 'blocked', confirmId, message: `복구 전 검증 실패: ${blockers.join(' / ')}` });
      try { this.save(set); } catch { /* the error below is still returned */ }
      fail(`전체 복구를 중단했습니다. 어떤 파일도 바꾸지 않았습니다.\n${blockers.join('\n')}`, 409);
    }
    const lock = acquireLock(this.lockFile, { maxAgeMs: 10 * 60000, busy: '다른 서버 프로세스가 같은 작업 데이터에서 파일을 쓰는 중입니다. 하나의 서버만 사용하세요.' });
    try { return this.runRestore(set, confirmId); } finally { lock.release(); }
  }
  runRestore(set, confirmId) {
    set.status = 'restoring'; set.batch = { ...(set.batch || {}), confirmId, restoreStartedAt: this.now(), message: '' };
    this.save(set);
    let failed = null;
    for (let i = set.ops.length - 1; i >= 0 && !failed; i--) {
      const op = set.ops[i];
      const state = this.opState(set, op);
      if (state === 'before') { op.state = 'reverted'; continue; }
      try {
        op.state = 'reverting'; this.save(set);
        this.faultHook?.('restore', i);
        this.undoOp(set, op);
        op.state = 'reverted'; this.save(set);
      } catch (error) {
        op.message = error.message;
        const now = this.opState(set, op);
        op.state = now === 'after' ? 'applied' : now === 'before' ? 'reverted' : 'unknown';
        failed = { op, error };
      }
    }
    const wrong = failed ? [] : set.ops.filter((o) => this.opState(set, o) !== 'before');
    if (failed || wrong.length) {
      const message = failed ? `${failed.op.path} 복구 중 오류가 발생해 중단했습니다(${failed.error.message}). 복구된 항목: ${set.ops.filter((o) => o.state === 'reverted').map((o) => o.path).join(', ') || '없음'}. 백업은 보존되어 있으며 복구를 다시 시도할 수 있습니다.`
        : `복구 후 검증에서 원래 상태와 다른 항목이 있습니다: ${wrong.map((o) => o.path).join(', ')}.`;
      set.status = set.ops.some((o) => o.state === 'unknown') ? 'manual' : 'restore_failed';
      set.batch.finishedAt = this.now(); set.batch.message = message;
      this.record(set, { kind: 'restore', result: 'failed', confirmId, message });
      this.save(set);
      fail(message, 500);
    }
    set.status = 'restored'; set.batch.finishedAt = this.now(); set.batch.message = `${set.ops.length}개 항목이 적용 전 상태로 복구되었고 SHA-256으로 확인했습니다.`;
    this.record(set, { kind: 'restore', result: 'succeeded', confirmId, message: set.batch.message });
    this.save(set);
    return { outcome: set.history.at(-1) };
  }

  // ---- startup recovery: decide from disk, never write project files ----
  recover() {
    let changed = false;
    for (const set of this.data.sets) {
      if (!['applying', 'restoring'].includes(set.status)) continue;
      changed = true;
      const restoring = set.status === 'restoring';
      for (const op of set.ops) {
        for (const name of [op.tempName, op.restoreTemp]) {
          if (!name || !TASK_TEMP_NAME.test(name)) continue;
          // Only the exact app-generated temp name, only beside this operation's own paths.
          for (const relative of [op.path, op.to].filter(Boolean)) {
            try {
              const dir = path.posix.dirname(relative);
              const temp = path.join(resolveTaskEntry(set.folderPath, dir === '.' ? '' : dir).target, name);
              if (fs.existsSync(temp)) fs.unlinkSync(temp);
            } catch { /* reported through the state check below */ }
          }
        }
        op.state = { before: restoring ? 'reverted' : 'queued', after: 'applied', unknown: 'unknown' }[this.opState(set, op)];
      }
      const states = set.ops.map((o) => o.state);
      let status, message;
      if (states.includes('unknown')) { status = 'manual'; message = '서버 재시작으로 작업이 중단되었고 일부 항목이 예상과 다른 상태입니다. 자동으로 덮어쓰지 않았습니다. 수동 확인이 필요합니다.'; }
      else if (restoring) {
        if (states.every((s) => s === 'reverted')) { status = 'restored'; message = '서버 재시작 후 확인: 모든 항목이 적용 전 상태와 일치하여 복구 완료로 처리했습니다.'; }
        else { status = 'restore_failed'; message = '서버 재시작으로 복구가 중단되었습니다. 일부 항목이 아직 적용된 상태입니다. 복구를 다시 실행할 수 있습니다.'; }
      } else if (states.every((s) => s === 'queued')) { status = 'apply_failed'; message = '서버 재시작으로 적용이 중단되었습니다. 모든 항목이 원래 그대로이므로 다시 적용할 수 있습니다.'; }
      else { status = 'partial'; message = '서버 재시작으로 적용이 중단되어 일부만 적용된 상태입니다. 전체 복구로 되돌릴 수 있습니다.'; }
      set.status = status; set.batch = { ...(set.batch || {}), message, finishedAt: this.now() };
      this.record(set, { kind: restoring ? 'restore' : 'apply', result: status === 'restored' ? 'succeeded' : 'failed', confirmId: set.batch.confirmId, message });
    }
    if (!changed) return;
    try { this.commit(structuredClone(this.data)); } catch { this.warnings.push('중단된 변경 작업의 정리 결과를 저장하지 못했습니다. 저장 공간·권한을 확인한 뒤 서버를 다시 시작하세요.'); }
  }

  // files kept for sets that are still needed vs finished (used by backup maintenance)
  backupRefs() {
    const refs = new Map();
    for (const set of this.data.sets) {
      const finished = ['rejected', 'restored'].includes(set.status);
      const base = path.join(this.blobDir, set.id);
      let names = [];
      try { names = fs.readdirSync(base); } catch { /* nothing stored */ }
      for (const name of names) refs.set(path.resolve(base, name).toLowerCase(), { keep: !finished });
    }
    return refs;
  }

  handle(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('올바른 변경안 요청이 아닙니다.');
    if (['path', 'to', 'folderPath', 'content', 'after', 'before', 'ops', 'files', 'hash', 'batch', 'backup', 'target'].some((key) => Object.hasOwn(body, key))) {
      fail('변경할 파일 경로나 내용은 요청으로 지정할 수 없습니다. 저장된 변경안만 처리합니다.');
    }
    const set = this.locate(body);
    if (body.action === 'get') return { ...this.view(this.recheck(set)) };
    if (body.action === 'detail') { this.recheck(set); return this.detail(set, body.opId); }
    if (body.action === 'decide') { this.decide(set, body.decision); return this.view(set); }
    if (body.action === 'apply.prepare') return { ...this.view(set), confirmation: this.prepareApply(set) };
    if (body.action === 'restore.prepare') return { ...this.view(set), confirmation: this.prepareRestore(set) };
    if (body.action === 'apply' || body.action === 'restore') {
      if (!uuid(body.confirmId)) fail('실제 파일을 변경하려면 최종 확인 절차가 필요합니다.');
      const result = body.action === 'apply' ? this.apply(set, body.confirmId) : this.restore(set, body.confirmId);
      return { ...this.view(this.locate(body)), outcome: result.outcome, ...(result.replayed ? { replayed: true } : {}) };
    }
    return fail('지원하지 않는 변경안 요청입니다.');
  }
}

// Exact line diff for texts up to 2,000 lines per side; larger texts only report sizes.
export function lineDiff(before, after) {
  const split = (t) => t.match(/[^\n]*\n|[^\n]+$/g) || [];
  const a = split(before), b = split(after);
  if (a.length > CHANGE_LIMITS.diffLines || b.length > CHANGE_LIMITS.diffLines) return { rows: null, added: null, removed: null, tooLarge: true, beforeLines: a.length, afterLines: b.length };
  const width = b.length + 1, table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i * width + j] = a[i] === b[j] ? 1 + table[(i + 1) * width + j + 1] : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const rows = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) { rows.push({ kind: 'removed', text: a[i++] }); removed++; }
    else { rows.push({ kind: 'added', text: b[j++] }); added++; }
  }
  return { rows, added, removed };
}
