import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createHash, randomUUID } from 'node:crypto';
import { ZipReader } from './task-zip.mjs';
import { pdfPages } from './task-pdf.mjs';

// Turns a file into plain text pieces with a location label, streaming wherever the format allows it, and spools them
// into bounded chunks on disk. Nothing here sends data anywhere; the analysis engine decides what reaches the model.
export const EXTRACT_LIMITS = { textBytes: 256 * 1024 * 1024, readBlock: 1024 * 1024, chunkBytes: 12000, xmlWindow: 4 * 1024 * 1024, pdfBytes: 256 * 1024 * 1024,
  officeBytes: 512 * 1024 * 1024, sharedStrings: 4_000_000, timeMs: 10 * 60000 };
const fail = (message, code = 'EXTRACT') => { throw Object.assign(new Error(message), { code, status: 400 }); };
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.xml', '.html', '.htm', '.yaml', '.yml', '.log', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.jsx', '.css', '.py', '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.ini', '.cfg', '.toml', '.rst', '.tex', '.srt', '.vtt', '.svg', '.bib']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
export function sniffKind(name, head = Buffer.alloc(0)) {
  const ext = path.extname(name).toLowerCase();
  if (head.subarray(0, 5).toString('latin1') === '%PDF-' || ext === '.pdf') return 'pdf';
  if (head[0] === 0x50 && head[1] === 0x4b) { if (ext === '.docx') return 'docx'; if (ext === '.pptx') return 'pptx'; if (ext === '.xlsx') return 'xlsx'; return 'zip'; }
  if (['.doc', '.ppt', '.xls', '.hwp'].includes(ext)) return 'legacy';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  if (!head.includes(0) && head.length) return 'text';
  return 'binary';
}

const unescapeXml = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]));
export const xmlUnescape = unescapeXml;

// Windows of an XML buffer that each end exactly after `endTag`, so a record is never cut in half.
function* xmlWindows(buffer, endTag, size = EXTRACT_LIMITS.xmlWindow) {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  for (let p = 0; p < buffer.length; p += size) {
    carry += decoder.write(buffer.subarray(p, Math.min(buffer.length, p + size)));
    const cut = carry.lastIndexOf(endTag);
    if (cut >= 0 && p + size < buffer.length) { yield carry.slice(0, cut + endTag.length); carry = carry.slice(cut + endTag.length); }
  }
  carry += decoder.end();
  if (carry) yield carry;
}

// ---- plain text: encoding detection + streaming ----
function textEncoding(head) {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { label: 'utf-8', skip: 3 };
  if (head[0] === 0xff && head[1] === 0xfe) return { label: 'utf-16le', skip: 2 };
  if (head[0] === 0xfe && head[1] === 0xff) return { label: 'utf-16be', skip: 2 };
  // stream:true tolerates a multi-byte character cut by the end of the sample; real invalid bytes still throw.
  try { new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true }); return { label: 'utf-8', skip: 0 }; } catch { /* maybe a legacy code page */ }
  return { label: 'euc-kr', skip: 0 };
}
async function* textPieces(file, { signal }) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(65536, size)); fs.readSync(fd, head, 0, head.length, 0);
    if (head.includes(0) && !(head[0] === 0xff && head[1] === 0xfe) && !(head[0] === 0xfe && head[1] === 0xff)) fail('바이너리 파일이라 텍스트로 읽을 수 없습니다.', 'EXTRACT_BINARY');
    const enc = textEncoding(head);
    const decoder = new TextDecoder(enc.label, { fatal: false, ignoreBOM: true });
    const buf = Buffer.alloc(EXTRACT_LIMITS.readBlock);
    let position = enc.skip, total = 0;
    for (;;) {
      if (signal?.aborted) fail('분석이 취소되었습니다.', 'CANCELLED');
      const n = fs.readSync(fd, buf, 0, buf.length, position);
      if (!n) break;
      position += n; total += n;
      if (total > EXTRACT_LIMITS.textBytes) fail('텍스트가 처리 한도(256MB)를 넘었습니다.', 'EXTRACT_LIMIT');
      yield { text: decoder.decode(buf.subarray(0, n), { stream: true }), loc: null };
      await yieldLoop();
    }
    const rest = decoder.decode();
    if (rest) yield { text: rest, loc: null };
  } finally { fs.closeSync(fd); }
}

// ---- Office ----
function openZip(file, kind) {
  const size = Buffer.isBuffer(file) ? file.length : fs.statSync(file).size;
  if (size > EXTRACT_LIMITS.officeBytes) fail('문서 파일이 처리 한도(512MB)를 넘었습니다.', 'EXTRACT_LIMIT');
  const zip = new ZipReader(file);
  const need = { docx: 'word/document.xml', pptx: 'ppt/presentation.xml', xlsx: 'xl/workbook.xml' }[kind];
  if (!zip.has(need)) { zip.close(); fail(`올바른 ${kind.toUpperCase()} 문서가 아닙니다.`, 'EXTRACT_INVALID'); }
  return zip;
}
const paragraphText = (xml, tag) => {
  let out = '';
  for (const m of xml.matchAll(new RegExp(`<${tag}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}:t>|<${tag}:tab\\s*/>|<${tag}:br\\s*/>|<${tag}:cr\\s*/>`, 'g'))) {
    out += m[1] !== undefined ? unescapeXml(m[1]) : m[0].includes(':tab') ? '\t' : '\n';
  }
  return out;
};
function* docxSync(file, { signal }) {
  const zip = openZip(file, 'docx');
  try {
    const xml = zip.read('word/document.xml');
    let table = 0, row = [], cell = [];
    for (const windowText of xmlWindows(xml, '</w:p>')) {
      if (signal?.aborted) fail('분석이 취소되었습니다.', 'CANCELLED');
      let out = '';
      for (const m of windowText.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:tbl>|<\/w:tbl>|<\/w:tc>|<\/w:tr>/g)) {
        const t = m[0];
        if (t === '<w:tbl>') { table++; continue; }
        if (t === '</w:tbl>') { table = Math.max(0, table - 1); out += '\n'; continue; }
        if (t === '</w:tc>') { row.push(cell.join(' ').trim()); cell = []; continue; }
        if (t === '</w:tr>') { out += `${row.join(' | ')}\n`; row = []; continue; }
        const text = paragraphText(t, 'w');
        if (table) { if (text.trim()) cell.push(text.trim()); continue; }
        const style = /<w:pStyle w:val="([^"]+)"/.exec(t)?.[1] || '';
        const level = /^(?:Heading|heading|제목)\s*(\d)$/.exec(style)?.[1] || (/^Title$/i.test(style) ? '1' : '');
        if (!text.trim()) { out += '\n'; continue; }
        out += `${level ? `${'#'.repeat(Number(level))} ` : /<w:numPr>/.test(t) ? '- ' : ''}${text}\n`;
      }
      yield { text: out, loc: null };
    }
  } finally { zip.close(); }
}
async function* docxPieces(file, options) {
  let n = 0;
  for (const piece of docxSync(file, options)) { yield piece; if (++n % 20 === 0) await yieldLoop(); }
}

function* pptxSync(file, { signal }) {
  const zip = openZip(file, 'pptx');
  try {
    const slides = zip.names().map((n) => ({ n, i: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(n)?.[1]) })).filter((s) => s.i).sort((a, b) => a.i - b.i);
    let index = 0;
    for (const slide of slides) {
      if (signal?.aborted) fail('분석이 취소되었습니다.', 'CANCELLED');
      index++;
      const xml = zip.text(slide.n);
      const paragraphs = [...xml.matchAll(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g)].map((m) => paragraphText(m[0], 'a').trim()).filter(Boolean);
      let notes = '';
      const noteName = `ppt/notesSlides/notesSlide${slide.i}.xml`;
      if (zip.has(noteName)) notes = [...zip.text(noteName).matchAll(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g)].map((m) => paragraphText(m[0], 'a').trim()).filter(Boolean).join('\n');
      yield { text: `## 슬라이드 ${index}\n${paragraphs.join('\n')}${notes ? `\n(발표자 노트) ${notes}` : ''}\n\n`, loc: `슬라이드 ${index}` };
    }
  } finally { zip.close(); }
}
async function* pptxPieces(file, options) {
  let n = 0;
  for (const piece of pptxSync(file, options)) { yield piece; if (++n % 20 === 0) await yieldLoop(); }
}

const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)?.[0] || '') n = n * 26 + ch.charCodeAt(0) - 64; return n; };
function* xlsxSync(file, { signal }) {
  const zip = openZip(file, 'xlsx');
  try {
    const shared = [];
    if (zip.has('xl/sharedStrings.xml')) {
      for (const windowText of xmlWindows(zip.read('xl/sharedStrings.xml'), '</si>')) {
        for (const m of windowText.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
          if (shared.length >= EXTRACT_LIMITS.sharedStrings) fail('공유 문자열이 너무 많습니다.', 'EXTRACT_LIMIT');
          shared.push([...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join(''));
        }
      }
    }
    const wb = zip.text('xl/workbook.xml');
    const rels = zip.has('xl/_rels/workbook.xml.rels') ? zip.text('xl/_rels/workbook.xml.rels') : '';
    const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
    const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m, i) => {
      const name = unescapeXml(/name="([^"]*)"/.exec(m[0])?.[1] || `Sheet${i + 1}`), rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
      let t = target.get(rid) || `worksheets/sheet${i + 1}.xml`;
      t = t.startsWith('/') ? t.slice(1) : `xl/${t}`;
      return { name, file: t };
    });
    for (const sheet of sheets) {
      if (!zip.has(sheet.file)) continue;
      yield { text: `## 시트: ${sheet.name}\n`, loc: `시트 ${sheet.name}` };
      for (const windowText of xmlWindows(zip.read(sheet.file), '</row>')) {
        if (signal?.aborted) fail('분석이 취소되었습니다.', 'CANCELLED');
        let out = '';
        for (const row of windowText.matchAll(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
          const cells = [];
          for (const c of row[0].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const attrs = c[1], body = c[2] || '', type = /\bt="([^"]+)"/.exec(attrs)?.[1] || 'n', ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] || '';
            let value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
            if (type === 's') value = shared[Number(value)] ?? '';
            else if (type === 'inlineStr') value = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join('');
            else value = unescapeXml(value);
            const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(body)?.[1];
            const col = colIndex(ref);
            while (cells.length < col - 1) cells.push('');
            cells.push(formula ? `${value} (=${unescapeXml(formula)})` : value);
          }
          while (cells.length && cells.at(-1) === '') cells.pop();
          if (cells.length) out += `${cells.join('\t')}\n`;
        }
        if (out) yield { text: out, loc: `시트 ${sheet.name}` };
      }
    }
  } finally { zip.close(); }
}
async function* xlsxPieces(file, options) {
  let n = 0;
  for (const piece of xlsxSync(file, options)) { yield piece; if (++n % 20 === 0) await yieldLoop(); }
}

// ---- PDF ----
export async function* pdfPieces(file, { signal, info }) {
  const size = fs.statSync(file).size;
  if (size > EXTRACT_LIMITS.pdfBytes) fail('PDF 파일이 처리 한도(256MB)를 넘었습니다.', 'EXTRACT_LIMIT');
  const buffer = fs.readFileSync(file);
  info.pages = 0; info.textPages = 0; info.scannedPages = []; info.undecodablePages = [];
  for (const page of pdfPages(buffer)) {
    if (signal?.aborted) fail('분석이 취소되었습니다.', 'CANCELLED');
    info.pages++;
    const text = page.text.trim();
    if (text) info.textPages++;
    else if (page.images) info.scannedPages.push(page.page);
    else if (!page.decodable) info.undecodablePages.push(page.page);
    yield { text: text ? `[${page.page}쪽]\n${text}\n\n` : '', loc: `${page.page}쪽` };
    if (page.page % 20 === 0) await yieldLoop();
  }
}

export function pieces(file, kind, { signal, info }) {
  if (kind === 'text') return textPieces(file, { signal });
  if (kind === 'docx') return docxPieces(file, { signal });
  if (kind === 'pptx') return pptxPieces(file, { signal });
  if (kind === 'xlsx') return xlsxPieces(file, { signal });
  if (kind === 'pdf') return pdfPieces(file, { signal, info });
  if (kind === 'legacy') fail('구형 Office(.doc/.ppt/.xls)·한글(.hwp) 파일은 지원하지 않습니다. .docx/.pptx/.xlsx 또는 PDF로 저장해서 첨부하세요.', 'EXTRACT_UNSUPPORTED');
  if (kind === 'image') fail('이미지는 문서 분석이 아니라 이미지 기능으로 처리합니다.', 'EXTRACT_UNSUPPORTED');
  if (kind === 'zip') fail('일반 압축 파일은 풀어서 첨부하세요. 압축 폭탄 위험 때문에 직접 읽지 않습니다.', 'EXTRACT_UNSUPPORTED');
  return fail('지원하지 않는 파일 형식입니다.', 'EXTRACT_UNSUPPORTED');
}

// Largest prefix of s[start..] that fits maxBytes of UTF-8, never splitting a surrogate pair.
function cutPoint(s, start, maxBytes) {
  let bytes = 0, i = start;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let width = 1, size = 1;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { width = 2; size = 4; } else if (c >= 0x800) size = 3; else if (c >= 0x80) size = 2;
    if (bytes + size > maxBytes) return { end: i, full: true };
    bytes += size; i += width;
  }
  return { end: i, full: false };
}

// Spools extracted text into a UTF-8 file plus a chunk index. Chunks break at line ends when possible and each remembers
// the location labels (page/slide/sheet) it covers, so coverage can be reported in the document's own terms.
export async function spoolText(file, { name = path.basename(file), cacheDir, key, signal, deadlineMs = EXTRACT_LIMITS.timeMs, clock = Date.now, chunkBytes = EXTRACT_LIMITS.chunkBytes } = {}) {
  const head = Buffer.alloc(8192); const fd = fs.openSync(file, 'r');
  let headRead = 0; try { headRead = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  const kind = sniffKind(name, head.subarray(0, headRead));
  fs.mkdirSync(cacheDir, { recursive: true });
  const textFile = path.join(cacheDir, `${key}.txt`);
  const temp = `${textFile}.${randomUUID()}.tmp`;
  const out = fs.openSync(temp, 'wx');
  const info = { kind };
  const index = [];
  let pending = '', pendingLocs = [], written = 0, chars = 0;
  const started = clock();
  const hash = createHash('sha256');
  const flush = (text, locs) => {
    const bytes = Buffer.from(text, 'utf8');
    fs.writeSync(out, bytes); hash.update(bytes);
    index.push({ start: written, end: written + bytes.length, chars: text.length, loc: [...new Set(locs)].slice(0, 3) });
    written += bytes.length; chars += text.length;
  };
  try {
    for await (const piece of pieces(file, kind, { signal, info })) {
      if (signal?.aborted) fail('분석이 취소되었습니다.', 'CANCELLED');
      if (clock() - started > deadlineMs) fail('문서 변환 시간이 제한을 넘었습니다.', 'EXTRACT_TIMEOUT');
      if (!piece.text) continue;
      pending += piece.text.replace(/\r\n?/g, '\n');
      if (piece.loc) pendingLocs.push(piece.loc);
      let start = 0;
      for (;;) {
        const { end, full } = cutPoint(pending, start, chunkBytes);
        if (!full) break;
        let cut = end;
        const nl = pending.lastIndexOf(String.fromCharCode(10), end - 1);
        if (nl >= start + (end - start) * 0.6) cut = nl + 1;
        flush(pending.slice(start, cut), pendingLocs);
        pendingLocs = piece.loc ? [piece.loc] : pendingLocs.slice(-1);
        start = cut;
      }
      pending = pending.slice(start);
    }
    if (pending.trim()) flush(pending, pendingLocs);
  } catch (error) { fs.closeSync(out); try { fs.rmSync(temp, { force: true }); } catch { /* cleaned later */ } throw error; }
  fs.fsyncSync(out); fs.closeSync(out);
  fs.renameSync(temp, textFile);
  return { kind, textFile, bytes: written, chars, chunks: index.length, index, info, textHash: hash.digest('hex') };
}

// Reads some chunks back (never the whole spool).
export function readChunks(spool, ids) {
  const fd = fs.openSync(spool.textFile, 'r');
  try {
    return ids.map((id) => {
      const c = spool.index[id]; const b = Buffer.alloc(c.end - c.start);
      fs.readSync(fd, b, 0, b.length, c.start);
      return { id, text: b.toString('utf8'), loc: c.loc };
    });
  } finally { fs.closeSync(fd); }
}

// Plain-text view of an in-memory Office document (used for approval previews). Synchronous and bounded.
export function previewTextSync(bytes, kind, maxChars = 120000) {
  const generator = { docx: docxSync, pptx: pptxSync, xlsx: xlsxSync }[kind];
  if (!generator) throw Object.assign(new Error('미리보기를 지원하지 않는 형식입니다.'), { status: 400 });
  let out = '';
  for (const piece of generator(bytes, { signal: null })) {
    out += piece.text;
    if (out.length > maxChars) return out.slice(0, maxChars) + String.fromCharCode(10) + '…(미리보기는 여기까지)';
  }
  return out;
}
export const previewText = async (bytes, kind, maxChars) => previewTextSync(bytes, kind, maxChars);
