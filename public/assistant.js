// Personal assistant UI; the existing portraits and group-chat layout are reused.
import { esc, renderMarkdown, extractLinks, splitFold } from './format.mjs';
import { memberStatus, limitWindows, batteryLevel } from './status.mjs';

const $ = (s) => document.querySelector(s);
const IDS = ['gemini', 'gpt', 'claude'];
const PHASES = { answer: '답변', opinion: '독립 의견', review: '교차 검토', final: '최종 정리' };
const STEPS = ['opinion', 'review', 'final'];
const SOURCES = { cli: { gpt: 'ChatGPT가 알려 준 목록', claude: 'Claude에 포함' }, help: 'Claude 도움말', config: '앱 기본·추천', custom: '직접 입력' };
const LIST_NOTE = {
  gpt: '이 컴퓨터의 ChatGPT가 알려 준 모델 목록이에요. 내 계정에서 실제로 되는지는 직접 써 봐야 알 수 있어요.',
  claude: '가벼운 모델일수록 빠르고 사용량을 덜 써요. haiku는 가장 가볍고, sonnet은 균형형, opus는 가장 똑똑하지만 사용량이 많아요.',
  gemini: 'Gemini 이름 끝의 low·medium·high는 생각을 얼마나 깊게 할지예요. low가 가장 가볍고 사용량이 적어요.',
};
// How to get each AI connected, in plain steps (Windows). The commands come from setup.mjs.
const CONNECT = {
  claude: { need: 'Claude 유료 요금제(Pro·Max 등) 계정이 필요해요. 무료 요금제는 안 돼요.', install: 'irm https://claude.ai/install.ps1 | iex', login: 'claude auth login' },
  gpt: { need: 'ChatGPT 계정이 필요해요.', install: 'irm https://chatgpt.com/codex/install.ps1 | iex', login: 'codex login' },
  gemini: { need: 'Google 계정이 필요해요.', install: 'irm https://antigravity.google/cli/install.ps1 | iex', login: 'agy' },
};
const EXAMPLES = [
  { tag: '자료 조사', text: '최근 1년 사이 바뀐 국내 전기차 보조금 제도를 출처 링크와 함께 정리해 줘.' },
  { tag: '자료 조사', text: '개인 프로젝트용으로 PostgreSQL과 SQLite를 비교해서 표로 정리해 줘.' },
  { tag: '코딩', text: 'JavaScript에서 "TypeError: Cannot read properties of undefined" 오류의 흔한 원인과 확인 순서를 알려 줘.' },
  { tag: '코딩', text: 'Node.js로 CSV 파일을 읽어 열별 합계를 내는 짧은 예제 코드를 보여 줘.' },
];
// The usage tour: one spotlight per control, in the order a new user needs them. Plain words, no jargon.
const TOUR = [
  { title: '어서 와요!' },
  { sel: '#input', title: '말 걸어 보기', text: '여기에 채팅을 입력하면 연결된 AI들이 모두 답해 줘요. 줄을 바꾸려면 Shift+Enter를 눌러요. @를 치면 언급할 AI를 고를 수 있어요.' },
  { sel: '#members', side: true, title: 'AI 친구들', text: '왼쪽에 AI들이 있어요.  남은 한도와 연결상태를 확인 할 수 있어요.' },
  { sel: '#members .switch', side: true, title: '참여 스위치', text: '참여를 끄면 AI는 쉬어요. 사용량을 아끼고 싶을 때 써 보세요. 다시 켜면 돌아와요.' },
  { sel: '#modelPicker', title: '누가 답할지, 어떤 모델인지', text: '활성된 AI 모두가 답해요. AI들의 “모델”을 바꿀 수 있어요. 사용량에 따라 조절해보세요.' },
  { sel: '#targetSwitch', title: '한 명에게만 묻기', text: '특정 AI 한 명에게만 물어봐요. 입력창에 @클로드 처럼 언급도 OK !' },
  { sel: '#debateSwitch', title: '토론 모드', text: '중요한 결정을 할때, AI들이 각자 의견을 내고, 서로 검토한 뒤, 하나의 결론으로 정리해 줘요. 시간이 더 걸리고 한도소모가 클 수 있어요.' },
  { sel: '#chatterBtn', title: 'Talk on / off', text: '켜 두면 AI들이 알아서 서로 수다를 떨어요. 내가 말을 걸면 바로 멈추고 먼저 답해요. 앱이 꺼져 있을 땐 아무것도 하지 않아요.' },
  { sel: '#levelSeg', side: true, title: '얼마나 떠들까', text: ' AI끼리의 대화 빈도를 정해요. 높을수록 자주 떠들고 사용량도 늘어요.' },
  { sel: '#meEdit', side: true, title: '이름 바꾸기', text: 'AI들은 내 이름을 기억해요.' },
  { sel: '#webSearchField', side: true, title: '인터넷 검색', text: 'AI가 인터넷에서 찾아보고 답해요. 모든 AI가 지원하는 건 아니니, 켠 뒤 나오는 안내를 확인하세요.' },
  { sel: '#guideButtons', side: true, title: '설정은 언제든 다시', text: 'AI 연결과 모델 설정, 사용법은 여기서 언제든 다시 열 수 있어요.' },
];

let state;
let pending = false;
let image = null;
let menu = null; // compact model menu: { sub, q, adding, addId }
let setup = null; // first-start guide draft
let tour = null;
let renderedKey = '';
const runOpen = new Map(); // discussion runs the user opened or closed by hand
const input = $('#input');
const tl = $('#timeline');

// ---------- helpers ----------
function toast(text) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
async function api(route, body) {
  const res = await fetch(route, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`);
  return value;
}
async function update(body) {
  try { applyState(await api('/api/room', body)); return true; } catch (e) { toast(e.message); renderControls(); return false; }
}
const member = (id) => state.members.find((m) => m.id === id);
const nameOf = (id) => member(id)?.name || id;
const avatar = (id, cls = 'mini-av') => `<img class="${cls}" src="/avatars/${id}-pixel-128.png" alt="">`;
const settingText = (s) => `${s.model}${s.effort ? ` · ${s.effort}` : ''}`;
const kindText = (kind) => state.kinds[kind] || state.kinds.unknown;

// One plain status per AI (rules in status.mjs); the separate technical steps live under "자세히".
const STATUS_CLS = { setup: 'missing', rest: 'off', busy: 'busy', check: 'unknown', unavailable: 'fail', active: 'ok' };
function statusOf(id, model) {
  const check = state.room.checks[id];
  const s = memberStatus({ available: state.catalog[id].available, enabled: state.room.enabled[id],
    busy: state.room.active?.states[id]?.status === '생성 중', checking: state.room.checking.includes(id),
    loginStatus: check.login?.status, call: check.models[model], now: Date.now() });
  return { cls: STATUS_CLS[s.key], text: s.text };
}
const dot = (st) => `<span class="st ${st.cls}"><i></i>${esc(st.text)}</span>`;
function connBadges(id, model) {
  const cat = state.catalog[id];
  const check = state.room.checks[id];
  const login = !cat.available ? ['missing', '―'] : !check.login ? ['wait', '확인 전']
    : { ok: ['ok', '확인됨'], fail: ['fail', '필요'], unknown: ['unknown', '확인 불가'], missing: ['missing', '―'] }[check.login.status];
  const call = check.models[model];
  const callBadge = state.room.checking.includes(id) ? ['busy', '확인 중…'] : call?.status === 'ok' ? ['ok', '성공']
    : call?.status === 'fail' ? ['fail', `실패 · ${kindText(call.kind)}`] : ['wait', '확인 전'];
  return `<span class="cb ${cat.available ? 'ok' : 'missing'}">CLI ${cat.available ? '발견' : '없음'}</span>`
    + `<span class="cb ${login[0]}" title="${esc(check.login?.detail || '')}">로그인 ${login[1]}</span>`
    + `<span class="cb ${callBadge[0]}" title="${esc(call?.label || '')}">실제 호출 ${callBadge[1]}</span>`;
}

// ---------- messages ----------
// Independent opinions and reviews can be long: from the first paragraph break after ~450 characters
// the rest is folded behind a button. Which ones are open survives re-rendering.
const FOLD_PHASES = new Set(['opinion', 'review']);
const foldOpen = new Set();
function bodyHTML(m) {
  const { head, tail } = FOLD_PHASES.has(m.phase) ? splitFold(m.text || '') : { head: m.text || '', tail: '' };
  if (!tail) return renderMarkdown(head);
  const open = foldOpen.has(m.id);
  return `${renderMarkdown(head)}<div class="fold-tail" ${open ? '' : 'hidden'}>${renderMarkdown(tail)}</div>`
    + `<button type="button" class="fold-btn" data-fold="${m.id}" data-more="약 ${tail.length}자" aria-expanded="${open}">${open ? '▴ 접기' : `▾ 이어서 보기 · 약 ${tail.length}자`}</button>`;
}
function messageNode(m) {
  const node = document.createElement('div');
  node.dataset.id = m.id;
  if (m.from === 'system') {
    node.className = `sys ${m.kind === 'error' ? 'k-error' : ''} ${m.kind === 'cancelled' ? 'k-cancel' : ''} ${m.kind === 'presence' ? 'k-presence' : ''} ${m.kind === 'welcome' ? 'k-welcome' : ''}`;
    const badge = m.kind === 'error' ? `<span class="err-kind k-${esc(m.errorKind || 'unknown')}">${esc(kindText(m.errorKind))}</span> ` : '';
    const who = m.by && m.kind !== 'presence' ? `<b>${esc(nameOf(m.by))}${m.phase && m.phase !== 'answer' ? ` · ${esc(PHASES[m.phase] || m.phase)}` : ''}: </b>` : '';
    node.innerHTML = `${badge}${who}${esc(m.text)}${m.detail ? `<details class="error-details"><summary>자세히</summary>${esc(m.detail)}</details>` : ''}`;
    return node;
  }
  const mine = m.from === 'user';
  const who = member(m.from);
  node.className = `msg ${mine ? 'mine' : ''} ${m.phase === 'final' ? 'final' : ''}`;
  const face = who ? `<img class="m-av clickable" data-profile="${who.id}" role="button" tabindex="0" src="/avatars/${who.id}-pixel-128.png" alt="${esc(who.name)} 프로필 보기">` : '<div class="m-av"></div>';
  const attachment = m.attach?.path ? `<img class="att-img" src="/ws/${m.attach.path.split('/').map(encodeURIComponent).join('/')}" alt="${esc(m.attach.label || '첨부 사진')}">${m.attach.generated ? `<small>${esc(m.attach.label)}</small>` : ''}` : '';
  const game = m.game?.path ? `<button type="button" class="model-pill" data-game>${esc(m.game.title)} · 게임 열기</button>` : '';
  const links = mine ? [] : extractLinks(m.text || '');
  const sources = links.length ? `<details class="sources"><summary>출처 링크 ${links.length}개 <span>· 링크 형식만 확인했고 내용은 검증하지 않았습니다</span></summary><ol>${links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label || l.host)}</a> <span class="host">${esc(l.host)}</span></li>`).join('')}</ol></details>` : '';
  const phase = m.phase === 'final' ? '<span class="phase final-tag">최종 답변</span>'
    : m.phase && m.phase !== 'answer' ? `<span class="phase">${esc(PHASES[m.phase] || m.phase)}</span>` : '';
  node.innerHTML = `${face}<div class="m-body">
    <div class="m-head"><span class="n">${esc(who?.name || m.from)}</span><span class="model">${esc(m.model || '')}${m.effort ? ` · ${esc(m.effort)}` : ''}</span>${phase}</div>
    <div class="line"><div class="bubble"><div class="text">${bodyHTML(m)}</div>${attachment}${game}${sources}</div></div></div>`;
  if (who) node.style.setProperty('--c', who.color);
  node.querySelector('[data-game]')?.addEventListener('click', () => {
    setWorkspaceOpen(true);
    openFile(m.game.path);
  });
  return node;
}
const isDiscussion = (m) => m.mode === 'discussion' || /^(opinion|review|final)$/.test(m.phase || '');
function runFooter(end) {
  const div = document.createElement('div');
  div.className = `run-foot ${end.kind}`;
  const s = end.summary;
  if (!s) { div.textContent = end.text; return div; }
  const chips = [
    ...s.failed.map((f) => `<span class="miss fail">${esc(nameOf(f.id))} 실패 · ${esc(kindText(f.kind))}</span>`),
    ...s.excluded.map((e) => `<span class="miss">${esc(nameOf(e.id))} 빠짐 · ${esc(e.reason)}</span>`),
  ];
  div.innerHTML = `<span>${s.ok ? '완료' : '최종 답변을 완료하지 못했습니다'}</span>${chips.join('')}`;
  return div;
}
// One discussion = header, collapsible process, highlighted final answer, footer.
function runNode({ runId, msgs }) {
  const node = document.createElement('section');
  node.className = 'run';
  const running = state.room.active?.id === runId;
  const final = msgs.find((m) => m.phase === 'final');
  const end = msgs.find((m) => m.kind === 'complete' || m.kind === 'cancelled');
  const steps = msgs.filter((m) => m !== final && m !== end);
  const people = [...new Map(msgs.filter((m) => member(m.from)).map((m) => [m.from, m])).values()];
  const synth = end?.summary?.synthesizer || final?.from || (running ? state.room.active.synthesizer : null);
  const count = (phase) => steps.filter((m) => m.phase === phase && m.from !== 'system').length;
  const errors = steps.filter((m) => m.kind === 'error').length;
  const head = document.createElement('div');
  head.className = 'run-head';
  head.innerHTML = `<span class="run-tag">토론</span>${people.map((m) => `<span class="run-who" style="--c:${member(m.from).color}">${avatar(m.from)}${esc(nameOf(m.from))} <small>${esc(m.model || '')}</small>${m.from === synth ? ' <b>종합</b>' : ''}</span>`).join('')}${running ? '<span class="run-live">진행 중</span>' : end?.kind === 'cancelled' ? '<span class="run-stop">중지됨</span>' : ''}`;
  const details = document.createElement('details');
  details.className = 'run-process';
  const byDefault = running || !final;
  details.open = runOpen.has(runId) ? runOpen.get(runId) : byDefault;
  details.innerHTML = `<summary>토론 과정 · 의견 ${count('opinion')} · 검토 ${count('review')}${errors ? ` · 오류 ${errors}` : ''}</summary>`;
  details.append(...steps.map(messageNode));
  details.addEventListener('toggle', () => {
    if (details.open === byDefault) runOpen.delete(runId); else runOpen.set(runId, details.open);
  });
  node.append(head, details);
  if (final) node.append(messageNode(final));
  if (end) node.append(runFooter(end));
  return node;
}
function renderMessages() {
  const runs = new Set(state.messages.filter((m) => m.runId && isDiscussion(m)).map((m) => m.runId));
  const groups = new Map();
  const items = [];
  for (const m of state.messages) {
    if (m.runId && runs.has(m.runId)) {
      if (!groups.has(m.runId)) { const g = { runId: m.runId, msgs: [] }; groups.set(m.runId, g); items.push(g); }
      groups.get(m.runId).msgs.push(m);
    } else items.push(m);
  }
  $('#msgs').replaceChildren(...items.map((x) => (x.msgs ? runNode(x) : messageNode(x))));
  $('#empty').hidden = state.messages.some((m) => m.from !== 'system');
  renderedKey = `${state.messages.length}:${state.messages.at(-1)?.id}:${state.room.active?.id || ''}`;
}
const distance = () => tl.scrollHeight - tl.scrollTop - tl.clientHeight;
function showJump(text) { $('#jump').textContent = text; $('#jump').hidden = false; }
function refreshMessages(grew) {
  const stick = distance() < 100;
  renderMessages();
  if (stick) tl.scrollTop = tl.scrollHeight;
  else if (grew) showJump('새 메시지 ↓');
}
function applyState(next) {
  const before = state?.messages.length || 0;
  state = next;
  const key = `${state.messages.length}:${state.messages.at(-1)?.id}:${state.room.active?.id || ''}`;
  if (key !== renderedKey) refreshMessages(state.messages.length > before);
  renderControls();
  renderFiles();
  if (profileId) renderProfile();
  if (menu && !$('#modelPop').contains(document.activeElement?.closest('input'))) renderMenu();
  // Redraw the guide only when what it shows changed, so a click never lands on a replaced button.
  const checks = JSON.stringify([state.room.checks, state.room.checking, state.catalog]);
  if (setup && checks !== setup.seen && !$('#setup').contains(document.activeElement?.closest('input'))) renderSetup();
}

// ---------- controls ----------
function stateClass(s) {
  return { '생성 중': 'busy', 완료: 'ok', 실패: 'fail', 제외: 'off' }[s.status] || 'wait';
}
function renderProgress() {
  const a = state.room.active;
  const box = $('#typing');
  box.classList.toggle('on', !!a);
  if (!a) { box.replaceChildren(); return; }
  const entries = Object.entries(a.states);
  const chips = entries.map(([id, s]) => `<span class="pg-ai ${stateClass(s)}" style="--c:${member(id).color}">${avatar(id)}<b>${esc(nameOf(id))}</b> ${esc(s.status)}${s.kind ? ` · ${esc(kindText(s.kind))}` : ''}${s.reason ? ` · ${esc(s.reason)}` : ''}${a.synthesizer === id ? ' <em>종합</em>' : ''}</span>`).join('');
  if (a.mode === 'discussion') {
    const joined = entries.filter(([, s]) => s.status !== '제외').length;
    const reached = Math.max(0, ...entries.filter(([, s]) => !['대기', '제외'].includes(s.status)).map(([, s]) => STEPS.indexOf(s.phase)));
    const steps = STEPS.map((p, i) => `<li class="${i < reached ? 'done' : i === reached ? 'now' : ''}">${PHASES[p]}</li>`).join('');
    box.innerHTML = `<ol class="pg-steps">${steps}</ol><div class="pg-ais">${chips}</div>`;
  } else {
    box.innerHTML = `<div class="pg-ais">${chips}</div>`;
  }
}
function renderRoomSub() {
  const room = state.room;
  $('#roomSub').textContent = room.active || pending ? '답변 중'
    : room.auto.on ? (room.autoSleeping ? '잠든 중 · 말 걸면 깨어나요' : room.autoRest ? '오늘의 자동 대화는 쉬고 있어요' : room.autoRunning ? '켜져 있음 · 대화 중' : '켜져 있음') : '꺼져 있음';
}
// Models in use: the discussion group has its own, everything else uses the normal chat models.
const bag = () => (state.room.discussion ? state.room.debateModels : state.room.models);
const bagKey = () => (state.room.discussion ? 'debateModels' : 'models');
// "Several AIs answer" = discussion, or the default all-AI chat.
const multi = () => state.room.discussion || !state.room.targeted;
// Remaining limit of one AI: the tightest of its windows, from the CLI's own usage report.
const WINDOW_LABEL = { '5h': '5시간', week: '주간' };
const isStale = (u) => !u.ok || u.restored || Date.now() - u.at > 30 * 60000;
// A phone-battery gauge: the fill is what is left of that window.
function batteryHTML(w, stale, big = false) {
  const pct = Math.round(w.remainingPct);
  return `<span class="batt ${batteryLevel(pct)} ${stale ? 'stale' : ''} ${big ? 'big' : ''}" title="${esc(`${WINDOW_LABEL[w.id]} 남은 한도 ${pct}%${stale ? ' (이전 값)' : ''}`)}"><span class="batt-label">${WINDOW_LABEL[w.id]}</span><span class="batt-body"><i style="width:${pct}%"></i><b>${pct}%</b></span><span class="batt-nub"></span></span>`;
}
function limitHTML(id) {
  const u = state.usage?.[id];
  const ws = limitWindows(id, u);
  return ws.length ? `<div class="m-limit">${ws.map((w) => batteryHTML(w, isStale(u))).join('')}</div>` : '';
}
function resetText(ms) {
  if (!ms) return '';
  const diff = ms - Date.now();
  if (diff <= 0) return '곧 초기화돼요';
  const days = Math.floor(diff / 86400000); const hours = Math.floor((diff % 86400000) / 3600000); const mins = Math.floor((diff % 3600000) / 60000);
  return `${days ? `${days}일 ` : ''}${hours ? `${hours}시간 ` : ''}${days ? '' : `${mins}분 `}뒤 초기화`;
}
// ---------- profile drawer: tap an AI's picture to see who it is (name, one-line intro, limits) ----------
let profileId = null;
function renderProfile() {
  const id = profileId;
  const m = member(id);
  const model = bag()[id];
  const st = statusOf(id, model.model);
  const u = state.usage?.[id];
  const ws = limitWindows(id, u);
  const bio = state.room.bios[id];
  const proGpt = id === 'gpt' && /^pro/i.test(u?.plan || '');
  $('#sheetBody').innerHTML = `<div class="profile" style="--c:${m.color}">
    <img class="p-av" src="/avatars/${id}-pixel-128.png" alt="">
    <div class="p-name" id="sheetName">${esc(m.name)} <small>${esc(m.maker)}</small></div>
    <div class="p-status">${dot(st)}<code>${esc(settingText(model))}</code></div>
    <div class="p-bio ${bio ? '' : 'empty'}">${bio ? `“${esc(bio)}”` : '아직 한 줄 소개가 없어'}</div>
    <div class="p-limits"><div class="p-sec">남은 한도</div>
      ${ws.length ? ws.map((w) => `<div class="p-lrow">${batteryHTML(w, isStale(u), true)}<small>${esc(resetText(w.resetsAt))}</small></div>`).join('') : '<small>한도 정보를 아직 가져오지 못했어요</small>'}
      ${proGpt ? '<small class="p-plan">Pro 요금제는 5시간 한도가 없어서 주간 한도만 보여요</small>' : ''}
      ${u && ws.length && isStale(u) ? '<small class="p-plan">새로 확인하지 못해 이전 값이에요</small>' : ''}</div></div>`;
}
function openProfile(id) {
  if (!member(id)) return;
  profileId = id;
  renderProfile();
  $('#aiSheet').hidden = false;
  requestAnimationFrame(() => $('#aiSheet').classList.add('open'));
  $('#sheetClose').focus({ preventScroll: true });
}
function closeProfile() {
  profileId = null;
  $('#aiSheet').classList.remove('open');
  setTimeout(() => { if (!profileId) $('#aiSheet').hidden = true; }, 200);
}
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-profile]');
  if (target) { e.stopPropagation(); openProfile(target.dataset.profile); }
  else if (e.target === $('#aiSheet') || e.target.closest('#sheetClose')) closeProfile();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches?.('[data-profile]')) { e.preventDefault(); openProfile(e.target.dataset.profile); }
});
function renderControls() {
  const room = state.room;
  const busy = !!room.active || pending;
  $('#members').replaceChildren(...state.members.map((m) => {
    const li = document.createElement('li');
    li.className = `member ${m.id === room.selected && room.targeted && !room.discussion ? 'selected' : ''} ${m.available ? '' : 'st-missing'}`;
    li.style.setProperty('--c', m.color);
    const settings = bag()[m.id];
    const live = room.active?.states[m.id];
    li.innerHTML = `<div class="av-wrap" data-profile="${m.id}" role="button" tabindex="0" aria-label="${esc(m.name)} 프로필 보기"><img class="av" src="/avatars/${m.id}-pixel-128.png" alt=""><span class="st-dot"></span></div>
      <div class="m-info"><div class="m-name"><span class="n">${esc(m.name)}</span><span class="m-maker">${esc(m.maker)}</span></div>
      <div class="m-status">${live && live.status !== '대기' ? esc({ '생성 중': '답변 중' }[live.status] || live.status) : dot(statusOf(m.id, settings.model))}</div>
      <div class="member-model">${room.discussion ? '토론 · ' : ''}${esc(settingText(settings))}</div>${limitHTML(m.id)}</div>
      <label class="switch" title="대화 참여"><input type="checkbox" aria-label="${esc(m.name)} 대화 참여" ${room.enabled[m.id] ? 'checked' : ''}><span></span></label>`;
    // Clicking an AI picks it for "특정 AI에게만" and turns that on.
    li.addEventListener('click', (e) => { if (!e.target.closest('.switch')) update({ selected: m.id, targeted: true }); });
    li.querySelector('input').addEventListener('change', (e) => update({ enabled: { [m.id]: e.target.checked } }));
    return li;
  }));
  // Everyone in the room: me plus each AI that is on and connected.
  const here = 1 + IDS.filter((id) => room.enabled[id] && state.catalog[id].available).length;
  $('#memberCount').textContent = String(here);
  $('#headCount').textContent = String(here);
  $('#headCount').setAttribute('aria-label', `참여자 ${here}명`);
  $('#meName').textContent = room.userName || '방장';
  $('#meAv').textContent = [...(room.userName || '방장')][0];
  document.title = room.name || 'AI 단톡방';
  $('#webSearch').checked = room.webSearch;
  $('#webHint').hidden = !room.webSearch; // the note about search support only matters once it is on
  $('#headSub').textContent = room.discussion ? `토론 모드 · 종합 ${nameOf(room.synthesizer)}`
    : room.targeted ? `${nameOf(room.selected)} · ${room.models[room.selected].model} · 이 AI에게만` : '켜져 있는 AI 모두에게 보내요 · @로 한 명만 부를 수 있어요';
  renderRoomSub();
  $('#headTitle').textContent = room.name || 'AI 단톡방';
  $('#roomName').textContent = room.name || 'AI 단톡방';
  const sel = room.selected;
  const pill = $('#modelPicker');
  if (room.discussion) {
    const joined = IDS.filter((id) => room.enabled[id] && state.catalog[id].available);
    pill.style.setProperty('--c', 'var(--accent)');
    pill.innerHTML = `<span class="pk-stack">${joined.map((id) => avatar(id)).join('')}</span><span class="pk-name">토론</span><span class="pk-model">${joined.length}명 · 종합 ${esc(nameOf(room.synthesizer))}</span><span class="caret">⌄</span>`;
  } else if (!room.targeted) {
    const joined = IDS.filter((id) => room.enabled[id] && state.catalog[id].available);
    pill.style.setProperty('--c', 'var(--accent)');
    pill.innerHTML = `<span class="pk-stack">${joined.map((id) => avatar(id)).join('')}</span><span class="pk-name">전체</span><span class="pk-model">${joined.length}명이 답해요</span><span class="caret">⌄</span>`;
  } else {
    const s = room.models[sel];
    const st = statusOf(sel, s.model);
    pill.style.setProperty('--c', member(sel).color);
    pill.innerHTML = `${avatar(sel)}<span class="pk-model">${esc(modelEntry(sel, s.model)?.label || s.model)}</span>${s.effort ? `<span class="pk-effort">${esc(s.effort)}</span>` : ''}<i class="pk-dot ${st.cls}" title="${esc(st.text)}"></i><span class="caret">⌄</span>`;
  }
  $('#debateToggle').checked = room.discussion;
  $('#debateSwitch').classList.toggle('on', room.discussion);
  $('#targetToggle').checked = room.targeted && !room.discussion;
  $('#targetToggle').disabled = room.discussion;
  $('#targetSwitch').classList.toggle('on', room.targeted && !room.discussion);
  $('#targetSwitch').classList.toggle('disabled', room.discussion);
  $('#send').disabled = busy;
  $('#stop').hidden = !room.active && !room.autoRunning;
  const chatter = $('#chatterBtn');
  chatter.classList.toggle('on', room.auto.on);
  chatter.setAttribute('aria-pressed', String(room.auto.on));
  $('#chatterText').textContent = room.auto.on ? 'Talk on' : 'Talk off';
  $('#app').classList.toggle('running', room.auto.on);
  $('#powerBtn').setAttribute('aria-pressed', String(room.auto.on));
  $('#powerText').textContent = room.auto.on ? '켜져 있음 · 끄기' : '꺼져 있음 · 켜기';
  renderProgress();
  renderAuto();
  renderDetails();
}
// Auto chat settings: one simple level (낮음/중간/높음) plus, under "고급", an optional model per AI.
const LEVEL_HINTS = { low: '조용하고 느긋하게 · 사용량이 가장 적어요', medium: '적당히 자주 · 사용량은 보통이에요', high: '활발하게 자주 · 사용량이 가장 많아요' };
function renderAuto() {
  const a = state.room.auto;
  $('#autoSleep').value = String(a.sleepMinutes);
  $('#levelSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.level === a.level));
  $('#levelHint').textContent = LEVEL_HINTS[a.level];
  // Only a problem is worth a line here; the rest is explained by the tour and under "자세히".
  const note = !a.on ? '' : state.room.autoSleeping ? '잠든 중이에요. 말 걸면 다시 깨어나요.' : state.room.autoRest ? '오늘의 자동 대화는 쉬고 있어요.' : !state.room.autoReady ? '대화할 수 있는 AI가 없어 짧은 대사만 나와요.' : '';
  $('#autoNote').textContent = note;
  $('#autoNote').hidden = !note;
}
// Technical facts (connection steps, raw errors, real call counts) are shown only here.
let memoBoxOpen = false;
const memoOpen = new Set();
function renderDetails() {
  const box = $('#detailsBox');
  if (!box.open) return;
  const a = state.room.auto;
  const u = a.usage;
  const ai = IDS.map((id) => {
    const model = (state.room.discussion ? state.room.debateModels : state.room.models)[id].model;
    const check = state.room.checks[id];
    const call = check.models[model];
    const raw = [check.login?.detail, call?.detail].filter(Boolean).join('\n');
    const lim = state.usage?.[id];
    const when = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
    const limits = lim?.windows?.length ? lim.windows.map((w) => `<div>남은 한도 · ${esc(w.label)} ${Math.round(w.remainingPct)}%${w.resetsAt ? ` (${esc(when(w.resetsAt))}에 초기화)` : ''}</div>`).join('')
      + `<small>${esc(lim.plan || '')} 확인 ${esc(when(lim.at))}${lim.ok ? '' : ' · 새로 확인하지 못해 이전 값이에요'}</small>${lim.error ? `<pre>${esc(lim.error)}</pre>` : ''}`
      : lim?.error ? `<div>한도를 확인하지 못했어요</div><pre>${esc(lim.error)}</pre>` : '';
    const use = state.room.autoUses[id];
    return `<div class="d-ai"><b>${esc(nameOf(id))}</b> <small>${esc(model)}</small><small>자동 대화 모델 ${esc(settingText(use))}</small><div class="conn-line">${connBadges(id, model)}</div>${limits}${raw ? `<pre>${esc(raw)}</pre>` : ''}</div>`;
  }).join('') + (state.usage ? '<button type="button" class="model-pill" id="usageRefresh">남은 한도 새로 확인</button>' : '');
  $('#detailsBody').innerHTML = `${ai}<div class="d-ai"><b>오늘 사용 기록</b>
    <div>자동 대화 실제 AI 호출 ${u.calls} / ${state.room.autoDaily}번</div><div>내 질문에 쓴 AI 호출 ${u.asked}번</div>
    <div>자동 창작 ${u.creations || 0} / 2개 · 새 사진 생성 ${u.photos || 0} / 1회 · 공동 게임 ${u.games || 0} / 1개</div>
    <small>사진 생성과 공동 게임 제작도 자동 호출 예산에 포함돼요. 게임 제작은 최대 3차례, 플레이에는 AI 호출이 없어요.</small>
    ${u.stopped ? `<div>자동 호출 중단: ${esc(kindText(u.stopped))}</div>` : ''}${a.lastError ? `<pre>${esc(nameOf(a.lastError.id))} · ${esc(a.lastError.detail)}</pre>` : ''}
    <small>횟수는 이 앱이 센 값이며, 구독 한도의 실제 소비량과는 다를 수 있어요.</small></div>`;
  // Each AI writes its own short memo (speech style, how it calls people). Here it can be read or cleared.
  // The whole section is folded by default; a long memo shows two lines until it is opened.
  // Which parts are open survives re-rendering.
  const filled = IDS.filter((id) => state.room.memos[id]).length;
  const memoRows = IDS.map((id) => {
    const memo = state.room.memos[id];
    const long = memo.length > 60;
    const open = memoOpen.has(id);
    return `<div class="memo-row"><span class="who">${esc(nameOf(id))}</span>
      <span class="memo-actions">${long ? `<button type="button" class="link-btn" data-memo-toggle="${id}">${open ? '접기' : '펼치기'}</button>` : ''}${memo ? `<button type="button" class="link-btn" data-memo-clear="${id}">지우기</button>` : ''}</span>
      <em class="${long && !open ? 'clamp' : ''}">${esc(memo || '아직 없음')}</em></div>`;
  }).join('');
  $('#detailsBody').insertAdjacentHTML('beforeend', `<details class="d-ai memo-box" id="memoBox" ${memoBoxOpen ? 'open' : ''}>
    <summary><b>AI 개인 메모</b> <small>${filled ? `${filled}명이 적어 둠` : '아직 없음'}</small></summary>
    <label class="memo-on"><input type="checkbox" id="memoOn" ${state.room.memoOn ? 'checked' : ''}> 메모 쓰기 (끄면 기억하지 않아요)</label>
    ${memoRows}
    <small>AI가 대화하면서 말투, 호칭, 다른 멤버와의 관계를 스스로 적어 두는 짧은 메모예요. 이 PC에만 저장돼요.</small></details>`);
  $('#memoBox').addEventListener('toggle', (e) => { memoBoxOpen = e.target.open; });
  $('#memoOn').onchange = (e) => update({ memoOn: e.target.checked });
  $('#detailsBody').querySelectorAll('[data-memo-clear]').forEach((b) => b.addEventListener('click', () => update({ memos: { [b.dataset.memoClear]: '' } })));
  $('#detailsBody').querySelectorAll('[data-memo-toggle]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.memoToggle;
    if (memoOpen.has(id)) memoOpen.delete(id); else memoOpen.add(id);
    renderDetails();
  }));
  $('#usageRefresh')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = '확인 중…';
    try { await api('/api/usage/refresh', {}); } catch (err) { toast(err.message); }
  });
}
function renderFiles() {
  if ($('#wsFiles').dataset.openPath) return;
  $('#wsFiles').replaceChildren();
  if (!state.files.length) { $('#wsFiles').textContent = '첨부한 사진과 기존 작업공간 파일이 여기에 표시됩니다.'; return; }
  for (const f of state.files) {
    const b = document.createElement('button');
    b.className = 'file-entry';
    b.textContent = f.path;
    b.addEventListener('click', () => openFile(f.path));
    $('#wsFiles').append(b);
  }
}
function setWorkspaceOpen(open) {
  $('#app').classList.toggle('ws-closed', !open);
  $('#app').classList.toggle('ws-open', open);
}
async function openFile(path) {
  try {
    const data = await api(`/api/file?path=${encodeURIComponent(path)}`);
    $('#wsFiles').dataset.openPath = path;
    const back = document.createElement('button');
    back.className = 'model-pill'; back.textContent = '← 파일 목록';
    back.onclick = () => { delete $('#wsFiles').dataset.openPath; renderFiles(); };
    const picture = data.image || data.activity === 'postcard';
    const content = document.createElement(data.activity === 'game' ? 'iframe' : picture ? 'img' : 'pre');
    if (data.activity === 'game') {
      content.setAttribute('sandbox', 'allow-scripts');
      content.title = '미니게임';
      content.style.cssText = 'width:100%;height:390px;border:0';
      content.src = `/ws/${path.split('/').map(encodeURIComponent).join('/')}`;
    } else if (picture) {
      content.src = `/ws/${path.split('/').map(encodeURIComponent).join('/')}`;
      content.style.maxWidth = '100%'; content.alt = path;
    } else content.textContent = data.text;
    $('#wsFiles').replaceChildren(back, content);
  } catch (e) { toast(e.message); }
}

// ---------- model chooser (shared by the model menu and the first-start guide) ----------
function fallbackEfforts(id) {
  return id === 'claude' ? state.catalog.claude.models[0].efforts : id === 'gpt' ? ['low', 'medium', 'high'] : [];
}
function chooserHTML(d) {
  const cat = state.catalog[d.id];
  const rec = d.target === 'general' ? state.room.recommended?.[d.id]?.model : null;
  const rank = (m) => (m.check?.status === 'ok' ? 0 : m.id === rec ? 1 : m.id === d.saved ? 2 : ['config', 'custom'].includes(m.source) ? 4 : 3);
  const list = [...cat.models].sort((a, b) => rank(a) - rank(b));
  const shown = d.more ? list : list.slice(0, 4);
  const current = list.find((m) => m.id === d.model);
  if (current && !shown.includes(current)) shown.push(current);
  const items = shown.map((m) => {
    const source = m.source === 'cli' ? SOURCES.cli[d.id] : SOURCES[m.source];
    const check = m.check?.status === 'ok' ? '<span class="tag ok">사용 확인됨</span>'
      : m.check?.status === 'fail' ? `<span class="tag fail">최근 실패 · ${esc(kindText(m.check.kind))}</span>` : '<span class="tag">아직 안 써 봤어요</span>';
    return `<button type="button" class="model-opt ${m.id === d.model && !d.custom ? 'on' : ''}" data-model="${esc(m.id)}">
      <span class="mo-top"><b>${esc(m.label)}</b>${m.label !== m.id ? `<code>${esc(m.id)}</code>` : ''}${m.id === rec ? '<span class="tag rec">추천 · 사용량 가장 적음</span>' : ''}</span>
      ${m.description ? `<span class="mo-desc">${esc(m.description)}</span>` : ''}
      <span class="mo-meta"><span class="tag src">${esc(source)}</span>${check}</span></button>`;
  }).join('');
  const note = d.id === 'gpt' && !cat.listedAt
    ? `ChatGPT 모델 목록을 아직 못 불러왔어요. <button type="button" class="link-btn" data-act="refresh">목록 불러오기 (사용량 안 써요)</button>`
    : esc(LIST_NOTE[d.id]);
  const entry = cat.models.find((m) => m.id === d.model);
  const efforts = d.custom ? fallbackEfforts(d.id) : entry?.efforts || [];
  const basis = '생각을 얼마나 깊게 할지예요. 낮을수록 빠르고 사용량이 적어요';
  const effortHTML = efforts.length
    ? `<div class="field-title">생각 수준 <small>${basis}</small></div><div class="seg effort">${['', ...efforts].map((v) => `<button type="button" data-effort="${v}" class="${d.effort === v ? 'on' : ''}">${v || (d.id === 'gpt' ? '기본(low)' : 'CLI 기본값')}</button>`).join('')}</div>`
    : d.effort ? `<p class="hint">생각 수준 ${esc(d.effort)} — 이 모델에서 지원 여부를 아직 확인하지 못했습니다.</p>` : '';
  return `<p class="hint list-note">${note}</p><div class="model-list">${items}</div>
    ${list.length > shown.length ? `<button type="button" class="link-btn" data-act="more">모델 더 보기 (${list.length - shown.length}개)</button>` : ''}
    ${effortHTML}
    <details class="advanced" ${d.custom ? 'open' : ''}><summary>고급 설정 · 모델 ID 직접 입력</summary>
      <input data-act="custom" value="${esc(d.custom ? d.model : '')}" placeholder="예: ${esc(cat.models[0]?.id || '')}" maxlength="120" spellcheck="false" aria-label="모델 ID 직접 입력">
      <p class="hint">CLI에서 확인한 모델 ID를 입력하면 목록 선택보다 우선합니다. 사용 가능 여부는 호출 테스트로 확인하세요.</p></details>`;
}
function bindChooser(root, d, rerender) {
  root.querySelectorAll('[data-model]').forEach((b) => b.addEventListener('click', () => {
    const entry = state.catalog[d.id].models.find((m) => m.id === b.dataset.model);
    d.model = entry.id; d.custom = false;
    if (d.effort && !entry.efforts.includes(d.effort)) d.effort = entry.efforts.includes(entry.defaultEffort) ? entry.defaultEffort : '';
    rerender();
  }));
  root.querySelectorAll('[data-effort]').forEach((b) => b.addEventListener('click', () => { d.effort = b.dataset.effort; rerender(); }));
  root.querySelector('[data-act="more"]')?.addEventListener('click', () => { d.more = true; rerender(); });
  root.querySelector('[data-act="refresh"]')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = '불러오는 중…';
    try { applyState(await api('/api/models/refresh', { id: d.id })); } catch (err) { toast(err.message); }
    if (!state.catalog[d.id].listedAt) toast('Codex 모델 목록을 불러오지 못했습니다. 설정 기반 목록을 사용합니다.');
    rerender();
  });
  const custom = root.querySelector('[data-act="custom"]');
  custom.addEventListener('input', () => {
    const v = custom.value.trim();
    d.custom = !!v;
    d.model = v || d.saved;
  });
  custom.addEventListener('change', () => {
    if (d.custom && d.effort && !fallbackEfforts(d.id).includes(d.effort)) d.effort = '';
    rerender();
  });
}
async function testCall(id, target, model, effort) {
  try { applyState(await api('/api/check/call', { id, target, model, effort })); } catch (e) { toast(e.message); }
  const result = state.room.checks[id]?.models[model];
  if (result?.status === 'fail') toast(`${nameOf(id)} · ${model}: ${result.label}`);
  if (result?.status === 'ok') toast(`${nameOf(id)} · ${model} 호출 성공`);
  if (menu) renderMenu();
  if (setup) renderSetup();
}

// ---------- compact model menu: short main rows + one sub panel (search, grouped by AI) ----------
const modelEntry = (id, model) => state.catalog[id].models.find((m) => m.id === model);
const effortLabel = (id, v) => v || (id === 'gpt' ? '기본(low)' : 'CLI 기본값');
// Keep the effort when the new model supports it, else the model's own default.
function effortFor(id, model, effort) {
  const entry = modelEntry(id, model);
  const efforts = entry?.efforts || [];
  if (!effort || efforts.includes(effort)) return efforts.length ? effort : '';
  return efforts.includes(entry?.defaultEffort) ? entry.defaultEffort : '';
}
function openMenu() {
  menu = { sub: null, q: '', adding: false, addId: state.room.selected };
  renderMenu();
  $('#modelPop').hidden = false;
  $('#modelPicker').setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  menu = null;
  $('#modelPop').hidden = true;
  $('#modelPicker').setAttribute('aria-expanded', 'false');
}
async function pick(body) {
  if (await update(body) && menu) { menu.sub = null; renderMenu(); }
}
const menuRow = (key, label, value, face = '') => `<button type="button" class="mm-row ${menu.sub === key ? 'on' : ''}" data-sub="${key}"><span class="mm-label">${label}</span><span class="mm-val">${face}<span class="mm-text">${value}</span></span><span class="chev">›</span></button>`;
const shortSetting = (id, s) => `${modelEntry(id, s.model)?.label || s.model}${s.effort ? ` · ${s.effort}` : ''}`;
function renderMenu() {
  const room = state.room;
  const main = $('#menuMain');
  if (multi()) {
    main.innerHTML = `<div class="mm-title">${room.discussion ? '토론 참여' : '답하는 AI'}</div>
      ${IDS.map((id) => `<div class="mm-ai ${room.enabled[id] ? '' : 'off'}" style="--c:${member(id).color}">
        <label class="switch"><input type="checkbox" data-join="${id}" ${room.enabled[id] ? 'checked' : ''} aria-label="${esc(nameOf(id))} 대화 참여"><span></span></label>
        ${menuRow(`ai:${id}`, `${avatar(id)}<b>${esc(nameOf(id))}</b>`, esc(state.catalog[id].available ? shortSetting(id, bag()[id]) : '연결 설정 필요'))}</div>`).join('')}
      ${room.discussion ? menuRow('synth', '종합 담당', esc(nameOf(room.synthesizer)), avatar(room.synthesizer)) : ''}`;
  } else {
    const id = room.selected;
    const s = room.models[id];
    const testing = room.checking.includes(id);
    main.innerHTML = `<div class="mm-title">${esc(nameOf(id))}에게만 보내요</div>
      ${menuRow('models', '모델', esc(modelEntry(id, s.model)?.label || s.model), avatar(id))}
      ${modelEntry(id, s.model)?.efforts.length ? menuRow('effort', '생각 수준', esc(effortLabel(id, s.effort))) : ''}
      <div class="mm-status">${dot(statusOf(id, s.model))}<button type="button" class="link-btn" data-act="test" ${!state.catalog[id].available || testing ? 'disabled' : ''} title="짧은 질문 1회를 보내 확인합니다. 구독 사용량이 조금 소비됩니다.">${testing ? '확인 중…' : '호출 테스트'}</button></div>`;
  }
  main.insertAdjacentHTML('beforeend', '<div class="mm-foot"><button type="button" class="link-btn" data-act="setup">연결 확인 · 처음 설정</button></div>');
  main.querySelectorAll('[data-sub]').forEach((b) => b.addEventListener('click', () => {
    menu.sub = menu.sub === b.dataset.sub ? null : b.dataset.sub;
    menu.q = ''; menu.adding = false;
    renderMenu();
  }));
  main.querySelectorAll('[data-join]').forEach((el) => el.addEventListener('change', () => update({ enabled: { [el.dataset.join]: el.checked } })));
  main.querySelector('[data-act="test"]')?.addEventListener('click', (e) => {
    e.target.disabled = true; e.target.textContent = '확인 중…';
    const s = room.models[room.selected];
    testCall(room.selected, 'general', s.model, s.effort);
  });
  main.querySelector('[data-act="setup"]').addEventListener('click', () => { closeMenu(); openSetup(); });
  renderSub();
}
function renderSub() {
  const sub = $('#menuSub');
  $('#modelPop').classList.toggle('has-sub', !!menu.sub);
  sub.hidden = !menu.sub;
  if (!menu.sub) return;
  const room = state.room;
  const back = '<button type="button" class="ms-back" data-act="back" aria-label="뒤로">‹</button>';
  if (menu.sub === 'effort') {
    const id = room.selected;
    const s = room.models[id];
    sub.innerHTML = `<div class="ms-head">${back}<b>생각 수준</b><small>${id === 'gpt' ? 'Codex 목록 기준' : 'Claude CLI 도움말 기준'}</small></div>
      ${['', ...modelEntry(id, s.model).efforts].map((v) => `<button type="button" class="ms-row ${s.effort === v ? 'cur' : ''}" data-effort="${v}"><span class="ms-name">${esc(effortLabel(id, v))}</span>${s.effort === v ? '<span class="check">✓</span>' : ''}</button>`).join('')}`;
    sub.querySelectorAll('[data-effort]').forEach((b) => b.addEventListener('click', () => pick({ models: { [id]: { model: s.model, effort: b.dataset.effort } } })));
  } else if (menu.sub === 'synth') {
    sub.innerHTML = `<div class="ms-head">${back}<b>종합 담당</b><small>최종 답변을 씁니다</small></div>
      ${IDS.map((id) => `<button type="button" class="ms-row ${room.synthesizer === id ? 'cur' : ''}" data-synth="${id}" style="--c:${member(id).color}">${avatar(id)}<span class="ms-name">${esc(nameOf(id))}</span>${room.enabled[id] ? '' : '<small>참여 안 함</small>'}${room.synthesizer === id ? '<span class="check">✓</span>' : ''}</button>`).join('')}
      <p class="ms-note">종합 담당이 실패하거나 빠지면 다른 참여 AI가 정리하고, 그 사실을 표시합니다.</p>`;
    sub.querySelectorAll('[data-synth]').forEach((b) => b.addEventListener('click', () => pick({ synthesizer: b.dataset.synth })));
  } else {
    const debateId = menu.sub.startsWith('ai:') ? menu.sub.slice(3) : null;
    const target = debateId || menu.addId;
    const debateSettings = debateId && bag()[debateId];
    const debateEfforts = debateId ? modelEntry(debateId, debateSettings.model)?.efforts || [] : [];
    sub.innerHTML = `<div class="ms-head">${back}<div class="ms-search"><input type="search" placeholder="모델 검색…" value="${esc(menu.q)}" aria-label="모델 검색"><button type="button" data-act="add" class="${menu.adding ? 'on' : ''}" title="모델 ID 직접 입력 (고급)">+</button></div></div>
      ${menu.adding ? `<div class="ms-add">${debateId ? '' : `<div class="ms-add-ai">${IDS.map((x) => `<button type="button" data-add-ai="${x}" class="${menu.addId === x ? 'on' : ''}" title="${esc(nameOf(x))}">${avatar(x)}</button>`).join('')}</div>`}
        <input data-act="custom" placeholder="${esc(nameOf(target))} 모델 ID" maxlength="120" spellcheck="false" aria-label="모델 ID 직접 입력"><button type="button" data-act="save-custom">추가</button></div>
        <p class="ms-note">고급: CLI에서 확인한 ID를 직접 씁니다. 사용 가능 여부는 호출 테스트로 확인하세요.</p>` : ''}
      <div class="ms-list"></div>
      ${debateEfforts.length ? `<div class="ms-effort"><span>생각 수준</span><div class="seg">${['', ...debateEfforts].map((v) => `<button type="button" data-deffort="${v}" class="${debateSettings.effort === v ? 'on' : ''}">${esc(v || '기본')}</button>`).join('')}</div></div>` : ''}`;
    const search = sub.querySelector('input[type="search"]');
    search.addEventListener('input', () => { menu.q = search.value; renderList(debateId); });
    sub.querySelector('[data-act="add"]').addEventListener('click', () => { menu.adding = !menu.adding; renderMenu(); });
    sub.querySelectorAll('[data-add-ai]').forEach((b) => b.addEventListener('click', () => { menu.addId = b.dataset.addAi; renderMenu(); }));
    sub.querySelector('[data-act="save-custom"]')?.addEventListener('click', () => {
      const model = sub.querySelector('[data-act="custom"]').value.trim();
      if (!model) return;
      pick(debateId ? { [bagKey()]: { [debateId]: { model, effort: '' } } } : { selected: target, models: { [target]: { model, effort: '' } } });
    });
    sub.querySelectorAll('[data-deffort]').forEach((b) => b.addEventListener('click', () => update({ [bagKey()]: { [debateId]: { model: debateSettings.model, effort: b.dataset.deffort } } })));
    renderList(debateId);
  }
  sub.querySelector('[data-act="back"]').addEventListener('click', () => { menu.sub = null; renderMenu(); });
}
// Models grouped under each AI's character; the search filters only this list.
function renderList(debateId) {
  const room = state.room;
  const box = $('#menuSub .ms-list');
  const cur = debateId ? { id: debateId, ...bag()[debateId] } : { id: room.selected, ...room.models[room.selected] };
  const q = menu.q.trim().toLowerCase();
  const hit = (m) => !q || `${m.label} ${m.id} ${m.description}`.toLowerCase().includes(q);
  const row = (id, m, withFace) => {
    const on = id === cur.id && m.id === cur.model;
    const mark = m.check?.status === 'ok' ? '<i class="pk-dot ok" title="호출 확인됨"></i>'
      : m.check?.status === 'fail' ? `<i class="pk-dot fail" title="최근 실패 · ${esc(kindText(m.check.kind))}"></i>` : '';
    return `<button type="button" class="ms-row ${on ? 'cur' : ''}" data-pick="${id}" data-model="${esc(m.id)}" style="--c:${member(id).color}" title="${esc([m.id, m.description].filter(Boolean).join(' — '))}">
      ${withFace ? avatar(id) : ''}<span class="ms-name">${esc(m.label)}</span>${state.room.recommended?.[id]?.model === m.id ? '<span class="tag rec">추천</span>' : ''}<small>${esc(m.description || (m.label !== m.id ? m.id : ''))}</small>${mark}${on ? '<span class="check">✓</span>' : ''}</button>`;
  };
  const ids = debateId ? [debateId] : IDS;
  let html = '';
  if (!debateId && !q) {
    const verified = ids.flatMap((id) => state.catalog[id].models.filter((m) => m.check?.status === 'ok').map((m) => [id, m]));
    if (verified.length) html += `<div class="ms-sec"><span>호출 확인됨</span></div>${verified.map(([id, m]) => row(id, m, true)).join('')}`;
  }
  for (const id of ids) {
    const cat = state.catalog[id];
    const models = cat.models.filter(hit);
    if (!models.length) continue;
    const source = id === 'gpt' ? (cat.listedAt ? 'Codex CLI 목록' : '설정 기반') : id === 'claude' ? 'CLI 도움말' : '설정 기반 · 조회 불가';
    html += `<div class="ms-sec" style="--c:${member(id).color}">${avatar(id)}<span>${esc(nameOf(id))}</span><small>${source}</small>${cat.available ? '' : '<em>연결 설정 필요</em>'}</div>`;
    html += models.map((m) => row(id, m, false)).join('');
    if (id === 'gpt' && !cat.listedAt && !q) html += '<button type="button" class="ms-load" data-act="refresh">Codex 목록 불러오기 (사용량 없음)</button>';
  }
  box.innerHTML = html || '<p class="ms-note">찾는 모델이 없습니다. + 버튼으로 ID를 직접 입력할 수 있습니다.</p>';
  box.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.pick;
    const model = b.dataset.model;
    if (debateId) pick({ [bagKey()]: { [id]: { model, effort: effortFor(id, model, bag()[id].effort) } } });
    else pick({ selected: id, models: { [id]: { model, effort: effortFor(id, model, room.models[id].effort) } } });
  }));
  box.querySelector('[data-act="refresh"]')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = '불러오는 중…';
    try { applyState(await api('/api/models/refresh', { id: 'gpt' })); } catch (err) { toast(err.message); }
    if (!state.catalog.gpt.listedAt) toast('Codex 모델 목록을 불러오지 못했습니다. 설정 기반 목록을 사용합니다.');
    renderMenu();
  });
}

// ---------- first-start guide: connection check -> default AI/model -> start ----------
// Three plain steps: connect the AIs -> pick their "brains" (the lightest one is pre-selected and marked 추천)
// -> start. On the very first run every AI starts on the recommended light model; reopening the guide keeps
// what is already chosen.
const modelLabel = (id, s) => `${modelEntry(id, s.model)?.label || s.model}${s.effort ? ` · ${s.effort}` : ''}`;
function connState(id) {
  const check = state.room.checks[id];
  if (!state.catalog[id].available) return { key: 'install', text: '설치가 필요해요' };
  if (state.room.checking.includes(id)) return { key: 'busy', text: '확인 중…' };
  if (Object.values(check.models).some((c) => c.status === 'ok') || check.login?.status === 'ok') return { key: 'ok', text: '연결됐어요' };
  if (check.login?.status === 'fail') return { key: 'login', text: '로그인이 필요해요' };
  return { key: 'unknown', text: '아직 확인 전이에요' };
}
function openSetup() {
  closeMenu();
  const first = !state.room.onboarding.done;
  setup = { step: 1, firstRun: first, touched: new Set(), open: null, drafts: {}, listing: false,
    models: Object.fromEntries(IDS.map((id) => [id, { ...(first && state.room.recommended?.[id] ? state.room.recommended[id] : state.room.models[id]) }])) };
  $('#setup').hidden = false;
  renderSetup();
}
function renderSetup() {
  const s = setup;
  const body = $('#setupBody');
  const acts = $('#setupActions');
  const room = state.room;
  s.seen = JSON.stringify([room.checks, room.checking, state.catalog]);
  $('#setupSteps').querySelectorAll('li').forEach((li, i) => { li.className = i + 1 < s.step ? 'done' : i + 1 === s.step ? 'now' : ''; });
  if (s.step === 1) {
    body.innerHTML = `<h2 id="setupTitle">AI 연결하기</h2>
      <p>이 앱은 <b>내 컴퓨터에 설치되고 로그인된 AI</b>를 그대로 불러 써요. 비밀번호나 키를 입력할 필요가 없어요. 아래 <b>[연결 확인하기]</b>를 누르면 어떤 AI가 준비됐는지 알려 줘요. <b>사용량은 쓰지 않아요.</b></p>
      <div class="conn-table">${IDS.map((id) => {
        const cs = connState(id);
        const c = CONNECT[id];
        const check = room.checks[id];
        const detail = check.login?.detail || '';
        const how = cs.key === 'install' || cs.key === 'login'
          ? `<details class="cr-more" ${cs.key === 'install' ? '' : 'open'}><summary>어떻게 하나요?</summary><ol class="how">
              <li>${esc(c.need)}</li>
              ${cs.key === 'install' ? `<li>키보드의 <b>Windows 키</b>를 누르고 <b>PowerShell</b>을 검색해서 열어요.</li>
              <li>아래 줄을 복사해서 붙여넣고 Enter를 눌러요.<code class="cmd">${esc(c.install)}</code></li>` : ''}
              <li>${id === 'gemini' ? `PowerShell에 <code>agy</code>를 입력하면 브라우저가 열려요. 구독 중인 Google 계정으로 로그인해요.` : `PowerShell에 <code>${esc(c.login)}</code>를 입력해서 로그인해요.`}</li>
              <li>끝나면 이 앱을 껐다가 다시 켜요. (<b>start.bat</b>)</li></ol>
              <p class="hint">더 쉬운 방법: 프로젝트 폴더의 <b>setup.bat</b>을 더블클릭하면 설치를 도와줘요.</p></details>` : '';
        const test = cs.key === 'unknown' ? `<button type="button" class="model-pill" data-test="${id}" title="짧은 질문을 한 번 보내 봐요. 사용량이 조금 쓰여요">말 걸어 보기</button>` : '';
        return `<div class="conn-row" style="--c:${member(id).color}">${avatar(id, 'conn-av')}
          <div class="cr-main"><div><b>${esc(nameOf(id))}</b> <small>${esc(member(id).maker)}</small></div>
          <span class="cs ${cs.key}">${esc(cs.text)}</span>
          ${how}
          <details class="cr-more"><summary>자세한 상태 보기</summary><div class="conn-line">${connBadges(id, room.models[id].model)}</div>${detail ? `<div class="cr-detail">${esc(detail)}</div>` : ''}</details></div>${test}</div>`;
      }).join('')}</div>
      <div class="cost-note"><b>[연결 확인하기]</b>는 사용량이 들지 않아요. <b>[말 걸어 보기]</b>는 짧은 질문을 한 번 보내서 <b>구독 사용량이 조금 쓰여요</b>. 둘 다 안 해도 바로 시작할 수 있어요. 연결이 안 된 AI는 쉬고, 나머지만 대화해요.</div>`;
    acts.innerHTML = '<button type="button" class="model-pill" data-act="skip">나중에 하기</button><span class="grow"></span><button type="button" class="model-pill" data-act="login">연결 확인하기</button><button type="button" class="model-pill primary" data-act="next">다음</button>';
    body.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => {
      b.disabled = true; b.textContent = '확인 중…';
      const m = setup.models[b.dataset.test];
      testCall(b.dataset.test, 'general', m.model, m.effort);
    }));
  } else if (s.step === 2) {
    // ChatGPT's list of models is loaded quietly (it costs no usage), because the lightest one is found in it.
    if (state.catalog.gpt.available && !state.catalog.gpt.listedAt && !s.listing) {
      s.listing = true;
      api('/api/models/refresh', { id: 'gpt' }).then(applyState).catch(() => {}).finally(() => { if (setup === s) renderSetup(); });
    }
    // Until a choice is touched, the recommendation follows what the app knows.
    if (s.firstRun) for (const id of IDS) if (!s.touched.has(id) && room.recommended?.[id]) s.models[id] = { ...room.recommended[id] };
    const card = (id) => {
      const cur = s.models[id];
      const rec = room.recommended?.[id];
      const isRec = !!rec && cur.model === rec.model && (cur.effort || '') === (rec.effort || '');
      const cs = connState(id);
      const open = s.open === id;
      if (open) s.drafts[id] = { id, target: 'general', model: cur.model, effort: cur.effort, saved: cur.model, custom: false, more: false, ...s.drafts[id] };
      return `<div class="mcard ${open ? 'open' : ''}" style="--c:${member(id).color}">
        <div class="mc-top">${avatar(id, 'conn-av')}<b>${esc(nameOf(id))}</b><span class="cs ${cs.key}">${esc(cs.text)}</span></div>
        <div class="mc-model"><code>${esc(modelLabel(id, cur))}</code>${isRec ? '<span class="tag rec">추천 · 사용량 가장 적음</span>' : rec ? '<span class="tag">내가 고른 모델</span>' : ''}</div>
        ${!rec && id === 'gpt' ? '<small class="hint">가장 가벼운 모델을 찾는 중이에요… 잠시 뒤 자동으로 골라 드려요.</small>' : ''}
        <div class="mc-actions">${rec && !isRec ? `<button type="button" class="link-btn" data-rec="${id}">추천으로 되돌리기</button>` : ''}<button type="button" class="link-btn" data-change="${id}">${open ? '닫기' : '다른 모델 고르기'}</button></div>
        ${open ? `<div class="chooser" data-chooser="${id}">${chooserHTML(s.drafts[id])}</div>` : ''}</div>`;
    };
    body.innerHTML = `<h2 id="setupTitle">AI 두뇌(모델) 고르기</h2>
      <p>모델은 AI의 <b>“두뇌 종류”</b>예요. 가벼운 모델일수록 빠르고 <b>구독 사용량을 덜 써요</b>. 그래서 사용량을 가장 적게 쓰는 모델을 <b>추천</b>으로 미리 골라 뒀어요. 그대로 시작해도 돼요.</p>
      <div class="model-cards">${IDS.map(card).join('')}</div>
      <div class="cost-note">가벼운 모델은 아주 어려운 질문에는 덜 정확할 수 있어요. 나중에 사이드바의 <b>[연결·모델 설정 다시 열기]</b>나 입력창 아래 모델 버튼에서 언제든 바꿀 수 있어요.</div>`;
    acts.innerHTML = '<button type="button" class="model-pill" data-act="skip">나중에 하기</button><span class="grow"></span><button type="button" class="model-pill" data-act="prev">이전</button><button type="button" class="model-pill primary" data-act="next">다음</button>';
    body.querySelectorAll('[data-rec]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.rec;
      s.models[id] = { ...room.recommended[id] }; s.touched.delete(id); delete s.drafts[id]; renderSetup();
    }));
    body.querySelectorAll('[data-change]').forEach((b) => b.addEventListener('click', () => { const id = b.dataset.change; s.open = s.open === id ? null : id; renderSetup(); }));
    body.querySelectorAll('[data-chooser]').forEach((root) => {
      const id = root.dataset.chooser;
      const d = s.drafts[id];
      bindChooser(root, d, () => { s.models[id] = { model: d.model, effort: d.effort }; s.touched.add(id); renderSetup(); });
    });
  } else {
    const connected = IDS.filter((id) => connState(id).key === 'ok');
    body.innerHTML = `<h2 id="setupTitle">준비 끝!</h2><ul class="summary">${IDS.map((id) => {
      const cs = connState(id);
      const rec = room.recommended?.[id];
      const cur = s.models[id];
      return `<li><b>${avatar(id)} ${esc(nameOf(id))}</b><span><span class="cs ${cs.key}">${esc(cs.text)}</span> <code>${esc(modelLabel(id, cur))}</code>${rec && cur.model === rec.model ? ' <span class="tag rec">추천</span>' : ''}</span></li>`;
    }).join('')}</ul>
      <div class="howto"><b>이렇게 쓰면 돼요</b><ol class="how">
        <li>아래 입력창에 말을 걸면 <b>연결된 AI들이 모두</b> 답해요.</li>
        <li><code>@Claude</code>처럼 이름을 쓰면 그 AI에게만 물어봐요.</li>
        <li>위쪽 <b>Talk on</b>을 켜면 AI들이 알아서 서로 수다를 떨어요.</li>
        <li>궁금한 건 왼쪽 <b>[사용법 다시 보기]</b>에서 언제든 다시 볼 수 있어요.</li></ol></div>
      ${connected.length ? '' : '<p class="hint warn">아직 연결된 AI가 없어요. 이전으로 돌아가 <b>“어떻게 하나요?”</b>를 확인해 보세요. 그냥 시작해도 되고, 나중에 다시 열 수 있어요.</p>'}`;
    acts.innerHTML = '<button type="button" class="model-pill" data-act="prev">이전</button><span class="grow"></span><button type="button" class="model-pill primary" data-act="start">시작하기</button>';
  }
  const on = (act, fn) => acts.querySelector(`[data-act="${act}"]`)?.addEventListener('click', fn);
  on('skip', () => finishSetup(false));
  on('next', () => { setup.step++; renderSetup(); });
  on('prev', () => { setup.step--; renderSetup(); });
  on('start', () => finishSetup(true));
  on('login', async (e) => {
    e.target.disabled = true; e.target.textContent = '확인 중…';
    try { applyState(await api('/api/check/login', {})); } catch (err) { toast(err.message); }
    renderSetup();
  });
  acts.querySelector('.primary')?.focus({ preventScroll: true });
}
async function finishSetup(save) {
  const s = setup;
  // Saving applies the chosen (by default: recommended) model to every AI.
  const models = Object.fromEntries(IDS.filter((id) => s.models[id]).map((id) => [id, { model: s.models[id].model, effort: s.models[id].effort }]));
  const ok = await update(save ? { models, onboarding: { done: true } } : { onboarding: { done: true } });
  if (!ok) return;
  setup = null;
  $('#setup').hidden = true;
  if (!state.room.tutorial.done) startTour();
}

// ---------- tutorial: spotlight each control with a speech bubble ----------
const narrow = () => matchMedia('(max-width: 680px)').matches;
const visible = (el) => el && el.getClientRects().length > 0;
function startTour() {
  closeMenu();
  tour = { i: 0 };
  $('#tour').hidden = false;
  showTour();
}
async function showTour() {
  const step = TOUR[tour.i];
  const app = $('#app');
  if (narrow() && app.classList.contains('side-open') !== !!step.side) {
    app.classList.toggle('side-open', !!step.side);
    await new Promise((resolve) => setTimeout(resolve, 280));
  }
  if (!tour) return;
  const el = [step.sel, step.alt].filter(Boolean).map((s) => $(s)).find(visible);
  const card = $('#tourCard');
  const hole = $('#tourHole');
  const from = tour.i === 1 && card.dataset.step === '0' ? card.getBoundingClientRect() : null;
  const last = tour.i === TOUR.length - 1;
  card.innerHTML = `<div class="tc-count">${tour.i + 1} / ${TOUR.length}</div><h3>${esc(step.title)}</h3>${step.text ? `<p>${esc(step.text)}</p>` : ''}
    <div class="tc-actions"><button type="button" data-act="skip">건너뛰기</button><span class="grow"></span>${tour.i ? '<button type="button" data-act="prev">이전</button>' : ''}<button type="button" class="primary" data-act="next">${last ? '완료' : '다음'}</button></div>`;
  card.querySelector('[data-act="skip"]').onclick = endTour;
  card.querySelector('[data-act="prev"]')?.addEventListener('click', () => { tour.i--; showTour(); });
  card.querySelector('[data-act="next"]').onclick = () => { if (last) endTour(); else { tour.i++; showTour(); } };
  $('#tour').classList.toggle('no-hole', !el);
  const vw = innerWidth; const vh = innerHeight;
  const cw = card.offsetWidth; const ch = card.offsetHeight;
  if (!el) {
    hole.hidden = true;
    Object.assign(card.style, { left: `${(vw - cw) / 2}px`, top: `${(vh - ch) / 2}px` });
    card.dataset.dir = '';
  } else {
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const pad = 6;
    hole.hidden = false;
    Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    let left; let top; let dir;
    if (r.bottom + 16 + ch < vh) { dir = 'up'; top = r.bottom + 16; }
    else if (r.top - 16 - ch > 0) { dir = 'down'; top = r.top - 16 - ch; }
    if (dir) {
      left = clamp(r.left + r.width / 2 - cw / 2, 8, vw - cw - 8);
      card.style.setProperty('--ax', `${clamp(r.left + r.width / 2 - left, 16, cw - 16)}px`);
    } else {
      dir = r.right + 16 + cw < vw ? 'left' : 'none';
      left = dir === 'left' ? r.right + 16 : (vw - cw) / 2;
      top = clamp(r.top, 8, vh - ch - 8);
      card.style.setProperty('--ay', `${clamp(r.top + Math.min(r.height, 60) / 2 - top, 16, ch - 16)}px`);
    }
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
    card.dataset.dir = dir;
  }
  card.dataset.step = String(tour.i);
  if (from && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const to = card.getBoundingClientRect();
    const timing = { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' };
    card.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, opacity: .55 },
      { transform: 'translate(0, 0)', opacity: 1 },
    ], timing);
    if (!hole.hidden) hole.animate([{ opacity: 0 }, { opacity: 1 }], timing);
  }
  card.querySelector('.primary').focus({ preventScroll: true });
}
function endTour() {
  if (!tour) return;
  tour = null;
  $('#tour').hidden = true;
  if (narrow()) { $('#app').classList.remove('side-open'); $('#scrim').hidden = true; }
  if (!state.room.tutorial.done) update({ tutorial: { done: true } });
}

// ---------- sending ----------
async function send() {
  if (pending || state.room.active || (!input.value.trim() && !image)) return;
  pending = true; renderControls();
  try {
    await api('/api/send', { text: input.value.trim(), image });
    input.value = ''; autosize(); clearImage();
    applyState(await api('/api/state'));
    tl.scrollTop = tl.scrollHeight;
  } catch (e) { toast(e.message); }
  finally { pending = false; renderControls(); }
}
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; }
function clearImage() { image = null; $('#attachChip').hidden = true; $('#fileInput').value = ''; }
async function attach(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { toast('PNG/JPG/GIF/WEBP 사진, 2MB 이하를 선택하세요.'); return; }
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
  });
  image = { mime: file.type, data: data.split(',')[1] };
  const thumb = document.createElement('img'); thumb.src = data; thumb.alt = '첨부 미리보기';
  const info = document.createElement('span'); info.className = 'q';
  const name = document.createElement('b'); name.textContent = file.name;
  const meta = document.createElement('small'); meta.textContent = `${file.type.split('/')[1].toUpperCase()} · ${Math.max(1, Math.round(file.size / 1024))}KB`;
  info.append(name, meta);
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', '첨부 제거'); remove.onclick = clearImage;
  $('#attachChip').replaceChildren(thumb, info, remove); $('#attachChip').hidden = false;
}

// ---------- events ----------
$('#examples').replaceChildren(...EXAMPLES.map((x) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'example';
  b.innerHTML = `<span class="tag">${esc(x.tag)}</span>${esc(x.text)}`;
  b.addEventListener('click', () => { input.value = x.text; autosize(); input.focus(); });
  return b;
}));
$('#modelPicker').onclick = () => (menu ? closeMenu() : openMenu());
$('#debateToggle').onchange = (e) => update({ discussion: e.target.checked });
$('#targetToggle').onchange = (e) => update({ targeted: e.target.checked });

// ---------- "@" picker: choose one AI to address, right above the input ----------
const ALIAS_HINT = { claude: ['claude', '클로드'], gpt: ['chatgpt', 'gpt', '챗지피티', '지피티'], gemini: ['gemini', '제미나이', '제미니'] };
let mention = null; // { from, to, items, i }
function closeMention() { mention = null; $('#mentionPop').hidden = true; }
function updateMention() {
  const caret = input.selectionStart;
  const m = /(?:^|[\s(])@([A-Za-z가-힣]*)$/.exec(input.value.slice(0, caret));
  if (!m) { closeMention(); return; }
  const q = m[1].toLowerCase();
  const items = IDS.slice().reverse().filter((id) => !q || ALIAS_HINT[id].some((a) => a.startsWith(q)) || nameOf(id).toLowerCase().startsWith(q));
  if (!items.length) { closeMention(); return; }
  mention = { from: caret - m[1].length - 1, to: caret, items, i: Math.min(mention?.i ?? 0, items.length - 1) };
  renderMention();
}
function renderMention() {
  const pop = $('#mentionPop');
  pop.hidden = false;
  pop.replaceChildren(...mention.items.map((id, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'option'); b.className = i === mention.i ? 'on' : '';
    const st = statusOf(id, bag()[id].model);
    b.innerHTML = `${avatar(id)}<b>${esc(nameOf(id))}</b><small>${esc(st.text)}</small>`;
    b.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(id); });
    return b;
  }));
}
function pickMention(id) {
  const at = `@${nameOf(id)} `;
  input.value = input.value.slice(0, mention.from) + at + input.value.slice(mention.to);
  const pos = mention.from + at.length;
  input.setSelectionRange(pos, pos);
  closeMention(); autosize(); input.focus();
}
input.addEventListener('input', updateMention);
input.addEventListener('click', updateMention);
input.addEventListener('blur', closeMention);
document.addEventListener('mousedown', (e) => {
  if (menu && !e.target.closest('#modelPop, #modelPicker')) closeMenu();
});
$('#webSearch').onchange = (e) => update({ webSearch: e.target.checked });
// ---------- pen icons: edit the room's title and my own name in place ----------
function editInline(textEl, current, label, save) {
  if (textEl.dataset.editing) return;
  textEl.dataset.editing = '1';
  const field = document.createElement('input');
  field.className = 'name-input'; field.value = current; field.maxLength = 20; field.setAttribute('aria-label', label);
  textEl.hidden = true; textEl.after(field); field.focus(); field.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const value = field.value.trim();
    field.remove(); textEl.hidden = false; delete textEl.dataset.editing;
    if (commit && value && value !== current) save(value);
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) finish(true);
    else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  field.addEventListener('blur', () => finish(true));
}
$('#roomEdit').onclick = () => editInline($('#roomName'), state.room.name, '단톡방 이름', (v) => update({ roomName: v }));
$('#meEdit').onclick = () => editInline($('#meName'), state.room.userName, '내 이름', (v) => update({ userName: v }));
const toggleAuto = () => update({ auto: { on: !state.room.auto.on } });
$('#chatterBtn').onclick = toggleAuto;
$('#powerBtn').onclick = toggleAuto;
$('#autoSleep').onchange = (e) => update({ auto: { sleepMinutes: Number(e.target.value) } });
$('#levelSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-level]');
  if (b) update({ auto: { level: b.dataset.level } });
});
$('#detailsBox').addEventListener('toggle', () => { if (state) renderDetails(); });
$('#openSetup').onclick = openSetup;
$('#openTour').onclick = startTour;
$('#send').onclick = send;
$('#stop').onclick = async () => { try { await api('/api/cancel', {}); applyState(await api('/api/state')); } catch (e) { toast(e.message); } };
input.oninput = autosize;
input.onkeydown = (e) => {
  if (mention) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mention.i = (mention.i + (e.key === 'ArrowDown' ? 1 : -1) + mention.items.length) % mention.items.length;
      renderMention(); return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) { e.preventDefault(); pickMention(mention.items[mention.i]); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMention(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
};
$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => attach(e.target.files[0]).catch((err) => toast(err.message));
input.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files || [])][0];
  if (file) { e.preventDefault(); attach(file).catch((err) => toast(err.message)); }
});
$('.composer').addEventListener('dragover', (e) => e.preventDefault());
$('.composer').addEventListener('drop', (e) => { e.preventDefault(); attach(e.dataTransfer.files[0]).catch((err) => toast(err.message)); });
$('#msgs').addEventListener('click', async (e) => {
  const copy = e.target.closest('.copy-code');
  if (copy) {
    try { await navigator.clipboard.writeText(copy.closest('.code-block').querySelector('code').textContent); toast('코드를 복사했습니다.'); }
    catch { toast('브라우저가 클립보드 접근을 허용하지 않습니다.'); }
  }
  const fold = e.target.closest('.fold-btn');
  if (fold) {
    const id = Number(fold.dataset.fold);
    const open = !foldOpen.has(id);
    if (open) foldOpen.add(id); else foldOpen.delete(id);
    fold.previousElementSibling.hidden = !open;
    fold.setAttribute('aria-expanded', String(open));
    fold.textContent = open ? '▴ 접기' : `▾ 이어서 보기 · ${fold.dataset.more}`;
  }
  const expand = e.target.closest('.code-expand');
  if (expand) {
    const collapsed = expand.closest('.code-block').querySelector('pre').classList.toggle('collapsed');
    expand.textContent = collapsed ? '펼치기' : '접기';
  }
  const img = e.target.closest('.att-img');
  if (img) { $('#lbImg').src = img.src; $('#lbCap').textContent = img.alt; $('#lightbox').hidden = false; }
});
tl.addEventListener('scroll', () => {
  const far = distance();
  if (far < 100) $('#jump').hidden = true;
  else if (far > 400 && $('#jump').hidden) showJump('최신 메시지로 ↓');
});
$('#jump').onclick = () => { tl.scrollTop = tl.scrollHeight; $('#jump').hidden = true; };
$('#lightbox').onclick = () => { $('#lightbox').hidden = true; };
$('#wsBtn').onclick = () => setWorkspaceOpen($('#app').classList.contains('ws-closed'));
$('#closeWs').onclick = () => setWorkspaceOpen(false);
$('#openSide').onclick = () => { $('#app').classList.toggle('side-open'); $('#scrim').hidden = !$('#app').classList.contains('side-open'); };
$('#scrim').onclick = () => { $('#app').classList.remove('side-open'); $('#scrim').hidden = true; };
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const theme = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; localStorage.setItem('chatroom-theme', theme);
};
const savedTheme = localStorage.getItem('chatroom-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
document.addEventListener('keydown', (e) => {
  if (tour) {
    if (e.key === 'Escape') endTour();
    if (e.key === 'ArrowRight' && tour.i < TOUR.length - 1) { tour.i++; showTour(); }
    if (e.key === 'ArrowLeft' && tour.i > 0) { tour.i--; showTour(); }
    return;
  }
  if (e.key === 'Escape') {
    if (profileId) { closeProfile(); return; }
    if (menu?.sub) { menu.sub = null; renderMenu(); return; }
    if (menu) closeMenu();
    $('#lightbox').hidden = true; $('#app').classList.remove('side-open'); $('#scrim').hidden = true;
  }
});
addEventListener('resize', () => { if (tour) showTour(); });
$('#loadMore').onclick = async () => {
  try {
    const height = tl.scrollHeight;
    const older = await api(`/api/history?before=${state.messages[0]?.id || ''}`);
    const known = new Set(state.messages.map((m) => m.id));
    state.messages = [...older.messages.filter((m) => !known.has(m.id)), ...state.messages];
    renderMessages();
    tl.scrollTop += tl.scrollHeight - height;
    $('#loadMore').hidden = older.messages.length < 200;
  } catch (e) { toast(e.message); }
};
function connect() {
  const events = new EventSource('/events');
  events.addEventListener('state', (e) => applyState(JSON.parse(e.data)));
  events.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (state.messages.some((x) => x.id === m.id)) return;
    state.messages.push(m);
    refreshMessages(true);
  });
  events.onerror = () => { $('#roomSub').textContent = '서버 연결 대기 중'; };
}
try {
  applyState(await api('/api/state'));
  tl.scrollTop = tl.scrollHeight;
  $('#loadMore').hidden = state.messages.length < 300;
  connect();
  if (!state.room.onboarding.done) openSetup();
  else if (!state.room.tutorial.done) startTour();
} catch (e) {
  $('#roomSub').textContent = '서버에 연결하지 못했어요';
  toast(`서버 연결 실패: ${e.message}`);
}
