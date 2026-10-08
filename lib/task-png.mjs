import zlib from 'node:zlib';
import { crc32 } from './task-zip.mjs';

// PNG decode/encode and a few pixel operations, so basic image editing works without any extra dependency.
// Only non-interlaced PNGs up to a pixel budget are decoded; everything else is refused with a clear message.
export const PNG_LIMITS = { pixels: 40_000_000, outputPixels: 40_000_000 };
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fail = (message) => { throw Object.assign(new Error(message), { status: 400, code: 'PNG' }); };
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function readPngHeader(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') fail('PNG 파일이 아닙니다.');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), depth: buf[24], colorType: buf[25], interlace: buf[28] };
}

export function decodePng(buf, { maxPixels = PNG_LIMITS.pixels } = {}) {
  const head = readPngHeader(buf);
  if (head.interlace) fail('인터레이스 PNG는 편집하지 않습니다. 일반 PNG로 저장한 파일을 사용하세요.');
  if (!(head.colorType in CHANNELS) || ![1, 2, 4, 8, 16].includes(head.depth)) fail('지원하지 않는 PNG 색상 형식입니다.');
  if (!head.width || !head.height || head.width * head.height > maxPixels) fail(`이미지가 너무 큽니다(최대 ${Math.round(maxPixels / 1e6)}메가픽셀).`);
  const channels = CHANNELS[head.colorType], bitsPerPixel = channels * head.depth, rowBytes = Math.ceil(head.width * bitsPerPixel / 8), bpp = Math.max(1, bitsPerPixel >> 3);
  const idat = [], palette = []; let transparency = null, p = 8;
  while (p + 12 <= buf.length) {
    const length = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (p + 12 + length > buf.length) fail('PNG 파일이 손상되었습니다.');
    const data = buf.subarray(p + 8, p + 8 + length);
    if (crc32(buf.subarray(p + 4, p + 8 + length)) !== buf.readUInt32BE(p + 8 + length)) fail('PNG 파일의 CRC가 올바르지 않습니다.');
    if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') for (let i = 0; i + 2 < data.length; i += 3) palette.push([data[i], data[i + 1], data[i + 2]]);
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IEND') break;
    p += 12 + length;
  }
  const expected = (rowBytes + 1) * head.height;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 16 }); } catch { fail('PNG 데이터를 풀지 못했습니다.'); }
  if (raw.length < expected) fail('PNG 데이터가 부족합니다.');
  const image = Buffer.alloc(rowBytes * head.height);
  for (let y = 0; y < head.height; y++) {
    const filter = raw[y * (rowBytes + 1)], src = y * (rowBytes + 1) + 1, dst = y * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[src + i], a = i >= bpp ? image[dst + i - bpp] : 0, b = y ? image[dst - rowBytes + i] : 0, c = y && i >= bpp ? image[dst - rowBytes + i - bpp] : 0;
      let v;
      if (filter === 0) v = x; else if (filter === 1) v = x + a; else if (filter === 2) v = x + b; else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else fail('PNG 필터 형식이 올바르지 않습니다.');
      image[dst + i] = v & 255;
    }
  }
  const out = new Uint8Array(head.width * head.height * 4);
  const sample = (row, index) => { // sample #index of a row at the file's bit depth, scaled to 8 bit (palette keeps raw index)
    if (head.depth === 8) return image[row + index];
    if (head.depth === 16) return image[row + index * 2];
    const perByte = 8 / head.depth, byte = image[row + Math.floor(index / perByte)], shift = 8 - head.depth * (index % perByte + 1);
    const value = (byte >> shift) & ((1 << head.depth) - 1);
    return head.colorType === 3 ? value : Math.round(value * 255 / ((1 << head.depth) - 1));
  };
  for (let y = 0; y < head.height; y++) for (let x = 0; x < head.width; x++) {
    const row = y * rowBytes, o = (y * head.width + x) * 4;
    if (head.colorType === 0) { const g = sample(row, x); out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255; }
    else if (head.colorType === 2) { out[o] = sample(row, x * 3); out[o + 1] = sample(row, x * 3 + 1); out[o + 2] = sample(row, x * 3 + 2); out[o + 3] = 255; }
    else if (head.colorType === 3) { const c = palette[sample(row, x)] || [0, 0, 0]; out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = transparency?.[sample(row, x)] ?? 255; }
    else if (head.colorType === 4) { const g = sample(row, x * 2); out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = sample(row, x * 2 + 1); }
    else { out[o] = sample(row, x * 4); out[o + 1] = sample(row, x * 4 + 1); out[o + 2] = sample(row, x * 4 + 2); out[o + 3] = sample(row, x * 4 + 3); }
  }
  return { width: head.width, height: head.height, data: out };
}

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};
export function encodePng({ width, height, data }) {
  if (!(width > 0 && height > 0) || width * height > PNG_LIMITS.outputPixels || data.length !== width * height * 4) fail('PNG로 저장할 수 없는 이미지 크기입니다.');
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (width * 4 + 1);
    rows[dst] = 1; // Sub filter keeps flat areas compressible
    for (let i = 0; i < width * 4; i++) rows[dst + 1 + i] = (data[y * width * 4 + i] - (i >= 4 ? data[y * width * 4 + i - 4] : 0)) & 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- pixel operations: each returns a new image ----
const make = (width, height) => ({ width, height, data: new Uint8Array(width * height * 4) });
export function crop(img, x, y, w, h) {
  if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > img.width || y + h > img.height) fail('자르기 영역이 이미지 밖에 있습니다.');
  const out = make(w, h);
  for (let row = 0; row < h; row++) out.data.set(img.data.subarray(((y + row) * img.width + x) * 4, ((y + row) * img.width + x + w) * 4), row * w * 4);
  return out;
}
export function resize(img, w, h) {
  if (![w, h].every(Number.isInteger) || w < 1 || h < 1 || w * h > PNG_LIMITS.outputPixels) fail('크기가 올바르지 않습니다.');
  const out = make(w, h);
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(img.height - 1, (y + 0.5) * img.height / h - 0.5)), y0 = Math.floor(fy), y1 = Math.min(img.height - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(img.width - 1, (x + 0.5) * img.width / w - 0.5)), x0 = Math.floor(fx), x1 = Math.min(img.width - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c], b = img.data[(y0 * img.width + x1) * 4 + c], d = img.data[(y1 * img.width + x0) * 4 + c], e = img.data[(y1 * img.width + x1) * 4 + c];
        out.data[(y * w + x) * 4 + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
      }
    }
  }
  return out;
}
export function rotate(img, degrees) {
  const turns = ((degrees / 90) % 4 + 4) % 4;
  if (!Number.isInteger(turns)) fail('회전은 90도 단위만 지원합니다.');
  let cur = img;
  for (let t = 0; t < turns; t++) {
    const out = make(cur.height, cur.width);
    for (let y = 0; y < cur.height; y++) for (let x = 0; x < cur.width; x++) out.data.set(cur.data.subarray((y * cur.width + x) * 4, (y * cur.width + x) * 4 + 4), (x * cur.height + (cur.height - 1 - y)) * 4);
    cur = out;
  }
  return cur;
}
export function flip(img, axis) {
  const out = make(img.width, img.height);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const sx = axis === 'horizontal' ? img.width - 1 - x : x, sy = axis === 'vertical' ? img.height - 1 - y : y;
    out.data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * img.width + x) * 4);
  }
  return out;
}
export function adjust(img, { grayscale = false, brightness = 0, contrast = 0, invert = false } = {}) {
  const out = make(img.width, img.height), k = (259 * (contrast + 255)) / (255 * (259 - contrast));
  for (let i = 0; i < img.data.length; i += 4) {
    let r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    if (grayscale) r = g = b = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    for (const [index, v] of [[0, r], [1, g], [2, b]]) {
      let n = v + brightness; n = contrast ? k * (n - 128) + 128 : n; if (invert) n = 255 - n;
      out.data[i + index] = Math.max(0, Math.min(255, Math.round(n)));
    }
    out.data[i + 3] = img.data[i + 3];
  }
  return out;
}
