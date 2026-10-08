const params = new URLSearchParams(location.hash.slice(1));
if (params.get('token')) sessionStorage.setItem('roomInvite', location.hash.slice(1));
const saved = new URLSearchParams(sessionStorage.getItem('roomInvite') || '');
const secret = saved.get('token');
history.replaceState(null, '', location.pathname);
const form = document.querySelector('#joinForm'), name = document.querySelector('#joinName'), error = document.querySelector('#joinError');
if (!secret) {
  form.hidden = true; error.textContent = '초대 링크나 PC의 휴대폰 연결 QR로 다시 열어 주세요.';
} else if (saved.get('role') === 'owner') {
  document.querySelector('#joinTitle').textContent = '내 휴대폰 연결';
  document.querySelector('#joinNote').textContent = '내 폰을 연결하고 있어요. 연결이 끝나면 바로 대화방을 엽니다.';
  document.querySelector('#nameLabel').hidden = true; name.required = false;
  document.querySelector('#joinSubmit').textContent = '내 휴대폰 연결하기';
}
async function connect() {
  const button = document.querySelector('#joinSubmit'); button.disabled = true; error.textContent = '';
  try {
    const response = await fetch('/api/share/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: secret, name: name.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    sessionStorage.removeItem('roomInvite');
    location.replace('/');
  } catch (e) { error.textContent = e.message; button.disabled = false; }
}
form.onsubmit = event => { event.preventDefault(); connect(); };
try {
  const response = await fetch('/api/share/session');
  const session = response.ok ? await response.json() : null;
  if (session?.role) { sessionStorage.removeItem('roomInvite'); location.replace('/'); }
  else if (secret && saved.get('role') === 'owner') connect();
} catch { error.textContent = 'PC와의 연결을 확인한 뒤 다시 시도해 주세요.'; }
