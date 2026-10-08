// The house UI keeps its existing API and saved grid; only its visual view changes.
import { esc } from './format.mjs';
import { bindHouseControls } from './house-controls.mjs';
import { actorActivity } from './house-view.mjs';
import { voteHeaderHTML, voteCardHTML, bindVoteCard } from './joint-vote.mjs';

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
    <button type="button" data-panel="hsPlan" aria-expanded="false">공동 계획</button>
    <button type="button" data-panel="hsProgress" aria-expanded="false">진행 상세</button>
    <button type="button" data-panel="hsDiary" aria-expanded="false">집 기록</button>
    <button type="button" id="hsPlayer" hidden>내 캐릭터</button>
    <button type="button" id="hsActive" aria-pressed="false">집 자동 실행 켜기</button>
    <button type="button" id="hsContinueSolo" hidden>혼자 계속하기</button>
    <span class="hs-follow" id="hsFollow" role="group" aria-label="캐릭터 따라가기">${Object.keys(COLORS).map((id) => `<button type="button" data-follow="${id}" aria-pressed="false" title="이 캐릭터를 따라가요"><img src="/avatars/${id}-pixel-128.png" alt=""><span></span></button>`).join('')}</span>
  </nav>
  <p class="hs-empty" id="hsEmpty" hidden>아직 아무것도 없어요.<br>집 자동 실행을 켜면 AI들이 집을 짓기 시작해요.</p>
  <p class="hs-error" id="hsError" role="alert" hidden></p>
  <aside class="hs-plan" id="hsPlan" hidden><b>공동 계획</b><p id="hsPlanText"></p></aside>
  <aside class="hs-progress" id="hsProgress" aria-label="공사 진행" hidden></aside>
  <aside class="hs-room" id="hsRoom" aria-label="선택한 방" hidden></aside>
  <aside class="hs-vote" id="hsVote" aria-label="인테리어 투표" hidden></aside>
  <aside class="hs-story" id="hsStory" aria-label="공동 스토리 투표" hidden></aside>
  <aside class="hs-activity" id="hsActivity" aria-label="작업현황" hidden>
    <button type="button" id="hsActivityToggle" aria-expanded="true" aria-controls="hsActivityBody" aria-label="작업현황 접기">
      <span aria-hidden="true">🔨</span><b class="hs-activity-title">작업현황</b><span class="hs-activity-title" aria-hidden="true">▾</span>
    </button>
    <div id="hsActivityBody">
      ${Object.keys(COLORS).map((id) => `<button type="button" class="hs-activity-row" data-activity-follow="${id}" aria-pressed="false" disabled>
        <i aria-hidden="true" style="background:${COLORS[id]}"></i><b></b><span></span></button>`).join('')}
      <p class="hs-activity-recent"><small>최근 완료</small><span id="hsActivityRecent"></span></p>
    </div>
  </aside>
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
let selectedRoom = -1;
let activityAt = 0;
$('#hsActivityToggle').onclick = () => {
  const collapsed = !$('#hsActivityBody').hidden;
  $('#hsActivityBody').hidden = collapsed;
  $('#hsActivity').classList.toggle('collapsed', collapsed);
  $('#hsActivityToggle').setAttribute('aria-expanded', String(!collapsed));
  $('#hsActivityToggle').setAttribute('aria-label', collapsed ? '작업현황 펼치기' : '작업현황 접기');
};
new ResizeObserver(() => panel.style.setProperty('--hs-chat-height', `${Math.ceil($('#hsLog').getBoundingClientRect().height)}px`)).observe($('#hsLog'));
const openPanels = new Set();
panel.querySelectorAll('[data-panel]').forEach((button) => {
  button.onclick = () => {
    const id = button.dataset.panel;
    const wasOpen = openPanels.has(id);
    openPanels.clear();
    if (!wasOpen) openPanels.add(id);
    panel.querySelectorAll('[data-panel]').forEach((b) => b.setAttribute('aria-expanded', String(openPanels.has(b.dataset.panel))));
    diaryKey = ''; if (data) renderSide();
  };
});
function error(message) { $('#hsError').hidden = false; $('#hsError').textContent = message; }
const clearMovement = bindHouseControls(panel, {
  ready: () => !panel.hidden && !!data?.player && !!scene,
  angle: () => scene?.angle || 0,
  send: (body) => send('/api/house/player', body),
  error,
});
$('#hsPlayer').onclick = () => { scene.follow = 'user'; scene.zoom = .65; showFollow(); canvas.focus(); };
canvas.addEventListener('house-render-error', (e) => { error(e.detail); $('#hsPhoto').disabled = true; });
canvas.addEventListener('house-follow-change', showFollow);
$('#hsContinueSolo').onclick = () => send('/api/house/continue-solo', {}).catch(e => error(e.message));
$('#hsActive').onclick = () => send('/api/house/active', { active: !data.active }).catch(e => error(e.message));
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
  panel.querySelectorAll('[data-deadline]').forEach(el => {
    el.textContent = `남은 시간 ${Math.max(0, Math.ceil((Number(el.dataset.deadline) - Date.now()) / 1000))}초`;
  });
  if (now - activityAt >= 500) { activityAt = now; renderActivity(); }
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
  $('#hsDiary').hidden = !openPanels.has('hsDiary');
  if ($('#hsDiary').hidden) return;
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
  $('#hsEvents').innerHTML = '<p class="hs-note">생활 사건은 자동 연출입니다. 실제 AI 발언은 채팅·말풍선에 표시합니다.</p>' + (data.events.slice().reverse().map((e) => {
    const head = day(e.at) !== last ? `<div class="hs-day">${esc(day(e.at))}</div>` : '';
    last = day(e.at);
    return `${head}<div class="hs-event ${esc(e.tone || '')}"><time>${time(e.at)}</time> ${esc(e.text)}</div>`;
  }).join('') || '<div class="hs-event">아직 기록된 일이 없어요.</div>');
}
$('#hsMode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) send('/api/house/mode', { mode: b.dataset.mode }).catch((err) => error(err.message));
});
function renderJoint(vote, target, story = false) {
  target.hidden = !vote;
  if (!vote) return;
  const expanded = vote.status === 'open' && (target.querySelector('details')?.open ?? false);
  target.innerHTML = `<details ${expanded ? 'open' : ''}><summary class="joint-vote-summary">${voteHeaderHTML(vote)}<small>${story ? `EPISODE ${String(vote.episode).padStart(2, '0')} · ` : ''}${esc(vote.title || '공동 인테리어 투표')}</small></summary>${voteCardHTML(vote, data, { header: false })}</details>`;
  bindVoteCard(target, vote, async body => {
    await send('/api/house/ballot', body);
    window.dispatchEvent(new Event('house-update'));
  });
}
function renderSide() {
  const guest = data.role === 'guest';
  $('#hsMode').hidden = guest;
  $('#hsActive').hidden = guest;
  $('#hsActive').textContent = data.active ? '집 자동 실행 끄기' : '집 자동 실행 켜기';
  $('#hsActive').setAttribute('aria-pressed', String(!!data.active));
  $('#hsAsk').hidden = guest || $('#hsAsk').hidden;
  $('#hsUndo').hidden = guest || $('#hsUndo').hidden;
  renderDiary();
  if (guest) { $('#hsAsk').hidden = true; $('#hsUndo').hidden = true; }
  renderJoint(data.story?.current, $('#hsStory'), true);
  renderActivity();
  $('#hsPlayer').hidden = $('#hsPlayerHelp').hidden = !data.player;
  const talk = data.crew?.waiting ? '건축 AI 호출은 쉬고 있어요. 일반 채팅은 계속할 수 있습니다.'
    : data.talk ? (data.busy ? 'AI가 계획을 검토하고 있어요' : data.nextAt > Date.now() ? '호출 오류로 재시도 대기 중' : '집 자동 실행 켜짐 · 작업을 이어가요') : '집 자동 실행 꺼짐 · 켜면 다시 움직여요';
  $('#hsStatus').textContent = `${data.crew?.waiting ? '동료 복귀 대기' : data.progress?.stage === 'planning' ? 'AI 공동 계획 논의 중' : data.progress ? `전체 공사 ${data.progress.percent}%` : data.phase === 'life' ? '기본 집 완성' : '집 짓는 중'}${data.talk ? '' : ' · 일시정지'}`;
  $('#hsContinueSolo').hidden = guest || !data.crew?.waiting || Object.keys(data.agents).length !== 1;
  $('#hsStatus').title = talk;
  $('#hsEmpty').hidden = !!(data.floors.length || data.walls.length || data.items.length);
  $('#hsPlan').hidden = !openPanels.has('hsPlan');
  const handoff = data.crew?.handoff;
  $('#hsPlanText').textContent = (data.plan || '아직 공동 계획이 없어요.') + (handoff
    ? `\n최근 작업 인계 (${handoff.source === 'ai' ? 'AI가 남긴 다음 작업' : '저장 상태 기준'})\n완료: ${handoff.completed}\n남은 일: ${handoff.remaining}\n다음: ${handoff.next} (${handoff.location.x}, ${handoff.location.z})` : '');
  if (data.story) $('#hsPlanText').textContent += `\n공동 집 환경: 지붕 ${data.story.environment.roof} · 자재 ${data.story.environment.materials} · 마당 ${data.story.environment.yard || '미정'} · 다음 방 ${data.story.environment.room || '미정'}`;
  panel.querySelectorAll('[data-follow] span').forEach((s) => {
    const id = s.parentElement.dataset.follow;
    s.textContent = data.names[id]; s.parentElement.hidden = !data.agents[id];
  });
  const p = data.progress, board = $('#hsProgress');
  board.hidden = !p || !openPanels.has('hsProgress');
  if (!board.hidden) {
    const STAGE = { planning: 'AI가 목표와 방 구성을 정하고 있어요', floor: '바닥 목표 진행 중', wall: '벽·문 목표 진행 중', furniture: '가구·통로 목표 진행 중' };
    const bar = (done, all) => `<i style="width:${all ? Math.min(100, Math.round(done / all * 100)) : 0}%"></i>`;
    board.innerHTML = `<b>${p.percent === null ? '공동 계획 준비 중' : `AI 목표 진행 ${p.percent}%`}</b> <small>${p.percent === 100 ? '목표 완료!' : STAGE[p.stage]}</small><div class="hs-bar-all">${bar(p.percent, 100)}</div>
      ${p.rooms.map((r, i) => `<button type="button" data-room="${i}" title="이 방으로 이동"><span>${esc(r.name)}</span><em style="color:${COLORS[r.owner] || 'var(--muted)'}">${esc(data.names[r.owner] || r.owner || '참가자 대기')}</em>
        <div class="hs-bar-room">${bar(r.floor, r.floorTotal)}</div><small>바닥 ${r.floor}/${r.floorTotal} · 가구 ${r.count}/${r.min}</small></button>`).join('')}`;
  }
  renderRoom();
  const vote = data.vote, votePanel = $('#hsVote');
  votePanel.hidden = !vote || vote.status !== 'open';
  if (!votePanel.hidden) {
    if (vote.ballots) renderJoint(vote, votePanel);
    else {
    votePanel.innerHTML = `<b>인테리어 의견이 갈렸어요</b><small>${time(vote.deadline)}까지 선택 · 미참여 시 기본안으로 진행 · 다른 공사는 계속됩니다.</small>`
      + vote.options.map((o, i) => `<button type="button" data-vote="${i}"><b>${esc(data.names[o.by] || o.by)}: ${esc(o.label)}</b><span>실제 발언: ${esc(o.say)}</span></button>`).join('');
    votePanel.querySelectorAll('[data-vote]').forEach((b) => {
      b.onclick = async () => {
        votePanel.querySelectorAll('button').forEach((button) => { button.disabled = true; });
        try { await send('/api/house/vote', { voteId: vote.id, choice: Number(b.dataset.vote) }); }
        catch (e) { error(e.message); await load(); }
      };
    });
    }
  }
  const next = JSON.stringify(data.log);
  if (next === logKey) return;
  logKey = next;
  const who = (id) => data.names[id] || (id === 'user' ? data.userName : id === 'house' ? '🏠 집' : id);
  const list = $('#hsLogList');
  list.innerHTML = data.log.slice(-30).map((l) => `<div class="hs-line ${esc(l.kind)}"><b style="color:${COLORS[l.id] || 'inherit'}">${esc(who(l.id))}</b> ${l.kind === 'build' ? '🔨 ' : l.kind === 'event' ? '[자동 연출/기록] ' : ''}${esc(l.text)}</div>`).join('') || '<div class="hs-line">아직 대화가 없어요.</div>';
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
  panel.querySelectorAll('[data-activity-follow]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.activityFollow === id)));
}
function renderActivity() {
  if (!data) return;
  $('#hsActivity').hidden = data.vote?.status === 'open';
  panel.querySelectorAll('[data-activity-follow]').forEach((button) => {
    const id = button.dataset.activityFollow;
    button.hidden = !data.agents[id];
    const name = data.names[id] || id;
    const action = scene?.agents[id]?.action || actorActivity({
      working: data.workingActor === id, doing: data.agents[id]?.doing, paused: data.talk === false,
    });
    button.querySelector('b').textContent = name;
    button.querySelector('span').textContent = data.agents[id] ? action : '참여하지 않음';
    button.disabled = !scene?.agents[id];
    button.setAttribute('aria-label', `${name} 따라가기 · ${action}`);
    button.setAttribute('aria-pressed', String(scene?.follow === id));
  });
  const latest = scene ? scene.latestCompletion : data.log.findLast((entry) => entry.kind === 'build');
  const text = latest ? `${data.names[latest.id] || latest.id} · ${latest.text}` : '아직 완료한 작업이 없어요.';
  $('#hsActivityRecent').textContent = text;
  $('#hsActivityRecent').title = text;
}
function renderRoom() {
  const room = data?.progress?.rooms[selectedRoom], card = $('#hsRoom');
  card.hidden = !room;
  if (!room) return;
  card.innerHTML = `<button type="button" aria-label="방 상세 닫기">×</button><b>${esc(room.name)}</b>
    <p>현재 담당 ${esc(data.names[room.owner] || room.owner || '참가자 대기')}</p>
    <p>바닥 ${room.floor}/${room.floorTotal} · 가구 ${room.count}/${room.min}</p>
    <small>${room.accessible ? '출입 가능' : '통로 확인 필요'}${room.missingUses?.length ? ' · 필수 가구 미완료' : ''}</small>`;
  card.querySelector('button').onclick = () => { selectedRoom = -1; renderRoom(); };
}
$('#hsProgress').onclick = (e) => {
  const b = e.target.closest('[data-room]');
  const room = b && data?.progress?.rooms[Number(b.dataset.room)];
  if (room) { selectedRoom = Number(b.dataset.room); renderRoom(); scene?.focusAt(room.x, room.z); showFollow(); }
};
$('#hsReset').onclick = () => { scene?.reset(); showFollow(); };
function followActor(id) {
  if (!scene || !scene.agents[id]) return;
  scene.follow = scene.follow === id ? null : id;
  if (scene.follow) scene.zoom = .65;
  showFollow();
}
$('#hsFollow').onclick = (e) => {
  const button = e.target.closest('[data-follow]');
  if (button) followActor(button.dataset.follow);
};
$('#hsActivityBody').onclick = (e) => {
  const button = e.target.closest('[data-activity-follow]');
  if (button) followActor(button.dataset.activityFollow);
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
canvas.onpointerdown = (e) => { canvas.focus(); drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false, pan: e.button === 2 || e.shiftKey }; canvas.setPointerCapture(e.pointerId); };
canvas.onpointermove = (e) => {
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 5) drag.moved = true;
  if (!drag.moved) return;
  scene?.orbit(e.clientX - drag.x, e.clientY - drag.y, drag.pan);
  drag.x = e.clientX; drag.y = e.clientY;
};
canvas.onpointerup = (e) => {
  if (drag && !drag.moved && !drag.pan) { selectedRoom = scene?.pickRoom(e.clientX, e.clientY) ?? -1; renderRoom(); }
  drag = null; showFollow();
};
canvas.onpointercancel = canvas.onlostpointercapture = () => { drag = null; showFollow(); };
canvas.addEventListener('wheel', (e) => { e.preventDefault(); scene?.magnify(e.deltaY); }, { passive: false });
$('#hsChat').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#hsChatInput'), text = input.value.trim();
  if (!text) return;
  try {
    const res = await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ...(document.body.dataset.role === 'guest' ? {} : { mode: 'house' }) }) });
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
  if (eventId) {
    openPanels.add('hsDiary'); diaryKey = '';
    panel.querySelector('[data-panel="hsDiary"]').setAttribute('aria-expanded', 'true');
  }
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
window.addEventListener('house-open', () => openHouse());
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
