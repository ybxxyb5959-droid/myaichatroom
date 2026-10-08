// Image tools: thumbnails and facts, deterministic local edits, AI analysis and AI generation/editing. Results always
// arrive as a pending change set (new file) that the user previews and approves; originals are never changed.
const $ = (selector) => document.querySelector(selector);
const el = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
const bytes = (n) => (n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`);
const opLabels = { resize: '크기 변경', crop: '자르기', rotate: '회전', flip: '뒤집기', grayscale: '흑백', brightness: '밝기', contrast: '대비', invert: '색 반전' };
const opText = (op) => ({ resize: `크기 ${op.width ?? '자동'}×${op.height ?? '자동'}${op.fit === 'contain' ? ' (비율 유지)' : ''}`, crop: `자르기 (${op.x},${op.y}) ${op.width}×${op.height}`, rotate: `${op.degrees}° 회전`,
  flip: op.axis === 'horizontal' ? '좌우 뒤집기' : '상하 뒤집기', grayscale: '흑백', brightness: `밝기 ${op.amount}`, contrast: `대비 ${op.amount}`, invert: '색 반전' }[op.op]);

export function createImageUI({ getScope, getInfo, refreshInfo, isBusy, startRun, openChange, onChange }) {
  const panel = $('#taskImagePanel'), thumbs = $('#taskImageThumbs'), info = $('#taskImageInfo'), opsList = $('#taskImageOps');
  let selected = null, ops = [], extra = new Map(), describeSeq = 0;
  const scope = () => getScope();
  const attachments = () => (getInfo()?.attachments || []).filter((a) => a.projectId === scope()?.projectId && a.kind === 'image');
  const sourceBody = () => (selected.kind === 'attachment' ? { kind: 'attachment', id: selected.id } : { kind: 'file', path: selected.path });
  async function post(body) {
    const s = scope();
    const response = await fetch('/api/tasks/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: s.projectId, sessionId: s.sessionId, ...body }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '요청을 처리하지 못했습니다.');
    return value;
  }
  async function describe() {
    const seq = ++describeSeq;
    if (!selected) { info.textContent = ''; return; }
    info.textContent = '이미지 정보를 확인하는 중…';
    try {
      const v = await post({ action: 'image.describe', source: sourceBody() });
      if (seq !== describeSeq) return;
      const parts = [`${v.format} · ${v.width}×${v.height}px (${v.megapixels}MP, ${v.aspect}) · ${bytes(v.bytes)}`];
      if (v.hasAlpha !== undefined) parts.push(v.hasAlpha ? '투명도 있음' : '투명도 없음');
      if (v.dpi) parts.push(`${v.dpi}dpi`);
      if (v.animated) parts.push('움직이는 GIF');
      if (v.exif) parts.push([v.exif.make, v.exif.model].filter(Boolean).join(' ') + (v.exif.dateTimeOriginal ? ` · ${v.exif.dateTimeOriginal}` : '') + (v.exif.iso ? ` · ISO ${v.exif.iso}` : ''));
      if (v.privacyNote) parts.push(`⚠ ${v.privacyNote}`);
      parts.push(v.editable ? '로컬 편집 가능(PNG)' : `${v.format}은(는) 로컬 편집 불가 — AI 편집 또는 PNG 변환 후 사용`);
      info.textContent = parts.filter(Boolean).join('\n');
      info.dataset.editable = String(v.editable);
    } catch (error) { if (seq === describeSeq) info.textContent = error.message; }
    sync();
  }
  function select(item) { selected = item; ops = []; describe(); render(); }

  function render() {
    const s = scope();
    const list = [...attachments().map((a) => ({ kind: 'attachment', id: a.id, name: a.name, src: `/api/tasks/attachments?projectId=${encodeURIComponent(s.projectId)}&file=${encodeURIComponent(a.id)}` })), ...extra.values()];
    if (selected && !list.some((i) => key(i) === key(selected))) { selected = null; describeSeq++; info.textContent = ''; }
    panel.hidden = !s || (!list.length && !panel.open);
    thumbs.replaceChildren(...list.map((item) => {
      const button = el('button', undefined, 'task-thumb'); button.type = 'button'; button.setAttribute('aria-pressed', String(!!selected && key(item) === key(selected))); button.title = item.name;
      const img = document.createElement('img'); img.alt = item.name; img.loading = 'lazy'; img.src = item.src;
      button.append(img, el('span', item.name));
      button.onclick = () => select(item);
      return button;
    }));
    opsList.replaceChildren(...ops.map((op, i) => { const li = el('li', opText(op)); const remove = el('button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', '편집 단계 삭제'); remove.onclick = () => { ops.splice(i, 1); render(); }; li.append(remove); return li; }));
    sync();
  }
  const key = (i) => `${i.kind}:${i.id || i.path}`;
  function sync() {
    const busy = isBusy(), have = !!selected, editable = info.dataset.editable === 'true';
    const consent = $('#taskImageConsent').checked;
    $('#taskImageAddOp').disabled = busy || !have || !editable;
    $('#taskImageLocal').disabled = busy || !have || !editable || !ops.length;
    $('#taskImageAnalyze').disabled = busy || !have || !consent;
    const provider = getInfo()?.imageProviders?.find((p) => p.id === $('#taskImageProvider').value);
    const editing = $('#taskImageMode').value === 'edit';
    $('#taskImageGenerate').disabled = busy || !consent || !provider?.installed || (editing && (!have || !provider.canEdit));
    $('#taskImageProvider').disabled = busy;
  }
  function renderProviders() {
    const select = $('#taskImageProvider'), providers = getInfo()?.imageProviders || [];
    const signature = JSON.stringify(providers.map((p) => [p.id, p.installed]));
    if (select.dataset.signature === signature) return;
    select.dataset.signature = signature;
    select.replaceChildren(...providers.map((p) => { const o = el('option', `${p.name}${p.installed ? '' : ' · 설치 안 됨'}`); o.value = p.id; o.disabled = !p.installed; return o; }));
    select.value = providers.find((p) => p.installed)?.id || '';
  }
  function params() {
    const op = $('#taskImageOp').value;
    for (const row of document.querySelectorAll('#taskImageParams [data-for]')) row.hidden = row.dataset.for !== op;
  }
  const num = (id) => { const v = $(id).value; return v === '' ? undefined : Number(v); };
  $('#taskImageOp').onchange = params;
  $('#taskImageAddOp').onclick = () => {
    const op = $('#taskImageOp').value;
    const built = { resize: { op, width: num('#taskImgW'), height: num('#taskImgH'), fit: $('#taskImgFit').checked ? 'contain' : undefined }, crop: { op, x: num('#taskImgX'), y: num('#taskImgY'), width: num('#taskImgCW'), height: num('#taskImgCH') },
      rotate: { op, degrees: Number($('#taskImgDeg').value) }, flip: { op, axis: $('#taskImgAxis').value }, grayscale: { op }, invert: { op }, brightness: { op, amount: Number($('#taskImgAmount').value) }, contrast: { op, amount: Number($('#taskImgAmount').value) } }[op];
    for (const k of Object.keys(built)) if (built[k] === undefined) delete built[k];
    ops.push(built); render();
  };
  $('#taskImageLocal').onclick = async () => {
    info.textContent = '편집 결과를 계산하는 중… (AI 없이 이 PC에서 계산합니다)';
    try { const made = await post({ action: 'image.local', source: sourceBody(), ops }); ops = []; await refreshInfo(); onChange?.(); render(); openChange(made.setId); }
    catch (error) { info.textContent = `편집하지 못했습니다: ${error.message}`; }
  };
  $('#taskImageAnalyze').onclick = () => startRun({ mode: 'image.analyze', sources: [sourceBody()], consent: true, consentAttachments: true });
  $('#taskImageGenerate').onclick = () => startRun({ mode: 'image', imageProvider: $('#taskImageProvider').value, imageAction: $('#taskImageMode').value, consent: true, consentImage: true,
    ...($('#taskImageMode').value === 'edit' ? { source: sourceBody() } : {}) });
  $('#taskImageConsent').onchange = sync; $('#taskImageMode').onchange = sync; $('#taskImageProvider').onchange = sync;
  $('#taskImageStatus').onclick = async () => {
    $('#taskImageProviderInfo').textContent = '확인 중…';
    try {
      const v = await post({ action: 'image.providers' });
      $('#taskImageProviderInfo').textContent = `${v.providers.map((p) => `${p.name}: ${p.installed ? (p.login === 'ok' ? '로그인됨' : p.login === 'fail' ? '로그인 필요' : '설치됨(로그인은 실제 생성 시 확인)') : '설치 안 됨'}`).join('\n')}\n${v.costNote}`;
    } catch (error) { $('#taskImageProviderInfo').textContent = error.message; }
  };
  panel.addEventListener('toggle', () => { renderProviders(); render(); });
  params();
  return { render, renderProviders, addProjectImage(path, src) { extra.set(`file:${path}`, { kind: 'file', path, name: path.split('/').at(-1), src }); panel.open = true; panel.hidden = false; render(); select(extra.get(`file:${path}`)); }, sync };
}
