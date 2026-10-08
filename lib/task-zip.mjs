import fs from 'node:fs';
import zlib from 'node:zlib';

// Minimal ZIP reader/writer for Office Open XML files (docx/pptx/xlsx). No dependencies.
// The reader refuses ZIP64, encrypted entries, path tricks and decompression bombs; the writer produces plain
// stored/deflated entries that Word, PowerPoint and Excel open.
export const ZIP_LIMITS = { entries: 10000, entryBytes: 128 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, ratio: 1000, minRatioCheckBytes: 1024 * 1024 };
const fail = (message, code = 'ZIP_INVALID') => { throw Object.assign(new Error(message), { code, status: 400 }); };

let CRC_TABLE = null;
export function crc32(buffer, seed = 0) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const safeName = (name) => !(!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || /(^|\/)\.\.(\/|$)/.test(name) || /^[a-zA-Z]:/.test(name));

// source: a file path or a Buffer. Only the central directory is read up front; entries are read on demand.
export class ZipReader {
  constructor(source, limits = {}) {
    this.limits = { ...ZIP_LIMITS, ...limits };
    this.fd = null; this.buffer = null;
    if (Buffer.isBuffer(source)) { this.buffer = source; this.size = source.length; }
    else { this.fd = fs.openSync(source, 'r'); this.size = fs.fstatSync(this.fd).size; }
    try { this.entries = this.#directory(); } catch (error) { this.close(); throw error; }
    this.byName = new Map(this.entries.map((e) => [e.name, e]));
  }
  close() { if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* closed */ } this.fd = null; } }
  #read(position, length) {
    if (position < 0 || length < 0 || position + length > this.size) fail('ZIP 구조가 손상되었습니다.');
    if (this.buffer) return this.buffer.subarray(position, position + length);
    const out = Buffer.alloc(length);
    let done = 0;
    while (done < length) { const n = fs.readSync(this.fd, out, done, length - done, position + done); if (!n) fail('ZIP 파일이 중간에 끝났습니다.'); done += n; }
    return out;
  }
  #directory() {
    if (this.size < 22) fail('ZIP 파일이 아닙니다.');
    const tailLength = Math.min(this.size, 22 + 65535);
    const tail = this.#read(this.size - tailLength, tailLength);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break; }
    if (at < 0) fail('ZIP 파일이 아니거나 손상되었습니다.');
    const total = tail.readUInt16LE(at + 10), size = tail.readUInt32LE(at + 12), offset = tail.readUInt32LE(at + 16);
    if (total === 0xffff || size === 0xffffffff || offset === 0xffffffff) fail('ZIP64 형식은 지원하지 않습니다.', 'ZIP_UNSUPPORTED');
    if (total > this.limits.entries) fail(`ZIP 항목이 너무 많습니다(${total}개).`, 'ZIP_BOMB');
    const dir = this.#read(offset, size);
    const entries = [];
    let p = 0, declared = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) fail('ZIP 목록이 손상되었습니다.');
      const flags = dir.readUInt16LE(p + 8), method = dir.readUInt16LE(p + 10), crc = dir.readUInt32LE(p + 16), csize = dir.readUInt32LE(p + 20), usize = dir.readUInt32LE(p + 24);
      const n = dir.readUInt16LE(p + 28), m = dir.readUInt16LE(p + 30), k = dir.readUInt16LE(p + 32), local = dir.readUInt32LE(p + 42);
      const name = dir.toString(flags & 0x800 ? 'utf8' : 'utf8', p + 46, p + 46 + n);
      p += 46 + n + m + k;
      if (flags & 1) fail('암호화된 ZIP 항목은 지원하지 않습니다.', 'ZIP_ENCRYPTED');
      if (csize === 0xffffffff || usize === 0xffffffff) fail('ZIP64 형식은 지원하지 않습니다.', 'ZIP_UNSUPPORTED');
      if (!safeName(name)) fail(`안전하지 않은 ZIP 항목 이름입니다: ${name}`, 'ZIP_UNSAFE');
      const dirEntry = name.endsWith('/');
      if (!dirEntry && ![0, 8].includes(method)) fail(`지원하지 않는 압축 방식입니다(${method}).`, 'ZIP_UNSUPPORTED');
      if (usize > this.limits.entryBytes) fail(`ZIP 항목이 너무 큽니다(${name}).`, 'ZIP_BOMB');
      if (usize >= this.limits.minRatioCheckBytes && csize > 0 && usize / csize > this.limits.ratio) fail(`비정상적인 압축률의 ZIP 항목입니다(${name}).`, 'ZIP_BOMB');
      declared += usize;
      if (declared > this.limits.totalBytes) fail('압축을 풀면 허용 용량(512MB)을 넘는 ZIP입니다.', 'ZIP_BOMB');
      entries.push({ name, method, crc, csize, usize, local, dir: dirEntry });
    }
    return entries;
  }
  names() { return this.entries.filter((e) => !e.dir).map((e) => e.name); }
  has(name) { return this.byName.has(name); }
  // Returns the verified uncompressed bytes of one entry; never more than the declared size.
  read(name, { maxBytes = this.limits.entryBytes } = {}) {
    const entry = this.byName.get(name);
    if (!entry || entry.dir) fail(`ZIP 안에 ${name} 항목이 없습니다.`, 'ZIP_MISSING');
    if (entry.usize > maxBytes) fail(`${name} 항목이 처리 한도보다 큽니다.`, 'ZIP_BOMB');
    const header = this.#read(entry.local, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) fail('ZIP 항목 헤더가 손상되었습니다.');
    const start = entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = this.#read(start, entry.csize);
    let data;
    if (entry.method === 0) data = Buffer.from(raw);
    else {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: entry.usize + 1 }); }
      catch (error) { fail(error.code === 'ERR_BUFFER_TOO_LARGE' ? `${name} 항목이 선언된 크기보다 큽니다.` : `${name} 압축 해제에 실패했습니다.`, 'ZIP_BOMB'); }
    }
    if (data.length !== entry.usize) fail(`${name} 항목 크기가 선언과 다릅니다.`, 'ZIP_BOMB');
    if (crc32(data) !== entry.crc) fail(`${name} 항목의 CRC가 일치하지 않습니다.`);
    return data;
  }
  text(name, options) { return this.read(name, options).toString('utf8'); }
}

// files: [{name, data: Buffer|string, store?: boolean}] in the given order ([Content_Types].xml first for OOXML).
export function writeZip(files, { date = new Date() } = {}) {
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const dosDate = ((Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const parts = [], central = [];
  let offset = 0;
  const seen = new Set();
  for (const file of files) {
    if (!safeName(file.name) || seen.has(file.name)) fail(`ZIP에 쓸 수 없는 항목 이름입니다: ${file.name}`);
    seen.add(file.name);
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const deflated = file.store ? null : zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    if (data.length > 0xfffffff0 || offset > 0xfffffff0) fail('ZIP 용량 한도를 넘었습니다.');
    const crc = crc32(data), method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(dosTime, 12); entry.writeUInt16LE(dosDate, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
