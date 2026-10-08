import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Process-level safety for the workbench data directory: one writer at a time, stale locks taken over,
// leftover temp files and unreferenced backups reported and (only when asked) removed.
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
export const STALE_LOCK_MS = 30 * 60000;

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Lock files hold JSON {pid, token, at}. The old format (a bare pid) is still understood.
export function readLock(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object') return { pid: Number(value.pid), token: value.token || '', at: Number(value.at) || 0 };
    return { pid: Number(value), token: '', at: 0 };
  } catch { return { pid: Number(text), token: '', at: 0 }; }
}

export function lockIsStale(lock, file, now = Date.now(), maxAgeMs = STALE_LOCK_MS) {
  if (!lock || !pidAlive(lock.pid)) return true;
  // A recycled PID can keep a dead owner's lock "alive" forever; no write or session lasts this long.
  let at = lock.at;
  if (!at) { try { at = fs.statSync(file).mtimeMs; } catch { return true; } }
  return maxAgeMs > 0 && now - at > maxAgeMs;
}

// Takes the lock file or throws 409. Returns {release, tookOver}. `owners` tracks locks held by this very process,
// so a second server object in one process cannot silently share a data directory.
const held = new Map();
export function acquireLock(file, { maxAgeMs = STALE_LOCK_MS, busy = '다른 서버 프로세스가 같은 작업 데이터를 사용 중입니다. 하나의 서버만 사용하세요.', now = Date.now } = {}) {
  const key = path.resolve(file).toLowerCase();
  if (held.has(key)) fail(busy);
  const token = randomUUID();
  let tookOver = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: now() })); } finally { fs.closeSync(fd); }
      held.set(key, token);
      return {
        tookOver, token,
        release() {
          if (held.get(key) !== token) return;
          held.delete(key);
          // Never remove a lock that another owner has taken over meanwhile.
          if (readLock(file)?.token === token) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') fail('잠금 파일을 만들지 못해 작업을 시작하지 않았습니다.', 500);
      const lock = readLock(file);
      if (!lockIsStale(lock, file, now(), maxAgeMs)) fail(busy);
      try { fs.unlinkSync(file); tookOver = true; } catch { /* another process won the race; retry */ }
    }
  }
  return fail('잠금을 확보하지 못했습니다.');
}

const ATOMIC_TEMP = /\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/i;
// Temp files of interrupted atomic saves ("<file>.<uuid>.tmp"). Only old files are removed, so a write in
// progress in another process is never disturbed. Returns the removed names.
export function cleanAtomicTemps(dir, { olderThanMs = 10 * 60000, now = Date.now() } = {}) {
  const removed = [];
  const walk = (current, depth) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (entry.isFile() && ATOMIC_TEMP.test(entry.name)) {
        try {
          if (now - fs.statSync(full).mtimeMs >= olderThanMs) { fs.unlinkSync(full); removed.push(path.relative(dir, full)); }
        } catch { /* in use; next start */ }
      }
    }
  };
  walk(dir, 0);
  return removed;
}

// Backup bookkeeping. `referenced` is a Map of absolute backup path -> {keep:boolean} supplied by the stores.
export function scanBackups(dirs, referenced, { now = Date.now(), orphanDays = 7, finishedDays = 30 } = {}) {
  const files = [];
  const walk = (current, depth) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (entry.isFile() && !ATOMIC_TEMP.test(entry.name)) {
        const stat = fs.statSync(full);
        const ref = referenced.get(path.resolve(full).toLowerCase());
        const ageDays = (now - stat.mtimeMs) / 86400000;
        // Needed backups (unresolved/restorable work) are never prunable, whatever their age.
        const prunable = ref ? (ref.keep === false && ageDays >= finishedDays) : ageDays >= orphanDays;
        files.push({ file: full, size: stat.size, ageDays: Math.floor(ageDays), referenced: !!ref, prunable });
      }
    }
  };
  for (const dir of dirs) walk(dir, 0);
  return { files, totalBytes: files.reduce((sum, f) => sum + f.size, 0), prunableBytes: files.filter((f) => f.prunable).reduce((sum, f) => sum + f.size, 0),
    prunableCount: files.filter((f) => f.prunable).length };
}

export function pruneBackups(report, root) {
  const removed = [];
  const base = path.resolve(root).toLowerCase();
  for (const item of report.files) {
    // Only files inside the app's own backup directory are ever deleted.
    if (!item.prunable || !path.resolve(item.file).toLowerCase().startsWith(base + path.sep)) continue;
    try { fs.unlinkSync(item.file); removed.push(item.file); } catch { /* try again later */ }
  }
  return removed;
}
