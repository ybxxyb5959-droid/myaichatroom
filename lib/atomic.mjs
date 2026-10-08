// Replace a file by renaming a fully written temp file over it. Windows can hold a just-written file for
// a moment (virus scan, indexing), so a refused rename is retried briefly; a lasting failure is thrown.
import fs from 'node:fs';
import crypto from 'node:crypto';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

export function retryFile(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); } catch (e) {
      if (attempt >= 9 || !RETRY_CODES.has(e.code)) throw e;
      Atomics.wait(PAUSE, 0, 0, 20 * (attempt + 1));
    }
  }
}
export function replaceFile(temp, file) {
  retryFile(() => fs.renameSync(temp, file));
}
export function writeToFd(fd, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    // Retry a single write, not the whole append: completed partial writes advance the offset.
    const count = retryFile(() => fs.writeSync(fd, bytes, offset, bytes.length - offset));
    if (!count) throw Object.assign(new Error('File write made no progress'), { code: 'EIO' });
    offset += count;
  }
  retryFile(() => fs.fsyncSync(fd));
}
export function writeFileAtomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode : 0o666;
  const fd = retryFile(() => fs.openSync(temp, 'wx', mode));
  try {
    writeToFd(fd, value);
  } finally { fs.closeSync(fd); }
  // Leave a completed temp file recoverable if replacement permanently fails.
  replaceFile(temp, file);
}
export function writeJsonFile(file, value) {
  writeFileAtomic(file, JSON.stringify(value));
}
export function appendFile(file, value) {
  // Retry opening only: retrying a partially completed append could duplicate chat records.
  const fd = retryFile(() => fs.openSync(file, 'a'));
  try { writeToFd(fd, value); } finally { fs.closeSync(fd); }
}
export function preserveUnreadable(file, onRecovery = () => {}) {
  const backup = `${file}.unreadable-${Date.now()}-${crypto.randomUUID()}`;
  retryFile(() => fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL));
  const message = `저장 파일 손상을 발견했습니다. 원본 보존: ${backup}`;
  console.error(message);
  onRecovery(message);
  return backup;
}
export function readJsonFile(file, fallback, { validate = (v) => v && typeof v === 'object' && !Array.isArray(v), onRecovery } = {}) {
  let text;
  try { text = retryFile(() => fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  try {
    const value = JSON.parse(text);
    if (!validate(value)) throw new Error('Invalid saved data');
    return value;
  } catch (e) {
    if (!(e instanceof SyntaxError) && e.message !== 'Invalid saved data') throw e;
    preserveUnreadable(file, onRecovery);
    writeJsonFile(file, fallback);
    return fallback;
  }
}
