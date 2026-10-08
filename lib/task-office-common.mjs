// Shared helpers for the OOXML writers/editors (docx, xlsx, pptx).
export const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, code: 'OFFICE' }); };
export const LIMITS = { text: 200000, items: 2000, blocks: 600, rows: 100000, cols: 200, slides: 200, sheets: 30, imageBytes: 8 * 1024 * 1024, images: 60, cellChars: 32000, nameChars: 31 };

// XML 1.0 forbids most control characters; they are dropped, never escaped.
export const clean = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
export const esc = (value) => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';

export function str(value, max, what) {
  if (typeof value !== 'string') fail(`${what}: 문자열이어야 합니다.`);
  if (value.length > max) fail(`${what}: 너무 깁니다(최대 ${max}자).`);
  return value;
}
export function list(value, max, what) {
  if (!Array.isArray(value)) fail(`${what}: 목록이어야 합니다.`);
  if (value.length > max) fail(`${what}: 항목이 너무 많습니다(최대 ${max}개).`);
  return value;
}
export const obj = (value, what) => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${what}: 객체여야 합니다.`); return value; };
export function onlyKeys(value, allowed, what) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${what}: 알 수 없는 항목 "${key}"입니다.`);
}

// Pixel size of PNG / JPEG / GIF, so pictures keep their aspect ratio. Anything else is rejected.
export function imageInfo(bytes) {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return { ext: 'png', mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 10 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let p = 2;
    while (p + 9 < bytes.length) {
      if (bytes[p] !== 0xff) { p++; continue; }
      const marker = bytes[p + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { ext: 'jpeg', mime: 'image/jpeg', height: bytes.readUInt16BE(p + 5), width: bytes.readUInt16BE(p + 7) };
      p += 2 + bytes.readUInt16BE(p + 2);
    }
  }
  if (bytes.length > 10 && bytes.toString('latin1', 0, 3) === 'GIF') return { ext: 'gif', mime: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  return null;
}
export function loadImage(source, resolveImage, what) {
  const bytes = resolveImage ? resolveImage(source) : null;
  if (!Buffer.isBuffer(bytes)) fail(`${what}: 이미지를 찾을 수 없습니다.`);
  if (bytes.length > LIMITS.imageBytes) fail(`${what}: 이미지가 너무 큽니다(최대 8MB).`);
  const info = imageInfo(bytes);
  if (!info || !info.width || !info.height || info.width > 20000 || info.height > 20000) fail(`${what}: PNG·JPEG·GIF 이미지만 넣을 수 있습니다.`);
  return { bytes, ...info };
}

export const contentTypes = (defaults, overrides) => `${XML}<Types xmlns="${NS_CT}">${Object.entries(defaults).map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`).join('')}${Object.entries(overrides).map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('')}</Types>`;
export const rels = (items) => `${XML}<Relationships xmlns="${NS_PKG_REL}">${items.map((r) => `<Relationship Id="${r.id}" Type="${r.type.startsWith('http') ? r.type : `${NS_R}/${r.type}`}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
export const coreProps = (title) => `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>AI 작업대</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`;
export const appProps = (name) => `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${esc(name)}</Application></Properties>`;
export const colorHex = (value, fallback = '000000') => (/^#?[0-9a-fA-F]{6}$/.test(value || '') ? value.replace('#', '').toUpperCase() : fallback);
export const colName = (index) => { let n = index, s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
export const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)?.[0] || '') n = n * 26 + ch.charCodeAt(0) - 64; return n; };
