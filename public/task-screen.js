import { dotCharacters, dotCharacter } from './dot-characters.mjs';
import { drawDotTitle } from './dot-title.mjs';
import { createProgress } from './task-progress.mjs';
import { createChanges } from './task-changes.mjs';
import { createAttach, docPath } from './task-attach.mjs';
import { createImageUI } from './task-image.mjs';

const $ = (selector) => document.querySelector(selector);
const screen = $('#taskScreen'), app = $('#app'), chat = $('.chat');
const toggle = $('#taskBtn'), back = $('#taskBack'), input = $('#taskInput');
const sidebarToggle = $('#taskSidebarToggle'), status = $('#taskSaveStatus');
const projectName = $('#taskProjectName'), retry = $('#taskRetry');
let data = null, projectId = null, sessionId = null, busy = false, saving = null;
let pendingMessageId = null;
let failedCommand = null;
let aiInfo = null, aiTimer = null, previewFile = null, previewDocFile = null, previewImagePath = null, previewImageSrc = null, analysisContext = '';
const analysisFiles = new Set();
const analysisActive = () => ['preparing', 'running'].includes(session()?.analysis?.status);
const project = () => data?.projects.find((item) => item.id === projectId);
const session = () => project()?.sessions.find((item) => item.id === sessionId);
const dirty = () => !!session() && input.value !== session().draft;
let fileContext = '', fileGeneration = 0, previewGeneration = 0;
const fileTree = $('#taskFileTree');
let proposalContext = '', proposalSequence = 0, openedProposal = null, proposalBusy = false, pendingConfirmation = null;
const proposalLabels = { pending: '검토 대기', approved: '승인 · 적용 전', rejected: '거절', conflict: '충돌', applying: '적용 중',
  applied: '적용 완료', apply_failed: '적용 실패', restoring: '복구 중', restored: '복구 완료', restore_failed: '복구 실패' };
const fileStateLabels = { after: '현재 파일: 수정안 적용 내용과 같음', before: '현재 파일: 이전(원본) 내용과 같음',
  changed: '현재 파일: 적용 이후 다른 내용으로 변경됨', unavailable: '현재 파일: 확인할 수 없음' };
const historyResults = { succeeded: '성공', failed: '실패', blocked: '차단' };
const confirmDialog = $('#taskConfirm');
const shortHash = (value) => value ? `${value.slice(0, 12)}…` : '확인 불가';
const progress = (text) => { $('#taskProposalProgress').textContent = text; };

function syncProposalButtons() {
  const p = openedProposal;
  $('#taskProposalApprove').disabled = proposalBusy || p?.status !== 'pending';
  $('#taskProposalReject').disabled = proposalBusy || !['pending', 'conflict'].includes(p?.status);
  $('#taskProposalApply').disabled = proposalBusy || !!p?.planId || !(p?.status === 'approved' || (p?.status === 'apply_failed' && p.fileState === 'before'));
  const restorable = !p?.planId && ['applied', 'apply_failed', 'restore_failed', 'restored', 'restoring'].includes(p?.status);
  $('#taskProposalRestore').hidden = !restorable;
  $('#taskProposalRestore').disabled = proposalBusy || !restorable || !p.backup || p.fileState !== 'after'
    || !['applied', 'apply_failed', 'restore_failed'].includes(p.status);
}

function closeProposal() {
  proposalSequence++;
  openedProposal = null;
  pendingConfirmation = null;
  if (confirmDialog.open) confirmDialog.close('cancel');
  screen.classList.remove('task-proposal-open');
  $('#taskProposalView').hidden = true;
}

async function proposalRequest(body) {
  const response = await fetch('/api/tasks/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '수정안을 확인하지 못했습니다.');
  return result;
}

function renderProposalList() {
  const context = JSON.stringify([projectId, sessionId, project()?.folderPath]);
  if (context !== proposalContext) { closeProposal(); closePlan(); proposalContext = context; }
  const proposals = (aiInfo?.proposals || []).filter((p) => p.projectId === projectId && p.sessionId === sessionId && !p.planId);
  $('#taskProposalListStatus').textContent = aiInfo?.proposalWarnings?.join(' ') || (proposals.length ? '실제 파일은 최종 확인 후에만 바뀝니다.' : '아직 수정안이 없습니다.');
  $('#taskProposals').replaceChildren(...proposals.map((p) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'task-session';
    button.textContent = `${p.path} · ${proposalLabels[p.status]}`; button.title = button.textContent;
    button.onclick = () => openProposal(p.id);
    return button;
  }));
}

function displayProposal(p) {
  openedProposal = p;
  $('#taskProposalTitle').textContent = p.path.split('/').at(-1);
  $('#taskProposalMeta').textContent = `${p.path} · ${new Date(p.createdAt).toLocaleString('ko-KR')}`;
  const last = p.history?.at(-1);
  $('#taskProposalState').textContent = [
    p.planId && '작업 계획의 일부입니다 · 적용·복구는 작업 계획의 전체 적용·전체 변경 복구에서만 가능합니다.',
    p.status === 'approved' && !p.planId ? '승인됨 · 아직 실제 파일은 바뀌지 않았습니다. "실제 파일에 적용"에서 최종 확인 후 적용됩니다.' : proposalLabels[p.status],
    p.status === 'conflict' && p.conflictReason, ['apply_failed', 'restore_failed'].includes(p.status) && last && `${last.message} · ${last.recoverable}`,
    p.fileState && fileStateLabels[p.fileState],
  ].filter(Boolean).join(' · ');
  $('#taskProposalReason').textContent = p.reason;
  $('#taskProposalCounts').textContent = `서버 계산: 추가 ${p.diff.added}줄 · 삭제 ${p.diff.removed}줄`;
  $('#taskProposalBefore').textContent = p.before;
  $('#taskProposalAfter').textContent = p.after;
  $('#taskProposalHash').textContent = `원본 SHA-256: ${p.beforeHash}`;
  $('#taskProposalDiff').replaceChildren(...p.diff.rows.map((line) => {
    const row = document.createElement('div'); row.className = `task-diff-row ${line.kind}`;
    const numbers = document.createElement('span'); numbers.className = 'task-diff-numbers';
    numbers.textContent = `${line.before ?? '·'} → ${line.after ?? '·'} ${line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}`;
    const text = document.createElement('code');
    text.textContent = line.text.replace(/\r?\n$/, '') + (line.text.endsWith('\n') ? '' : ' ⟵ 줄 끝 개행 없음');
    row.append(numbers, text); return row;
  }));
  $('#taskProposalHistory').replaceChildren(...[...(p.history || [])].reverse().map((entry) => {
    const item = document.createElement('li'); item.dataset.result = entry.result;
    item.textContent = `${new Date(entry.at).toLocaleString('ko-KR')} · ${entry.kind === 'apply' ? '적용' : '복구'} ${historyResults[entry.result]} · ${entry.path}\n`
      + `작업 전 ${shortHash(entry.beforeHash)} → 작업 후 ${shortHash(entry.afterHash)}\n${entry.message}\n${entry.recoverable}`;
    return item;
  }));
  if (!p.history?.length) {
    const item = document.createElement('li'); item.textContent = '아직 실제 파일에 적용한 기록이 없습니다.';
    $('#taskProposalHistory').append(item);
  }
  syncProposalButtons();
  const summary = aiInfo?.proposals.find((item) => item.id === p.id);
  if (summary) summary.status = p.status;
  renderProposalList();
}

async function openProposal(id) {
  closePlan(); changesUI.close();
  const sequence = ++proposalSequence;
  const context = proposalContext;
  closePreview();
  openedProposal = null;
  screen.classList.add('task-proposal-open');
  $('#taskProposalView').hidden = false;
  $('#taskProposalTitle').textContent = '수정안 불러오는 중…';
  for (const selector of ['#taskProposalMeta', '#taskProposalReason', '#taskProposalState', '#taskProposalCounts', '#taskProposalHash', '#taskProposalBefore', '#taskProposalAfter', '#taskProposalProgress']) $(selector).textContent = '';
  $('#taskProposalDiff').replaceChildren();
  $('#taskProposalHistory').replaceChildren();
  syncProposalButtons();
  showSidebar(false); $('#taskProposalTitle').focus();
  try {
    const p = await proposalRequest({ action: 'get', projectId, sessionId, id });
    if (sequence === proposalSequence && context === proposalContext) displayProposal(p);
  } catch (error) {
    if (sequence === proposalSequence && context === proposalContext) $('#taskProposalState').textContent = error.message;
  }
}

async function decideProposal(decision) {
  if (!openedProposal || proposalBusy) return;
  const p = openedProposal, sequence = proposalSequence;
  proposalBusy = true;
  syncProposalButtons();
  try {
    const result = await proposalRequest({ action: 'decide', projectId: p.projectId, sessionId: p.sessionId, id: p.id, decision });
    if (sequence === proposalSequence) displayProposal(result);
  } catch (error) {
    if (sequence === proposalSequence) {
      const context = proposalContext;
      await openProposal(p.id);
      if (context === proposalContext && openedProposal?.id === p.id) {
        $('#taskProposalState').textContent = `${error.message} ${$('#taskProposalState').textContent}`;
      }
    }
  } finally { proposalBusy = false; syncProposalButtons(); }
}
$('#taskProposalApprove').onclick = () => decideProposal('approved');
$('#taskProposalReject').onclick = () => decideProposal('rejected');

// ---- Work plans: one reviewable job made of several per-file proposals (review/approve only in this stage) ----
const planLabels = { planned: '계획 수립됨 · 수정안 아직 없음', proposed: '수정안 검토 대기', approved: '전체 승인됨 · 실제 파일은 바뀌지 않음',
  applying: '적용 중…', applied: '전체 적용 완료 · 모든 파일이 수정안과 일치', apply_failed: '적용 실패 · 파일은 원본 상태(변경 없음 또는 롤백됨)',
  partial_applied: '부분 적용됨 · 복구가 필요합니다', restoring: '복구 중…', restored: '전체 변경 복구 완료 · 원본 SHA-256과 일치',
  restore_failed: '복구 실패 · 일부 파일만 복구된 상태입니다', manual: '수동 확인 필요 · 자동으로 덮어쓰지 않았습니다',
  rejected: '전체 거절됨', partial: '일부 승인·거절됨 · 파일별 상태를 확인하세요', conflict: '원본 충돌 · 새 계획이 필요합니다', invalid: '수정안 검증 실패' };
const batchStates = { queued: '대기', backed_up: '백업 완료', staged: '임시 파일 준비됨', replacing: '교체 중', applied: '적용됨', reverting: '복구 중',
  reverted: '원본으로 복구됨', failed: '변경 없음(실패)', unknown: '상태 확인 불가', revert_failed: '복구 실패' };
let openedPlan = null, planSequence = 0, planBusy = false, planPending = null;
const planList = () => (aiInfo?.plans || []).filter((p) => p.projectId === projectId && p.sessionId === sessionId);

function closePlan() {
  planSequence++; openedPlan = null;
  if (!openedProposal) screen.classList.remove('task-proposal-open');
  $('#taskPlanView').hidden = true;
}

async function planRequest(body) {
  const response = await fetch('/api/tasks/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '작업 계획을 확인하지 못했습니다.');
  return result;
}

function renderPlanList() {
  const plans = planList();
  $('#taskPlanListStatus').textContent = plans.length ? '계획은 실제 탐색 결과를 기반으로 하며 파일은 바뀌지 않습니다.' : '아직 작업 계획이 없습니다.';
  $('#taskPlans').replaceChildren(...plans.map((p) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'task-session';
    button.textContent = `${p.goal} · ${planLabels[p.status]}`; button.title = button.textContent;
    button.onclick = () => openPlan(p.id);
    return button;
  }));
}

function syncPlanButtons() {
  const p = openedPlan, running = !!aiInfo?.running || analysisActive();
  const members = p ? p.files.filter((f) => f.proposalId) : [];
  $('#taskPlanGenerate').disabled = planBusy || running || !p || p.status !== 'planned' || !p.files.length || !$('#taskPlanConsent').checked
    || project()?.folder.state !== 'connected' || !selectedProvider()?.available || !supports('plan.proposals');
  $('#taskPlanGenerate').hidden = !!members.length;
  const locked = !!p?.batch;
  $('#taskPlanApprove').disabled = planBusy || locked || !members.length || p.files.some((f) => f.error) || ['approved', 'conflict'].includes(p.status);
  $('#taskPlanReject').disabled = planBusy || locked || !members.length || p.status === 'rejected';
  const applicable = ['approved', 'apply_failed'].includes(p?.status);
  const restorable = ['applied', 'partial_applied', 'manual', 'restore_failed'].includes(p?.status);
  $('#taskPlanApply').hidden = !applicable; $('#taskPlanApply').disabled = planBusy || running || !applicable;
  $('#taskPlanRestore').hidden = !restorable; $('#taskPlanRestore').disabled = planBusy || running || !restorable;
  $('#taskPlanConsent').disabled = planBusy || running;
}

function displayPlan() {
  const fresh = planList().find((item) => item.id === openedPlan?.id);
  if (fresh) openedPlan = fresh;
  const p = openedPlan;
  $('#taskPlanTitle').textContent = p.goal;
  $('#taskPlanMeta').textContent = `작업 계획 · ${new Date(p.createdAt).toLocaleString('ko-KR')} · 수정 대상 ${p.files.length}개 (최대 3개)`;
  const execution = session()?.analysis;
  const generating = execution?.mode === 'plan.proposals' && ['preparing', 'running'].includes(execution.status);
  $('#taskPlanState').textContent = generating ? 'Claude가 여러 파일 수정안을 생성 중입니다…' : planLabels[p.status];
  const items = (list) => (list.length ? list : ['없음']).map((text) => { const li = document.createElement('li'); li.textContent = text; return li; });
  $('#taskPlanIssues').replaceChildren(...items(p.issues));
  $('#taskPlanRisks').replaceChildren(...items(p.risks));
  $('#taskPlanFiles').replaceChildren(...(p.files.length ? p.files.map((f) => {
    const li = document.createElement('li');
    li.dataset.state = f.error ? 'invalid' : f.proposalStatus || 'planned';
    const name = document.createElement('strong'); name.textContent = f.path;
    const reason = document.createElement('span'); reason.textContent = `이유: ${f.reason}`;
    const change = document.createElement('span'); change.textContent = `예상 변경: ${f.change}`;
    const state = document.createElement('small');
    const stage = p.batch?.files.find((b) => b.proposalId === f.proposalId);
    state.textContent = stage ? `적용 진행 상태: ${batchStates[stage.state] || stage.state}${stage.message ? ` · ${stage.message}` : ''} · 추가 ${f.added}줄 · 삭제 ${f.removed}줄`
      : f.error ? `검증 실패: ${f.error}` : f.proposalId
      ? `${f.proposalStatus === 'approved' ? '승인됨 · 전체 적용 전' : proposalLabels[f.proposalStatus] || ''} · 추가 ${f.added}줄 · 삭제 ${f.removed}줄` : '수정안 생성 전';
    li.append(name, reason, change, state);
    if (f.proposalId) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '변경 전후 비교 보기';
      button.onclick = () => openProposal(f.proposalId); li.append(button);
    }
    return li;
  }) : [Object.assign(document.createElement('li'), { textContent: '수정이 필요한 파일이 없다고 판단했습니다.' })]));
  $('#taskPlanBatch').textContent = p.batch?.message || '';
  $('#taskPlanHistory').replaceChildren(...[...(p.history || [])].reverse().map((entry) => {
    const item = document.createElement('li'); item.dataset.result = entry.result;
    item.textContent = `${new Date(entry.at).toLocaleString('ko-KR')} · ${entry.kind === 'apply' ? '전체 적용' : '전체 복구'} ${{ succeeded: '성공', failed: '실패', partial: '부분 적용', blocked: '차단' }[entry.result] || entry.result}\n${entry.message}`
      + (entry.files?.length ? `\n${entry.files.map((x) => `${x.path}: ${batchStates[x.state] || x.state}`).join(' · ')}` : '');
    return item;
  }));
  if (!p.history?.length) $('#taskPlanHistory').replaceChildren(Object.assign(document.createElement('li'), { textContent: '아직 적용·복구 기록이 없습니다.' }));
  syncPlanButtons();
}

async function openPlan(id) {
  if (!planList().some((item) => item.id === id)) return;
  closePreview(); closeProposal(); changesUI.close();
  const sequence = ++planSequence;
  openedPlan = planList().find((item) => item.id === id);
  $('#taskPlanConsent').checked = project()?.analysisConsent === true;
  screen.classList.add('task-proposal-open');
  $('#taskPlanView').hidden = false;
  $('#taskPlanProgress').textContent = '';
  displayPlan(); showSidebar(false); $('#taskPlanTitle').focus();
  try {
    await planRequest({ action: 'get', projectId, sessionId, planId: id });
    if (sequence === planSequence) { await refreshPlanData(); openedPlan = planList().find((item) => item.id === id) || openedPlan; displayPlan(); }
  } catch (error) { if (sequence === planSequence) $('#taskPlanProgress').textContent = error.message; }
}

async function refreshPlanData() { try { aiInfo = await aiRequest(); } catch { /* the next poll retries */ } }

async function planAction(run) {
  if (!openedPlan || planBusy) return;
  const sequence = planSequence, id = openedPlan.id;
  planBusy = true; syncPlanButtons(); $('#taskPlanProgress').textContent = '';
  try { await run(id); } catch (error) { if (sequence === planSequence) $('#taskPlanProgress').textContent = error.message; }
  finally {
    planBusy = false;
    if (sequence === planSequence) { await refreshPlanData(); openedPlan = planList().find((item) => item.id === id) || openedPlan; displayPlan(); renderAI(); }
  }
}
for (const [button, decision] of [['#taskPlanApprove', 'approved'], ['#taskPlanReject', 'rejected']]) {
  $(button).onclick = () => planAction((id) => planRequest({ action: 'decide', projectId, sessionId, planId: id, decision }));
}
$('#taskPlanGenerate').onclick = () => planAction(async (id) => {
  await flushDraft();
  aiInfo = await aiRequest({ action: 'start', mode: 'plan.proposals', planId: id, provider: $('#taskAISelect').value, projectId, sessionId,
    consent: $('#taskPlanConsent').checked, files: [] });
  data = aiInfo.state; scheduleAI();
});
$('#taskPlanConsent').onchange = syncPlanButtons;

// Step 1 reads and verifies only and issues a single-use confirmation; files change only after the dialog is accepted.
async function preparePlanChange(kind) {
  if (!openedPlan || planBusy) return;
  const sequence = planSequence, id = openedPlan.id;
  planBusy = true; syncPlanButtons();
  $('#taskPlanProgress').textContent = '대상 파일과 백업을 확인하는 중… 아직 파일은 바뀌지 않습니다.';
  try {
    const result = await planRequest({ action: `${kind}.prepare`, projectId, sessionId, planId: id });
    if (sequence !== planSequence) return;
    const c = result.confirmation;
    planPending = { kind, planId: id, projectId, sessionId, confirmId: c.confirmId, sequence };
    $('#taskConfirmTitle').textContent = kind === 'apply' ? `${c.files.length}개 파일을 실제로 적용할까요?` : `${c.files.length}개 파일을 이전 버전으로 복구할까요?`;
    $('#taskConfirmDetails').replaceChildren(...[['프로젝트 폴더', c.folderName], ['작업 목표', c.goal], ...c.files.map((f) => [f.path, kind === 'apply'
      ? `추가 ${f.added}줄 · 삭제 ${f.removed}줄 · ${f.beforeBytes.toLocaleString('ko-KR')} → ${f.afterBytes.toLocaleString('ko-KR')} bytes\n원본 ${shortHash(f.beforeHash)} → 적용 후 ${shortHash(f.afterHash)}`
      : `${f.changed ? '적용된 내용을 원본으로 복구' : '이미 원본과 같음'} · 복구 후 ${shortHash(f.restoredHash)}`])]
      .flatMap(([term, value]) => { const dt = document.createElement('dt'); dt.textContent = term; const dd = document.createElement('dd'); dd.textContent = value; return [dt, dd]; }));
    $('#taskConfirmNotes').replaceChildren(...c.notes.map((note) => Object.assign(document.createElement('li'), { textContent: note })));
    $('#taskConfirmWarning').textContent = kind === 'apply'
      ? '확인을 누르면 모든 원본을 백업한 뒤 PC의 실제 파일을 변경합니다. 5분 안에 확인하지 않으면 다시 확인해야 합니다.'
      : '확인을 누르면 적용된 파일을 백업된 원본으로 되돌립니다. 외부 변경이 하나라도 있으면 서버가 전체 복구를 차단합니다.';
    $('#taskConfirmAccept').textContent = kind === 'apply' ? '전체 적용하기' : '전체 복구하기';
    $('#taskPlanProgress').textContent = '';
    confirmDialog.returnValue = '';
    confirmDialog.showModal();
  } catch (error) {
    if (sequence === planSequence) $('#taskPlanProgress').textContent = `진행하지 않았습니다: ${error.message}`;
  } finally { planBusy = false; if (sequence === planSequence) { await refreshPlanData(); displayPlan(); } }
}
$('#taskPlanApply').onclick = () => preparePlanChange('apply');
$('#taskPlanRestore').onclick = () => preparePlanChange('restore');
confirmDialog.addEventListener('close', async () => {
  const c = planPending;
  planPending = null;
  if (!c || c.sequence !== planSequence) return;
  if (confirmDialog.returnValue !== 'accept') { $('#taskPlanProgress').textContent = '취소했습니다. 실제 파일은 변경되지 않았습니다.'; return; }
  planBusy = true; syncPlanButtons();
  $('#taskPlanProgress').textContent = c.kind === 'apply' ? '적용 중… 원본 확인 → 전체 백업 → 임시 파일 준비 → 파일별 교체 → 검증' : '복구 중… 백업·현재 파일 확인 → 파일별 교체 → 검증';
  const body = { action: c.kind, projectId: c.projectId, sessionId: c.sessionId, planId: c.planId, confirmId: c.confirmId };
  try {
    let result;
    // A lost response is resent with the same confirmation; the server returns the recorded result, never a second write.
    try { result = await planRequest(body); } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      result = await planRequest(body);
    }
    if (c.sequence === planSequence) $('#taskPlanProgress').textContent = `${c.kind === 'apply' ? '전체 적용' : '전체 복구'} 성공 · ${result.outcome.message}`;
  } catch (error) {
    if (c.sequence === planSequence) $('#taskPlanProgress').textContent = `${c.kind === 'apply' ? '전체 적용' : '전체 복구'} 실패: ${error.message}`;
  } finally {
    planBusy = false;
    if (c.sequence === planSequence) { await refreshPlanData(); openedPlan = planList().find((item) => item.id === c.planId) || openedPlan; displayPlan(); renderAI(); }
  }
});
$('#taskPlanClose').onclick = closePlan;

function confirmRows(c) {
  const rows = c.kind === 'apply' ? [
    ['프로젝트 폴더', c.folderName], ['대상 파일', c.path], ['변경 요약', `추가 ${c.added}줄 · 삭제 ${c.removed}줄`],
    ['크기', `${c.beforeBytes.toLocaleString('ko-KR')} → ${c.afterBytes.toLocaleString('ko-KR')} bytes`],
    ['원본 SHA-256', c.beforeHash], ['적용 후 SHA-256', c.afterHash],
  ] : [
    ['프로젝트 폴더', c.folderName], ['대상 파일', c.path],
    ['적용 시각', c.appliedAt ? new Date(c.appliedAt).toLocaleString('ko-KR') : '기록 없음'],
    ['현재 SHA-256', c.currentHash], ['복구 후 SHA-256', c.restoredHash], ['백업 크기', `${c.backupBytes.toLocaleString('ko-KR')} bytes`],
  ];
  return rows.flatMap(([term, value]) => {
    const dt = document.createElement('dt'); dt.textContent = term;
    const dd = document.createElement('dd'); dd.textContent = value;
    return [dt, dd];
  });
}

// Step 1 only reads and issues a single-use confirmation; the file changes only after the dialog is accepted.
async function prepareFileChange(kind) {
  if (!openedProposal || proposalBusy) return;
  const p = openedProposal, sequence = proposalSequence;
  proposalBusy = true; syncProposalButtons();
  progress('최종 확인 정보를 확인하는 중… 아직 파일은 바뀌지 않습니다.');
  try {
    const result = await proposalRequest({ action: `${kind}.prepare`, projectId: p.projectId, sessionId: p.sessionId, id: p.id });
    if (sequence !== proposalSequence) return;
    displayProposal(result);
    const c = result.confirmation;
    pendingConfirmation = { ...c, projectId: p.projectId, sessionId: p.sessionId, id: p.id, sequence };
    $('#taskConfirmTitle').textContent = kind === 'apply' ? '실제 파일에 적용할까요?' : '이전 버전으로 복구할까요?';
    $('#taskConfirmDetails').replaceChildren(...confirmRows(c));
    $('#taskConfirmNotes').replaceChildren(...(c.notes || []).map((note) => {
      const li = document.createElement('li'); li.textContent = note; return li;
    }));
    $('#taskConfirmWarning').textContent = kind === 'apply'
      ? '확인을 누르면 원본을 백업한 뒤 PC의 실제 파일 1개를 변경합니다. 5분 안에 확인하지 않으면 다시 확인해야 합니다.'
      : '확인을 누르면 현재 파일(수정안 적용본)을 백업된 원본으로 되돌립니다. 적용 이후 파일이 바뀌었다면 서버가 복구를 차단합니다.';
    $('#taskConfirmAccept').textContent = kind === 'apply' ? '적용하기' : '복구하기';
    progress('');
    confirmDialog.returnValue = '';
    confirmDialog.showModal();
  } catch (error) {
    if (sequence === proposalSequence) {
      await openProposal(p.id);
      if (sequence + 1 === proposalSequence) progress(`진행하지 않았습니다: ${error.message}`);
    }
  } finally { proposalBusy = false; syncProposalButtons(); }
}
$('#taskProposalApply').onclick = () => prepareFileChange('apply');
$('#taskProposalRestore').onclick = () => prepareFileChange('restore');

confirmDialog.addEventListener('close', async () => {
  const c = pendingConfirmation;
  pendingConfirmation = null;
  if (!c || c.sequence !== proposalSequence) return;
  if (confirmDialog.returnValue !== 'accept') { progress('취소했습니다. 실제 파일은 변경되지 않았습니다.'); return; }
  proposalBusy = true; syncProposalButtons();
  progress(c.kind === 'apply' ? '적용 중… 원본 확인 → 백업 → 임시 파일 저장 → 교체 → 검증' : '복구 중… 백업 확인 → 현재 파일 확인 → 교체 → 검증');
  const body = { action: c.kind, projectId: c.projectId, sessionId: c.sessionId, id: c.id, confirmId: c.confirmId };
  try {
    let result;
    // A lost response is resent with the same confirmation; the server returns the recorded result, never a second write.
    try { result = await proposalRequest(body); } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      result = await proposalRequest(body);
    }
    if (c.sequence !== proposalSequence) return;
    displayProposal(result);
    const o = result.outcome;
    progress(`${c.kind === 'apply' ? '적용' : '복구'} 성공 · ${o.path}\n작업 전 SHA-256 ${o.beforeHash}\n작업 후 SHA-256 ${o.afterHash}\n${o.message}`);
  } catch (error) {
    if (c.sequence !== proposalSequence) return;
    await openProposal(c.id);
    if (c.sequence + 1 === proposalSequence) progress(`${c.kind === 'apply' ? '적용' : '복구'} 실패: ${error.message}`);
  } finally { proposalBusy = false; syncProposalButtons(); }
});
$('#taskProposalClose').onclick = () => { closeProposal(); back.focus(); };

async function fileRequest(action, path) {
  const response = await fetch('/api/tasks/files', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, projectId, path }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '파일 조회에 실패했습니다.');
  return value;
}

function closePreview() {
  previewFile = null;
  previewGeneration++;
  screen.classList.remove('task-preview-open');
  $('#taskFilePreview').hidden = true;
  $('#taskPreviewText').textContent = '';
  $('#taskAnalyzeFile').disabled = true;
}

async function openFilePreview(relative) {
  if (busy) return;
  closeProposal(); changesUI.close(); screen.classList.remove('task-proposal-open');
  const generation = ++previewGeneration;
  const context = fileGeneration;
  screen.classList.add('task-preview-open');
  $('#taskFilePreview').hidden = false;
  $('#taskPreviewName').textContent = relative.split('/').at(-1);
  $('#taskPreviewMeta').textContent = relative;
  $('#taskPreviewNotice').textContent = '파일 확인 중…';
  $('#taskPreviewText').hidden = true;
  $('#taskPreviewText').textContent = '';
  previewFile = null; previewDocFile = null; $('#taskDocFile').hidden = true; $('#taskPreviewImage').hidden = true; $('#taskImageFile').hidden = true; $('#taskPreviewFacts').hidden = true;
  $('#taskAnalyzeFile').disabled = true;
  showSidebar(false);
  $('#taskPreviewName').focus();
  try {
    const file = await fileRequest('read', relative);
    if (context !== fileGeneration || generation !== previewGeneration) return;
    $('#taskPreviewName').textContent = file.name;
    $('#taskPreviewMeta').textContent = `${file.path} · ${file.size.toLocaleString('ko-KR')} bytes · 읽기 전용`;
    $('#taskPreviewNotice').textContent = file.kind === 'text' ? 'UTF-8 텍스트 · AI에 전달하지 않습니다.' : file.reason;
    $('#taskPreviewImage').hidden = file.kind !== 'image'; $('#taskImageFile').hidden = file.kind !== 'image'; $('#taskPreviewFacts').hidden = file.kind !== 'image';
    if (file.kind === 'image') {
      $('#taskPreviewImage').src = file.dataUrl; $('#taskPreviewImage').alt = file.name; previewImagePath = file.path; previewImageSrc = file.dataUrl;
      const f = file.image;
      $('#taskPreviewNotice').textContent = '이미지 · 읽기 전용 · AI에 전달하지 않습니다.';
      $('#taskPreviewFacts').textContent = [`${f.format} · ${f.width}×${f.height}px (${f.megapixels}MP) · ${(f.bytes / 1024).toFixed(1)}KB`, f.hasAlpha !== undefined && (f.hasAlpha ? '투명도 있음' : '투명도 없음'), f.exif && [f.exif.make, f.exif.model, f.exif.dateTimeOriginal].filter(Boolean).join(' · '), f.privacyNote && `⚠ ${f.privacyNote}`].filter(Boolean).join('\n');
    }
    $('#taskPreviewText').hidden = file.kind !== 'text';
    $('#taskPreviewText').textContent = file.kind === 'text' ? file.text : '';
    previewFile = file.kind === 'text' && file.size <= 32768 ? file.path : null;
    $('#taskAnalyzeFile').disabled = !previewFile || analysisActive();
    const docCandidate = docPath(file.path) || (file.kind !== 'text' && /256KB/.test(file.reason || '') && /\.(txt|md|csv|tsv|json|jsonl|log|xml|html?|ya?ml)$/i.test(file.path));
    $('#taskDocFile').hidden = !docCandidate; $('#taskDocFile').disabled = analysisActive(); previewDocFile = docCandidate ? file.path : null;
  } catch (error) {
    if (context === fileGeneration && generation === previewGeneration) $('#taskPreviewNotice').textContent = error.message;
  }
}

function fileNodes(list, context) {
  const nodes = list.entries.map((entry) => {
    const li = document.createElement('li');
    if (entry.type === 'folder' && !entry.blocked) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = entry.name; summary.title = entry.path;
      const children = document.createElement('ul');
      let loaded = false, loading = false;
      details.append(summary, children);
      details.addEventListener('toggle', async () => {
        if (!details.open || loaded || loading || context !== fileGeneration) return;
        loading = true;
        const note = document.createElement('li'); note.textContent = '불러오는 중…';
        children.replaceChildren(note);
        try {
          const result = await fileRequest('list', entry.path);
          if (context !== fileGeneration) return;
          children.replaceChildren(...fileNodes(result, context));
          loaded = true;
        } catch (error) {
          if (context === fileGeneration) note.textContent = `${error.message} 접었다 펼치면 다시 조회합니다.`;
        } finally { loading = false; }
      });
      li.append(details);
    } else {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = `${entry.blocked ? '⊘' : '·'} ${entry.name}`;
      button.title = entry.blocked || entry.path; button.disabled = !!entry.blocked;
      button.onclick = () => openFilePreview(entry.path);
      li.append(button);
    }
    return li;
  });
  if (!nodes.length || list.truncated) {
    const note = document.createElement('li');
    note.className = 'task-file-note';
    note.textContent = list.truncated ? `항목이 많아 처음 ${list.limit}개 범위만 표시합니다.` : '표시할 항목이 없습니다.';
    nodes.push(note);
  }
  return nodes;
}

async function refreshFiles() {
  const context = ++fileGeneration;
  closePreview();
  fileTree.replaceChildren();
  if (project()?.folder.state !== 'connected') {
    $('#taskFileStatus').textContent = project()?.folder.error || '폴더를 연결하면 파일 목록이 표시됩니다.';
    return;
  }
  $('#taskFileStatus').textContent = '최상위 항목 불러오는 중…';
  try {
    const list = await fileRequest('list', '');
    if (context !== fileGeneration) return;
    fileTree.replaceChildren(...fileNodes(list, context));
    $('#taskFileStatus').textContent = '폴더를 펼쳐 탐색하세요. .git · node_modules · dist · build 제외';
  } catch (error) {
    if (context === fileGeneration) $('#taskFileStatus').textContent = error.message;
  }
}

function syncFiles() {
  const context = JSON.stringify([projectId, project()?.folderPath, project()?.folder.state]);
  if (context === fileContext) return;
  fileContext = context;
  refreshFiles();
}

$('#taskFilesRefresh').onclick = () => refreshFiles();
$('#taskImageFile').onclick = () => { if (previewImagePath) { imageUI.addProjectImage(previewImagePath, previewImageSrc); $('#taskPreviewNotice').textContent = '이미지 작업 목록에 추가했습니다. 화면 아래 첨부 영역의 이미지 작업을 여세요.'; } };
$('#taskDocFile').onclick = () => {
  if (!previewDocFile || analysisActive()) return;
  attachUI.addProjectFile(previewDocFile);
  $('#taskPreviewNotice').textContent = '문서 분석 목록에 추가했습니다. 화면 아래 첨부·문서 분석 영역에서 실행하세요.';
};
$('#taskAnalyzeFile').onclick = () => {
  if (!previewFile || analysisActive()) return;
  if (analysisFiles.size >= 5 && !analysisFiles.has(previewFile)) {
    $('#taskPreviewNotice').textContent = '분석할 파일은 최대 5개입니다.'; return;
  }
  analysisFiles.add(previewFile);
  closePreview();
  renderAI();
};
$('#taskPreviewClose').onclick = () => {
  closePreview();
  (matchMedia('(max-width: 680px)').matches ? sidebarToggle : $('#taskFilesRefresh')).focus();
};

function showSidebar(open) {
  screen.classList.toggle('task-sidebar-open', open);
  sidebarToggle.setAttribute('aria-expanded', String(open));
}

async function request(body) {
  const response = await fetch('/api/tasks', body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '작업대 저장에 실패했습니다.');
  return value;
}

function errorStatus(error) {
  status.textContent = `저장되지 않았습니다: ${error.message}`;
  retry.hidden = false;
}

function savedStatus() {
  status.textContent = data?.warnings.length ? data.warnings.join(' ') : session() ? '이 PC에 저장됨' : '프로젝트를 만들어 시작하세요';
  retry.hidden = true;
}

const selectedProvider = () => aiInfo?.providers?.find((p) => p.id === $('#taskAISelect').value) || aiInfo?.providers?.[0];
const supports = (mode) => { const p = selectedProvider(); return !!p?.available && (!p.modes?.length || p.modes.includes(mode)); };
function renderProviders() {
  const select = $('#taskAISelect');
  if (!aiInfo?.providers?.length) return;
  const wanted = select.value || 'claude';
  const options = aiInfo.providers.map((p) => {
    const option = document.createElement('option');
    option.value = p.id; option.disabled = !p.available;
    option.textContent = `${p.name}${!p.available ? ' · 설치 안 됨' : p.verified ? '' : ' · 연결 확인 필요'}`;
    return option;
  });
  const signature = JSON.stringify(options.map((o) => [o.value, o.textContent, o.disabled]));
  if (select.dataset.signature !== signature) { select.replaceChildren(...options); select.dataset.signature = signature; }
  select.value = aiInfo.providers.some((p) => p.id === wanted && p.available) ? wanted : (aiInfo.providers.find((p) => p.available)?.id || 'claude');
}
function renderAI() {
  renderProviders();
  const context = JSON.stringify([projectId, sessionId, project()?.folderPath]);
  if (analysisContext !== context) { analysisFiles.clear(); analysisContext = context; }
  $('#taskAnalysisFiles').replaceChildren(...[...analysisFiles].map((file) => {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = `${file} ×`; button.title = 'AI 분석 목록에서 제거';
    button.disabled = analysisActive();
    button.onclick = () => { analysisFiles.delete(file); renderAI(); };
    return button;
  }));
  const execution = session()?.analysis;
  const explore = ['explore', 'plan', 'changes'].includes(execution?.mode) ? execution.explore : null;
  if (explore) {
    $('#taskAnalysisFiles').textContent = explore.files.length ? `자동 탐색에서 읽은 파일 (${explore.files.length}개): ${explore.files.map((file) => file.path).join(', ')}` : '자동 탐색에서 아직 읽은 파일이 없습니다.';
  } else if (!analysisFiles.size) $('#taskAnalysisFiles').textContent = '미리보기에서 분석·수정안 대상 파일을 추가하세요. 수정안은 파일 1개만 선택하세요. 자동 탐색 분석은 파일 선택이 필요 없습니다.';
  const labels = { preparing: 'CLI 권한·로그인 확인 중…', running: 'Claude 분석 중…', completed: '실제 AI 답변 저장 완료', failed: 'AI 실행 실패', cancelled: 'AI 실행 취소됨' };
  if (execution?.mode === 'explore') { labels.running = explore ? `자동 탐색 중 · ${explore.phase} (AI ${explore.calls}회 · 조회 ${explore.operations}회 · 읽은 파일 ${explore.files.length}개)` : '자동 탐색 시작 중…'; labels.completed = `자동 탐색 분석 완료 · 읽은 파일 ${explore?.files.length ?? 0}개를 기록했습니다.`; }
  if (execution?.mode === 'plan') { labels.running = explore ? `작업 계획 조사 중 · ${explore.phase} (AI ${explore.calls}회 · 조회 ${explore.operations}회 · 읽은 파일 ${explore.files.length}개)` : '작업 계획 조사 시작 중…'; labels.completed = '작업 계획 저장 완료 · 대화의 작업 계획 보기에서 검토하세요.'; }
  if (execution?.mode === 'image') { labels.running = '이미지 생성·편집 요청 중… (최대 4분, 취소할 수 있습니다)'; labels.completed = '이미지 결과를 변경안으로 저장했습니다 · 변경안 보기에서 미리보기를 확인하세요.'; }
  if (execution?.mode === 'image.analyze') { labels.running = '이미지를 분석하는 중…'; labels.completed = '이미지 분석 완료'; }
  if (execution?.mode === 'docs') { labels.running = '문서를 변환·요약하는 중… (진행 상황은 위 작업 진행 패널을 보세요)'; labels.completed = '문서 분석 완료 · 답변 끝의 분석 범위를 확인하세요.'; }
  if (execution?.mode === 'changes') { labels.running = explore ? `파일 변경안 조사 중 · ${explore.phase} (AI ${explore.calls}회 · 조회 ${explore.operations}회 · 읽은 파일 ${explore.files.length}개)` : '파일 변경안 조사 시작 중…'; labels.completed = '파일 변경안 저장 완료 · 변경안 보기에서 검토하세요. 아직 파일은 바뀌지 않았습니다.'; }
  if (execution?.mode === 'plan.proposals') { labels.running = 'Claude가 계획된 파일의 수정안을 생성 중…'; labels.completed = '여러 파일 수정안 저장 완료 · 작업 계획에서 검토하세요.'; }
  if (execution?.mode === 'proposal') { labels.running = 'Claude 수정안 생성 중…'; labels.completed = '수정안 저장 완료 · 대화의 수정안 보기에서 비교하세요.'; }
  $('#taskAIStatus').textContent = aiInfo?.storageError || (execution ? `${labels[execution.status]}${execution.error ? ` · ${execution.error}` : ''}`
    : selectedProvider()?.available ? `${selectedProvider().name} · 실행 시 로그인과 안전 설정 확인${selectedProvider().modes?.length && selectedProvider().modes.length < 7 ? ` · 지원 작업: ${selectedProvider().modes.join(', ')}` : ''}` : '선택한 AI CLI가 없거나 연결 상태를 확인하지 못했습니다.');
  if (aiInfo?.running && !analysisActive()) $('#taskAIStatus').textContent = '다른 세션에서 AI가 실행 중입니다.';
  renderTeamPick();
  renderDrawer();
  renderProposalList();
  renderPlanList();
  changesUI.renderList();
  attachUI.render();
  imageUI.renderProviders(); imageUI.render();
  if (changesUI.isOpen()) changesUI.refresh();
  if (openedPlan) displayPlan();
  controls();
}

const permission = () => project()?.permission || 'default';
const consentOK = () => $('#taskAIConsent').checked || (permission() === 'auto' && project()?.analysisConsent === true);
const PERSONA = { claude: { avatar: 'claude', name: 'Claude' }, codex: { avatar: 'gpt', name: 'ChatGPT (Codex)' }, gemini: { avatar: 'gemini', name: 'Gemini' } };
const FINAL_OF = { taskExploreRun: 'explore', taskAIRun: 'analysis', taskPlanRun: 'plan', taskChangesRun: 'changes' };
const ACTION_LABEL = { taskExploreRun: '자동 탐색 분석', taskAIRun: '선택 파일 분석', taskChangesRun: '파일·문서 변경안', taskPlanRun: '작업 계획', taskProposalGenerate: '수정안 생성' };
const teamPicked = new Set();
const workMode = () => $('#taskModeSelect').value;
// Expected AI calls for what is selected now (the explore budget grows with the task's difficulty).
function estimate() {
  const action = $('#taskActionSelect').value, single = action === 'taskAIRun' || action === 'taskProposalGenerate' ? '1회' : '5~10회';
  if (workMode() === 'solo') return `예상 AI 호출: ${single}`;
  const n = teamPicked.size;
  return workMode() === 'split' ? `예상 AI 호출: 역할 ${n}회 + 최종 통합 ${single}` : `예상 AI 호출: 독립 의견 ${n}회 + 교차 검토 ${n}회 + 최종 통합 ${single}`;
}
// 'ask' permission: nothing runs before the owner confirms AI, work and expected calls.
function gate(body) {
  if (!body || !['start', 'context.compress'].includes(body.action) || permission() !== 'ask') return body;
  const who = body.mode === 'team' ? body.team.providers.map((id) => PERSONA[id]?.name || id).join(' · ') : PERSONA[body.provider]?.name || body.provider;
  const what = body.action === 'context.compress' ? '대화 압축 (AI 1회)' : body.mode === 'team' ? `${body.team.style === 'split' ? '분담' : '협업'} · 최종 ${body.team.final}` : body.mode || 'analysis';
  if (!confirm(`[권한 요청] 이 작업을 실행할까요?\n\nAI: ${who}\n작업: ${what}\n${body.action === 'context.compress' ? '' : estimate()}\n\n요청·선택 자료가 해당 AI 서비스로 전송됩니다. 파일 적용·복구는 이후 별도의 최종 확인을 받습니다.`)) throw new Error('실행을 취소했습니다.');
  return { ...body, confirmed: true };
}
async function aiRequest(body) {
  body = gate(body);
  const response = await fetch('/api/tasks/ai', body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'AI 요청에 실패했습니다.');
  return value;
}

function scheduleAI() {
  clearTimeout(aiTimer);
  if ((aiInfo?.running || analysisActive()) && !screen.hidden) aiTimer = setTimeout(refreshAI, 1000);
}

async function refreshAI() {
  if (busy || saving || dirty()) { aiTimer = setTimeout(refreshAI, 1000); return; }
  try {
    aiInfo = await aiRequest();
    // Keep this browser's selected project and its draft; another tab may have changed the global selection.
    if (!busy && !saving && !dirty()) { data = aiInfo.state; render(); }
    renderAI();
  } catch (error) { $('#taskAIStatus').textContent = `AI 상태 확인 실패: ${error.message}`; }
  scheduleAI();
}

const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
async function storage(action) {
  $('#taskStorageInfo').textContent = '확인 중…';
  try {
    const r = await aiRequest({ action });
    $('#taskStorageInfo').textContent = `백업·변경 파일 ${r.total}개 (${mb(r.totalBytes)}) 중 정리 가능 ${r.prunable}개 (${mb(r.prunableBytes)})\n문서 변환 캐시 정리 가능 ${r.cache.removable}개 (${mb(r.cache.bytes)})\n연결 없는 첨부 데이터 ${r.orphanAttachments}개(자동 삭제하지 않음)${action === 'maintenance.prune' ? `\n정리 완료: 백업 ${r.removed}개` : ''}`;
    $('#taskStoragePrune').disabled = !(r.prunable || r.cache.removable) || action === 'maintenance.prune';
  } catch (error) { $('#taskStorageInfo').textContent = error.message; }
}
$('#taskStorageCheck').onclick = () => storage('maintenance.report');
$('#taskStoragePrune').onclick = () => { if (confirm('적용·복구에 필요하지 않은 오래된 백업과 문서 변환 캐시만 삭제합니다. 계속할까요?')) storage('maintenance.prune'); };
$('#taskAIConsent').onchange = controls;
$('#taskAISelect').onchange = () => { renderAI(); };
$('#taskAICheck').onclick = async () => {
  const provider = $('#taskAISelect').value;
  $('#taskAIStatus').textContent = '연결 확인 중…';
  try {
    const result = await aiRequest({ action: 'provider.check', provider });
    $('#taskAIStatus').textContent = `${result.ok ? '✓ 사용 가능' : '✗ 사용 불가'} · ${result.detail}`;
    aiInfo = await aiRequest(); renderProviders();
  } catch (error) { $('#taskAIStatus').textContent = error.message; }
};
async function startAI(mode) {
  if (busy || analysisActive()) return;
  busy = true; controls();
  try {
    await flushDraft();
    aiInfo = await aiRequest({ action: 'start', mode, provider: $('#taskAISelect').value, projectId, sessionId,
      revision: session().revision, consent: consentOK(), files: ['explore', 'plan', 'changes'].includes(mode) ? [] : [...analysisFiles] });
    data = aiInfo.state; render(true); renderAI();
    scheduleAI();
  } catch (error) { $('#taskAIStatus').textContent = error.message; }
  finally { busy = false; controls(); }
}
$('#taskAIRun').onclick = () => startAI('analysis');
$('#taskExploreRun').onclick = () => startAI('explore');
$('#taskPlanRun').onclick = () => startAI('plan');
$('#taskChangesRun').onclick = () => startAI('changes');
$('#taskProposalGenerate').onclick = () => startAI('proposal');
async function cancelAI() {
  if (!aiInfo?.running) return;
  try { aiInfo = await aiRequest({ action: 'cancel', ...aiInfo.running }); renderAI(); scheduleAI(); }
  catch (error) { $('#taskAIStatus').textContent = error.message; }
}
$('#taskAICancel').onclick = cancelAI;
const attachUI = createAttach({
  getScope: () => (projectId && sessionId ? { projectId, sessionId } : null),
  getInfo: () => aiInfo,
  refreshInfo: async () => { try { aiInfo = await aiRequest(); } catch { /* the next poll retries */ } },
  isBusy: () => busy || analysisActive() || !!aiInfo?.running,
  startDocs: (options) => startDocs(options),
  onChange: () => controls(),
});
const imageUI = createImageUI({
  getScope: () => (projectId && sessionId ? { projectId, sessionId } : null),
  getInfo: () => aiInfo,
  refreshInfo: async () => { try { aiInfo = await aiRequest(); } catch { /* the next poll retries */ } },
  isBusy: () => busy || analysisActive() || !!aiInfo?.running,
  startRun: (body) => startRaw(body),
  openChange: (id) => { changesUI.open(id); },
  onChange: () => renderAI(),
});
async function startRaw(extra) {
  if (busy || analysisActive()) return;
  busy = true; controls();
  try {
    await flushDraft();
    aiInfo = await aiRequest({ action: 'start', provider: $('#taskAISelect').value, projectId, sessionId, revision: session().revision, files: [], ...extra });
    data = aiInfo.state; render(true); renderAI(); scheduleAI();
  } catch (error) { $('#taskAIStatus').textContent = error.message; }
  finally { busy = false; controls(); }
}
async function startDocs({ sources, depth, consentAttachments }) {
  if (busy || analysisActive()) return;
  busy = true; controls();
  try {
    await flushDraft();
    aiInfo = await aiRequest({ action: 'start', mode: 'docs', provider: $('#taskAISelect').value, projectId, sessionId, revision: session().revision,
      consent: consentOK(), consentAttachments, sources, depth, files: [] });
    data = aiInfo.state; render(true); renderAI(); scheduleAI();
  } catch (error) { $('#taskAIStatus').textContent = error.message; }
  finally { busy = false; controls(); }
}
const changesUI = createChanges({
  getScope: () => (projectId && sessionId ? { projectId, sessionId } : null),
  getInfo: () => aiInfo,
  refreshInfo: async () => { try { aiInfo = await aiRequest(); } catch { /* the next poll retries */ } },
  onOpen: () => { closePreview(); closeProposal(); closePlan(); showSidebar(false); },
  onChanged: (closed) => { if (closed) screen.classList.remove('task-proposal-open'); renderAI(); },
});
// Live run progress (SSE). It follows the selected project/session only, so another session's run never shows here.
const liveProgress = createProgress({
  getScope: () => (projectId && sessionId && !screen.hidden ? { projectId, sessionId } : null),
  onTerminal: () => { refreshAI(); },
  onCancel: cancelAI,
});

function controls() {
  input.disabled = busy || !session() || analysisActive();
  $('#taskNew').disabled = busy || !project();
  $('#taskProjectAdd').disabled = busy || !data;
  $('#taskProjectRename').disabled = busy || !project();
  $('#taskProjectLinked').disabled = busy || !data;
  $('#taskFolderPick').disabled = busy || !project();
  $('#taskFolderDisconnect').disabled = busy || !project()?.folderPath;
  $('#taskFolderCheck').disabled = busy || !project()?.folderPath;
  $('#taskSaveMessage').disabled = busy || !session() || !input.value.trim() || analysisActive();
  $('#taskAIRun').disabled = busy || !session() || !input.value.trim() || !!aiInfo?.running || analysisActive()
    || !consentOK() || project()?.folder.state !== 'connected' || !selectedProvider()?.available;
  const runBlocked = $('#taskAIRun').disabled;
  $('#taskExploreRun').disabled = runBlocked || !supports('explore');
  $('#taskPlanRun').disabled = runBlocked || !supports('plan');
  $('#taskChangesRun').disabled = runBlocked || !supports('changes');
  $('#taskProposalGenerate').disabled = runBlocked || analysisFiles.size !== 1 || !supports('proposal');
  $('#taskAIRun').disabled = runBlocked || !supports('analysis');
  $('#taskAICheck').disabled = busy || analysisActive() || !!aiInfo?.running;
  syncCard();
  if (workMode() !== 'solo') {
    const final = FINAL_OF[$('#taskActionSelect').value];
    const leadable = [...teamPicked].some((id) => { const p = aiInfo?.providers?.find((x) => x.id === id); return p && (!p.modes?.length || p.modes.includes(final)); });
    $('#taskSend').disabled = busy || !session() || !input.value.trim() || !!aiInfo?.running || analysisActive() || !consentOK()
      || project()?.folder.state !== 'connected' || !final || teamPicked.size < 2 || !leadable || (final === 'analysis' && !analysisFiles.size);
    $('#taskSend').title = !final ? '분담·협업에서는 수정안 생성 대신 파일·문서 변경안을 고르세요.' : !leadable ? '선택한 AI 중 최종 통합을 맡을 수 있는 AI가 없습니다.' : '분담·협업 실행 (Ctrl+Enter)';
  } else $('#taskSend').title = '선택한 작업을 실행합니다 (Ctrl+Enter)';
  $('#taskModeSelect').disabled = busy || analysisActive();
  $('#taskPermSelect').disabled = busy || !project();
  $('#taskCompress').disabled = busy || !session() || (session()?.messages.length || 0) < 2 || !!aiInfo?.running || !consentOK();
  $('#taskAISelect').disabled = busy || analysisActive();
  $('#taskAIConsent').disabled = busy || analysisActive();
  $('#taskAICancel').hidden = !aiInfo?.running || !analysisActive();
  $('#taskFilesRefresh').disabled = busy || project()?.folder.state !== 'connected';
  fileTree.inert = busy;
  projectName.disabled = busy || !data;
  screen.querySelectorAll('[data-task-example], .task-project, .task-session').forEach((button) => {
    button.disabled = busy || ((!session() || analysisActive()) && button.hasAttribute('data-task-example'));
  });
}

// Composer card: one send button runs whichever work type is chosen by clicking the (hidden) original button.
function syncCard() {
  const target = $('#' + $('#taskActionSelect').value);
  $('#taskSend').disabled = !target || target.disabled;
  $('#taskCardProject').textContent = project() ? `📁 ${project().name}${project().folder?.state === 'connected' ? '' : ' · 폴더 미연결'} ▾` : '📁 프로젝트 ▾';
  $('#taskPermSelect').value = permission();
  $('#taskPermSelect').title = aiInfo?.permissions?.[permission()]?.scope || 'AI 실행 권한';
  $('#taskEstimate').textContent = estimate();
}
function render(restore = false) {
  const selected = session();
  if (restore) input.value = selected?.draft || '';
  if (restore) $('#taskAIConsent').checked = project()?.analysisConsent === true;
  $('#taskProjects').replaceChildren(...(data?.projects || []).map((item) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'task-session task-project';
    button.textContent = item.name; button.title = item.name;
    const folder = document.createElement('small');
    folder.textContent = item.folder.state === 'connected' ? `연결 완료 · ${item.folder.name}`
      : item.folder.state === 'unavailable' ? '경로 접근 불가' : '폴더 미연결';
    button.append(folder);
    if (item.id === projectId) button.setAttribute('aria-current', 'true');
    button.onclick = () => change({ action: 'select', projectId: item.id });
    return button;
  }));
  const query = $('#taskSearch').value.trim().toLowerCase();
  const matches = (item) => !query || [item.draft, ...item.messages.map((m) => m.text)].some((text) => String(text || '').toLowerCase().includes(query));
  $('#taskSessions').replaceChildren(...(project()?.sessions || []).map((item, index) => [item, index]).filter(([item]) => matches(item)).reverse().map(([item, index]) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'task-session';
    button.textContent = (item.messages[0]?.text || (item.id === sessionId ? input.value : item.draft)).trim().split('\n')[0].slice(0, 60) || `새 작업 ${index + 1}`;
    button.title = button.textContent;
    if (item.id === sessionId) button.setAttribute('aria-current', 'true');
    button.onclick = () => change({ action: 'select', projectId, sessionId: item.id });
    return button;
  }));
  $('.task-project-status').textContent = project()?.name || '프로젝트 미선택';
  const folder = project()?.folder;
  $('#taskFolder').dataset.state = folder?.state || 'unlinked';
  $('#taskFolderStatus').textContent = folder?.state === 'connected' ? '연결 완료'
    : folder?.state === 'unavailable' ? '경로 접근 불가' : '폴더 미연결';
  $('#taskFolderName').textContent = folder?.name || '';
  $('#taskFolderPath').textContent = project()?.folderPath || '';
  $('#taskFolderError').textContent = folder?.error || '';
  $('#taskFolderError').hidden = !folder?.error;
  $('#taskFolderPick').textContent = project()?.folderPath ? '폴더 변경' : '폴더 연결';
  const messages = selected?.messages || [];
  $('.task-center').hidden = messages.length > 0;
  $('#taskMessages').hidden = !messages.length;
  const PHASE = { role: '역할 작업', opinion: '독립 의견', review: '교차 검토' };
  $('#taskMessages').replaceChildren(...messages.map((message, index) => {
    const article = document.createElement('article');
    const ai = message.role === 'assistant', persona = PERSONA[message.provider] || { avatar: 'claude', name: 'AI' };
    const finalResult = ai && !message.team && messages[index - 1]?.teamFinal;
    article.className = `task-message ${ai ? 'task-message-ai' : 'task-message-user'}${message.teamFinal ? ' task-message-handoff' : ''}`;
    if (ai) {
      const face = document.createElement('img'); face.className = 'task-message-av'; face.alt = ''; face.src = `/avatars/${persona.avatar}-pixel-128.png`;
      article.append(face);
    }
    const heading = document.createElement('small');
    const role = message.work || (finalResult ? '최종 통합' : ai ? '단독 작업' : '');
    heading.innerHTML = ai ? `<b></b><span class="task-message-role"></span><span class="task-message-phase"></span><span class="task-message-state">완료 · 실제 AI 답변</span><time></time>` : `<b>나</b><time></time>`;
    if (ai) {
      heading.querySelector('b').textContent = persona.name;
      heading.querySelector('.task-message-role').textContent = role;
      heading.querySelector('.task-message-phase').textContent = finalResult ? '최종 결과' : PHASE[message.phase] || '';
      heading.querySelector('.task-message-phase').hidden = !finalResult && (!PHASE[message.phase] || PHASE[message.phase] === role);
    }
    heading.querySelector('time').textContent = new Date(message.at).toLocaleString('ko-KR');
    let text = document.createElement('p'); text.textContent = message.text;
    if (message.teamFinal) {
      // The lead's integration request carries every team note; keep it folded.
      const fold = document.createElement('details'); const label = document.createElement('summary');
      label.textContent = `최종 통합 요청 · ${message.team === 'split' ? '분담' : '협업'} 결과 ${(message.text.match(/^### /gm) || []).length}개를 하나로 합칩니다`;
      fold.append(label, text); text = fold;
    }
    const body = document.createElement('div'); body.className = 'task-message-body';
    body.append(heading, text);
    article.append(body);
    if (message.role === 'user' && message.files?.length) {
      const used = document.createElement('small'); used.className = 'task-message-files';
      used.textContent = `분석에 사용한 파일: ${message.files.join(', ')}`; article.append(used);
    }
    if (message.planId) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'task-start'; button.textContent = '작업 계획 보기';
      button.onclick = () => openPlan(message.planId); article.append(button);
    }
    if (message.changeId) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'task-start'; button.textContent = '변경안 보기';
      button.onclick = () => changesUI.open(message.changeId); article.append(button);
    }
    if (message.proposalId) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'task-start'; button.textContent = '수정안 보기';
      button.onclick = () => openProposal(message.proposalId); article.append(button);
    }
    return article;
  }));
  controls();
  syncFiles();
  renderAI();
  if (!screen.hidden) liveProgress.connect();
}

async function flushDraft() {
  if (saving) return saving;
  saving = (async () => {
    while (dirty()) {
      status.textContent = '초안 저장 중…';
      const text = input.value;
      data = await request({ action: 'draft.save', projectId, sessionId, text, revision: session().revision });
      // Do not replace text typed while the request was in flight.
      render();
    }
    savedStatus();
  })();
  try { await saving; } finally { saving = null; }
}

async function change(command) {
  if (busy) return;
  busy = true; controls();
  try {
    await flushDraft();
    if (command.action === 'folder.pick' || command.action === 'project.createLinked') status.textContent = 'PC에서 폴더를 선택해 주세요…';
    if (command.action === 'message.add') {
      command.revision = session().revision;
      command.messageId = pendingMessageId ??= crypto.randomUUID();
    }
    data = await request(command);
    failedCommand = null;
    if (command.action === 'message.add') pendingMessageId = null;
    projectId = data.selectedProjectId; sessionId = data.selectedSessionId;
    render(true); savedStatus();
    if (data.folderSelectionCancelled) status.textContent = '폴더 선택을 취소했습니다. 기존 정보는 유지됩니다.';
    else if (['project.create', 'project.createLinked', 'project.rename'].includes(command.action)) projectName.value = '';
    showSidebar(false);
    if (['select', 'project.create', 'project.createLinked', 'project.rename'].includes(command.action) && !command.sessionId) $('#taskProjectMenu').open = false;
  } catch (error) { failedCommand = command; errorStatus(error); }
  finally { busy = false; controls(); }
}

async function load() {
  busy = true; controls(); status.textContent = '기록 불러오는 중…';
  try {
    data = await request();
    projectId = data.selectedProjectId; sessionId = data.selectedSessionId;
    render(true); savedStatus();
  } catch (error) { errorStatus(error); }
  finally { busy = false; controls(); }
}

input.addEventListener('input', () => {
  controls();
  flushDraft().catch(errorStatus);
});
$('#taskNew').onclick = () => change({ action: 'session.create', projectId });
$('#taskProjectForm').onsubmit = (event) => {
  event.preventDefault();
  change({ action: 'project.create', name: projectName.value });
};
$('#taskProjectRename').onclick = () => {
  if ($('#taskProjectForm').reportValidity()) change({ action: 'project.rename', projectId, name: projectName.value });
};
$('#taskProjectLinked').onclick = () => change({ action: 'project.createLinked', name: projectName.value });
$('#taskFolderPick').onclick = () => change({ action: 'folder.pick', projectId });
$('#taskFolderDisconnect').onclick = () => change({ action: 'folder.disconnect', projectId });
$('#taskFolderCheck').onclick = () => change({ action: 'folder.check', projectId });
$('#taskSaveMessage').onclick = () => change({ action: 'message.add', projectId, sessionId });
retry.onclick = () => {
  if (!data) load();
  else if (failedCommand) change(failedCommand);
  else flushDraft().catch(errorStatus);
};
sidebarToggle.onclick = () => showSidebar(!screen.classList.contains('task-sidebar-open'));
$('#taskSidebarDismiss').onclick = () => { showSidebar(false); sidebarToggle.focus(); };
screen.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && screen.classList.contains('task-sidebar-open')) {
    showSidebar(false); sidebarToggle.focus();
  }
});

$('#taskCharacters').innerHTML = dotCharacters.map((_, i) => `<div class="empty-character" style="--index:${i}">${dotCharacter(i)}</div>`).join('');
drawDotTitle($('#taskDotTitle'));
function showTask(open) {
  if (!open) { closePreview(); closeProposal(); closePlan(); changesUI.close(); }
  screen.hidden = !open;
  app.classList.toggle('task-open', open);
  chat.classList.toggle('task-mode', open);
  showSidebar(false);
  toggle.setAttribute('aria-pressed', String(open));
  (open ? back : toggle).focus();
  if (!open) { clearTimeout(aiTimer); liveProgress.disconnect(); }
  else liveProgress.connect();
}
toggle.onclick = () => {
  showTask(true);
  if (!data && !busy) load();
  else if (projectId && !busy) change({ action: 'folder.check', projectId });
  refreshAI();
};
let continuingChat = false;
window.addEventListener('task-continue', async event => {
  if (document.body.dataset.role === 'guest' || typeof event.detail?.text !== 'string') return;
  if (continuingChat || busy || analysisActive()) { status.textContent = '진행 중인 작업이 끝난 뒤 이어해 주세요.'; return; }
  continuingChat = true;
  try {
    if (!data) await load();
    if (!data || busy) { showTask(true); return; }
    await flushDraft();
    busy = true; controls();
    data = await request(project() ? { action: 'session.create', projectId } : { action: 'project.create', name: '채팅에서 이어하기' });
    projectId = data.selectedProjectId; sessionId = data.selectedSessionId;
    render(true); showTask(true);
    input.value = event.detail.text; input.style.height = 'auto';
    input.style.height = `${Math.min(220, input.scrollHeight)}px`;
    await flushDraft(); input.focus();
    status.textContent = '단톡방 내용을 새 세션 초안으로 옮겼어요. 프로젝트·작업 방식을 확인하고 요청을 다듬은 뒤 실행하세요.';
  } catch (error) { errorStatus(error); }
  finally { continuingChat = false; busy = false; controls(); }
});
back.onclick = async () => {
  if (busy) return;
  busy = true; controls();
  try { await flushDraft(); showTask(false); }
  catch (error) { errorStatus(error); }
  finally { busy = false; controls(); }
};
screen.addEventListener('click', (event) => {
  const example = event.target.closest('[data-task-example]');
  if (!example || !session() || busy || analysisActive()) return;
  input.value = example.dataset.taskExample;
  controls(); flushDraft().catch(errorStatus); input.focus();
});
// Never silently abandon a draft that the server has not acknowledged.
window.addEventListener('beforeunload', (event) => {
  if (dirty() || saving || busy) { event.preventDefault(); event.returnValue = ''; }
});
render();

$('#taskActionSelect').onchange = () => { renderTeamPick(); controls(); };
$('#taskSend').onclick = () => {
  if (workMode() !== 'solo') { startTeam(); return; }
  const target = $('#' + $('#taskActionSelect').value); if (target && !target.disabled) target.click();
};
async function startTeam() {
  if (busy || analysisActive() || $('#taskSend').disabled) return;
  busy = true; controls();
  try {
    await flushDraft();
    const final = FINAL_OF[$('#taskActionSelect').value], providers = [...teamPicked];
    aiInfo = await aiRequest({ action: 'start', mode: 'team', provider: providers[0], projectId, sessionId, revision: session().revision, consent: consentOK(), consentAttachments: $('#taskAttachConsent').checked,
      files: final === 'analysis' ? [...analysisFiles] : [], team: { style: workMode(), providers, final } });
    data = aiInfo.state; render(true); renderAI(); scheduleAI();
  } catch (error) { $('#taskAIStatus').textContent = error.message; }
  finally { busy = false; controls(); }
}
function renderTeamPick() {
  const providers = (aiInfo?.providers || []).filter((p) => p.available && (!p.modes?.length || p.modes.includes('analysis')));
  for (const id of [...teamPicked]) if (!providers.some((p) => p.id === id)) teamPicked.delete(id);
  if (!teamPicked.size) providers.slice(0, 3).forEach((p) => teamPicked.add(p.id));
  const team = workMode() !== 'solo';
  $('#taskTeamPick').hidden = !team; $('#taskAISelect').hidden = team;
  const final = FINAL_OF[$('#taskActionSelect').value];
  $('#taskTeamPick').replaceChildren(...providers.map((p) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'task-team-ai';
    const on = teamPicked.has(p.id), lead = !p.modes?.length || p.modes.includes(final);
    b.setAttribute('aria-pressed', String(on)); b.disabled = busy || analysisActive();
    b.title = `${PERSONA[p.id]?.name || p.name}${lead ? '' : ' · 분석 단계만 참여 (최종 통합은 다른 AI)'}`;
    b.innerHTML = `<img src="/avatars/${PERSONA[p.id]?.avatar || 'claude'}-pixel-128.png" alt=""><span></span>`;
    b.querySelector('span').textContent = PERSONA[p.id]?.name.split(' ')[0] || p.short;
    b.onclick = () => { if (on && teamPicked.size > 2) teamPicked.delete(p.id); else if (!on && teamPicked.size < 3) teamPicked.add(p.id); renderTeamPick(); controls(); };
    return b;
  }));
  $('#taskEstimate').textContent = estimate();
}
// The chosen work mode is a per-browser convenience.
try { const saved = localStorage.getItem('task-work-mode'); if (['solo', 'split', 'collab'].includes(saved)) $('#taskModeSelect').value = saved; } catch { /* storage unavailable */ }
$('#taskModeSelect').onchange = () => { try { localStorage.setItem('task-work-mode', workMode()); } catch { /* storage unavailable */ } renderTeamPick(); controls(); };
$('#taskPermSelect').onchange = async () => {
  const value = $('#taskPermSelect').value, scope = aiInfo?.permissions?.[value]?.scope || '';
  if (value === 'auto' && !confirm(`자동 승인으로 바꿀까요?\n\n${scope}\n\n이 프로젝트의 요청·선택 자료를 AI 서비스로 전송하는 데 동의합니다.`)) { $('#taskPermSelect').value = permission(); return; }
  await change({ action: 'project.permission', projectId, permission: value, ...(value === 'auto' ? { consent: true } : {}) });
  $('#taskPermSelect').value = permission();
};
$('#taskCompress').onclick = async () => {
  if (busy || aiInfo?.running) return;
  const provider = workMode() === 'solo' ? $('#taskAISelect').value : [...teamPicked][0];
  if (permission() !== 'ask' && !confirm('이 세션의 대화를 요약해 저장할까요?\nAI 호출 1회를 사용하고, 원본 대화는 지우지 않습니다.')) return;
  busy = true; controls(); $('#taskCompressStatus').textContent = '압축 요청 중…';
  try { aiInfo = await aiRequest({ action: 'context.compress', projectId, sessionId, provider, consent: consentOK() }); renderAI(); scheduleAI(); }
  catch (error) { $('#taskCompressStatus').textContent = error.message; }
  finally { busy = false; controls(); }
};
$('#taskSearch').addEventListener('input', () => render());
function renderDrawer() {
  const running = aiInfo?.running;
  const where = running && data?.projects.find((item) => item.id === running.projectId);
  const runningSession = where?.sessions.find((item) => item.id === running.sessionId);
  $('#taskRunning').textContent = running ? `${where?.name || '다른 프로젝트'} · ${(runningSession?.messages.findLast((m) => m.role === 'user')?.text || '작업').split('\n')[0].slice(0, 40)} · 실행 중` : '진행 중인 AI 작업이 없습니다.';
  const mine = (list, open) => (list || []).filter((item) => item.projectId === projectId && open.includes(item.status)).length;
  const pending = mine(aiInfo?.changes, ['pending', 'approved', 'conflict']) + mine(aiInfo?.plans, ['pending', 'approved']) + mine(aiInfo?.proposals, ['pending', 'approved']);
  $('#taskPendingCount').textContent = pending ? `검토·적용을 기다리는 결과물 ${pending}개 · 아래 목록에서 열어 확인하세요.` : '승인을 기다리는 결과물이 없습니다.';
  const summary = session()?.summary;
  const box = $('#taskContextSummary');
  if (summary) {
    box.className = 'task-context-summary';
    box.textContent = `${new Date(summary.at).toLocaleString('ko-KR')} · 메시지 ${summary.count}개 압축 · ${PERSONA[summary.by]?.name || summary.by}\n${summary.text}`;
  } else { box.className = 'task-sidebar-empty'; box.textContent = '아직 압축 요약이 없습니다. 대화가 길어지면 압축해 두면 다음 AI 호출과 다른 AI 인계에 요약이 함께 전달됩니다.'; }
  const compressing = aiInfo?.runs?.find((run) => run.mode === 'compress' && run.status === 'running' && run.sessionId === sessionId);
  $('#taskCompressStatus').textContent = compressing ? '대화를 압축하는 중…' : aiInfo?.compressError || '';
}
$('#taskPlus').onclick = () => { const tray = $('#taskTray'); tray.hidden = !tray.hidden; $('#taskPlus').setAttribute('aria-expanded', String(!tray.hidden)); };
input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('#taskSend').click(); } });
// A file dragged over the composer opens the tray so the drop target is visible.
$('.task-compose').addEventListener('dragenter', (event) => { if ([...(event.dataTransfer?.types || [])].includes('Files') && $('#taskTray').hidden) $('#taskPlus').click(); });
// The text box grows with its content.
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(220, input.scrollHeight)}px`; });
syncCard();
