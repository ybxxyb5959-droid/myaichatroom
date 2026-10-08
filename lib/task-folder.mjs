import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { retryFile, replaceFile, writeToFd } from './atomic.mjs';
import { describeImage, IMAGE_MIME } from './task-image.mjs';

function localPath(value) {
  if (typeof value !== 'string' || !value || value.length > 32767 || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('올바른 절대 폴더 경로가 아닙니다.');
  }
  if (process.platform === 'win32' && /^[\\/]{2}/.test(value)) {
    throw new Error('네트워크·장치 경로 대신 이 PC의 로컬 프로젝트 폴더를 선택하세요.');
  }
  if (path.resolve(value) === path.parse(path.resolve(value)).root) {
    throw new Error('드라이브 전체가 아닌 프로젝트 폴더를 선택하세요.');
  }
}

// Metadata only: never enumerate a folder or read any file inside it.
export function validateTaskFolder(value) {
  localPath(value);
  try {
    const resolved = fs.realpathSync(value);
    localPath(resolved);
    if (!fs.statSync(resolved).isDirectory()) throw new Error('파일이 아닌 폴더를 선택하세요.');
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
    return resolved;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('폴더가 존재하지 않거나 이동되었습니다.');
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error('폴더에 접근할 권한이 없습니다.');
    throw error;
  }
}

export function taskFolderStatus(folderPath) {
  if (!folderPath) return { state: 'unlinked', name: '', error: '' };
  const name = path.basename(folderPath);
  try {
    if (validateTaskFolder(folderPath) !== folderPath) throw new Error('폴더의 실제 위치가 변경되었습니다. 다시 연결하세요.');
    return { state: 'connected', name, error: '' };
  } catch (error) {
    return { state: 'unavailable', name, error: error.message };
  }
}

export const TASK_TEXT_BYTES = 256 * 1024;
const DIRECTORY_LIMIT = 500;
export const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.js', '.jsx', '.ts', '.tsx', '.css', '.html', '.htm', '.py', '.mjs', '.cjs', '.yaml', '.yml', '.xml', '.csv', '.tsv']);
export const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'build']);
const PRIVATE_NAMES = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.credentials', 'authorized_keys', 'known_hosts', 'shadow']);
const PRIVATE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.p8', '.ppk', '.jks', '.keystore', '.der']);
export const privateName = (name) => {
  const lower = name.toLowerCase();
  return lower === '.env' || lower.startsWith('.env.') || lower.startsWith('id_rsa') || lower.startsWith('id_ed25519')
    || lower.startsWith('id_ecdsa') || lower.startsWith('id_dsa') || PRIVATE_NAMES.has(lower) || PRIVATE_EXTENSIONS.has(path.extname(lower))
    || /(^|[._ -])(secrets?|credentials?|passwords?|passwd|tokens?|api[_-]?keys?|private[_-]?keys?|비밀번호|인증키|개인키)([._ -]|$)/i.test(name);
};
export const fileFail = (message, status = 403) => { throw Object.assign(new Error(message), { status }); };
const blockedName = (name) => EXCLUDED.has(name.toLowerCase()) ? '기본 탐색 제외 경로입니다.'
  : privateName(name) ? '민감한 파일·폴더는 기본적으로 읽기를 차단합니다.' : '';

export function relativeParts(relative) {
  if (typeof relative !== 'string' || relative.length > 4096 || /[\\:<>"|*?\x00-\x1f]/.test(relative) || path.posix.isAbsolute(relative)) {
    fileFail('프로젝트 내부의 상대경로만 사용할 수 있습니다.');
  }
  const parts = relative === '' ? [] : relative.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      fileFail('허용하지 않는 경로입니다.');
    }
    const reason = blockedName(part);
    if (reason) fileFail(reason);
  }
  return parts;
}

export function resolveTaskEntry(root, relative) {
  const parts = relativeParts(relative);
  if (!root) fileFail('프로젝트 폴더가 연결되지 않았습니다.', 409);
  if (validateTaskFolder(root) !== root) fileFail('프로젝트 폴더의 실제 위치가 변경되었습니다. 다시 연결하세요.');
  const rootReason = blockedName(path.basename(root));
  if (rootReason) fileFail(rootReason);
  let target = root;
  let stat = fs.lstatSync(root);
  for (const part of parts) {
    target = path.join(target, part);
    stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fileFail('심볼릭 링크와 연결 지점은 탐색하거나 읽을 수 없습니다.');
  }
  const real = fs.realpathSync(target);
  const inside = path.relative(root, real);
  if (path.isAbsolute(inside) || inside === '..' || inside.startsWith(`..${path.sep}`)) fileFail('프로젝트 외부 경로에는 접근할 수 없습니다.');
  for (const part of inside.split(path.sep).filter(Boolean)) {
    const reason = blockedName(part);
    if (reason) fileFail(reason);
  }
  if (!stat.isDirectory() && !stat.isFile()) fileFail('일반 파일과 폴더만 조회할 수 있습니다.');
  if (stat.isFile() && stat.nlink > 1) fileFail('다른 경로와 연결된 하드 링크 파일은 읽을 수 없습니다.');
  return { target: real, stat };
}

export function sameEntry(before, after) {
  if (before.dev !== after.dev || before.ino !== after.ino) fileFail('조회 중 파일 또는 폴더가 변경되었습니다. 새로고침하세요.', 409);
}

// All APIs below are read-only. Relative paths are never used before validation.
export function taskProjectFiles(root, relative, action) {
  try {
    if (!['list', 'read'].includes(action)) fileFail('읽기 전용 탐색 요청만 지원합니다.', 400);
    const { target, stat } = resolveTaskEntry(root, relative);
    if (action === 'list') {
      if (!stat.isDirectory()) fileFail('폴더가 아닌 경로입니다.', 400);
      const directory = fs.opendirSync(target);
      const entries = [];
      let truncated = false;
      try {
        for (let scanned = 0; ; scanned++) {
          const entry = directory.readSync();
          if (!entry) break;
          if (scanned === DIRECTORY_LIMIT) { truncated = true; break; }
          if (EXCLUDED.has(entry.name.toLowerCase())) continue;
          const itemPath = relative ? `${relative}/${entry.name}` : entry.name;
          let blocked = blockedName(entry.name);
          try { relativeParts(itemPath); } catch (error) { blocked = error.message; }
          if (entry.isSymbolicLink()) blocked = '심볼릭 링크·연결 지점은 접근하지 않습니다.';
          else if (!entry.isDirectory() && !entry.isFile()) blocked = '일반 파일·폴더가 아닙니다.';
          entries.push({ name: entry.name, path: itemPath, type: entry.isDirectory() ? 'folder' : 'file', blocked });
        }
      } finally { directory.closeSync(); }
      sameEntry(stat, resolveTaskEntry(root, relative).stat);
      entries.sort((a, b) => (a.type === 'folder' ? 0 : 1) - (b.type === 'folder' ? 0 : 1) || a.name.localeCompare(b.name));
      return { path: relative, entries, truncated, limit: DIRECTORY_LIMIT };
    }
    if (!stat.isFile()) fileFail('파일이 아닌 경로입니다.', 400);
    const result = { name: path.basename(target), path: relative, size: stat.size, kind: 'metadata', limit: TASK_TEXT_BYTES };
    const imageMime = IMAGE_MIME[path.extname(target).toLowerCase()];
    if (imageMime && stat.size <= 6 * 1024 * 1024) {
      // Pictures are shown (and described) read-only; the preview is the exact bytes of the file.
      const bytes = fs.readFileSync(target);
      try { return { ...result, kind: 'image', mime: imageMime, dataUrl: `data:${imageMime};base64,${bytes.toString('base64')}`, image: describeImage(bytes), hash: createHash('sha256').update(bytes).digest('hex') }; }
      catch { return { ...result, reason: '이미지로 해석하지 못해 기본 정보만 표시합니다.' }; }
    }
    if (!TEXT_EXTENSIONS.has(path.extname(target).toLowerCase())) {
      return { ...result, reason: '미리보기를 지원하지 않는 형식입니다. 바이너리·PDF·Office 파일은 기본 정보만 표시합니다.' };
    }
    if (stat.size > TASK_TEXT_BYTES) return { ...result, reason: '256KB를 초과하여 파일 내용을 읽지 않았습니다.' };
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const opened = fs.fstatSync(fd);
      sameEntry(stat, opened);
      sameEntry(opened, resolveTaskEntry(root, relative).stat);
      if (!opened.isFile() || opened.nlink > 1) fileFail('일반 단일 파일만 읽을 수 있습니다.');
      if (opened.size > TASK_TEXT_BYTES) return { ...result, size: opened.size, reason: '256KB를 초과하여 파일 내용을 읽지 않았습니다.' };
      const buffer = Buffer.alloc(TASK_TEXT_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
        if (!count) break;
        bytes += count;
      }
      const after = fs.fstatSync(fd);
      sameEntry(opened, resolveTaskEntry(root, relative).stat);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fileFail('읽는 동안 파일이 변경되었습니다. 다시 선택하세요.', 409);
      if (bytes > TASK_TEXT_BYTES) return { ...result, size: bytes, reason: '256KB를 초과하여 미리보기를 중단했습니다.' };
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes)); }
      catch { return { ...result, reason: 'UTF-8 텍스트가 아니므로 내용은 표시하지 않습니다.' }; }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return { ...result, reason: '바이너리 데이터가 포함되어 기본 정보만 표시합니다.' };
      return { ...result, kind: 'text', text, hash: createHash('sha256').update(buffer.subarray(0, bytes)).digest('hex') };
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fileFail('파일 또는 폴더가 존재하지 않습니다.', 404);
    if (['EACCES', 'EPERM', 'ELOOP'].includes(error.code)) fileFail('파일 또는 폴더에 접근할 수 없습니다.');
    fileFail(error.code ? '파일 또는 폴더 조회에 실패했습니다.' : error.message, 400);
  }
}

// ---- Approved-proposal writes: one existing text file, replaced through a same-folder temp file. ----
export const TASK_TEMP_NAME = /^\.chatroom-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/;
const VERIFY_ENTRIES = 2000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const conflict = (message) => { throw Object.assign(new Error(message), { status: 409, conflict: true }); };

// Re-resolves every path component (links, outside paths, private names, hard links) and reads exact bytes.
function readExisting(root, relative) {
  const entry = resolveTaskEntry(root, relative);
  if (!entry.stat.isFile()) fileFail('파일이 아닌 경로입니다.', 400);
  const fd = fs.openSync(entry.target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd);
    sameEntry(entry.stat, opened);
    if (!opened.isFile() || opened.nlink > 1) fileFail('일반 단일 파일만 수정할 수 있습니다.');
    if (opened.size > TASK_TEXT_BYTES) fileFail('256KB를 초과한 파일은 수정하지 않습니다.', 400);
    const bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (!count) break;
      read += count;
    }
    const after = fs.fstatSync(fd);
    if (read !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fileFail('확인하는 동안 파일이 변경되었습니다. 다시 시도하세요.', 409);
    return { target: entry.target, stat: opened, bytes };
  } finally { fs.closeSync(fd); }
}

// Identity and timestamps of every entry beside the target, so unintended changes in that folder are detected.
function folderSnapshot(dir) {
  const entries = new Map();
  const directory = fs.opendirSync(dir);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (entries.size >= VERIFY_ENTRIES) fileFail(`같은 폴더의 항목이 ${VERIFY_ENTRIES}개를 넘어 변경 검증을 할 수 없으므로 적용을 차단했습니다.`, 400);
      const s = fs.lstatSync(path.join(dir, entry.name), { bigint: true });
      entries.set(entry.name, `${s.mode}:${s.size}:${s.mtimeNs}:${s.ino}`);
    }
  } finally { directory.closeSync(); }
  return entries;
}

function writeError(error) {
  if (error.status) return error;
  const code = error.code;
  const message = code === 'ENOENT' || code === 'ENOTDIR' ? '파일 또는 폴더가 존재하지 않습니다.'
    : code === 'EBUSY' ? '다른 프로그램이 파일을 사용 중입니다. 해당 프로그램을 닫고 다시 시도하세요.'
      : code === 'EACCES' || code === 'EPERM' ? '파일 쓰기 권한이 없거나 다른 프로그램이 파일을 잠그고 있습니다.'
        : code === 'ENOSPC' ? '디스크 공간이 부족합니다.'
          : code === 'ELOOP' ? '링크 경로는 수정할 수 없습니다.'
            : `파일 저장에 실패했습니다.${code ? ` (${code})` : ''}`;
  return Object.assign(new Error(message), { code,
    status: code === 'ENOENT' || code === 'ENOTDIR' ? 404 : code === 'EBUSY' ? 409 : ['EACCES', 'EPERM', 'ELOOP'].includes(code) ? 403 : 500 });
}

// Two-phase replacement. stageTaskTextFile verifies the original and prepares + re-reads a same-folder temp file
// without touching the target; commitStagedTaskFile swaps it in. replaceTaskTextFile = stage + commit.
// beforeWrite (the backup) runs after the hash check and before any project change; if it throws, nothing is touched.
// Thrown errors carry replaced=true only when the target was already swapped and post-write checks failed.
export function stageTaskTextFile(root, relative, { expectedHash, content, tempName, beforeWrite = () => {} }) {
  let temp = null;
  try {
    if (!TASK_TEMP_NAME.test(tempName) || !Buffer.isBuffer(content)) fileFail('올바른 수정 요청이 아닙니다.', 400);
    const first = readExisting(root, relative);
    if (!TEXT_EXTENSIONS.has(path.extname(first.target).toLowerCase())) fileFail('지원하는 텍스트 형식 파일만 수정할 수 있습니다.', 400);
    if (sha256(first.bytes) !== expectedHash) conflict('현재 파일 내용(SHA-256)이 예상과 달라 변경을 중단했습니다.');
    try { fs.accessSync(first.target, fs.constants.W_OK); } catch (error) {
      if (['EACCES', 'EPERM'].includes(error.code)) fileFail('읽기 전용 파일이거나 쓰기 권한이 없어 수정하지 않았습니다.', 403);
      throw error;
    }
    const dir = path.dirname(first.target), name = path.basename(first.target);
    const dirStat = fs.lstatSync(dir);
    beforeWrite(first.bytes);
    const before = folderSnapshot(dir);
    temp = path.join(dir, tempName);
    const fd = retryFile(() => fs.openSync(temp, 'wx', first.stat.mode & 0o777));
    try {
      writeToFd(fd, content);
      fs.fchmodSync(fd, first.stat.mode & 0o777);
    } finally { fs.closeSync(fd); }
    if (!fs.readFileSync(temp).equals(content)) fileFail('임시 파일 내용이 수정안과 일치하지 않아 중단했습니다.', 500);
    return { root, relative, expectedHash, content, tempName, temp, first, dir, name, dirStat, before };
  } catch (error) {
    const result = writeError(error);
    if (temp) {
      try { fs.rmSync(temp, { force: true }); } catch { result.message += ` 임시 파일을 삭제하지 못했습니다: ${tempName}`; }
    }
    throw Object.assign(result, { replaced: false });
  }
}

export function discardStagedTaskFile(staged) {
  try { fs.rmSync(staged.temp, { force: true }); return true; } catch { return false; }
}

// ignoreNames: other entries of the same multi-file job whose temp/target changes are expected in this folder.
export function commitStagedTaskFile(staged, { ignoreNames = [] } = {}) {
  const { root, relative, expectedHash, content, tempName, first, dir, name, dirStat, before } = staged;
  let temp = staged.temp, replaced = false;
  try {
    // Last check immediately before the swap: same file identity, same bytes, same folder, intact temp file.
    const again = readExisting(root, relative);
    if (again.target !== first.target) fileFail('적용 중 대상 경로가 변경되어 중단했습니다.', 409);
    sameEntry(first.stat, again.stat);
    if (again.stat.mtimeMs !== first.stat.mtimeMs || sha256(again.bytes) !== expectedHash) conflict('적용 직전에 파일이 변경되어 중단했습니다.');
    const dirNow = fs.lstatSync(dir);
    if (dirNow.isSymbolicLink() || dirNow.dev !== dirStat.dev || dirNow.ino !== dirStat.ino) fileFail('적용 중 폴더 경로가 변경되어 중단했습니다.', 409);
    const tempStat = fs.lstatSync(temp);
    if (!tempStat.isFile() || tempStat.nlink !== 1 || tempStat.size !== content.length || !fs.readFileSync(temp).equals(content)) fileFail('임시 파일이 변경되어 적용을 중단했습니다.', 409);
    replaceFile(temp, first.target);
    temp = null; replaced = true;
    const result = readExisting(root, relative);
    if (result.target !== first.target || !result.bytes.equals(content)) fileFail('교체 후 파일 내용이 예상한 내용과 일치하지 않습니다.', 500);
    const after = folderSnapshot(dir);
    const ignored = new Set([name, ...ignoreNames]);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((key) => !ignored.has(key) && before.get(key) !== after.get(key));
    if (changed.length) fileFail(`대상 외 항목의 변경이 감지되었습니다: ${changed.slice(0, 5).join(', ')}`, 500);
    return { hash: sha256(result.bytes), size: result.bytes.length, previousHash: sha256(first.bytes),
      checks: ['대상 파일 존재', '내용이 예상과 바이트 단위로 일치', 'SHA-256 일치', '같은 폴더의 다른 항목 변경 없음', '임시 파일 정리됨'] };
  } catch (error) {
    const result = writeError(error);
    if (temp) {
      try { fs.rmSync(temp, { force: true }); } catch { result.message += ` 임시 파일을 삭제하지 못했습니다: ${tempName}`; }
    }
    throw Object.assign(result, { replaced });
  }
}

export function replaceTaskTextFile(root, relative, options) {
  return commitStagedTaskFile(stageTaskTextFile(root, relative, options));
}

// Read-only pre-flight for a multi-file job: the file must be a writable, supported, single regular text file inside the project.
export function inspectTaskTextFile(root, relative) {
  const entry = readExisting(root, relative);
  if (!TEXT_EXTENSIONS.has(path.extname(entry.target).toLowerCase())) fileFail('지원하는 텍스트 형식 파일만 수정할 수 있습니다.', 400);
  try { fs.accessSync(entry.target, fs.constants.W_OK); } catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) fileFail('읽기 전용 파일이거나 쓰기 권한이 없습니다.', 403);
    throw error;
  }
  return { bytes: entry.bytes, hash: sha256(entry.bytes), size: entry.bytes.length };
}

// Removes a temp file left by an interrupted write. Only the exact app-generated name in the target's folder.
export function removeTaskTemp(root, relative, tempName) {
  if (!TASK_TEMP_NAME.test(tempName)) return false;
  const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
  const temp = path.join(resolveTaskEntry(root, parent).target, tempName);
  let stat;
  try { stat = fs.lstatSync(temp); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile()) return false;
  fs.unlinkSync(temp);
  return true;
}

// Source-mode Windows has no Electron window. A fixed STA script owns the native picker;
// no browser-supplied path or shell fragment is interpolated into it.
export async function chooseTaskFolder({ signal } = {}) {
  if (process.platform !== 'win32') throw new Error('이 실행 환경에서는 설치형 데스크톱 앱으로 폴더를 선택해 주세요.');
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.TopMost = $true
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'AI 작업대에 연결할 프로젝트 폴더를 선택하세요'
$dialog.ShowNewFolderButton = $false
try {
  $owner.Show()
  $owner.Activate()
  $selected = $null
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $selected = $dialog.SelectedPath }
  @{ path = $selected } | ConvertTo-Json -Compress
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 180000, maxBuffer: 16384, encoding: 'utf8', signal,
    }, (error, stdout) => {
      if (error) return reject(new Error(error.name === 'AbortError' ? '폴더 선택이 중단되었습니다.'
        : error.killed ? '폴더 선택 시간이 초과되었습니다.' : 'Windows 폴더 선택창을 열지 못했습니다.'));
      try {
        const result = JSON.parse(stdout.trim());
        if (result.path !== null && typeof result.path !== 'string') throw new Error('invalid selection');
        resolve(result.path);
      } catch { reject(new Error('폴더 선택 결과를 확인하지 못했습니다.')); }
    });
  });
}
