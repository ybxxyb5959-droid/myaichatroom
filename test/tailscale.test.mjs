import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getTailscaleAddress } from '../lib/tailscale.mjs';
import { createAssistantServer, loadConfig } from '../server.mjs';

test('Tailscale address discovery uses the CLI and rejects every non-Tailscale or ambiguous result', async () => {
  const execute = async (bin, args, options) => {
    assert.equal(path.basename(bin), 'tailscale.exe');
    assert.deepEqual(args, ['ip', '-4']);
    assert.equal(options.timeout, 10000);
    return { stdout: '100.64.0.1\r\n' };
  };
  assert.equal(await getTailscaleAddress({ execute, platform: 'win32' }), '100.64.0.1');
  for (const stdout of ['', '127.0.0.1', '0.0.0.0', '192.168.0.1', '100.63.255.255', '100.128.0.1', '::1', '100.64.0.1\n100.64.0.2'])
    await assert.rejects(getTailscaleAddress({ execute: async () => ({ stdout }) }), /전용 IPv4/);
  await assert.rejects(getTailscaleAddress({ execute: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), /설치/);
  await assert.rejects(getTailscaleAddress({ execute: async () => { throw new Error('not logged in'); } }), /로그인/);
});

test('private phone listener binds only the discovered address, preserves authentication and closes with the room', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tailscale-room-'));
  let discoveries = 0;
  const app = createAssistantServer({ root, greetings: false,
    cfg: { ...loadConfig(path.join(root, 'config.json')), external: { port: 0, host: '0.0.0.0' } },
    adapter: { available: () => ({}) },
    // Stand in for the VPN interface on test machines without Tailscale.
    tailscaleAddress: async () => { discoveries++; return '127.0.0.1'; } });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(await app.startExternal(), null);
  const [listener, same] = await Promise.all([app.startExternal({ tailscale: true }), app.startExternal({ tailscale: true })]);
  assert.equal(listener, same);
  assert.equal(discoveries, 1);
  assert.equal(listener.address().address, '127.0.0.1');
  assert.equal(fs.existsSync(path.join(root, 'data/tls')), false);
  const { url, password } = app.phoneConnection();
  assert.ok(password.length >= 20);
  assert.equal((await fetch(`${url}/api/state`)).status, 401);
  assert.equal((await fetch(`${url}/api/dev/state`)).status, 403);
  const send = (route, headers, body = '') => fetch(url + route, { method: 'POST', redirect: 'manual', headers, body });
  assert.equal((await send('/login', { Origin: 'https://evil.example' })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.get(`${url}/api/state`, { headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  const login = await send('/login', { Origin: url }, new URLSearchParams({ password }));
  assert.equal(login.status, 303);
  const cookieHeader = login.headers.get('set-cookie');
  assert.ok(cookieHeader.includes('HttpOnly'));
  assert.ok(cookieHeader.includes('SameSite=Strict'));
  assert.ok(!cookieHeader.includes('Secure'));
  const Cookie = cookieHeader.split(';')[0];
  assert.equal((await fetch(`${url}/api/state`, { headers: { Cookie } })).status, 200);
  assert.equal((await send('/api/room', { Cookie }, '{}')).status, 403);
  assert.equal((await send('/api/room', { Cookie, Origin: url, 'Content-Type': 'application/json' },
    JSON.stringify({ roomName: '휴대폰 연결 확인' }))).status, 200);
  assert.equal(app.room.roomName, '휴대폰 연결 확인');
  await fetch(`${url}/logout`, { headers: { Cookie }, redirect: 'manual' });
  assert.equal((await fetch(`${url}/api/state`, { headers: { Cookie } })).status, 401);
  await app.close();
  assert.equal(listener.listening, false);
  await assert.rejects(app.startExternal({ tailscale: true }), /종료/);
});

test('a Tailscale failure never falls back to a LAN or public listener', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tailscale-missing-'));
  const app = createAssistantServer({ root, greetings: false,
    cfg: loadConfig(path.join(root, 'config.json')), adapter: { available: () => ({}) },
    tailscaleAddress: async () => { throw new Error('Tailscale missing'); } });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(app.startExternal({ tailscale: true }), /Tailscale missing/);
  assert.equal(app.phoneConnection(), null);
  assert.equal(fs.existsSync(path.join(root, 'data/external-auth.json')), false);
});
