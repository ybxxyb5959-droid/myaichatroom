import zlib from 'node:zlib';

// Hand-built PDFs for parser tests: plain/Flate streams, object streams, CID fonts with ToUnicode, image-only pages, encryption marker.
const lit = (s) => `(${s.replace(/[\\()]/g, '\\$&')})`;
export function makePdf(pages, { compress = false, objstm = false, cid = false, scanned = [], encrypt = false, form = false } = {}) {
  const objects = []; // {num, body, stream?}
  const add = (body, stream) => { objects.push({ num: objects.length + 1, body, stream }); return objects.length; };
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesNum = add('PAGES');
  const code = new Map(); // CID codes for the 2-byte font
  const codeOf = (ch) => { if (!code.has(ch)) code.set(ch, code.size + 1); return code.get(ch); };
  const encodeText = (t) => (cid ? `<${[...t].map((ch) => codeOf(ch).toString(16).padStart(4, '0')).join('')}>` : lit(t));
  const streams = pages.map((text, i) => {
    if (scanned.includes(i)) return 'q 400 0 0 400 100 100 cm /Im1 Do Q';
    const lines = String(text).split('\n');
    const ops = lines.map((line, k) => `BT /F1 12 Tf 72 ${720 - k * 16} Td ${cid ? `[${encodeText(line)}] TJ` : `${encodeText(line)} Tj`} ET`).join('\n');
    return form ? `/Fm1 Do\n${ops}` : ops;
  });
  const fontNum = objects.length + 1;
  let toUni = 0, fontBody;
  const pageCount = pages.length;
  // fonts are added after the codes are known (content built first)
  const imageNum = scanned.length ? 0 : 0;
  void imageNum;
  const contentNums = streams.map((s) => { const raw = Buffer.from(s, 'latin1'); const data = compress ? zlib.deflateSync(raw) : raw; return add(`<< /Length ${data.length}${compress ? ' /Filter /FlateDecode' : ''} >>`, data); });
  if (cid) {
    const map = [...code].map(([ch, c]) => `<${c.toString(16).padStart(4, '0')}> <${[...ch].map((x) => x.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`).join('\n');
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n${code.size} beginbfchar\n${map}\nendbfchar\nendcmap end end`;
    const raw = Buffer.from(cmap, 'latin1'); const data = compress ? zlib.deflateSync(raw) : raw;
    toUni = add(`<< /Length ${data.length}${compress ? ' /Filter /FlateDecode' : ''} >>`, data);
    const desc = add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>');
    fontBody = `<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [${desc} 0 R] /ToUnicode ${toUni} 0 R >>`;
  } else fontBody = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const font = add(fontBody);
  void fontNum;
  let image = 0, formNum = 0;
  if (scanned.length) image = add('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>', Buffer.from([128]));
  if (form) { const raw = Buffer.from('BT /F1 12 Tf 72 780 Td (FORM-TEXT) Tj ET', 'latin1'); formNum = add(`<< /Type /XObject /Subtype /Form /BBox [0 0 600 800] /Resources << /Font << /F1 ${font} 0 R >> >> /Length ${raw.length} >>`, raw); }
  const pageNums = pages.map((_, i) => add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNums[i]} 0 R /Resources << /Font << /F1 ${font} 0 R >>${scanned.includes(i) ? ` /XObject << /Im1 ${image} 0 R >>` : ''}${form ? ` /XObject << /Fm1 ${formNum} 0 R >>` : ''} >> >>`));
  objects[pagesNum - 1].body = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const emit = (o) => chunks.push(Buffer.from(`${o.num} 0 obj\n${o.body}\n`, 'latin1'), ...(o.stream ? [Buffer.from('stream\n'), o.stream, Buffer.from('\nendstream\n')] : []), Buffer.from('endobj\n'));
  if (objstm) {
    // everything that is not a stream moves into one compressed object stream
    const inside = objects.filter((o) => !o.stream);
    let offsets = '', body = '';
    for (const o of inside) { offsets += `${o.num} ${body.length} `; body += `${o.body}\n`; }
    const raw = Buffer.from(offsets + body, 'latin1'); const data = zlib.deflateSync(raw);
    const stmNum = objects.length + 1;
    for (const o of objects.filter((x) => x.stream)) emit(o);
    emit({ num: stmNum, body: `<< /Type /ObjStm /N ${inside.length} /First ${offsets.length} /Length ${data.length} /Filter /FlateDecode >>`, stream: data });
    chunks.push(Buffer.from(`trailer\n<< /Root ${catalog} 0 R /Size ${stmNum + 1}${encrypt ? ' /Encrypt 99 0 R' : ''} >>\n%%EOF\n`));
  } else {
    for (const o of objects) emit(o);
    chunks.push(Buffer.from(`trailer\n<< /Root ${catalog} 0 R /Size ${objects.length + 1}${encrypt ? ' /Encrypt 99 0 R' : ''} >>\n%%EOF\n`));
  }
  return Buffer.concat(chunks);
}
