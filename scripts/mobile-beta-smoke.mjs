// Optional fast mobile smoke. Uses an installed Playwright and mock providers only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createAssistantServer, loadConfig } from '../server.mjs';
import { House } from '../lib/house.mjs';
const modulePath = process.env.CHATROOM_PLAYWRIGHT;
if (!modulePath) throw new Error('Set CHATROOM_PLAYWRIGHT to an installed playwright/index.mjs');
const { chromium } = await import(pathToFileURL(modulePath));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-mobile-beta-'));
const home = new House(path.join(root, 'data', 'house.json'), { ids: ['gemini', 'gpt', 'claude'], names: {} });
home.s.floors = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`${12 + i % 4},${12 + Math.floor(i / 4)}`, 'wood']));
home.s.walls = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`${12 + i},11`, { c: 'cream', door: i === 1 }]));
home.save();
let target, browser, proxy;
const app = createAssistantServer({ root, cfg: loadConfig(path.join(root, 'config.json')),
  adapter: { available: () => ({ claude: true, gpt: true, gemini: true }), chat: () => { throw new Error('Real AI calls forbidden'); } },
  tailscaleFunnel: async url => { target = url; return { url: 'https://room.example.ts.net:8443', stop: async () => {} }; } });
try {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${app.server.address().port}`;
  const owner = async (route, body) => {
    const res = await fetch(local + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    assert.equal(res.status, 200); return res.json();
  };
  await owner('/api/share/connect', { public: true });
  // Loopback-only mock reverse proxy: no Funnel/Serve is enabled.
  proxy = http.createServer((req, res) => {
    const headers = { ...req.headers, host: 'room.example.ts.net:8443' };
    if (headers.origin) headers.origin = 'https://room.example.ts.net:8443';
    const forward = http.request(target + req.url, { method: req.method, headers }, upstream => {
      const responseHeaders = { ...upstream.headers };
      if (responseHeaders['set-cookie']) responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(v => v.replace('; Secure', ''));
      res.writeHead(upstream.statusCode, responseHeaders); upstream.pipe(res);
    });
    forward.on('error', () => { res.writeHead(502); res.end(); });
    res.on('close', () => forward.destroy()); req.pipe(forward);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${proxy.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const width of process.env.CHATROOM_SMOKE_WIDTHS ? process.env.CHATROOM_SMOKE_WIDTHS.split(',').map(Number) : [1280, 430]) {
    const context = await browser.newContext({ viewport: { width, height: 860 }, isMobile: width < 600, hasTouch: width < 600 });
    const page = await context.newPage(), errors = [], failedAssets = [];
    page.on('response', response => { if (/\.(css|js|mjs)(?:\?|$)/.test(response.url()) && response.status() >= 400) failedAssets.push(response.url()); });
    page.on('pageerror', error => errors.push(error.message));
    const invite = await owner('/api/share/invite', { role: 'guest' });
    await page.goto(address + '/join' + new URL(invite.link).hash);
    await page.locator('#joinName').fill(`모바일${width}`);
    await page.locator('#joinSubmit').click();
    await page.locator('#input').waitFor({ state: 'visible' });
    await page.locator('#input').fill(`반가워 ${width}`); await page.locator('#send').click();
    await page.getByText(`반가워 ${width}`, { exact: true }).waitFor();
    app.runtime.post({ from: 'claude', text: '같이 집을 둘러보고 마당 투표에 참여해 보자!', model: 'Mock' });
    assert.ok((await owner('/api/state')).messages.some(m => m.text === `반가워 ${width}`));
    await page.reload(); await page.locator('#input').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px chat overflow`);
    assert.equal(await page.locator('#members .member').count(), 3);
    assert.equal(await page.locator('#guestForm').count(), 0);
    assert.equal(await page.locator('#taskBtn').isVisible(), false);
    if (width < 600) await page.locator('#openSide').click();
    await page.locator('#members [data-profile=claude]').click(); await page.locator('#sheetName').waitFor(); await page.locator('#sheetClose').click();
    await page.locator('#aiSheet').waitFor({ state: 'hidden' });
    if (width < 600) await page.locator('#scrim').click({ position: { x: width - 10, y: 100 } });
    if (width < 600) await page.waitForFunction(() => document.querySelector('#side').getBoundingClientRect().right <= 1);
    if (process.env.CHATROOM_SMOKE_OUTPUT) await page.screenshot({ path: path.join(process.env.CHATROOM_SMOKE_OUTPUT, `friend-chat-${width}.png`) });
    await page.locator('#houseBtn').click(); await page.locator('#hsStory').waitFor({ state: 'visible' });
    if (width < 600) await page.locator('#hsStory summary').click();
    await page.locator('#hsStory [data-joint="1"]').click();
    await page.locator('#hsStory button[aria-pressed="true"]').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px house overflow`);
    assert.equal(await page.locator('#hsMode').isVisible(), false);
    assert.equal(await page.locator('#hsError').isVisible(), false, '3D imports should work');
    const denied = await page.evaluate(async () => Promise.all(['/api/tasks', '/api/share', '/api/room', '/api/file?path=secret.txt'].map(async route => [route, (await fetch(route)).status])));
    assert.ok(denied.every(([, status]) => status === 403));
    const mutation = await page.evaluate(async () => (await fetch('/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: { claude: true } }) })).status);
    assert.equal(mutation, 403);
    assert.deepEqual(failedAssets, []);
    if (process.env.CHATROOM_SMOKE_OUTPUT) await page.screenshot({ path: path.join(process.env.CHATROOM_SMOKE_OUTPUT, `friend-house-${width}.png`) });
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(r => new URL(r.url).pathname)))).flat());
    assert.ok(cached.length > 0);
    assert.ok(cached.every(url => ['/offline.html', '/icon-192.png', '/icon-512.png'].includes(url)), 'cache only public offline assets');
    await page.locator('#hsClose').click();
    await context.setOffline(true);
    await page.locator('.pwa-connection').waitFor({ state: 'visible' });
    await context.setOffline(false);
    await page.locator('.pwa-connection').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: common index/chat renderer, CSS/JS loads, 3D house/vote, admin API denied`);
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  await app.close(); fs.rmSync(root, { recursive: true, force: true });
}
