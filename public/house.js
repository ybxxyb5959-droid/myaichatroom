// The house UI keeps its existing API and saved grid; only its visual view changes.
import { esc } from './format.mjs';

const COLORS = { claude: '#d97a3a', gpt: '#2f7cf6', gemini: '#5b6cf0' };
const panel = document.createElement('section');
panel.id = 'house'; panel.className = 'house'; panel.hidden = true;
panel.setAttribute('aria-label', '집');
panel.innerHTML = `
  <header class="hs-bar"><b>집</b><span id="hsStatus" role="status"></span><button type="button" id="hsClose" aria-label="집 닫고 채팅방으로" title="채팅방으로"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></header>
  <canvas id="hsCanvas" aria-label="AI들이 함께 짓는 3D 집"></canvas>
  <nav class="hs-tools" aria-label="집 시점">
    <button type="button" id="hsOverview" aria-pressed="true">집 전체</button>
    <button type="button" id="hsReset">시점 초기화</button>
    <button type="button" id="hsPhoto" disabled>사진 저장</button>
    <button type="button" id="hsCameras" aria-expanded="true">CCTV 접기</button>
  </nav>
  <section class="hs-cameras" id="hsCameraList" aria-label="실시간 가상 CCTV">
    ${[1, 2, 3, 4].map((n) => `<button type="button" data-camera="${n - 1}" aria-pressed="false" aria-label="CCTV ${n} 확대"><canvas aria-hidden="true"></canvas><span>CCTV ${n} <small>LIVE · 고정 시점</small></span></button>`).join('')}
  </section>
  <p class="hs-empty" id="hsEmpty" hidden>아직 아무것도 없어요.<br>Talk가 켜져 있으면 AI들이 천천히 집을 짓기 시작해요.</p>
  <p class="hs-error" id="hsError" role="alert" hidden></p>
  <aside class="hs-plan" id="hsPlan" hidden><b>공동 계획</b><p id="hsPlanText"></p></aside>
  <aside class="hs-diary" id="hsDiary" hidden aria-label="집 기록">
    <header><b>📖 집 기록</b><div class="hs-mode" id="hsMode" role="group" aria-label="집 운영 방식">
      <button type="button" data-mode="auto" title="AI들이 거의 모든 일을 알아서 정해요">🤖 자율</button>
      <button type="button" data-mode="balanced" title="큰 일만 물어보고 나머지는 알아서 정해요 (기본)">⚖️ 중요만</button>
      <button type="button" data-mode="together" title="작은 의견 차이도 한마디 할 기회를 줘요">🎮 함께</button></div></header>
    <section class="hs-selected-event" id="hsSelectedEvent" tabindex="-1" hidden></section>
    <div class="hs-ask" id="hsAsk" hidden></div><div class="hs-undo" id="hsUndo" hidden></div><div id="hsEvents"></div>
    <small class="hs-note">캐릭터들의 생활 기록이에요. 실제 감정이 아니라 앱이 정한 캐릭터 상태예요.</small>
  </aside>
  <section class="hs-log" id="hsLog" aria-label="집 대화"><button type="button" id="hsLogToggle" aria-expanded="true">대화 접기 ▾</button><div id="hsLogList" aria-live="polite"></div></section>
  <p class="hs-help">드래그: 회전 · 휠: 확대/축소 · 우클릭/Shift 드래그: 이동</p>`;
document.body.append(panel);
const $ = (s) => panel.querySelector(s);
const opener = document.querySelector('#houseBtn'), canvas = $('#hsCanvas');
let data = null, timer = 0, raf = 0, logKey = '', diaryKey = '', seenAt = 0;
let scene = null, initializing = null, loading = false;
let selectedEventId = null;
const bubbles = {};
function error(message) { $('#hsError').hidden = false; $('#hsError').textContent = message; }
canvas.addEventListener('house-render-error', (e) => { error(e.detail); $('#hsPhoto').disabled = true; });
async function initialize() {
  if (scene) return;
  initializing ||= import('./house-scene.mjs').then(({ HouseScene }) => {
    scene = new HouseScene(canvas, [...panel.querySelectorAll('[data-camera] canvas')]);
    $('#hsPhoto').disabled = false;
    if (data) scene.update(data, bubbles);
  });
  try { await initializing; } catch (e) { error(`3D 화면을 열 수 없어요: ${e.message}`); }
}
function frame(now) {
  if (panel.hidden) return;
  scene?.render(now);
  raf = requestAnimationFrame(frame);
}
async function send(route, body) {
  const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await res.json();
  if (!res.ok || value.error) throw new Error(value.error || `요청 실패 (${res.status})`);
  data = value; renderSide(); scene?.update(data, bubbles);
}
const day = (at) => new Date(at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
const time = (at) => new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
function renderDiary() {
  const life = data.phase === 'life';
  $('#hsDiary').hidden = !life;
  if (!life) return;
  const key = JSON.stringify([data.mode, data.open, data.undo, data.events.map((e) => e.id), selectedEventId]);
  if (key === diaryKey) return;
  diaryKey = key;
  $('#hsMode').querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === data.mode)));
  const selected = data.events.find((e) => e.id === selectedEventId);
  const current = data.open && (!selectedEventId || selectedEventId === data.open.eventId);
  $('#hsSelectedEvent').hidden = !selectedEventId;
  if (selectedEventId) {
    $('#hsSelectedEvent').innerHTML = `<b>확인하러 온 사건</b><p>${esc(selected?.text || (current ? data.open.text : '이 사건은 보관 기간이 지났거나 집이 새로 지어졌어요.'))}</p>
      <small>${current && data.open.stage === 'conflict' ? '아래에서 한마디 하거나 AI들에게 맡길 수 있어요.' : '이 사건은 지금 참여할 수 없어요. 기록만 확인할 수 있습니다.'}</small>
      <button type="button">전체 기록 보기</button>`;
    $('#hsSelectedEvent button').onclick = () => { selectedEventId = null; renderDiary(); };
  }
  const ask = current && data.open.ask;
  const canAct = current && (data.open.stage === 'conflict' || ask);
  $('#hsAsk').hidden = !canAct;
  if (canAct) {
    $('#hsAsk').innerHTML = `<p>${esc(data.open.text)}</p><small>${ask ? `${time(ask.deadline)}까지 아무것도 안 하면 AI들이 알아서 정해요.` : 'AI들이 알아서 해결하는 중이에요. 원하면 직접 한마디 할 수 있어요.'}</small>
      <div><button type="button" data-decide="ai">AI들에게 맡기기</button><button type="button" data-say>내가 한마디 하기</button></div>
      <form hidden><input maxlength="60" placeholder="예: 창가 쪽으로 두자" aria-label="방장 한마디"><button type="submit">정하기</button></form>`;
    const eventId = data.open.eventId;
    $('#hsAsk').querySelector('[data-decide]').onclick = () => send('/api/house/decide', { choice: 'ai', eventId }).catch((e) => error(e.message));
    $('#hsAsk').querySelector('[data-say]').onclick = () => { const f = $('#hsAsk form'); f.hidden = false; f.querySelector('input').focus(); };
    $('#hsAsk form').onsubmit = (e) => { e.preventDefault(); send('/api/house/decide', { choice: 'owner', eventId, note: e.target.querySelector('input').value }).catch((err) => error(err.message)); };
  }
  $('#hsUndo').hidden = !data.undo;
  if (data.undo) {
    $('#hsUndo').innerHTML = `<span>${esc(data.undo.text)}</span><button type="button">되돌리기</button>`;
    $('#hsUndo').querySelector('button').onclick = () => send('/api/house/undo', {}).catch((e) => error(e.message));
  }
  let last = '';
  $('#hsEvents').innerHTML = data.events.slice().reverse().map((e) => {
    const head = day(e.at) !== last ? `<div class="hs-day">${esc(day(e.at))}</div>` : '';
    last = day(e.at);
    return `${head}<div class="hs-event ${esc(e.tone || '')}"><time>${time(e.at)}</time> ${esc(e.text)}</div>`;
  }).join('') || '<div class="hs-event">아직 기록된 일이 없어요.</div>';
}
$('#hsMode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) send('/api/house/mode', { mode: b.dataset.mode }).catch((err) => error(err.message));
});
function renderSide() {
  renderDiary();
  const talk = data.talk ? (data.busy ? '지금 짓는 중…' : data.phase === 'life' ? 'Talk 켜짐 · 생활 중' : `Talk 켜짐 · 다음 작업 ${Math.max(1, Math.round((data.nextAt - Date.now()) / 60000))}분 뒤쯤`) : 'Talk 꺼짐 · 켜면 다시 움직여요';
  $('#hsStatus').textContent = `${data.phase === 'life' ? '🏠 생활 중' : '🔨 짓는 중'} · 가구 ${data.items.length}개 · ${talk}`;
  $('#hsEmpty').hidden = !!(data.floors.length || data.walls.length || data.items.length);
  $('#hsPlan').hidden = !data.plan; $('#hsPlanText').textContent = data.plan;
  const next = JSON.stringify(data.log);
  if (next === logKey) return;
  logKey = next;
  const who = (id) => data.names[id] || (id === 'user' ? data.userName : id === 'house' ? '🏠 집' : id);
  const list = $('#hsLogList');
  list.innerHTML = data.log.slice(-30).map((l) => `<div class="hs-line ${esc(l.kind)}"><b style="color:${COLORS[l.id] || 'inherit'}">${esc(who(l.id))}</b> ${l.kind === 'build' ? '🔨 ' : ''}${esc(l.text)}</div>`).join('') || '<div class="hs-line">아직 대화가 없어요.</div>';
  list.scrollTop = list.scrollHeight;
}
async function load() {
  if (loading) return;
  loading = true;
  try {
    const res = await fetch('/api/house');
    if (!res.ok) throw new Error(`집 불러오기 실패 (${res.status})`);
    const first = !data; data = await res.json();
    for (const l of data.log) {
      if (l.at > seenAt && l.kind === 'say' && !first) bubbles[l.id] = { text: l.text, until: Date.now() + 12000 };
    }
    seenAt = Math.max(seenAt, ...data.log.map((l) => l.at), 0);
    renderSide(); scene?.update(data, bubbles);
  } catch (e) { error(e.message); } finally { loading = false; }
}
function selectCamera(index) {
  if (!scene) return;
  scene.selected = index;
  $('#hsOverview').setAttribute('aria-pressed', String(index === -1));
  panel.querySelectorAll('[data-camera]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.camera) === index)));
  canvas.setAttribute('aria-label', index === -1 ? 'AI들이 함께 짓는 3D 집' : `CCTV ${index + 1} 확대 화면`);
  $('#hsReset').disabled = index !== -1;
}
$('#hsOverview').onclick = () => selectCamera(-1);
$('#hsCameraList').onclick = (e) => { const b = e.target.closest('[data-camera]'); if (b) selectCamera(Number(b.dataset.camera)); };
$('#hsReset').onclick = () => scene?.reset();
$('#hsCameras').onclick = () => {
  const open = $('#hsCameraList').hidden;
  $('#hsCameraList').hidden = !open;
  $('#hsCameras').setAttribute('aria-expanded', String(open));
  $('#hsCameras').textContent = open ? 'CCTV 접기' : 'CCTV 열기';
};
$('#hsPhoto').onclick = () => {
  if (!scene || !data) return;
  scene.photo().toBlob((blob) => {
    if (!blob) { error('사진을 저장할 수 없어요.'); return; }
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    const title = scene.selected === -1 ? 'house' : `cctv-${scene.selected + 1}`;
    link.href = url; link.download = `${title}-${new Date().toISOString().replaceAll(':', '-')}.png`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, 'image/png');
};
let drag = null;
canvas.oncontextmenu = (e) => e.preventDefault();
canvas.onpointerdown = (e) => { drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; canvas.setPointerCapture(e.pointerId); };
canvas.onpointermove = (e) => {
  if (!drag) return;
  scene?.orbit(e.clientX - drag.x, e.clientY - drag.y, drag.pan);
  drag.x = e.clientX; drag.y = e.clientY;
};
canvas.onpointerup = canvas.onpointercancel = canvas.onlostpointercapture = () => { drag = null; };
canvas.addEventListener('wheel', (e) => { e.preventDefault(); scene?.magnify(e.deltaY); }, { passive: false });
$('#hsLogToggle').onclick = () => {
  const open = $('#hsLogList').hidden;
  $('#hsLogList').hidden = !open; $('#hsLogToggle').setAttribute('aria-expanded', String(open));
  $('#hsLogToggle').textContent = open ? '대화 접기 ▾' : '대화 열기 ▴';
};
async function openHouse(eventId = null) {
  selectedEventId = eventId;
  panel.hidden = false; document.querySelector('#app').inert = true; opener.setAttribute('aria-expanded', 'true');
  const ready = Promise.all([initialize(), load()]);
  clearInterval(timer); timer = setInterval(load, 20000);
  cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); $('#hsClose').focus();
  await ready;
  if (panel.hidden || !data) return;
  renderDiary();
  if (eventId) {
    const event = data.events.find((e) => e.id === eventId);
    const actors = event?.actors || (data.open?.eventId === eventId ? data.open.pair : []);
    selectCamera(-1); scene?.focusActors(actors);
    if (!$('#hsSelectedEvent').hidden) $('#hsSelectedEvent').focus();
  }
}
opener.onclick = () => openHouse();
window.addEventListener('house-open-event', (e) => {
  if (Number.isInteger(e.detail?.id) && e.detail.id > 0) openHouse(e.detail.id);
});
$('#hsClose').onclick = () => {
  panel.hidden = true; document.querySelector('#app').inert = false;
  opener.setAttribute('aria-expanded', 'false'); opener.focus();
  clearInterval(timer); cancelAnimationFrame(raf); raf = 0;
  if (scene) scene.last = 0;
};
panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#hsClose').click(); });
window.addEventListener('house-update', () => { if (!panel.hidden) load(); });
