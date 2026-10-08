import { ZipReader, writeZip } from './task-zip.mjs';
import { fail, LIMITS, esc, clean, XML, NS_R, contentTypes, rels, coreProps, appProps, str, list, obj, onlyKeys, loadImage, colorHex } from './task-office-common.mjs';

// Word documents from a validated JSON spec, and careful edits of existing .docx files.
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NS = `${W} xmlns:r="${NS_R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
const TEXT_WIDTH_TWIPS = 9026, MAX_PX = 600;
const BLOCK_TYPES = ['title', 'heading', 'paragraph', 'bullets', 'numbered', 'table', 'image', 'pagebreak'];

function runXml(run) {
  const props = `${run.bold ? '<w:b/>' : ''}${run.italic ? '<w:i/>' : ''}${run.underline ? '<w:u w:val="single"/>' : ''}${run.color ? `<w:color w:val="${colorHex(run.color)}"/>` : ''}${run.size ? `<w:sz w:val="${Math.round(run.size * 2)}"/>` : ''}`;
  const parts = clean(run.text).split('\n');
  const body = parts.map((t, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t>`).join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${body}</w:r>`;
}
const jc = (align) => (align && ['left', 'center', 'right', 'justify'].includes(align) ? `<w:jc w:val="${align === 'justify' ? 'both' : align}"/>` : '');

function validateBlock(block, index, ctx) {
  const what = `blocks[${index}]`;
  obj(block, what);
  if (!BLOCK_TYPES.includes(block.type)) fail(`${what}: 지원하지 않는 블록 종류입니다(${block.type}). 사용 가능: ${BLOCK_TYPES.join(', ')}`);
  if (block.type === 'title') { onlyKeys(block, ['type', 'text'], what); str(block.text, 500, `${what}.text`); }
  else if (block.type === 'heading') {
    onlyKeys(block, ['type', 'level', 'text'], what); str(block.text, 500, `${what}.text`);
    if (![1, 2, 3].includes(block.level)) fail(`${what}.level은 1~3이어야 합니다.`);
  } else if (block.type === 'paragraph') {
    onlyKeys(block, ['type', 'text', 'runs', 'align'], what);
    if ((block.text === undefined) === (block.runs === undefined)) fail(`${what}: text 또는 runs 중 하나만 지정하세요.`);
    if (block.text !== undefined) str(block.text, LIMITS.text, `${what}.text`);
    else for (const [i, run] of list(block.runs, 200, `${what}.runs`).entries()) {
      obj(run, `${what}.runs[${i}]`); onlyKeys(run, ['text', 'bold', 'italic', 'underline', 'color', 'size'], `${what}.runs[${i}]`); str(run.text, LIMITS.text, `${what}.runs[${i}].text`);
      if (run.size !== undefined && !(run.size >= 6 && run.size <= 72)) fail(`${what}.runs[${i}].size는 6~72(pt)여야 합니다.`);
    }
  } else if (block.type === 'bullets' || block.type === 'numbered') {
    onlyKeys(block, ['type', 'items'], what);
    for (const [i, item] of list(block.items, LIMITS.items, `${what}.items`).entries()) str(item, 2000, `${what}.items[${i}]`);
    if (!block.items.length) fail(`${what}: 항목이 비었습니다.`);
  } else if (block.type === 'table') {
    onlyKeys(block, ['type', 'header', 'rows', 'widths'], what);
    const rows = list(block.rows, 5000, `${what}.rows`);
    if (block.header !== undefined) for (const [i, h] of list(block.header, LIMITS.cols, `${what}.header`).entries()) str(h, 1000, `${what}.header[${i}]`);
    for (const [r, row] of rows.entries()) for (const [c, cell] of list(row, LIMITS.cols, `${what}.rows[${r}]`).entries()) if (typeof cell !== 'string' && typeof cell !== 'number') fail(`${what}.rows[${r}][${c}]: 문자열 또는 숫자여야 합니다.`);
    if (!rows.length && !block.header) fail(`${what}: 표가 비었습니다.`);
    if (block.widths !== undefined) for (const w of list(block.widths, LIMITS.cols, `${what}.widths`)) if (!(w > 0)) fail(`${what}.widths는 양수여야 합니다.`);
  } else if (block.type === 'image') {
    onlyKeys(block, ['type', 'source', 'alt', 'width', 'caption'], what);
    str(block.source, 500, `${what}.source`);
    if (block.alt !== undefined) str(block.alt, 500, `${what}.alt`);
    if (block.caption !== undefined) str(block.caption, 500, `${what}.caption`);
    if (block.width !== undefined && !(block.width >= 40 && block.width <= MAX_PX)) fail(`${what}.width는 40~${MAX_PX}(px)여야 합니다.`);
    ctx.images++;
    if (ctx.images > LIMITS.images) fail('문서에 넣을 수 있는 이미지는 최대 60개입니다.');
  } else onlyKeys(block, ['type'], what);
}
export function validateDocx(spec) {
  obj(spec, 'document'); onlyKeys(spec, ['type', 'title', 'blocks'], 'document');
  if (spec.title !== undefined) str(spec.title, 300, 'title');
  const blocks = list(spec.blocks, LIMITS.blocks, 'blocks');
  if (!blocks.length) fail('문서에 내용이 없습니다.');
  const ctx = { images: 0 };
  blocks.forEach((b, i) => validateBlock(b, i, ctx));
  return spec;
}

// state: {images: [{rid, name, bytes, ext}], nextId, numbers: [numId...], resolveImage, noNumbering}
function blockXml(block, state) {
  switch (block.type) {
    case 'title': return `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${runXml({ text: block.text })}</w:p>`;
    case 'heading': return `<w:p><w:pPr><w:pStyle w:val="Heading${block.level}"/></w:pPr>${runXml({ text: block.text })}</w:p>`;
    case 'paragraph': return `<w:p><w:pPr>${jc(block.align)}</w:pPr>${(block.runs || [{ text: block.text }]).map(runXml).join('')}</w:p>`;
    case 'pagebreak': return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    case 'bullets': return block.items.map((t) => (state.noNumbering
      ? `<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>${runXml({ text: `• ${t}` })}</w:p>`
      : `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${runXml({ text: t })}</w:p>`)).join('');
    case 'numbered': {
      if (state.noNumbering) return block.items.map((t, i) => `<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>${runXml({ text: `${i + 1}. ${t}` })}</w:p>`).join('');
      const numId = 2 + state.numbers.length; state.numbers.push(numId);
      return block.items.map((t) => `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${runXml({ text: t })}</w:p>`).join('');
    }
    case 'table': {
      const cols = Math.max(block.header?.length || 0, ...block.rows.map((r) => r.length), 1);
      const total = block.widths ? block.widths.slice(0, cols).reduce((a, b) => a + b, 0) : 0;
      const widths = Array.from({ length: cols }, (_, i) => Math.floor(TEXT_WIDTH_TWIPS * (block.widths && block.widths[i] ? block.widths[i] / total : 1 / cols)));
      const cell = (text, w, header) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' : ''}</w:tcPr><w:p>${runXml({ text: String(text ?? ''), bold: header })}</w:p></w:tc>`;
      const row = (cells, header) => `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: cols }, (_, i) => cell(cells[i] ?? '', widths[i], header)).join('')}</w:tr>`;
      return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${TEXT_WIDTH_TWIPS}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${block.header ? row(block.header, true) : ''}${block.rows.map((r) => row(r, false)).join('')}</w:tbl><w:p/>`;
    }
    case 'image': {
      const image = loadImage(block.source, state.resolveImage, `이미지 ${block.source}`);
      const px = Math.min(block.width || Math.min(image.width, MAX_PX), MAX_PX);
      const cx = Math.round(px * 9525), cy = Math.round((px * image.height / image.width) * 9525);
      const id = state.nextId++, rid = `rIdImg${id}`, name = `image${id}.${image.ext === 'jpeg' ? 'jpg' : image.ext}`;
      state.images.push({ rid, name, bytes: image.bytes, ext: image.ext });
      const alt = esc(block.alt || block.caption || '');
      const drawing = `<w:p><w:pPr><w:keepNext/>${jc('center')}</w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
      return drawing + (block.caption ? `<w:p><w:pPr><w:pStyle w:val="Caption"/>${jc('center')}</w:pPr>${runXml({ text: block.caption })}</w:p>` : '');
    }
    default: return '';
  }
}

const styles = () => `${XML}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>'
  + [1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${360 - n * 60}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="${36 - n * 4}"/><w:szCs w:val="${36 - n * 4}"/></w:rPr></w:style>`).join('')
  + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:i/><w:color w:val="595959"/><w:sz w:val="18"/></w:rPr></w:style>'
  + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`).join('') + '</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>';

const numbering = (numbers) => `${XML}<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr></w:lvl></w:abstractNum>`
  + '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
  + numbers.map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join('') + '</w:numbering>';

export function buildDocx(spec, { resolveImage } = {}) {
  validateDocx(spec);
  const state = { images: [], nextId: 1, numbers: [], resolveImage };
  const body = spec.blocks.map((b) => blockXml(b, state)).join('');
  const document = `${XML}<w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const imgExt = {}; for (const i of state.images) imgExt[i.ext === 'jpeg' ? 'jpg' : i.ext] = i.ext === 'png' ? 'image/png' : i.ext === 'gif' ? 'image/gif' : 'image/jpeg';
  const files = [
    { name: '[Content_Types].xml', data: contentTypes({ rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml', ...imgExt }, {
      '/word/document.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      '/word/styles.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
      '/word/numbering.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
      '/docProps/core.xml': 'application/vnd.openxmlformats-package.core-properties+xml',
      '/docProps/app.xml': 'application/vnd.openxmlformats-officedocument.extended-properties+xml' }) },
    { name: '_rels/.rels', data: rels([{ id: 'rId1', type: 'officeDocument', target: 'word/document.xml' },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
      { id: 'rId3', type: 'extended-properties', target: 'docProps/app.xml' }]) },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles() },
    { name: 'word/numbering.xml', data: numbering(state.numbers) },
    { name: 'word/_rels/document.xml.rels', data: rels([{ id: 'rId1', type: 'styles', target: 'styles.xml' }, { id: 'rId2', type: 'numbering', target: 'numbering.xml' },
      ...state.images.map((i) => ({ id: i.rid, type: 'image', target: `media/${i.name}` }))]) },
    { name: 'docProps/core.xml', data: coreProps(spec.title || spec.blocks.find((b) => b.type === 'title' || b.type === 'heading')?.text || '문서') },
    { name: 'docProps/app.xml', data: appProps('AI 작업대') },
    ...state.images.map((i) => ({ name: `word/media/${i.name}`, data: i.bytes, store: true })),
  ];
  return writeZip(files);
}

// ---- editing ----
const RISKY = /<w:txbxContent|<w:sdt[ >]|<w:ins[ >]|<w:del[ >]|<w:moveFrom|<w:moveTo|<w:fldChar|<w:fldSimple|<w:hyperlink/;
const PARAGRAPH = /<w:p(?:\s[^>]*)?>(?:(?!<w:p[ >])[\s\S])*?<\/w:p>/g;
const T_NODE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
const unesc = (s) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]));
const paragraphPlain = (p) => [...p.matchAll(T_NODE)].map((m) => unesc(m[1])).join('');

function replaceInParagraph(p, find, replacement, all) {
  const nodes = [...p.matchAll(T_NODE)].map((m) => ({ index: m.index, length: m[0].length, open: m[0].slice(0, m[0].indexOf('>') + 1), text: unesc(m[1]) }));
  if (!nodes.length) return { xml: p, count: 0 };
  const texts = nodes.map((n) => n.text);
  let full = texts.join(''), count = 0, from = 0;
  const starts = []; { let acc = 0; for (const t of texts) { starts.push(acc); acc += t.length; } }
  for (;;) {
    const at = full.indexOf(find, from);
    if (at < 0) break;
    const end = at + find.length;
    const first = starts.findLastIndex((s) => s <= at), last = starts.findLastIndex((s) => s < end);
    // First run keeps its formatting and receives the replacement; the other runs lose only the replaced characters.
    const before = texts[first].slice(0, at - starts[first]);
    const after = texts[last].slice(end - starts[last]);
    if (first === last) texts[first] = before + replacement + after;
    else { texts[first] = before + replacement; for (let i = first + 1; i < last; i++) texts[i] = ''; texts[last] = after; }
    count++;
    full = texts.join(''); starts.length = 0; { let acc = 0; for (const t of texts) { starts.push(acc); acc += t.length; } }
    from = at + replacement.length;
    if (!all) break;
  }
  if (!count) return { xml: p, count: 0 };
  let out = '', cursor = 0;
  nodes.forEach((n, i) => {
    out += p.slice(cursor, n.index) + `<w:t xml:space="preserve">${esc(texts[i])}</w:t>`;
    cursor = n.index + n.length;
  });
  return { xml: out + p.slice(cursor), count };
}

export function validateDocxEdit(edit) {
  obj(edit, 'edit'); onlyKeys(edit, ['type', 'replace', 'append', 'insertAfter'], 'edit');
  if (edit.replace !== undefined) for (const [i, r] of list(edit.replace, 200, 'replace').entries()) {
    obj(r, `replace[${i}]`); onlyKeys(r, ['find', 'replace', 'all'], `replace[${i}]`);
    if (!str(r.find, 2000, `replace[${i}].find`)) fail(`replace[${i}].find가 비었습니다.`);
    str(r.replace, 20000, `replace[${i}].replace`);
  }
  if (edit.append !== undefined) { const ctx = { images: 0 }; list(edit.append, LIMITS.blocks, 'append').forEach((b, i) => validateBlock(b, i, ctx)); }
  if (edit.insertAfter !== undefined) for (const [i, ins] of list(edit.insertAfter, 100, 'insertAfter').entries()) {
    obj(ins, `insertAfter[${i}]`); onlyKeys(ins, ['containing', 'blocks'], `insertAfter[${i}]`); str(ins.containing, 2000, `insertAfter[${i}].containing`);
    const ctx = { images: 0 }; list(ins.blocks, LIMITS.blocks, `insertAfter[${i}].blocks`).forEach((b, k) => validateBlock(b, k, ctx));
  }
  if (!edit.replace?.length && !edit.append?.length && !edit.insertAfter?.length) fail('수정 내용이 비었습니다.');
  return edit;
}

// Only word/document.xml (plus new image parts) is rewritten; every other part is copied as it is.
export function editDocx(bytes, edit, { resolveImage } = {}) {
  validateDocxEdit(edit);
  const zip = new ZipReader(bytes);
  try {
    if (!zip.has('word/document.xml')) fail('올바른 DOCX 문서가 아닙니다.');
    let xml = zip.text('word/document.xml', { maxBytes: 64 * 1024 * 1024 });
    const wantsText = edit.replace?.length || edit.insertAfter?.length;
    if (wantsText && /<w:txbxContent/.test(xml)) fail('이 문서에는 텍스트 상자가 있어 본문 찾아 바꾸기·중간 삽입을 안전하게 할 수 없습니다. 문서 끝에 추가만 가능합니다.');
    const hasNumbering = zip.has('word/numbering.xml');
    const state = { images: [], nextId: 1000 + Math.floor(Math.random() * 1000), numbers: [], resolveImage, noNumbering: true };
    for (const r of edit.replace || []) {
      let total = 0, risky = 0;
      xml = xml.replace(PARAGRAPH, (p) => {
        if (!paragraphPlain(p).includes(r.find)) return p;
        if (RISKY.test(p)) { risky++; return p; }
        const result = replaceInParagraph(p, r.find, r.replace, true);
        total += result.count; return result.xml;
      });
      if (!total) fail(risky ? `"${r.find}"는 변경 추적·필드·하이퍼링크 등이 있는 문단에만 있어 안전하게 바꿀 수 없습니다.` : `"${r.find}"를 문서에서 찾지 못했습니다(서식이 여러 조각으로 나뉘어 있어도 찾지만 글자는 정확히 같아야 합니다).`);
    }
    for (const ins of edit.insertAfter || []) {
      let done = false;
      xml = xml.replace(PARAGRAPH, (p) => {
        if (done || !paragraphPlain(p).includes(ins.containing) || RISKY.test(p)) return p;
        done = true; return p + ins.blocks.map((b) => blockXml(b, state)).join('');
      });
      if (!done) fail(`"${ins.containing}"가 있는 문단을 찾지 못했습니다.`);
    }
    if (edit.append?.length) {
      const add = edit.append.map((b) => blockXml(b, state)).join('');
      const at = xml.lastIndexOf('<w:sectPr');
      const close = xml.lastIndexOf('</w:body>');
      if (close < 0) fail('문서 본문을 찾지 못했습니다.');
      // The body-level sectPr (page setup) must stay last; a paragraph-level one is followed by more content.
      const sectEnd = at >= 0 ? xml.indexOf('</w:sectPr>', at) : -1;
      const point = sectEnd >= 0 && sectEnd < close && xml.slice(sectEnd + 11, close).trim() === '' ? at : close;
      xml = xml.slice(0, point) + add + xml.slice(point);
    }
    void hasNumbering;
    const files = [];
    let relsXml = zip.has('word/_rels/document.xml.rels') ? zip.text('word/_rels/document.xml.rels') : null;
    let types = zip.text('[Content_Types].xml');
    if (state.images.length) {
      if (relsXml === null) fail('문서의 관계 파일이 없어 이미지를 추가할 수 없습니다.');
      relsXml = relsXml.replace('</Relationships>', state.images.map((i) => `<Relationship Id="${i.rid}" Type="${NS_R}/image" Target="media/${i.name}"/>`).join('') + '</Relationships>');
      for (const ext of new Set(state.images.map((i) => (i.ext === 'jpeg' ? 'jpg' : i.ext)))) {
        if (!new RegExp(`<Default[^>]*Extension="${ext}"`, 'i').test(types)) types = types.replace('</Types>', `<Default Extension="${ext}" ContentType="${ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg'}"/></Types>`);
      }
    }
    for (const entry of zip.entries) {
      if (entry.dir) continue;
      const replacement = { 'word/document.xml': xml, 'word/_rels/document.xml.rels': relsXml, '[Content_Types].xml': types }[entry.name];
      files.push({ name: entry.name, data: replacement !== undefined && replacement !== null ? replacement : zip.read(entry.name), ...(entry.method === 0 ? { store: true } : {}) });
    }
    for (const i of state.images) files.push({ name: `word/media/${i.name}`, data: i.bytes, store: true });
    return writeZip(files);
  } finally { zip.close(); }
}
