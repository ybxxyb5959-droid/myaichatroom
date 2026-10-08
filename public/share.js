const button = document.querySelector('#shareBtn');
const dialog = document.createElement('dialog');
dialog.className = 'share-dialog';
dialog.setAttribute('aria-label', '휴대폰 연결 및 친구 초대');
dialog.innerHTML = `<header><h2>공유</h2><button type="button" data-close aria-label="닫기">✕</button></header>
<section class="share-setup" aria-labelledby="tailscaleTitle">
<h3 id="tailscaleTitle">링크로 친구 초대하기</h3>
<p class="share-note">친구는 휴대폰·컴퓨터 브라우저로 입장해요. Tailscale 설치는 방장 PC에만 필요합니다.</p>
<ol><li><a href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">Tailscale 다운로드 ↗</a>에서 PC용 앱을 설치하세요.</li>
<li>PC에서 로그인하고, 처음에는 계정의 Funnel 공개 연결을 승인해 주세요.</li>
<li>친구 초대 링크를 보내면 친구는 이름만 입력해서 입장해요.</li></ol>
<p class="share-note">이용 중에는 PC·단톡방 앱·PC의 Tailscale을 켜 두세요. 공개 주소는 친구용 채팅만 허용하며, 방장 설정과 작업대는 차단합니다.</p>
<div class="share-actions"><button data-connect>선택한 방식으로 연결 켜기</button><button data-refresh>연결 상태 확인</button></div>
<p data-status role="status"></p><p class="share-error" data-error role="alert"></p>
</section>
<div class="share-tabs" role="tablist" aria-label="공유 방식">
<button type="button" id="shareOwnerTab" role="tab" aria-selected="true" aria-controls="shareOwnerPanel" data-tab="owner">내 폰 연결</button>
<button type="button" id="shareGuestTab" role="tab" aria-selected="false" aria-controls="shareGuestPanel" tabindex="-1" data-tab="guest">친구 부르기</button>
</div>
<section id="shareOwnerPanel" class="share-panel" role="tabpanel" aria-labelledby="shareOwnerTab">
<h3>기존 내 폰 연결 · 비공개 전용</h3>
<ol><li>PC와 폰의 Tailscale에 <strong>같은 계정</strong>으로 로그인하고 연결을 켜세요.</li><li>아래 버튼으로 QR코드를 만들고 폰 카메라로 링크를 여세요.</li><li>PC에 뜨는 기기 승인 팝업에서 <strong>예</strong>를 누르면 연결됩니다.</li></ol>
<p class="share-note">폰에도 Tailscale이 필요합니다. 방장은 비공개 8444 주소, 친구는 공개 8443 주소를 사용합니다. 이 QR코드는 친구에게 보내지 마세요. 브라우저에서 확인 가능한 기기 종류·모델을 승인 팝업에 표시합니다.</p>
<button data-pair>내 폰 연결 QR 만들기</button>
<section data-result="owner" class="share-result" hidden></section>
<div class="share-home"><h3>폰 홈 화면에 추가하기</h3>
<p>연결된 폰에서 아래 방법으로 추가하면 앱처럼 열 수 있어요.</p>
<ul><li><strong>iPhone:</strong> Safari에서 공유 → 홈 화면에 추가</li><li><strong>Android:</strong> Chrome 메뉴 → 앱 설치 또는 홈 화면에 추가</li></ul>
<p class="share-note">QR을 찍는 것만으로 자동 설치되지는 않아요. 설치해도 PC와 Tailscale 연결은 필요해요.</p>
<div data-pwa-install></div></div>
<h3>연결한 내 기기</h3><ul class="share-list" data-devices></ul>
<h3>대기 중인 내 폰 연결</h3><ul class="share-list" data-owner-invites></ul>
</section>
<section id="shareGuestPanel" class="share-panel" role="tabpanel" aria-labelledby="shareGuestTab" hidden>
<h3>친구와 함께 대화하기</h3>
<ol><li>친구에게 아래 링크를 보내거나 QR코드를 보여 주세요.</li>
<li>친구가 브라우저로 열고 이름을 입력하면 입장합니다. 별도 설치·회원가입은 필요 없어요.</li></ol>
<p class="share-note">한 링크로 24시간 동안 최대 10명이 입장합니다. 친구는 한도 내 AI 질문과 일반 채팅만 할 수 있고 AI 활성화 설정·작업대·파일에는 접근할 수 없습니다.</p>
<button data-invite>새 친구 초대 링크 만들기</button>
<section data-result="guest" class="share-result" hidden></section>
<details class="share-manage"><summary>친구 관리 · AI 사용 한도</summary>
<h3>방 모드</h3><select data-room-mode aria-label="방 모드"><option value="multi">친구와 쓰기</option><option value="solo">혼자 쓰기</option></select>
<p class="share-note">혼자 쓰기에서는 친구 입장과 접속을 닫습니다. 친구와 쓰기로 돌아오면 기존 친구가 재접속할 수 있어요.</p>
<h3>친구 권한</h3><div class="share-permissions"><label><input type="checkbox" data-permission="chat"> 채팅</label><label><input type="checkbox" data-permission="questions"> AI 질문</label><label><input type="checkbox" data-permission="discussion"> 토론</label><label><input type="checkbox" data-permission="house"> 집·투표 참여</label></div>
<h3>친구 AI 호출 한도</h3><p data-usage></p>
<form data-limits><label>친구 공용 하루 AI 호출 <input name="total" type="number" min="0" max="1000" required value="100"></label> <button>저장</button></form>
<p class="share-note">기본 공용 100회. 입장 권한이 있는 친구끼리 남은 한도를 균등 배분합니다. 친구 추가·내보내기·한도 변경 시 남은 몫만 다시 나누며 이미 쓴 횟수는 유지합니다. 브라우저를 닫거나 다시 열어도 초기화되지 않습니다. 자정(PC 시간)에 새로 배분합니다.</p>
<p class="share-note">Talk가 켜져 있으면 친구의 일반 대화에도 AI가 자동 반응합니다. 실제 호출 직전에 1회 차감하며 실패·취소도 포함합니다. 한도 소진 후에도 일반 채팅은 가능합니다. 개인 상한은 빈칸이면 자동 배분, 0이면 그 친구의 AI 응답만 중지합니다.</p>
<h3>친구 관리</h3><ul class="share-list" data-guests></ul>
<h3>대기 중인 친구 초대</h3><ul class="share-list" data-invites></ul>
</details></section>
<footer class="share-footer"><button data-disconnect>모든 휴대폰·친구 연결 끄기</button></footer>`;
document.body.append(dialog);
const $ = (selector) => dialog.querySelector(selector);
const tabs = [...dialog.querySelectorAll('[role=tab]')];
function selectTab(role) {
  $('.share-tabs').classList.toggle('is-guest', role === 'guest');
  tabs.forEach(tab => {
    const selected = tab.dataset.tab === role;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`#${tab.getAttribute('aria-controls')}`).hidden = !selected;
  });
}
tabs.forEach(tab => {
  tab.onclick = () => selectTab(tab.dataset.tab);
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[1] : tabs.find(item => item !== tab);
    selectTab(next.dataset.tab); next.focus();
  };
});
function clearResults() {
  dialog.querySelectorAll('[data-result]').forEach(box => { box.replaceChildren(); box.hidden = true; });
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
  const buttons = [...dialog.querySelectorAll('button')].filter(b => !b.hasAttribute('data-close'));
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
async function refresh() {
  const state = await request('/api/share');
  $('[data-status]').textContent = state.url ? `${state.public ? '친구용 공개' : '기존 비공개'} 연결: ${state.url}` : '공유 연결이 꺼져 있습니다.';
  $('[data-usage]').textContent = `오늘 공용 ${state.usage.total}/${state.usage.limit}회 사용 · 친구 ${state.usage.participants}명`;
  $('[data-usage]').textContent += ` · 실제 호출: 일반 ${state.calls?.ordinary || 0}, 친구 ${state.calls?.friend || 0}, 토론 ${state.calls?.discussion || 0}, 집 ${state.calls?.house || 0}`;
  $('[name=total]').value = state.usage.limit;
  $('[data-room-mode]').value = state.mode;
  $('[data-invite]').disabled = state.mode === 'solo';
  dialog.querySelectorAll('[data-permission]').forEach(input => { input.checked = state.permissions[input.dataset.permission]; });
  $('[data-guests]').replaceChildren(...state.guests.map(guest => {
    const li = row(`${guest.name} · ${state.participants?.find(p => p.id === guest.id)?.online ? '접속 중' : '오프라인'} · 사용 ${guest.usage.used}회 · 배정 잔여 ${guest.usage.remaining}회`, '내보내기', async () => {
      if (!confirm(`${guest.name}님의 입장 권한을 해제할까요?`)) return;
      await request('/api/share/revoke-guest', { id: guest.id }); await refresh();
    });
    const form = document.createElement('form'), input = document.createElement('input'), save = document.createElement('button');
    input.type = 'number'; input.min = '0'; input.max = '1000'; input.value = guest.limit ?? ''; input.placeholder = '자동'; input.setAttribute('aria-label', `${guest.name} 개인 상한 (빈칸은 자동 배분)`);
    save.textContent = '한도 저장';
    form.append(input, save); form.onsubmit = event => {
      event.preventDefault();
      action(async () => { await request('/api/share/limits', { guestId: guest.id, limit: input.value === '' ? null : Number(input.value) }); await refresh(); });
    };
    li.append(form); return li;
  }));
  for (const role of ['owner', 'guest']) {
    const box = $(`[data-result="${role}"]`);
    if (!state.invites.some(invite => invite.id === box.dataset.inviteId && invite.exp > Date.now())) {
      box.replaceChildren(); box.hidden = true;
    }
    $(role === 'owner' ? '[data-owner-invites]' : '[data-invites]').replaceChildren(...state.invites.filter(invite => invite.role === role).map(invite => row(
      `${role === 'owner' ? '내 휴대폰' : '친구'} · ${invite.uses || 0}/${invite.maxUses || 1}명 · ${new Date(invite.exp).toLocaleString()}까지`, '취소',
      async () => { await request('/api/share/revoke-invite', { id: invite.id }); await refresh(); })));
  }
  $('[data-devices]').replaceChildren(...state.devices.map(device => row(
    `${device.name || '방장 기기'} · ${new Date(device.exp).toLocaleDateString()}까지`, '연결 권한 해제',
    async () => { if (confirm('이 기기의 로그인 권한을 해제할까요?')) { await request('/api/share/revoke-device', { id: device.id }); await refresh(); } })));
}
async function createInvite(role) {
  const connection = await request('/api/share/connect', { public: role === 'guest' });
  if (role === 'guest' && connection.public !== true) throw new Error('새 공개 연결 기능을 사용하려면 PC 앱을 완전히 종료한 뒤 다시 실행해 주세요.');
  const result = await request('/api/share/invite', { role, maxUses: role === 'guest' ? 10 : 1 });
  const box = $(`[data-result="${role}"]`);
  box.dataset.inviteId = result.id;
  box.replaceChildren();
  const title = document.createElement('h3'), note = document.createElement('p'), image = document.createElement('img');
  title.textContent = role === 'owner' ? '내 휴대폰 전용 · 방장 권한' : '친구 초대 · 이름 입력 후 입장';
  note.textContent = `${new Date(result.exp).toLocaleString()}까지 최대 ${result.maxUses || 1}명. ${role === 'owner' ? '이 QR은 친구에게 보내지 마세요.' : '링크를 아는 사람이 입장할 수 있으니 친구에게만 전달하세요.'}`;
  image.src = result.qr; image.alt = title.textContent;
  const link = document.createElement('input'); link.readOnly = true; link.value = result.link; link.setAttribute('aria-label', '초대 링크');
  const copy = document.createElement('button'); copy.textContent = '링크 복사';
  const share = document.createElement('button'); share.type = 'button'; share.textContent = '친구에게 공유';
  share.hidden = role !== 'guest';
  share.onclick = async () => {
    try {
      if (/AIChatroomOwner\/1/.test(navigator.userAgent)) location.href = `aichatroom-share://send?url=${encodeURIComponent(result.link)}`;
      else if (navigator.share) await navigator.share({ title: 'AI 단톡방 초대', text: 'Chrome에서 열고 이름을 입력해 주세요.', url: result.link });
      else { await navigator.clipboard.writeText(result.link); share.textContent = '복사됨 · 카카오톡에 붙여넣기'; }
    } catch (error) { if (error.name !== 'AbortError') $('[data-error]').textContent = error.message; }
  };
  copy.onclick = () => action(async () => {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(result.link);
    else { link.select(); throw new Error('주소를 길게 누르거나 Ctrl+C로 복사해 주세요.'); }
  });
  box.append(title, note, image, link, copy, share); box.hidden = false;
  await refresh();
}
selectTab('guest');
button.onclick = () => {
  if (dialog.open) return;
  dialog.showModal(); selectTab('guest');
  action(async () => { await refresh(); await createInvite('guest'); });
};
$('[data-close]').onclick = () => dialog.close();
dialog.addEventListener('close', clearResults);
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
$('[data-connect]').onclick = () => action(async () => {
  $('[data-status]').textContent = 'Tailscale 연결 확인 중…';
  await request('/api/share/connect', { public: $('#shareGuestTab').getAttribute('aria-selected') === 'true' }); await refresh();
});
$('[data-pair]').onclick = () => action(() => createInvite('owner'));
$('[data-invite]').onclick = () => action(() => createInvite('guest'));
$('[data-room-mode]').onchange = event => action(async () => { await request('/api/share/access', { mode: event.target.value }); await refresh(); });
dialog.querySelectorAll('[data-permission]').forEach(input => { input.onchange = () => action(async () => { await request('/api/share/access', { permissions: { [input.dataset.permission]: input.checked } }); await refresh(); }); });
$('[data-disconnect]').onclick = () => action(async () => {
  if (!confirm('휴대폰과 친구의 현재 연결을 끌까요?')) return;
  await request('/api/share/disconnect', {}); clearResults(); $('[data-status]').textContent = '연결을 종료하고 있습니다.';
});
$('[data-limits]').onsubmit = event => {
  event.preventDefault();
  action(async () => { await request('/api/share/limits', { total: Number($('[name=total]').value) }); await refresh(); });
};
