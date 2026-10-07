import { esc, renderMarkdown } from './format.mjs';
import { limitWindows, batteryLevel, quotaOf, recommendByQuota, quotaCheck } from './status.mjs';

const IDS = ['gpt', 'gemini', 'claude'];
const NAMES = { gpt: 'GPT', gemini: 'Gemini', claude: 'Claude Code', user: '나', system: '작업대', tool: '도구' };
const MODES = { solo: '단독', divide: '분담', collaborate: '협업' };
const STATUS = { idle: '대기', running: '작업 중', waiting: '실행 승인 대기', done: '작업 종료', interrupted: '중단됨', needs_input: '답변 필요', declined: '실행 거절됨' };
// Task cards: one per work request. Steps come from the actions the AI really took; no extra AI call.
const TASK_STATUS = { running: '작업 중', done: '작업 완료', interrupted: '중단됨', failed: '실패' };
const STOP_REASON = { needs_input: '답변이 필요해서 멈췄어요. 아래 질문을 확인해 주세요.', declined: '명령 실행이 거절되어 멈췄어요.', cancelled: '작업을 중지했어요.', restart: '서버가 다시 시작되어 중단됐어요.', plan_declined: '실행 계획을 중단했어요. 파일은 수정하지 않았어요.' };
// Per member of a divided or collaborative task: what it is doing now, or the last thing it finished.
const PHASE_WORK = { 의견: '의견 작성 중', '분담 계획': '계획 작성 중', 합의: '계획 검토 중', '분담 실행': '담당 작업 중', '종합 확인': '결과 확인 중' };
const PHASE_DONE = { 의견: '✓ 의견 완료', '분담 계획': '✓ 계획 작성 완료', 동의: '✓ 계획에 동의', 이견: '✕ 이견 제시', 질문: '? 질문함', '분담 실행': '✓ 담당 작업 완료', '종합 확인': '✓ 종합 확인 완료' };
const QUOTA_ICON = { ok: '🟢', mid: '🟡', low: '🔴' };
const SOLO_STEPS = ['프로젝트 확인', '코드 수정', '테스트', '결과 정리'];
const STEP_OF = { list: 0, read: 0, write: 1, patch: 1, command: 2, approval: 2, '명령 결과': 2 };
const PHASE_STEPS = { divide: ['분담 계획', '분담 실행', '종합 확인'], collaborate: ['의견', '분담 계획', '합의', '계획 승인', '분담 실행', '종합 확인'] };
const ACTION_TEXT = { think: '생각하는 중', list: '폴더 살펴보는 중', read: '읽는 중', write: '새 파일 만드는 중', patch: '수정하는 중', command: '명령 실행 중', approval: '명령 실행 승인을 기다리는 중', plan_approval: '실행 계획 승인을 기다리는 중' };
const DONE_TEXT = { list: '폴더 확인', read: '확인', write: '새 파일 작성', patch: '수정' };
const MARK = { done: '✓', now: '●', todo: '○', skip: '–', stop: '■' };
const MARK_TEXT = { done: '완료', now: '진행 중', todo: '대기', skip: '건너뜀', stop: '멈춤' };
const panel = document.createElement('section');
panel.id = 'workbench'; panel.className = 'workbench'; panel.hidden = true;
panel.setAttribute('aria-label', '작업대');
panel.innerHTML = `
  <header class="wb-header"><div><b>작업대</b></div><button type="button" id="wbClose" class="wb-close" aria-label="작업대 닫고 채팅방으로" title="채팅방으로"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></header>
  <div class="wb-layout">
    <aside class="wb-sidebar" aria-label="프로젝트와 세션">
     <div class="wb-side-scroll">
      <div class="wb-project-row"><select id="wbProjects" aria-label="작업대 프로젝트"></select><button type="button" id="wbProjectAdd" class="wb-outline" aria-label="프로젝트 폴더 추가" title="프로젝트 폴더 추가">＋</button></div>
      <p class="wb-path" id="wbProjectPath"></p>
      <div class="wb-session-head"><b>세션</b><button type="button" id="wbNew" aria-label="새 작업 세션">＋</button></div>
      <nav id="wbSessions" aria-label="작업 세션"></nav>
      <p class="wb-aside-note" id="wbAsideNote">채팅방·집과 별도 기록입니다.<br>같은 프로젝트의 작업은 한 번에 하나씩 진행합니다.</p>
     </div>
     <div class="wb-side-foot">
      <section class="wb-limits" aria-label="AI별 남은 한도"><div class="wb-limits-head"><b>남은 한도</b><small>5시간 · 주간</small></div><div id="wbLimits"></div></section>
      <button type="button" id="wbSettingsBtn" class="wb-gear" aria-haspopup="dialog"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><span>설정</span></button>
     </div>
    </aside>
    <main class="wb-main">
      <div class="wb-session-bar"><input id="wbTitle" aria-label="작업 세션 이름" maxlength="80"><span id="wbStatus" role="status"></span></div>
      <div class="wb-scroll" id="wbScroll">
        <section class="wb-empty" id="wbEmpty"><div class="wb-characters" id="wbCharacters"></div>
          <canvas id="wbEmptyText" width="340" height="40" role="img" aria-label="작업을 시작해볼까요?"></canvas>
          <p id="wbEmptyHint">AI에게 프로젝트를 맡겨보세요.</p>
          <ol class="wb-start-steps" id="wbStartSteps" aria-label="시작 순서"></ol>
          <button type="button" id="wbEmptyPick" class="wb-outline">프로젝트 선택하기</button>
        </section>
        <div id="wbMessages" aria-live="polite" aria-relevant="additions"></div>
        <section id="wbPermission" class="wb-permission" hidden aria-label="명령 실행 승인"></section>
        <details id="wbChanges" class="wb-changes" hidden><summary id="wbChangeTitle">변경 파일</summary><div id="wbChangeList"></div></details>
      </div>
      <div class="wb-error" id="wbError" role="alert" hidden></div>
      <div class="wb-notice" id="wbNotice" role="status" hidden></div>
      <div class="wb-composer-area">
        <div class="wb-composer-toolbar">
          <button type="button" id="wbProjectShortcut" title="프로젝트 폴더 선택"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h6l2 2h10v12H3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><span id="wbProjectLabel">프로젝트 선택</span><span aria-hidden="true">⌄</span></button>
          <div class="wb-mode">
            <select id="wbMode" class="wb-sr" tabindex="-1" aria-hidden="true"><option value="solo">단독</option><option value="divide">분담</option><option value="collaborate">협업</option></select>
            <button type="button" id="wbModeBtn" aria-label="작업 모드" aria-haspopup="listbox" aria-expanded="false"><span id="wbModeLabel">단독</span><span aria-hidden="true">⌄</span></button>
            <div id="wbModeMenu" class="wb-mode-menu" role="listbox" aria-label="작업 모드" hidden></div>
          </div>
          <div class="wb-mode wb-approval">
            <button type="button" id="wbApprovalBtn" aria-label="명령 실행 권한" aria-haspopup="listbox" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.500-7-10V6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><span id="wbApprovalLabel">매번 요청</span><span aria-hidden="true">⌄</span></button>
            <div id="wbApprovalMenu" class="wb-mode-menu wb-approval-menu" role="listbox" aria-label="명령 실행 권한" hidden></div>
          </div>
        </div>
        <form class="wb-composer" id="wbForm"><label class="wb-sr" for="wbInput">작업 요청</label>
          <textarea id="wbInput" rows="2" maxlength="12000" placeholder="무엇이든 물어보세요..."></textarea>
          <div class="wb-compose-bottom">
            <div class="wb-settings" id="wbSettings"></div>
            <details class="wb-context-menu" id="wbContextDetails"><summary aria-label="컨텍스트 정보" title="컨텍스트 정보"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 11v5m0-8v.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></summary><div id="wbContext" class="wb-context"></div></details>
            <span class="wb-compose-spacer"></span>
            <button type="button" id="wbCancel" class="wb-send-icon" aria-label="작업 중지" title="작업 중지" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg></button>
            <button type="submit" id="wbSend" class="wb-send-icon" aria-label="작업 시작" title="작업 시작"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          </div>
        </form>
      </div>
    </main>
  </div>
  <dialog id="wbSettingsDialog" class="wb-folder-dialog wb-settings-dialog" aria-labelledby="wbSettingsTitle">
    <header><h2 id="wbSettingsTitle">작업대 설정</h2><button type="button" id="wbSettingsClose" aria-label="설정 닫기">×</button></header>
    <div class="wb-setting-row"><label for="wbTheme">화면 테마</label><select id="wbTheme"><option value="">시스템 설정 따름</option><option value="light">밝게</option><option value="dark">어둡게</option></select></div>
    <div class="wb-setting-row"><label for="wbMotion">움직임 줄이기</label><input type="checkbox" id="wbMotion"></div>
    <p>애니메이션을 끄고 바로 전환합니다. 이 브라우저에만 저장됩니다.</p>
    <div class="wb-setting-row"><label for="wbUsageRefresh">남은 한도</label><button type="button" id="wbUsageRefresh">지금 새로 확인</button></div>
    <p id="wbUsageNote">한도는 각 AI CLI가 알려주는 계정 전체 기준 값입니다.</p>
  </dialog>
  <dialog id="wbChoiceDialog" class="wb-folder-dialog wb-choice-dialog" aria-labelledby="wbChoiceTitle">
    <header><h2 id="wbChoiceTitle"></h2></header><p id="wbChoiceText"></p><footer id="wbChoiceButtons"></footer>
  </dialog>
  <dialog id="wbFolderDialog" class="wb-folder-dialog" aria-labelledby="wbFolderTitle">
    <header><h2 id="wbFolderTitle">프로젝트 폴더 선택</h2><button type="button" id="wbFolderClose" aria-label="폴더 선택 닫기">×</button></header>
    <p>기존 로컬 폴더를 연결합니다. 요청한 파일 수정은 이 폴더에 적용되며, 외부 명령은 실행 전에 승인을 받습니다.</p>
    <form id="wbBrowseForm"><label class="wb-sr" for="wbFolderPath">프로젝트 폴더 경로</label><input id="wbFolderPath" placeholder="프로젝트 폴더의 전체 경로"><button type="submit">탐색</button></form>
    <div class="wb-folder-nav"><button type="button" id="wbFolderUp">↑ 상위 폴더</button><button type="button" id="wbFolderMore" hidden>다음 목록 →</button></div>
    <div id="wbFolders" class="wb-folders"></div><p id="wbFolderError" role="alert"></p>
    <footer><button type="button" id="wbFolderChoose" class="wb-primary">이 폴더 사용</button></footer>
  </dialog>`;
document.body.append(panel);
const $ = (selector) => panel.querySelector(selector);
const opener = document.querySelector('#workbenchBtn');
let state = null, sessionId = '', projectId = '', requestNumber = 0, refreshTimer = null;
let settingsKey = '', contentKey = '', folder = null, folderOffset = 0;
let pending = {}, sending = false, shownSession = null, shownCount = 0, usage = null;
const drafts = new Map();
const busy = () => state?.session && ['running', 'waiting'].includes(state.session.status);
// A waiting plan approval is labelled apart from a waiting command approval.
const statusText = (s) => (s.status === 'waiting' && s.pending?.kind === 'plan' ? '계획 승인 대기' : STATUS[s.status] || s.status);

async function api(route, body) {
  const response = await fetch(`/api/workbench${route}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || `요청 실패 (${response.status})`);
  return result;
}
function error(e) { $('#wbError').textContent = e.message || String(e); $('#wbError').hidden = false; }
async function perform(action) {
  $('#wbError').hidden = true;
  try { return await action(); } catch (e) { error(e); }
}
async function refresh() {
  const number = ++requestNumber;
  const value = await api(sessionId ? `?session=${encodeURIComponent(sessionId)}` : '');
  if (number !== requestNumber) return;
  state = value;
  if (!projectId && value.projects.length) projectId = value.projects[0].id;
  render();
}
function render() {
  const s = state.session, project = state.projects.find((p) => p.id === projectId);
  $('#wbProjects').innerHTML = state.projects.length ? state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') : '<option value="">＋ 버튼으로 폴더 추가</option>';
  $('#wbProjects').value = projectId;
  $('#wbProjectPath').textContent = project?.path || '';
  $('#wbProjectLabel').textContent = project?.name || '프로젝트 선택';
  $('#wbProjectShortcut').title = project?.path || '프로젝트 폴더 선택';
  $('#wbNew').disabled = !project;
  $('#wbSessions').replaceChildren(...state.sessions.filter((x) => x.projectId === projectId).slice().reverse().map((item) => {
    const button = document.createElement('button'); button.type = 'button';
    button.className = item.id === sessionId ? 'selected' : '';
    button.setAttribute('aria-current', item.id === sessionId ? 'page' : 'false');
    button.innerHTML = `<span>${esc(item.title)}</span><small>${esc(statusText(item))} · ${MODES[item.mode]}</small>`;
    button.onclick = () => selectSession(item.id);
    return button;
  }));
  $('#wbAsideNote').innerHTML = state.sessions.some((x) => x.projectId === projectId) ? '채팅방·집과 별도 기록입니다.<br>같은 프로젝트의 작업은 한 번에 하나씩 진행합니다.' : '대화가 없습니다';
  if (document.activeElement !== $('#wbTitle')) $('#wbTitle').value = s?.title || '새 작업';
  $('#wbTitle').disabled = !s || busy();
  $('#wbStatus').textContent = s ? `${statusText(s)}${s.phase ? ` · ${s.phase}` : ''}${s.speaker ? ` · ${NAMES[s.speaker]}` : ''}` : '';
  renderSettings();
  $('#wbEmpty').hidden = !!s?.messages.length;
  $('#wbEmptyPick').hidden = !!s;
  $('#wbEmptyPick').textContent = project ? '이 프로젝트로 시작하기' : '프로젝트 선택하기';
  renderStartSteps(project, s);
  const nextContent = JSON.stringify([s?.id, s?.messages.length, s?.pending, busy(), s?.changes.map((c) => [c.id, c.status]),
    s?.tasks?.map((t) => [t.status, t.phase, t.current, t.commands.length, t.working]), state.sessions.filter((x) => x.projectId === s?.projectId).map((x) => x.status)]);
  if (contentKey !== nextContent) {
    const scroll = $('#wbScroll'), follow = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 100 || contentKey === '';
    contentKey = nextContent;
    const nodes = conversationNodes(s);
    if (s?.id === shownSession) nodes.slice(shownCount).forEach((node) => node.classList.add('wb-new'));
    shownSession = s?.id; shownCount = nodes.length;
    $('#wbMessages').replaceChildren(...nodes);
    renderPermission();
    renderChanges();
    if (follow) scroll.scrollTop = scroll.scrollHeight;
  }
  $('#wbInput').disabled = !s;
  $('#wbInput').placeholder = s ? '무엇이든 물어보세요...' : '먼저 프로젝트 폴더를 선택해 주세요';
  $('#wbSend').disabled = !s || busy() || sending;
  $('#wbSend').hidden = !!busy();
  $('#wbCancel').hidden = !busy();
  $('#wbContext').replaceChildren(...IDS.map((id) => {
    const span = document.createElement('span'), context = s?.context[id];
    span.textContent = context
      ? `${NAMES[id]} · 최근 입력 ${context.chars.toLocaleString()}자${context.omitted ? ` · 이전 ${context.omitted}건 제외` : ''}`
      : `${NAMES[id]} · 아직 호출 없음`;
    span.title = '대화 원본은 보존됩니다. CLI가 정확한 토큰 사용량과 컨텍스트 한도를 제공하지 않아 비율은 표시하지 않습니다.';
    return span;
  }));
  const note = document.createElement('small'); note.textContent = '컨텍스트 한도·토큰 사용량: 확인 불가';
  $('#wbContext').append(note);
}
function renderSettings() {
  const s = state.session;
  $('#wbMode').value = s?.mode || pending.mode || 'solo';
  $('#wbMode').disabled = !!busy();
  $('#wbModeBtn').disabled = !!busy();
  const approval = s?.approval || pending.approval || 'ask';
  $('#wbApprovalBtn').disabled = !!busy();
  $('#wbApprovalLabel').textContent = APPROVALS[approval].name;
  $('#wbApprovalMenu').querySelectorAll('[data-approval-value]').forEach((el) => el.setAttribute('aria-selected', String(el.dataset.approvalValue === approval)));
  $('#wbModeLabel').textContent = MODES[$('#wbMode').value];
  $('#wbModeMenu').querySelectorAll('[data-mode]').forEach((el) => el.setAttribute('aria-selected', String(el.dataset.mode === $('#wbMode').value)));
  $('#wbMode').title = s?.mode === 'divide' ? '담당을 나누고 충돌 없이 순서대로 실행' : s?.mode === 'collaborate' ? '의견 → 계획 → 합의 후 실행' : '선택한 모델이 직접 수행';
  const quotas = Object.fromEntries(IDS.map((id) => [id, quotaOf(id, usage?.[id])]));
  const advice = recommendByQuota(IDS.filter((id) => state.catalog[id]?.available), usage);
  const next = JSON.stringify([s?.id, s?.mode, s?.lead, s?.participants, s?.models, busy(), state.catalog, pending, quotas, advice]);
  if (settingsKey === next) return;
  settingsKey = next;
  const models = s?.models || Object.fromEntries(IDS.map((id) => [id, { ...state.defaults[id], ...pending.models?.[id] }]));
  const lead = s?.lead || pending.lead || 'gpt';
  const mode = s?.mode || pending.mode || 'solo';
  const participants = s?.participants || pending.participants || IDS;
  const current = models[lead];
  const label = state.catalog[lead]?.models.find((m) => m.id === current.model)?.label || current.model;
  const open = $('.wb-model-options')?.open && !busy();
  $('#wbSettings').innerHTML = `
    <details class="wb-model-options" ${open ? 'open' : ''}><summary aria-label="작업 모델 설정" title="${esc(`${NAMES[lead]} · ${label} ${current.effort || ''}`)}"><img class="wb-mini-av" src="${avatarOf(lead)}" alt=""><span>${esc(NAMES[lead])} · ${esc(label)}</span>${current.effort ? `<small>${esc(current.effort)}</small>` : ''}<span class="wb-model-caret" aria-hidden="true">⌄</span></summary>
    <div class="wb-model-menu"><div class="wb-model-menu-head"><b>모델 설정</b><span class="wb-advice" title="CLI가 알려준 남은 사용량만 비교한 추천이에요. 모델의 능력이나 품질을 비교한 것이 아니에요.">${advice ? `추천: ${esc(NAMES[advice.id])} · 사용량 여유 기준 (남은 ${advice.pct}%)` : '사용량 정보가 충분하지 않아 추천하지 않아요'}</span></div><div class="wb-model-grid">
    ${IDS.map((id) => {
      const options = [...new Set([models[id].model, ...(state.catalog[id]?.models || []).map((m) => m.id)])];
      const efforts = id === 'gemini' ? [''] : ['', 'low', 'medium', 'high', 'xhigh', 'max', ...(id === 'gpt' ? ['ultra'] : [])];
      return `<div class="wb-model-card wb-ai-${id} ${id === lead ? 'is-lead' : ''}"><button type="button" class="wb-pick" data-lead="${id}" aria-pressed="${id === lead}" aria-label="${NAMES[id]}를 담당으로 선택" ${busy() ? 'disabled' : ''}><img src="${avatarOf(id)}" alt=""><span><b>${NAMES[id]}</b>${id === lead ? '<small>담당</small>' : ''}${quotaBadge(quotas[id])}</span></button>
        <label class="wb-member"><input type="checkbox" data-member="${id}" ${(mode !== 'solo' && participants.includes(id)) || lead === id ? 'checked' : ''} ${busy() || mode === 'solo' || lead === id ? 'disabled' : ''}>참여</label>
        <input type="hidden" data-model="${id}" value="${esc(models[id].model)}">
        <div class="wb-model-pick"><button type="button" class="wb-model-btn" data-modelbtn="${id}" aria-expanded="false" aria-label="${NAMES[id]} 작업 모델 고르기" ${busy() ? 'disabled' : ''}><span>${esc(models[id].model)}</span><span aria-hidden="true">⌄</span></button>
          <div class="wb-model-list" hidden>${options.map((m) => `<button type="button" data-choose="${esc(m)}" aria-selected="${m === models[id].model}">${esc(state.catalog[id]?.models.find((x) => x.id === m)?.label || m)}</button>`).join('')}
            <input data-custom="${id}" placeholder="직접 입력 후 Enter" aria-label="${NAMES[id]} 모델 직접 입력"></div></div>
        <select aria-label="${NAMES[id]} 생각 수준" data-effort="${id}" ${busy() || id === 'gemini' ? 'disabled' : ''}>${efforts.map((effort) => `<option value="${effort}" ${effort === (models[id].effort || '') ? 'selected' : ''}>${effort || (id === 'gemini' ? '모델에 포함' : '기본')}</option>`).join('')}</select>
      </div>`;
    }).join('')}</div><p>${s ? '모델·생각 수준은 이 세션에만 적용됩니다.' : '먼저 고른 담당·모델은 프로젝트를 선택하면 새 세션에 적용돼요.'}</p></div></details>`;
  $('#wbSettings').querySelectorAll('.wb-model-card').forEach((card) => card.onclick = (e) => {
    if (busy() || e.target.closest('input, select, label, .wb-model-pick')) return;
    const id = card.querySelector('[data-lead]').dataset.lead;
    if (id !== lead) configure({ lead: id });
  });
  $('#wbSettings').querySelectorAll('[data-member]').forEach((el) => el.onchange = () => {
    const participants = [...$('#wbSettings').querySelectorAll('[data-member]:checked')].map((node) => node.dataset.member);
    configure({ participants });
  });
  const setModel = (id, model) => configure({ models: { [id]: { model: model.trim(), effort: $(`[data-effort="${id}"]`).value } } });
  $('#wbSettings').querySelectorAll('[data-effort]').forEach((el) => el.onchange = () => setModel(el.dataset.effort, $(`[data-model="${el.dataset.effort}"]`).value));
  $('#wbSettings').querySelectorAll('[data-modelbtn]').forEach((btn) => btn.onclick = () => {
    const list = btn.nextElementSibling; list.hidden = !list.hidden; btn.setAttribute('aria-expanded', String(!list.hidden));
  });
  $('#wbSettings').querySelectorAll('[data-choose]').forEach((el) => el.onclick = () => setModel(el.closest('.wb-model-card').querySelector('[data-modelbtn]').dataset.modelbtn, el.dataset.choose));
  $('#wbSettings').querySelectorAll('[data-custom]').forEach((el) => el.onkeydown = (e) => {
    if (e.key === 'Enter' && el.value.trim()) { e.preventDefault(); e.stopPropagation(); setModel(el.dataset.custom, el.value); }
  });
}
async function configure(body) {
  if (!sessionId) {
    // No session yet: remember the choice and apply it to the first session created.
    const { models, ...rest } = body;
    Object.assign(pending, rest);
    if (models) pending.models = { ...pending.models, ...Object.fromEntries(Object.entries(models).map(([id, m]) => [id, { ...pending.models?.[id], ...m }])) };
    settingsKey = ''; renderSettings(); return;
  }
  await perform(async () => {
    try { await api('/settings', { id: sessionId, ...body }); }
    finally { settingsKey = ''; await refresh(); }
  });
}
const avatarOf = (id) => `/avatars/${id}-pixel-128.png`;
const quotaBadge = (q) => (q.known ? `<small class="wb-quota wb-quota-${q.level}" title="남은 사용량 (5시간·주간 중 적은 쪽)">${QUOTA_ICON[q.level]} ${q.pct}%</small>`
  : '<small class="wb-quota wb-quota-unknown" title="CLI에서 최근 사용량을 받지 못했어요">사용량 확인 불가</small>');
// A small modal with explicit choices; resolves to the chosen value ('cancel' on Esc).
function choose(title, text, choices) {
  const dialog = $('#wbChoiceDialog');
  $('#wbChoiceTitle').textContent = title; $('#wbChoiceText').textContent = text;
  return new Promise((resolve) => {
    $('#wbChoiceButtons').replaceChildren(...choices.map((c) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = c.label;
      if (c.primary) b.className = 'wb-primary';
      b.onclick = () => { dialog.returnValue = c.value; dialog.close(); };
      return b;
    }));
    dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true });
    dialog.returnValue = ''; dialog.showModal();
  });
}
// Before sending: warn about AIs that are nearly out of usage. The user decides; nothing changes silently.
async function confirmQuota(s) {
  const check = quotaCheck({ mode: s.mode, lead: s.lead, participants: s.participants, usage, available: IDS.filter((id) => state.catalog[id]?.available) });
  if (!check) return true;
  const names = check.low.map((id) => `${NAMES[id]}(${check.pct[id]}%)`).join(', ');
  const alt = check.alternative;
  if (check.mode === 'solo') {
    const pick = await choose(`⚠ ${NAMES[s.lead]}의 남은 사용량이 적습니다 (${check.pct[s.lead]}%)`,
      '긴 작업에서는 중간에 한도가 부족할 수 있습니다. 남은 사용량은 각 AI CLI가 알려준 계정 기준 값입니다.',
      [{ label: `${NAMES[s.lead]} 그대로 사용`, value: 'keep', primary: true }, ...(alt ? [{ label: `${NAMES[alt.id]} 사용 (남은 ${alt.pct}%)`, value: 'switch' }] : []), { label: '취소', value: 'cancel' }]);
    if (pick === 'switch') await api('/settings', { id: s.id, lead: alt.id });
    return pick !== 'cancel';
  }
  const pick = await choose(`⚠ ${names} 사용량이 얼마 남지 않았습니다`,
    `이번 ${MODES[s.mode]}에 포함하면 작업 도중 한도가 부족해 중단될 수 있습니다.`,
    [{ label: '그대로 진행', value: 'keep', primary: true },
      ...(check.canExclude ? [{ label: `${check.low.map((id) => NAMES[id]).join(', ')} 제외하고 진행`, value: 'exclude' }] : []),
      ...(check.leadLow && alt ? [{ label: `담당을 ${NAMES[alt.id]}로 바꾸고 진행`, value: 'switch' }] : []), { label: '취소', value: 'cancel' }]);
  if (pick === 'exclude') await api('/settings', { id: s.id, participants: s.participants.filter((id) => !check.low.includes(id)) });
  if (pick === 'switch') await api('/settings', { id: s.id, lead: alt.id });
  return pick !== 'cancel';
}
function notice(text) { $('#wbNotice').textContent = text; $('#wbNotice').hidden = !text; }
function messageNode(message, prev) {
  const el = document.createElement(message.from === 'tool' ? 'details' : 'article');
  const ai = IDS.includes(message.from);
  const cont = ai && prev?.from === message.from && prev.phase === message.phase;
  el.className = `wb-message ${message.from === 'user' ? 'wb-mine' : ''} ${message.from === 'tool' ? 'wb-tool' : ''} ${message.from === 'system' ? 'wb-system' : ''} ${ai ? `wb-ai wb-ai-${message.from}` : ''} ${cont ? 'wb-cont' : ''}`;
  if (message.from === 'tool') {
    const summary = document.createElement('summary'); summary.textContent = `${message.by ? `${NAMES[message.by]} · ` : ''}${message.phase || '도구 결과'}`;
    const pre = document.createElement('pre'); pre.textContent = (message.command ? `${JSON.stringify(message.command)}\n` : '') + message.text;
    el.append(summary, pre);
  } else if (ai) {
    el.innerHTML = `<img class="wb-av" src="${avatarOf(message.from)}" alt="${esc(NAMES[message.from])}"><div class="wb-body"><div class="wb-message-head"><b>${esc(NAMES[message.from])}</b>${message.phase ? `<span class="wb-phase">${esc(message.phase)}</span>` : ''}</div><div class="wb-message-text text">${renderMarkdown(message.text)}</div></div>`;
  } else {
    el.innerHTML = `<div class="wb-message-head">${esc(NAMES[message.from] || message.from)}${message.phase ? ` · ${esc(message.phase)}` : ''}</div><div class="wb-message-text text">${renderMarkdown(message.text)}</div>`;
  }
  return el;
}
function renderStartSteps(project, s) {
  const mode = s?.mode || pending.mode || 'solo', lead = s?.lead || pending.lead || 'gpt';
  const steps = [
    ['프로젝트 폴더 선택', project ? project.name : '작업할 로컬 폴더를 연결해요', project ? 'done' : 'now'],
    ['AI와 작업 방식 선택', `지금: ${MODES[mode]} · ${NAMES[lead]} — 아래 도구 막대에서 바꿀 수 있어요`, s ? 'done' : project ? 'now' : 'todo'],
    ['원하는 작업 설명', '입력창에 하고 싶은 일을 편하게 적어 주세요', s ? 'now' : 'todo'],
  ];
  $('#wbStartSteps').innerHTML = steps.map(([title, help, st], i) => `<li class="wb-start-${st}"><span class="wb-start-mark" aria-hidden="true">${st === 'done' ? '✓' : i + 1}</span><span><b>${esc(title)}</b><small>${esc(help)}</small></span></li>`).join('');
}
// Messages of a task: the request first, then its card (execution record), then the conversation.
// Messages without a known task (older sessions) render exactly as before.
function conversationNodes(s) {
  if (!s) return [];
  const tasks = new Map((s.tasks || []).map((t) => [t.id, t]));
  const nodes = [], placed = new Set();
  let prev = null;
  for (const m of s.messages) {
    const task = tasks.get(m.taskId);
    if (task && m.from === 'tool') continue;
    nodes.push(messageNode(m, prev)); prev = m;
    if (task && !placed.has(task.id)) {
      placed.add(task.id); prev = null;
      nodes.push(taskCard(task, s.messages.filter((x) => x.taskId === task.id && x.from === 'tool'), s));
    }
  }
  return nodes;
}
function taskSteps(task, tools) {
  const running = task.status === 'running', finished = task.status === 'done';
  if (task.mode !== 'solo') {
    const names = PHASE_STEPS[task.mode] || [];
    const reached = Math.max(0, names.indexOf(task.phase));
    return names.map((label, i) => ({ label, state: i < reached || (i === reached && finished) ? 'done' : i === reached ? (running ? 'now' : 'stop') : 'todo' }));
  }
  const seen = new Set(tools.map((m) => STEP_OF[m.phase]).filter((i) => i !== undefined));
  const last = running ? task.current.action : task.stoppedAt;
  if (STEP_OF[last] !== undefined) seen.add(STEP_OF[last]);
  const reached = finished ? SOLO_STEPS.length - 1 : Math.max(0, ...seen);
  return SOLO_STEPS.map((label, i) => ({ label,
    state: i < reached ? (seen.has(i) ? 'done' : 'skip') : i === reached ? (finished ? 'done' : running ? 'now' : 'stop') : 'todo' }));
}
function toolLine(m) {
  if (m.phase === '명령 결과') {
    let code = '?';
    try { code = JSON.parse(m.text).code; } catch { /* redacted output may not parse; the code stays unknown */ }
    return `명령 실행 · ${(m.command || []).join(' ').slice(0, 80)} · 종료 코드 ${code}`;
  }
  return `${!m.path || m.path === '.' ? '프로젝트 최상위' : m.path} ${DONE_TEXT[m.phase]}`;
}
const duration = (ms) => {
  const sec = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};
const openLogs = new Set();
function taskCard(task, tools, s) {
  const el = document.createElement('section');
  el.className = `wb-task wb-task-${task.status}`;
  el.setAttribute('aria-label', `작업: ${task.title}`);
  const running = task.status === 'running';
  const files = task.files || [];
  const projectBusy = state.sessions.some((x) => x.projectId === s.projectId && ['running', 'waiting'].includes(x.status));
  const blocked = running ? '작업이 끝난 뒤 되돌릴 수 있어요.' : projectBusy ? '같은 프로젝트의 작업이 진행 중이에요.' : '';
  const fileBlock = (f) => blocked || (f.status === 'restored' ? '이미 되돌렸어요.' : f.status !== 'applied' ? '적용 확인이 필요한 변경이라 자동으로 되돌릴 수 없어요.' : '');
  const taskBlock = blocked || (files.every((f) => f.status === 'restored') ? '이미 모두 되돌렸어요.' : !files.some((f) => f.status === 'applied') ? '자동으로 되돌릴 수 있는 변경이 없어요.' : '');
  const ran = task.commands.length, ok = task.commands.filter((c) => c.code === 0 && !c.timedOut).length;
  const tests = ran ? `명령 ${ran}회 · 성공 ${ok}${ran - ok ? ` · 실패 ${ran - ok}` : ''}` : '실행하지 않음';
  const crew = task.mode === 'solo' ? '' : ` · 참여: ${task.participants.map((id) => NAMES[id]).join(', ')}`;
  const { actor, action, file } = task.current;
  const now = actor ? `${NAMES[actor]} · ${file ? `${file} ` : ''}${ACTION_TEXT[action] || '작업 중'}` : '작업 준비 중';
  const lines = tools.filter((m) => DONE_TEXT[m.phase] || m.phase === '명령 결과').slice(-5);
  el.innerHTML = `<header class="wb-task-head"><b>${esc(task.title)}</b><span class="wb-task-state">${running ? '<i class="wb-task-dot" aria-hidden="true"></i>' : task.status === 'done' ? '✅ ' : ''}${esc(TASK_STATUS[task.status] || task.status)} · <span class="wb-task-time" data-start="${task.startedAt}" data-end="${task.endedAt || ''}">${duration((task.endedAt || Date.now()) - task.startedAt)}</span></span></header>
    <p class="wb-task-meta">담당: ${esc(NAMES[task.lead])} · ${esc(MODES[task.mode])}${esc(crew)}</p>
    ${task.mode !== 'solo' ? crewList(task, s) : ''}
    <ol class="wb-task-steps">${taskSteps(task, tools).map((st) => `<li class="wb-step-${st.state}"><span aria-hidden="true">${MARK[st.state]}</span> ${esc(st.label)}<span class="wb-sr"> (${MARK_TEXT[st.state]})</span></li>`).join('')}</ol>
    ${running ? `<p class="wb-task-now" role="status">● ${esc(now)}</p>` : ''}
    ${task.status === 'interrupted' && STOP_REASON[task.stopReason] ? `<p class="wb-task-note">${esc(STOP_REASON[task.stopReason])}</p>` : ''}
    ${task.status === 'failed' ? '<p class="wb-task-note">작업이 실패했어요. 아래 작업대 메시지에서 이유를 확인해 주세요.</p>' : ''}
    ${lines.length ? `<ul class="wb-task-lines">${lines.map((m) => `<li>✓ ${esc(toolLine(m))}${m.by ? ` <small>${esc(NAMES[m.by])}</small>` : ''}</li>`).join('')}</ul>` : ''}
    <p class="wb-task-summary">변경 파일 ${files.length}개 · 테스트: ${esc(tests)}</p>
    ${files.length ? `<ul class="wb-task-files">${files.map((f, i) => `<li><code>${esc(f.path)}</code> <span class="wb-plus">+${f.added}</span> <span class="wb-minus">−${f.removed}</span>${f.kind === 'create' ? ' <small>새 파일</small>' : ''}${f.changeIds.length > 1 ? ` <small>변경 ${f.changeIds.length}회</small>` : ''}${f.status === 'restored' ? ' <small>되돌림</small>' : ''}
      <span class="wb-file-actions"><button type="button" class="wb-link" data-file-view="${i}">변경 보기</button><button type="button" class="wb-link" data-file-revert="${i}" ${fileBlock(f) ? `disabled title="${esc(fileBlock(f))}"` : ''}>이 파일 되돌리기</button></span></li>`).join('')}</ul>` : ''}`;
  el.querySelectorAll('[data-file-view]').forEach((b) => b.onclick = () => showFile(files[b.dataset.fileView].path));
  el.querySelectorAll('[data-file-revert]').forEach((b) => b.onclick = () => revertFlow(task, files[b.dataset.fileRevert].path));
  if (tools.length) {
    const log = document.createElement('details'); log.className = 'wb-task-log'; log.open = openLogs.has(task.id);
    log.innerHTML = `<summary>실행 기록 ${tools.length}건</summary>`;
    log.append(...tools.map((m) => messageNode(m)));
    log.addEventListener('toggle', () => { if (log.open) openLogs.add(task.id); else openLogs.delete(task.id); });
    el.append(log);
  }
  const buttons = document.createElement('div'); buttons.className = 'wb-task-actions';
  if (files.length) {
    const show = document.createElement('button'); show.type = 'button'; show.className = 'wb-outline';
    show.textContent = running ? '변경 내용 보기' : '변경사항 확인';
    show.onclick = () => { $('#wbChanges').open = true; $('#wbChanges').scrollIntoView({ block: 'start', behavior: 'smooth' }); };
    buttons.append(show);
  }
  if (running && state.session?.id === s.id && busy()) {
    const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'wb-outline'; stop.textContent = '작업 중단';
    stop.onclick = () => { stop.disabled = true; perform(async () => { await api('/cancel', { id: s.id }); await refresh(); }); };
    buttons.append(stop);
  }
  if (files.length) {
    const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'wb-outline'; undo.textContent = '되돌리기';
    undo.disabled = !!taskBlock; undo.title = taskBlock || '이 작업의 변경을 작업 전 상태로 되돌립니다';
    undo.onclick = () => revertFlow(task);
    buttons.append(undo);
    if (taskBlock && !running) { const why = document.createElement('small'); why.className = 'wb-task-block'; why.textContent = taskBlock; buttons.append(why); }
  }
  if (buttons.childElementCount) el.append(buttons);
  return el;
}
function crewList(task, s) {
  const running = task.status === 'running';
  const said = s.messages.filter((m) => m.taskId === task.id && IDS.includes(m.from));
  return `<ul class="wb-crew" aria-label="참여 AI의 역할과 상태">${task.participants.map((id) => {
    const { actor, action } = task.current;
    const last = said.filter((m) => m.from === id).at(-1);
    const work = task.working?.includes(id);
    const st = running && work ? ['now', `● ${PHASE_WORK[task.phase] || ACTION_TEXT[action] || '작업 중'}`]
      : running && actor === id && action === 'plan_approval' ? ['now', '● 사용자 계획 승인 대기']
      : running && actor === id && action === 'approval' ? ['now', '● 명령 실행 승인 대기']
      : running && actor === id && ACTION_TEXT[action] ? ['now', `● ${ACTION_TEXT[action]}`]
      : last && PHASE_DONE[last.phase] ? [last.phase === '이견' ? 'stop' : 'done', PHASE_DONE[last.phase]]
      : running ? ['todo', '○ 대기'] : ['skip', '– 기록 없음'];
    const job = task.assignments?.[id];
    return `<li class="wb-crew-${st[0]}"><img src="${avatarOf(id)}" alt=""><span><b>${esc(NAMES[id])}</b>${task.roles?.[id] ? ` <small>역할: ${esc(task.roles[id])}</small>` : ''}${job ? `<em>${esc(job.task.slice(0, 90))}${job.files.length ? ` · 파일 ${job.files.length}개` : ''}</em>` : ''}</span><span class="wb-crew-state">${esc(st[1])}</span></li>`;
  }).join('')}</ul>`;
}
function showFile(file) {
  openFiles.add(file);
  $('#wbChanges').open = true;
  const group = [...$('#wbChangeList').children].find((g) => g.dataset.path === file);
  if (group) { group.open = true; group.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
}
// Preview first (nothing is written), then the user decides; the server re-checks every file while restoring.
function revertFlow(task, file) {
  return perform(async () => {
    const scope = { id: sessionId, taskId: task.id, ...(file ? { path: file } : {}) };
    const { files } = await api('/revert/preview', scope);
    const ok = files.filter((f) => f.ok), bad = files.filter((f) => !f.ok);
    const lines = [...ok.map((f) => `✓ ${f.path}${f.deletes ? ' — 새로 만든 파일이라 삭제돼요' : f.changes.length > 1 ? ` — 변경 ${f.changes.length}회를 최신 것부터 되돌려요` : ''}`),
      ...bad.map((f) => `✕ ${f.path} — ${f.reason}`)];
    if (!ok.length) { alert(`되돌릴 수 있는 파일이 없어요.\n\n${lines.join('\n')}`); return; }
    const ask = bad.length ? `되돌릴 수 있는 ${ok.length}개 파일만 되돌릴까요? 나머지 파일은 그대로 둡니다.` : `${ok.length}개 파일을 이 작업 전 상태로 되돌릴까요?`;
    if (!confirm(`되돌리기 미리보기\n\n${lines.join('\n')}\n\n${ask}`)) return;
    try { await api('/revert', { ...scope, onlyPossible: bad.length > 0 }); } finally { await refresh(); }
  });
}
setInterval(() => {
  if (panel.hidden) return;
  panel.querySelectorAll('.wb-task-time[data-end=""]').forEach((el) => { el.textContent = duration(Date.now() - Number(el.dataset.start)); });
}, 1000);
function renderPermission() {
  const pending = state.session?.pending, box = $('#wbPermission');
  box.hidden = !pending;
  box.classList.toggle('wb-permission-risk', !!pending?.risk);
  if (!pending) { box.replaceChildren(); return; }
  box.classList.toggle('wb-permission-plan', pending.kind === 'plan');
  if (pending.kind === 'plan') {
    box.innerHTML = `<h3>📋 실행 계획 승인</h3><p>AI들이 합의한 계획이에요. 승인하면 아래 담당대로 실제 파일 수정을 시작해요. 아직 아무 파일도 바뀌지 않았어요.</p>
      ${pending.text ? `<div class="wb-plan-text">${renderMarkdown(pending.text)}</div>` : ''}
      <ul class="wb-plan-list">${pending.tasks.map((t) => `<li><b>${esc(NAMES[t.id] || t.id)}</b>${t.role ? ` <small>${esc(t.role)}</small>` : ''}<div>${esc(t.task)}</div><div class="wb-plan-files">${t.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div></li>`).join('')}</ul>
      <p>계획을 승인해도 명령 실행은 명령 실행 권한 설정대로 따로 묻고, 위험한 명령은 자동 승인이어도 다시 확인해요.</p>
      <div><button type="button" data-approval="yes" class="wb-primary">계획 승인</button><button type="button" data-approval="no">중단</button></div>`;
  } else if (pending.risk) {
    const line = [pending.command, ...pending.args].map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
    box.innerHTML = `<h3>⚠ 중요한 명령입니다.</h3><pre>${esc(line)}</pre><ul>${pending.risk.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      ${pending.reason ? `<p>AI가 밝힌 목적: ${esc(pending.reason)}</p>` : ''}<p>실행 위치: <code>${esc(pending.cwd)}</code></p>
      ${pending.risk.auto ? '<p>자동 승인 중이지만 되돌리기 어려울 수 있는 명령이라 한 번 더 확인해요.</p>' : ''}
      <div><button type="button" data-approval="no" class="wb-primary">취소</button><button type="button" data-approval="yes">이번에만 실행</button></div>`;
  } else box.innerHTML = `<h3>명령 실행 승인</h3><p>${esc(pending.reason)}</p><p>실행 위치: <code>${esc(pending.cwd)}</code></p><pre>${esc(JSON.stringify([pending.command, ...pending.args], null, 2))}</pre>
    <p>운영체제 권한으로 실행되므로 프로젝트 밖이나 네트워크에도 영향을 줄 수 있습니다. 위 실행 파일과 인자를 확인하고 신뢰하는 명령만 승인하세요.</p>
    <div><button type="button" data-approval="yes" class="wb-primary">확인한 명령 실행</button><button type="button" data-approval="no">거절하고 중단</button></div>`;
  box.querySelectorAll('[data-approval]').forEach((button) => button.onclick = () => perform(async () => {
    box.querySelectorAll('button').forEach((b) => b.disabled = true);
    await api('/approve', { id: sessionId, pendingId: pending.id, allow: button.dataset.approval === 'yes' }); await refresh();
  }));
}
function renderChanges() {
  const changes = state.session?.changes || [];
  $('#wbChanges').hidden = !changes.length;
  $('#wbChangeTitle').textContent = `변경 ${changes.length}건 · 원문 보존`;
  // Grouped by file, newest first. A change's diff is requested only when it is opened, then kept:
  // a recorded change never changes, so the browser never asks or computes it twice.
  const groups = new Map();
  for (const c of changes.slice().reverse()) groups.set(c.path, [...(groups.get(c.path) || []), c]);
  $('#wbChangeList').replaceChildren(...[...groups].map(([file, list]) => {
    const group = document.createElement('details'); group.className = 'wb-change-file'; group.dataset.path = file; group.open = openFiles.has(file);
    group.innerHTML = `<summary><code>${esc(file)}</code>${list.length === 1 ? ` <span class="wb-plus">+${list[0].added}</span> <span class="wb-minus">−${list[0].removed}</span>` : ''} <small>변경 ${list.length}회</small></summary>`;
    group.addEventListener('toggle', () => { if (group.open) openFiles.add(file); else openFiles.delete(file); });
    group.append(...list.map(changeNode));
    return group;
  }));
}
const diffs = new Map(), openChanges = new Set(), openFiles = new Set();
const CHANGE_STATUS = { applied: '적용됨', restored: '되돌림', pending: '적용 확인 필요' };
function changeNode(change) {
  const item = document.createElement('details'); item.className = 'wb-change';
  const task = state.session.tasks?.find((t) => t.id === change.taskId);
  item.innerHTML = `<summary>${change.kind === 'create' ? '새 파일' : '수정'} · <span class="wb-plus">+${change.added}</span> <span class="wb-minus">−${change.removed}</span> · ${CHANGE_STATUS[change.status] || change.status}${task ? ` · <small>${esc(task.title)}</small>` : ''}</summary><div class="wb-diff-body"></div>`;
  const body = item.querySelector('.wb-diff-body');
  const show = async () => {
    if (!diffs.has(change.id)) {
      body.textContent = '변경 내용을 불러오는 중…';
      try { diffs.set(change.id, await api(`/change?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(change.id)}`)); }
      catch (e) { body.textContent = `변경 내용을 불러오지 못했어요: ${e.message}`; return; }
    }
    body.replaceChildren(diffNode(diffs.get(change.id)));
  };
  item.open = openChanges.has(change.id);
  if (item.open) show();
  item.addEventListener('toggle', () => { if (item.open) { openChanges.add(change.id); show(); } else openChanges.delete(change.id); });
  const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = '이 변경 되돌리기';
  restore.disabled = busy() || change.status !== 'applied';
  restore.onclick = () => {
    if (!confirm(`${change.path}의 이 변경을 되돌릴까요? 이후에 수정된 파일은 덮어쓰지 않습니다.`)) return;
    perform(async () => { await api('/restore', { id: sessionId, changeId: change.id }); await refresh(); });
  };
  item.append(restore);
  return item;
}
function diffNode(d) {
  const box = document.createElement('div'); box.className = 'wb-diff';
  const notes = [d.replacedBlock && '바뀐 부분이 많아 해당 구간 전체를 교체한 것으로 보여 줘요.', d.clipped && '너무 길어서 앞부분만 보여 줘요.', d.eofChanged && '파일 끝 줄바꿈이 바뀌었어요.'].filter(Boolean);
  const row = ([sign, text, oldNo, newNo]) => `<div class="wb-dl ${sign === '+' ? 'wb-dl-add' : sign === '-' ? 'wb-dl-del' : ''}"><span class="wb-ln">${oldNo ?? ''}</span><span class="wb-ln">${newNo ?? ''}</span><span class="wb-sign">${sign === '+' ? '+' : sign === '-' ? '−' : ''}</span><code>${esc(text)}</code></div>`;
  box.innerHTML = notes.map((n) => `<p class="wb-diff-note">${esc(n)}</p>`).join('')
    + (d.hunks.length ? d.hunks.map((h) => `<div class="wb-hunk"><div class="wb-hunk-head">${d.kind === 'create' ? '새 파일' : `${h.oldStart}번째 줄 근처`}</div>${h.rows.map(row).join('')}</div>`).join('')
      : '<p class="wb-diff-note">줄 내용은 바뀌지 않았어요.</p>');
  return box;
}
async function selectSession(id) {
  drafts.set(sessionId, $('#wbInput').value);
  sessionId = id; contentKey = ''; settingsKey = '';
  $('#wbInput').value = drafts.get(id) || '';
  await perform(refresh);
  if (id && prefill) { const text = prefill; prefill = ''; applyPrefill(text); }
}
async function createSession() {
  await perform(async () => {
    const s = await api('/session', { projectId }); await selectSession(s.id);
    if (Object.keys(pending).length) { const body = pending; pending = {}; await configure(body); }
  });
}
async function browse(value = '', offset = 0) {
  $('#wbFolderError').textContent = '';
  try {
    folder = await api(`/directories?path=${encodeURIComponent(value)}&offset=${offset}`);
    folderOffset = offset; $('#wbFolderPath').value = folder.path;
    $('#wbFolderMore').hidden = !folder.more;
    $('#wbFolderUp').disabled = folder.path === folder.parent;
    $('#wbFolders').replaceChildren(...folder.entries.map((entry) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `▱ ${entry.name}`;
      button.onclick = () => browse(entry.path); return button;
    }));
    if (!folder.entries.length) $('#wbFolders').textContent = '하위 폴더가 없습니다. 이 폴더를 선택할 수 있습니다.';
  } catch (e) { $('#wbFolderError').textContent = e.message; }
}
function openFolder() {
  $('#wbFolderDialog').showModal();
  browse(state?.projects.find((p) => p.id === projectId)?.path || '');
}
// ---- fixed per-AI limit gauges (5h / weekly), fed by the chat room's usage report ----
const LIMIT_LABEL = { '5h': '5시간', week: '주간' };
function resetText(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return '곧 초기화';
  const days = Math.floor(diff / 86400000), hours = Math.floor((diff % 86400000) / 3600000), mins = Math.floor((diff % 3600000) / 60000);
  return days ? `${days}일 ${hours}시간 뒤 초기화` : hours ? `${hours}시간 ${mins}분 뒤 초기화` : `${mins}분 뒤 초기화`;
}
setInterval(() => { if (!panel.hidden) { renderLimits(); if (state) renderSettings(); } }, 60000);
function renderLimits() {
  $('#wbLimits').innerHTML = IDS.map((id) => {
    const u = usage?.[id], windows = limitWindows(id, u);
    const stale = !u || !u.ok || u.restored || Date.now() - u.at > 30 * 60000;
    const bars = windows.length ? windows.map((w) => {
      const pct = Math.round(w.remainingPct);
      const exact = w.resetsAt ? new Date(w.resetsAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      return `<div class="wb-limit ${batteryLevel(pct)} ${stale ? 'stale' : ''}" title="${esc(`${NAMES[id]} ${LIMIT_LABEL[w.id]} 남은 한도 ${pct}%${exact ? ` · ${exact}에 초기화` : ''}${stale ? ' (이전 값)' : ''}`)}"><span>${LIMIT_LABEL[w.id]}</span><span class="wb-limit-bar"><i style="width:${pct}%"></i></span><b>${pct}%</b><small>${w.resetsAt ? resetText(w.resetsAt) : '초기화 시각 모름'}</small></div>`;
    }).join('') : `<div class="wb-limit none"><span>${usage ? '확인 불가' : '확인 중…'}</span></div>`;
    return `<div class="wb-limit-ai wb-limit-${id}"><div class="wb-limit-name">${NAMES[id]}</div>${bars}</div>`;
  }).join('');
}
async function loadUsage() {
  try { usage = (await (await fetch('/api/state')).json()).usage; } catch { /* keep the last values */ }
  renderLimits();
  if (state) renderSettings();
}
window.addEventListener('usage-update', (e) => { usage = e.detail; renderLimits(); if (state && !panel.hidden) renderSettings(); });
renderLimits();

// ---- settings dialog (browser-local) ----
const root = document.documentElement;
const applyMotion = (reduce) => panel.classList.toggle('wb-reduce', reduce);
$('#wbSettingsBtn').onclick = () => {
  $('#wbTheme').value = localStorage.getItem('chatroom-theme') || '';
  $('#wbMotion').checked = localStorage.getItem('workbench-motion') === 'reduce';
  $('#wbSettingsDialog').showModal();
};
$('#wbSettingsClose').onclick = () => $('#wbSettingsDialog').close();
$('#wbTheme').onchange = (e) => {
  if (e.target.value) { root.dataset.theme = e.target.value; localStorage.setItem('chatroom-theme', e.target.value); }
  else { delete root.dataset.theme; localStorage.removeItem('chatroom-theme'); }
};
$('#wbMotion').onchange = (e) => { localStorage.setItem('workbench-motion', e.target.checked ? 'reduce' : ''); applyMotion(e.target.checked); };
$('#wbUsageRefresh').onclick = async () => {
  const button = $('#wbUsageRefresh'); button.disabled = true; button.textContent = '확인 중…';
  try {
    const response = await fetch('/api/usage/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error((await response.json()).error || `요청 실패 (${response.status})`);
    $('#wbUsageNote').textContent = '새로 확인을 요청했습니다. 잠시 뒤 한도가 갱신됩니다.';
  } catch (e) { $('#wbUsageNote').textContent = e.message; }
  finally { button.disabled = false; button.textContent = '지금 새로 확인'; }
};
applyMotion(localStorage.getItem('workbench-motion') === 'reduce');

let closing = 0, prefill = '';
async function openPanel() {
  clearTimeout(closing); panel.classList.remove('wb-closing');
  panel.hidden = false; document.querySelector('#app').inert = true; opener.setAttribute('aria-expanded', 'true');
  loadUsage();
  await refresh(); $('#wbClose').focus();
}
opener.onclick = () => perform(openPanel);
// From the chat: fill the request box only. The user still picks a mode and presses send.
function applyPrefill(text) {
  const input = $('#wbInput');
  if (input.value.trim() && input.value !== text && !confirm('작업 요청 입력창에 쓰던 내용이 있어요. 채팅 대화 내용으로 바꿀까요?')) return;
  input.value = text.slice(0, 12000); drafts.set(sessionId, input.value);
  notice('채팅 대화를 불러왔어요. 내용을 확인하고 작업 방식(단독·분담·협업)을 고른 뒤 ↑ 버튼으로 시작하세요. 아직 실행되지 않았어요.');
  input.focus(); input.setSelectionRange(0, 0); input.scrollTop = 0;
}
window.addEventListener('workbench-prefill', (e) => perform(async () => {
  if (panel.hidden) await openPanel();
  if (sessionId) applyPrefill(e.detail.text);
  else { prefill = e.detail.text; notice('채팅 대화를 가져왔어요. 프로젝트와 작업 세션을 고르면 입력창에 채워져요.'); }
}));
$('#wbClose').onclick = () => {
  document.querySelector('#app').inert = false; opener.setAttribute('aria-expanded', 'false'); opener.focus();
  panel.classList.add('wb-closing');
  closing = setTimeout(() => { panel.hidden = true; panel.classList.remove('wb-closing'); }, 180);
};
$('#wbProjectAdd').onclick = openFolder; $('#wbEmptyPick').onclick = () => (projectId ? createSession() : openFolder()); $('#wbProjectShortcut').onclick = openFolder;
const APPROVALS = {
  ask: { name: '매번 요청', help: '명령을 실행하기 전마다 내가 직접 승인' },
  auto: { name: '자동 승인', help: '묻지 않고 바로 실행 · 삭제·외부 전송 같은 위험한 명령은 다시 확인' },
  deny: { name: '자동 거절', help: '명령은 실행하지 않음 (파일 수정만 진행)' },
};
const MODE_HELP ={ solo: '선택한 AI가 혼자 처리', divide: '일을 나눠 순서대로 실행', collaborate: '의견 → 계획 → 합의 후 실행' };
$('#wbModeMenu').innerHTML = Object.entries(MODES).map(([value, name]) => `<button type="button" role="option" data-mode="${value}"><b>${name}</b><small>${MODE_HELP[value]}</small></button>`).join('');
const setModeMenu = (open) => { $('#wbModeMenu').hidden = !open; $('#wbModeBtn').setAttribute('aria-expanded', String(open)); };
$('#wbModeBtn').onclick = () => setModeMenu($('#wbModeMenu').hidden);
$('#wbModeMenu').querySelectorAll('[data-mode]').forEach((el) => el.onclick = () => { setModeMenu(false); $('#wbMode').value = el.dataset.mode; configure({ mode: el.dataset.mode }); });
const setApprovalMenu = (open) => { $('#wbApprovalMenu').hidden = !open; $('#wbApprovalBtn').setAttribute('aria-expanded', String(open)); };
$('#wbApprovalMenu').innerHTML = Object.entries(APPROVALS).map(([value, a]) => `<button type="button" role="option" data-approval-value="${value}"><b>${a.name}</b><small>${a.help}</small></button>`).join('');
$('#wbApprovalBtn').onclick = () => { setModeMenu(false); setApprovalMenu($('#wbApprovalMenu').hidden); };
$('#wbApprovalMenu').querySelectorAll('[data-approval-value]').forEach((el) => el.onclick = () => { setApprovalMenu(false); configure({ approval: el.dataset.approvalValue }); });
$('#wbModeBtn').addEventListener('click', () => setApprovalMenu(false));
panel.addEventListener('click', (e) => {
  if (!e.target.closest('.wb-approval')) setApprovalMenu(false);
  if (!e.target.closest('.wb-mode:not(.wb-approval)')) setModeMenu(false);
  if (!e.target.closest('.wb-model-options') && $('.wb-model-options')) $('.wb-model-options').open = false;
  if (!e.target.closest('.wb-context-menu')) $('#wbContextDetails').open = false;
});
$('#wbFolderClose').onclick = () => $('#wbFolderDialog').close();
$('#wbBrowseForm').onsubmit = (e) => { e.preventDefault(); browse($('#wbFolderPath').value.trim()); };
$('#wbFolderUp').onclick = () => browse(folder.parent);
$('#wbFolderMore').onclick = () => browse(folder.path, folderOffset + 100);
$('#wbFolderChoose').onclick = async () => {
  const button = $('#wbFolderChoose'); button.disabled = true;
  try {
    const project = await api('/project', { path: $('#wbFolderPath').value.trim() });
    projectId = project.id; $('#wbFolderDialog').close(); await createSession();
  } catch (e) { $('#wbFolderError').textContent = e.message; }
  finally { button.disabled = false; }
};
$('#wbProjects').onchange = () => {
  projectId = $('#wbProjects').value;
  const last = state.sessions.filter((s) => s.projectId === projectId).at(-1);
  selectSession(last?.id || '');
};
$('#wbNew').onclick = createSession;
$('#wbTitle').onchange = () => configure({ title: $('#wbTitle').value });
$('#wbForm').onsubmit = (e) => {
  e.preventDefault();
  if (document.activeElement?.closest('.wb-model-menu')) return;
  const text = $('#wbInput').value.trim();
  if (!sessionId || busy() || sending || !text) return;
  perform(async () => {
    sending = true; $('#wbSend').disabled = true;
    try {
      if (!await confirmQuota(state.session)) return;
      await api('/send', { id: sessionId, text });
      $('#wbInput').value = ''; drafts.delete(sessionId); notice('');
    } finally { sending = false; await refresh(); }
  });
};
$('#wbInput').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#wbForm').requestSubmit(); }
};
$('#wbCancel').onclick = () => perform(async () => { await api('/cancel', { id: sessionId }); await refresh(); });
window.addEventListener('workbench-update', () => {
  if (panel.hidden) return;
  clearTimeout(refreshTimer); refreshTimer = setTimeout(() => perform(refresh), 120);
});

// Original monochrome dot characters; no external fonts or image requests.
const sprites = [
  [
    '000000011101110000000',
    '000001111111111100000',
    '000011111111111110000',
    '000111111111111111000',
    '001111111111111111100',
    '011111111111111111110',
    '011110000000000011110',
    '1111' + '0000000000000' + '1111',
    '1111' + '0010000000000' + '1111',
    '1111' + '0001000000000' + '1111',
    '1111' + '0000100000000' + '1111',
    '1111' + '0001000011100' + '1111',
    '1111' + '0010000000000' + '1111',
    '1111' + '0000000000000' + '1111',
    '011110000000000011110',
    '011111111111111111110',
    '001111111111111111100',
    '000111111111111111000',
    '000000111111111000000',
    '00011' + '01111111110' + '11000',
    '00111' + '01100100110' + '11100',
    '00111' + '01101011110' + '11100',
    '00011' + '01111111110' + '11000',
    '00000' + '00111111100' + '00000',
    '00000' + '00111011100' + '00000',
    '00000' + '00111011100' + '00000',
    '00000' + '00110001100' + '00000',
  ],
  ['000000010000000', '000000111000000', '000000111000000', '000001111100000', '000001111100000', '000011111110000', '011111111111110', '111111111111111', '011111111111110', '000011111110000', '000001111100000', '000001111100000', '000000111000000', '000000111000000', '000000010000000'],
  ['000000000000000', '000111111111000', '001111111111100', '001111111111100', '111100111001111', '111100111001111', '111111111111111', '001111111111100', '001111111111100', '000111111111000', '000110101011000', '000110101011000', '000110000011000', '000000000000000', '000000000000000'],
];
$('#wbCharacters').innerHTML = sprites.map((rows, i) => `<div class="wb-character" style="--index:${i}"><svg viewBox="0 0 ${rows[0].length * 4} ${rows.length * 4}" role="img" aria-label="${i === 0 ? 'Codex' : NAMES[IDS[i]]} 도트 캐릭터">${rows.flatMap((row, y) => [...row].map((value, x) => value === '1' ? `<circle cx="${x * 4 + 2}" cy="${y * 4 + 2}" r="1.45"/>` : '')).join('')}</svg></div>`).join('');
const canvas = $('#wbEmptyText'), ctx = canvas.getContext('2d');
const source = document.createElement('canvas'); source.width = 340; source.height = 40;
const sourceCtx = source.getContext('2d');
sourceCtx.font = 'bold 23px "Malgun Gothic", sans-serif'; sourceCtx.textAlign = 'center';
sourceCtx.fillText('작업을 시작해볼까요?', 170, 29);
const pixels = sourceCtx.getImageData(0, 0, 340, 40).data;
ctx.fillStyle = '#fff';
for (let y = 0; y < 40; y += 2) for (let x = 0; x < 340; x += 2) {
  if (pixels[(y * 340 + x) * 4 + 3] > 70) { ctx.beginPath(); ctx.arc(x, y, .72, 0, Math.PI * 2); ctx.fill(); }
}
