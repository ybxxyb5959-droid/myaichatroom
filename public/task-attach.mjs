// Attachments (file chooser + drag and drop) and the document-analysis controls. Files are uploaded as raw bytes and
// kept in the app's data folder; the original on the PC is only read by the browser and is never modified.
const $ = (selector) => document.querySelector(selector);
const kindLabel = { pdf: 'PDF', docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel', text: '텍스트', image: '이미지', legacy: '구형 문서(미지원)', zip: '압축 파일(미지원)', binary: '기타(미지원)' };
const analyzable = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'text']);
const depthLabel = { quick: '빠르게', normal: '보통', thorough: '꼼꼼히' };
export const bytes = (n) => (n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)}MB` : `${(n / 1073741824).toFixed(2)}GB`);
export const docPath = (path) => /\.(pdf|docx|pptx|xlsx)$/i.test(path);

export function createAttach({ getScope, getInfo, refreshInfo, startDocs, isBusy, onChange }) {
  const list = $('#taskAttachList'), chips = $('#taskDocSources'), estimate = $('#taskDocEstimate'), zone = $('.task-compose');
  const picked = new Map(); // key -> {kind:'attachment'|'file', id|path, name}
  const uploads = new Map(); // temporary id -> {name, loaded, total, error}
  let scopeKey = '', prepareSeq = 0, prepared = null, preparing = false;

  const scope = () => getScope();
  const mine = () => (getInfo()?.attachments || []).filter((a) => a.projectId === scope()?.projectId);
  const sources = () => [...picked.values()].map((p) => (p.kind === 'attachment' ? { kind: 'attachment', id: p.id } : { kind: 'file', path: p.path }));
  const el = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };

  function upload(file) {
    const s = scope();
    if (!s) return;
    const tempId = `${Date.now()}-${Math.random()}`;
    const state = { name: file.name, loaded: 0, total: file.size, error: '' };
    uploads.set(tempId, state); render();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/tasks/attachments?projectId=${encodeURIComponent(s.projectId)}&sessionId=${encodeURIComponent(s.sessionId)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => { state.loaded = event.loaded; render(); };
    xhr.onload = async () => {
      let value = {};
      try { value = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status === 201) {
        uploads.delete(tempId);
        await refreshInfo();
        if (value.item && analyzable.has(value.item.kind)) picked.set(`a:${value.item.id}`, { kind: 'attachment', id: value.item.id, name: value.item.name });
        if (value.duplicate) state.note = '이미 같은 파일이 첨부되어 있습니다.';
        onChange?.(); schedulePrepare();
      } else { state.error = value.error || `업로드 실패(${xhr.status})`; setTimeout(() => { uploads.delete(tempId); render(); }, 6000); }
      render();
    };
    xhr.onerror = () => { state.error = '네트워크 오류로 업로드하지 못했습니다.'; render(); setTimeout(() => { uploads.delete(tempId); render(); }, 6000); };
    xhr.send(file);
  }
  function addFiles(fileList) {
    if (!scope()) { estimate.textContent = '먼저 프로젝트를 만들거나 선택하세요.'; return; }
    for (const file of fileList) upload(file);
  }

  async function removeAttachment(item) {
    const s = scope();
    const response = await fetch('/api/tasks/attachments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove', projectId: s.projectId, id: item.id }) });
    if (!response.ok) { estimate.textContent = (await response.json()).error || '첨부를 제거하지 못했습니다.'; return; }
    picked.delete(`a:${item.id}`);
    await refreshInfo(); onChange?.(); schedulePrepare(); render();
  }

  let prepareTimer = null;
  function schedulePrepare() { clearTimeout(prepareTimer); prepared = null; prepareTimer = setTimeout(prepare, 300); }
  async function prepare() {
    const s = scope(), list = sources();
    const seq = ++prepareSeq;
    if (!s || !list.length) { prepared = null; preparing = false; estimate.textContent = ''; onChange?.(); return; }
    preparing = true; estimate.textContent = '문서를 읽을 수 있는 형태로 변환하는 중… (AI에는 아무것도 보내지 않습니다)'; onChange?.();
    try {
      const response = await fetch('/api/tasks/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'docs.prepare', projectId: s.projectId, sessionId: s.sessionId, sources: list }) });
      const value = await response.json();
      if (seq !== prepareSeq) return;
      if (!response.ok) throw new Error(value.error || '문서를 확인하지 못했습니다.');
      prepared = value.sources;
    } catch (error) { if (seq === prepareSeq) { prepared = null; estimate.textContent = error.message; } }
    finally { if (seq === prepareSeq) { preparing = false; renderEstimate(); onChange?.(); } }
  }
  function renderEstimate() {
    if (!prepared) return;
    const depth = $('#taskDocDepth').value;
    const calls = prepared.reduce((n, p) => n + p.estimates[depth].calls, 0);
    const lines = prepared.map((p) => {
      const e = p.estimates[depth];
      const where = p.pages ? `${p.pages}쪽` : `${p.chunks}개 구간`;
      return `${p.name}: ${where} · ${p.chars.toLocaleString('ko-KR')}자 → ${e.chunks}개 구간(${e.percent}%) 분석${e.percent < 100 ? ' · 나머지는 분석하지 않고 범위로 표시' : ''}${p.scannedPages ? ` · 스캔 ${p.scannedPages}쪽은 텍스트 없음(OCR 미지원)` : ''}`;
    });
    estimate.textContent = `${lines.join('\n')}\n예상 AI 호출 ${calls}회 (${depthLabel[depth]}). 깊이를 바꾸면 호출 수와 분석 범위가 달라집니다.`;
  }

  function render() {
    const s = scope();
    if (s && `${s.projectId}` !== scopeKey) { scopeKey = s.projectId; picked.clear(); prepared = null; estimate.textContent = ''; }
    const items = mine();
    const rows = items.map((item) => {
      const li = el('li'); li.dataset.kind = item.kind;
      const ok = analyzable.has(item.kind);
      const check = document.createElement('input'); check.type = 'checkbox'; check.disabled = !ok || isBusy(); check.checked = picked.has(`a:${item.id}`);
      check.setAttribute('aria-label', `${item.name} 분석에 사용`);
      check.onchange = () => { if (check.checked) picked.set(`a:${item.id}`, { kind: 'attachment', id: item.id, name: item.name }); else picked.delete(`a:${item.id}`); schedulePrepare(); onChange?.(); };
      const info = el('span', undefined, 'task-attach-info');
      info.append(el('strong', item.name), el('small', `${kindLabel[item.kind] || item.kind} · ${bytes(item.size)}${item.image ? ` · ${item.image.width}×${item.image.height}px` : ''}${ok ? '' : ' · 분석 불가'}`));
      const remove = el('button', '제거'); remove.type = 'button'; remove.disabled = isBusy(); remove.title = '첨부 목록에서 제거합니다. PC의 원본 파일은 그대로입니다.';
      remove.onclick = () => removeAttachment(item);
      li.append(check, info, remove);
      return li;
    });
    for (const state of uploads.values()) {
      const li = el('li'); li.dataset.state = state.error ? 'failed' : 'uploading';
      const pct = state.total ? Math.floor(state.loaded / state.total * 100) : 0;
      li.append(el('span', undefined, 'task-attach-info'));
      li.firstChild.append(el('strong', state.name), el('small', state.error ? `실패: ${state.error}` : state.note || `업로드 중 ${pct}% (${bytes(state.loaded)} / ${bytes(state.total)})`));
      rows.push(li);
    }
    list.replaceChildren(...rows);
    $('#taskAttachHint').hidden = rows.length > 0;
    const fileChips = [...picked.values()].filter((p) => p.kind === 'file');
    chips.replaceChildren(...fileChips.map((p) => {
      const chip = el('button', `${p.path} ×`, 'task-chip'); chip.type = 'button'; chip.title = '분석 목록에서 제거'; chip.disabled = isBusy();
      chip.onclick = () => { picked.delete(`f:${p.path}`); schedulePrepare(); render(); onChange?.(); };
      return chip;
    }));
    const hasSources = picked.size > 0;
    $('#taskDocControls').hidden = !hasSources && !uploads.size;
    $('#taskDocRun').disabled = !hasSources || isBusy() || preparing || !$('#taskAttachConsent').checked || !$('#taskAIConsent').checked || !prepared;
    $('#taskDocDepth').disabled = isBusy();
    $('#taskAttachConsent').disabled = isBusy();
    $('#taskAttachPick').disabled = !s || isBusy();
  }

  $('#taskAttachPick').onclick = () => $('#taskAttachInput').click();
  $('#taskAttachInput').onchange = (event) => { addFiles([...event.target.files]); event.target.value = ''; };
  $('#taskDocDepth').onchange = () => { renderEstimate(); };
  $('#taskAttachConsent').onchange = render;
  $('#taskDocRun').onclick = () => startDocs({ sources: sources(), depth: $('#taskDocDepth').value, consentAttachments: $('#taskAttachConsent').checked });
  // Drag and drop on the whole compose area; folders are ignored (browsers expose only files).
  let depth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
  zone.addEventListener('dragenter', (event) => { if (!hasFiles(event)) return; event.preventDefault(); depth++; zone.dataset.dragging = 'true'; });
  zone.addEventListener('dragover', (event) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) delete zone.dataset.dragging; });
  zone.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault(); depth = 0; delete zone.dataset.dragging;
    const files = [...event.dataTransfer.files].filter((f) => f.size > 0 || f.type);
    if (files.length) addFiles(files); else estimate.textContent = '폴더는 끌어다 놓을 수 없습니다. 파일을 선택하세요.';
  });
  // Dropping on the page outside the zone must not make the browser navigate to the file.
  for (const type of ['dragover', 'drop']) window.addEventListener(type, (event) => { if (hasFiles(event) && !zone.contains(event.target)) event.preventDefault(); });

  return {
    render,
    // Adds a project file (PDF/Office/large text) chosen in the file browser to the analysis list.
    addProjectFile(path) { picked.set(`f:${path}`, { kind: 'file', path, name: path.split('/').at(-1) }); schedulePrepare(); render(); onChange?.(); },
    has: (path) => picked.has(`f:${path}`),
    sources, count: () => picked.size, isPreparing: () => preparing,
    clear() { picked.clear(); prepared = null; estimate.textContent = ''; render(); },
    reset() { picked.clear(); prepared = null; scopeKey = ''; },
  };
}
