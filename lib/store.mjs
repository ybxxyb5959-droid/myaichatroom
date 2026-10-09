// Persistence: chat log (append-only JSONL), room settings, private notes and the
// shared workspace folder the AIs can read and write.

import fs from 'node:fs';
import path from 'node:path';
import { pick } from './i18n.mjs';
import { readJsonFile, writeJsonFile, writeFileAtomic, appendFile, preserveUnreadable, retryFile } from './atomic.mjs';

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.svg', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.py', '.yaml', '.yml', '.xml', '.tsv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
export const MAX_FILE_BYTES = 60 * 1024;
const MAX_FILES = 300;
const MAX_NOTE_CHARS = 4000;

// Errors from workspace operations; the AI members read them in the room.
const T = {
  ko: {
    emptyPath: '빈 경로',
    outside: '작업공간 밖 경로',
    tooDeep: '폴더가 너무 깊음',
    badChars: '경로에 쓸 수 없는 문자',
    badExt: (ext) => `허용 안 되는 확장자 ${ext || '(없음)'}`,
    fileMissing: (rel) => `없는 파일 ${rel}`,
    imageWrite: '이미지 파일은 직접 못 씀',
    fileLimit: '파일 개수 한도',
    findMissing: (rel) => `${rel}에서 바꿀 부분을 못 찾음`,
    unknownOp: (op) => `모르는 작업 ${op}`,
    tooBig: (rel) => `${rel} 너무 큼(60KB 초과)`,
  },
  en: {
    emptyPath: 'Empty path',
    outside: 'Path is outside the Workspace',
    tooDeep: 'Folders nested too deep',
    badChars: 'Path has characters that are not allowed',
    badExt: (ext) => `Extension not allowed: ${ext || '(none)'}`,
    fileMissing: (rel) => `No such file ${rel}`,
    imageWrite: "Image files can't be written directly",
    fileLimit: 'File limit reached',
    findMissing: (rel) => `Couldn't find the part to replace in ${rel}`,
    unknownOp: (op) => `Unknown op ${op}`,
    tooBig: (rel) => `${rel} is too big (over 60KB)`,
  },
  ja: {
    emptyPath: '空のパス',
    outside: 'ワークスペースの外のパス',
    tooDeep: 'フォルダが深すぎる',
    badChars: 'パスに使えない文字がある',
    badExt: (ext) => `使えない拡張子 ${ext || '(なし)'}`,
    fileMissing: (rel) => `ファイル ${rel} がない`,
    imageWrite: '画像ファイルは直接書けない',
    fileLimit: 'ファイル数の上限',
    findMissing: (rel) => `${rel} の中に置き換える部分が見つからない`,
    unknownOp: (op) => `知らない操作 ${op}`,
    tooBig: (rel) => `${rel} が大きすぎる(60KB超え)`,
  },
};
const tx = () => pick(T);

export class Store {
  constructor(root) {
    this.root = root;
    this.dataDir = path.join(root, 'data');
    this.notesDir = path.join(this.dataDir, 'notes');
    this.logDir = path.join(this.dataDir, 'logs');
    this.wsDir = path.join(root, 'workspace');
    for (const d of [this.dataDir, this.notesDir, this.logDir, this.wsDir]) fs.mkdirSync(d, { recursive: true });

    this.msgFile = path.join(this.dataDir, 'messages.jsonl');
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.metaFile = path.join(this.dataDir, 'workspace-meta.json');

    this.messages = [];
    this.byId = new Map();
    this.nextId = 1;
    this.warnings = [];
    this.loadMessages();
    const onRecovery = (message) => this.warnings.push(message);
    this.state = readJsonFile(this.stateFile, {}, { onRecovery });
    this.meta = readJsonFile(this.metaFile, {}, { onRecovery });
  }

  // ---------- messages ----------
  loadMessages() {
    if (!fs.existsSync(this.msgFile)) return;
    const source = retryFile(() => fs.readFileSync(this.msgFile, 'utf8'));
    const lines = source.split('\n');
    const valid = [];
    let damaged = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { damaged = true; continue; }
      if (!rec || typeof rec !== 'object' || (!['react', 'desc'].includes(rec.kind) && !Number.isSafeInteger(rec.id))) {
        damaged = true; continue;
      }
      valid.push(line);
      if (rec.kind === 'react') { if (rec.remove) this.removeReaction(rec.target, rec.by, rec.emoji, false); else this.applyReaction(rec.target, rec.by, rec.emoji, false); continue; }
      if (rec.kind === 'desc') { this.setAttachDesc(rec.target, rec.text, false); continue; }
      rec.reactions ??= {};
      this.messages.push(rec);
      this.byId.set(rec.id, rec);
      this.nextId = Math.max(this.nextId, rec.id + 1);
    }
    if (damaged || (source && !source.endsWith('\n'))) {
      preserveUnreadable(this.msgFile, (message) => this.warnings.push(message));
      writeFileAtomic(this.msgFile, valid.length ? valid.join('\n') + '\n' : '');
    }
  }

  addMessage(m) {
    const msg = { id: this.nextId, ts: Date.now(), reactions: {}, ...m };
    appendFile(this.msgFile, JSON.stringify(msg) + '\n');
    this.nextId++;
    this.messages.push(msg);
    this.byId.set(msg.id, msg);
    return msg;
  }

  // Room reset: the history is emptied but ids keep counting, so read positions and client caches never meet a reused id.
  // The next message written (the reset notice) carries the counter across a restart.
  clearMessages() {
    writeFileAtomic(this.msgFile, '');
    this.messages = [];
    this.byId = new Map();
  }

  // Toggle-free: an emoji reaction is added once per (member, emoji).
  applyReaction(targetId, by, emoji, persist = true) {
    const msg = this.byId.get(targetId);
    if (!msg || !emoji) return null;
    const list = (msg.reactions[emoji] ??= []);
    if (list.includes(by)) return null;
    if (persist) appendFile(this.msgFile, JSON.stringify({ kind: 'react', target: targetId, by, emoji, ts: Date.now() }) + '\n');
    list.push(by);
    return msg;
  }
  removeReaction(targetId, by, emoji, persist = true) {
    const msg = this.byId.get(targetId), list = msg?.reactions[emoji];
    if (!list?.includes(by)) return null;
    if (persist) appendFile(this.msgFile, JSON.stringify({ kind: 'react', remove: true, target: targetId, by, emoji, ts: Date.now() }) + '\n');
    list.splice(list.indexOf(by), 1);
    if (!list.length) delete msg.reactions[emoji];
    return msg;
  }
  // People (owner and friends) toggle their own reactions; AI reactions stay add-only.
  toggleReaction(targetId, by, emoji) {
    return this.byId.get(targetId)?.reactions[emoji]?.includes(by)
      ? { msg: this.removeReaction(targetId, by, emoji), on: false } : { msg: this.applyReaction(targetId, by, emoji), on: true };
  }

  // Text description of an uploaded photo, for the members whose CLI cannot take images.
  setAttachDesc(targetId, text, persist = true) {
    const msg = this.byId.get(targetId);
    if (!msg?.attach || !text) return null;
    if (persist) appendFile(this.msgFile, JSON.stringify({ kind: 'desc', target: targetId, text: String(text), ts: Date.now() }) + '\n');
    msg.attach.desc = String(text);
    return msg;
  }

  get lastId() { return this.nextId - 1; }
  lastMessage() { return this.messages[this.messages.length - 1]; }
  after(id) {
    // messages are in id order; walk backwards for speed
    const out = [];
    for (let i = this.messages.length - 1; i >= 0 && this.messages[i].id > id; i--) out.push(this.messages[i]);
    return out.reverse();
  }
  recent(n) { return this.messages.slice(-n); }

  // ---------- room state ----------
  saveState() { writeJsonFile(this.stateFile, this.state); }

  // ---------- notes (private per AI) ----------
  readNote(id) {
    const f = path.join(this.notesDir, `${id}.md`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  }
  writeNote(id, text) {
    let t = String(text ?? '');
    if (t.length > MAX_NOTE_CHARS) t = t.slice(t.length - MAX_NOTE_CHARS);
    writeFileAtomic(path.join(this.notesDir, `${id}.md`), t);
    return t;
  }
  appendNote(id, line) {
    const cur = this.readNote(id);
    return this.writeNote(id, (cur ? cur.replace(/\s*$/, '\n') : '') + String(line).trim() + '\n');
  }

  // ---------- workspace ----------
  // Returns a safe relative path (forward slashes) or throws.
  safeRel(p) {
    let rel = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!rel) throw new Error(tx().emptyPath);
    rel = path.posix.normalize(rel);
    if (rel.startsWith('..') || path.posix.isAbsolute(rel) || rel.includes('\0')) throw new Error(tx().outside);
    if (rel.split('/').length > 4) throw new Error(tx().tooDeep);
    if (!/^[\p{L}\p{N} _.\-()/]+$/u.test(rel)) throw new Error(tx().badChars);
    const ext = path.posix.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext) && !IMAGE_EXT.has(ext)) throw new Error(tx().badExt(ext));
    return rel;
  }
  abs(rel) { return path.join(this.wsDir, ...rel.split('/')); }
  isImage(rel) { return IMAGE_EXT.has(path.posix.extname(rel).toLowerCase()); }

  listFiles() {
    const out = [];
    const gameTitles = new Map(this.messages.filter((m) => m.game?.path && m.game.title).map((m) => [m.game.path, m.game.title]));
    const walk = (dir, prefix) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
        else {
          const st = fs.statSync(path.join(dir, ent.name));
          const m = this.meta[rel] || {};
          out.push({ path: rel, size: st.size, mtime: st.mtimeMs, by: m.by || null, createdBy: m.createdBy || m.by || null,
            activity: m.activity || null, title: m.title || gameTitles.get(rel) || null,
            image: this.isImage(rel) || path.posix.extname(rel).toLowerCase() === '.svg' });
        }
      }
    };
    walk(this.wsDir, '');
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  readFile(p) {
    const rel = this.safeRel(p);
    const f = this.abs(rel);
    if (!fs.existsSync(f)) throw new Error(tx().fileMissing(rel));
    if (this.isImage(rel)) return { rel, image: true, size: fs.statSync(f).size };
    return { rel, text: fs.readFileSync(f, 'utf8') };
  }

  // op: {op: write|append|edit|delete, path, content, find, replace}
  applyFileOp(op, by) {
    const rel = this.safeRel(op.path);
    if (this.isImage(rel) && op.op !== 'delete') throw new Error(tx().imageWrite);
    const f = this.abs(rel);
    const exists = fs.existsSync(f);
    let text;
    switch (op.op) {
      case 'write':
        if (!exists && this.listFiles().length >= MAX_FILES) throw new Error(tx().fileLimit);
        text = String(op.content ?? '');
        break;
      case 'append': {
        const cur = exists ? fs.readFileSync(f, 'utf8') : '';
        const add = String(op.content ?? '');
        // Models often omit the leading newline when appending a line.
        const glue = cur && !cur.endsWith('\n') && !add.startsWith('\n') ? '\n' : '';
        text = cur + glue + add;
        break;
      }
      case 'edit': {
        if (!exists) throw new Error(tx().fileMissing(rel));
        const cur = fs.readFileSync(f, 'utf8');
        const find = String(op.find ?? '');
        if (!find || !cur.includes(find)) throw new Error(tx().findMissing(rel));
        text = cur.replace(find, String(op.replace ?? ''));
        break;
      }
      case 'delete':
        if (!exists) throw new Error(tx().fileMissing(rel));
        retryFile(() => fs.rmSync(f));
        delete this.meta[rel];
        writeJsonFile(this.metaFile, this.meta);
        return { rel, op: 'delete' };
      default:
        throw new Error(tx().unknownOp(op.op));
    }
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error(tx().tooBig(rel));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    writeFileAtomic(f, text);
    this.touchMeta(rel, by, !exists);
    return { rel, op: exists ? op.op : 'create', size: Buffer.byteLength(text) };
  }

  // Register a binary file (generated image) that was copied into the workspace.
  touchMeta(rel, by, created) {
    const m = (this.meta[rel] ??= {});
    if (created || !m.createdBy) m.createdBy = by;
    m.by = by;
    m.at = Date.now();
    writeJsonFile(this.metaFile, this.meta);
  }

  log(id, text) {
    const line = `[${new Date().toISOString()}] ${text}\n`;
    try { appendFile(path.join(this.logDir, `${id}.log`), line); }
    catch (e) { console.error(`로그 저장 실패: ${e.message}\n${line}`); }
  }
}

