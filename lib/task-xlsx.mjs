import { ZipReader, writeZip } from './task-zip.mjs';
import { fail, LIMITS, esc, clean, XML, NS_R, contentTypes, rels, coreProps, appProps, str, list, obj, onlyKeys, colName, colIndex } from './task-office-common.mjs';

// Excel workbooks from a validated JSON spec, and careful cell/sheet edits of existing .xlsx files.
const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_R}"`;
const FORMATS = ['text', 'integer', 'decimal', 'percent', 'currency', 'date'];
const FORBIDDEN_FORMULA = /\[\d+\]|\[[^\]]*\.(?:xls\w*|xla\w*)\]|\b(?:HYPERLINK|WEBSERVICE|FILTERXML|CALL|REGISTER\.ID|EXEC|DDE|RTD|SQL\.REQUEST|INFO|IMPORTXML|IMPORTDATA|IMPORTRANGE)\s*\(|file:|https?:|\\\\|[A-Za-z]:\\/i;

const validName = (name) => typeof name === 'string' && name.length >= 1 && name.length <= LIMITS.nameChars && !/[\[\]:*?/\\]/.test(name) && !/^'|'$/.test(name);
function checkFormula(formula, what) {
  const f = String(formula).replace(/^=/, '');
  if (!f.trim() || f.length > 8000 || /[\u0000-\u001f]/.test(f)) fail(`${what}: 수식이 올바르지 않습니다.`);
  if (FORBIDDEN_FORMULA.test(f)) fail(`${what}: 외부 파일·웹 접근이나 위험한 함수가 포함된 수식은 사용할 수 없습니다.`);
  return f;
}
function dateSerial(value, what) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) fail(`${what}: 날짜는 YYYY-MM-DD 형식이어야 합니다.`);
  const serial = (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
  if (!Number.isFinite(serial)) fail(`${what}: 올바른 날짜가 아닙니다.`);
  return serial;
}
function checkCell(cell, what) {
  if (cell === null || cell === undefined || typeof cell === 'boolean') return;
  if (typeof cell === 'number') { if (!Number.isFinite(cell)) fail(`${what}: 숫자가 올바르지 않습니다.`); return; }
  if (typeof cell === 'string') { str(cell, LIMITS.cellChars, what); return; }
  obj(cell, what); onlyKeys(cell, ['formula', 'date', 'value', 'format'], what);
  if (cell.formula !== undefined) checkFormula(cell.formula, what);
  else if (cell.date !== undefined) dateSerial(cell.date, what);
  else fail(`${what}: formula 또는 date가 필요합니다.`);
  if (cell.format !== undefined && !FORMATS.includes(cell.format)) fail(`${what}.format은 ${FORMATS.join('/')} 중 하나여야 합니다.`);
}
export function validateSheet(sheet, index, names) {
  const what = `sheets[${index}]`;
  obj(sheet, what); onlyKeys(sheet, ['name', 'columns', 'rows', 'freezeHeader', 'autoFilter', 'table'], what);
  if (!validName(sheet.name)) fail(`${what}.name: 1~31자이며 []:*?/\\ 문자를 쓸 수 없습니다.`);
  if (names.has(sheet.name.toLowerCase())) fail(`${what}.name: 시트 이름이 중복됩니다(${sheet.name}).`);
  names.add(sheet.name.toLowerCase());
  const rows = list(sheet.rows ?? [], LIMITS.rows, `${what}.rows`);
  if (sheet.columns !== undefined) for (const [i, c] of list(sheet.columns, LIMITS.cols, `${what}.columns`).entries()) {
    obj(c, `${what}.columns[${i}]`); onlyKeys(c, ['header', 'width', 'format'], `${what}.columns[${i}]`); str(c.header, 255, `${what}.columns[${i}].header`);
    if (c.width !== undefined && !(c.width >= 4 && c.width <= 100)) fail(`${what}.columns[${i}].width는 4~100이어야 합니다.`);
    if (c.format !== undefined && !FORMATS.includes(c.format)) fail(`${what}.columns[${i}].format은 ${FORMATS.join('/')} 중 하나여야 합니다.`);
  }
  for (const [r, row] of rows.entries()) for (const [c, cell] of list(row, LIMITS.cols, `${what}.rows[${r}]`).entries()) checkCell(cell, `${what}.rows[${r}][${c}]`);
  if (!sheet.columns && !rows.length) fail(`${what}: 내용이 없습니다.`);
  return sheet;
}
export function validateXlsx(spec) {
  obj(spec, 'workbook'); onlyKeys(spec, ['type', 'sheets'], 'workbook');
  const sheets = list(spec.sheets, LIMITS.sheets, 'sheets');
  if (!sheets.length) fail('시트가 없습니다.');
  const names = new Set();
  sheets.forEach((s, i) => validateSheet(s, i, names));
  return spec;
}

// styles: xf indexes by role (fixed for new workbooks, appended for existing ones)
const FORMAT_ROLE = { text: 'text', integer: 'integer', decimal: 'decimal', percent: 'percent', currency: 'currency', date: 'date' };
function sheetXml(sheet, xf, { table = null, selected = false } = {}) {
  const columns = sheet.columns || [];
  const body = [];
  if (columns.length) body.push(columns.map((c) => c.header));
  const width = Math.max(columns.length, ...((sheet.rows || []).map((r) => r.length)), 1);
  const rows = [...body, ...(sheet.rows || [])];
  const headerRow = columns.length ? 1 : 0;
  const out = rows.map((row, r) => {
    const cells = [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell === null || cell === undefined || cell === '') continue;
      const ref = `${colName(c + 1)}${r + 1}`;
      const role = r < headerRow ? 'header' : (typeof cell === 'object' && cell.format) || columns[c]?.format || 'text';
      const s = xf[FORMAT_ROLE[role] || role] ? ` s="${xf[FORMAT_ROLE[role] || role]}"` : '';
      if (typeof cell === 'number') cells.push(`<c r="${ref}"${s}><v>${cell}</v></c>`);
      else if (typeof cell === 'boolean') cells.push(`<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`);
      else if (typeof cell === 'string') cells.push(`<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`);
      else if (cell.formula !== undefined) cells.push(`<c r="${ref}"${s}><f>${esc(checkFormula(cell.formula, ref))}</f></c>`);
      else cells.push(`<c r="${ref}" s="${xf.date || 0}"><v>${dateSerial(cell.date, ref)}</v></c>`);
    }
    return cells.length ? `<row r="${r + 1}">${cells.join('')}</row>` : '';
  }).join('');
  const last = `${colName(width)}${Math.max(rows.length, 1)}`;
  const minWidth = { date: 13, currency: 14, integer: 11, decimal: 12, percent: 10, text: 8 };
  const autoWidth = (c, i) => {
    let longest = c.header.length * 2 + 2;
    for (const row of (sheet.rows || []).slice(0, 500)) { const cell = row[i]; const len = typeof cell === 'string' ? [...cell].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0) : 10; if (len > longest) longest = len; }
    return Math.min(60, Math.max(minWidth[c.format || 'text'], longest + 2));
  };
  const widths = columns.length ? columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || autoWidth(c, i)}" customWidth="1"/>`).join('') : '';
  const freeze = sheet.freezeHeader && headerRow ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>' : '';
  return `${XML}<worksheet ${NS}><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}>${freeze}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${widths ? `<cols>${widths}</cols>` : ''}<sheetData>${out}</sheetData>${sheet.autoFilter && headerRow && !table ? `<autoFilter ref="A1:${last}"/>` : ''}${table ? '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' : ''}</worksheet>`;
}
function tableXml(sheet, id) {
  const headers = sheet.columns.map((c) => c.header);
  const seen = new Map();
  const cols = headers.map((h, i) => { const base = h.trim() || `열${i + 1}`; const n = (seen.get(base.toLowerCase()) || 0) + 1; seen.set(base.toLowerCase(), n); return n > 1 ? `${base}_${n}` : base; });
  const last = `${colName(cols.length)}${Math.max((sheet.rows || []).length + 1, 2)}`;
  return `${XML}<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${id}" name="Table${id}" displayName="Table${id}" ref="A1:${last}" totalsRowShown="0"><autoFilter ref="A1:${last}"/><tableColumns count="${cols.length}">${cols.map((c, i) => `<tableColumn id="${i + 1}" name="${esc(c)}"/>`).join('')}</tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`;
}
const NEW_XF = { header: 1, integer: 2, decimal: 3, percent: 4, date: 5, currency: 6 };
const stylesNew = () => `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="&quot;₩&quot;#,##0"/></numFmts>`
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

export function buildXlsx(spec) {
  validateXlsx(spec);
  const files = [], overrides = {}, wbRels = [], sheetRefs = [];
  let tableId = 0;
  spec.sheets.forEach((sheet, i) => {
    const n = i + 1, wantsTable = sheet.table && sheet.columns?.length;
    files.push({ name: `xl/worksheets/sheet${n}.xml`, data: sheetXml(sheet, NEW_XF, { table: wantsTable, selected: i === 0 }) });
    overrides[`/xl/worksheets/sheet${n}.xml`] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
    wbRels.push({ id: `rId${n}`, type: 'worksheet', target: `worksheets/sheet${n}.xml` });
    sheetRefs.push(`<sheet name="${esc(sheet.name)}" sheetId="${n}" r:id="rId${n}"/>`);
    if (wantsTable) {
      tableId++;
      files.push({ name: `xl/tables/table${tableId}.xml`, data: tableXml(sheet, tableId) });
      files.push({ name: `xl/worksheets/_rels/sheet${n}.xml.rels`, data: rels([{ id: 'rId1', type: 'table', target: `../tables/table${tableId}.xml` }]) });
      overrides[`/xl/tables/table${tableId}.xml`] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml';
    }
  });
  const count = spec.sheets.length;
  wbRels.push({ id: `rId${count + 1}`, type: 'styles', target: 'styles.xml' });
  return writeZip([
    { name: '[Content_Types].xml', data: contentTypes({ rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml' }, { '/xl/workbook.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
      '/xl/styles.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml', '/docProps/core.xml': 'application/vnd.openxmlformats-package.core-properties+xml', '/docProps/app.xml': 'application/vnd.openxmlformats-officedocument.extended-properties+xml', ...overrides }) },
    { name: '_rels/.rels', data: rels([{ id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' }, { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' }, { id: 'rId3', type: 'extended-properties', target: 'docProps/app.xml' }]) },
    { name: 'xl/workbook.xml', data: `${XML}<workbook ${NS}><bookViews><workbookView/></bookViews><sheets>${sheetRefs.join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: rels(wbRels) },
    { name: 'xl/styles.xml', data: stylesNew() },
    ...files,
    { name: 'docProps/core.xml', data: coreProps(spec.sheets[0].name) },
    { name: 'docProps/app.xml', data: appProps('AI 작업대') },
  ]);
}

// ---- editing existing workbooks ----
const ref = (value) => { const m = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value || ''); if (!m || colIndex(m[1]) > 16384 || Number(m[2]) > 1048576) return null; return { col: colIndex(m[1]), row: Number(m[2]), text: value }; };
export function validateXlsxEdit(edit) {
  obj(edit, 'edit'); onlyKeys(edit, ['type', 'setCells', 'addSheets'], 'edit');
  if (edit.setCells !== undefined) for (const [i, c] of list(edit.setCells, 5000, 'setCells').entries()) {
    obj(c, `setCells[${i}]`); onlyKeys(c, ['sheet', 'ref', 'value', 'formula', 'date'], `setCells[${i}]`);
    str(c.sheet, 100, `setCells[${i}].sheet`);
    if (!ref(c.ref)) fail(`setCells[${i}].ref는 A1 형식이어야 합니다.`);
    const value = c.formula !== undefined ? { formula: c.formula } : c.date !== undefined ? { date: c.date } : c.value;
    if (value === undefined) fail(`setCells[${i}]: value, formula, date 중 하나가 필요합니다.`);
    checkCell(value, `setCells[${i}]`);
  }
  if (edit.addSheets !== undefined) { const names = new Set(); list(edit.addSheets, LIMITS.sheets, 'addSheets').forEach((s, i) => validateSheet(s, i, names)); }
  if (!edit.setCells?.length && !edit.addSheets?.length) fail('수정 내용이 비었습니다.');
  return edit;
}

function cellXml(rf, value, format, style) {
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'number') return `<c r="${rf}"${s}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${rf}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (value === null || value === '') return `<c r="${rf}"${s}/>`;
  if (typeof value === 'string') return `<c r="${rf}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  if (value.formula !== undefined) return `<c r="${rf}"${s}><f>${esc(checkFormula(value.formula, rf))}</f></c>`;
  return `<c r="${rf}"${s}><v>${dateSerial(value.date, rf)}</v></c>`;
}

function sheetFiles(zip) {
  const wb = zip.text('xl/workbook.xml');
  const relsXml = zip.has('xl/_rels/workbook.xml.rels') ? zip.text('xl/_rels/workbook.xml.rels') : '';
  const target = new Map([...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
  return [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m, i) => {
    const name = /name="([^"]*)"/.exec(m[0])?.[1] ?? `Sheet${i + 1}`, rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    let t = target.get(rid) || `worksheets/sheet${i + 1}.xml`; t = t.startsWith('/') ? t.slice(1) : `xl/${t}`;
    return { name: name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"), file: t };
  });
}

function setCellInSheet(xml, cell, style) {
  const target = ref(cell.ref);
  if (/<sheetProtection/.test(xml)) fail('보호된 시트는 수정하지 않습니다.');
  const value = cell.formula !== undefined ? { formula: cell.formula } : cell.date !== undefined ? { date: cell.date } : cell.value;
  const sdOpen = xml.indexOf('<sheetData');
  if (sdOpen < 0) fail('시트 데이터를 찾지 못했습니다.');
  let selfClosed = /<sheetData\s*\/>/.exec(xml);
  if (selfClosed) xml = xml.replace(selfClosed[0], '<sheetData></sheetData>');
  const sdStart = xml.indexOf('>', xml.indexOf('<sheetData')) + 1, sdEnd = xml.indexOf('</sheetData>');
  let data = xml.slice(sdStart, sdEnd);
  const rowRe = new RegExp(`<row\\b[^>]*\\br="${target.row}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`);
  const existing = rowRe.exec(data);
  const make = (existingStyle) => cellXml(target.text, value, cell.format, style || existingStyle);
  if (existing) {
    let row = existing[0];
    if (row.endsWith('/>')) row = row.replace(/\s*\/>$/, '></row>');
    const cellRe = new RegExp(`<c\\b[^>]*\\br="${target.text}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
    const old = cellRe.exec(row);
    if (old) {
      if (/<f\b[^>]*t="(shared|array)"/.test(old[0])) fail(`${target.text}: 공유·배열 수식 셀은 안전하게 덮어쓸 수 없습니다.`);
      row = row.replace(old[0], make(/\bs="(\d+)"/.exec(old[0].slice(0, old[0].indexOf('>')))?.[1]));
    } else {
      const cells = [...row.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)];
      const after = cells.find((m) => colIndex(m[1]) > target.col);
      row = after ? row.replace(after[0], make() + after[0]) : row.replace('</row>', `${make()}</row>`);
    }
    data = data.replace(existing[0], () => row);
  } else {
    const rows = [...data.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)];
    const after = rows.find((m) => Number(m[1]) > target.row);
    const fresh = `<row r="${target.row}">${make()}</row>`;
    data = after ? data.replace(after[0], () => fresh + after[0]) : data + fresh;
  }
  xml = xml.slice(0, sdStart) + data + xml.slice(sdEnd);
  const dim = /<dimension ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"\/>/.exec(xml);
  if (dim) {
    const c2 = Math.max(colIndex(dim[3] || dim[1]), target.col), r2 = Math.max(Number(dim[4] || dim[2]), target.row);
    xml = xml.replace(dim[0], `<dimension ref="${dim[1]}${dim[2]}:${colName(c2)}${r2}"/>`);
  }
  return xml;
}

function extendStyles(xml) {
  if (!/<cellXfs\b/.test(xml) || !/<fonts\b/.test(xml) || !/<fills\b/.test(xml)) fail('스타일 정보가 없어 새 시트 서식을 추가할 수 없습니다.');
  const bump = (tag, add) => {
    const m = new RegExp(`<${tag}\\b[^>]*count="(\\d+)"`).exec(xml);
    if (!m) fail(`스타일 ${tag} 정보를 찾지 못했습니다.`);
    const n = Number(m[1]);
    xml = xml.replace(new RegExp(`(<${tag}\\b[^>]*count=")\\d+(")`), `$1${n + add}$2`);
    return n;
  };
  const ids = [...xml.matchAll(/numFmtId="(\d+)"/g)].map((m) => Number(m[1]));
  const fmtDate = Math.max(163, ...ids.filter((i) => i < 5000)) + 1, fmtCur = fmtDate + 1;
  const fontId = bump('fonts', 1), fillId = bump('fills', 1);
  xml = xml.replace('</fonts>', '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>').replace('</fills>', '<fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill></fills>');
  const customs = `<numFmt numFmtId="${fmtDate}" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="${fmtCur}" formatCode="&quot;₩&quot;#,##0"/>`;
  if (/<numFmts\b/.test(xml)) { bump('numFmts', 2); xml = xml.replace('</numFmts>', `${customs}</numFmts>`); }
  else xml = xml.replace(/(<styleSheet\b[^>]*>)/, `$1<numFmts count="2">${customs}</numFmts>`);
  const base = bump('cellXfs', 7);
  const xfs = [`<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>`,
    '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>', '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
    '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>', `<xf numFmtId="${fmtDate}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
    `<xf numFmtId="${fmtCur}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`, '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  xml = xml.replace('</cellXfs>', `${xfs.join('')}</cellXfs>`);
  return { xml, xf: { header: base, integer: base + 1, decimal: base + 2, percent: base + 3, date: base + 4, currency: base + 5, text: 0 } };
}

export function editXlsx(bytes, edit) {
  validateXlsxEdit(edit);
  const zip = new ZipReader(bytes);
  try {
    if (!zip.has('xl/workbook.xml')) fail('올바른 XLSX 문서가 아닙니다.');
    const replaced = new Map(), removed = new Set(), added = [];
    const sheets = sheetFiles(zip);
    for (const cell of edit.setCells || []) {
      const sheet = sheets.find((s) => s.name === cell.sheet);
      if (!sheet || !zip.has(sheet.file)) fail(`시트 "${cell.sheet}"를 찾지 못했습니다. 사용 가능: ${sheets.map((s) => s.name).join(', ')}`);
      let xml = replaced.get(sheet.file) ?? zip.text(sheet.file, { maxBytes: 96 * 1024 * 1024 });
      replaced.set(sheet.file, setCellInSheet(xml, cell, 0));
    }
    let workbook = zip.text('xl/workbook.xml'), types = zip.text('[Content_Types].xml');
    let wbRels = zip.has('xl/_rels/workbook.xml.rels') ? zip.text('xl/_rels/workbook.xml.rels') : null;
    if (edit.addSheets?.length) {
      if (wbRels === null) fail('워크북 관계 파일이 없어 시트를 추가할 수 없습니다.');
      const exists = new Set(sheets.map((s) => s.name.toLowerCase()));
      for (const s of edit.addSheets) if (exists.has(s.name.toLowerCase())) fail(`이미 같은 이름의 시트가 있습니다: ${s.name}`);
      const styled = extendStyles(zip.text('xl/styles.xml'));
      replaced.set('xl/styles.xml', styled.xml);
      let maxSheet = Math.max(0, ...zip.names().map((n) => Number(/^xl\/worksheets\/sheet(\d+)\.xml$/.exec(n)?.[1] || 0)));
      let maxId = Math.max(0, ...[...workbook.matchAll(/sheetId="(\d+)"/g)].map((m) => Number(m[1])));
      let maxRid = Math.max(0, ...[...wbRels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])));
      for (const s of edit.addSheets) {
        maxSheet++; maxId++; maxRid++;
        const file = `xl/worksheets/sheet${maxSheet}.xml`;
        added.push({ name: file, data: sheetXml({ ...s, table: false }, styled.xf) });
        workbook = workbook.replace('</sheets>', `<sheet name="${esc(s.name)}" sheetId="${maxId}" r:id="rId${maxRid}"/></sheets>`);
        wbRels = wbRels.replace('</Relationships>', `<Relationship Id="rId${maxRid}" Type="${NS_R}/worksheet" Target="worksheets/sheet${maxSheet}.xml"/></Relationships>`);
        types = types.replace('</Types>', `<Override PartName="/${file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
      }
    }
    // Formulas must be recalculated by Excel on open; a stale calculation chain would be wrong for edited cells.
    if (/<calcPr\b/.test(workbook)) workbook = /fullCalcOnLoad=/.test(workbook) ? workbook.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"') : workbook.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
    else workbook = workbook.replace(/(<extLst\b|<\/workbook>)/, '<calcPr fullCalcOnLoad="1"/>$1');
    if (zip.has('xl/calcChain.xml')) {
      removed.add('xl/calcChain.xml');
      types = types.replace(/<Override[^>]*calcChain[^>]*\/>/, '');
      if (wbRels) wbRels = wbRels.replace(/<Relationship\b[^>]*calcChain[^>]*\/>/, '');
    }
    const files = [];
    for (const entry of zip.entries) {
      if (entry.dir || removed.has(entry.name)) continue;
      const data = { 'xl/workbook.xml': workbook, '[Content_Types].xml': types, 'xl/_rels/workbook.xml.rels': wbRels }[entry.name] ?? replaced.get(entry.name);
      files.push({ name: entry.name, data: data !== undefined && data !== null ? data : zip.read(entry.name), ...(entry.method === 0 ? { store: true } : {}) });
    }
    return writeZip([...files, ...added]);
  } finally { zip.close(); }
}
