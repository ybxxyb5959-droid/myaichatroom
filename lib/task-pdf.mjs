import zlib from 'node:zlib';

// Text extraction from PDF files that contain a text layer. No dependencies, no execution: the file is parsed as data.
// Scanned/image-only pages are reported separately (they need OCR, which this app does not do).
export const PDF_LIMITS = { fileBytes: 256 * 1024 * 1024, streamBytes: 64 * 1024 * 1024, pages: 20000, objects: 4_000_000, depth: 64, formDepth: 3 };
const fail = (message, code = 'PDF_INVALID') => { throw Object.assign(new Error(message), { code, status: 400 }); };
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isWS = (c) => WS.has(c);
const isReg = (c) => c !== undefined && !WS.has(c) && !DELIM.has(c);
class Name { constructor(name) { this.name = name; } }
class Ref { constructor(num, gen) { this.num = num; this.gen = gen; } }
class Keyword { constructor(word) { this.word = word; } }
class Dict { constructor() { this.map = new Map(); this.streamAt = -1; } get(key) { return this.map.get(key); } }

class Lexer {
  constructor(buf, pos = 0, end = buf.length) { this.buf = buf; this.pos = pos; this.end = end; }
  skip() {
    for (;;) {
      const c = this.buf[this.pos];
      if (this.pos >= this.end) return;
      if (isWS(c)) this.pos++;
      else if (c === 0x25) { while (this.pos < this.end && this.buf[this.pos] !== 10 && this.buf[this.pos] !== 13) this.pos++; }
      else return;
    }
  }
  // Returns a value, a Keyword (operators/structure words), or undefined at the end.
  next(depth = 0) {
    if (depth > 100) fail('PDF 객체의 중첩이 너무 깊습니다.');
    this.skip();
    if (this.pos >= this.end) return undefined;
    const b = this.buf, c = b[this.pos];
    if (c === 0x2f) { // name
      this.pos++; let s = '';
      while (this.pos < this.end && isReg(b[this.pos])) {
        if (b[this.pos] === 0x23 && /^[0-9a-fA-F]{2}$/.test(b.toString('latin1', this.pos + 1, this.pos + 3))) { s += String.fromCharCode(parseInt(b.toString('latin1', this.pos + 1, this.pos + 3), 16)); this.pos += 3; }
        else s += String.fromCharCode(b[this.pos++]);
      }
      return new Name(s);
    }
    if (c === 0x28) return this.literal();
    if (c === 0x3c && b[this.pos + 1] === 0x3c) { this.pos += 2; return this.dict(depth); }
    if (c === 0x3c) return this.hex();
    if (c === 0x5b) {
      this.pos++; const arr = [];
      for (;;) {
        this.skip();
        if (this.pos >= this.end) return arr;
        if (b[this.pos] === 0x5d) { this.pos++; return arr; }
        const v = this.next(depth + 1);
        if (v === undefined) return arr;
        arr.push(v);
      }
    }
    if (c === 0x29 || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x3e) { this.pos++; return new Keyword(String.fromCharCode(c)); }
    const start = this.pos;
    while (this.pos < this.end && isReg(b[this.pos])) this.pos++;
    const word = b.toString('latin1', start, this.pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const value = Number(word);
      if (depth >= 0 && /^\d+$/.test(word)) { // possible "n g R"
        const save = this.pos;
        this.skip();
        const s2 = this.pos;
        while (this.pos < this.end && b[this.pos] >= 0x30 && b[this.pos] <= 0x39) this.pos++;
        if (this.pos > s2) {
          const gen = Number(b.toString('latin1', s2, this.pos));
          this.skip();
          if (b[this.pos] === 0x52 && !isReg(b[this.pos + 1])) { this.pos++; return new Ref(value, gen); }
        }
        this.pos = save;
      }
      return value;
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new Keyword(word);
  }
  dict(depth) {
    const d = new Dict();
    for (;;) {
      this.skip();
      if (this.pos >= this.end) return d;
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) { this.pos += 2; return d; }
      const key = this.next(depth + 1);
      if (!(key instanceof Name)) { if (key === undefined) return d; continue; }
      const value = this.next(depth + 1);
      if (value instanceof Keyword && value.word === '>') continue;
      d.map.set(key.name, value);
    }
  }
  literal() {
    const b = this.buf; this.pos++;
    const out = []; let level = 1;
    while (this.pos < this.end) {
      let c = b[this.pos++];
      if (c === 0x5c) {
        c = b[this.pos++];
        if (c === 0x6e) out.push(10); else if (c === 0x72) out.push(13); else if (c === 0x74) out.push(9); else if (c === 0x62) out.push(8); else if (c === 0x66) out.push(12);
        else if (c >= 0x30 && c <= 0x37) {
          let v = c - 0x30;
          for (let i = 0; i < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; i++) v = v * 8 + (b[this.pos++] - 0x30);
          out.push(v & 255);
        } else if (c === 13) { if (b[this.pos] === 10) this.pos++; } else if (c === 10) { /* line continuation */ } else out.push(c);
      } else if (c === 0x28) { level++; out.push(c); }
      else if (c === 0x29) { if (--level === 0) break; out.push(c); }
      else out.push(c);
    }
    return Buffer.from(out);
  }
  hex() {
    const b = this.buf; this.pos++;
    let s = '';
    while (this.pos < this.end && b[this.pos] !== 0x3e) { const ch = String.fromCharCode(b[this.pos++]); if (/[0-9a-fA-F]/.test(ch)) s += ch; }
    this.pos++;
    if (s.length % 2) s += '0';
    return Buffer.from(s, 'hex');
  }
}

function predictor(data, parms) {
  const p = parms?.get('Predictor');
  if (!p || p === 1) return data;
  const columns = parms.get('Columns') || 1, colors = parms.get('Colors') || 1, bpc = parms.get('BitsPerComponent') || 8;
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8)), row = Math.ceil(columns * colors * bpc / 8);
  if (p < 10) return data;
  const rows = Math.floor(data.length / (row + 1));
  const out = Buffer.alloc(rows * row);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (row + 1)], src = r * (row + 1) + 1, dst = r * row;
    for (let i = 0; i < row; i++) {
      const x = data[src + i], a = i >= bpp ? out[dst + i - bpp] : 0, b = r ? out[dst - row + i] : 0, c = r && i >= bpp ? out[dst - row + i - bpp] : 0;
      let v;
      if (type === 0) v = x; else if (type === 1) v = x + a; else if (type === 2) v = x + b; else if (type === 3) v = x + ((a + b) >> 1);
      else { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[dst + i] = v & 255;
    }
  }
  return out;
}
function ascii85(data) {
  const out = []; let tuple = 0, count = 0;
  const text = data.toString('latin1').replace(/\s+/g, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '~') break;
    if (ch === 'z' && count === 0) { out.push(0, 0, 0, 0); continue; }
    tuple = tuple * 85 + (ch.charCodeAt(0) - 33); count++;
    if (count === 5) { out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255); tuple = 0; count = 0; }
  }
  if (count > 1) { for (let i = count; i < 5; i++) tuple = tuple * 85 + 84; const bytes = [(tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255]; out.push(...bytes.slice(0, count - 1)); }
  return Buffer.from(out);
}

class PdfDocument {
  constructor(buf, limits = {}) {
    this.buf = buf; this.limits = { ...PDF_LIMITS, ...limits };
    this.offsets = new Map(); this.cache = new Map(); this.objStms = new Map(); this.inObjStm = new Map();
    this.trailers = []; this.warnings = [];
    this.scan();
  }
  // Sequential scan for "N G obj". Stream bodies are skipped, so binary data cannot create phantom objects.
  scan() {
    const b = this.buf;
    let pos = 0, count = 0;
    while (pos < b.length) {
      const at = b.indexOf('obj', pos, 'latin1');
      if (at < 0) break;
      if (b[at - 1] === 0x64 /* endobj */ || isReg(b[at + 3]) && b[at + 3] !== undefined) { pos = at + 3; continue; }
      let i = at - 1;
      while (i >= 0 && isWS(b[i])) i--;
      let e = i; while (i >= 0 && b[i] >= 0x30 && b[i] <= 0x39) i--;
      if (e === i) { pos = at + 3; continue; }
      const gen = Number(b.toString('latin1', i + 1, e + 1));
      while (i >= 0 && isWS(b[i])) i--;
      e = i; while (i >= 0 && b[i] >= 0x30 && b[i] <= 0x39) i--;
      if (e === i) { pos = at + 3; continue; }
      const num = Number(b.toString('latin1', i + 1, e + 1));
      if (++count > this.limits.objects) fail('PDF 객체가 너무 많습니다.', 'PDF_LIMIT');
      this.offsets.set(num, at + 3);
      const lex = new Lexer(b, at + 3);
      const value = lex.next();
      let next = lex.pos;
      if (value instanceof Dict) {
        lex.skip();
        if (b.toString('latin1', lex.pos, lex.pos + 6) === 'stream') {
          let start = lex.pos + 6; if (b[start] === 13) start++; if (b[start] === 10) start++;
          value.streamAt = start;
          let length = value.get('Length');
          if (length instanceof Ref) length = undefined;
          let end = typeof length === 'number' && b.toString('latin1', start + length, start + length + 20).replace(/^\s+/, '').startsWith('endstream') ? start + length : -1;
          if (end < 0) { end = b.indexOf('endstream', start, 'latin1'); if (end < 0) end = b.length; }
          value.streamEnd = end; next = end;
        }
        if (value.get('Type') instanceof Name && ['XRef'].includes(value.get('Type').name)) this.trailers.push(value);
        if (value.get('Type') instanceof Name && value.get('Type').name === 'ObjStm') this.objStms.set(num, true);
      }
      void gen;
      pos = Math.max(next, at + 3);
    }
    // Read trailers once after indexing objects, not by searching the remaining file for every object.
    let t = 0;
    while ((t = b.indexOf('trailer', t, 'latin1')) >= 0) { this.readTrailer(t + 7); t += 7; }
  }
  readTrailer(pos) { try { const v = new Lexer(this.buf, pos).next(); if (v instanceof Dict && !this.trailers.includes(v)) this.trailers.push(v); } catch { /* ignore */ } }
  resolve(value) { return value instanceof Ref ? this.get(value.num) : value; }
  get(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    let value;
    if (this.offsets.has(num)) { const lex = new Lexer(this.buf, this.offsets.get(num)); value = lex.next(); if (value instanceof Dict) { lex.skip(); } }
    if (value === undefined || (this.inObjStm.has(num) && !this.offsets.has(num))) value = this.fromObjStm(num);
    if (value instanceof Dict && this.offsets.has(num)) { /* streamAt is set during the scan only for scanned dicts; re-read below */ value = this.withStream(num, value); }
    this.cache.set(num, value);
    return value;
  }
  withStream(num, dict) {
    if (dict.streamAt >= 0) return dict;
    const lex = new Lexer(this.buf, this.offsets.get(num)); lex.next(); lex.skip();
    if (this.buf.toString('latin1', lex.pos, lex.pos + 6) === 'stream') {
      let start = lex.pos + 6; if (this.buf[start] === 13) start++; if (this.buf[start] === 10) start++;
      let end = this.buf.indexOf('endstream', start, 'latin1'); if (end < 0) end = this.buf.length;
      const len = this.resolve(dict.get('Length'));
      if (typeof len === 'number' && start + len <= this.buf.length && this.buf.toString('latin1', start + len, start + len + 20).replace(/^\s+/, '').startsWith('endstream')) end = start + len;
      dict.streamAt = start; dict.streamEnd = end;
    }
    return dict;
  }
  fromObjStm(num) {
    if (!this.objStmIndexed) {
      this.objStmIndexed = true;
      for (const stmNum of this.objStms.keys()) {
        try {
          const dict = this.get(stmNum), data = this.streamData(dict);
          const n = this.resolve(dict.get('N')), first = this.resolve(dict.get('First'));
          const lex = new Lexer(data, 0);
          for (let i = 0; i < n; i++) { const on = lex.next(), off = lex.next(); if (typeof on === 'number' && typeof off === 'number' && !this.offsets.has(on)) this.inObjStm.set(on, { stmNum, offset: first + off, data }); }
        } catch (error) { this.warnings.push(`객체 스트림을 읽지 못했습니다: ${error.message}`); }
      }
    }
    const info = this.inObjStm.get(num);
    if (!info) return undefined;
    return new Lexer(info.data, info.offset).next();
  }
  streamData(dict) {
    if (!(dict instanceof Dict) || dict.streamAt < 0) return Buffer.alloc(0);
    let data = this.buf.subarray(dict.streamAt, dict.streamEnd);
    let filters = this.resolve(dict.get('Filter')), parms = this.resolve(dict.get('DecodeParms'));
    if (filters === undefined || filters === null) return data;
    if (!Array.isArray(filters)) { filters = [filters]; parms = [parms]; } else parms = Array.isArray(parms) ? parms : [];
    filters.forEach((f, i) => {
      const name = this.resolve(f)?.name, p = this.resolve(parms[i]);
      if (name === 'FlateDecode' || name === 'Fl') {
        try { data = zlib.inflateSync(data, { maxOutputLength: this.limits.streamBytes, finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
        catch (error) { if (error.code === 'ERR_BUFFER_TOO_LARGE') fail('PDF 스트림의 압축 해제 크기가 한도를 넘었습니다.', 'PDF_BOMB'); throw Object.assign(new Error('PDF 스트림 압축 해제 실패'), { code: 'PDF_STREAM' }); }
        data = predictor(data, p instanceof Dict ? p : null);
      } else if (name === 'ASCIIHexDecode' || name === 'AHx') data = Buffer.from(data.toString('latin1').replace(/[^0-9a-fA-F]/g, '').replace(/(.)$/, (m, c, o, s) => (s.length % 2 ? c + '0' : c)), 'hex');
      else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85(data);
      else throw Object.assign(new Error(`지원하지 않는 PDF 필터(${name})`), { code: 'PDF_STREAM' });
    });
    return data;
  }
  root() {
    for (const t of [...this.trailers].reverse()) { if (t.get('Root')) return this.resolve(t.get('Root')); }
    for (const num of this.offsets.keys()) { const v = this.get(num); if (v instanceof Dict && v.get('Type')?.name === 'Catalog') return v; }
    return null;
  }
  encrypted() { return this.trailers.some((t) => t.get('Encrypt')); }
}

// ---- fonts ----
function parseCMap(text) {
  const map = new Map(); let codeBytes = 1;
  const hexNum = (h) => parseInt(h, 16);
  const uni = (h) => { const b = Buffer.from(h.length % 2 ? h + '0' : h, 'hex'); let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i)); if (b.length === 1) s = String.fromCharCode(b[0]); return s; };
  for (const m of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) for (const h of m[1].matchAll(/<([0-9a-fA-F]+)>/g)) codeBytes = Math.max(codeBytes, Math.ceil(h[1].length / 2));
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const h of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(hexNum(h[1]), uni(h[2]));
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const h of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = hexNum(h[1]), hi = Math.min(hexNum(h[2]), lo + 65535);
      if (h[3].startsWith('[')) { let i = lo; for (const d of h[3].matchAll(/<([0-9a-fA-F]*)>/g)) map.set(i++, uni(d[1])); }
      else { const base = uni(h[3].slice(1, -1)); for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo))); }
    }
  }
  return { map, codeBytes };
}
function loadFont(doc, ref, cache) {
  const key = ref instanceof Ref ? ref.num : ref;
  if (cache.has(key)) return cache.get(key);
  const font = doc.resolve(ref);
  const info = { map: null, codeBytes: 1, decodable: true, type0: false };
  if (font instanceof Dict) {
    info.type0 = font.get('Subtype')?.name === 'Type0';
    const to = doc.resolve(font.get('ToUnicode'));
    if (to instanceof Dict) { try { const c = parseCMap(doc.streamData(to).toString('latin1')); info.map = c.map; info.codeBytes = c.codeBytes; } catch { /* decode as plain text below */ } }
    if (info.type0) { info.codeBytes = info.map ? info.codeBytes : 2; if (!info.map) info.decodable = false; }
  }
  cache.set(key, info);
  return info;
}
function decodeText(font, bytes) {
  if (!font) return bytes.toString('latin1');
  if (!font.decodable) return '';
  let out = '';
  if (font.map) {
    const n = Math.max(1, font.codeBytes);
    for (let i = 0; i + n <= bytes.length; i += n) { let code = 0; for (let j = 0; j < n; j++) code = code * 256 + bytes[i + j]; const s = font.map.get(code); out += s !== undefined ? s : (n === 1 && code >= 32 ? String.fromCharCode(code) : ''); }
    return out;
  }
  return bytes.toString('latin1');
}

// ---- content stream ----
function interpret(doc, data, resources, state, depth) {
  const lex = new Lexer(data);
  const stack = [];
  const fonts = doc.resolve(doc.resolve(resources)?.get('Font'));
  const xobjects = doc.resolve(doc.resolve(resources)?.get('XObject'));
  let font = null, lastY = null, any = false;
  const emit = (text) => { if (!text) return; state.line += text; any = true; };
  const newline = () => { if (state.line.trim()) state.lines.push(state.line.replace(/\s+$/, '')); state.line = ''; };
  const moveY = (dy) => { if (Math.abs(dy) > 0.5) newline(); else if (state.line && !/\s$/.test(state.line)) state.line += ' '; };
  for (;;) {
    const token = lex.next();
    if (token === undefined) break;
    if (!(token instanceof Keyword)) { stack.push(token); if (stack.length > 4096) stack.shift(); continue; }
    const op = token.word, a = stack;
    if (op === 'Tf') { const name = a[a.length - 2]; if (name instanceof Name && fonts instanceof Dict) font = loadFont(doc, fonts.get(name.name), state.fontCache); }
    else if (op === 'Tj') { if (Buffer.isBuffer(a.at(-1))) emit(decodeText(font, a.at(-1))); }
    else if (op === "'" || op === '"') { newline(); if (Buffer.isBuffer(a.at(-1))) emit(decodeText(font, a.at(-1))); }
    else if (op === 'TJ') {
      for (const item of a.at(-1) || []) {
        if (Buffer.isBuffer(item)) emit(decodeText(font, item));
        else if (typeof item === 'number' && item < -500 && state.line && !/\s$/.test(state.line)) state.line += ' ';
      }
    } else if (op === 'Td' || op === 'TD') { const dy = a.at(-1); if (typeof dy === 'number') moveY(dy); lastY = dy; }
    else if (op === 'Tm') { const y = a.at(-1); if (typeof y === 'number') { if (lastY !== null && Math.abs(y - lastY) > 0.5) newline(); else if (state.line && !/\s$/.test(state.line)) state.line += ' '; lastY = y; } }
    else if (op === 'T*') newline();
    else if (op === 'ET') { if (state.line && !/\s$/.test(state.line)) state.line += ' '; }
    else if (op === 'BI') { // inline image: skip to EI
      state.images++;
      const rest = Buffer.from(data.subarray(lex.pos)); const e = rest.indexOf('\nEI', 0, 'latin1'); const e2 = e < 0 ? rest.indexOf(' EI', 0, 'latin1') : e;
      lex.pos = e2 < 0 ? data.length : lex.pos + e2 + 3;
    } else if (op === 'Do') {
      const name = a.at(-1);
      const x = name instanceof Name && xobjects instanceof Dict ? doc.resolve(xobjects.get(name.name)) : null;
      if (x instanceof Dict) {
        const sub = x.get('Subtype')?.name;
        if (sub === 'Image') state.images++;
        else if (sub === 'Form' && depth < doc.limits.formDepth) { try { newline(); interpret(doc, doc.streamData(x), doc.resolve(x.get('Resources')) || resources, state, depth + 1); newline(); } catch { /* unreadable form */ } }
      }
    }
    stack.length = 0;
  }
  newline();
  return any;
}

function* pageList(doc, node, resources, depth = 0, seen = new Set()) {
  if (depth > doc.limits.depth || !(node instanceof Dict)) return;
  const res = node.get('Resources') !== undefined ? node.get('Resources') : resources;
  const kids = doc.resolve(node.get('Kids'));
  if (Array.isArray(kids)) {
    for (const kid of kids) {
      const key = kid instanceof Ref ? kid.num : null;
      if (key !== null) { if (seen.has(key)) continue; seen.add(key); }
      yield* pageList(doc, doc.resolve(kid), res, depth + 1, seen);
    }
  } else yield { node, resources: res };
}

// Generator of {page, text, images, decodable}. Memory use is one page at a time.
export function* pdfPages(buffer, limits = {}) {
  if (!Buffer.isBuffer(buffer)) fail('PDF 데이터가 올바르지 않습니다.');
  if (buffer.length > (limits.fileBytes ?? PDF_LIMITS.fileBytes)) fail('PDF 파일이 처리 한도(256MB)를 넘었습니다.', 'PDF_LIMIT');
  if (!buffer.subarray(0, 1024).includes('%PDF-')) fail('PDF 파일이 아닙니다.');
  const doc = new PdfDocument(buffer, limits);
  if (doc.encrypted()) fail('암호화된 PDF는 읽지 않습니다. 암호를 해제한 파일을 첨부하세요.', 'PDF_ENCRYPTED');
  const root = doc.root();
  const pages = doc.resolve(root?.get('Pages'));
  if (!(pages instanceof Dict)) fail('PDF의 페이지 구조를 찾지 못했습니다.');
  const fontCache = new Map();
  let n = 0;
  for (const { node, resources } of pageList(doc, pages, undefined)) {
    if (++n > doc.limits.pages) fail('PDF 페이지가 너무 많습니다.', 'PDF_LIMIT');
    const state = { lines: [], line: '', images: 0, fontCache };
    let decodable = true, error = '';
    try {
      let contents = doc.resolve(node.get('Contents'));
      if (!Array.isArray(contents)) contents = contents === undefined ? [] : [contents];
      const parts = contents.map((c) => doc.resolve(c)).filter((c) => c instanceof Dict).map((c) => doc.streamData(c));
      interpret(doc, Buffer.concat(parts.flatMap((p) => [p, Buffer.from('\n')])), doc.resolve(resources), state, 0);
    } catch (e) { error = e.message; }
    const text = state.lines.join('\n');
    for (const info of fontCache.values()) if (!info.decodable) decodable = false;
    yield { page: n, text, images: state.images, decodable, error, warnings: doc.warnings };
  }
  if (!n) fail('PDF에서 페이지를 찾지 못했습니다.');
}
