import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './agents.mjs';
import { taskSystem } from './task-prompts.mjs';

// Codex and Gemini (agy) as workbench AIs. Both use the CLI's own subscription login; no API keys are read or created.
// One task is handled by exactly one AI. Neither CLI can be started without tools the way Claude's `--tools ""` allows, so each
// runs the way the chat room already runs it: in an empty scratch folder, with shell/computer tools switched off.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const scratch = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const ALL_MODES = ['analysis', 'proposal', 'explore', 'plan', 'plan.proposals', 'changes', 'docs'];
const API_KEY_ENV = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']);
const subscriptionEnv = (extra = {}) => {
  const env = { ...extra };
  // run() merges overrides into process.env; undefined removes a key from the child environment.
  for (const key of new Set([...API_KEY_ENV, ...Object.keys(process.env), ...Object.keys(extra)])) {
    if (API_KEY_ENV.has(key.toUpperCase())) env[key] = undefined;
  }
  return env;
};

export class CodexTaskProvider {
  constructor(adapter, { runner = run } = {}) {
    this.id = 'codex'; this.label = 'Codex · ChatGPT 구독'; this.shortName = 'Codex';
    this.bin = adapter.bins?.codex; this.cfg = adapter.cfg?.agents?.gpt || {}; this.runner = runner;
    this.modes = new Set(ALL_MODES); this.maxInputChars = 400000; this.verifiedAt = 0; this.imageCapable = true;
    this.note = 'ChatGPT 구독 로그인(codex login)을 사용합니다. 셸·브라우저·컴퓨터 도구를 끄고 읽기 전용 샌드박스의 빈 폴더에서 실행합니다.';
  }
  available() { return !!this.bin && fs.existsSync(this.bin); }
  verified() { return Date.now() - this.verifiedAt < 600000; }
  async check(signal) {
    if (!this.available()) return { ok: false, state: 'missing', detail: 'Codex CLI가 설치되어 있지 않습니다.' };
    const options = { timeoutMs: 30000, signal, env: subscriptionEnv() };
    const version = await this.runner(this.bin, ['--version'], options);
    if (version.code !== 0) return { ok: false, state: 'missing', detail: 'Codex CLI를 실행하지 못했습니다.' };
    const help = await this.runner(this.bin, ['exec', '--help'], options);
    const flags = ['--ignore-user-config', '--ephemeral', '--sandbox', '--disable', '--skip-git-repo-check', '--output-last-message'];
    if (help.code !== 0 || !flags.every((flag) => help.stdout.includes(flag))) return { ok: false, state: 'unsupported', detail: '이 Codex 버전은 필요한 안전 옵션(읽기 전용·임시 세션·도구 차단)을 확인하지 못해 사용하지 않습니다.' };
    const login = await this.runner(this.bin, ['login', 'status'], options);
    const text = `${login.stdout}\n${login.stderr}`;
    if (login.code !== 0 || !/logged in/i.test(text) || /not logged in/i.test(text)) return { ok: false, state: 'login', detail: 'Codex에 로그인되어 있지 않습니다. 터미널에서 codex login을 실행하세요.' };
    if (/api key/i.test(text) && !/chatgpt/i.test(text)) return { ok: false, state: 'api-key', detail: 'API 키 로그인은 사용하지 않습니다. ChatGPT 계정으로 codex login 하세요.' };
    this.verifiedAt = Date.now();
    return { ok: true, state: 'ready', detail: `${version.stdout.trim()} · ${text.trim().split('\n')[0]}` };
  }
  async prepare(signal) { const result = await this.check(signal); if (!result.ok) fail(result.detail); return result.detail; }
  async analyze(input, { signal, timeoutMs = 150000, mode = 'analysis', images = [] } = {}) {
    const cwd = scratch('chatroom-readonly-codex-');
    const outFile = path.join(cwd, 'reply.txt');
    try {
      const effort = ['plan', 'changes', 'proposal', 'multi'].includes(mode) ? 'medium' : 'low';
      const imageFiles = images.map((image, i) => { const file = path.join(cwd, `image${i + 1}${path.extname(image.name || '') || '.png'}`); fs.writeFileSync(file, image.bytes); return file; });
      const args = ['exec', '-m', this.cfg.model || 'gpt-6-sol', '-c', `model_reasoning_effort="${effort}"`, '--skip-git-repo-check', '--ignore-user-config', '--ephemeral',
        '-s', 'read-only', '--disable', 'shell_tool', '--disable', 'computer_use', '--disable', 'browser_use', '--disable', 'apps',
        '-c', 'web_search="disabled"', '-c', 'windows.sandbox="unelevated"', ...imageFiles.map((file) => `--image=${file}`), '--color', 'never', '-o', outFile, '-'];
      const result = await this.runner(this.bin, args, { input: `${taskSystem(mode)}\n\n=====\n\n${input}`, cwd, timeoutMs, signal, env: subscriptionEnv(), maxOutputBytes: 8 * 1024 * 1024 });
      if (result.code === -3 || signal?.aborted) fail('AI 실행을 취소했습니다.');
      if (result.code === -2) fail('AI 실행 시간이 초과되어 프로세스를 종료했습니다.');
      if (result.code === -4) fail('AI 출력 크기 제한을 초과하여 프로세스를 종료했습니다.');
      if (result.code !== 0) fail('Codex CLI 실행에 실패했습니다. 로그인·사용량 한도·네트워크 상태를 확인하세요.');
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch { /* handled below */ }
      if (!text.trim()) fail('Codex가 답변을 반환하지 않았습니다. 로그인·사용량 한도를 확인하세요.');
      if (Buffer.byteLength(text) > 3 * 1024 * 1024) fail('AI 답변이 저장 크기 제한을 초과했습니다.');
      return text.trim();
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  }
}

export class AgyTaskProvider {
  constructor(adapter, { runner = run } = {}) {
    this.id = 'gemini'; this.label = 'Gemini · agy 로그인'; this.shortName = 'Gemini';
    this.adapter = adapter; this.bin = adapter.bins?.agy; this.cfg = adapter.cfg?.agents?.gemini || {}; this.runner = runner;
    // agy takes the whole prompt as one command-line argument, so only small inputs fit.
    this.modes = new Set(['analysis', 'docs']); this.maxInputChars = 24000; this.verifiedAt = 0;
    this.docLimits = { chunkBatch: 1, reduceBytes: 14000, reduceGroup: 6 };
    this.note = 'agy(Antigravity) 로그인을 사용합니다. 명령줄로 프롬프트를 전달하므로 한 번에 약 2.4만 자까지만 처리해 단순 분석·문서 분석만 지원합니다.';
  }
  available() { return !!this.bin && fs.existsSync(this.bin); }
  verified() { return Date.now() - this.verifiedAt < 600000; }
  env() { return subscriptionEnv(this.adapter.agyEnv ? this.adapter.agyEnv() : {}); }
  // agy has no login-status command: the only honest check is one tiny real call, remembered for ten minutes.
  async check(signal) {
    if (!this.available()) return { ok: false, state: 'missing', detail: 'Gemini(agy) CLI가 설치되어 있지 않습니다.' };
    if (this.verified()) return { ok: true, state: 'ready', detail: '최근 연결 확인 완료' };
    const cwd = scratch('chatroom-readonly-agy-');
    try {
      const result = await this.runner(this.bin, ['--model', this.cfg.model || 'gemini-3.8-flash-medium', '--output-format', 'json', '--print-timeout', '60s', '-p', '연결 확인용 호출이다. OK라고만 답하라.'],
        { cwd, timeoutMs: 90000, signal, env: this.env() });
      let json = null; try { json = JSON.parse(result.stdout); } catch { /* not json */ }
      if (result.code === 0 && json?.status === 'SUCCESS' && typeof json.response === 'string' && json.response.trim()) { this.verifiedAt = Date.now(); return { ok: true, state: 'ready', detail: '연결 확인 완료(실제 호출 1회 사용)' }; }
      return { ok: false, state: 'login', detail: `Gemini(agy) 호출에 실패했습니다. agy 로그인 상태를 확인하세요. ${(result.stderr || result.stdout || '').slice(-160)}` };
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  }
  async prepare(signal) { const result = await this.check(signal); if (!result.ok) fail(result.detail); return result.detail; }
  async analyze(input, { signal, timeoutMs = 150000, mode = 'analysis' } = {}) {
    const prompt = `${taskSystem(mode)}\n\n=====\n\n${input}`;
    if (prompt.length > this.maxInputChars) fail(`Gemini(agy)는 한 번에 약 ${this.maxInputChars.toLocaleString('ko-KR')}자까지만 받을 수 있어 이 입력(${prompt.length.toLocaleString('ko-KR')}자)을 처리할 수 없습니다. 다른 AI를 선택하세요.`);
    const cwd = scratch('chatroom-readonly-agy-');
    try {
      const result = await this.runner(this.bin, ['--model', this.cfg.model || 'gemini-3.8-flash-medium', '--output-format', 'json', '--print-timeout', `${Math.round(timeoutMs / 1000)}s`, '-p', prompt],
        { cwd, timeoutMs: timeoutMs + 10000, signal, env: this.env(), maxOutputBytes: 4 * 1024 * 1024 });
      if (result.code === -3 || signal?.aborted) fail('AI 실행을 취소했습니다.');
      if (result.code === -2) fail('AI 실행 시간이 초과되어 프로세스를 종료했습니다.');
      let json = null; try { json = JSON.parse(result.stdout); } catch { fail('Gemini(agy) 응답 형식을 확인하지 못했습니다.'); }
      // A tool call is denied in headless mode; an answer that only consists of denied actions is not an answer.
      if (result.code !== 0 || json?.status !== 'SUCCESS' || typeof json.response !== 'string' || !json.response.trim()) fail('Gemini(agy)가 성공한 답변을 반환하지 않았습니다. 로그인·사용량 한도를 확인하세요.');
      if (json.response.length > 3 * 1024 * 1024) fail('AI 답변이 저장 크기 제한을 초과했습니다.');
      // agy likes to turn file names into file:/// links that point into its scratch folder; show plain names instead.
      return json.response.replace(/\[([^\]]+)\]\(file:\/\/\/[^)]*\)/g, '$1').trim();
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  }
}
