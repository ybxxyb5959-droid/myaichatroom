import test from 'node:test';
import assert from 'node:assert/strict';
import { startTailscaleServe } from '../lib/tailscale-serve.mjs';

test('Serve owns only HTTPS 8443, verifies the private target and stops only its own mapping', async () => {
  const calls = [], target = 'http://127.0.0.1:43210', endpoint = 'pc.example.ts.net:8443';
  let config = {};
  const execute = async (_bin, args) => {
    calls.push(args);
    if (args[0] === 'status') return { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.example.ts.net.' } }) };
    if (args[1] === 'status') return { stdout: JSON.stringify(config) };
    if (args.includes('--bg')) config = { TCP: { 8443: { HTTPS: true } }, Web: { [endpoint]: { Handlers: { '/': { Proxy: target } } } } };
    if (args.includes('off')) config = {};
    return { stdout: '' };
  };
  const service = await startTailscaleServe(target, { execute });
  assert.equal(service.url, 'https://pc.example.ts.net:8443');
  assert.deepEqual(calls[2], ['serve', '--bg', '--https=8443', target]);
  assert.ok(calls.every(args => !args.includes('funnel')));
  await service.stop();
  assert.deepEqual(calls.at(-1), ['serve', '--https=8443', 'off']);
  assert.deepEqual(config, {});
});

test('Serve refuses missing login, pre-existing mappings, invalid targets and public Funnel', async () => {
  await assert.rejects(startTailscaleServe('http://0.0.0.0:123'), /로컬/);
  await assert.rejects(startTailscaleServe('http://127.0.0.1:123', { execute: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), /설치/);
  await assert.rejects(startTailscaleServe('http://127.0.0.1:123', { execute: async () => ({ stdout: '{"BackendState":"NeedsLogin"}' }) }), /MagicDNS/);
  const calls = [];
  await assert.rejects(startTailscaleServe('http://127.0.0.1:123', { execute: async (_bin, args) => {
    calls.push(args);
    return { stdout: JSON.stringify(args[0] === 'status' ? { BackendState: 'Running', Self: { DNSName: 'pc.example.ts.net.' } } : { TCP: { 8443: { HTTPS: true } } }) };
  } }), /덮어쓰지/);
  assert.equal(calls.length, 2);
  let config = {}, disabled = false;
  await assert.rejects(startTailscaleServe('http://127.0.0.1:123', { execute: async (_bin, args) => {
    if (args[0] === 'status') return { stdout: '{"BackendState":"Running","Self":{"DNSName":"pc.example.ts.net."}}' };
    if (args[1] === 'status') return { stdout: JSON.stringify(config) };
    if (args.includes('--bg')) config = { TCP: { 8443: { HTTPS: true } }, Web: { 'pc.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:123' } } } }, AllowFunnel: { 'pc.example.ts.net:8443': true } };
    if (args.includes('off')) disabled = true;
    return { stdout: '' };
  } }), /確認|확인/);
  assert.equal(disabled, true);
});
