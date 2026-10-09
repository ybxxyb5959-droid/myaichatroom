const button = document.querySelector('#shareBtn');
// Line icons drawn like the header's own (24px grid, 1.8 stroke), instead of emoji.
const ICONS = {
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.6.1 4.4 1.7 5 4.3"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18h2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9.5 13v.5M14.5 13v.5"/>',
  debate: '<path d="M3 4h11v8H7l-4 3z"/><path d="M10 15v2h7l4 3V9h-4"/>',
  house: '<path d="M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5h4v5"/>',
  game: '<rect x="3" y="7" width="18" height="11" rx="4"/><path d="M8 10.5v4M6 12.5h4M15.5 11.5v.5M17.5 13.5v.5"/>',
};
const icon = (name) => `<svg class="share-ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
const dialog = document.createElement('dialog');
dialog.className = 'share-dialog';
dialog.setAttribute('aria-label', '휴대폰 연결 및 친구 초대');
// Three screens: a choice, one step-by-step guide per goal (my phone / a friend), and management.
dialog.innerHTML = `<header><button type="button" class="share-back" data-back aria-label="처음으로" hidden>‹</button><h2 data-title>공유</h2><button type="button" data-close aria-label="닫기">✕</button></header>
<p class="share-status" data-status role="status"></p>
<p class="share-error" data-error role="alert"></p>
<section data-view="home">
<p class="share-lead">무엇을 할까요?</p>
<div class="share-choices">
<button type="button" class="share-choice" data-go="guest"><span class="share-choice-icon">${icon('users')}</span><b>친구 초대하기</b><small>링크만 보내면 돼요. 친구는 설치·가입 없이 이름만 입력해요.</small></button>
<button type="button" class="share-choice" data-go="owner"><span class="share-choice-icon">${icon('phone')}</span><b>내 폰 연결하기</b><small>내 폰에서 방장으로 써요. 폰에도 Tailscale이 필요해요.</small></button>
</div>
<button type="button" class="share-link" data-go="manage">연결된 기기 · 친구 관리 ›</button>
</section>
<section data-view="guest" hidden>
<ol class="share-steps" data-steps><li>PC 준비</li><li>초대 보내기</li><li>친구 입장</li></ol>
<div data-stage="prepare"><p class="share-wait">PC의 Tailscale 연결을 확인하고 초대 링크를 만드는 중이에요…</p></div>
<div data-stage="fix" hidden></div>
<div data-stage="ready" hidden>
<p class="share-do">아래 링크를 카카오톡 등으로 보내거나, 친구에게 QR을 보여 주세요.</p>
<section data-result="guest" class="share-result" hidden></section>
<p class="share-joined" data-joined>아직 들어온 친구가 없어요. 친구가 이름을 입력하면 여기에 표시돼요.</p>
</div>
<details class="share-more"><summary>ⓘ 알아 두기</summary>
<p class="share-note">한 링크로 24시간 동안 최대 10명이 입장해요. 링크를 아는 사람은 누구나 들어올 수 있으니 친구에게만 보내 주세요.</p>
<p class="share-note">친구는 한도 안에서 AI 질문과 일반 채팅만 할 수 있어요. AI 설정·작업대·파일에는 접근할 수 없어요.</p>
<p class="share-note">이용하는 동안 PC, 단톡방 앱, PC의 Tailscale을 켜 두세요. Tailscale은 방장 PC에만 있으면 돼요.</p>
</details>
</section>
<section data-view="owner" hidden>
<ol class="share-steps" data-steps><li>PC 준비</li><li>QR 찍기</li><li>PC에서 승인</li></ol>
<div data-stage="prepare"><p class="share-wait">PC의 Tailscale 연결을 확인하고 내 폰용 QR을 만드는 중이에요…</p></div>
<div data-stage="fix" hidden></div>
<div data-stage="ready" hidden>
<p class="share-do">폰에서 <strong>Tailscale을 켠 뒤</strong>(PC와 같은 계정) 카메라로 아래 QR을 찍으세요.</p>
<section data-result="owner" class="share-result" hidden></section>
<p class="share-joined" data-joined>QR로 열면 PC에 승인 창이 떠요. <strong>예</strong>를 누르면 연결돼요.</p>
<details class="share-home"><summary>폰 홈 화면에 앱처럼 추가하기</summary>
<ul><li><strong>iPhone:</strong> Safari에서 공유 → 홈 화면에 추가</li><li><strong>Android:</strong> Chrome 메뉴 → 앱 설치 또는 홈 화면에 추가</li></ul>
<p class="share-note">QR을 찍는 것만으로 자동 설치되지는 않아요. 설치해도 PC와 Tailscale 연결은 필요해요.</p>
</details>
</div>
<details class="share-more"><summary>ⓘ 알아 두기</summary>
<p class="share-note">이 QR은 방장 권한이라 친구에게 보내면 안 돼요. 친구는 "친구 초대하기"를 쓰세요.</p>
<p class="share-note">방장은 비공개 8444 주소, 친구는 공개 8443 주소를 써요. 승인 창에는 브라우저가 알려 주는 기기 종류·모델이 표시돼요.</p>
</details>
</section>
<section data-view="manage" hidden>
<div class="mg-card">
<h3>방 모드</h3>
<div class="mg-modes" role="radiogroup" aria-label="방 모드">
<button type="button" role="radio" data-mode="multi">${icon('users')}<b>친구와 쓰기</b><small>초대한 친구가 들어와 같이 대화해요</small></button>
<button type="button" role="radio" data-mode="solo">${icon('lock')}<b>혼자 쓰기</b><small>친구 입장과 접속을 잠시 닫아요. 다시 켜면 기존 친구가 돌아올 수 있어요</small></button>
</div>
</div>
<div class="mg-card">
<h3>친구 <span class="mg-count" data-guest-count></span></h3>
<ul class="mg-guests" data-guests></ul>
</div>
<div class="mg-card" data-perm-card>
<h3>친구가 할 수 있는 것</h3>
<p class="mg-off-note" data-perm-off hidden>혼자 쓰기 중이라 친구가 들어올 수 없어요. 설정은 저장되고 친구와 쓰기로 바꾸면 적용돼요.</p>
<div class="mg-perms">
<label class="mg-perm">${icon('chat')}<span class="mg-perm-text"><b>채팅</b><small>친구가 메시지를 보낼 수 있어요</small></span><span class="switch"><input type="checkbox" data-permission="chat" aria-label="채팅"><span></span></span></label>
<label class="mg-perm">${icon('bot')}<span class="mg-perm-text"><b>AI 질문</b><small>친구 메시지에 AI가 답해요 · 아래 한도를 써요</small></span><span class="switch"><input type="checkbox" data-permission="questions" aria-label="AI 질문"><span></span></span></label>
<label class="mg-perm">${icon('debate')}<span class="mg-perm-text"><b>토론</b><small>친구가 토론 모드를 쓸 수 있어요 · 한 번에 호출이 많아요</small></span><span class="switch"><input type="checkbox" data-permission="discussion" aria-label="토론"><span></span></span></label>
<label class="mg-perm">${icon('house')}<span class="mg-perm-text"><b>집·투표 참여</b><small>집짓기 화면을 보고 인테리어·스토리 투표에 참여해요</small></span><span class="switch"><input type="checkbox" data-permission="house" aria-label="집·투표 참여"><span></span></span></label>
<label class="mg-perm">${icon('game')}<span class="mg-perm-text"><b>미니게임 시작</b><small>친구가 게임을 열 수 있어요 · 시작할 때 AI 호출 1회</small></span><span class="switch"><input type="checkbox" data-permission="games" aria-label="미니게임 시작"><span></span></span></label>
</div>
</div>
<div class="mg-card">
<h3>친구 AI 호출 한도 <small>하루 · 친구 전체 공용</small></h3>
<div class="mg-usage"><b data-left></b><span data-usage></span></div>
<div class="share-meter" aria-hidden="true"><i data-meter></i></div>
<p class="mg-hint" data-share-hint></p>
<form data-limits class="mg-limit">
<span class="mg-presets" role="group" aria-label="하루 한도 빠른 선택"><button type="button" data-preset="30">30</button><button type="button" data-preset="50">50</button><button type="button" data-preset="100">100</button><button type="button" data-preset="200">200</button></span>
<label>직접 입력 <input name="total" type="number" min="0" max="1000" required value="100"> 회</label>
<button class="share-primary">저장</button>
</form>
<details class="share-more"><summary>ⓘ 한도는 어떻게 나뉘나요?</summary>
<p class="share-note">입장 권한이 있는 친구끼리 남은 한도를 똑같이 나눠요. 친구 추가·내보내기·한도 변경 때는 남은 몫만 다시 나누고, 이미 쓴 횟수는 그대로예요. 자정(PC 시간)에 새로 나눠요.</p>
<p class="share-note">Talk가 켜져 있으면 친구의 일반 대화에도 AI가 반응해요. 실제 호출 직전에 1회씩 빠지고, 실패·취소도 포함돼요. 한도를 다 써도 일반 채팅은 할 수 있어요.</p>
<p class="share-note">친구마다 개인 한도를 따로 정할 수 있어요. 비워 두면 자동, 0이면 그 친구에게만 AI가 답하지 않아요.</p>
</details>
</div>
<div class="mg-card">
<h3>연결한 내 기기</h3><ul class="share-list" data-devices></ul>
</div>
<details class="mg-card mg-invites"><summary><h3>대기 중인 초대 <span class="mg-count" data-invite-count></span></h3></summary>
<ul class="share-list" data-invites></ul><ul class="share-list" data-owner-invites></ul>
</details>
<div class="share-actions"><button type="button" data-refresh>연결 상태 다시 확인</button></div>
<div class="share-danger"><h3>위험 구역</h3><p class="share-note">켜져 있는 휴대폰·친구 연결을 모두 끊어요. 초대와 기기 권한은 그대로 남아요.</p><button type="button" data-disconnect>모든 휴대폰·친구 연결 끄기</button></div>
</section>`;
document.body.append(dialog);
const $ = (selector) => dialog.querySelector(selector);
const TITLES = { home: '공유', guest: '친구 초대하기', owner: '내 폰 연결하기', manage: '연결 · 친구 관리' };
let view = 'home';
const known = { guest: null, owner: null };
function show(next) {
  view = next;
  dialog.querySelectorAll('[data-view]').forEach(section => { section.hidden = section.dataset.view !== next; });
  $('[data-title]').textContent = TITLES[next];
  $('[data-back]').hidden = next === 'home';
  $('[data-error]').textContent = '';
}
// Steps: done before `now`, the current one marked (or failed), the rest waiting.
function steps(role, now, failed = false) {
  $(`[data-view="${role}"] [data-steps]`).querySelectorAll('li').forEach((li, i) => {
    li.dataset.state = i < now ? 'done' : i === now ? (failed ? 'error' : 'now') : '';
  });
}
function stage(role, name) {
  $(`[data-view="${role}"]`).querySelectorAll('[data-stage]').forEach(box => { box.hidden = box.dataset.stage !== name; });
}
function clearResults() {
  dialog.querySelectorAll('[data-result]').forEach(box => { box.replaceChildren(); box.hidden = true; delete box.dataset.inviteId; });
}
const request = async (route, body) => {
  const response = await fetch(route, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '연결하지 못했습니다.');
  return result;
};
async function action(task) {
  $('[data-error]').textContent = '';
  const buttons = [...dialog.querySelectorAll('button')].filter(b => !b.hasAttribute('data-close') && !b.hasAttribute('data-back'));
  buttons.forEach(b => { b.disabled = true; });
  try { await task(); } catch (error) { $('[data-error]').textContent = error.message; }
  finally { buttons.forEach(b => { b.disabled = false; }); }
}
function row(text, label, callback) {
  const li = document.createElement('li'), span = document.createElement('span'), b = document.createElement('button');
  span.textContent = text; b.textContent = label; b.type = 'button'; b.onclick = () => action(callback);
  li.append(span, document.createTextNode(' '), b);
  return li;
}
// Text with any https:// address turned into a link that opens outside the app.
function linked(text) {
  const p = document.createElement('p');
  String(text).split(/(https?:\/\/[^\s)]+)/).forEach((part, i) => {
    if (i % 2) { const a = document.createElement('a'); a.href = part; a.textContent = part; a.target = '_blank'; a.rel = 'noopener noreferrer'; p.append(a); }
    else if (part) p.append(part);
  });
  return p;
}
async function refresh() {
  const state = await request('/api/share');
  $('[data-status]').textContent = state.url ? `● ${state.public ? '친구 초대용' : '내 폰 전용'} 연결이 켜져 있어요` : '○ 공유 연결이 꺼져 있어요';
  $('[data-status]').classList.toggle('on', !!state.url);
  const used = state.usage.total, limit = state.usage.limit, friends = state.usage.participants;
  $('[data-meter]').style.width = `${limit ? Math.min(100, Math.round(used / limit * 100)) : 0}%`;
  $('[data-left]').textContent = `${Math.max(0, limit - used)}회 남음`;
  $('[data-usage]').textContent = `오늘 ${used} / ${limit}회 사용`;
  $('[data-usage]').title = `실제 호출: 일반 ${state.calls?.ordinary || 0}, 친구 ${state.calls?.friend || 0}, 토론 ${state.calls?.discussion || 0}, 집 ${state.calls?.house || 0}`;
  $('[data-share-hint]').textContent = friends ? `친구 ${friends}명이 나눠 쓰면 1인당 약 ${Math.floor(limit / friends)}회예요.` : '친구가 들어오면 이 한도를 똑같이 나눠 써요.';
  if (!dialog.contains(document.activeElement?.closest('[data-limits]'))) $('[name=total]').value = limit;
  dialog.querySelectorAll('[data-preset]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.preset) === limit)));
  dialog.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));
  $('[data-perm-off]').hidden = state.mode !== 'solo';
  $('[data-perm-card]').classList.toggle('is-off', state.mode === 'solo');
  dialog.querySelectorAll('[data-permission]').forEach(input => { input.checked = state.permissions[input.dataset.permission]; });
  const online = (id) => state.participants?.find(p => p.id === id)?.online;
  $('[data-guest-count]').textContent = state.guests.length ? `${state.guests.filter(g => online(g.id)).length}명 접속 · 전체 ${state.guests.length}명` : '';
  $('[data-guests]').replaceChildren(...(state.guests.length ? state.guests.map(guestRow(online)) : [empty('아직 들어온 친구가 없어요. "친구 초대하기"로 링크를 보내 보세요.')]));
  $('[data-invite-count]').textContent = `${state.invites.length}개`;
  for (const role of ['owner', 'guest']) {
    const box = $(`[data-result="${role}"]`);
    if (box.dataset.inviteId && !state.invites.some(invite => invite.id === box.dataset.inviteId && invite.exp > Date.now())) {
      box.replaceChildren(); box.hidden = true; delete box.dataset.inviteId;
      if (view === role) { stage(role, 'fix'); steps(role, 1, true); fixHelp(role, '초대가 만료됐거나 취소됐어요. 새로 만들어 주세요.'); }
    }
    $(role === 'owner' ? '[data-owner-invites]' : '[data-invites]').replaceChildren(...state.invites.filter(invite => invite.role === role).map(invite => row(
      `${role === 'owner' ? '내 폰 QR' : '친구 링크'} · ${invite.uses || 0}/${invite.maxUses || 1}명 입장 · ${new Date(invite.exp).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}까지`, '취소',
      async () => { await request('/api/share/revoke-invite', { id: invite.id }); await refresh(); })));
  }
  $('[data-devices]').replaceChildren(...(state.devices.length ? state.devices.map(device => row(
    `${device.name || '방장 기기'} · ${new Date(device.exp).toLocaleDateString('ko-KR')}까지`, '연결 해제',
    async () => { if (confirm('이 기기의 로그인 권한을 해제할까요?')) { await request('/api/share/revoke-device', { id: device.id }); await refresh(); } })) : [empty('연결한 기기가 없어요.')]));
  arrivals(state);
  return state;
}
function empty(text) { const li = document.createElement('li'); li.className = 'share-empty'; li.textContent = text; return li; }
// A friend row: initial, name, online state, today's usage bar, and a folded personal limit (kept open across refreshes).
const openLimits = new Set();
const guestRow = (online) => (guest) => {
  const li = document.createElement('li'); li.className = 'mg-guest';
  const share = guest.usage.used + guest.usage.remaining;
  const here = online(guest.id);
  li.innerHTML = `<span class="mg-av" aria-hidden="true"></span><span class="mg-who"><b></b><small class="${here ? 'on' : ''}">${here ? '● 접속 중' : '○ 오프라인'}</small></span>
    <span class="mg-use"><small></small><span class="share-meter"><i style="width:${share ? Math.min(100, Math.round(guest.usage.used / share * 100)) : 0}%"></i></span></span>`;
  li.querySelector('.mg-av').textContent = guest.icon || [...guest.name][0] || '친';
  li.querySelector('.mg-who b').textContent = guest.name;
  li.querySelector('.mg-use small').textContent = `오늘 ${guest.usage.used}회 · 남은 몫 ${guest.usage.remaining}회${guest.limit === 0 ? ' · AI 답변 멈춤' : guest.limit != null ? ` · 개인 한도 ${guest.limit}회` : ''}`;
  const more = document.createElement('details'); more.className = 'mg-guest-more'; more.open = openLimits.has(guest.id);
  more.ontoggle = () => { if (more.open) openLimits.add(guest.id); else openLimits.delete(guest.id); };
  more.innerHTML = '<summary>설정</summary>';
  const form = document.createElement('form'), label = document.createElement('label'), input = document.createElement('input'), save = document.createElement('button');
  input.type = 'number'; input.min = '0'; input.max = '1000'; input.value = guest.limit ?? ''; input.placeholder = '자동';
  label.append('개인 한도 ', input, ' 회'); save.textContent = '저장';
  form.append(label, save);
  form.onsubmit = event => {
    event.preventDefault();
    action(async () => { await request('/api/share/limits', { guestId: guest.id, limit: input.value === '' ? null : Number(input.value) }); await refresh(); });
  };
  const hint = document.createElement('p'); hint.className = 'share-note'; hint.textContent = '비워 두면 자동으로 나눠요. 0이면 이 친구에게만 AI가 답하지 않아요.';
  const kick = document.createElement('button'); kick.type = 'button'; kick.className = 'mg-kick'; kick.textContent = '내보내기';
  kick.onclick = () => action(async () => {
    if (!confirm(`${guest.name}님의 입장 권한을 해제할까요?`)) return;
    await request('/api/share/revoke-guest', { id: guest.id }); openLimits.delete(guest.id); await refresh();
  });
  more.append(form, hint, kick); li.append(more);
  return li;
};
// Step 3 finishes when someone actually arrives after the invite was made: a new friend, or a new owner device.
function arrivals(state) {
  if (known.guest) {
    const fresh = state.guests.filter(g => !known.guest.has(g.id));
    if (fresh.length) {
      $('[data-view="guest"] [data-joined]').textContent = `${fresh.map(g => g.name).join(', ')}님이 들어왔어요. 더 초대하려면 같은 링크를 계속 보내면 돼요.`;
      if (view === 'guest') steps('guest', 3);
    }
  }
  if (known.owner && state.devices.some(d => !known.owner.has(d.id))) {
    $('[data-view="owner"] [data-joined]').textContent = '✓ 내 폰이 연결됐어요. 이제 폰에서 단톡방을 쓸 수 있어요.';
    if (view === 'owner') steps('owner', 3);
  }
}
// The server's message decides which concrete next step to show.
function fixHelp(role, message) {
  const box = $(`[data-view="${role}"] [data-stage="fix"]`);
  box.replaceChildren();
  const title = document.createElement('h3'), list = document.createElement('ol');
  const item = (...parts) => { const li = document.createElement('li'); li.append(...parts); list.append(li); };
  const link = (href, text) => { const a = document.createElement('a'); a.href = href; a.textContent = text; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
  if (/설치/.test(message)) {
    title.textContent = 'PC에 Tailscale이 필요해요';
    item(link('https://tailscale.com/download', 'Tailscale 다운로드 ↗'), '에서 PC용 앱을 설치하세요.');
    item(`PC의 Tailscale 앱을 열고 로그인하세요.${role === 'owner' ? ' 폰에도 같은 계정으로 설치·로그인해 두세요.' : ''}`);
    item('끝나면 아래 [다시 확인]을 누르세요.');
  } else if (/승인/.test(message)) {
    title.textContent = 'Tailscale 계정에서 한 번만 승인해 주세요';
    item('처음 쓸 때는 Tailscale이 공개 연결(Funnel) 허용을 물어봐요. 아래 안내의 주소를 열어 승인하세요.');
    item('승인한 뒤 [다시 확인]을 누르세요.');
  } else if (/종료한 뒤 다시 실행/.test(message)) {
    title.textContent = '단톡방 앱을 다시 켜 주세요';
    item('PC의 단톡방 앱을 완전히 종료한 뒤 start.bat으로 다시 실행하세요.');
  } else if (/혼자 쓰기/.test(message)) {
    title.textContent = '지금은 "혼자 쓰기" 모드예요';
    const switchMode = document.createElement('button'); switchMode.type = 'button'; switchMode.textContent = '친구와 쓰기로 바꾸기';
    switchMode.onclick = () => action(async () => { await request('/api/share/access', { mode: 'multi' }); await refresh(); await start(role); });
    item('친구를 초대하려면 방 모드를 "친구와 쓰기"로 바꿔야 해요. ', switchMode);
  } else if (/만료|취소/.test(message)) {
    title.textContent = '초대를 새로 만들어 주세요';
  } else {
    title.textContent = 'PC의 Tailscale을 확인해 주세요';
    item('PC 화면 오른쪽 아래 트레이에서 Tailscale이 켜져 있고 로그인돼 있는지 확인하세요.');
    item('그래도 안 되면 아래 안내 문구를 확인하세요.');
  }
  const detail = linked(message); detail.className = 'share-note share-detail';
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'share-primary'; retry.textContent = /만료|취소/.test(message) ? '새로 만들기' : '다시 확인';
  retry.onclick = () => start(role);
  box.append(title, ...(list.children.length ? [list] : []), detail, retry);
}
async function createInvite(role) {
  const connection = await request('/api/share/connect', { public: role === 'guest' });
  if (role === 'guest' && connection.public !== true) throw new Error('새 공개 연결 기능을 사용하려면 PC 앱을 완전히 종료한 뒤 다시 실행해 주세요.');
  const result = await request('/api/share/invite', { role, maxUses: role === 'guest' ? 10 : 1 });
  const box = $(`[data-result="${role}"]`);
  box.dataset.inviteId = result.id;
  box.replaceChildren();
  const title = document.createElement('h3'), note = document.createElement('p'), image = document.createElement('img');
  title.textContent = role === 'owner' ? '내 휴대폰 전용 QR' : '친구 초대 링크';
  note.className = 'share-note';
  note.textContent = `${new Date(result.exp).toLocaleString()}까지 · 최대 ${result.maxUses || 1}명${role === 'owner' ? ' · 친구에게 보내지 마세요' : ''}`;
  image.src = result.qr; image.alt = `${title.textContent} QR코드`;
  const link = document.createElement('input'); link.readOnly = true; link.value = result.link; link.setAttribute('aria-label', '초대 링크');
  const buttons = document.createElement('div'); buttons.className = 'share-actions';
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '링크 복사';
  const share = document.createElement('button'); share.type = 'button'; share.className = 'share-primary'; share.textContent = '친구에게 보내기';
  share.hidden = role !== 'guest';
  share.onclick = async () => {
    try {
      if (/AIChatroomOwner\/1/.test(navigator.userAgent)) location.href = `aichatroom-share://send?url=${encodeURIComponent(result.link)}`;
      else if (navigator.share) await navigator.share({ title: 'AI 단톡방 초대', text: 'Chrome에서 열고 이름을 입력해 주세요.', url: result.link });
      else { await navigator.clipboard.writeText(result.link); share.textContent = '복사됨 · 카카오톡에 붙여넣기'; }
    } catch (error) { if (error.name !== 'AbortError') $('[data-error]').textContent = error.message; }
  };
  copy.onclick = () => action(async () => {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(result.link); copy.textContent = '복사됨 ✓'; }
    else { link.select(); throw new Error('주소를 길게 누르거나 Ctrl+C로 복사해 주세요.'); }
  });
  buttons.append(share, copy);
  box.append(title, image, link, buttons, note); box.hidden = false;
}
// One guide run: check the PC side by actually connecting, then show the QR/link, then wait for the arrival.
async function start(role) {
  show(role);
  const box = $(`[data-result="${role}"]`);
  if (box.dataset.inviteId && !box.hidden) { stage(role, 'ready'); steps(role, 1); return; }
  stage(role, 'prepare'); steps(role, 0);
  $('[data-error]').textContent = '';
  try {
    const state = await refresh();
    if (role === 'guest' && state.mode === 'solo') throw new Error('혼자 쓰기 모드에서는 친구를 초대할 수 없어요.');
    known[role] = new Set((role === 'guest' ? state.guests : state.devices).map(x => x.id));
    await createInvite(role);
    stage(role, 'ready'); steps(role, 1);
    await refresh();
  } catch (error) {
    stage(role, 'fix'); steps(role, 0, true); fixHelp(role, error.message);
  }
}
dialog.querySelectorAll('[data-go]').forEach(choice => {
  choice.onclick = () => (choice.dataset.go === 'manage' ? (show('manage'), action(refresh)) : start(choice.dataset.go));
});
$('[data-back]').onclick = () => show('home');
button.onclick = () => {
  if (dialog.open) return;
  dialog.showModal(); show('home');
  refresh().catch(error => { $('[data-error]').textContent = error.message; });
};
$('[data-close]').onclick = () => dialog.close();
dialog.addEventListener('close', () => { clearResults(); known.guest = known.owner = null; });
$('[data-refresh]').onclick = () => action(refresh);
setInterval(() => {
  if (dialog.open && !dialog.contains(document.activeElement?.closest('input'))) refresh().catch(error => { $('[data-error]').textContent = error.message; });
}, 5000);
// Approval is available only on the local PC, even with the sharing panel closed.
const pairDialog = document.createElement('dialog');
pairDialog.className = 'share-dialog';
pairDialog.setAttribute('aria-label', '기기 연결 승인');
const pairTitle = document.createElement('h2'), pairNote = document.createElement('p'), pairError = document.createElement('p');
pairNote.textContent = '내 휴대폰에서 요청한 연결인지 확인하세요. 예를 누르면 이 기기에 방장 권한을 부여합니다.';
pairNote.className = 'share-note'; pairError.setAttribute('role', 'alert');
const pairYes = document.createElement('button'), pairNo = document.createElement('button');
pairYes.textContent = '예'; pairNo.textContent = '아니오'; pairYes.type = pairNo.type = 'button';
const pairActions = document.createElement('div'); pairActions.className = 'share-pair-actions'; pairActions.append(pairYes, pairNo);
pairDialog.append(pairTitle, pairNote, pairError, pairActions); document.body.append(pairDialog);
let pairingRequest = null, pairingBusy = false;
async function decidePair(approve) {
  if (!pairingRequest || pairingBusy) return;
  pairingBusy = true; pairYes.disabled = pairNo.disabled = true;
  try { await request('/api/share/pairing', { id: pairingRequest.id, approve }); pairingRequest = null; pairDialog.close(); if (dialog.open) await refresh(); }
  catch (error) { pairError.textContent = error.message; }
  finally { pairingBusy = false; pairYes.disabled = pairNo.disabled = false; }
}
pairYes.onclick = () => decidePair(true); pairNo.onclick = () => decidePair(false);
pairDialog.addEventListener('cancel', event => { event.preventDefault(); decidePair(false); });
if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) setInterval(async () => {
  if (pairingBusy || document.hidden) return;
  try {
    const result = await request('/api/share/pairing');
    if (pairingRequest && !result.requests.some(r => r.id === pairingRequest.id)) { pairingRequest = null; pairDialog.close(); }
    if (!pairingRequest && result.requests.length) {
      pairingRequest = result.requests[0]; pairTitle.textContent = `${pairingRequest.name}으로 연결하시겠습니까?`; pairError.textContent = '';
      pairDialog.showModal(); pairYes.focus();
    }
  } catch { /* The PC may be restarting; no approval is inferred. */ }
}, 2000);
dialog.querySelectorAll('[data-mode]').forEach(choice => {
  choice.onclick = () => action(async () => {
    if (choice.getAttribute('aria-checked') === 'true') return;
    if (choice.dataset.mode === 'solo' && !confirm('혼자 쓰기로 바꾸면 지금 접속한 친구의 연결도 닫혀요. 바꿀까요?')) return;
    await request('/api/share/access', { mode: choice.dataset.mode }); await refresh();
  });
});
dialog.querySelectorAll('[data-preset]').forEach(preset => {
  preset.onclick = () => action(async () => { await request('/api/share/limits', { total: Number(preset.dataset.preset) }); await refresh(); });
});
dialog.querySelectorAll('[data-permission]').forEach(input => { input.onchange = () => action(async () => { await request('/api/share/access', { permissions: { [input.dataset.permission]: input.checked } }); await refresh(); }); });
$('[data-disconnect]').onclick = () => action(async () => {
  if (!confirm('휴대폰과 친구의 현재 연결을 끌까요?')) return;
  await request('/api/share/disconnect', {}); clearResults(); $('[data-status]').textContent = '연결을 종료하고 있습니다.';
});
$('[data-limits]').onsubmit = event => {
  event.preventDefault();
  action(async () => { await request('/api/share/limits', { total: Number($('[name=total]').value) }); await refresh(); });
};
