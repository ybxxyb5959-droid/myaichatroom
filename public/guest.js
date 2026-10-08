import { esc, renderMarkdown } from './format.mjs';

const $ = selector => document.querySelector(selector);
const colors = { claude: '#d97a3a', gpt: '#2f7cf6', gemini: '#5b6cf0' };
const timeline = $('#timeline'), input = $('#guestText'), messages = new Map();
let events, sending = false, firstRender = true, memberKey = '';
const portrait = id => `<img class="m-av" src="/avatars/${id}-pixel-128.png" alt="">`;
const clock = ts => ts ? new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';

function messageNode(message, selfId) {
  const node = document.createElement('article');
  if (message.from === 'system') {
    node.className = `sys${message.kind === 'error' ? ' k-error' : ''}`;
    node.textContent = message.text || '';
    return node;
  }
  const mine = message.from === 'user' && message.guestId === selfId;
  const ai = Object.hasOwn(colors, message.from);
  node.className = `msg${mine ? ' mine' : ''}`;
  node.style.setProperty('--c', colors[message.from] || 'var(--text)');
  node.setAttribute('aria-label', `${message.name}${mine ? ' · 나' : ''}`);
  const avatar = ai ? portrait(message.from) : `<div class="m-av guest-person">${esc([...message.name][0] || '?')}</div>`;
  const quote = message.replyPreview
    ? `<div class="quote"><span class="qn">${esc(message.replyPreview.name)}</span>${esc(message.replyPreview.text)}</div>` : '';
  node.innerHTML = `${avatar}<div class="m-body">
    <div class="m-head"><span class="n">${esc(message.name)}</span>
      <span class="model">${esc(ai ? message.model || '' : message.guestId ? '친구' : '방장')}</span></div>
    <div class="line"><div class="bubble">${quote}<div class="text">${renderMarkdown(message.text || '')}</div></div>
      <time class="time">${esc(clock(message.ts))}</time></div></div>`;
  return node;
}

function scrollToLatest() { timeline.scrollTop = timeline.scrollHeight; $('#guestJump').hidden = true; }
function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  $('#guestSend').disabled = sending || !input.value.trim();
}
function render(state) {
  $('#guestPeople').textContent = (state.participants || []).map(p => `${p.online ? '●' : '○'} ${p.name}`).join(' · ');
  $('#roomTitle').textContent = $('#sideRoomTitle').textContent = state.roomName;
  $('#guestName').textContent = state.name;
  $('#guestInitial').textContent = [...state.name][0] || '나';
  $('#guestConnection').textContent = `${state.name} · 친구로 참여 중`;
  $('#guestStatus').textContent = `내 사용 ${state.usage.used}회 · 배정 잔여 ${state.usage.remaining}회\n공용 ${state.usage.total}/${state.usage.limit}회 · 친구 ${state.usage.participants}명`;
  const key = JSON.stringify(state.members);
  if (key !== memberKey) {
    memberKey = key;
    $('#guestMembers').innerHTML = state.members.map(member => `<li class="member${member.busy ? ' st-typing' : ''}" style="--c:${colors[member.id] || 'var(--text)'}">
      <div class="av-wrap"><img class="av" src="/avatars/${member.id}-pixel-128.png" alt=""><span class="st-dot"></span></div>
      <div class="m-info"><div class="m-name"><span class="n">${esc(member.name)}</span><span class="m-maker">${esc(member.maker || '')}</span></div>
      <div class="m-status">${member.busy ? '답변·작업 중' : '참여 중'}</div></div></li>`).join('');
    if (!state.members.length) $('#guestMembers').innerHTML = '<li class="hint">현재 연결된 AI가 없어요. 일반 채팅은 사용할 수 있습니다.</li>';
  }
  const replyStatus = { queued: '최근 메시지를 묶어 응답 대기 중', responding: 'AI가 대화에 참여하는 중',
    paused: '방장이 AI 대화를 일시정지했어요', limited: '배정 한도 소진 · 일반 채팅 가능', ready: `내 배정 잔여 ${state.usage.remaining}회` };
  $('#guestRemaining').textContent = state.members.length ? replyStatus[state.autoReply] || replyStatus.ready : 'AI 연결 대기 · 일반 채팅 가능';
  const busy = state.members.filter(member => member.busy);
  $('#guestTyping').textContent = busy.length ? `${busy.map(member => member.name).join(', ')} · 답변·작업 중…` : '';

  const bottom = firstRender || timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100;
  const current = new Set(state.messages.map(message => message.id));
  for (const [id, cached] of messages) if (!current.has(id)) { cached.node.remove(); messages.delete(id); }
  let appended = false;
  for (const message of state.messages) {
    const signature = JSON.stringify(message), cached = messages.get(message.id);
    if (cached?.signature === signature) continue;
    const node = messageNode(message, state.selfId);
    if (cached) cached.node.replaceWith(node);
    else { $('#guestMessages').append(node); appended = true; }
    messages.set(message.id, { signature, node });
  }
  $('#guestEmpty').hidden = state.messages.length > 0;
  if (bottom) scrollToLatest();
  else if (appended) $('#guestJump').hidden = false;
  firstRender = false;
}

async function refresh() {
  const response = await fetch('/api/state');
  if (response.status === 401) { events?.close(); location.replace('/join'); return false; }
  if (!response.ok) throw new Error('연결이 끊겼습니다. 방장 PC의 단톡방 앱과 공유 연결 상태를 확인해 주세요.');
  render(await response.json()); return true;
}
$('#guestForm').onsubmit = async event => {
  event.preventDefault();
  const text = input.value.trim();
  if (sending || !text) return;
  const draft = input.value;
  sending = true; autosize(); $('#guestError').textContent = '';
  try {
    const response = await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (input.value === draft) input.value = '';
    await refresh(); scrollToLatest();
  } catch (error) { $('#guestError').textContent = error.message; }
  finally { sending = false; autosize(); }
};
input.addEventListener('input', autosize);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) {
    event.preventDefault(); $('#guestForm').requestSubmit();
  }
});
$('#guestJump').onclick = scrollToLatest;
timeline.addEventListener('scroll', () => {
  if (timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100) $('#guestJump').hidden = true;
});
$('#guestMessages').onclick = async event => {
  const button = event.target.closest('.copy-code, .code-expand');
  if (!button) return;
  const block = button.closest('.code-block');
  if (button.classList.contains('code-expand')) {
    const collapsed = block.querySelector('pre').classList.toggle('collapsed');
    button.textContent = collapsed ? '펼치기' : '접기';
  } else {
    try { await navigator.clipboard.writeText(block.querySelector('code').textContent); button.textContent = '복사됨'; }
    catch { $('#guestError').textContent = '복사하지 못했습니다. 코드를 선택해 직접 복사해 주세요.'; }
  }
};
function side(open) {
  $('#app').classList.toggle('side-open', open);
  $('#scrim').hidden = !open;
  $('#openSide').setAttribute('aria-expanded', String(open));
  $('#side').inert = matchMedia('(max-width: 820px)').matches && !open;
}
$('#openSide').onclick = () => side(!$('#app').classList.contains('side-open'));
$('#scrim').onclick = () => { side(false); $('#openSide').focus(); };
addEventListener('keydown', event => { if (event.key === 'Escape') side(false); });
addEventListener('resize', () => side(false));
side(false);
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const theme = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('chatroom-theme', theme);
};
const theme = localStorage.getItem('chatroom-theme');
addEventListener('room-reconnect', () => refresh().catch(error => { $('#guestError').textContent = error.message; }));
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
try {
  if (await refresh()) {
    events = new EventSource('/events');
    events.addEventListener('state', event => render(JSON.parse(event.data)));
    events.addEventListener('house', () => dispatchEvent(new Event('house-update')));
    events.onerror = () => {
      $('#guestConnection').textContent = '연결을 다시 확인하고 있어요…';
      refresh().catch(error => { $('#guestError').textContent = error.message; });
    };
  }
} catch (error) { $('#guestConnection').textContent = '연결 확인 필요'; $('#guestError').textContent = error.message; }
