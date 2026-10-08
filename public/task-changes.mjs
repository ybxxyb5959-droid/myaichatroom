// File change sets: review, approve, apply (with a final confirmation) and restore. The server holds every path and
// content; this view only displays them and sends the set id plus the user's decision.
const $ = (selector) => document.querySelector(selector);
const typeLabel = { create: '새 파일', modify: '수정', rename: '이름·위치 변경', delete: '삭제' };
const typeIcon = { create: '＋', modify: '✎', rename: '↦', delete: '🗑' };
const statusLabel = { pending: '검토 대기', approved: '승인됨 · 아직 실제 파일은 바뀌지 않았습니다', rejected: '거절됨', conflict: '충돌 · 파일이 변경안 생성 이후 바뀌었습니다',
  applying: '적용 중', applied: '적용 완료', apply_failed: '적용 실패 · 실제 파일은 원래대로입니다', partial: '부분 적용 · 복구가 필요합니다', restoring: '복구 중',
  restored: '복구 완료', restore_failed: '복구 실패 · 다시 시도할 수 있습니다', manual: '수동 확인 필요' };
const opStates = { queued: '대기', backed_up: '백업 완료', applying: '적용 중', applied: '적용됨', reverted: '원래대로 복구됨', failed: '변경 없음(실패)',
  unknown: '상태 확인 불가', revert_failed: '복구 실패', reverting: '복구 중' };
const bytes = (n) => (n == null ? '' : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`);

export function createChanges({ getScope, getInfo, refreshInfo, onOpen, onChanged }) {
  const view = $('#taskChangeView'), dialog = $('#taskChangeConfirm');
  let opened = null, sequence = 0, busy = false, pending = null;

  const sets = () => { const s = getScope(); return (getInfo()?.changes || []).filter((c) => s && c.projectId === s.projectId && c.sessionId === s.sessionId); };
  async function request(body) {
    const response = await fetch('/api/tasks/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '변경안을 처리하지 못했습니다.');
    return value;
  }
  const el = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };

  function renderList() {
    const list = sets();
    $('#taskChangeListStatus').textContent = list.length ? '변경안은 승인·최종 확인 전에는 파일을 바꾸지 않습니다.' : '아직 파일 변경안이 없습니다.';
    $('#taskChangeSets').replaceChildren(...list.map((c) => {
      const button = el('button', `${c.title} · ${statusLabel[c.status]?.split(' ·')[0] || c.status}`, 'task-session'); button.type = 'button'; button.title = button.textContent;
      button.onclick = () => open(c.id);
      return button;
    }));
  }

  function diffRows(rows) {
    return rows.map((line) => {
      const row = el('div', undefined, `task-diff-row ${line.kind}`);
      row.append(el('span', line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ', 'task-diff-numbers'),
        el('code', line.text.replace(/\r?\n$/, '')));
      return row;
    });
  }
  async function showDetail(set, op, holder, button) {
    if (holder.dataset.loaded) { holder.hidden = !holder.hidden; button.textContent = holder.hidden ? '내용 보기' : '내용 접기'; return; }
    button.disabled = true;
    try {
      const s = getScope();
      const d = await request({ action: 'detail', projectId: s.projectId, sessionId: s.sessionId, setId: set.id, opId: op.id });
      holder.replaceChildren();
      if (d.diff?.rows) { const box = el('div', undefined, 'task-diff'); box.append(...diffRows(d.diff.rows)); holder.append(el('p', `추가 ${d.diff.added}줄 · 삭제 ${d.diff.removed}줄`), box); }
      else if (d.diff?.tooLarge) holder.append(el('p', `파일이 커서(${d.diff.beforeLines} → ${d.diff.afterLines}줄) 줄 단위 비교를 생략했습니다.`));
      else if (typeof d.after === 'string') { const pre = el('pre', d.after); pre.className = 'task-change-text'; holder.append(pre); }
      else if (typeof d.before === 'string' && op.type === 'delete') { const pre = el('pre', d.before); pre.className = 'task-change-text'; holder.append(pre); }
      if (d.beforeImage || d.afterImage) {
        const wrap = el('div', undefined, 'task-change-images');
        for (const [label, src] of [['변경 전', d.beforeImage], ['변경 후', d.afterImage]]) {
          if (!src) continue;
          const figure = el('figure'); const img = document.createElement('img'); img.src = src; img.alt = `${op.path} ${label}`;
          figure.append(img, el('figcaption', label)); wrap.append(figure);
        }
        holder.append(wrap);
      }
      if (!holder.childNodes.length) holder.append(el('p', op.kind === 'binary' ? '문서·바이너리 파일이라 내용 미리보기를 제공하지 않습니다. 크기와 SHA-256으로 검증합니다.' : '표시할 내용이 없습니다.'));
      holder.dataset.loaded = '1'; holder.hidden = false; button.textContent = '내용 접기';
    } catch (error) { holder.replaceChildren(el('p', error.message)); holder.hidden = false; }
    finally { button.disabled = false; }
  }

  function display() {
    const fresh = sets().find((c) => c.id === opened?.id);
    if (fresh) opened = fresh;
    const c = opened;
    $('#taskChangeTitle').textContent = c.title;
    $('#taskChangeMeta').textContent = `파일 변경안 · ${new Date(c.createdAt).toLocaleString('ko-KR')} · 작업 ${c.ops.length}개\n${c.summary || ''}`;
    $('#taskChangeState').textContent = `${statusLabel[c.status] || c.status}${c.conflictReason ? ` — ${c.conflictReason}` : ''}`;
    $('#taskChangeOps').replaceChildren(...c.ops.map((op) => {
      const li = el('li'); li.dataset.type = op.type; li.dataset.state = op.state || 'queued';
      const head = el('div', undefined, 'task-change-head');
      head.append(el('span', typeIcon[op.type], 'task-change-icon'), el('strong', typeLabel[op.type]), el('code', op.to ? `${op.path} → ${op.to}` : op.path));
      const meta = el('small', [op.type === 'create' ? `새로 만듦 ${bytes(op.afterBytes)}` : op.type === 'modify' ? `${bytes(op.beforeBytes)} → ${bytes(op.afterBytes)}`
        : op.type === 'delete' ? `삭제 ${bytes(op.beforeBytes)} · 백업에서 복구 가능` : `크기 ${bytes(op.beforeBytes)}`,
        op.reason && `이유: ${op.reason}`, c.batch && op.state !== 'queued' && `진행: ${opStates[op.state] || op.state}${op.message ? ` · ${op.message}` : ''}`].filter(Boolean).join(' · '));
      const holder = el('div', undefined, 'task-change-detail'); holder.hidden = true;
      const button = el('button', '내용 보기'); button.type = 'button';
      button.onclick = () => showDetail(c, op, holder, button);
      li.append(head, meta, button, holder);
      return li;
    }));
    $('#taskChangeBatch').textContent = c.batch?.message || '';
    $('#taskChangeHistory').replaceChildren(...(c.history?.length ? [...c.history].reverse().map((h) => {
      const li = el('li', `${new Date(h.at).toLocaleString('ko-KR')} · ${h.kind === 'apply' ? '적용' : '복구'} ${{ succeeded: '성공', failed: '실패', partial: '부분 적용', blocked: '차단' }[h.result] || h.result}\n${h.message}`);
      li.dataset.result = h.result; return li;
    }) : [el('li', '아직 적용·복구 기록이 없습니다.')]));
    sync();
  }
  function sync() {
    const c = opened, running = !!getInfo()?.running;
    const decidable = ['pending', 'approved', 'conflict'].includes(c?.status);
    $('#taskChangeReject').disabled = busy || !decidable || c.status === 'rejected';
    $('#taskChangeApprove').disabled = busy || !c || !['pending'].includes(c.status);
    const applicable = ['approved', 'apply_failed'].includes(c?.status);
    const restorable = ['applied', 'partial', 'manual', 'restore_failed'].includes(c?.status);
    $('#taskChangeApply').hidden = !applicable; $('#taskChangeApply').disabled = busy || running || !applicable;
    $('#taskChangeRestore').hidden = !restorable; $('#taskChangeRestore').disabled = busy || running || !restorable;
  }

  async function open(id) {
    if (!sets().some((c) => c.id === id)) return;
    onOpen?.();
    const mine = ++sequence;
    opened = sets().find((c) => c.id === id);
    document.querySelector('#taskScreen').classList.add('task-proposal-open');
    view.hidden = false; $('#taskChangeProgress').textContent = '';
    display(); $('#taskChangeTitle').focus();
    try {
      const s = getScope();
      await request({ action: 'get', projectId: s.projectId, sessionId: s.sessionId, setId: id });
      if (mine === sequence) { await refreshInfo(); opened = sets().find((c) => c.id === id) || opened; display(); }
    } catch (error) { if (mine === sequence) $('#taskChangeProgress').textContent = error.message; }
  }
  function close() {
    sequence++; opened = null; view.hidden = true;
    if (dialog.open) dialog.close('cancel');
  }
  async function act(run) {
    if (!opened || busy) return;
    const mine = sequence, id = opened.id;
    busy = true; sync(); $('#taskChangeProgress').textContent = '';
    try { await run(id); } catch (error) { if (mine === sequence) $('#taskChangeProgress').textContent = error.message; }
    finally {
      busy = false;
      if (mine === sequence) { await refreshInfo(); opened = sets().find((c) => c.id === id) || opened; display(); onChanged?.(); }
    }
  }
  const base = (id) => { const s = getScope(); return { projectId: s.projectId, sessionId: s.sessionId, setId: id }; };
  $('#taskChangeApprove').onclick = () => act((id) => request({ action: 'decide', ...base(id), decision: 'approved' }));
  $('#taskChangeReject').onclick = () => act((id) => request({ action: 'decide', ...base(id), decision: 'rejected' }));
  async function prepare(kind) {
    if (!opened || busy) return;
    const mine = sequence, id = opened.id;
    busy = true; sync();
    $('#taskChangeProgress').textContent = '대상 파일과 백업을 확인하는 중… 아직 파일은 바뀌지 않습니다.';
    try {
      const result = await request({ action: `${kind}.prepare`, ...base(id) });
      if (mine !== sequence) return;
      const c = result.confirmation;
      pending = { kind, id, mine, confirmId: c.confirmId, ...base(id) };
      $('#taskChangeConfirmTitle').textContent = kind === 'apply' ? `${c.files.length}개 작업을 실제로 적용할까요?` : `${c.files.length}개 항목을 적용 전 상태로 복구할까요?`;
      $('#taskChangeConfirmDetails').replaceChildren(...[['프로젝트 폴더', c.folderName], ['변경안', c.title],
        ...c.files.map((f) => [`${typeLabel[f.type]}`, `${f.to ? `${f.path} → ${f.to}` : f.path}${kind === 'restore' ? (f.willRevert ? ' · 되돌림' : ' · 이미 원래 상태') : ''}`])]
        .flatMap(([term, value]) => [el('dt', term), el('dd', value)]));
      $('#taskChangeConfirmNotes').replaceChildren(...c.notes.map((n) => el('li', n)));
      $('#taskChangeConfirmWarning').textContent = kind === 'apply'
        ? (c.deletes ? `삭제 ${c.deletes}개가 포함되어 있습니다. 삭제된 파일은 백업에서 복구할 수 있습니다. ` : '') + '확인을 누르면 PC의 실제 파일을 변경합니다. 5분 안에 확인하지 않으면 다시 확인해야 합니다.'
        : '확인을 누르면 적용된 변경을 되돌립니다. 외부 변경이 하나라도 있으면 서버가 전체 복구를 차단합니다.';
      $('#taskChangeConfirmAccept').textContent = kind === 'apply' ? '적용하기' : '복구하기';
      $('#taskChangeProgress').textContent = '';
      dialog.returnValue = ''; dialog.showModal();
    } catch (error) { if (mine === sequence) $('#taskChangeProgress').textContent = `진행하지 않았습니다: ${error.message}`; }
    finally { busy = false; if (mine === sequence) { await refreshInfo(); display(); } }
  }
  $('#taskChangeApply').onclick = () => prepare('apply');
  $('#taskChangeRestore').onclick = () => prepare('restore');
  dialog.addEventListener('close', async () => {
    const c = pending; pending = null;
    if (!c || c.mine !== sequence) return;
    if (dialog.returnValue !== 'accept') { $('#taskChangeProgress').textContent = '취소했습니다. 실제 파일은 변경되지 않았습니다.'; return; }
    busy = true; sync();
    $('#taskChangeProgress').textContent = c.kind === 'apply' ? '적용 중… 원본 확인 → 백업 → 파일별 변경 → SHA-256 검증' : '복구 중… 현재 상태 확인 → 파일별 복구 → 검증';
    const body = { action: c.kind, projectId: c.projectId, sessionId: c.sessionId, setId: c.setId, confirmId: c.confirmId };
    try {
      let result;
      // A lost response is resent with the same confirmation; the server returns the recorded result, never a second write.
      try { result = await request(body); } catch (error) { if (!(error instanceof TypeError)) throw error; result = await request(body); }
      if (c.mine === sequence) $('#taskChangeProgress').textContent = `${c.kind === 'apply' ? '적용' : '복구'} 성공 · ${result.outcome.message}`;
    } catch (error) { if (c.mine === sequence) $('#taskChangeProgress').textContent = `${c.kind === 'apply' ? '적용' : '복구'} 실패: ${error.message}`; }
    finally { busy = false; if (c.mine === sequence) { await refreshInfo(); opened = sets().find((x) => x.id === c.setId) || opened; display(); onChanged?.(); } }
  });
  $('#taskChangeClose').onclick = () => { close(); onChanged?.(true); };
  return { open, close, renderList, isOpen: () => !!opened, refresh: () => { if (opened) display(); } };
}
