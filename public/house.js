// The house UI keeps its existing API and saved grid; only its visual view changes.
import { esc } from './format.mjs';
import { bindHouseControls } from './house-controls.mjs';

const COLORS = { claude: '#d97a3a', gpt: '#2f7cf6', gemini: '#5b6cf0' };
const panel = document.createElement('section');
panel.id = 'house'; panel.className = 'house'; panel.hidden = true;
panel.setAttribute('aria-label', '집');
panel.innerHTML = `
  <header class="hs-bar"><b>집</b><span id="hsStatus" role="status"></span><button type="button" id="hsClose" aria-label="집 닫고 채팅방으로" title="채팅방으로"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></header>
  <canvas id="hsCanvas" tabindex="0" aria-label="AI들이 함께 짓는 3D 집. 완성 후 방향키로 이동, E키로 상호작용"></canvas>
  <nav class="hs-tools" aria-label="집 시점">
    <button type="button" id="hsReset" aria-pressed="true">집 전체</button>
    <button type="button" id="hsPhoto" disabled>사진 저장</button>
    <button type="button" id="hsPlayer" hidden>내 캐릭터</button>
    <span class="hs-follow" id="hsFollow" role="group" aria-label="캐릭터 따라가기">${Object.keys(COLORS).map((id) => `<button type="button" data-follow="${id}" aria-pressed="false" title="이 캐릭터를 따라가요"><img src="/avatars/${id}-pixel-128.png" alt=""><span></span></button>`).join('')}</span>
  </nav>
  <p class="hs-empty" id="hsEmpty" hidden>아직 아무것도 없어요.<br>Talk가 켜져 있으면 AI들이 천천히 집을 짓기 시작해요.</p>
  <p class="hs-error" id="hsError" role="alert" hidden></p>
  <aside class="hs-plan" id="hsPlan" hidden><b>공동 계획</b><p id="hsPlanText"></p></aside>
  <aside class="hs-progress" id="hsProgress" aria-label="공사 진행" hidden></aside>
  <aside class="hs-diary" id="hsDiary" hidden aria-label="집 기록">
    <header><b>📖 집 기록</b><div class="hs-mode" id="hsMode" role="group" aria-label="집 운영 방식">
      <button type="button" data-mode="auto" title="AI들이 거의 모든 일을 알아서 정해요">🤖 자율</button>
      <button type="button" data-mode="balanced" title="큰 일만 물어보고 나머지는 알아서 정해요 (기본)">⚖️ 중요만</button>
      <button type="button" data-mode="together" title="작은 의견 차이도 한마디 할 기회를 줘요">🎮 함께</button></div></header>
    <section class="hs-selected-event" id="hsSelectedEvent" tabindex="-1" hidden></section>
    <div class="hs-ask" id="hsAsk" hidden></div><div class="hs-undo" id="hsUndo" hidden></div><div id="hsEvents"></div>
  </aside>
  <section class="hs-log" id="hsLog" aria-label="집 대화"><button type="button" id="hsLogToggle" aria-expanded="true">대화 접기 ▾</button><div id="hsLogList" aria-live="polite"></div><form id="hsChat" autocomplete="off"><input id="hsChatInput" maxlength="2000" placeholder="AI들에게 말 걸기 (@이름으로 지정)" aria-label="AI에게 채팅 보내기"><button type="submit">보내기</button></form></section>
  <p class="hs-help">드래그: 회전 · 휠: 확대/축소 · 우클릭/Shift 드래그: 이동<br><span id="hsPlayerHelp" hidden>방향키: 걷기 · E: 소파 앉기/침대 눕기/AI에게 인사 · 방향키로 일어나기</span></p>`;
document.body.append(panel);
const $ = (s) => panel.querySelector(s);
const opener = document.querySelector('#houseBtn'), canvas = $('#hsCanvas');
let data = null, timer = 0, raf = 0, logKey = '', diaryKey = '';
let scene = null, initializing = null, loading = false;
let selectedEventId = null;
function error(message) { $('#hsError').hidden = false; $('#hsError').textContent = message; }
const clearMovement = bindHouseControls(panel, {
  ready: () => !panel.hidden && !!data?.player && !!scene,
  angle: () => scene?.angle || 0,
  send: (body) => send('/api/house/player', body),
  error,
});
$('#hsPlayer').onclick = () => { scene.follow = 'user'; scene.zoom = .65; showFollow(); canvas.focus(); };
canvas.addEventListener('house-render-error', (e) => { error(e.detail); $('#hsPhoto').disabled = true; });
async function initialize() {
  if (scene) return;
  initializing ||= import('./house-scene.mjs').then(({ HouseScene }) => {
    scene = new HouseScene(canvas);
    $('#hsPhoto').disabled = false;
    if (data) scene.update(data);
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
  $('#hsError').hidden = true;
  data = value; renderSide(); scene?.update(data);
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
  $('#hsPlayer').hidden = $('#hsPlayerHelp').hidden = !data.player;
  const talk = data.talk ? (data.busy ? '지금 짓는 중…' : data.phase === 'life' ? 'Talk 켜짐 · 생활 중' : `Talk 켜짐 · 다음 작업 ${Math.max(1, Math.round((data.nextAt - Date.now()) / 60000))}분 뒤쯤`) : 'Talk 꺼짐 · 켜면 다시 움직여요';
  $('#hsStatus').textContent = `${data.phase === 'life' ? '🏠 생활 중' : '🔨 짓는 중'} · 가구 ${data.items.length}개 · ${talk}`;
  $('#hsEmpty').hidden = !!(data.floors.length || data.walls.length || data.items.length);
  $('#hsPlan').hidden = !data.plan; $('#hsPlanText').textContent = data.plan;
  panel.querySelectorAll('[data-follow] span').forEach((s) => { s.textContent = data.names[s.parentElement.dataset.follow]; });
  const p = data.progress, board = $('#hsProgress');
  board.hidden = !p || data.phase === 'life';
  if (!board.hidden) {
    const STAGE = { floor: '바닥 까는 중', wall: '벽·문 짓는 중', furniture: '가구 놓는 중' };
    const bar = (done, all) => `<i style="width:${all ? Math.min(100, Math.round(done / all * 100)) : 0}%"></i>`;
    board.innerHTML = `<b>공사 진행 ${p.percent}%</b> <small>${p.percent === 100 ? '완성!' : STAGE[p.stage]}</small><div class="hs-bar-all">${bar(p.percent, 100)}</div>
      ${p.rooms.map((r, i) => `<button type="button" data-room="${i}" title="이 방으로 이동"><span>${esc(r.name)}</span><em style="color:${COLORS[r.owner]}">${esc(data.names[r.owner] || r.owner)}</em>
        <div class="hs-bar-room">${bar(r.floor, r.floorTotal)}</div><small>바닥 ${r.floor}/${r.floorTotal} · 가구 ${r.count}/${r.min}</small></button>`).join('')}`;
  }
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
    data = await res.json();
    renderSide(); scene?.update(data);
  } catch (e) { error(e.message); } finally { loading = false; }
}
// Which member the view follows (null = the whole house); dragging to move the view stops following.
function showFollow() {
  const id = scene?.follow || null;
  $('#hsReset').setAttribute('aria-pressed', String(!id));
  panel.querySelectorAll('[data-follow]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.follow === id)));
}
$('#hsProgress').onclick = (e) => {
  const b = e.target.closest('[data-room]');
  const room = b && data?.progress?.rooms[Number(b.dataset.room)];
  if (room) { scene?.focusAt(room.x, room.z); showFollow(); }
};
$('#hsReset').onclick = () => { scene?.reset(); showFollow(); };
$('#hsFollow').onclick = (e) => {
  const b = e.target.closest('[data-follow]');
  if (!b || !scene) return;
  scene.follow = scene.follow === b.dataset.follow ? null : b.dataset.follow;
  if (scene.follow) scene.zoom = .65;
  showFollow();
};
$('#hsPhoto').onclick = () => {
  if (!scene || !data) return;
  scene.photo().toBlob((blob) => {
    if (!blob) { error('사진을 저장할 수 없어요.'); return; }
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `house-${new Date().toISOString().replaceAll(':', '-')}.png`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, 'image/png');
};
let drag = null;
canvas.oncontextmenu = (e) => e.preventDefault();
canvas.onpointerdown = (e) => { canvas.focus(); drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; canvas.setPointerCapture(e.pointerId); };
canvas.onpointermove = (e) => {
  if (!drag) return;
  scene?.orbit(e.clientX - drag.x, e.clientY - drag.y, drag.pan);
  drag.x = e.clientX; drag.y = e.clientY;
};
canvas.onpointerup = canvas.onpointercancel = canvas.onlostpointercapture = () => { drag = null; showFollow(); };
canvas.addEventListener('wheel', (e) => { e.preventDefault(); scene?.magnify(e.deltaY); }, { passive: false });
$('#hsChat').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#hsChatInput'), text = input.value.trim();
  if (!text) return;
  try {
    const res = await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const value = await res.json();
    if (!res.ok) throw new Error(value.error || `요청 실패 (${res.status})`);
    input.value = ''; $('#hsError').hidden = true; load();
  } catch (err) { error(err.message); }
};
$('#hsLogToggle').onclick = () => {
  const open = $('#hsLogList').hidden;
  $('#hsLogList').hidden = !open; $('#hsChat').hidden = !open; $('#hsLogToggle').setAttribute('aria-expanded', String(open));
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
    scene?.focusActors(actors); showFollow();
    if (!$('#hsSelectedEvent').hidden) $('#hsSelectedEvent').focus();
  }
}
opener.onclick = () => openHouse();
window.addEventListener('house-open-event', (e) => {
  if (Number.isInteger(e.detail?.id) && e.detail.id > 0) openHouse(e.detail.id);
});
$('#hsClose').onclick = () => {
  clearMovement();
  panel.hidden = true; document.querySelector('#app').inert = false;
  opener.setAttribute('aria-expanded', 'false'); opener.focus();
  clearInterval(timer); cancelAnimationFrame(raf); raf = 0;
  if (scene) scene.last = 0;
};
panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#hsClose').click(); });
window.addEventListener('house-update', () => { if (!panel.hidden) load(); });
