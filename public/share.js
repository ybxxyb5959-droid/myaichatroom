const button = document.querySelector('#shareBtn');
const dialog = document.createElement('dialog');
dialog.className = 'share-dialog';
dialog.setAttribute('aria-label', '휴대폰 연결 및 친구 초대');
dialog.innerHTML = `<header><h2>공유</h2><button type="button" data-close aria-label="닫기">✕</button></header>
<section class="share-setup" aria-labelledby="tailscaleTitle">
<h3 id="tailscaleTitle">먼저, Tailscale로 연결해 주세요</h3>
<p class="share-note">PC와 폰을 안전하게 이어 주는 연결 앱이에요.</p>
<ol><li><a href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">Tailscale 다운로드 ↗</a>에서 PC용 앱을 설치하세요.</li>
<li>폰의 App Store 또는 Google Play에서 <strong>Tailscale</strong>을 검색해 설치하세요.</li>
<li>두 기기에서 로그인하고 연결을 켜 주세요. 폰에 VPN 연결 허용 안내가 나오면 허용하세요.</li></ol>
<p class="share-note">내 폰은 PC와 같은 계정으로 로그인해요. 친구는 본인 계정을 사용해요. 접속하는 동안 PC·단톡방 앱·양쪽 Tailscale을 계속 켜 두세요.</p>
<div class="share-actions"><button data-connect>HTTPS 연결 켜기</button><button data-refresh>연결 상태 확인</button></div>
<p data-status role="status"></p><p class="share-error" data-error role="alert"></p>
</section>
<div class="share-tabs" role="tablist" aria-label="공유 방식">
<button type="button" id="shareOwnerTab" role="tab" aria-selected="true" aria-controls="shareOwnerPanel" data-tab="owner">내 폰 연결</button>
<button type="button" id="shareGuestTab" role="tab" aria-selected="false" aria-controls="shareGuestPanel" tabindex="-1" data-tab="guest">친구 부르기</button>
</div>
<section id="shareOwnerPanel" class="share-panel" role="tabpanel" aria-labelledby="shareOwnerTab">
<h3>내 폰에서도 이 방 그대로</h3>
<ol><li>PC와 폰의 Tailscale에 <strong>같은 계정</strong>으로 로그인하세요.</li><li>위에서 HTTPS 연결을 켜고, 아래 버튼으로 QR코드를 만드세요.</li><li>폰 카메라로 QR코드를 찍고 링크를 열어 연결하세요.</li></ol>
<p class="share-note">내 폰에는 방장 권한이 연결돼요. 이 QR코드는 친구에게 보내지 마세요.</p>
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
<ol><li>친구도 Tailscale을 설치하고 <strong>본인 계정</strong>으로 로그인해요.</li>
<li>방장이 <a href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener noreferrer">Tailscale 기기 관리 ↗</a>에서 이 PC를 친구에게 공유하고 접근을 허용해 주세요. 친구는 기기 공유 초대를 수락해야 해요.</li>
<li>아래에서 친구용 QR코드·링크를 만들어 보내 주세요. 친구가 링크를 열고 이름을 입력하면 입장해요.</li></ol>
<p class="share-note">Tailscale 기기 공유와 단톡방 초대는 별개예요. 아래 QR코드만으로는 PC에 접근할 수 없어요. 친구에게는 방장 권한을 주지 않아요.</p>
<button data-invite>친구 초대 QR 만들기</button>
<section data-result="guest" class="share-result" hidden></section>
<details class="share-manage"><summary>친구 관리 · AI 사용 한도</summary>
<h3>친구 AI 호출 한도</h3><p data-usage></p>
<form data-limits><label>친구 전체 하루 합계 <input name="total" type="number" min="0" max="1000" required value="15"></label> <button>저장</button></form>
<p class="share-note">친구 1명당 기본 15회, 친구 전체 합계 기본 15회입니다. 실제 AI 호출 직전에 1회 차감하며 실패·취소도 포함합니다. 자정(PC 시간)에 초기화됩니다. AI 요청을 끄면 사람끼리 대화는 계속할 수 있습니다.</p>
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
  $('[data-status]').textContent = state.url ? `연결 주소: ${state.url}` : '휴대폰 연결이 꺼져 있습니다. 먼저 HTTPS 연결을 켜 주세요.';
  $('[data-usage]').textContent = `오늘 ${state.usage.total}/${state.usage.limit}회 사용`;
  $('[name=total]').value = state.usage.limit;
  $('[data-guests]').replaceChildren(...state.guests.map(guest => {
    const li = row(`${guest.name} · ${guest.usage.used}/${guest.limit}회`, '내보내기', async () => {
      if (!confirm(`${guest.name}님의 입장 권한을 해제할까요?`)) return;
      await request('/api/share/revoke-guest', { id: guest.id }); await refresh();
    });
    const form = document.createElement('form'), input = document.createElement('input'), save = document.createElement('button');
    input.type = 'number'; input.min = '0'; input.max = '1000'; input.value = guest.limit; input.setAttribute('aria-label', `${guest.name} 하루 호출 한도`);
    save.textContent = '한도 저장';
    form.append(input, save); form.onsubmit = event => {
      event.preventDefault();
      action(async () => { await request('/api/share/limits', { guestId: guest.id, limit: Number(input.value) }); await refresh(); });
    };
    li.append(form); return li;
  }));
  for (const role of ['owner', 'guest']) {
    const box = $(`[data-result="${role}"]`);
    if (!state.invites.some(invite => invite.id === box.dataset.inviteId && invite.exp > Date.now())) {
      box.replaceChildren(); box.hidden = true;
    }
    $(role === 'owner' ? '[data-owner-invites]' : '[data-invites]').replaceChildren(...state.invites.filter(invite => invite.role === role).map(invite => row(
      `${role === 'owner' ? '내 휴대폰' : '친구'} · ${new Date(invite.exp).toLocaleString()}까지`, '취소',
      async () => { await request('/api/share/revoke-invite', { id: invite.id }); await refresh(); })));
  }
  $('[data-devices]').replaceChildren(...state.devices.map(device => row(
    `방장 기기 · ${new Date(device.exp).toLocaleDateString()}까지`, '연결 권한 해제',
    async () => { if (confirm('이 기기의 로그인 권한을 해제할까요?')) { await request('/api/share/revoke-device', { id: device.id }); await refresh(); } })));
}
async function createInvite(role) {
  const result = await request('/api/share/invite', { role });
  const box = $(`[data-result="${role}"]`);
  box.dataset.inviteId = result.id;
  box.replaceChildren();
  const title = document.createElement('h3'), note = document.createElement('p'), image = document.createElement('img');
  title.textContent = role === 'owner' ? '내 휴대폰 전용 · 방장 권한' : '친구 초대 · 이름 입력 후 입장';
  note.textContent = `${new Date(result.exp).toLocaleString()}까지 1회 사용 가능. ${role === 'owner' ? '이 QR은 친구에게 보내지 마세요.' : '이 링크를 먼저 사용하는 사람이 입장합니다. 친구에게만 전달하세요.'}`;
  image.src = result.qr; image.alt = title.textContent;
  const link = document.createElement('input'); link.readOnly = true; link.value = result.link; link.setAttribute('aria-label', '초대 링크');
  const copy = document.createElement('button'); copy.textContent = '링크 복사';
  copy.onclick = () => action(async () => {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(result.link);
    else { link.select(); throw new Error('주소를 길게 누르거나 Ctrl+C로 복사해 주세요.'); }
  });
  box.append(title, note, image, link, copy); box.hidden = false;
  await refresh();
}
button.onclick = () => { if (!dialog.open) dialog.showModal(); action(refresh); };
$('[data-close]').onclick = () => dialog.close();
dialog.addEventListener('close', clearResults);
$('[data-refresh]').onclick = () => action(refresh);
$('[data-connect]').onclick = () => action(async () => { $('[data-status]').textContent = 'Tailscale HTTPS 연결 확인 중…'; await request('/api/share/connect', {}); await refresh(); });
$('[data-pair]').onclick = () => action(() => createInvite('owner'));
$('[data-invite]').onclick = () => action(() => createInvite('guest'));
$('[data-disconnect]').onclick = () => action(async () => {
  if (!confirm('휴대폰과 친구의 현재 연결을 끌까요?')) return;
  await request('/api/share/disconnect', {}); clearResults(); $('[data-status]').textContent = '연결을 종료하고 있습니다.';
});
$('[data-limits]').onsubmit = event => {
  event.preventDefault();
  action(async () => { await request('/api/share/limits', { total: Number($('[name=total]').value) }); await refresh(); });
};
