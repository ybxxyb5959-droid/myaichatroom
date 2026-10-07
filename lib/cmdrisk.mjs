// Second look at a workbench command before it runs. It reads the real arguments and the code passed
// to shells and interpreters (cmd /c, powershell -Command, bash -c, node -e, npm scripts) instead of
// trusting the program name. A match means "ask the user again", even when approval is automatic.
// This is a safety net, not a sandbox: a script file inside the project is not analysed.
import fs from 'node:fs';
import path from 'node:path';

const R = {
  wipe: '현재 작업 내용이 삭제될 수 있습니다.',
  history: '저장소 이력이 바뀌거나 지워질 수 있습니다.',
  push: '외부 저장소로 내용이 전송됩니다.',
  remove: '파일이나 폴더가 삭제됩니다.',
  mass: '여러 파일이 한꺼번에 삭제될 수 있습니다.',
  outside: '프로젝트 밖의 파일이나 경로에 영향을 줄 수 있습니다.',
  upload: '파일이나 데이터가 외부로 전송될 수 있습니다.',
  system: '시스템 설정이나 환경변수가 바뀔 수 있습니다.',
  hidden: '실제로 실행될 내용을 미리 확인할 수 없습니다.',
  disk: '디스크 데이터가 지워질 수 있습니다.',
};
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PWSH = new Set(['powershell', 'pwsh']);
const DELETE = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'shred', 'rimraf', 'trash', 'remove-item', 'ri', 'clear-content', 'clc']);
const DISK = new Set(['format', 'diskpart', 'format-volume', 'clear-disk', 'mkfs', 'dd', 'fdisk', 'cipher']);
const SYSTEM = new Set(['setx', 'schtasks', 'stop-computer', 'restart-computer', 'shutdown', 'bcdedit']);
const NET = new Set(['scp', 'sftp', 'ftp', 'nc', 'ncat', 'netcat', 'telnet']);
const MAX_DEPTH = 4;

const exeName = (cmd) => String(cmd).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
const tokens = (text) => [...String(text).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
// Shell text -> commands: split on ; & | && || and new lines, then into words.
const commands = (text) => String(text).split(/&&|\|\||[;&|\n\r]/).map(tokens).filter((t) => t.length);
const isWithin = (root, target) => {
  const rel = path.relative(root, target);
  return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
// Absolute paths, home and environment references, and ".." paths that leave the project.
const PATHS = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`;|&)<>]*|\\\\[^\s"'`;|&)<>]+|(?<=^|[\s"'=(,])\/(?![\/\s])[^\s"'`;|&)<>]*|(?<=^|[\s"'=(,])~[\\/][^\s"'`;|&)<>]*|%[A-Za-z_]+%|\$env:[A-Za-z_]+|\$\{?HOME\}?|(?<=^|[\s"'=(,])(?:[^\s"'`;|&)<>]*[\\/])?\.\.(?=$|[\\/\s"'`;|&)<>,])(?:[\\/][^\s"'`;|&)<>]*)?/g;
function outside(text, root) {
  for (const [hit] of String(text).matchAll(PATHS)) {
    if (/^\/[A-Za-z?][\w?-]*(:\S*)?$/.test(hit)) continue; // Windows switches such as /s /q /MIR (a bare /word is not a path here)
    if (/^(%|\$|~)/.test(hit)) return true;
    const target = /^[A-Za-z]:|^\\\\|^\//.test(hit) ? path.resolve(hit) : path.resolve(root, hit);
    if (!isWithin(root, target)) return true;
  }
  return false;
}
const flagged = (args, re) => args.some((a) => re.test(a));

function git(args, add) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) { if (['-c', '-C', '--git-dir', '--work-tree'].includes(args[i])) i++; i++; }
  const sub = (args[i] || '').toLowerCase(), rest = args.slice(i + 1), low = rest.map((a) => a.toLowerCase());
  const dry = flagged(low, /^(-n|--dry-run)$/);
  if (sub === 'reset' && flagged(low, /^--(hard|merge|keep)$/)) add(R.wipe);
  if (sub === 'clean' && !dry && flagged(rest, /^-[a-zA-Z]*f|^--force$/)) add(R.wipe);
  if (sub === 'checkout' && (low.includes('--') || flagged(low, /^(\.|:\/|-f|--force)$/))) add(R.wipe);
  if (sub === 'restore' && (!low.includes('--staged') || low.includes('--worktree'))) add(R.wipe);
  if (sub === 'stash' && ['drop', 'clear'].includes(low[0])) add(R.wipe);
  if (sub === 'rm' && !dry) add(R.remove);
  if (sub === 'branch' && flagged(rest, /^(-[dD]|--delete)$/)) add(R.history);
  if (['filter-branch', 'filter-repo'].includes(sub) || (sub === 'reflog' && ['expire', 'delete'].includes(low[0]))
    || (sub === 'gc' && flagged(low, /^--prune/)) || (sub === 'update-ref' && low.includes('-d'))) add(R.history);
  if (sub === 'push') add(R.push);
  if (sub === 'config' && flagged(low, /^--(global|system)$/)) add(R.system);
}
// The npm scripts a command runs, read from the project's package.json.
function npmScripts(exe, args, root) {
  const low = args.map((a) => a.toLowerCase());
  const sub = low[0];
  const name = ['run', 'run-script', 'rum', 'urn'].includes(sub) ? args[1] : ['test', 't', 'tst'].includes(sub) ? 'test'
    : ['start', 'stop', 'restart'].includes(sub) ? sub : exe === 'yarn' && sub && !sub.startsWith('-') ? args[0] : null;
  const file = path.join(root, 'package.json');
  if (!name || !fs.existsSync(file)) return [];
  let scripts;
  try { scripts = JSON.parse(fs.readFileSync(file, 'utf8')).scripts || {}; } catch { return []; } // not valid JSON: npm fails too
  return [`pre${name}`, name, `post${name}`].map((key) => scripts[key]).filter((s) => typeof s === 'string');
}

function inspect(exe, args, root, add, depth) {
  if (depth > MAX_DEPTH) { add(R.hidden); return; }
  const low = args.map((a) => a.toLowerCase());
  const shellText = (text) => {
    // Piping into a shell or Invoke-Expression hides what really runs.
    if (/\|\s*(sh|bash|zsh|pwsh|powershell|iex|invoke-expression)\b/i.test(text)) add(R.hidden);
    for (const [e, ...rest] of commands(text)) inspect(exeName(e), rest, root, add, depth + 1);
  };
  const after = (re) => { const i = low.findIndex((a) => re.test(a)); return i < 0 ? null : args.slice(i + 1); };
  if (exe === 'cmd') {
    const rest = after(/^\/[ckr]$/);
    if (rest) shellText(rest.join(' '));
  } else if (PWSH.has(exe)) {
    const enc = low.findIndex((a) => /^-(e|ec|enc|encodedcommand)$/.test(a));
    if (enc >= 0) {
      const decoded = Buffer.from(args[enc + 1] || '', 'base64').toString('utf16le');
      if (!decoded.trim() || /[\u0000-\u0008\ufffd]/.test(decoded)) add(R.hidden); else shellText(decoded);
    }
    const file = after(/^-(f|file)$/);
    if (file) { if (file[0] && outside(file[0], root)) add(R.outside); }
    else {
      const rest = after(/^-(c|command)$/) || args.filter((a) => !a.startsWith('-'));
      if (rest.length) shellText(rest.join(' '));
    }
  } else if (SHELLS.has(exe)) {
    const rest = after(/^-[a-z]*c$/);
    if (rest) shellText(rest.join(' '));
  } else if (['node', 'deno', 'bun', 'python', 'python3', 'py', 'perl', 'ruby'].includes(exe)) {
    const code = after(/^(-e|--eval|-p|--print|-c|eval)$/)?.[0];
    if (code !== undefined) {
      if (/\b(rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink|rimraf|rmtree|removedirs|remove)\s*\(/.test(code)) add(R.remove);
      if (/child_process|\bexec(Sync|File|FileSync)?\s*\(|\bspawn(Sync)?\s*\(|subprocess|os\.system|os\.popen|\beval\s*\(|Deno\.(run|Command)|\bsystem\s*\(/.test(code)) add(R.hidden);
      if (/method\s*:\s*['"](POST|PUT|PATCH)|requests\.(post|put)|\.(put|post)\s*\(|net\.connect|dgram|https?\.request/i.test(code)) add(R.upload);
      if (outside(code, root)) add(R.outside);
    } else if (outside(args.join(' '), root)) add(R.outside); // a script file outside the project

  } else if (['npm', 'pnpm', 'yarn'].includes(exe)) {
    if (['publish', 'unpublish', 'deprecate'].includes(low[0])) add(R.upload);
    if (flagged(low, /^(-g|--global|--location=global)$/) || (low[0] === 'config' && ['set', 'delete'].includes(low[1]))) add(R.system);
    for (const script of npmScripts(exe, args, root)) shellText(script);
  } else if (exe === 'git') git(args, add);
  else if (DELETE.has(exe)) {
    add(R.remove);
    if (flagged(low.filter((a) => a !== '-force'), /^(-[a-z]*r[a-z]*|--recursive|\/s)$/) || flagged(args, /[*?]/) || flagged(args, /^(\.|\.\.|\.[\\/]|\/|[A-Za-z]:[\\/]?)$/)) add(R.mass);
  } else if (exe === 'find' && flagged(low, /^(-delete|-exec|-execdir)$/)) add(R.remove);
  else if (exe === 'robocopy' && flagged(low, /^\/(mir|purge)$/)) add(R.mass);
  else if (DISK.has(exe) || /^mkfs/.test(exe)) add(R.disk);
  else if (SYSTEM.has(exe) || (exe === 'reg' && ['add', 'delete', 'import', 'restore'].includes(low[0]))) add(R.system);
  else if (['set-itemproperty', 'new-itemproperty', 'remove-itemproperty', 'sp'].includes(exe) && flagged(args, /^(HK|Registry::)/i)) add(R.system);
  else if (['invoke-expression', 'iex'].includes(exe)) add(R.hidden);
  else if (NET.has(exe) || (exe === 'rsync' && args.some((a) => /^[^/\\]*:/.test(a) && !/^[A-Za-z]:/.test(a)))) add(R.upload);
  else if (['curl', 'wget'].includes(exe) && flagged(args, /^(-T|--upload-file|-F|--form|--post-file|--body-file)$|^(-d|--data(-binary|-raw|-urlencode)?)$|^@|^-X(POST|PUT)$/i)) add(R.upload);
  else if (['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'].includes(exe) && (flagged(low, /^-infile$/) || low.some((a, i) => a === '-method' && /^(post|put|patch)$/.test(low[i + 1] || '')))) add(R.upload);
  if (/\[environment\]::setenvironmentvariable/i.test(args.join(' ')) || exe.startsWith('[environment]::setenvironmentvariable')) add(R.system);
  if (!['node', 'deno', 'bun', 'python', 'python3', 'py', 'perl', 'ruby'].includes(exe) && depth > 0 && outside(args.join(' '), root)) add(R.outside);
}

// null when nothing risky was found, otherwise { reasons: [...] } in plain Korean.
export function assessCommand(command, args, projectRoot) {
  const reasons = new Set();
  const add = (reason) => reasons.add(reason);
  const exe = exeName(command);
  inspect(exe, args, projectRoot, add, 0);
  // Top-level arguments (not the program path itself) that point outside the project.
  if (!['node', 'deno', 'bun', 'python', 'python3', 'py', 'perl', 'ruby'].includes(exe) && outside(args.join(' '), projectRoot)) add(R.outside);
  return reasons.size ? { reasons: [...reasons] } : null;
}
