// Run against development Electron or an already-packaged executable, without touching user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packaged = process.argv[2];
const executable = packaged ? path.resolve(packaged) : createRequire(import.meta.url)('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-desktop-smoke-'));
const env = { ...process.env, CHATROOM_HOME: path.join(root, 'room'),
  CHATROOM_CONFIG: path.join(root, 'config.json') };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [...(packaged ? [] : [project]), '--smoke-test'], {
      cwd: project, env, windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-32000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-32000); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(result.code, 0, JSON.stringify(result));
  const line = result.stdout.split(/\r?\n/).find((s) => s.startsWith('DESKTOP_SMOKE '));
  assert.ok(line, `실행 확인 결과가 없습니다.\n${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(line.slice('DESKTOP_SMOKE '.length));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.packaged, !!packaged);
  assert.equal(receipt.input, '채팅을 입력하세요.');
  console.log(JSON.stringify(receipt));
  if (result.stderr.trim()) console.error(result.stderr.trim());
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
