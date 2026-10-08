import { ZipReader, writeZip } from './task-zip.mjs';
import { fail, LIMITS, esc, clean, XML, NS_R, contentTypes, rels, coreProps, appProps, str, list, obj, onlyKeys, loadImage, colorHex } from './task-office-common.mjs';

// PowerPoint decks from a validated JSON spec, and careful text/slide edits of existing .pptx files.
const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_R}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const SW = 12192000, SH = 6858000;
const LAYOUTS = ['title', 'bullets', 'two-column', 'image', 'section', 'blank'];
const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function bulletItem(item, what) {
  if (typeof item === 'string') return str(item, 600, what);
  obj(item, what); onlyKeys(item, ['text', 'level'], what); str(item.text, 600, `${what}.text`);
  if (item.level !== undefined && ![0, 1, 2].includes(item.level)) fail(`${what}.level은 0~2여야 합니다.`);
  return item;
}
export function validateSlide(slide, index, ctx) {
  const what = `slides[${index}]`;
  obj(slide, what); onlyKeys(slide, ['layout', 'title', 'subtitle', 'bullets', 'left', 'right', 'image', 'caption', 'color'], what);
  if (!LAYOUTS.includes(slide.layout)) fail(`${what}.layout은 ${LAYOUTS.join('/')} 중 하나여야 합니다.`);
  if (slide.layout !== 'blank') str(slide.title, 300, `${what}.title`);
  for (const key of ['subtitle', 'caption']) if (slide[key] !== undefined) str(slide[key], 600, `${what}.${key}`);
  for (const key of ['bullets', 'left', 'right']) if (slide[key] !== undefined) list(slide[key], 12, `${what}.${key}`).forEach((b, i) => bulletItem(b, `${what}.${key}[${i}]`));
  if (slide.layout === 'bullets' && !slide.bullets?.length) fail(`${what}: bullets 레이아웃에는 bullets가 필요합니다.`);
  if (slide.layout === 'two-column' && !(slide.left?.length && slide.right?.length)) fail(`${what}: two-column 레이아웃에는 left와 right가 필요합니다.`);
  if (slide.layout === 'image') {
    obj(slide.image, `${what}.image`); onlyKeys(slide.image, ['source', 'alt'], `${what}.image`); str(slide.image.source, 500, `${what}.image.source`);
    if (slide.image.alt !== undefined) str(slide.image.alt, 500, `${what}.image.alt`);
    ctx.images++;
    if (ctx.images > LIMITS.images) fail('이미지는 최대 60개까지 넣을 수 있습니다.');
  }
  if (slide.color !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(slide.color)) fail(`${what}.color는 6자리 16진수 색상이어야 합니다.`);
  return slide;
}
export function validatePptx(spec) {
  obj(spec, 'presentation'); onlyKeys(spec, ['type', 'title', 'slides'], 'presentation');
  if (spec.title !== undefined) str(spec.title, 300, 'title');
  const slides = list(spec.slides, LIMITS.slides, 'slides');
  if (!slides.length) fail('슬라이드가 없습니다.');
  const ctx = { images: 0 };
  slides.forEach((s, i) => validateSlide(s, i, ctx));
  return spec;
}

const para = (item, size, bullet = false) => {
  const t = typeof item === 'string' ? item : item.text, lvl = typeof item === 'string' ? 0 : item.level || 0;
  const ppr = bullet ? `<a:pPr marL="${342900 + lvl * 400050}" indent="-285750" lvl="${lvl}"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>` : `<a:pPr lvl="${lvl}"/>`;
  return `<a:p>${ppr}<a:r><a:rPr lang="ko-KR" sz="${Math.max(1200, size - lvl * 200)}" dirty="0"/><a:t>${esc(t)}</a:t></a:r></a:p>`;
};
const sizeFor = (items) => { const chars = items.reduce((n, i) => n + (typeof i === 'string' ? i : i.text).length, 0); return items.length <= 4 && chars < 200 ? 2800 : items.length <= 6 && chars < 360 ? 2400 : chars < 600 ? 2000 : 1600; };
const xfrm = (x, y, w, h) => `<a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm>`;
const placeholder = (id, name, ph, geom, body) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr>${geom ? xfrm(...geom) : ''}</p:spPr><p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;
const textBox = (id, name, geom, body, anchor = 't') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(...geom)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;
const picture = (id, rid, alt, image, box) => {
  const scale = Math.min(box[2] / image.width, box[3] / image.height), w = image.width * scale, h = image.height * scale;
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${esc(alt || '')}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(box[0] + (box[2] - w) / 2, box[1] + (box[3] - h) / 2, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
};
const titleRun = (text, size, color, extra = '') => `<a:p><a:pPr${extra}/><a:r><a:rPr lang="ko-KR" sz="${size}" b="1" dirty="0">${color ? `<a:solidFill><a:srgbClr val="${colorHex(color)}"/></a:solidFill>` : ''}</a:rPr><a:t>${esc(text)}</a:t></a:r></a:p>`;

// layoutInfo: {file, hasBody} for the layout the slide will use. images: collector [{rid, name, bytes, ext}]
function slideXml(slide, ctx, layoutInfo = { body: true, title: true }) {
  const shapes = [];
  const accent = slide.color;
  let bg = '';
  const rid = () => `rId${2 + ctx.images.length}`;
  if (slide.layout === 'section') {
    bg = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${colorHex(accent, '1F3864')}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
    shapes.push(layoutInfo.title ? placeholder(2, 'Title 1', 'type="title"', [914400, 2400000, 10363200, 1400000], titleRun(slide.title, 4800, 'FFFFFF')) : textBox(2, 'Title', [914400, 2400000, 10363200, 1400000], titleRun(slide.title, 4800, 'FFFFFF'), 'ctr'));
    if (slide.subtitle) shapes.push(textBox(3, 'Subtitle', [914400, 3900000, 10363200, 900000], `<a:p><a:r><a:rPr lang="ko-KR" sz="2400" dirty="0"><a:solidFill><a:srgbClr val="D9E2F3"/></a:solidFill></a:rPr><a:t>${esc(slide.subtitle)}</a:t></a:r></a:p>`));
  } else if (slide.layout === 'title') {
    shapes.push(layoutInfo.ctr ? placeholder(2, 'Title 1', 'type="ctrTitle"', [914400, 2130425, 10363200, 1470025], titleRun(slide.title, 5400, slide.color, ' algn="ctr"'))
      : textBox(2, 'Title', [914400, 2130425, 10363200, 1470025], titleRun(slide.title, 5400, slide.color, ' algn="ctr"'), 'b'));
    if (slide.subtitle) shapes.push(textBox(3, 'Subtitle', [914400, 3700000, 10363200, 1300000], `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="ko-KR" sz="2800" dirty="0"><a:solidFill><a:srgbClr val="595959"/></a:solidFill></a:rPr><a:t>${esc(slide.subtitle)}</a:t></a:r></a:p>`));
  } else if (slide.layout !== 'blank') {
    shapes.push(layoutInfo.title ? placeholder(2, 'Title 1', 'type="title"', null, titleRun(slide.title, 3600, slide.color)) : textBox(2, 'Title', [609600, 274638, 10972800, 1000000], titleRun(slide.title, 3600, slide.color), 'ctr'));
    if (slide.layout === 'bullets') {
      const size = sizeFor(slide.bullets);
      shapes.push(layoutInfo.body ? placeholder(3, 'Content 2', 'idx="1"', null, slide.bullets.map((b) => para(b, size)).join(''))
        : textBox(3, 'Content', [609600, 1500000, 10972800, 4800000], slide.bullets.map((b) => para(b, size, true)).join('')));
    } else if (slide.layout === 'two-column') {
      shapes.push(textBox(3, 'Left', [609600, 1500000, 5334000, 4800000], slide.left.map((b) => para(b, sizeFor(slide.left), true)).join('')));
      shapes.push(textBox(4, 'Right', [6248400, 1500000, 5334000, 4800000], slide.right.map((b) => para(b, sizeFor(slide.right), true)).join('')));
    } else if (slide.layout === 'image') {
      const image = loadImage(slide.image.source, ctx.resolveImage, `이미지 ${slide.image.source}`);
      const id = ctx.images.length + 1, name = `image${ctx.nextImage++}.${image.ext === 'jpeg' ? 'jpg' : image.ext}`, r = rid();
      ctx.images.push({ rid: r, name, bytes: image.bytes, ext: image.ext });
      shapes.push(picture(3, r, slide.image.alt || slide.title, image, [609600, 1450000, 10972800, slide.caption ? 4500000 : 4900000]));
      if (slide.caption) shapes.push(textBox(4, 'Caption', [609600, 6050000, 10972800, 500000], `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="ko-KR" sz="1800" i="1" dirty="0"><a:solidFill><a:srgbClr val="595959"/></a:solidFill></a:rPr><a:t>${esc(slide.caption)}</a:t></a:r></a:p>`));
      void id;
    }
  }
  return `${XML}<p:sld ${NS}><p:cSld>${bg}<p:spTree>${GROUP}${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const bodyLvl = (n, marL, size) => `<a:lvl${n}pPr marL="${marL}" indent="-285750" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="${size}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;
const master = () => `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}`
  + placeholder(2, 'Title Placeholder 1', 'type="title"', [609600, 274638, 10972800, 1143000], '<a:p><a:r><a:rPr lang="ko-KR"/><a:t>제목</a:t></a:r></a:p>')
  + placeholder(3, 'Text Placeholder 2', 'type="body" idx="1"', [609600, 1600200, 10972800, 4525963], '<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="ko-KR"/><a:t>내용</a:t></a:r></a:p>')
  + '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/><p:sldLayoutId id="2147483651" r:id="rId3"/><p:sldLayoutId id="2147483652" r:id="rId4"/></p:sldLayoutIdLst>'
  + '<p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="3600" b="1" kern="1200"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>'
  + `<p:bodyStyle>${bodyLvl(1, 342900, 2800)}${bodyLvl(2, 742950, 2400)}${bodyLvl(3, 1143000, 2000)}</p:bodyStyle>`
  + '<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>';
const layout = (name, type, shapes) => `${XML}<p:sldLayout ${NS} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const theme = () => `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="AI Workbench"><a:themeElements><a:clrScheme name="Workbench"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F3864"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="2F5597"/></a:accent1><a:accent2><a:srgbClr val="C55A11"/></a:accent2><a:accent3><a:srgbClr val="548235"/></a:accent3><a:accent4><a:srgbClr val="7030A0"/></a:accent4><a:accent5><a:srgbClr val="2E75B6"/></a:accent5><a:accent6><a:srgbClr val="BF9000"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>`
  + '<a:fontScheme name="Workbench"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
  + '<a:fmtScheme name="Workbench"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
  + '<a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>'
  + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>';

const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
export function buildPptx(spec, { resolveImage } = {}) {
  validatePptx(spec);
  const ctx = { images: [], nextImage: 1, resolveImage };
  const slideFiles = [], slideRels = [];
  spec.slides.forEach((slide, i) => {
    ctx.images = [];
    const layoutIndex = slide.layout === 'title' ? 1 : slide.layout === 'bullets' ? 2 : slide.layout === 'blank' ? 4 : 3;
    const xml = slideXml(slide, ctx, { title: layoutIndex !== 4, body: layoutIndex === 2, ctr: layoutIndex === 1 });
    slideFiles.push({ name: `ppt/slides/slide${i + 1}.xml`, data: xml });
    slideRels.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: rels([{ id: 'rId1', type: 'slideLayout', target: `../slideLayouts/slideLayout${layoutIndex}.xml` }, ...ctx.images.map((im) => ({ id: im.rid, type: 'image', target: `../media/${im.name}` }))]), images: [...ctx.images] });
  });
  const media = slideRels.flatMap((r) => r.images).map((im) => ({ name: `ppt/media/${im.name}`, data: im.bytes, store: true }));
  const imgExt = {}; for (const r of slideRels) for (const im of r.images) imgExt[im.ext === 'jpeg' ? 'jpg' : im.ext] = im.ext === 'png' ? 'image/png' : im.ext === 'gif' ? 'image/gif' : 'image/jpeg';
  const n = spec.slides.length;
  const overrides = { '/ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', '/ppt/slideMasters/slideMaster1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
    '/ppt/theme/theme1.xml': 'application/vnd.openxmlformats-officedocument.theme+xml', '/docProps/core.xml': 'application/vnd.openxmlformats-package.core-properties+xml', '/docProps/app.xml': 'application/vnd.openxmlformats-officedocument.extended-properties+xml' };
  for (let i = 1; i <= 4; i++) overrides[`/ppt/slideLayouts/slideLayout${i}.xml`] = 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml';
  for (let i = 1; i <= n; i++) overrides[`/ppt/slides/slide${i}.xml`] = CT_SLIDE;
  const files = [
    { name: '[Content_Types].xml', data: contentTypes({ rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml', ...imgExt }, overrides) },
    { name: '_rels/.rels', data: rels([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }, { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' }, { id: 'rId3', type: 'extended-properties', target: 'docProps/app.xml' }]) },
    { name: 'ppt/presentation.xml', data: `${XML}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${spec.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${SW}" cy="${SH}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="ko-KR"/></a:defPPr></p:defaultTextStyle></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels([{ id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }, { id: 'rId2', type: 'theme', target: 'theme/theme1.xml' }, ...spec.slides.map((_, i) => ({ id: `rId${i + 3}`, type: 'slide', target: `slides/slide${i + 1}.xml` }))]) },
    { name: 'ppt/theme/theme1.xml', data: theme() },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master() },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels([1, 2, 3, 4].map((i) => ({ id: `rId${i}`, type: 'slideLayout', target: `../slideLayouts/slideLayout${i}.xml` })).concat([{ id: 'rId5', type: 'theme', target: '../theme/theme1.xml' }])) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout('Title Slide', 'title', placeholder(2, 'Title 1', 'type="ctrTitle"', [914400, 2130425, 10363200, 1470025], '<a:p><a:r><a:rPr lang="ko-KR"/><a:t>제목</a:t></a:r></a:p>') + placeholder(3, 'Subtitle 2', 'type="subTitle" idx="1"', [914400, 3700000, 10363200, 1300000], '<a:p><a:r><a:rPr lang="ko-KR"/><a:t>부제목</a:t></a:r></a:p>')) },
    { name: 'ppt/slideLayouts/slideLayout2.xml', data: layout('Title and Content', 'obj', placeholder(2, 'Title 1', 'type="title"', null, '<a:p><a:r><a:rPr lang="ko-KR"/><a:t>제목</a:t></a:r></a:p>') + placeholder(3, 'Content Placeholder 2', 'idx="1"', null, '<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="ko-KR"/><a:t>내용</a:t></a:r></a:p>')) },
    { name: 'ppt/slideLayouts/slideLayout3.xml', data: layout('Title Only', 'titleOnly', placeholder(2, 'Title 1', 'type="title"', null, '<a:p><a:r><a:rPr lang="ko-KR"/><a:t>제목</a:t></a:r></a:p>')) },
    { name: 'ppt/slideLayouts/slideLayout4.xml', data: layout('Blank', 'blank', '') },
    ...[1, 2, 3, 4].map((i) => ({ name: `ppt/slideLayouts/_rels/slideLayout${i}.xml.rels`, data: rels([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]) })),
    ...slideFiles, ...slideRels.map(({ name, data }) => ({ name, data })), ...media,
    { name: 'docProps/core.xml', data: coreProps(spec.title || spec.slides[0].title || '프레젠테이션') },
    { name: 'docProps/app.xml', data: appProps('AI 작업대') },
  ];
  return writeZip(files);
}

// ---- editing ----
const PPT_PARAGRAPH = /<a:p>(?:(?!<a:p>)[\s\S])*?<\/a:p>|<a:p\s(?:(?!<a:p[ >])[\s\S])*?<\/a:p>/g;
const A_T = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
const unesc = (s) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]));
function replaceInParagraph(p, find, replacement) {
  const nodes = [...p.matchAll(A_T)].map((m) => ({ index: m.index, length: m[0].length, open: m[0].slice(0, m[0].indexOf('>') + 1), text: unesc(m[1]) }));
  if (!nodes.length) return { xml: p, count: 0 };
  const texts = nodes.map((n) => n.text);
  let full = texts.join(''), count = 0, from = 0;
  for (;;) {
    const at = full.indexOf(find, from);
    if (at < 0) break;
    const starts = []; { let acc = 0; for (const t of texts) { starts.push(acc); acc += t.length; } }
    const end = at + find.length, first = starts.findLastIndex((s) => s <= at), last = starts.findLastIndex((s) => s < end);
    const before = texts[first].slice(0, at - starts[first]), after = texts[last].slice(end - starts[last]);
    if (first === last) texts[first] = before + replacement + after;
    else { texts[first] = before + replacement; for (let i = first + 1; i < last; i++) texts[i] = ''; texts[last] = after; }
    count++; full = texts.join(''); from = at + replacement.length;
  }
  if (!count) return { xml: p, count: 0 };
  let out = '', cursor = 0;
  nodes.forEach((n, i) => { out += p.slice(cursor, n.index) + `<a:t>${esc(texts[i])}</a:t>`; cursor = n.index + n.length; });
  return { xml: out + p.slice(cursor), count };
}
export function validatePptxEdit(edit) {
  obj(edit, 'edit'); onlyKeys(edit, ['type', 'replace', 'addSlides'], 'edit');
  if (edit.replace !== undefined) for (const [i, r] of list(edit.replace, 200, 'replace').entries()) {
    obj(r, `replace[${i}]`); onlyKeys(r, ['find', 'replace'], `replace[${i}]`);
    if (!str(r.find, 2000, `replace[${i}].find`)) fail(`replace[${i}].find가 비었습니다.`);
    str(r.replace, 5000, `replace[${i}].replace`);
  }
  if (edit.addSlides !== undefined) { const ctx = { images: 0 }; list(edit.addSlides, LIMITS.slides, 'addSlides').forEach((s, i) => validateSlide(s, i, ctx)); }
  if (!edit.replace?.length && !edit.addSlides?.length) fail('수정 내용이 비었습니다.');
  return edit;
}
export function editPptx(bytes, edit, { resolveImage } = {}) {
  validatePptxEdit(edit);
  const zip = new ZipReader(bytes);
  try {
    if (!zip.has('ppt/presentation.xml')) fail('올바른 PPTX 문서가 아닙니다.');
    const replaced = new Map(), added = [];
    const slideNames = zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
    for (const r of edit.replace || []) {
      let total = 0;
      for (const name of slideNames) {
        const xml = replaced.get(name) ?? zip.text(name, { maxBytes: 32 * 1024 * 1024 });
        const next = xml.replace(PPT_PARAGRAPH, (p) => {
          const plain = [...p.matchAll(A_T)].map((m) => unesc(m[1])).join('');
          if (!plain.includes(r.find)) return p;
          const result = replaceInParagraph(p, r.find, r.replace); total += result.count; return result.xml;
        });
        if (next !== xml) replaced.set(name, next);
      }
      if (!total) fail(`"${r.find}"를 슬라이드 텍스트에서 찾지 못했습니다.`);
    }
    let presentation = zip.text('ppt/presentation.xml'), types = zip.text('[Content_Types].xml');
    let presRels = zip.text('ppt/_rels/presentation.xml.rels');
    if (edit.addSlides?.length) {
      const size = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presentation);
      if (!size || Number(size[1]) !== SW || Number(size[2]) !== SH) fail('이 발표 자료는 16:9(와이드) 크기가 아니어서 슬라이드를 자동으로 추가하지 않습니다.');
      // choose layouts by name, falling back to any layout with a title placeholder
      const layouts = zip.names().filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n)).map((n) => {
        const xml = zip.text(n); return { n, name: /<p:cSld name="([^"]*)"/.exec(xml)?.[1] || '', title: /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(xml), body: /<p:ph\b(?![^>]*type="(?:title|ctrTitle|subTitle|dt|ftr|sldNum)")[^>]*idx="1"/.test(xml) };
      });
      const pick = (...names) => names.map((nm) => layouts.find((l) => l.name.toLowerCase() === nm)).find(Boolean);
      const byKind = { bullets: pick('title and content') || layouts.find((l) => l.title && l.body), default: pick('title only') || layouts.find((l) => l.title) || pick('blank') || layouts[0] };
      if (!layouts.length) fail('슬라이드 레이아웃을 찾지 못했습니다.');
      let maxSlide = Math.max(0, ...slideNames.map((n) => Number(/(\d+)\.xml$/.exec(n)[1])));
      let maxId = Math.max(255, ...[...presentation.matchAll(/<p:sldId\b[^>]*\bid="(\d+)"/g)].map((m) => Number(m[1])));
      let maxRid = Math.max(0, ...[...presRels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])));
      let maxImage = Math.max(0, ...zip.names().map((n) => Number(/^ppt\/media\/image(\d+)\./.exec(n)?.[1] || 0)));
      for (const slide of edit.addSlides) {
        maxSlide++; maxId++; maxRid++;
        const layoutInfo = slide.layout === 'bullets' ? byKind.bullets || byKind.default : byKind.default;
        const ctx = { images: [], nextImage: maxImage + 1, resolveImage };
        const xml = slideXml(slide, ctx, { title: !!layoutInfo.title && slide.layout !== 'blank', body: !!layoutInfo.body && slide.layout === 'bullets', ctr: false });
        maxImage = ctx.nextImage - 1;
        added.push({ name: `ppt/slides/slide${maxSlide}.xml`, data: xml });
        added.push({ name: `ppt/slides/_rels/slide${maxSlide}.xml.rels`, data: rels([{ id: 'rId1', type: 'slideLayout', target: `../slideLayouts/${layoutInfo.n.split('/').pop()}` }, ...ctx.images.map((im) => ({ id: im.rid, type: 'image', target: `../media/${im.name}` }))]) });
        for (const im of ctx.images) {
          added.push({ name: `ppt/media/${im.name}`, data: im.bytes, store: true });
          const ext = im.ext === 'jpeg' ? 'jpg' : im.ext;
          if (!new RegExp(`<Default[^>]*Extension="${ext}"`, 'i').test(types)) types = types.replace('</Types>', `<Default Extension="${ext}" ContentType="${ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg'}"/></Types>`);
        }
        types = types.replace('</Types>', `<Override PartName="/ppt/slides/slide${maxSlide}.xml" ContentType="${CT_SLIDE}"/></Types>`);
        presRels = presRels.replace('</Relationships>', `<Relationship Id="rId${maxRid}" Type="${NS_R}/slide" Target="slides/slide${maxSlide}.xml"/></Relationships>`);
        presentation = /<p:sldIdLst\s*\/>/.test(presentation) ? presentation.replace(/<p:sldIdLst\s*\/>/, `<p:sldIdLst><p:sldId id="${maxId}" r:id="rId${maxRid}"/></p:sldIdLst>`) : presentation.replace('</p:sldIdLst>', `<p:sldId id="${maxId}" r:id="rId${maxRid}"/></p:sldIdLst>`);
      }
    }
    const files = [];
    for (const entry of zip.entries) {
      if (entry.dir) continue;
      const data = { 'ppt/presentation.xml': presentation, '[Content_Types].xml': types, 'ppt/_rels/presentation.xml.rels': presRels }[entry.name] ?? replaced.get(entry.name);
      files.push({ name: entry.name, data: data ?? zip.read(entry.name), ...(entry.method === 0 ? { store: true } : {}) });
    }
    return writeZip([...files, ...added]);
  } finally { zip.close(); }
}
