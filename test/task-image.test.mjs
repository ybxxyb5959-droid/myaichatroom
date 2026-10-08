import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { roomFixture } from './helpers/room.mjs';
import { encodePng, decodePng, crop, resize, rotate, flip } from '../lib/task-png.mjs';
import { describeImage, applyImageEdit, validateImageEdit, siblingName } from '../lib/task-image.mjs';

const json = JSON.stringify;
function gradient(w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; data[o] = x * 255 / (w - 1 || 1); data[o + 1] = y * 255 / (h - 1 || 1); data[o + 2] = 40; data[o + 3] = 255; }
  return { width: w, height: h, data };
}
const png = (w = 40, h = 20) => encodePng(gradient(w, h));
// A minimal JPEG: SOI, APP1/Exif (Make, Model, GPS pointer), SOF0 with the size, EOI.
function jpeg(width, height, { gps = true } = {}) {
  const ascii = (text) => Buffer.from(`${text}\0`, 'latin1');
  const make = ascii('TestCam'), model = ascii('Model X');
  const entries = 3, ifd0 = 8, dataStart = ifd0 + 2 + entries * 12 + 4;
  const tiff = Buffer.alloc(dataStart + make.length + model.length);
  tiff.write('MM', 0); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(ifd0, 4); tiff.writeUInt16BE(entries, ifd0);
  const put = (i, tag, type, count, value) => { const e = ifd0 + 2 + i * 12; tiff.writeUInt16BE(tag, e); tiff.writeUInt16BE(type, e + 2); tiff.writeUInt32BE(count, e + 4); tiff.writeUInt32BE(value, e + 8); };
  put(0, 0x010f, 2, make.length, dataStart); put(1, 0x0110, 2, model.length, dataStart + make.length);
  if (gps) put(2, 0x8825, 4, 1, 0); else put(2, 0x0112, 3, 1, 1 << 16);
  make.copy(tiff, dataStart); model.copy(tiff, dataStart + make.length);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255]), exif]);
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}

test('png codec round-trips and the pixel operations are exact', () => {
  const img = gradient(6, 4);
  const back = decodePng(encodePng(img));
  assert.deepEqual([back.width, back.height], [6, 4]);
  assert.ok(Buffer.from(back.data).equals(Buffer.from(img.data)));
  const c = crop(img, 1, 1, 3, 2);
  assert.deepEqual([c.width, c.height], [3, 2]);
  assert.deepEqual([...c.data.subarray(0, 4)], [...img.data.subarray((1 * 6 + 1) * 4, (1 * 6 + 1) * 4 + 4)]);
  const r = rotate(img, 90);
  assert.deepEqual([r.width, r.height], [4, 6]);
  assert.deepEqual([...r.data.subarray(0, 4)], [...img.data.subarray(((4 - 1) * 6) * 4, ((4 - 1) * 6) * 4 + 4)], 'the bottom-left pixel moves to the top-left');
  assert.ok(Buffer.from(rotate(rotate(img, 90), -90).data).equals(Buffer.from(img.data)));
  assert.ok(Buffer.from(flip(flip(img, 'horizontal'), 'horizontal').data).equals(Buffer.from(img.data)));
  const small = resize(img, 3, 2);
  assert.deepEqual([small.width, small.height], [3, 2]);
  assert.throws(() => crop(img, 5, 0, 3, 3), /밖/);
  assert.throws(() => decodePng(Buffer.from('not a png')), /PNG/);
  const bad = Buffer.from(encodePng(img)); bad[bad.length - 20] ^= 0xff;
  assert.throws(() => decodePng(bad), /CRC|데이터/);
  // interlaced files are refused instead of mis-decoded
  const interlaced = Buffer.from(encodePng(img)); interlaced[28] = 1;
  assert.throws(() => decodePng(interlaced), /CRC|인터레이스/);
  assert.throws(() => decodePng(encodePng(gradient(10, 10)), { maxPixels: 50 }), /너무 큽니다/);
});

test('image metadata: format, size, PNG facts, EXIF camera facts, GPS is reported as present only', () => {
  const info = describeImage(png(40, 20));
  assert.deepEqual([info.format, info.width, info.height, info.hasAlpha, info.editable], ['PNG', 40, 20, true, true]);
  assert.equal(info.aspect, '2:1');
  const j = describeImage(jpeg(300, 200));
  assert.deepEqual([j.format, j.width, j.height, j.exif.make, j.exif.model, j.exif.gps, j.editable], ['JPEG', 300, 200, 'TestCam', 'Model X', true, false]);
  assert.match(j.privacyNote, /GPS/);
  assert.ok(!JSON.stringify(j).match(/\d+\.\d{4,}/), 'no coordinates are exposed');
  assert.equal(describeImage(jpeg(10, 10, { gps: false })).exif.gps, false);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([5, 0, 7, 0]), Buffer.alloc(10)]);
  assert.deepEqual([describeImage(gif).format, describeImage(gif).width, describeImage(gif).height], ['GIF', 5, 7]);
  const webp = Buffer.alloc(40); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12); webp.writeUIntLE(99, 24, 3); webp.writeUIntLE(49, 27, 3);
  assert.deepEqual([describeImage(webp).format, describeImage(webp).width, describeImage(webp).height], ['WEBP', 100, 50]);
  assert.throws(() => describeImage(Buffer.from('plain text')), /이미지가 아닙니다/);
});

test('edit operations are validated strictly and produce a new PNG without touching the source', () => {
  const source = png(40, 20);
  const copy = Buffer.from(source);
  const out = applyImageEdit(source, [{ op: 'resize', width: 20 }, { op: 'rotate', degrees: 90 }, { op: 'grayscale' }]);
  const result = decodePng(out);
  assert.deepEqual([result.width, result.height], [10, 20]);
  assert.ok(source.equals(copy), 'the source bytes are unchanged');
  assert.equal(result.data[0], result.data[1]);
  for (const bad of [{ op: 'sharpen' }, { op: 'resize' }, { op: 'resize', width: 0 }, { op: 'rotate', degrees: 45 }, { op: 'flip', axis: 'diagonal' }, { op: 'brightness', amount: 500 }, { op: 'crop', x: 1.5, y: 0, width: 1, height: 1 }, { op: 'crop', x: 0, y: 0, width: 1, height: 1, evil: 1 }]) {
    assert.throws(() => validateImageEdit({ source: 'a.png', ops: [bad] }), /ops\[0\]/, json(bad));
  }
  assert.throws(() => validateImageEdit({ source: 'a.png', ops: Array.from({ length: 11 }, () => ({ op: 'invert' })) }), /1~10/);
  assert.throws(() => validateImageEdit({ source: 'a.png', ops: [{ op: 'invert' }], extra: 1 }), /알 수 없는/);
  assert.throws(() => applyImageEdit(source, [{ op: 'resize', width: 12000, height: 12000 }]), /크기가 올바르지/);
  assert.equal(siblingName('images/a.png', (p) => p === 'images/a-edited.png'), 'images/a-edited-2.png');
});

async function fixture(t, options = {}) {
  let dir;
  const seen = [];
  const provider = { available: () => true, prepare: async () => 'ok', imageCapable: true, shortName: 'Claude', modes: new Set(['analysis']), analyze: async (input, o) => { seen.push({ input: JSON.parse(input), options: o }); return '이미지 설명 답변'; } };
  const room = await roomFixture(t, { taskProvider: provider, folderPicker: async () => dir, ...options });
  dir = path.join(room.root, 'proj'); fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images', 'logo.png'), png(40, 20));
  fs.writeFileSync(path.join(dir, 'images', 'photo.jpg'), jpeg(300, 200));
  const post = async (url, body, status = 200) => {
    const response = await fetch(room.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: room.base }, body: json(body) });
    const value = await response.json(); assert.equal(response.status, status, json(value)); return value;
  };
  const state = await post('/api/tasks', { action: 'project.createLinked', name: '이미지' });
  const ids = { projectId: state.selectedProjectId, sessionId: state.selectedSessionId };
  const get = async () => (await fetch(room.base + '/api/tasks/ai')).json();
  const wait = async () => { const end = Date.now() + 8000; while (Date.now() < end) { const v = await get(); if (!v.running) return v; await delay(10); } assert.fail('timeout'); };
  const draft = async (text) => { const s = (await get()).state.projects[0].sessions[0]; return post('/api/tasks', { action: 'draft.save', ...ids, revision: s.revision, text }); };
  const changes = (setId, body, status = 200) => post('/api/tasks/changes', { ...ids, setId, ...body }, status);
  const upload = async (name, bytes) => {
    const r = await fetch(`${room.base}/api/tasks/attachments?projectId=${ids.projectId}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), Origin: room.base }, body: bytes });
    return (await r.json()).item;
  };
  return { room, dir, ids, seen, post, get, wait, draft, changes, upload };
}

test('local edits become pending change sets with a new file; the original stays; apply and restore work; names never collide', async (t) => {
  const f = await fixture(t);
  const info = await f.post('/api/tasks/ai', { action: 'image.describe', ...f.ids, source: { kind: 'file', path: 'images/logo.png' } });
  assert.deepEqual([info.format, info.width, info.height], ['PNG', 40, 20]);
  const original = fs.readFileSync(path.join(f.dir, 'images', 'logo.png'));
  const made = await f.post('/api/tasks/ai', { action: 'image.local', ...f.ids, source: { kind: 'file', path: 'images/logo.png' }, ops: [{ op: 'resize', width: 20 }, { op: 'grayscale' }] });
  assert.equal(made.path, 'images/logo-edited.png');
  assert.ok(!fs.existsSync(path.join(f.dir, 'images', 'logo-edited.png')), 'nothing is written before approval');
  const view = await f.get();
  const set = view.changes.find((c) => c.id === made.setId);
  assert.equal(set.status, 'pending');
  const detail = await f.changes(set.id, { action: 'detail', opId: set.ops[0].id });
  assert.match(detail.afterImage, /^data:image\/png;base64,/);
  await f.changes(set.id, { action: 'decide', decision: 'approved' });
  const prepared = await f.changes(set.id, { action: 'apply.prepare' });
  await f.changes(set.id, { action: 'apply', confirmId: prepared.confirmation.confirmId });
  const edited = decodePng(fs.readFileSync(path.join(f.dir, 'images', 'logo-edited.png')));
  assert.deepEqual([edited.width, edited.height], [20, 10]);
  assert.ok(fs.readFileSync(path.join(f.dir, 'images', 'logo.png')).equals(original), 'the original image is byte-identical');
  const second = await f.post('/api/tasks/ai', { action: 'image.local', ...f.ids, source: { kind: 'file', path: 'images/logo.png' }, ops: [{ op: 'invert' }] });
  assert.equal(second.path, 'images/logo-edited-2.png');
  const restore = await f.changes(set.id, { action: 'restore.prepare' });
  await f.changes(set.id, { action: 'restore', confirmId: restore.confirmation.confirmId });
  assert.ok(!fs.existsSync(path.join(f.dir, 'images', 'logo-edited.png')));
  // not editable / not allowed
  const jpegRefusal = await f.post('/api/tasks/ai', { action: 'image.local', ...f.ids, source: { kind: 'file', path: 'images/photo.jpg' }, ops: [{ op: 'invert' }] }, 400);
  assert.match(jpegRefusal.error, /PNG만 가능/);
  await f.post('/api/tasks/ai', { action: 'image.local', ...f.ids, source: { kind: 'file', path: '../x.png' }, ops: [{ op: 'invert' }] }, 403);
  await f.post('/api/tasks/ai', { action: 'image.local', ...f.ids, source: { kind: 'file', path: 'images/logo.png' }, ops: [{ op: 'nope' }] }, 400);
});

test('attached pictures: thumbnails are served safely, edits can use them, and the AI route sees only chosen images with consent', async (t) => {
  const f = await fixture(t);
  const item = await f.upload('내 사진.png', png(30, 30));
  assert.equal(item.kind, 'image');
  assert.deepEqual([item.image.width, item.image.height], [30, 30]);
  const thumb = await fetch(`${f.room.base}/api/tasks/attachments?projectId=${f.ids.projectId}&file=${item.id}`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/png');
  assert.equal(thumb.headers.get('x-content-type-options'), 'nosniff');
  assert.match(thumb.headers.get('content-security-policy'), /sandbox/);
  const text = await f.upload('메모.txt', Buffer.from('글'));
  assert.equal((await fetch(`${f.room.base}/api/tasks/attachments?projectId=${f.ids.projectId}&file=${text.id}`)).status, 415);
  const made = await f.post('/api/tasks/ai', { action: 'image.local', ...f.ids, source: { kind: 'attachment', id: item.id }, ops: [{ op: 'rotate', degrees: 180 }] });
  assert.equal(made.path, 'images/내 사진-edited.png');

  await f.draft('이 사진에 뭐가 있어?');
  const start = async (extra, status = 202) => post(f, extra, status);
  async function post(fx, extra, status) { return fx.post('/api/tasks/ai', { action: 'start', ...fx.ids, mode: 'image.analyze', provider: 'claude', consent: true, files: [], revision: (await fx.get()).state.projects[0].sessions[0].revision, ...extra }, status); }
  await start({ sources: [{ kind: 'attachment', id: item.id }], consentAttachments: false }, 403);
  await start({ sources: [] }, 400);
  await start({ sources: [{ kind: 'attachment', id: text.id }], consentAttachments: true }, 400);
  await start({ sources: [{ kind: 'file', path: 'images/logo.png' }], consentAttachments: true });
  const view = await f.wait();
  assert.equal(view.state.projects[0].sessions[0].analysis.status, 'completed');
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].options.images.length, 1);
  assert.equal(f.seen[0].options.images[0].mime, 'image/png');
  assert.ok(Buffer.isBuffer(f.seen[0].options.images[0].bytes));
  assert.equal(f.seen[0].input.request, '이 사진에 뭐가 있어?');
  assert.equal(view.state.projects[0].sessions[0].messages.at(-1).text, '이미지 설명 답변');

  // project pictures are previewable through the read-only file API
  const file = await f.post('/api/tasks/files', { ...f.ids, action: 'read', path: 'images/photo.jpg' });
  assert.equal(file.kind, 'image');
  assert.match(file.dataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(file.image.exif.make, 'TestCam');
});

test('AI image generation/editing: consent, real outcomes only, pending change set with preview, reference copies are cleaned up', async (t) => {
  const f = await fixture(t);
  const calls = [];
  let mode = 'ok';
  f.room.adapter.image = async (id, prompt, opts) => {
    calls.push({ id, prompt, opts, refExists: opts.refSheet ? fs.existsSync(opts.refSheet) : null, refBytes: opts.refSheet ? fs.readFileSync(opts.refSheet) : null });
    if (mode === 'hang') await new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    if (mode === 'fail') return { ok: false, detail: 'exit=1 quota exceeded' };
    const file = path.join(f.room.root, `gen-${calls.length}.png`);
    fs.writeFileSync(file, mode === 'junk' ? Buffer.from('this is not an image at all') : png(64, 48));
    return { ok: true, file };
  };
  await f.draft('파란 하늘 아래 작은 집');
  const run = async (extra, status = 202) => f.post('/api/tasks/ai', { action: 'start', ...f.ids, mode: 'image', provider: 'claude', consent: true, files: [], imageProvider: 'gpt', imageAction: 'generate',
    consentImage: true, revision: (await f.get()).state.projects[0].sessions[0].revision, ...extra }, status);
  await run({ consentImage: false }, 403);
  await run({ imageProvider: 'nobody' }, 400);
  await run({ imageProvider: 'grok' }, 400);
  assert.equal(calls.length, 0, 'nothing is requested without consent or with an unavailable tool');

  await run({});
  let view = await f.wait();
  assert.equal(view.state.projects[0].sessions[0].analysis.status, 'completed', view.state.projects[0].sessions[0].analysis.error);
  assert.equal(calls[0].id, 'gpt');
  assert.equal(calls[0].prompt, '파란 하늘 아래 작은 집');
  assert.equal(calls[0].refExists, null);
  const set = view.changes.at(-1);
  assert.equal(set.status, 'pending');
  assert.match(set.ops[0].path, /^images\/.+\.png$/);
  assert.ok(!fs.existsSync(path.join(f.dir, set.ops[0].path)), 'a generated image is not saved before approval');
  assert.equal(view.state.projects[0].sessions[0].messages.at(-1).changeId, set.id);
  const detail = await f.changes(set.id, { action: 'detail', opId: set.ops[0].id });
  assert.match(detail.afterImage, /^data:image\/png/);
  await f.changes(set.id, { action: 'decide', decision: 'approved' });
  const prepared = await f.changes(set.id, { action: 'apply.prepare' });
  await f.changes(set.id, { action: 'apply', confirmId: prepared.confirmation.confirmId });
  assert.deepEqual(decodePng(fs.readFileSync(path.join(f.dir, set.ops[0].path))).width, 64);

  // edit: the original is passed only as a temporary reference copy, which is removed afterwards
  await f.draft('하늘을 노을색으로 바꿔줘');
  await run({ imageAction: 'edit', source: { kind: 'file', path: 'images/logo.png' } });
  view = await f.wait();
  assert.equal(calls[1].opts.refMode, 'edit');
  assert.equal(calls[1].refExists, true);
  assert.ok(calls[1].refBytes.equals(fs.readFileSync(path.join(f.dir, 'images', 'logo.png'))), 'the reference is a copy of the original bytes');
  assert.ok(!fs.existsSync(calls[1].opts.refSheet), 'the temporary reference copy is deleted');
  assert.match(calls[1].prompt, /^Edit the attached image/);

  // failures are reported as failures, never turned into a fake result
  mode = 'fail';
  await f.draft('실패하는 요청');
  const before = (await f.get()).changes.length;
  await run({});
  view = await f.wait();
  assert.equal(view.state.projects[0].sessions[0].analysis.status, 'failed');
  assert.match(view.state.projects[0].sessions[0].analysis.error, /이미지를 만들지 못했습니다.*quota exceeded/);
  assert.equal(view.changes.length, before);
  mode = 'junk';
  await f.draft('쓰레기 파일을 돌려주는 요청');
  await run({});
  view = await f.wait();
  assert.match(view.state.projects[0].sessions[0].analysis.error, /올바른 이미지/);
  assert.equal(view.changes.length, before);

  mode = 'hang';
  await f.draft('멈추는 요청');
  await run({});
  await delay(80);
  await f.post('/api/tasks/ai', { action: 'cancel', ...(await f.get()).running });
  view = await f.wait();
  assert.equal(view.state.projects[0].sessions[0].analysis.status, 'cancelled');
  assert.equal(view.changes.length, before);
  const providers = await f.post('/api/tasks/ai', { action: 'image.providers' });
  assert.deepEqual(providers.providers.map((p) => [p.id, p.installed]), [['gpt', true], ['gemini', true], ['grok', false]]);
  assert.match(providers.costNote, /구독/);
});
