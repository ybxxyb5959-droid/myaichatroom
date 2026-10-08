import { imageInfo } from './task-office-common.mjs';
import { decodePng, encodePng, crop, resize, rotate, flip, adjust, readPngHeader, PNG_LIMITS } from './task-png.mjs';

// Image facts and deterministic edits computed here (no AI, no network). Edits always produce a NEW PNG; the source file
// is never changed. Formats other than PNG can be inspected and shown, but are edited through the AI route instead.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, code: 'IMAGE' }); };
export const IMAGE_LIMITS = { previewBytes: 6 * 1024 * 1024, sourceBytes: 40 * 1024 * 1024, ops: 10 };
export const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

const TAGS = { 0x010f: 'make', 0x0110: 'model', 0x0112: 'orientation', 0x0131: 'software', 0x0132: 'dateTime', 0x829a: 'exposureTime', 0x829d: 'fNumber', 0x8827: 'iso',
  0x9003: 'dateTimeOriginal', 0x920a: 'focalLength', 0xa002: 'pixelWidth', 0xa003: 'pixelHeight', 0x010e: 'description' };
function readExif(bytes) {
  // JPEG APP1 "Exif\0\0" + TIFF structure. Only a small set of harmless camera facts is read; GPS is reported as present/absent.
  let p = 2;
  while (p + 4 < bytes.length && bytes[p] === 0xff) {
    const marker = bytes[p + 1], length = bytes.readUInt16BE(p + 2);
    if (marker === 0xe1 && bytes.toString('latin1', p + 4, p + 10) === 'Exif\0\0') return parseTiff(bytes.subarray(p + 10, p + 2 + length));
    if (marker === 0xda) break;
    p += 2 + length;
  }
  return null;
}
function parseTiff(tiff) {
  if (tiff.length < 8) return null;
  const little = tiff.toString('latin1', 0, 2) === 'II';
  if (!little && tiff.toString('latin1', 0, 2) !== 'MM') return null;
  const u16 = (o) => (o + 2 <= tiff.length ? (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)) : 0);
  const u32 = (o) => (o + 4 <= tiff.length ? (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)) : 0);
  const out = { gps: false };
  const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const walk = (offset, depth) => {
    if (!offset || offset + 2 > tiff.length || depth > 2) return;
    const count = Math.min(u16(offset), 200);
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12;
      if (e + 12 > tiff.length) break;
      const tag = u16(e), type = u16(e + 2), n = u32(e + 4), size = (sizes[type] || 1) * n;
      const at = size > 4 ? u32(e + 8) : e + 8;
      if (tag === 0x8825) { out.gps = true; continue; }
      if (tag === 0x8769) { walk(u32(e + 8), depth + 1); continue; }
      const name = TAGS[tag];
      if (!name || at + size > tiff.length) continue;
      if (type === 2) out[name] = tiff.toString('utf8', at, at + Math.max(0, n - 1)).replace(/\0.*$/, '').slice(0, 120);
      else if (type === 3) out[name] = u16(at);
      else if (type === 4) out[name] = u32(at);
      else if (type === 5 || type === 10) { const d = u32(at + 4); out[name] = d ? Math.round(u32(at) / d * 1000) / 1000 : null; }
    }
  };
  walk(u32(4), 0);
  return out;
}
function pngFacts(bytes) {
  const h = readPngHeader(bytes);
  const colorNames = { 0: '그레이스케일', 2: 'RGB', 3: '팔레트', 4: '그레이+투명도', 6: 'RGBA' };
  const facts = { bitDepth: h.depth, colorType: colorNames[h.colorType] || String(h.colorType), interlaced: !!h.interlace, hasAlpha: h.colorType === 4 || h.colorType === 6, text: {} };
  let p = 8;
  while (p + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(p), type = bytes.toString('latin1', p + 4, p + 8);
    if (type === 'pHYs' && length >= 9) { const x = bytes.readUInt32BE(p + 8); facts.dpi = bytes[p + 16] === 1 ? Math.round(x * 0.0254) : null; }
    if (type === 'tRNS') facts.hasAlpha = true;
    if (type === 'tEXt' && length < 4096 && Object.keys(facts.text).length < 10) { const raw = bytes.subarray(p + 8, p + 8 + length), z = raw.indexOf(0); if (z > 0) facts.text[raw.toString('latin1', 0, z)] = raw.toString('utf8', z + 1).slice(0, 200); }
    if (type === 'IEND' || p + 12 + length > bytes.length) break;
    p += 12 + length;
  }
  return facts;
}

// A readable summary of an image file. Throws for anything that is not a PNG/JPEG/GIF/WebP picture.
export function describeImage(bytes) {
  const info = imageInfo(bytes);
  let format = info?.ext === 'jpeg' ? 'JPEG' : info?.ext?.toUpperCase();
  let width = info?.width, height = info?.height;
  if (!info && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    format = 'WEBP';
    const kind = bytes.toString('latin1', 12, 16);
    if (kind === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === 'VP8 ') { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else if (kind === 'VP8L') { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >> 14) & 0x3fff) + 1; }
  }
  if (!format || !width || !height) fail('PNG·JPEG·GIF·WebP 이미지가 아닙니다.');
  const out = { format, width, height, bytes: bytes.length, megapixels: Math.round(width * height / 1e4) / 100, aspect: `${Math.round(width / height * 100) / 100}:1` };
  try {
    if (format === 'PNG') Object.assign(out, pngFacts(bytes));
    else if (format === 'JPEG') { const exif = readExif(bytes); if (exif) out.exif = exif; if (exif?.gps) out.privacyNote = '위치(GPS) 정보가 들어 있습니다. 공유 전에 확인하세요.'; }
    else if (format === 'GIF') out.animated = bytes.includes(Buffer.from([0x21, 0xf9, 0x04])) && (bytes.toString('latin1').match(/\x00\x2c/g) || []).length > 1;
  } catch { /* the basic facts above still stand */ }
  out.editable = format === 'PNG' && !out.interlaced && width * height <= PNG_LIMITS.pixels;
  return out;
}

const OPS = {
  crop: ['x', 'y', 'width', 'height'], resize: ['width', 'height', 'fit'], rotate: ['degrees'], flip: ['axis'],
  grayscale: [], brightness: ['amount'], contrast: ['amount'], invert: [],
};
export function validateImageEdit(edit) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) fail('image.edit 형식이 올바르지 않습니다.');
  for (const key of Object.keys(edit)) if (!['source', 'ops'].includes(key)) fail(`image.edit: 알 수 없는 항목 "${key}"입니다.`);
  if (typeof edit.source !== 'string') fail('image.edit.source가 필요합니다.');
  if (!Array.isArray(edit.ops) || !edit.ops.length || edit.ops.length > IMAGE_LIMITS.ops) fail(`ops는 1~${IMAGE_LIMITS.ops}개여야 합니다.`);
  for (const [i, op] of edit.ops.entries()) {
    if (!op || typeof op !== 'object' || !OPS[op.op]) fail(`ops[${i}]: 지원하지 않는 작업입니다. 사용 가능: ${Object.keys(OPS).join(', ')}`);
    for (const key of Object.keys(op)) if (key !== 'op' && !OPS[op.op].includes(key)) fail(`ops[${i}]: 알 수 없는 항목 "${key}"입니다.`);
    const ints = { crop: ['x', 'y', 'width', 'height'], resize: [] }[op.op] || [];
    for (const key of ints) if (!Number.isInteger(op[key])) fail(`ops[${i}].${key}는 정수여야 합니다.`);
    if (op.op === 'resize') {
      if (op.width === undefined && op.height === undefined) fail(`ops[${i}]: width 또는 height가 필요합니다.`);
      for (const key of ['width', 'height']) if (op[key] !== undefined && !(Number.isInteger(op[key]) && op[key] >= 1 && op[key] <= 12000)) fail(`ops[${i}].${key}는 1~12000 정수여야 합니다.`);
      if (op.fit !== undefined && !['stretch', 'contain'].includes(op.fit)) fail(`ops[${i}].fit은 stretch 또는 contain이어야 합니다.`);
    }
    if (op.op === 'rotate' && ![90, 180, 270, -90].includes(op.degrees)) fail(`ops[${i}].degrees는 90, 180, 270, -90 중 하나여야 합니다.`);
    if (op.op === 'flip' && !['horizontal', 'vertical'].includes(op.axis)) fail(`ops[${i}].axis는 horizontal 또는 vertical이어야 합니다.`);
    if (['brightness', 'contrast'].includes(op.op) && !(typeof op.amount === 'number' && op.amount >= -100 && op.amount <= 100)) fail(`ops[${i}].amount는 -100~100이어야 합니다.`);
  }
  return edit;
}

// source bytes -> new PNG bytes. Never touches the source.
export function applyImageEdit(bytes, ops) {
  if (bytes.length > IMAGE_LIMITS.sourceBytes) fail('편집할 이미지가 너무 큽니다.');
  let img = decodePng(bytes);
  for (const op of ops) {
    if (op.op === 'crop') img = crop(img, op.x, op.y, op.width, op.height);
    else if (op.op === 'resize') {
      let w = op.width, h = op.height;
      if (w === undefined) w = Math.max(1, Math.round(img.width * h / img.height));
      if (h === undefined) h = Math.max(1, Math.round(img.height * w / img.width));
      if (op.fit === 'contain' && op.width !== undefined && op.height !== undefined) { const s = Math.min(w / img.width, h / img.height); w = Math.max(1, Math.round(img.width * s)); h = Math.max(1, Math.round(img.height * s)); }
      img = resize(img, w, h);
    } else if (op.op === 'rotate') img = rotate(img, op.degrees);
    else if (op.op === 'flip') img = flip(img, op.axis);
    else if (op.op === 'grayscale') img = adjust(img, { grayscale: true });
    else if (op.op === 'brightness') img = adjust(img, { brightness: Math.round(op.amount * 2.55) });
    else if (op.op === 'contrast') img = adjust(img, { contrast: Math.round(op.amount * 2.55) });
    else if (op.op === 'invert') img = adjust(img, { invert: true });
  }
  return encodePng(img);
}

// A new file name next to the source: "photo.png" -> "photo-edited.png", "photo-edited-2.png", ...
export function siblingName(relative, exists, suffix = 'edited', forceExt = '.png') {
  const dot = relative.lastIndexOf('.'), slash = relative.lastIndexOf('/');
  const stem = dot > slash ? relative.slice(0, dot) : relative;
  for (let n = 1; n < 1000; n++) { const candidate = `${stem}-${suffix}${n > 1 ? `-${n}` : ''}${forceExt}`; if (!exists(candidate)) return candidate; }
  return fail('새 파일 이름을 정하지 못했습니다.');
}
