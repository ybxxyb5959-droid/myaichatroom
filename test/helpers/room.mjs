import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../../lib/store.mjs';
import { createAssistantServer, loadConfig } from '../../server.mjs';

export const IDS = ['claude', 'gpt', 'gemini'];
export async function roomFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'original-room-test-'));
  const store = new Store(root);
  if (options.seed) { options.seed(store); store.saveState(); }
  const clock = { now: new Date(2026, 9, 7, 10).getTime() };
  const calls = [], images = [];
  let reply = options.reply || (() => ({ action: 'pass' }));
  const ids = options.ids || IDS;
  const adapter = {
    available: () => Object.fromEntries(IDS.map((id) => [id, ids.includes(id)])),
    loginStatus: async () => ({ status: 'ok' }),
    listModels: async () => [{ id: 'gpt-6-luna', description: 'Fast and affordable model', efforts: ['low', 'medium'] }],
    maxPromptChars: () => 120000,
    canSee: (id) => options.canSee ? options.canSee(id) : true,
    describeImage: options.describeImage || (async () => ({ ok: true, text: '첨부 사진 설명' })),
    chat: async (id, brief, prompt, opts) => {
      const call = { id, brief, prompt, options: opts };
      calls.push(call);
      if (opts.independent) return options.discussionReply ? options.discussionReply(call) : { ok: true, text: '토론 의견과 근거' };
      const value = await reply(call, calls.length);
      return value?.ok !== undefined ? value : { ok: true, text: JSON.stringify(value), ms: 1 };
    },
    image: async (id, prompt, opts) => {
      images.push({ id, prompt, options: opts });
      const file = path.join(root, 'generated.png');
      fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
      return { ok: true, file };
    },
  };
  const cfg = { ...loadConfig(path.join(root, 'config.json')), autoSleepMinutes: 0, ...options.cfg };
  let app, base;
  const launch = async () => {
    app = createAssistantServer({ root, cfg, adapter, clock: () => clock.now, random: () => .5, autoTickMs: 3600000,
      wait: options.wait || (async () => {}), usage: options.usage, ...(options.shot ? { worldShooter: options.shot } : {}) });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  await launch();
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const post = async (url, body) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const advance = async (ms = 0) => { clock.now += ms; return app.tick(); };
  return {
    root, cfg, adapter, calls, images, clock, get app() { return app; }, get base() { return base; }, post, advance,
    reply: (value) => { reply = value; },
    start: async () => { const r = await post('/api/room', { auto: { on: true, sleepMinutes: 0 } }); assert.equal(r.status, 200); },
    send: async (text, extra = {}) => { const r = await post('/api/send', { text, ...extra }); assert.equal(r.status, 200); return r.value.msg; },
    turn: async (text = '안녕') => {
      const r = await post('/api/send', { text }); assert.equal(r.status, 200);
      await advance(0); await advance(12000);
      return r.value.msg;
    },
    reopen: async () => { await app.close(); await launch(); },
  };
}
