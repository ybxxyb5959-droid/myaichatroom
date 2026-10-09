import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setupScript, openTerminal, tailscaleStatus } from '../lib/setup-terminal.mjs';
import { roomFixture } from './helpers/room.mjs';

test('setup scripts install only what is missing and then sign in with the CLI that was found', () => {
  const fresh = setupScript({ kind: 'ai', id: 'claude' });
  assert.match(fresh, /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
  assert.match(fresh, /Refresh-Path/);
  assert.match(fresh, /& \$bin 'auth' 'login'/);
  const known = setupScript({ kind: 'ai', id: 'gpt' }, { installed: "C:\\it's\\codex.exe" });
  assert.doesNotMatch(known, /install\.ps1/);
  assert.match(known, /\$bin = 'C:\\it''s\\codex\.exe'/, 'a path is quoted for PowerShell');
  assert.match(setupScript({ kind: 'ai', id: 'gemini' }), /\/quit/);
  const ts = setupScript({ kind: 'tailscale' }, { env: { ProgramFiles: 'D:\\Apps' } });
  assert.match(ts, /winget install -e --id Tailscale\.Tailscale/);
  assert.match(ts, /'D:\\Apps\\Tailscale\\tailscale\.exe'/);
  assert.match(ts, /& \$ts up/);
  assert.throws(() => setupScript({ kind: 'ai', id: 'nope' }));
  assert.throws(() => setupScript({ kind: 'shell' }));
});

test('a setup window is a visible PowerShell with the script encoded, and its closing is reported', () => {
  let seen;
  const child = new EventEmitter();
  let exited = 0;
  openTerminal('Write-Host "안녕"', { onExit: () => exited++, spawnFn: (cmd, args, opts) => { seen = { cmd, args, opts }; return child; } });
  assert.equal(seen.cmd, 'powershell.exe');
  assert.equal(seen.opts.windowsHide, true, 'the launcher is hidden; the window it starts is not');
  const launcher = seen.args[seen.args.indexOf('-Command') + 1];
  assert.match(launcher, /^Start-Process -FilePath powershell.exe -WindowStyle Normal -Wait /);
  const encoded = launcher.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1];
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), 'Write-Host "안녕"');
  child.emit('exit', 0);
  assert.equal(exited, 1);
});

test('the Tailscale state is read from tailscale status', async () => {
  const env = { ProgramFiles: 'C:\\PF' };
  const reply = (stdout) => ({ env, platform: 'win32', exists: () => true, execute: async () => ({ stdout }) });
  assert.equal((await tailscaleStatus({ env, platform: 'win32', exists: () => false })).status, 'missing');
  const ok = await tailscaleStatus(reply(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'my-pc.tail1234.ts.net.' } })));
  assert.deepEqual([ok.status, ok.name], ['ok', 'my-pc.tail1234.ts.net']);
  assert.equal((await tailscaleStatus(reply(JSON.stringify({ BackendState: 'NeedsLogin' })))).status, 'login');
  assert.equal((await tailscaleStatus(reply(JSON.stringify({ BackendState: 'Stopped' })))).status, 'stopped');
  assert.equal((await tailscaleStatus({ ...reply(''), execute: async () => { throw Object.assign(new Error('x'), { stdout: '' }); } })).status, 'stopped');
});

test('the first-run guide opens a setup window on the PC and finds a CLI installed meanwhile', async (t) => {
  const opened = [];
  let installed = false;
  const s = await roomFixture(t, { ids: ['claude', 'gemini'], server: {
    setupTerminal: (script, { onExit }) => { opened.push({ script, onExit }); return {}; },
    tailscaleCheck: async () => ({ status: 'ok', name: 'pc.ts.net', detail: '' }),
  } });
  s.adapter.rescan = () => ({ claude: true, gpt: installed, gemini: true });
  const r = await s.post('/api/setup/terminal', { kind: 'ai', id: 'gpt' });
  assert.equal(r.status, 200);
  assert.equal(opened.length, 1);
  assert.match(opened[0].script, /chatgpt\.com\/codex\/install\.ps1/);
  assert.deepEqual((await s.post('/api/setup/terminal', { kind: 'ai', id: 'gpt' })).status, 409, 'one window per job');
  s.clock.now += 16 * 60000;
  assert.equal((await s.post('/api/setup/terminal', { kind: 'ai', id: 'gpt' })).status, 200, 'a window lost track of stops blocking');
  opened.shift(); // the newer window is the one that counts now
  let state = await (await fetch(s.base + '/api/state')).json();
  assert.deepEqual(state.setupTerminals, ['ai:gpt']);
  assert.equal(state.catalog.gpt.available, false);
  installed = true;
  await opened[0].onExit();
  state = await (await fetch(s.base + '/api/state')).json();
  assert.deepEqual(state.setupTerminals, []);
  assert.equal(state.catalog.gpt.available, true, 'picked up without a restart');
  assert.equal(state.room.checks.gpt.login.status, 'ok');
  assert.equal((await s.post('/api/setup/terminal', { kind: 'shell', cmd: 'calc' })).status, 400);
  const ts = await s.post('/api/check/tailscale', {});
  assert.deepEqual([ts.status, ts.value.status, ts.value.terminal], [200, 'ok', false]);
  // A page from another site, or anything but the PC's own address, may not open windows.
  const cross = await fetch(s.base + '/api/setup/terminal', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"kind":"tailscale"}' });
  assert.equal(cross.status, 403);
  assert.equal(opened.length, 1);
});
