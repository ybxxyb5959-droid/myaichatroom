const $ = selector => document.querySelector(selector);
let lastIds = '', events;
function render(state) {
  $('#roomTitle').textContent = state.roomName;
  $('#guestStatus').textContent = `${state.name} · 내 AI ${state.usage.used}/${state.usage.guestLimit}회 · 친구 전체 ${state.usage.total}/${state.usage.limit}회`;
  const selected = $('#guestAI').value;
  $('#guestAI').replaceChildren(...state.members.map(member => {
    const option = document.createElement('option'); option.value = member.id; option.textContent = member.name; return option;
  }));
  if (state.members.some(member => member.id === selected)) $('#guestAI').value = selected;
  const exhausted = state.usage.total >= state.usage.limit || state.usage.used >= state.usage.guestLimit || !state.members.length;
  $('#askAI').disabled = exhausted;
  if (exhausted) $('#askAI').checked = false;
  const ids = state.messages.map(m => m.id).join(',');
  if (ids === lastIds) return;
  lastIds = ids;
  const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 140;
  $('#guestMessages').replaceChildren(...state.messages.map(message => {
    const item = document.createElement('article'), name = document.createElement('strong'), body = document.createElement('p');
    item.className = 'phone-message'; name.textContent = message.name; body.textContent = message.text || '';
    item.append(name, body); return item;
  }));
  if (bottom) window.scrollTo(0, document.documentElement.scrollHeight);
}
async function refresh() {
  const response = await fetch('/api/state');
  if (response.status === 401) { events?.close(); location.replace('/join'); return false; }
  if (!response.ok) throw new Error('연결이 끊겼습니다. PC와 Tailscale 연결을 확인하세요.');
  render(await response.json()); return true;
}
$('#guestForm').onsubmit = async event => {
  event.preventDefault(); $('#guestSend').disabled = true; $('#guestError').textContent = '';
  try {
    const response = await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: $('#guestText').value, askAI: $('#askAI').checked, ai: $('#guestAI').value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    $('#guestText').value = ''; await refresh();
  } catch (error) { $('#guestError').textContent = error.message; }
  finally { $('#guestSend').disabled = false; }
};
try {
  if (await refresh()) {
    events = new EventSource('/events');
    events.addEventListener('state', event => render(JSON.parse(event.data)));
    events.onerror = () => refresh().catch(error => { $('#guestError').textContent = error.message; });
  }
} catch (error) { $('#guestError').textContent = error.message; }
