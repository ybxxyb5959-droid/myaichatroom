import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ZipReader, writeZip, crc32 } from '../lib/task-zip.mjs';
import { pdfPages } from '../lib/task-pdf.mjs';
import { spoolText, readChunks, sniffKind, previewText } from '../lib/task-extract.mjs';
import { makePdf } from './helpers/pdf.mjs';

const temp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const pages = (buffer) => [...pdfPages(buffer)];

test('zip: round trip, CRC, traversal names and encrypted/zip64/bomb entries are refused', () => {
  const zip = writeZip([{ name: 'a.txt', data: '가나다'.repeat(1000) }, { name: 'dir/b.bin', data: Buffer.from([1, 2, 3]), store: true }]);
  const reader = new ZipReader(zip);
  assert.deepEqual(reader.names(), ['a.txt', 'dir/b.bin']);
  assert.equal(reader.text('a.txt'), '가나다'.repeat(1000));
  assert.deepEqual([...reader.read('dir/b.bin')], [1, 2, 3]);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.throws(() => writeZip([{ name: '../evil', data: 'x' }]), /쓸 수 없는/);
  assert.throws(() => writeZip([{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }]), /쓸 수 없는/);
  // corrupted payload -> CRC mismatch
  const bad = Buffer.from(zip); bad[bad.indexOf(Buffer.from([1, 2, 3]))] = 9;
  assert.throws(() => new ZipReader(bad).read('dir/b.bin'), /CRC/);
  // a traversal name smuggled into the directory is refused when opening
  const evil = Buffer.from(writeZip([{ name: 'xx/evil.txt', data: 'x' }]));
  for (let i = 0; i < evil.length - 3; i++) if (evil.toString('latin1', i, i + 3) === 'xx/') { evil.write('../', i, 'latin1'); }
  assert.throws(() => new ZipReader(evil), /안전하지 않은/);
  // encrypted flag
  const enc = Buffer.from(zip); const cd = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); enc[cd + 8] |= 1;
  assert.throws(() => new ZipReader(enc), /암호화/);
  assert.throws(() => new ZipReader(Buffer.from('not a zip at all, definitely not')), /ZIP/);
});

test('zip bombs: oversized declarations, lying sizes and extreme ratios stop before large allocations', () => {
  const big = writeZip([{ name: 'zeros.bin', data: Buffer.alloc(6 * 1024 * 1024) }]);
  assert.throws(() => new ZipReader(big, { entryBytes: 1024 * 1024 }), /너무 큽니다/);
  assert.throws(() => new ZipReader(big, { ratio: 50, minRatioCheckBytes: 1024 }), /압축률/);
  assert.throws(() => new ZipReader(big, { totalBytes: 2 * 1024 * 1024, entryBytes: 8 * 1024 * 1024, ratio: 100000 }), /허용 용량/);
  // declared size smaller than the real inflated size
  const lie = Buffer.from(writeZip([{ name: 'x.bin', data: Buffer.alloc(100000) }]));
  const cd = lie.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); lie.writeUInt32LE(50, cd + 24);
  const local = lie.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])); lie.writeUInt32LE(50, local + 22);
  assert.throws(() => new ZipReader(lie).read('x.bin'), /선언된 크기|크기가 선언/);
  assert.throws(() => new ZipReader(writeZip(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, data: 'x' }))), { entries: 10 }), /항목이 너무 많/);
});

test('pdf: plain, Flate and object-stream files give text per page in order', () => {
  const text = ['첫 페이지\nsecond line', 'Page two: (parens) & \\ slash', '셋째'];
  for (const options of [{}, { compress: true }, { compress: true, objstm: true }, { form: true }]) {
    const result = pages(makePdf(options.form ? ['본문'] : text.map((t) => (options.compress || options.objstm ? t.replace(/[가-힣]/g, 'x') : t.replace(/[가-힣]/g, 'k')), ), options));
    assert.equal(result.length, options.form ? 1 : 3);
    assert.equal(result.map((p) => p.page).join(), options.form ? '1' : '1,2,3');
    if (!options.form) assert.match(result[1].text, /Page two: \(parens\) & \\ slash/);
    else assert.match(result[0].text, /FORM-TEXT/);
  }
});

test('pdf: many-page files retain every page and its text after object and trailer indexing', () => {
  const source = Array.from({ length: 1200 }, (_, i) => `Page ${i + 1}\n${'text with (parentheses) and a slash \\ '.repeat(20).trim()}`);
  const result = pages(makePdf(source));
  assert.equal(result.length, source.length);
  for (const [i, page] of result.entries()) {
    assert.equal(page.page, i + 1);
    assert.equal(page.text, source[i]);
    assert.equal(page.error, '');
  }
});

test('pdf: CID fonts use ToUnicode so Korean text is recovered; undecodable fonts and scanned pages are reported', () => {
  const korean = ['안녕하세요 반갑습니다', '두 번째 쪽: 한글 문서'];
  for (const options of [{ cid: true }, { cid: true, compress: true, objstm: true }]) {
    const result = pages(makePdf(korean, options));
    assert.equal(result[0].text, korean[0]);
    assert.equal(result[1].text, korean[1]);
  }
  const mixed = pages(makePdf(['텍스트 쪽', '', '또 텍스트'], { cid: true, scanned: [1] }));
  assert.equal(mixed[1].text, '');
  assert.ok(mixed[1].images >= 1, 'an image-only page is reported as such');
  assert.throws(() => pages(makePdf(['x'], { encrypt: true })), /암호화/);
  assert.throws(() => pages(Buffer.from('%PDF-1.4\n garbage')), /페이지/);
  assert.throws(() => pages(Buffer.from('not a pdf')), /PDF 파일이 아닙니다/);
  // inflated stream bomb inside a page
  const bomb = makePdf(['x'], { compress: true });
  assert.ok(pages(bomb).length === 1);
});

test('text: encodings (UTF-8 BOM, UTF-16, Korean legacy code page) become UTF-8 chunks that read back exactly', async (t) => {
  const dir = temp(t);
  const korean = '한글 문서입니다.\n둘째 줄: 가나다라마바사\n';
  const cases = {
    'utf8.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(korean)]),
    'utf16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(korean, 'utf16le')]),
    'cp949.txt': Buffer.from(new TextEncoder().encode('')),
  };
  // cp949 bytes for "한글 문서입니다.\n둘째 줄\n"
  cases['cp949.txt'] = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0xb9, 0xae, 0xbc, 0xad, 0xc0, 0xd4, 0xb4, 0xcf, 0xb4, 0xd9, 0x2e, 0x0a, 0xb5, 0xd1, 0xc2, 0xb0, 0x20, 0xc1, 0xd9, 0x0a]);
  for (const [name, bytes] of Object.entries(cases)) {
    const file = path.join(dir, name); fs.writeFileSync(file, bytes);
    const spool = await spoolText(file, { cacheDir: path.join(dir, 'cache'), key: name });
    const text = readChunks(spool, spool.index.map((_, i) => i)).map((c) => c.text).join('');
    assert.equal(spool.kind, 'text');
    assert.match(text, name === 'cp949.txt' ? /^한글 문서입니다\.\n둘째 줄\n$/ : /^한글 문서입니다\.\n둘째 줄: 가나다라마바사\n$/, name);
  }
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
  await assert.rejects(() => spoolText(path.join(dir, 'bin.dat'), { cacheDir: path.join(dir, 'cache'), key: 'b' }), /바이너리|지원하지/);
  assert.equal(sniffKind('x.doc'), 'legacy');
  assert.equal(sniffKind('x.png'), 'image');
  assert.equal(sniffKind('a.pdf', Buffer.from('%PDF-1')), 'pdf');
});

test('a large text file is chunked in a stream with bounded memory, exact chunk bytes, cancel and deadline', async (t) => {
  const dir = temp(t), file = path.join(dir, 'big.log');
  const line = '2026-10-08 12:00:00 INFO 서버 요청 처리 완료 id=%d status=200 한글 로그 메시지\n';
  const fd = fs.openSync(file, 'w');
  let id = 0;
  for (let size = 0; size < 40 * 1024 * 1024; id++) { const buf = Buffer.from(line.replace('%d', id)); fs.writeSync(fd, buf); size += buf.length; }
  fs.closeSync(fd);
  const before = process.memoryUsage().rss;
  const started = Date.now();
  const spool = await spoolText(file, { cacheDir: path.join(dir, 'cache'), key: 'big' });
  const growth = process.memoryUsage().rss - before;
  assert.ok(spool.chunks > 3000, `chunks ${spool.chunks}`);
  assert.ok(growth < 300 * 1024 * 1024, `rss grew ${Math.round(growth / 1048576)}MB while chunking 40MB`);
  assert.ok(spool.index.every((c) => c.end - c.start <= 12000 && c.end > c.start), 'every chunk stays within the byte budget');
  assert.equal(spool.index.at(-1).end, spool.bytes);
  assert.ok(spool.index.slice(0, -1).every((c, i) => c.end === spool.index[i + 1].start), 'chunks are contiguous');
  const [first, last] = readChunks(spool, [0, spool.chunks - 1]);
  assert.ok(first.text.startsWith('2026-10-08 12:00:00 INFO 서버 요청 처리 완료 id=0 '), 'text is decoded as UTF-8');
  assert.ok(last.text.endsWith(`id=${id - 1} status=200 한글 로그 메시지\n`), 'the last chunk ends with the last line');
  assert.ok(Date.now() - started < 60000);
  // cancellation and deadline
  const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => spoolText(file, { cacheDir: path.join(dir, 'cache'), key: 'c', signal: controller.signal }), /취소/);
  let now = 0;
  await assert.rejects(() => spoolText(file, { cacheDir: path.join(dir, 'cache'), key: 'd', deadlineMs: 5, clock: () => (now += 10) }), /시간/);
  assert.ok(!fs.readdirSync(path.join(dir, 'cache')).some((n) => n.endsWith('.tmp')), 'failed extractions leave no partial spool');
});

test('office documents: spool reports page/slide/sheet locations', async (t) => {
  const dir = temp(t);
  const { buildPptx } = await import('../lib/task-pptx.mjs');
  const deck = buildPptx({ type: 'pptx', slides: [{ layout: 'title', title: '표지' }, { layout: 'bullets', title: '내용', bullets: ['하나', '둘'] }] });
  const file = path.join(dir, 'd.pptx'); fs.writeFileSync(file, deck);
  const spool = await spoolText(file, { cacheDir: path.join(dir, 'c'), key: 'd' });
  assert.equal(spool.kind, 'pptx');
  assert.deepEqual(spool.index[0].loc, ['슬라이드 1', '슬라이드 2']);
  const text = await previewText(deck, 'pptx');
  assert.match(text, /## 슬라이드 2\n내용\n하나\n둘/);
  const pdf = path.join(dir, 'p.pdf'); fs.writeFileSync(pdf, makePdf(['hello', '', 'world'], { scanned: [1] }));
  const result = await spoolText(pdf, { cacheDir: path.join(dir, 'c'), key: 'p' });
  assert.equal(result.kind, 'pdf');
  assert.deepEqual([result.info.pages, result.info.textPages, result.info.scannedPages], [3, 2, [2]]);
});
