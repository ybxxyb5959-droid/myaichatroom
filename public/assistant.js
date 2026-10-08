// Personal assistant UI; the existing portraits and group-chat layout are reused.
import { esc, renderMarkdown, extractLinks, splitFold, houseNoticeHTML, houseEventHTML } from './format.mjs';
import { voteCardHTML, bindVoteCard, updateVoteClocks } from './joint-vote.mjs';
import { memberStatus, latestCall, limitWindows, batteryLevel } from './status.mjs';
import { createDiscussionStage } from './discussion-stage.mjs';
import { dotCharacters, dotCharacter } from './dot-characters.mjs';
import { playCardNode, updatePlayClocks } from './play-ui.mjs';

const $ = (s) => document.querySelector(s);
const guest = document.body.dataset.role === 'guest';
let guestDiscussion = false;
let guestWebSearch = false;
$('#guestLeave').hidden = !guest;
$('#guestLeave').onclick = () => { if (guest) location.assign('/logout'); };
if (guest) {
  $('#wsBtn').setAttribute('aria-label', '공유 보관함 열기'); $('#wsBtn').title = '공유 사진·창작물 보관함'; $('#wsBtn').removeAttribute('data-i18n-aria');
  $('#ws').setAttribute('aria-label', '공유 보관함'); $('#ws').removeAttribute('data-i18n-aria');
  const title = $('#ws [data-tab="files"]'); title.textContent = '공유 보관함'; title.removeAttribute('data-i18n');
}
$('#ownerMore').hidden = guest;
$('#ownerMore').querySelectorAll('[data-head-action]').forEach(button => {
  button.onclick = () => { $('#ownerMore').open = false; document.getElementById(button.dataset.headAction).click(); };
});
document.addEventListener('click', event => { if (!$('#ownerMore').contains(event.target)) $('#ownerMore').open = false; });
$('#ownerMore').addEventListener('keydown', event => { if (event.key === 'Escape') { $('#ownerMore').open = false; $('#ownerMore summary').focus(); } });
const IDS = ['gemini', 'gpt', 'claude'];
const PHASES = { answer: '답변', opinion: '독립 의견', review: '교차 검토', selection: '최종 답변 AI 선정 중', final: '최종 정리' };
const STEPS = ['opinion', 'review', 'selection', 'final'];
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
  { sel: '#input', title: '말 걸어 보기', text: '방을 켜면 각 AI가 새 메시지를 읽고 말하거나 넘어가요. Shift+Enter로 줄을 바꾸고, @로 멘션할 수 있어요.' },
  { sel: '#members', side: true, title: 'AI 친구들', text: '왼쪽에 AI들이 있어요.  남은 한도와 연결상태를 확인 할 수 있어요.' },
  { sel: '#members .switch', side: true, title: '참여 스위치', text: '참여를 끄면 AI는 쉬어요. 사용량을 아끼고 싶을 때 써 보세요. 다시 켜면 돌아와요.' },
  { sel: '#modelPicker', title: '누가 답할지, 어떤 모델인지', text: '참여할 AI를 켜고 끄고, AI들의 “모델”을 바꿀 수 있어요. 사용량에 따라 조절해보세요.' },
  { sel: '#recipientHint', title: '자율 대화', text: '대표 답변자를 뽑지 않아요. 각 AI가 따로 읽고 답하며, @이름이나 답장은 그 AI가 먼저 읽게 해요. 다른 AI도 참여할 수 있어요.' },
  { sel: '#debateSwitch', title: '토론 모드', text: '중요한 결정을 할때, AI들이 각자 의견을 내고, 서로 검토한 뒤, 하나의 결론으로 정리해 줘요. 시간이 더 걸리고 한도소모가 클 수 있어요.' },
  { sel: '#chatterBtn', title: 'Talk on / off', text: '켜 두면 사용자 메시지와 동료의 말에 각자 반응해요. 최대 3개의 호출이 동시에 진행돼요. 끄면 진행 중인 일반 대화도 중단해요.' },
  { sel: '#boostSeg', side: true, title: '⚡ 진심모드', text: '복잡한 요청은 더 강한 모델로 생각해요. 자동·부를 때만·끔을 선택할 수 있어요. 대화 속도는 바뀌지 않아요.' },
  { sel: '#meEdit', side: true, title: '이름 바꾸기', text: 'AI들은 내 이름을 기억해요.' },
  { sel: '#webSearchField', title: '인터넷 검색', text: 'AI가 인터넷에서 찾아보고 답해요. 모든 AI가 지원하는 건 아니니, 켠 뒤 나오는 안내를 확인하세요.' },
  { sel: '#guideButtons', side: true, title: '설정은 언제든 다시', text: 'AI 연결과 모델 설정, 사용법은 여기서 언제든 다시 열 수 있어요.' },
];

let state;
let pending = false;
let image = null;
let menu = null; // compact model menu: { sub, q, adding, addId }
let setup = null; // first-start guide draft
let tour = null;
let renderedKey = '';
let replyTo = null;
const replyChip = document.createElement('button');
replyChip.type = 'button'; replyChip.className = 'reply-quote'; replyChip.hidden = true;
replyChip.setAttribute('aria-label', '답장 취소');
const messageKey = () => JSON.stringify([state.messages.map((m) => [m.id, m.reactions]), state.room.active?.id, state.play?.polls, state.play?.games, state.play?.bookmarks]);
const wave = (text) => `<span class="typing-wave" aria-label="${esc(text)}">${[...text].map((c, i) => `<span aria-hidden="true" style="--i:${i}">${esc(c)}</span>`).join('')}</span>`;
const runOpen = new Map(); // discussion runs the user opened or closed by hand
const input = $('#input');
const tl = $('#timeline');
const mediaURL = path => guest ? `/api/gallery/file?path=${encodeURIComponent(path)}` : `/ws/${path.split('/').map(encodeURIComponent).join('/')}`;
let chatHouse = null, votesLoading = false, votesDirty = false;
const chatVotes = new Map();
const votePreference = vote => sessionStorage.getItem(`room-vote:${chatHouse?.selfId || 'owner'}:${vote.id}`);
function renderLiveVotes() {
  let live = $('#chatVoteLive');
  if (!live) { live = document.createElement('div'); live.id = 'chatVoteLive'; $('#msgs').after(live); }
  live.replaceChildren(...[chatHouse?.story?.current, chatHouse?.vote].filter(v => v?.status === 'open' && v.ballots && !state.messages.some(m => m.voteId === v.id)).map(v => chatVoteNode({ id: `vote-${v.id}`, voteId: v.id, text: `투표가 열렸어요! ${v.title || '공동 인테리어 투표'}` })));
}
function chatVoteNode(message) {
  const node = document.createElement('div'); node.dataset.id = message.id; node.dataset.voteId = message.voteId; node.className = 'sys k-house-vote';
  const vote = chatVotes.get(message.voteId), preference = vote && votePreference(vote);
  const open = vote?.status === 'open';
  node.innerHTML = `<div class="chat-vote-notice"><b>🏠 ${esc(vote && !open ? vote.result || '투표가 마감되었습니다.' : message.text)}</b><div><button type="button" data-house-open>집 보기</button>${!vote || open ? `<button type="button" data-participate aria-expanded="${preference === 'join'}">참여</button><button type="button" data-decline>${preference === 'skip' ? '참여 안 함 ✓' : '참여 안 함'}</button>` : '<small>마감</small>'}</div></div><div class="chat-vote-card" ${open && preference === 'join' ? '' : 'hidden'}></div>`;
  const card = node.querySelector('.chat-vote-card');
  if (vote) { card.innerHTML = voteCardHTML(vote, chatHouse); bindVoteCard(card, vote, async body => { await api('/api/house/ballot', body); await loadChatVotes(); window.dispatchEvent(new Event('house-update')); }); }
  node.querySelector('[data-participate]')?.addEventListener('click', async () => {
    if (!vote) {
      await loadChatVotes();
      if (!chatVotes.has(message.voteId)) { toast('투표 정보를 불러오지 못했습니다. 잠시 후 다시 눌러 주세요.'); return; }
    }
    sessionStorage.setItem(`room-vote:${chatHouse.selfId || 'owner'}:${message.voteId}`, 'join');
    const updated = chatVoteNode(message);
    const current = node.isConnected ? node : document.querySelector(`[data-vote-id="${CSS.escape(message.voteId)}"]`);
    current?.replaceWith(updated);
    updated.querySelector('.chat-vote-card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  node.querySelector('[data-decline]')?.addEventListener('click', () => {
    if (!vote) return;
    sessionStorage.setItem(`room-vote:${chatHouse.selfId || 'owner'}:${vote.id}`, 'skip');
    node.replaceWith(chatVoteNode(message));
  });
  return node;
}
async function loadChatVotes() {
  if (votesLoading) { votesDirty = true; return; }
  votesLoading = true;
  try {
    chatHouse = await api('/api/house');
    for (const v of [...(chatHouse.story?.history || []), ...(chatHouse.voteHistory || []), chatHouse.story?.current, chatHouse.vote]) {
      if (!v?.ballots) continue;
      chatVotes.set(v.id, { ...v, myChoice: v.ballots[`human:${chatHouse.selfId || 'owner'}`]?.choice ?? null });
    }
    const stick = distance() < 100;
    renderLiveVotes();
    for (const node of $('#msgs').querySelectorAll('[data-vote-id]')) {
      const message = state.messages.find(m => String(m.id) === node.dataset.id);
      if (message) node.replaceWith(chatVoteNode(message));
    }
    if (stick) tl.scrollTop = tl.scrollHeight;
  } catch (error) { if (state?.messages.some(m => m.kind === 'house-vote')) toast(error.message); }
  finally { votesLoading = false; if (votesDirty) { votesDirty = false; loadChatVotes(); } }
}
window.addEventListener('house-update', loadChatVotes);
setInterval(() => updateVoteClocks($('#msgs')), 1000);
const renderDiscussionStage = createDiscussionStage($('#discussionStage'));

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
  if (guest) { toast('방장만 설정을 변경할 수 있습니다.'); return false; }
  try { applyState(await api('/api/room', body)); return true; } catch (e) { toast(e.message); renderControls(); return false; }
}
const member = (id) => state.members.find((m) => m.id === id);
const nameOf = (id) => id === 'user' ? state?.room.userName || '방장'
  : String(id).startsWith('guest:') ? state?.participants?.find(p => p.id === id.slice(6))?.name || '친구' : member(id)?.name || id;
// Each friend keeps one colour from their stable id, so equal-looking names stay apart.
const friendOf = (guestId) => state?.participants?.find((p) => p.id === guestId);
const authorName = (m) => m.from === 'user' && m.guestId ? friendOf(m.guestId)?.name || m.displayName || '친구' : m.displayName || nameOf(m.from);
const friendColor = (guestId) => { let h = 0; for (const c of String(guestId)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 62% 48%)`; };
const selfReactor = () => guest ? `guest:${state.selfId}` : 'user';
const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '😡'];
const INTENSITY_HINTS = {
  quiet: '@이름으로 부르거나 AI에게 답장할 때만 반응해요.',
  normal: 'AI가 대화 흐름을 보고 말할지 넘길지 스스로 정해요.',
  lively: 'AI끼리 @멘션으로 이어 말할 수 있어요. 친구 대화는 최초 응답 포함 최대 3회까지만 이어져요.',
};
const avatar = (id, cls = 'mini-av') => `<img class="${cls}" src="/avatars/${id}-pixel-128.png" alt="">`;
const settingText = (s) => `${s.model}${s.effort ? ` · ${s.effort}` : ''}`;
const kindText = (kind) => state.kinds[kind] || state.kinds.unknown;

// One plain status per AI (rules in status.mjs); the separate technical steps live under "자세히".
const STATUS_CLS = { setup: 'missing', rest: 'off', busy: 'busy', check: 'unknown', active: 'ok', quota: 'off', auth: 'missing', model: 'fail', cooldown: 'unknown' };
function statusOf(id, model, connection = false) {
  const check = state.room.checks[id];
  const s = memberStatus({ available: state.catalog[id].available, enabled: state.room.enabled[id],
    busy: state.room.active?.states[id]?.status === '생성 중', checking: state.room.checking.includes(id),
    loginStatus: check.login?.status, call: connection ? latestCall(check) : check.models[model], health: member(id)?.health, now: Date.now() });
  return { cls: STATUS_CLS[s.key], text: s.text };
}
// A cooldown ends at the server's time: redraw right then (and every 30 s meanwhile, for the minutes left),
// so the member shows "활성" again without waiting for a new state from the server.
let healthTimer = 0;
function scheduleHealth() {
  clearTimeout(healthTimer);
  const ends = state.members.map((m) => m.health?.until || 0).filter((t) => t > Date.now());
  if (!ends.length) return;
  healthTimer = setTimeout(() => { renderControls(); if (profileId) renderProfile(); scheduleHealth(); }, Math.min(Math.min(...ends) - Date.now() + 50, 30000));
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
// "@방장" in an AI's message is a call to the user: highlight it.
const atMe = (html) => {
  const name = state?.room?.userName;
  return name && html.includes(`@${esc(name)}`) ? html.split(`@${esc(name)}`).join(`<span class="at-me">@${esc(name)}</span>`) : html;
};
function bodyHTML(m) {
  return atMe(plainBodyHTML(m));
}
function plainBodyHTML(m) {
  const { head, tail } = FOLD_PHASES.has(m.phase) || (m.text || '').length > 1600 ? splitFold(m.text || '') : { head: m.text || '', tail: '' };
  if (!tail) return renderMarkdown(head);
  const open = foldOpen.has(m.id);
  return `${renderMarkdown(head)}<div class="fold-tail" ${open ? '' : 'hidden'}>${renderMarkdown(tail)}</div>`
    + `<button type="button" class="fold-btn" data-fold="${m.id}" data-more="약 ${tail.length}자" aria-expanded="${open}">${open ? '▴ 접기' : `▾ 이어서 보기 · 약 ${tail.length}자`}</button>`;
}
function messageNode(m) {
  const node = document.createElement('div');
  node.dataset.id = m.id;
  if (m.from === 'system') {
    if (m.kind === 'house-vote') return chatVoteNode(m);
    if (m.kind === 'play') return playCardNode(m, playContext(), playAct);
    if (m.kind === 'house-event') {
      node.className = 'sys k-house-event';
      node.innerHTML = houseEventHTML(m.text, m.houseEvent?.id);
      return node;
    }
    if (m.kind === 'house-news') {
      node.className = 'sys k-house-news';
      node.innerHTML = `<span>${esc(m.text)}</span><button type="button" class="house-event-link" data-house-open>집짓기 보기</button>`;
      return node;
    }
    if (m.kind === 'house-build') {
      node.className = 'sys k-house-build';
      const actor = member(m.by);
      if (actor) node.style.setProperty('--c', actor.color);
      node.innerHTML = houseNoticeHTML(nameOf(m.by), m.text);
      return node;
    }
    node.className = `sys ${m.kind === 'error' ? 'k-error' : ''} ${m.kind === 'cancelled' ? 'k-cancel' : ''} ${m.kind === 'presence' ? 'k-presence' : ''} ${m.kind === 'welcome' ? 'k-welcome' : ''} ${m.kind === 'play-result' ? 'k-play-result' : ''}`;
    const badge = m.kind === 'error' ? `<span class="err-kind k-${esc(m.errorKind || 'unknown')}">${esc(kindText(m.errorKind))}</span> ` : '';
    const who = m.by && m.kind !== 'presence' ? `<b>${esc(nameOf(m.by))}${m.phase && m.phase !== 'answer' ? ` · ${esc(PHASES[m.phase] || m.phase)}` : ''}: </b>` : '';
    if (m.kind === 'digest') {
      // "오늘 뭐 했어?" answered from the activity log; a more natural summary is one explicit message away.
      node.className = 'sys k-digest';
      node.innerHTML = `<div class="text">${renderMarkdown(m.text)}</div>`;
      const ask = document.createElement('button'); ask.type = 'button'; ask.className = 'model-pill';
      ask.textContent = 'AI에게 자연스럽게 요약해 달라고 하기';
      ask.title = '입력창에 요청을 채워요. 보내면 AI 한 명이 답해요 (호출 1회).';
      ask.onclick = () => { input.value = `아래 활동 기록을 두세 줄로 자연스럽게 요약해 줘.\n${m.text.split('\n').filter((l) => l.startsWith('- ')).join('\n')}`; autosize(); input.focus(); };
      node.append(ask);
      return node;
    }
    node.innerHTML = `${badge}${who}${esc(m.text)}${m.detail ? `<details class="error-details"><summary>자세히</summary>${esc(m.detail)}</details>` : ''}`;
    return node;
  }
  const mine = m.from === 'user' && (guest ? m.guestId === state.selfId : !m.guestId);
  const who = member(m.from);
  node.className = `msg ${mine ? 'mine' : ''} ${m.phase === 'final' ? 'final' : ''} ${m.from === 'user' && m.guestId ? 'friend' : ''}`;
  if (m.from === 'user' && m.guestId) node.style.setProperty('--c', friendColor(m.guestId));
  const friend = m.from === 'user' && m.guestId ? friendOf(m.guestId) : null;
  const face = who ? `<img class="m-av clickable" data-profile="${who.id}" role="button" tabindex="0" src="/avatars/${who.id}-pixel-128.png" alt="${esc(who.name)} 프로필 보기">`
    : m.guestId && !mine ? `<div class="m-av friend-av" aria-hidden="true">${esc(friend?.icon || [...authorName(m)][0] || '친')}</div>` : '<div class="m-av"></div>';
  const attachment = !m.attach?.path ? '' : /\.(png|jpe?g|gif|webp|svg)$/i.test(m.attach.path)
    ? `<img class="att-img" src="${mediaURL(m.attach.path)}" alt="${esc(m.attach.label || '첨부 사진')}">${m.attach.generated ? `<small>${esc(m.attach.label)}</small>` : ''}`
    : `<button type="button" class="model-pill" data-attachment>${esc(m.attach.path)} · 열기</button>`;
  const game = m.game?.path ? `<button type="button" class="model-pill" data-game>${esc(m.game.title)} · 게임 열기</button>` : '';
  const memo = m.note?.path ? `<button type="button" class="model-pill" data-note>📝 ${esc(m.note.title)} · 메모 열기</button>` : '';
  const links = mine ? [] : extractLinks(m.text || '');
  const sources = links.length ? `<details class="sources"><summary>출처 링크 ${links.length}개 <span>· 링크 형식만 확인했고 내용은 검증하지 않았습니다</span></summary><ol>${links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label || l.host)}</a> <span class="host">${esc(l.host)}</span></li>`).join('')}</ol></details>` : '';
  const humanReply = who && state.messages.find(message => message.id === m.replyTo && message.from === 'user');
  const target = m.addressedTo || (humanReply ? humanReply.displayName || humanReply.name || state.room.userName : null)
    || (who && m.guestId ? state.participants?.find(p => p.id === m.guestId)?.name : null);
  const addressed = target && who ? `<span class="m-maker">${esc(target)}에게 답변</span>` : '';
  const phase = m.phase === 'final' ? '<span class="phase final-tag">최종 답변</span>'
    : m.phase && m.phase !== 'answer' ? `<span class="phase">${esc(PHASES[m.phase] || m.phase)}</span>` : '';
  node.innerHTML = `${face}<div class="m-body">
    <div class="m-head"><span class="n">${esc(m.from === 'user' && m.guestId ? authorName(m) : m.displayName || who?.name || (m.from === 'user' ? state.room.userName : m.from))}${m.from === 'user' && m.guestId ? ' · 친구' : ''}</span><span class="model">${esc(m.model || '')}${m.effort ? ` · ${esc(m.effort)}` : ''}</span>${addressed}${phase}</div>
    <div class="line"><div class="bubble"><div class="text">${bodyHTML(m)}</div>${attachment}${game}${memo}${sources}</div></div></div>`;
  const bubble = node.querySelector('.bubble');
  if (m.replyPreview) {
    const quote = document.createElement('button');
    quote.type = 'button'; quote.className = 'reply-quote';
    quote.textContent = `${m.replyPreview.name || nameOf(m.replyPreview.from)}에게 답장 · ${m.replyPreview.text}`;
    quote.onclick = () => document.querySelector(`[data-id="${Number(m.replyTo)}"]`)?.scrollIntoView({ block: 'center' });
    bubble.prepend(quote);
  }
  if (m.autoPick) {
    const note = document.createElement('small'); note.className = 'auto-pick';
    note.textContent = `💬 자동 → ${nameOf(m.autoPick.id)} · ${m.autoPick.reason}`;
    node.querySelector('.m-body').append(note);
  }
  const actions = document.createElement('div'); actions.className = 'chat-actions';
  const answer = document.createElement('button'); answer.type = 'button'; answer.textContent = '답장';
  answer.onclick = () => {
    replyTo = m.id; replyChip.textContent = `${authorName(m)}에게 답장 · ${(m.text || '').slice(0, 100)} ×`;
    replyChip.hidden = false; input.before(replyChip); input.focus();
  };
  actions.append(answer);
  const saved = state.play?.bookmarks?.includes(m.id);
  const mark = document.createElement('button'); mark.type = 'button'; mark.className = 'bookmark-btn';
  mark.textContent = saved ? '★ 저장됨' : '☆ 저장'; mark.setAttribute('aria-pressed', String(!!saved));
  mark.title = saved ? '명장면 저장 취소' : '명장면으로 저장';
  mark.onclick = () => playAct({ action: 'bookmark.toggle', id: m.id }).catch(() => {});
  actions.append(mark);
  const picker = document.createElement('details'); picker.className = 'reaction-picker';
  const summary = document.createElement('summary'); summary.textContent = '공감';
  picker.append(summary); actions.append(picker);
  for (const emoji of REACTIONS) {
    const people = m.reactions?.[emoji] || [];
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = `${emoji}${people.length ? ` ${people.length}` : ''}`;
    button.title = people.length ? people.map(nameOf).join(', ') : `${emoji} 공감`;
    button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', String(people.includes(selfReactor())));
    button.onclick = async () => {
      picker.open = false;
      try { await api('/api/react', { id: m.id, emoji }); } catch (e) { toast(e.message); }
    };
    (people.length ? actions : picker).append(button);
  }
  node.querySelector('.m-body').append(actions);
  if (who) node.style.setProperty('--c', who.color);
  node.querySelector('[data-note]')?.addEventListener('click', () => { setWorkspaceOpen(true); openFile(m.note.path); });
  node.querySelector('[data-attachment]')?.addEventListener('click', () => { setWorkspaceOpen(true); openFile(m.attach.path); });
  node.querySelector('[data-game]')?.addEventListener('click', () => {
    setWorkspaceOpen(true);
    openFile(m.game.path);
  });
  return node;
}
// ---------- play: polls, mini games, bookmarks ----------
const personLabel = (id) => id === 'owner' ? state.room.userName || '방장' : nameOf(id);
function playContext() {
  const ai = IDS.slice().reverse().find((id) => member(id)?.enabled && member(id)?.available) || 'claude';
  return { play: state.play, person: guest ? `guest:${state.selfId}` : 'owner', owner: !guest, nameOf: personLabel, aiName: nameOf(ai),
    askAI: (text) => { input.value = text; autosize(); input.focus(); toast(guest ? '보내면 AI가 의견을 말해요 · 내 AI 호출 1회 차감' : '보내면 AI가 의견을 말해요.'); } };
}
async function playAct(body) {
  try { const result = await api('/api/play', body); applyState(await api('/api/state')); return result; }
  catch (e) { toast(e.message); throw e; }
}
setInterval(() => updatePlayClocks($('#msgs')), 1000);
function jumpTo(id) {
  const node = document.querySelector(`#msgs [data-id="${id}"]`);
  if (!node) return false;
  node.closest('details')?.setAttribute('open', '');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 1600);
  return true;
}
function renderSaved() {
  const list = state.play?.saved || [];
  $('#savedList').replaceChildren(...(list.length ? list.slice().reverse().map((item) => {
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" class="saved-open"><b>${esc(item.name)}</b><span>${esc(item.text)}</span><small>${esc(new Date(item.ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</small></button><button type="button" class="link-btn" aria-label="저장 취소">취소</button>`;
    li.querySelector('.saved-open').onclick = async () => {
      $('#savedDialog').close();
      if (jumpTo(item.id)) return;
      if (!guest) for (let n = 0; n < 15 && !jumpTo(item.id) && !$('#loadMore').hidden; n++) await loadOlder().catch(() => {});
      if (!jumpTo(item.id)) toast('이 메시지는 지금 불러온 대화 범위 밖에 있어요.');
    };
    li.querySelector('.link-btn').onclick = async () => { await playAct({ action: 'bookmark.toggle', id: item.id }).catch(() => {}); renderSaved(); };
    return li;
  }) : [Object.assign(document.createElement('li'), { className: 'saved-empty', textContent: '아직 저장한 명장면이 없어요. 메시지 아래 ☆ 저장을 눌러 보세요.' })]));
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
  const final = msgs.find((m) => m.phase === 'final' && m.from !== 'system');
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
  if (synth) {
    const selection = document.createElement('p');
    selection.className = 'ms-note';
    selection.textContent = `최종 답변 담당: ${nameOf(synth)} · ${end?.summary?.selectionReason || (running ? state.room.active.selectionReason : '') || msgs.findLast(m => m.kind === 'selection')?.selectionReason || ''}`;
    node.append(selection);
  } else if (running && state.room.active.phase === 'selection') {
    const selection = document.createElement('p');
    selection.textContent = '최종 답변 AI 선정 중'; node.append(selection);
  }
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
  // Unchanged ordinary messages reuse their nodes, so a long history is not rebuilt on every update.
  const epoch = JSON.stringify([state.participants?.map((p) => [p.id, p.name, p.icon]), state.room.userName, state.selfId, state.members?.map((m) => [m.id, m.color])]);
  const fresh = new Map();
  const nodes = items.map((x) => {
    if (x.msgs || x.from === 'system') return x.msgs ? runNode(x) : messageNode(x);
    const key = JSON.stringify([epoch, x, !!state.play?.bookmarks?.includes(x.id)]);
    const hit = nodeCache.get(x.id);
    const node = hit?.key === key ? hit.node : messageNode(x);
    fresh.set(x.id, { key, node });
    return node;
  });
  nodeCache = fresh;
  const firstUnread = unreadMark === null ? null : state.messages.find((m) => m.id > unreadMark && m.from !== 'system' && !isMine(m));
  const at = firstUnread ? nodes.findIndex((n) => n.dataset.id === String(firstUnread.id) || n.querySelector?.(`[data-id="${firstUnread.id}"]`)) : -1;
  if (at >= 0) nodes.splice(at, 0, unreadDivider());
  $('#msgs').replaceChildren(...nodes);
  if (chatHouse) renderLiveVotes();
  $('#empty').hidden = state.messages.some((m) => m.from !== 'system');
  renderedKey = messageKey();
}
const distance = () => tl.scrollHeight - tl.scrollTop - tl.clientHeight;
let nodeCache = new Map();
let unreadMark = null; // read position when this visit started; the divider and summary range start here
const isMine = (m) => m.from === 'user' && (guest ? m.guestId === state.selfId : !m.guestId);
const unreadCount = () => state.messages.filter((m) => m.id > (state.lastRead || 0) && m.from !== 'system' && !isMine(m)).length;
function unreadDivider() {
  const missed = state.messages.filter((m) => m.id > unreadMark && m.from !== 'system' && !isMine(m)).length;
  const div = document.createElement('div');
  div.className = 'unread-divider'; div.setAttribute('role', 'separator');
  div.innerHTML = `<span>여기부터 안 읽은 메시지 ${missed}개</span>${missed >= 3 ? '<button type="button" class="link-btn" data-summary>놓친 대화 요약</button>' : ''}`;
  div.querySelector('[data-summary]')?.addEventListener('click', openSummary);
  return div;
}
let readTimer = 0;
function maybeMarkRead() {
  if (!state || document.visibilityState !== 'visible' || distance() > 100) return;
  const last = state.messages.at(-1)?.id || 0;
  if (last <= (state.lastRead || 0)) return;
  clearTimeout(readTimer);
  readTimer = setTimeout(async () => {
    try { state.lastRead = (await api('/api/read', { id: last })).lastRead; } catch { /* retried on the next scroll */ }
    if (distance() < 100) $('#jump').hidden = true;
  }, 1200);
}
async function openSummary() {
  $('#summaryBody').innerHTML = `<p class="play-wait">AI가 놓친 대화를 요약하는 중…${guest ? ' (내 AI 호출 1회)' : ''}</p>`;
  $('#summaryDialog').showModal();
  try {
    const result = await api('/api/summary', { since: unreadMark ?? state.lastRead ?? 0 });
    $('#summaryBody').innerHTML = `<div class="text">${renderMarkdown(result.summary)}</div><small class="hint">${esc(nameOf(result.by))} · 메시지 ${result.count}개 요약 · 나에게만 보여요</small>`;
  } catch (e) { $('#summaryBody').innerHTML = `<p class="joint-vote-error">${esc(e.message)}</p>`; }
}
function showJump(text) { $('#jump').textContent = text; $('#jump').hidden = false; }
function refreshMessages(grew) {
  const stick = distance() < 100;
  renderMessages();
  if (stick) tl.scrollTop = tl.scrollHeight;
  else if (grew) showJump(unreadCount() ? `새 메시지 ${unreadCount()}개 ↓` : '새 메시지 ↓');
  maybeMarkRead();
}
function applyState(next) {
  const before = state?.messages.length || 0;
  state = next;
  if (guest) state.room = next.sharedRoom;
  const key = messageKey();
  if (key !== renderedKey) refreshMessages(state.messages.length > before);
  renderControls();
  if (guest) { renderFiles(); if (profileId) renderProfile(); return; }
  renderFiles();
  scheduleHealth();
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
  const stick = distance() < 100;
  renderDiscussionStage(state.room);
  if (stick) tl.scrollTop = tl.scrollHeight;
  const a = state.room.active?.mode === 'discussion' ? state.room.active : null;
  const box = $('#typing');
  box.classList.toggle('on', !!a);
  if (!a) { box.replaceChildren(); return; }
  const entries = Object.entries(a.states);
  const chips = entries.map(([id, s]) => `<span class="pg-ai ${stateClass(s)} ${s.phase === 'review' ? 'debating' : ''}" style="--c:${member(id).color}">${avatar(id)}<b>${esc(nameOf(id))}</b> ${s.status === '생성 중' ? wave('토론하는 중...') : esc(s.status)}${s.kind ? ` · ${esc(kindText(s.kind))}` : ''}${s.reason ? ` · ${esc(s.reason)}` : ''}${a.synthesizer === id ? ' <em>종합</em>' : ''}</span>`).join('');
  const reached = Math.max(0, ...entries.filter(([, s]) => !['대기', '제외'].includes(s.status)).map(([, s]) => STEPS.indexOf(s.phase)));
  const steps = STEPS.map((p, i) => `<li class="${i < reached ? 'done' : i === reached ? 'now' : ''}">${PHASES[p]}</li>`).join('');
  box.innerHTML = `${wave(`${a.startedBy || '방장'}가 토론을 열고 있어요…`)}<ol class="pg-steps">${steps}</ol><div class="pg-ais">${chips}</div>`;
}
// A provider error can pause automatic calls; an app-defined daily call cap is no longer used.
const restText = () => '오류로 자동 대화를 쉬고 있어요 · 연결 상태를 확인해 주세요';
function renderRoomSub() {
  const room = state.room;
  $('#roomSub').textContent = room.active?.mode === 'discussion' || (pending && room.discussion) ? '토론하는 중...'
    : room.auto.on ? (room.autoSleeping ? '잠들어 있어요 · 말 걸면 깨어나요' : room.autoRest ? restText(room) : room.autoRunning ? '켜져 있음 · 대화 중' : '켜져 있음') : '꺼져 있음';
}
// Models in use: the discussion group has its own, everything else uses the normal chat models.
const bag = () => (state.room.discussion ? state.room.debateModels : state.room.models);
const bagKey = () => (state.room.discussion ? 'debateModels' : 'models');
// "Several AIs answer" = discussion, or the default all-AI chat.
// Remaining limit of one AI: the tightest of its windows, from the CLI's own usage report.
const WINDOW_LABEL = { '5h': '5시간', week: '주간', friend: '내 AI' };
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
  if (guest) {
    $('#sheetBody').innerHTML = `<div class="profile" style="--c:${m.color}"><img class="p-av" src="/avatars/${id}-pixel-128.png" alt=""><div class="p-name" id="sheetName">${esc(m.name)} <small>${esc(m.maker)}</small></div><div class="p-status">${esc(m.busy ? '입력·작업 중' : m.available && m.enabled ? '참여 중' : '쉬는 중')}</div></div>`;
    return;
  }
  const model = bag()[id];
  const st = statusOf(id, model.model, true);
  const u = state.usage?.[id];
  const ws = limitWindows(id, u);
  const bio = state.room.bios[id];
  const recent = state.activity?.recent?.[id] || [];
  const proGpt = id === 'gpt' && /^pro/i.test(u?.plan || '');
  $('#sheetBody').innerHTML = `<div class="profile" style="--c:${m.color}">
    <img class="p-av" src="/avatars/${id}-pixel-128.png" alt="">
    <div class="p-name" id="sheetName">${esc(m.name)} <small>${esc(m.maker)}</small></div>
    <div class="p-status">${dot(st)}<code>${esc(settingText(model))}</code></div>
    ${m.activity ? `<div class="p-doing">현재: ${esc(m.activity.text)}</div>` : ''}
    <div class="p-bio ${bio ? '' : 'empty'}">${bio ? `“${esc(bio)}”` : '아직 한 줄 소개가 없어'}</div>
    <div class="p-recent"><div class="p-sec">최근 활동</div>
      ${recent.length ? `<ul>${recent.map((e) => `<li><time>${esc(new Date(e.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</time> ${esc(e.text)}</li>`).join('')}</ul>` : '<small>아직 기록된 활동이 없어요</small>'}
      <small class="p-plan">앱이 남긴 활동 기록이에요. AI가 기억하는 내용은 아니에요.</small></div>
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
const removingGuests = new Set();
function renderHumans() {
  const people = state.participants || [];
  if (guest) {
    const owner = people.find(p => p.id === 'owner');
    $('#meName').textContent = owner?.name || '방장';
    $('#meAv').textContent = [...(owner?.name || '방장')][0];
    $('.me-row .m-status').textContent = '방장';
    $('.me-row .m-tag').hidden = true;
  }
  $('#humanMembers').replaceChildren(...people.filter(p => p.id !== 'owner').map(p => {
    const li = document.createElement('li');
    li.className = 'member human-member';
    li.style.setProperty('--c', friendColor(p.id));
    li.innerHTML = `<div class="me-av friend">${esc(p.icon || [...p.name][0] || '?')}</div>
      <div class="m-info"><div class="m-name"><span>${esc(p.name)}</span></div>
      <div class="m-status">친구${guest && p.id === state.selfId ? ' · 나' : ''} · ${p.online ? p.away ? '자리 비움' : '접속 중' : '오프라인'}</div></div>`;
    if (guest && p.id === state.selfId) {
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-btn human-kick'; edit.textContent = '✎';
      edit.title = '내 프로필 바꾸기'; edit.setAttribute('aria-label', edit.title); edit.onclick = openProfileEditor; li.append(edit);
    }
    if (!guest) {
      const kick = document.createElement('button');
      kick.type = 'button'; kick.className = 'icon-btn human-kick';
      kick.title = `${p.name} 내보내기`; kick.setAttribute('aria-label', kick.title);
      kick.disabled = removingGuests.has(p.id);
      kick.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H4v16h6m4-12 4 4-4 4m-6-4h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      kick.onclick = async () => {
        if (removingGuests.has(p.id)) return;
        removingGuests.add(p.id); kick.disabled = true;
        try { await api('/api/share/revoke-guest', { id: p.id }); applyState(await api('/api/state')); }
        catch (e) { toast(e.message); }
        finally { removingGuests.delete(p.id); renderHumans(); }
      };
      li.append(kick);
    }
    return li;
  }));
}
function renderControls() {
  $('#notifyBtn').setAttribute('aria-pressed', String((state.push?.subscribed || 0) > 0));
  $('#notifyBtn').classList.toggle('on', (state.push?.subscribed || 0) > 0);
  if (guest) { renderGuestControls(); return; }
  const room = state.room;
  const busy = !!room.active || pending;
  $('#members').replaceChildren(...state.members.map((m) => {
    const li = document.createElement('li');
    const ready = m.available;
    li.className = `member ${!ready ? 'st-missing' : !room.enabled[m.id] ? 'st-off' : ''}`;
    li.style.setProperty('--c', m.color);
    const settings = bag()[m.id];
    const live = room.active?.mode === 'discussion' ? room.active.states[m.id] : null;
    // What the member is doing comes from the server's own facts; otherwise the connection status.
    const doing = ['work', 'world'].includes(m.activity?.kind) ? `<span class="m-doing">${esc(m.activity.text)}</span>` : '';
    li.innerHTML = `<div class="av-wrap" data-profile="${m.id}" role="button" tabindex="0" aria-label="${esc(m.name)} 프로필 보기"><img class="av" src="/avatars/${m.id}-pixel-128.png" alt=""><span class="st-dot"></span></div>
      <div class="m-info"><div class="m-name"><span class="n">${esc(m.name)}</span><span class="m-maker">${esc(m.maker)}</span></div>
      <div class="m-status">${live && live.status !== '대기' ? (live.status === '생성 중' ? wave('토론하는 중...') : esc(live.status)) : doing || dot(statusOf(m.id, settings.model, true))}</div>
      <div class="member-model">${room.discussion ? '토론 · ' : ''}${esc(settingText(settings))}</div>${limitHTML(m.id)}</div>
      <label class="switch" title="대화 참여"><input type="checkbox" aria-label="${esc(m.name)} 대화 참여" ${room.enabled[m.id] && ready ? 'checked' : ''}><span></span></label>`;
    // The member row only toggles participation; targeted chat belongs to the bottom switch.
    li.addEventListener('click', (e) => {
      if (!e.target.closest('.switch, [data-profile], button')) ready ? update({ enabled: { [m.id]: !room.enabled[m.id] } }) : openSetup();
    });
    li.querySelector('input').addEventListener('change', (e) => {
      if (!ready) { e.target.checked = false; openSetup(); return; }
      update({ enabled: { [m.id]: e.target.checked } });
    });
    return li;
  }));
  // Everyone in the room: me plus each AI that is on and connected.
  const here = (state.participants || [{ online: true }]).filter(p => p.online).length + IDS.filter((id) => room.enabled[id] && state.catalog[id].available).length;
  $('#memberCount').textContent = String(here);
  $('#headCount').textContent = String(here);
  $('#headCount').setAttribute('aria-label', `참여자 ${here}명`);
  $('#meName').textContent = room.userName || '방장';
  $('#meAv').textContent = [...(room.userName || '방장')][0];
  renderHumans();
  document.title = room.name || 'AI 단톡방';
  $('#webSearch').checked = room.webSearch;
  $('#webSearchField').classList.toggle('on', room.webSearch);
  $('#webHint').hidden = !room.webSearch; // the note about search support only matters once it is on
  $('#input').placeholder = room.discussion ? '조사할 내용 또는 복잡한 추론을 물어보세요' : '채팅을 입력하세요.';
  renderRoomSub();
  $('#headTitle').textContent = room.name || 'AI 단톡방';
  $('#roomName').textContent = room.name || 'AI 단톡방';
  const sel = room.selected;
  const pill = $('#modelPicker');
  if (room.discussion) {
    const joined = IDS.filter((id) => room.enabled[id] && state.catalog[id].available);
    pill.style.setProperty('--c', 'var(--accent)');
    pill.innerHTML = `<span class="pk-stack">${joined.map((id) => avatar(id)).join('')}</span><span class="pk-name">토론</span><span class="pk-model">${joined.length}명 · 종합 자동 선정</span><span class="caret">⌄</span>`;
  } else {
    const joined = IDS.filter((id) => room.enabled[id] && state.catalog[id].available);
    pill.style.setProperty('--c', 'var(--accent)');
    pill.innerHTML = `<span class="pk-stack">${joined.map((id) => avatar(id)).join('')}</span><span class="pk-name">${joined.length}명 참가 중</span><span class="caret">⌄</span>`;
  }
  $('#debateToggle').checked = room.discussion;
  $('#debateToggle').disabled = !!room.active;
  $('#debateSwitch').classList.toggle('disabled', !!room.active);
  $('#debateSwitch').setAttribute('aria-disabled', String(!!room.active));
  $('#debateSwitch').classList.toggle('on', room.discussion);
  schedulePreview();
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
function renderGuestControls() {
  const room = state.room;
  $('#chatFrequencyField').hidden = true; $('#chatFrequencyHint').hidden = true;
  $('#members').innerHTML = state.members.map(m => `<li class="member ${m.busy ? 'st-typing' : !m.available || !m.enabled ? 'st-off' : ''}" style="--c:${m.color}">
    <div class="av-wrap" data-profile="${m.id}" role="button" tabindex="0" aria-label="${esc(m.name)} 프로필 보기"><img class="av" src="/avatars/${m.id}-pixel-128.png" alt=""><span class="st-dot"></span></div>
    <div class="m-info"><div class="m-name"><span class="n">${esc(m.name)}</span><span class="m-maker">${esc(m.maker)}</span></div><div class="m-status">${esc(m.busy ? '입력·작업 중' : m.available && m.enabled ? '참여 중' : '쉬는 중')}</div></div>
    <label class="switch" title="참여 상태 · 방장 관리"><input type="checkbox" disabled ${m.available && m.enabled ? 'checked' : ''}><span></span></label></li>`).join('');
  renderHumans();
  const here = (state.participants || []).filter(p => p.online).length + state.members.filter(m => m.available && m.enabled).length;
  $('#memberCount').textContent = $('#headCount').textContent = String(here);
  $('#headTitle').textContent = $('#roomName').textContent = document.title = room.name;
  $('#roomSub').textContent = (state.participants || []).map(p => `${p.online ? '●' : '○'} ${p.name}`).join(' · ');
  $('#chatterBtn').classList.toggle('on', room.auto.on); $('#chatterBtn').disabled = true;
  $('#chatterBtn').setAttribute('aria-pressed', String(room.auto.on));
  $('#chatterText').textContent = room.auto.on ? 'Talk on' : 'Talk off';
  $('#app').classList.toggle('running', room.auto.on);
  $('#powerBtn').disabled = true; $('#powerBtn').setAttribute('aria-pressed', String(room.auto.on));
  $('#powerText').textContent = room.auto.on ? '켜져 있음 · 방장 관리' : '꺼져 있음 · 방장 관리';
  $('#boostSeg').querySelectorAll('button').forEach(b => { b.disabled = true; b.classList.toggle('on', b.dataset.boost === room.boostMode); });
  $('#boostHint').textContent = '방장의 진심모드 설정을 그대로 사용합니다.';
  $('#modelPicker').disabled = true; $('#modelPicker').textContent = 'AI 자동 참여 · @이름으로 부르기';
  const debateMembers = state.members.filter(m => m.available && m.enabled).length;
  const debateCalls = debateMembers * 2 + 1;
  if (room.active || state.permissions?.discussion === false) guestDiscussion = false;
  if (room.active || state.permissions?.questions === false) guestWebSearch = false;
  $('#debateToggle').disabled = !!room.active || debateMembers < 2 || state.usage.remaining < debateCalls || state.permissions?.discussion === false;
  $('#debateSwitch').classList.toggle('disabled', $('#debateToggle').disabled);
  $('#debateSwitch').setAttribute('aria-disabled', String($('#debateToggle').disabled));
  $('#debateToggle').checked = guestDiscussion;
  $('#debateSwitch').classList.toggle('on', guestDiscussion);
  $('#debateSwitch').title = room.active ? '토론 진행 중 · 사람끼리 채팅은 가능' : `토론 시 최대 ${debateCalls}회 호출 · 실제 호출만 차감`;
  let cost = $('#guestDebateCost');
  if (!cost) { cost = document.createElement('small'); cost.id = 'guestDebateCost'; cost.className = 'm-maker'; $('#debateSwitch').after(cost); }
  cost.hidden = !guestDiscussion;
  cost.textContent = `최대 ${debateCalls}회 · ${state.usage.guestLimit ? Math.ceil(debateCalls / state.usage.guestLimit * 100) : 100}%`;
  $('#webSearchField').hidden = false;
  $('#webSearch').checked = guestWebSearch;
  $('#webSearch').disabled = state.permissions?.questions === false || !!room.active;
  $('#webSearchField').classList.toggle('on', guestWebSearch);
  $('#webHint').hidden = !guestWebSearch;
  const remaining = Math.max(0, state.usage.remaining);
  const allowance = Math.max(0, state.usage.guestLimit);
  const percent = allowance ? Math.min(100, remaining / allowance * 100) : 0;
  renderIntensity();
  const hint = $('#recipientHint');
  const status = { responding: 'AI가 답하는 중', queued: 'AI가 곧 읽어요', paused: 'Talk off · 사람끼리 대화 중', limited: 'AI 한도 소진 · 사람끼리 대화는 계속돼요', ready: '' }[state.autoReply] || '';
  hint.innerHTML = batteryHTML({ id: 'friend', remainingPct: percent }, false)
    + `<span class="friend-quota ${remaining ? '' : 'warn'}">내 AI ${remaining}/${allowance}회${status ? ` · ${esc(status)}` : ''}</span>`;
  const gauge = hint.querySelector('.batt');
  gauge.title = `내 AI 잔여 ${remaining}/${allowance}회 · 공용 ${state.usage.total}/${state.usage.limit}회 · 한도 소진 후에도 사람끼리 대화할 수 있어요.`;
  gauge.setAttribute('role', 'meter'); gauge.setAttribute('aria-label', '내 AI 남은 한도');
  gauge.setAttribute('aria-valuemin', '0'); gauge.setAttribute('aria-valuemax', String(allowance || 1));
  gauge.setAttribute('aria-valuenow', String(remaining)); gauge.setAttribute('aria-valuetext', `잔여 ${remaining}회, 배정 ${allowance}회`);
  $('#typing').classList.toggle('on', !!room.active);
  $('#typing').innerHTML = room.active ? wave(`${room.active.startedBy || '방장'}가 토론을 열고 있어요…`) : esc(state.members.filter(m => m.busy).map(m => `${m.name} 입력·작업 중…`).join(' · '));
  $('#send').disabled = pending || !!room.active && guestDiscussion || state.permissions?.chat === false;
  $('#loadMore').hidden = true;
  $('#stop').hidden = true;
}
const BOOST_HINTS = {
  auto: '복잡한 요청이면 더 강한 모델로 답해요 · 사용량이 더 들 수 있어요',
  manual: '진지하게 답해 달라고 하거나 /boost @멤버로 부를 때만 켜요',
  off: '항상 평소 모델 설정으로 답해요',
};
function renderIntensity() {
  const value = state.room.aiIntensity || 'normal';
  $('#aiIntensitySeg').querySelectorAll('[data-intensity]').forEach(button => {
    const on = button.dataset.intensity === value;
    button.classList.toggle('on', on); button.setAttribute('aria-pressed', String(on)); button.disabled = guest;
  });
  $('#aiIntensityHint').textContent = INTENSITY_HINTS[value] + (guest ? ' · 방장만 바꿀 수 있어요.' : '');
}
function renderAuto() {
  renderIntensity();
  $('#chatFrequencySeg').querySelectorAll('[data-frequency]').forEach(button => {
    const on = button.dataset.frequency === state.room.chatFrequency;
    button.classList.toggle('on', on); button.setAttribute('aria-pressed', String(on));
  });
  const a = state.room.auto;
  $('#autoSleep').value = String(a.sleepMinutes);
  $('#boostSeg').querySelectorAll('button').forEach((b) => {
    const on = b.dataset.boost === state.room.boostMode;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
  $('#boostHint').textContent = BOOST_HINTS[state.room.boostMode];
  // Only a problem is worth a line here; the rest is explained by the tour and under "자세히".
  const note = !a.on ? '' : state.room.autoSleeping ? '잠들어 있어요. 말 걸면 다시 깨어나요.' : state.room.autoRest ? `${restText(state.room)}.` : !state.room.autoReady ? '대화할 수 있는 AI가 없어 기다리고 있어요.' : '';
  $('#autoNote').textContent = note;
  $('#autoNote').hidden = !note;
}
// Technical facts (connection steps, raw errors, real call counts) are shown only here.
let memoBoxOpen = false;
const memoOpen = new Set();
function renderDetails() {
  if (guest) return;
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
  $('#detailsBody').innerHTML = `${ai}<div class="d-ai"><b>사용 기록</b>
    <div>일반 대화 AI 호출 ${u.calls}번</div><div>토론에 쓴 AI 호출 ${u.asked}번</div>
    <small>일반 대화 안에서 건축과 파일·게임 제작을 함께 해요. 별도 건축 차례나 정해진 게임 제작 순서는 없어요. 호출 실패는 20초부터 최대 5분까지 기다려요.</small>
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
    ${memoRows}
    <small>AI가 대화하면서 말투, 호칭, 다른 멤버와의 관계를 스스로 적어 두는 짧은 메모예요. 이 PC에만 저장돼요.</small></details>`);
  $('#memoBox').addEventListener('toggle', (e) => { memoBoxOpen = e.target.open; });
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
  if (!state.files.length) { $('#wsFiles').textContent = guest ? '입장 이후 채팅에 공유된 AI 사진·창작물이 여기에 표시됩니다.' : '함께 만든 게임과 사진·그림이 여기에 표시됩니다.'; return; }
  for (const f of state.files) {
    const game = f.activity === 'game' || /\.html?$/i.test(f.path);
    const drawing = f.activity === 'postcard' || /\.svg$/i.test(f.path);
    const kind = game ? '게임' : drawing ? '그림' : f.image ? '사진' : '파일';
    const title = f.title || (kind === '파일' ? f.path.split('/').at(-1) : kind);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'file-entry';
    b.title = f.path;
    const preview = document.createElement('span');
    preview.className = 'file-preview';
    if (f.image && !game) {
      const img = document.createElement('img');
      img.src = mediaURL(f.path);
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      preview.append(img);
    } else preview.textContent = game ? '🎮' : '📄';
    preview.setAttribute('aria-hidden', 'true');
    const info = document.createElement('span');
    info.className = 'file-info';
    const heading = document.createElement('strong');
    heading.className = 'file-title';
    heading.textContent = title;
    const action = document.createElement('span');
    action.className = 'file-action';
    action.textContent = `${kind} 열기`;
    info.append(heading, action);
    b.append(preview, info);
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
    const data = await api(guest ? `/api/gallery/file?path=${encodeURIComponent(path)}&info=1` : `/api/file?path=${encodeURIComponent(path)}`);
    $('#wsFiles').dataset.openPath = path;
    const back = document.createElement('button');
    back.className = 'model-pill'; back.textContent = '← 파일 목록';
    back.onclick = () => { delete $('#wsFiles').dataset.openPath; renderFiles(); };
    const picture = data.image || data.activity === 'postcard' || /\.svg$/i.test(path);
    const title = state.files.find((f) => f.path === path)?.title;
    const content = document.createElement(data.activity === 'game' ? 'iframe' : picture ? 'img' : 'pre');
    if (data.activity === 'game') {
      content.setAttribute('sandbox', 'allow-scripts');
      content.title = title || '게임';
      content.style.cssText = 'width:100%;height:390px;border:0';
      content.src = mediaURL(path);
    } else if (picture) {
      content.src = mediaURL(path);
      content.style.maxWidth = '100%'; content.alt = title || (data.image ? '사진' : '그림');
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
  {
    main.innerHTML = `<div class="mm-title">${room.discussion ? '토론 참여' : '답하는 AI'}</div>
      ${IDS.map((id) => `<div class="mm-ai ${room.enabled[id] ? '' : 'off'}" style="--c:${member(id).color}">
        <label class="switch"><input type="checkbox" data-join="${id}" ${room.enabled[id] && state.catalog[id].connected ? 'checked' : ''} aria-label="${esc(nameOf(id))} 대화 참여"><span></span></label>
        ${menuRow(`ai:${id}`, `${avatar(id)}<b>${esc(nameOf(id))}</b>`, esc(state.catalog[id].available ? shortSetting(id, bag()[id]) : '연결 설정 필요'))}</div>`).join('')}
      ${room.discussion ? '<p class="ms-note">최종 답변 담당은 참여 AI들의 상호 평가로 자동 선정합니다.</p>' : ''}`;
  }
  main.insertAdjacentHTML('beforeend', '<div class="mm-foot"><button type="button" class="link-btn" data-act="setup">연결 확인 · 처음 설정</button></div>');
  main.querySelectorAll('[data-sub]').forEach((b) => b.addEventListener('click', () => {
    menu.sub = menu.sub === b.dataset.sub ? null : b.dataset.sub;
    menu.q = ''; menu.adding = false;
    renderMenu();
  }));
  main.querySelectorAll('[data-join]').forEach((el) => el.addEventListener('change', () => {
    if (!state.catalog[el.dataset.join].connected) { el.checked = false; openSetup(); return; }
    update({ enabled: { [el.dataset.join]: el.checked } });
  }));
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
  if (check.login?.status === 'fail') return { key: 'login', text: '로그인이 필요해요' };
  if (state.catalog[id].connected) return { key: 'ok', text: '연결됐어요' };
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
        <li>방을 켜면 각 AI가 <b>스스로 답하거나 넘어가요.</b> 대표 답변자는 정하지 않아요.</li>
        <li><code>@Claude</code>처럼 이름을 쓰면 그 AI가 먼저 읽어요. 다른 AI도 반응할 수 있어요.</li>
        <li><b>Talk on</b>은 일반 대화 전체의 켜기·끄기예요. 토론은 별도 스위치로 요청해요.</li>
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
  if (pending || state.room.active && (!guest || guestDiscussion) || (!input.value.trim() && !image)) return;
  pending = true; renderControls();
  try {
    await api('/api/send', { text: input.value.trim(), image, replyTo, ...(guest ? { discussion: guestDiscussion, webSearch: guestWebSearch } : {}) });
    if (guest) guestDiscussion = false;
    replyTo = null; replyChip.hidden = true; unreadMark = null;
    input.value = ''; autosize(); clearImage();
    applyState(await api('/api/state'));
    tl.scrollTop = tl.scrollHeight;
  } catch (e) { toast(e.message); }
  finally { pending = false; renderControls(); }
}
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; }
replyChip.onclick = () => { replyTo = null; replyChip.hidden = true; };
function clearImage() { image = null; $('#attachChip').hidden = true; $('#fileInput').value = ''; }
async function attach(file) {
  if (guest) return;
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
// Reuse the workbench's original dot pets and staggered wave on the empty chat screen.
$('#emptyCharacters').innerHTML = dotCharacters.map((rows, i) => `<div class="empty-character" style="--index:${i}">${dotCharacter(i)}</div>`).join('');
import { drawDotTitle } from './dot-title.mjs';
drawDotTitle($('#emptyDotTitle'));
$('#examples').replaceChildren(...EXAMPLES.map((x) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'example';
  b.innerHTML = `<span class="tag">${esc(x.tag)}</span>${esc(x.text)}`;
  b.addEventListener('click', () => { input.value = x.text; autosize(); input.focus(); });
  return b;
}));
$('#modelPicker').onclick = () => (menu ? closeMenu() : openMenu());
function pollInput(n) { const field = document.createElement('input'); field.maxLength = 40; field.required = n <= 2; field.placeholder = `선택지 ${n}`; field.setAttribute('aria-label', field.placeholder); return field; }
$('#pollBtn').onclick = () => { $('#pollForm').reset(); $('#pollOptions').replaceChildren(...[1, 2].map(pollInput)); $('#pollAdd').hidden = false; $('#pollDialog').showModal(); $('#pollQuestion').focus(); };
$('#pollAdd').onclick = () => { const count = $('#pollOptions').children.length; if (count < 4) $('#pollOptions').append(pollInput(count + 1)); $('#pollAdd').hidden = count + 1 >= 4; };
$('#pollForm').addEventListener('submit', async (event) => {
  if (event.submitter?.value !== 'ok') return;
  event.preventDefault(); $('#pollDialog').close();
  const options = [...$('#pollOptions').querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
  await playAct({ action: 'poll.create', question: $('#pollQuestion').value.trim(), options, minutes: Number($('#pollMinutes').value) }).catch(() => {});
  tl.scrollTop = tl.scrollHeight;
});
$('#gameBtn').onclick = () => {
  if (state.play?.games.some((g) => g.status === 'open' || g.status === 'preparing')) { toast('이미 진행 중인 게임이 있어요. 채팅창의 게임 카드에서 참여하세요.'); return; }
  if (guest && !state.permissions?.games) { toast('방장이 미니게임 시작을 허용하면 시작할 수 있어요. 진행 중인 게임에는 언제든 참여할 수 있어요.'); return; }
  $('#gameHint').textContent = guest ? '게임 시작 때 AI가 문제를 한 번 만들어요 (내 AI 호출 1회). 한도가 없으면 기본 문제로 진행해요.' : '게임 시작 때 AI가 문제를 한 번만 만들어요 (호출 1회). 선택·채점에는 AI를 쓰지 않아요.';
  $('#gameDialog').showModal();
};
$('#gameDialog').addEventListener('submit', async (event) => {
  const kind = event.submitter?.value;
  event.preventDefault(); $('#gameDialog').close();
  if (!['balance', 'quiz'].includes(kind)) return;
  await playAct({ action: 'game.start', kind, topic: $('#gameTopic').value.trim() }).catch(() => {});
  $('#gameTopic').value = ''; tl.scrollTop = tl.scrollHeight;
});
$('#savedBtn').onclick = () => { renderSaved(); $('#savedDialog').showModal(); };
const PROFILE_ICONS = ['🐱', '🐶', '🐰', '🦊', '🐻', '🐼', '🐸', '🐧', '🐯', '🐨', '🐹', '🦄'];
let profileIcon = null;
function openProfileEditor() {
  const me = friendOf(state.selfId);
  $('#profileName').value = me?.name || state.name || '';
  profileIcon = me?.icon || null;
  const draw = () => $('#profileIcons').replaceChildren(...[null, ...PROFILE_ICONS].map((icon) => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(icon === profileIcon)); b.textContent = icon || [...($('#profileName').value || '?')][0];
    b.title = icon ? '이 아이콘 쓰기' : '이름 첫 글자'; b.onclick = () => { profileIcon = icon; draw(); };
    return b;
  }));
  draw();
  $('#profileDialog').showModal();
}
$('#profileForm').addEventListener('submit', async (event) => {
  if (event.submitter?.value !== 'ok') return;
  event.preventDefault();
  try { await api('/api/profile', { name: $('#profileName').value.trim(), icon: profileIcon }); $('#profileDialog').close(); applyState(await api('/api/state')); toast('프로필을 바꿨어요.'); }
  catch (e) { toast(e.message); }
});
const pushReady = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && isSecureContext;
const keyBytes = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (c) => c.charCodeAt(0));
const workerReady = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('서비스 워커가 준비되지 않았어요. 페이지를 새로고침해 주세요.')), 8000))]);
async function currentSubscription() { try { return await (await workerReady()).pushManager.getSubscription(); } catch { return null; } }
async function openNotify() {
  const body = $('#notifyBody'), acts = $('#notifyActions');
  const ios = /iPhone|iPad/i.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  acts.innerHTML = '<button value="cancel">닫기</button>';
  const note = '<p class="hint">방장 PC와 단톡방 서버가 켜져 있을 때만 알림이 와요. 알림에는 메시지 내용 없이 보낸 사람만 표시돼요.</p>';
  if (!pushReady()) {
    body.innerHTML = `<p>이 브라우저에서는 푸시 알림을 쓸 수 없어요.</p><p class="hint">${ios && !standalone ? 'iPhone·iPad는 Safari 공유 메뉴에서 “홈 화면에 추가”로 앱을 설치한 뒤(iOS 16.4 이상) 설치된 앱에서 켤 수 있어요.' : !isSecureContext ? 'HTTPS 주소(Tailscale 연결 주소)로 접속해야 알림을 켤 수 있어요.' : '카카오톡 등 앱 안의 브라우저는 알림을 지원하지 않아요. Chrome·Edge·Firefox·Safari에서 열어 주세요.'}</p>${note}`;
  } else if (Notification.permission === 'denied') {
    body.innerHTML = `<p>이 사이트의 알림이 브라우저에서 차단되어 있어요.</p><p class="hint">주소창의 사이트 설정에서 알림을 허용한 뒤 다시 눌러 주세요.</p>${note}`;
  } else {
    const sub = await currentSubscription();
    const on = !!sub && (state.push?.subscribed || 0) > 0;
    body.innerHTML = `<p>${on ? '이 기기에서 알림이 켜져 있어요.' : '새 사람 메시지와 나를 부른 메시지(@이름)를 알려 드려요.'}</p>
      <label class="notify-opt"><input type="checkbox" id="notifyPeople" checked> 사람들의 새 메시지 (30초에 한 번까지)</label>
      <label class="notify-opt"><input type="checkbox" id="notifyAI"> AI 자율 대화도 알림 (기본 꺼짐)</label>
      <p class="hint">나를 부른 메시지는 항상 알려요.</p>${note}`;
    acts.innerHTML = `<button value="cancel">닫기</button>${on ? '<button type="button" id="notifyOff">알림 끄기</button>' : ''}<button type="button" class="primary" id="notifyOn">${on ? '설정 저장' : '알림 켜기'}</button>`;
    $('#notifyOn').onclick = async () => {
      try {
        if (await Notification.requestPermission() !== 'granted') { toast('알림 권한이 허용되지 않았어요.'); return; }
        const registration = await workerReady();
        let subscription = await registration.pushManager.getSubscription();
        const key = keyBytes(state.push.publicKey);
        const stale = subscription?.options?.applicationServerKey && new Uint8Array(subscription.options.applicationServerKey).join() !== key.join();
        if (stale) { await subscription.unsubscribe(); subscription = null; }
        subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        await api('/api/push/subscribe', { subscription: subscription.toJSON(), prefs: { people: $('#notifyPeople').checked, ai: $('#notifyAI').checked } });
        $('#notifyDialog').close(); applyState(await api('/api/state')); toast('알림을 켰어요.');
      } catch (e) { toast(`알림을 켜지 못했어요: ${e.message}`); }
    };
    $('#notifyOff')?.addEventListener('click', async () => {
      try { await api('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); $('#notifyDialog').close(); applyState(await api('/api/state')); toast('이 기기의 알림을 껐어요.'); }
      catch (e) { toast(e.message); }
    });
  }
  if (!$('#notifyDialog').open) $('#notifyDialog').showModal();
}
$('#notifyBtn').onclick = () => openNotify().catch((e) => toast(e.message));
// Phones: keep the composer above the on-screen keyboard (iOS ignores interactive-widget).
if (window.visualViewport) {
  const fit = () => document.documentElement.style.setProperty('--app-h', `${Math.round(visualViewport.height)}px`);
  visualViewport.addEventListener('resize', fit); fit();
  input.addEventListener('focus', () => setTimeout(() => { if (distance() < 160) tl.scrollTop = tl.scrollHeight; }, 300));
}
$('#debateToggle').onchange = (e) => { if (guest) { guestDiscussion = e.target.checked; renderControls(); } else update({ discussion: e.target.checked }); };

// ---------- who will answer: a small preview under the input, from the server's local rules (no AI call) ----------
let previewTimer = null;
let previewSeq = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 150);
}
async function refreshPreview() {
  if (guest) return;
  const seq = ++previewSeq;
  const hint = $('#recipientHint');
  try {
    const r = await api(`/api/preview?text=${encodeURIComponent(input.value.slice(0, 2000))}`);
    if (seq !== previewSeq) return;
    const names = r.ids.map((id) => nameOf(id)).join(' · ');
    const out = r.excluded.length && r.kind !== 'all' ? ` (${r.excluded.map((e) => `${nameOf(e.id)} ${e.reason}`).join(', ')})` : '';
    let text;
    if (r.needTwo) text = '토론하려면 AI를 2명 이상 불러주세요';
    else if (!r.ids.length) text = '답할 수 있는 AI가 없어요';
    else if (r.kind === 'discussion') text = `${names}가 토론${out}`;
    else if (r.kind === 'room') text = state.room.auto.on ? '각 AI가 자율적으로 답해요 · @이름은 우선 호출' : '방이 꺼져 있어요 · 켜기를 눌러 대화를 시작하세요';
    else if (r.ids.length === 1) text = `${names}에게 질문${out}`;
    else text = `${names}가 답변${out}`;
    hint.textContent = text; hint.classList.toggle('warn', !!r.needTwo || !r.ids.length);
  } catch { /* the preview is only a hint */ }
}

// ---------- "@" picker: choose one AI to address, right above the input ----------
const ALIAS_HINT = { claude: ['claude', '클로드'], gpt: ['chatgpt', 'gpt', '챗지피티', '지피티'], gemini: ['gemini', '제미나이', '제미니'] };
let mention = null; // { from, to, items, i }
function closeMention() { mention = null; $('#mentionPop').hidden = true; }
function updateMention() {
  const caret = input.selectionStart;
  const m = /(?:^|[\s(])@([A-Za-z가-힣]*)$/.exec(input.value.slice(0, caret));
  if (!m) { closeMention(); return; }
  const q = m[1].toLowerCase();
  const people = (state.participants || []).filter(p => p.id !== (guest ? state.selfId : 'owner') && (!q || p.name.toLowerCase().startsWith(q))).map(p => `human:${p.id}`);
  const items = [...IDS.slice().reverse().filter((id) => member(id)?.enabled !== false && (!q || ALIAS_HINT[id].some((a) => a.startsWith(q)) || nameOf(id).toLowerCase().startsWith(q))),
    ...(!q || '모두'.startsWith(q) || 'all'.startsWith(q) ? ['all'] : []), ...people].slice(0, 8);
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
    if (id === 'all') b.innerHTML = '<b>모두</b><small>켜진 AI 전체</small>';
    else if (id.startsWith('human:')) { const p = state.participants.find(x => x.id === id.slice(6)); b.innerHTML = `<b>${esc(p?.name || '')}</b><small>${p?.id === 'owner' ? '방장' : '친구'} · ${p?.online ? '접속 중' : '오프라인'}</small>`; }
    else b.innerHTML = `${avatar(id)}<b>${esc(nameOf(id))}</b><small>${esc(guest ? (member(id)?.enabled ? '참여 중' : '쉬는 중') : statusOf(id, bag()[id].model).text)}</small>`;
    b.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(id); });
    return b;
  }));
}
function pickMention(id) {
  const at = `@${id === 'all' ? '모두' : id.startsWith('human:') ? state.participants.find(p => p.id === id.slice(6))?.name || '' : nameOf(id)} `;
  input.value = input.value.slice(0, mention.from) + at + input.value.slice(mention.to);
  const pos = mention.from + at.length;
  input.setSelectionRange(pos, pos);
  closeMention(); autosize(); input.focus(); schedulePreview();
}
input.addEventListener('input', schedulePreview);
input.addEventListener('input', updateMention);
input.addEventListener('click', updateMention);
input.addEventListener('blur', closeMention);
document.addEventListener('mousedown', (e) => {
  if (menu && !e.target.closest('#modelPop, #modelPicker')) closeMenu();
});
$('#webSearch').onchange = (e) => { if (guest) { guestWebSearch = e.target.checked; renderControls(); } else update({ webSearch: e.target.checked }); };
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
$('#boostSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-boost]');
  if (b) update({ boostMode: b.dataset.boost });
});
$('#aiIntensitySeg').addEventListener('click', event => {
  const button = event.target.closest('[data-intensity]');
  if (button && !guest) update({ aiIntensity: button.dataset.intensity });
});
$('#chatFrequencySeg').addEventListener('click', event => {
  const button = event.target.closest('[data-frequency]');
  if (button && !guest) update({ chatFrequency: button.dataset.frequency });
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
  if (far < 100) { $('#jump').hidden = true; maybeMarkRead(); }
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
async function loadOlder() {
  const height = tl.scrollHeight;
  const older = await api(`/api/history?before=${state.messages[0]?.id || ''}`);
  const known = new Set(state.messages.map((m) => m.id));
  state.messages = [...older.messages.filter((m) => !known.has(m.id)), ...state.messages];
  renderMessages();
  tl.scrollTop += tl.scrollHeight - height;
  $('#loadMore').hidden = older.messages.length < 200;
}
$('#loadMore').onclick = () => loadOlder().catch((e) => toast(e.message));
let connFails = 0;
function showConn(text, rejoin = false) {
  const banner = $('#connBanner');
  banner.textContent = text; banner.hidden = false;
  if (rejoin && guest) { const link = document.createElement('a'); link.href = '/join'; link.textContent = ' 다시 입장하기'; banner.append(link); }
}
function connect() {
  const events = new EventSource('/events');
  events.addEventListener('house', () => window.dispatchEvent(new Event('house-update')));
  events.addEventListener('state', (e) => applyState(JSON.parse(e.data)));
  events.addEventListener('open', () => { api('/api/share/presence', { away: document.hidden }).catch(() => {}); });
  events.addEventListener('open', () => {
    connFails = 0;
    if (!$('#connBanner').hidden) { $('#connBanner').hidden = true; api('/api/state').then(applyState).catch(() => {}); }
  });
  events.addEventListener('open', loadChatVotes);
  events.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (state.messages.some((x) => x.id === m.id) || ['house-say', 'house-build'].includes(m.kind)) return;
    state.messages.push(m);
    refreshMessages(true);
  });
  events.onerror = () => {
    connFails++;
    const closed = events.readyState === EventSource.CLOSED;
    showConn(closed && connFails > 3 ? '연결할 수 없어요. 서버가 꺼졌거나 입장 권한이 해제되었을 수 있어요.' : '연결이 끊겼어요 · 다시 연결하는 중… (방장 PC와 서버가 켜져 있어야 해요)', closed && connFails > 3);
    if (!guest) $('#roomSub').textContent = '서버 연결 대기 중';
    if (closed) { events.close(); setTimeout(connect, Math.min(30000, 3000 * connFails)); }
  };
}
addEventListener('room-reconnect', () => api('/api/state').then(applyState).catch(() => { $('#roomSub').textContent = '서버 연결 대기 · 방장 PC가 켜져 있어야 합니다'; }));
document.addEventListener('visibilitychange', () => { api('/api/share/presence', { away: document.hidden }).catch(() => {}); maybeMarkRead(); });
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-house-open]')) window.dispatchEvent(new Event('house-open'));
  const button = e.target.closest('[data-house-event]');
  if (button) window.dispatchEvent(new CustomEvent('house-open-event', { detail: { id: Number(button.dataset.houseEvent) } }));
});
try {
  const first = await api('/api/state');
  unreadMark = first.lastRead || 0;
  if (!first.messages.some((m) => m.id > unreadMark && m.from !== 'system' && !(m.from === 'user' && (guest ? m.guestId === first.selfId : !m.guestId)))) unreadMark = null;
  applyState(first);
  await loadChatVotes();
  const divider = $('#msgs .unread-divider');
  if (divider) divider.scrollIntoView({ block: 'start' }); else tl.scrollTop = tl.scrollHeight;
  maybeMarkRead();
  $('#loadMore').hidden = guest || state.messages.length < 300;
  connect();
  if (!guest && !state.room.onboarding.done) openSetup();
  else if (!guest && !state.room.tutorial.done) startTour();
} catch (e) {
  $('#roomSub').textContent = '서버에 연결하지 못했어요';
  toast(`서버 연결 실패: ${e.message}`);
}
