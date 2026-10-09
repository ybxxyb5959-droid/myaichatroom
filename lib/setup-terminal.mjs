// First-run helpers for the installed app: open a visible PowerShell window that installs and signs in to
// an AI CLI or Tailscale, and read whether the PC's Tailscale is ready. Only fixed scripts are ever run;
// nothing from a request is put into a command line.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

// The official installers (no Node.js needed) and how each CLI signs in.
export const AI_SETUP = {
  claude: { name: 'Claude', install: 'irm https://claude.ai/install.ps1 | iex', bin: 'claude', fallback: '$env:USERPROFILE\\.local\\bin\\claude.exe', login: ['auth', 'login'] },
  gpt: { name: 'ChatGPT (Codex)', install: 'irm https://chatgpt.com/codex/install.ps1 | iex', bin: 'codex', fallback: '$env:LOCALAPPDATA\\Programs\\OpenAI\\Codex\\bin\\codex.exe', login: ['login'] },
  gemini: { name: 'Gemini (Antigravity)', install: 'irm https://antigravity.google/cli/install.ps1 | iex', bin: 'agy', fallback: '$env:LOCALAPPDATA\\agy\\bin\\agy.exe', login: [],
    note: '브라우저가 열리면 구독 중인 Google 계정으로 로그인하세요. 로그인이 끝나면 /quit 를 입력하거나 이 창을 닫으세요.' },
};
const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;

export const tailscaleBin = (env = process.env) => path.join(env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');

// A PowerShell script for one setup job. `installed` is the CLI path the app already found (null = install first).
export function setupScript(job, { installed = null, env = process.env } = {}) {
  const lines = ['$ErrorActionPreference = "Continue"', '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    // Commands installed a moment ago are not on this window's PATH yet.
    'function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path","User") + ";" + [Environment]::GetEnvironmentVariable("Path","Machine") }',
    'function Say($t) { Write-Host ""; Write-Host $t -ForegroundColor Cyan }',
    '$failed = $false',
    // Key presses proved unreliable in these windows (Read-Host returned at once or never saw Enter, and stray
    // Enter events arrived), so the window just counts down and closes itself; the X button closes it sooner.
    'function Close-Soon($sec) {',
    '  for ($i = $sec; $i -gt 0; $i--) { Write-Host -NoNewline ("`r이 창은 {0}초 뒤 자동으로 닫혀요. 바로 닫으려면 오른쪽 위 X를 누르세요.  " -f $i) -ForegroundColor DarkGray; Start-Sleep 1 }',
    '  exit 0',
    '}'];
  if (job.kind === 'ai') {
    const c = AI_SETUP[job.id];
    if (!c) throw new Error('알 수 없는 AI입니다.');
    lines.push(`$Host.UI.RawUI.WindowTitle = ${ps(`AI 단톡방 · ${c.name} 연결`)}`);
    if (!installed) lines.push(`Say ${ps(`${c.name} 프로그램을 설치하는 중이에요… (1~3분)`)}`, c.install, 'Refresh-Path');
    lines.push(installed ? `$bin = ${ps(installed)}`
      : `$bin = (Get-Command ${ps(c.bin)} -ErrorAction SilentlyContinue).Source; if (-not $bin) { $bin = "${c.fallback}" }`);
    lines.push('if (-not (Test-Path $bin)) { $failed = $true; Say "설치를 마치지 못했어요. 위의 오류를 확인하고 앱에서 다시 눌러 주세요." }',
      `else { Say ${ps(`${c.name}에 로그인해요. 브라우저가 열리면 계정으로 로그인하세요.`)}; ${c.note ? `Say ${ps(c.note)}; ` : ''}& $bin ${c.login.map(ps).join(' ')}; if ($LASTEXITCODE) { $failed = $true } }`);
  } else if (job.kind === 'tailscale') {
    const bin = tailscaleBin(env);
    lines.push(`$Host.UI.RawUI.WindowTitle = ${ps('AI 단톡방 · Tailscale 연결')}`, `$ts = ${ps(bin)}`);
    lines.push('if (-not (Test-Path $ts)) {',
      '  Say "Tailscale을 설치하는 중이에요… 설치 확인 창이 뜨면 [예]를 눌러 주세요."',
      '  if (Get-Command winget -ErrorAction SilentlyContinue) { winget install -e --id Tailscale.Tailscale --accept-source-agreements --accept-package-agreements }',
      '  else { Say "자동 설치를 할 수 없어 다운로드 페이지를 열어요. 설치한 뒤 앱에서 다시 눌러 주세요."; Start-Process "https://tailscale.com/download/windows" }',
      '}',
      'if (Test-Path $ts) {',
      '  Say "Tailscale에 로그인해요. 브라우저가 열리면 휴대폰과 같은 계정으로 로그인하세요."',
      '  & $ts up',
      '  $state = try { (& $ts status --json | Out-String | ConvertFrom-Json).BackendState } catch { "" }',
      '  if ($state -eq "Running") { Say "Tailscale이 연결됐어요." } else { $failed = $true; Say "아직 연결되지 않았어요. 작업 표시줄의 Tailscale 아이콘에서 로그인해 주세요." }',
      '} else { $failed = $true }');
  } else throw new Error('알 수 없는 설정 작업입니다.');
  // A problem stays on screen longer so it can be read.
  lines.push('if ($failed) { Close-Soon 60 } else { Say "끝났어요. 앱으로 돌아가면 자동으로 다시 확인해요."; Close-Soon 10 }');
  return lines.join('\n');
}

// Opens the script in its own console window. Resolves with the child; `onExit` runs when the window closes.
export function openTerminal(script, { onExit = () => {}, spawnFn = spawn } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  // Node's `detached` gives a console program no window at all on Windows, so a hidden PowerShell starts the
  // visible one in a new console and waits: this child exits when the person closes that window.
  const launcher = `Start-Process -FilePath powershell.exe -WindowStyle Normal -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`;
  const child = spawnFn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launcher],
    { windowsHide: true, stdio: 'ignore' });
  child.once('error', () => onExit());
  child.once('exit', () => onExit());
  return child;
}

// Is the PC's Tailscale installed, running and signed in? {status: 'missing'|'stopped'|'login'|'ok', name?, detail}
export async function tailscaleStatus({ execute = runFile, env = process.env, exists = fs.existsSync, platform = process.platform } = {}) {
  const bin = platform === 'win32' ? tailscaleBin(env) : 'tailscale';
  if (platform === 'win32' && !exists(bin)) return { status: 'missing', detail: 'PC에 Tailscale이 설치되어 있지 않아요.' };
  let out;
  try { out = (await execute(bin, ['status', '--json'], { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', detail: 'PC에 Tailscale이 설치되어 있지 않아요.' };
    out = error.stdout || '';
    if (!out) return { status: 'stopped', detail: 'Tailscale이 꺼져 있어요. 작업 표시줄의 Tailscale을 켜 주세요.' };
  }
  let j;
  try { j = JSON.parse(out); } catch { return { status: 'stopped', detail: 'Tailscale 상태를 읽지 못했어요. Tailscale 앱이 켜져 있는지 확인해 주세요.' }; }
  if (j.BackendState === 'Running') {
    const name = String(j.Self?.DNSName || '').replace(/\.$/, '');
    return { status: 'ok', name, detail: name ? `${name} 로 연결돼 있어요.` : '연결돼 있어요.' };
  }
  if (j.BackendState === 'NeedsLogin' || j.BackendState === 'NoState') return { status: 'login', detail: 'Tailscale 로그인이 필요해요.' };
  if (j.BackendState === 'NeedsMachineAuth') return { status: 'login', detail: 'Tailscale 관리 화면에서 이 PC를 승인해 주세요.' };
  return { status: 'stopped', detail: 'Tailscale이 꺼져 있어요. 작업 표시줄의 Tailscale을 켜 주세요.' };
}
