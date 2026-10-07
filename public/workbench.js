import { esc, renderMarkdown } from './format.mjs';
import { limitWindows, batteryLevel } from './status.mjs';

const IDS = ['gpt', 'gemini', 'claude'];
const NAMES = { gpt: 'GPT', gemini: 'Gemini', claude: 'Claude Code', user: '나', system: '작업대', tool: '도구' };
const MODES = { solo: '단독', divide: '분담', collaborate: '협업' };
const STATUS = { idle: '대기', running: '작업 중', waiting: '실행 승인 대기', done: '작업 종료', interrupted: '중단됨', needs_input: '답변 필요', declined: '실행 거절됨' };
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
          <p id="wbEmptyHint">프로젝트를 선택하고 첫 작업을 이야기해 주세요.</p>
          <button type="button" id="wbEmptyPick" class="wb-outline">프로젝트 폴더 선택</button>
        </section>
        <div id="wbMessages" aria-live="polite" aria-relevant="additions"></div>
        <section id="wbPermission" class="wb-permission" hidden aria-label="명령 실행 승인"></section>
        <details id="wbChanges" class="wb-changes" hidden><summary id="wbChangeTitle">변경 파일</summary><div id="wbChangeList"></div></details>
      </div>
      <div class="wb-error" id="wbError" role="alert" hidden></div>
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
    button.innerHTML = `<span>${esc(item.title)}</span><small>${esc(STATUS[item.status] || item.status)} · ${MODES[item.mode]}</small>`;
    button.onclick = () => selectSession(item.id);
    return button;
  }));
  $('#wbAsideNote').innerHTML = state.sessions.some((x) => x.projectId === projectId) ? '채팅방·집과 별도 기록입니다.<br>같은 프로젝트의 작업은 한 번에 하나씩 진행합니다.' : '대화가 없습니다';
  if (document.activeElement !== $('#wbTitle')) $('#wbTitle').value = s?.title || '새 작업';
  $('#wbTitle').disabled = !s || busy();
  $('#wbStatus').textContent = s ? `${STATUS[s.status] || s.status}${s.phase ? ` · ${s.phase}` : ''}${s.speaker ? ` · ${NAMES[s.speaker]}` : ''}` : '';
  renderSettings();
  $('#wbEmpty').hidden = !!s?.messages.length;
  $('#wbEmptyPick').hidden = !!s;
  $('#wbEmptyHint').textContent = s ? '작업 모드와 모델을 고르고, 첫 요청을 보내세요.' : '프로젝트를 선택하고 첫 작업을 이야기해 주세요.';
  const nextContent = JSON.stringify([s?.id, s?.messages.length, s?.pending, busy(), s?.changes.map((c) => [c.id, c.status])]);
  if (contentKey !== nextContent) {
    const scroll = $('#wbScroll'), follow = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 100 || contentKey === '';
    contentKey = nextContent;
    const nodes = (s?.messages || []).map((m, i, all) => messageNode(m, all[i - 1]));
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
  const next = JSON.stringify([s?.id, s?.mode, s?.lead, s?.participants, s?.models, busy(), state.catalog, pending]);
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
    <div class="wb-model-menu"><div class="wb-model-menu-head"><b>모델 설정</b></div><div class="wb-model-grid">
    ${IDS.map((id) => {
      const options = [...new Set([models[id].model, ...(state.catalog[id]?.models || []).map((m) => m.id)])];
      const efforts = id === 'gemini' ? [''] : ['', 'low', 'medium', 'high', 'xhigh', 'max', ...(id === 'gpt' ? ['ultra'] : [])];
      return `<div class="wb-model-card wb-ai-${id} ${id === lead ? 'is-lead' : ''}"><button type="button" class="wb-pick" data-lead="${id}" aria-pressed="${id === lead}" aria-label="${NAMES[id]}를 담당으로 선택" ${busy() ? 'disabled' : ''}><img src="${avatarOf(id)}" alt=""><span><b>${NAMES[id]}</b>${id === lead ? '<small>담당</small>' : ''}</span></button>
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
function renderPermission() {
  const pending = state.session?.pending, box = $('#wbPermission');
  box.hidden = !pending;
  if (!pending) { box.replaceChildren(); return; }
  box.innerHTML = `<h3>명령 실행 승인</h3><p>${esc(pending.reason)}</p><p>실행 위치: <code>${esc(pending.cwd)}</code></p><pre>${esc(JSON.stringify([pending.command, ...pending.args], null, 2))}</pre>
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
  $('#wbChangeList').replaceChildren(...changes.slice().reverse().map((change) => {
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = `${change.path} · ${change.status === 'restored' ? '복원됨' : change.status === 'pending' ? '적용 확인 필요' : '적용됨'}`;
    const before = document.createElement('pre'); before.textContent = change.before === null ? '(새 파일)' : change.before;
    const after = document.createElement('pre'); after.textContent = change.after;
    const columns = document.createElement('div'); columns.className = 'wb-diff';
    const left = document.createElement('section'); left.innerHTML = '<b>변경 전</b>'; left.append(before);
    const right = document.createElement('section'); right.innerHTML = '<b>변경 후</b>'; right.append(after); columns.append(left, right);
    const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = '이 변경 되돌리기';
    restore.disabled = busy() || change.status !== 'applied';
    restore.onclick = () => {
      if (!confirm(`${change.path}의 이 변경을 되돌릴까요? 이후에 수정된 파일은 덮어쓰지 않습니다.`)) return;
      perform(async () => { await api('/restore', { id: sessionId, changeId: change.id }); await refresh(); });
    };
    details.append(summary, columns, restore); return details;
  }));
}
async function selectSession(id) {
  drafts.set(sessionId, $('#wbInput').value);
  sessionId = id; contentKey = ''; settingsKey = '';
  $('#wbInput').value = drafts.get(id) || '';
  await perform(refresh);
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
setInterval(() => { if (!panel.hidden) renderLimits(); }, 60000);
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
}
window.addEventListener('usage-update', (e) => { usage = e.detail; renderLimits(); });
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

let closing = 0;
opener.onclick = () => perform(async () => {
  clearTimeout(closing); panel.classList.remove('wb-closing');
  panel.hidden = false; document.querySelector('#app').inert = true; opener.setAttribute('aria-expanded', 'true');
  loadUsage();
  await refresh(); $('#wbClose').focus();
});
$('#wbClose').onclick = () => {
  document.querySelector('#app').inert = false; opener.setAttribute('aria-expanded', 'false'); opener.focus();
  panel.classList.add('wb-closing');
  closing = setTimeout(() => { panel.hidden = true; panel.classList.remove('wb-closing'); }, 180);
};
$('#wbProjectAdd').onclick = openFolder; $('#wbEmptyPick').onclick = openFolder; $('#wbProjectShortcut').onclick = openFolder;
const APPROVALS = {
  ask: { name: '매번 요청', help: '명령을 실행하기 전마다 내가 직접 승인' },
  auto: { name: '자동 승인', help: '묻지 않고 바로 실행 (주의: 프로젝트 밖에도 영향 가능)' },
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
      await api('/send', { id: sessionId, text });
      $('#wbInput').value = ''; drafts.delete(sessionId);
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
