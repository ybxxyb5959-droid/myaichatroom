import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFile } from './atomic.mjs';
import { sniffKind } from './task-extract.mjs';
import { imageInfo } from './task-office-common.mjs';

// Files the user explicitly picked (file chooser or drag and drop). The browser sends the bytes only; the original on
// the user's PC is never touched. Bytes are stored once per project (by SHA-256) in the app's own data folder and
// are never executed or written into the project folder.
export const ATTACH_LIMITS = { fileBytes: 512 * 1024 * 1024, projectBytes: 2 * 1024 * 1024 * 1024, perProject: 200, nameChars: 200, idleMs: 60000 };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const valid = (data) => data?.version === 1 && Array.isArray(data.items) && data.items.every((i) => i && ID.test(i.id) && ID.test(i.projectId)
  && typeof i.name === 'string' && Number.isSafeInteger(i.size) && HEX.test(i.hash) && Number.isSafeInteger(i.addedAt));

export function cleanName(raw) {
  let name = String(raw ?? '').split(/[\\/]/).pop().normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*\\/]+/g, '_').replace(/^\.+/, '').trim();
  if (!name) name = '첨부 파일';
  return [...name].slice(0, ATTACH_LIMITS.nameChars).join('');
}

export class AttachmentStore {
  constructor(store, clock = Date.now) {
    this.store = store; this.clock = clock;
    this.root = path.join(path.dirname(store.file), 'task-attachments');
    this.file = path.join(path.dirname(store.file), 'task-attachments.json');
    this.warnings = [];
    this.data = readJsonFile(this.file, { version: 1, items: [] }, { validate: valid, onRecovery: (m) => this.warnings.push(m) });
    fs.mkdirSync(path.join(this.root, '.incoming'), { recursive: true });
    // Leftovers of interrupted uploads are only ever in the incoming folder.
    for (const name of fs.readdirSync(path.join(this.root, '.incoming'))) { try { fs.unlinkSync(path.join(this.root, '.incoming', name)); } catch { /* in use */ } }
  }
  blobPath(item) { return path.join(this.root, item.projectId, `${item.hash}.bin`); }
  summary(item) { const { hash, ...rest } = item; return { ...rest, hash: hash.slice(0, 12) }; }
  list(projectId) { return this.data.items.filter((i) => !projectId || i.projectId === projectId).map((i) => this.summary(i)); }
  get(projectId, id) {
    const item = this.data.items.find((i) => i.id === id && i.projectId === projectId);
    if (!item) fail('첨부 파일을 찾을 수 없습니다.', 404);
    if (!fs.existsSync(this.blobPath(item))) fail('첨부 파일 데이터가 없습니다. 다시 첨부하세요.', 410);
    return item;
  }
  commit(next) { writeJsonFile(this.file, next); this.data = next; }

  // stream: a readable of the raw bytes (the HTTP request). Resolves with the stored item.
  async receive({ projectId, sessionId = null, name, stream, declaredSize = null, signal }) {
    const project = this.store.data.projects.find((p) => p.id === projectId);
    if (!project) fail('프로젝트를 찾을 수 없습니다.', 404);
    if (sessionId && !project.sessions.some((s) => s.id === sessionId)) fail('프로젝트의 세션을 찾을 수 없습니다.', 404);
    const mine = this.data.items.filter((i) => i.projectId === projectId);
    if (mine.length >= ATTACH_LIMITS.perProject) fail(`프로젝트당 첨부는 최대 ${ATTACH_LIMITS.perProject}개입니다. 안 쓰는 첨부를 제거하세요.`, 413);
    if (declaredSize !== null && declaredSize > ATTACH_LIMITS.fileBytes) fail(`파일이 너무 큽니다(최대 ${ATTACH_LIMITS.fileBytes / 1048576}MB).`, 413);
    const stored = new Set(); const projectBytes = mine.reduce((sum, i) => (stored.has(i.hash) ? sum : (stored.add(i.hash), sum + i.size)), 0);
    const temp = path.join(this.root, '.incoming', `${randomUUID()}.part`);
    const hash = createHash('sha256'); let size = 0, head = Buffer.alloc(0);
    const out = fs.createWriteStream(temp, { flags: 'wx' });
    const done = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
    done.catch(() => {});
    let idle = null;
    const failWith = (error) => { stream.unpipe?.(out); out.destroy(); stream.destroy?.(); throw error; };
    try {
      await new Promise((resolve, reject) => {
        const poke = () => { clearTimeout(idle); idle = setTimeout(() => reject(Object.assign(new Error('업로드가 멈췄습니다. 다시 시도하세요.'), { status: 408 })), ATTACH_LIMITS.idleMs); };
        poke();
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('업로드가 취소되었습니다.'), { status: 499 })), { once: true });
        stream.on('data', (chunk) => {
          poke();
          size += chunk.length;
          if (size > ATTACH_LIMITS.fileBytes) return reject(Object.assign(new Error(`파일이 너무 큽니다(최대 ${ATTACH_LIMITS.fileBytes / 1048576}MB).`), { status: 413 }));
          if (projectBytes + size > ATTACH_LIMITS.projectBytes) return reject(Object.assign(new Error('프로젝트 첨부 용량(2GB)을 넘습니다.'), { status: 413 }));
          if (head.length < 8192) head = Buffer.concat([head, chunk.subarray(0, 8192 - head.length)]);
          hash.update(chunk);
          if (!out.write(chunk)) { stream.pause(); out.once('drain', () => stream.resume()); }
        });
        stream.on('end', resolve); stream.on('error', reject); stream.on('aborted', () => reject(Object.assign(new Error('업로드가 중단되었습니다.'), { status: 499 })));
      });
      clearTimeout(idle);
      out.end(); await done;
      if (declaredSize !== null && size !== declaredSize) fail('전송된 크기가 예상과 달라 저장하지 않았습니다.');
      if (!size) fail('빈 파일은 첨부할 수 없습니다.');
    } catch (error) { clearTimeout(idle); try { failWith(error); } catch { /* rethrown below */ } try { fs.rmSync(temp, { force: true }); } catch { /* cleaned on restart */ } throw error; }
    const digest = hash.digest('hex'), safeName = cleanName(name);
    const duplicate = mine.find((i) => i.hash === digest);
    if (duplicate) { fs.rmSync(temp, { force: true }); return { item: this.summary(duplicate), duplicate: true }; }
    const kind = sniffKind(safeName, head);
    const item = { id: randomUUID(), projectId, sessionId, name: safeName, size, hash: digest, kind, ext: path.extname(safeName).toLowerCase(), addedAt: this.clock() };
    const image = kind === 'image' ? imageInfo(head.length >= 8192 || size < 8192 ? fs.readFileSync(temp).subarray(0, 65536) : head) : null;
    if (image) item.image = { width: image.width, height: image.height, mime: image.mime };
    const target = this.blobPath(item);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const sameBlob = this.data.items.some((i) => i.projectId === projectId && i.hash === digest);
    if (sameBlob) fs.rmSync(temp, { force: true }); else fs.renameSync(temp, target);
    try { this.commit({ ...structuredClone(this.data), items: [...this.data.items, item] }); } catch (error) { if (!sameBlob) fs.rmSync(target, { force: true }); throw error; }
    return { item: this.summary(item), duplicate: false };
  }

  remove(projectId, id) {
    const item = this.data.items.find((i) => i.id === id && i.projectId === projectId);
    if (!item) fail('첨부 파일을 찾을 수 없습니다.', 404);
    this.commit({ ...structuredClone(this.data), items: this.data.items.filter((i) => i !== item) });
    // The bytes go only when nothing else in this project uses them.
    if (!this.data.items.some((i) => i.projectId === projectId && i.hash === item.hash)) { try { fs.unlinkSync(this.blobPath(item)); } catch { /* already gone */ } }
    return { removed: id };
  }
  // Attachments of a deleted project folder or unreferenced blobs: removed on request only.
  orphans() {
    const known = new Set(this.data.items.map((i) => this.blobPath(i).toLowerCase()));
    const found = [];
    for (const dir of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name.startsWith('.')) continue;
      for (const f of fs.readdirSync(path.join(this.root, dir.name))) { const full = path.join(this.root, dir.name, f); if (!known.has(full.toLowerCase())) found.push(full); }
    }
    return found;
  }
}
