const params = new URLSearchParams(location.hash.slice(1));
const savedTheme = localStorage.getItem('chatroom-theme');
if (['light', 'dark'].includes(savedTheme)) document.documentElement.dataset.theme = savedTheme;
let returning = false;
if (params.get('token')) sessionStorage.setItem('roomInvite', location.hash.slice(1));
const saved = new URLSearchParams(sessionStorage.getItem('roomInvite') || '');
const secret = saved.get('token');
history.replaceState(null, '', location.pathname);
// The join button is a round "→ 입장"; owner pairing and waiting use a wide button with words.
function setButton(label, wide = false) {
  const button = document.querySelector('#joinSubmit');
  button.classList.toggle('wide', wide);
  button.setAttribute('aria-label', label);
  if (wide) button.textContent = label;
  else button.innerHTML = '<span class="join-go-ic" aria-hidden="true">→</span><span class="join-go-label">입장</span>';
}
const form = document.querySelector('#joinForm'), name = document.querySelector('#joinName'), error = document.querySelector('#joinError');
if (!secret) {
  form.hidden = true; error.textContent = '초대 링크나 PC의 휴대폰 연결 QR로 다시 열어 주세요.';
} else if (saved.get('role') === 'owner') {
  document.querySelector('#joinTitle').textContent = '내 휴대폰 연결';
  document.querySelector('#joinNote').textContent = '휴대폰의 Tailscale을 켜 주세요. QR 연결 후 PC에서 이 기기를 승인하면 대화방이 열립니다.';
  document.querySelector('#nameLabel').hidden = true; name.required = false;
  setButton('내 휴대폰 연결하기', true);
}
async function connect() {
  const button = document.querySelector('#joinSubmit'); button.disabled = true; error.textContent = '';
  try {
    const response = await fetch(returning ? '/api/share/rejoin' : '/api/share/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: secret, name: name.value }), signal: AbortSignal.timeout(15000) });
    let result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (result.pending) {
      const { challenge, exp } = result;
      document.querySelector('#joinNote').textContent = 'PC에 연결 요청을 보냈습니다. PC의 기기 승인 팝업에서 ‘예’를 눌러 주세요.';
      setButton('PC 승인 기다리는 중…', true);
      while (result.pending) {
        if (Date.now() >= exp) throw new Error('승인 대기 시간이 지났습니다. 연결하기를 눌러 다시 요청해 주세요.');
        await new Promise(resolve => setTimeout(resolve, 2000));
        const status = await fetch('/api/share/pair-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret, challenge }), signal: AbortSignal.timeout(15000) });
        result = await status.json();
        if (!status.ok) throw new Error(result.error);
      }
    }
    sessionStorage.removeItem('roomInvite');
    location.replace('/');
  } catch (e) { error.textContent = e.name === 'TimeoutError' ? 'PC에 연결되지 않습니다. PC 앱과 휴대폰 Tailscale 연결을 확인해 주세요.' : e.message; button.disabled = false; setButton(saved.get('role') === 'owner' ? '내 휴대폰 연결하기' : '입장하기', saved.get('role') === 'owner'); }
}
form.onsubmit = event => { event.preventDefault(); connect(); };
try {
  const response = await fetch('/api/share/session', { signal: AbortSignal.timeout(15000) });
  const session = response.ok ? await response.json() : null;
  if (session?.role) { sessionStorage.removeItem('roomInvite'); location.replace('/'); }
  else if (session?.returnName) {
    returning = true; form.hidden = false; name.value = session.returnName; name.readOnly = true; error.textContent = '';
    document.querySelector('#joinTitle').textContent = '다시 만나서 반가워요';
    document.querySelector('#joinNote').textContent = '같은 이름과 남은 한도로 대화를 이어가세요.';
  }
  else if (secret && saved.get('role') === 'owner') connect();
  // Who sent the invitation: the server names the owner only for a link that is still valid.
  else if (secret) {
    const info = await fetch('/api/share/invite-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret }), signal: AbortSignal.timeout(15000) });
    const { host } = info.ok ? await info.json() : {};
    if (host) document.querySelector('#joinNote').textContent = `${host}님이 단톡방에 초대했어요.`;
  }
} catch { error.textContent = 'PC와의 연결을 확인한 뒤 다시 시도해 주세요.'; }
