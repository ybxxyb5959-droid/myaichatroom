import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { House } from '../lib/house.mjs';
import { lifeBeat } from '../lib/life.mjs';
import { playerView, playerAction } from '../lib/house-player.mjs';
import { furniturePose } from '../public/house-pose.mjs';
import { movementFor, bindHouseControls, stickKey } from '../public/house-controls.mjs';
import { createAssistantServer, loadConfig } from '../server.mjs';

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-player-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const house = new House(path.join(root, 'house.json'), { ids: ['gpt'], names: { gpt: 'GPT' } });
  Object.assign(house.s, {
    phase: 'life', floors: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`${i % 5},${Math.floor(i / 5)}`, 'wood'])),
    defs: { sofa: { use: 'sit', parts: [{ s: 'box', x: 0, y: 0, z: 0, w: 2, h: .6, d: 1, c: 'wood' }] },
      bed: { use: 'rest', parts: [{ s: 'box', x: 0, y: 0, z: 0, w: 1, h: .5, d: 2, c: 'wood' }] } },
    items: [{ id: 1, def: 'sofa', x: 1, z: 1, rot: 0 }, { id: 2, def: 'bed', x: 3, z: 2, rot: 1 }],
    agents: { gpt: { x: 2, z: 4 } },
  });
  return { root, house };
}

test('player can walk in during construction too, uses furniture, respects walls/doors and survives reload', (t) => {
  const { house } = home(t);
  house.s.phase = 'build';
  assert.deepEqual([playerView(house).x, playerView(house).z], [0, 0], 'construction is no reason to keep people out');
  house.s.phase = 'life';
  assert.deepEqual([playerView(house).x, playerView(house).z], [0, 0]);
  const act = (body) => playerAction(house, body, { gpt: 'GPT' }, 100);
  assert.throws(() => act({ action: 'move', dx: 2, dz: 0 }), /한 칸/);
  act({ action: 'move', dx: -1, dz: 0 });
  assert.equal(house.s.player.x, 0);
  house.s.walls['1,0'] = { c: 'wood', door: false };
  act({ action: 'move', dx: 1, dz: 0 }); assert.equal(house.s.player.x, 0);
  house.s.walls['1,0'].door = true;
  act({ action: 'move', dx: 1, dz: 0 }); assert.equal(house.s.player.x, 1);
  act({ action: 'interact' }); assert.equal(house.s.player.pose, 'sit');
  assert.deepEqual(furniturePose(house.view(), house.s.player), { x: 2, y: .6, z: 1.5, angle: -0, pose: 'sit' });
  act({ action: 'move', dx: 0, dz: 1 });
  assert.equal(house.s.player.z, 0); assert.equal(house.s.player.pose, undefined);
  house.s.player = { x: 4, z: 1 };
  act({ action: 'interact' }); assert.equal(house.s.player.pose, 'lie');
  const pose = furniturePose(house.view(), house.s.player);
  assert.equal(pose.angle, -Math.PI / 2); assert.equal(pose.y, .5);
  const again = new House(house.file, { ids: ['gpt'], names: { gpt: 'GPT' } });
  assert.deepEqual(again.s.player, house.s.player);
  house.s.player = { x: 2, z: 3 };
  act({ action: 'interact' });
  assert.equal(house.s.player.pose, 'wave'); assert.equal(house.s.agents.gpt.waveUntil, 2100);
  house.s.player = { x: 4, z: 4 };
  assert.throws(() => act({ action: 'interact' }), /옆에서/);
});

test('AI furniture actions carry real poses and clear them on other actions', (t) => {
  const { house } = home(t);
  lifeBeat(house, 'gpt', { mode: 'after-work', rand: () => 0 });
  assert.equal(house.s.agents.gpt.pose, 'sit');
  house.s.player = { x: 1, z: 0 };
  assert.throws(() => playerAction(house, { action: 'interact' }, {}), /사용 중/);
  house.s.player = { x: 1, z: 0, pose: 'sit', furnitureId: 1 };
  lifeBeat(house, 'gpt', { mode: 'after-work', rand: () => 0 });
  assert.equal(house.s.agents.gpt.pose, undefined, 'an AI never sits through the player');
  house.s.items = house.s.items.filter((it) => it.def === 'bed');
  lifeBeat(house, 'gpt', { mode: 'sleep', rand: () => 0 });
  assert.equal(house.s.agents.gpt.pose, 'lie');
  assert.equal(house.s.agents.gpt.furnitureId, 2);
  lifeBeat(house, 'gpt', { mode: 'work', rand: () => 0 });
  assert.equal(house.s.agents.gpt.pose, undefined);
});

test('arrow directions follow camera orientation without diagonal steps', () => {
  assert.deepEqual(movementFor('ArrowUp', 0), { dx: 0, dz: -1 });
  assert.deepEqual(movementFor('ArrowRight', Math.PI / 2), { dx: 0, dz: -1 });
  assert.equal(movementFor('e', 0), null);
});

test('keyboard controls ignore typing, serialize requests and stop on close, blur and key release', async (t) => {
  const target = () => {
    const handlers = {};
    return { handlers, addEventListener: (name, fn) => { handlers[name] = fn; } };
  };
  const win = target(), doc = { ...target(), hidden: false, activeElement: null }, panel = target();
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = win; globalThis.document = doc;
  t.after(() => {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  });
  let tick, ready = true, release, clock = 0;
  t.mock.method(globalThis, 'setInterval', (fn) => { tick = fn; return 1; });
  const calls = [];
  const { clear, hold } = bindHouseControls(panel, { ready: () => ready, angle: () => 0, now: () => (clock += 1000),
    send: (body) => { calls.push(body); return new Promise((resolve) => { release = resolve; }); },
    error: (message) => assert.fail(message) });
  const press = (key, edit = false) => panel.handlers.keydown({
    key, code: key === 'e' ? 'KeyE' : key, repeat: false, target: { closest: () => edit },
    preventDefault() {},
  });
  press('ArrowUp', true); press('e', true); assert.equal(calls.length, 0);
  press('ArrowUp'); tick(); assert.equal(calls.length, 1);
  release(); await Promise.resolve();
  win.handlers.keyup({ key: 'ArrowUp' }); tick(); assert.equal(calls.length, 1);
  press('ArrowDown'); release(); await Promise.resolve(); win.handlers.blur(); tick();
  assert.equal(calls.length, 2);
  press('ArrowRight'); release(); await Promise.resolve(); clear(); tick();
  assert.equal(calls.length, 3);
  ready = false; press('e'); assert.equal(calls.length, 3);
  // The on-screen joystick holds a direction like an arrow key and stops when let go.
  ready = true; release(); await Promise.resolve();
  hold(stickKey(0, -40)); assert.deepEqual(calls.at(-1), { action: 'move', dx: 0, dz: -1 });
  release(); await Promise.resolve(); tick(); assert.equal(calls.length, 5);
  release(); await Promise.resolve(); hold(null); tick(); assert.equal(calls.length, 5);
  // Steps never come faster than the character walks, so nothing is left to play out after letting go.
  let paced = 0; const sent = [];
  const pacedControls = bindHouseControls(target(), { ready: () => true, angle: () => 0, now: () => paced, send: async (body) => { sent.push(body); }, error: assert.fail });
  pacedControls.hold('ArrowUp'); await Promise.resolve();
  paced = 100; tick(); await Promise.resolve();
  pacedControls.hold('ArrowLeft'); await Promise.resolve();
  assert.equal(sent.length, 1, 'a second step within 260 ms waits');
  paced = 270; tick(); await Promise.resolve();
  assert.deepEqual(sent.at(-1), { action: 'move', dx: -1, dz: 0 });
  assert.equal(stickKey(3, 4), null); assert.equal(stickKey(30, 5), 'ArrowRight'); assert.equal(stickKey(-2, 30), 'ArrowDown');
});

test('restored house player and its UI work without calling AI', async (t) => {
  const { root, house } = home(t);
  house.file = path.join(root, 'data', 'house.json'); house.save();
  let calls = 0;
  const app = createAssistantServer({ root, cfg: loadConfig(path.join(root, 'no-user-config.json')), greetings: false,
    adapter: { available: () => ({ gpt: true }), chat: async () => { calls++; return { ok: true, text: 'hi' }; } } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = (body) => fetch(url + '/api/house/player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'interact' })).status, 400);
  const response = await post({ action: 'move', dx: 1, dz: 0 });
  assert.equal(response.status, 200);
  assert.equal((await post({ action: 'move', dx: 1, dz: 1 })).status, 400);
  assert.equal(calls, 0);
  for (const asset of ['house.js', 'house-pose.mjs', 'house-controls.mjs', 'house-avatar.mjs']) assert.equal((await fetch(`${url}/${asset}`)).status, 200);
});

test('the interact button names what it would do: sit, lie down, wave, stand up, or nothing', async (t) => {
  const { house } = home(t);
  const { nearbyAction } = await import('../lib/house-player.mjs');
  const at = (x, z) => { house.s.player = { x, z }; return nearbyAction(house, 'user', ['gpt'])?.kind ?? null; };
  assert.equal(at(0, 1), 'sit');
  assert.equal(at(4, 1), 'lie');
  assert.equal(at(2, 3), 'wave');
  assert.equal(at(4, 4), null);
  house.s.player = { x: 0, z: 1 };
  playerAction(house, { action: 'interact' }, { gpt: 'GPT' }, 1);
  assert.equal(house.s.player.pose, 'sit');
  assert.deepEqual(nearbyAction(house, 'user', ['gpt']), { kind: 'up', label: '일어나기' });
  playerAction(house, { action: 'interact' }, { gpt: 'GPT' }, 2);
  assert.equal(house.s.player.pose, undefined, 'pressing it again stands up in place');
  assert.deepEqual([house.s.player.x, house.s.player.z], [0, 1]);
});
