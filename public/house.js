// The house UI keeps its existing API and saved grid; only its visual view changes.
// PC: top bar, left icon rail, one right-hand panel at a time, chat (bottom left) and work status (bottom right).
// Phone: the same parts live in a bottom sheet with tabs; the view gets pinch zoom, a joystick and an E button.
import { esc, lineIcon } from './format.mjs';
import { bindHouseControls, stickKey } from './house-controls.mjs';
import { actorActivity } from './house-view.mjs';
import { voteHeaderHTML, voteCardHTML, bindVoteCard } from './joint-vote.mjs';

const COLORS = { claude: '#d97a3a', gpt: '#2f7cf6', gemini: '#5b6cf0' };
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON = {
  close: svg('M6 6l12 12M18 6L6 18'), camera: svg('M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z'),
  me: svg('M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c.8-4 4-6 8-6s7.2 2 8 6'), plan: svg('M8 4h8v3H8zM6 5H5v16h14V5h-1M8 11h8M8 15h5'),
  progress: svg('M4 20h16M7 16V11M12 16V7M17 16v-3'),
  moon: svg('M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'), sun: svg('M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'),
};
const PANELS = [['hsPlan', '계획', ICON.plan], ['hsProgress', '진행', ICON.progress], ['hsDiary', '기록', lineIcon('book')], ['hsVotes', '투표', lineIcon('vote')]];
const TABS = [['log', '대화'], ['activity', '작업'], ...PANELS.map(([id, name]) => [id, name])];
const panel = document.createElement('section');
panel.id = 'house'; panel.className = 'house'; panel.hidden = true;
panel.setAttribute('aria-label', '집');
panel.innerHTML = `
  <header class="hs-bar">
    <b class="hs-name">${lineIcon('house')}집</b><span id="hsStatus" role="status"></span>
    <span class="hs-bar-actions">
      <button type="button" id="hsContinueSolo" class="hs-text-btn" hidden>혼자 계속하기</button>
      <label class="hs-switch" id="hsActiveWrap" title="켜면 AI들이 집짓기를 이어가요"><span>자동 실행</span><span class="switch"><input type="checkbox" id="hsActive" aria-label="집 자동 실행"><span></span></span></label>
      <button type="button" class="hs-icon" id="hsNight" aria-pressed="false" aria-label="밤으로 바꾸기" title="밤으로 바꾸기">${ICON.moon}</button>
      <button type="button" class="hs-icon" id="hsPhoto" aria-label="사진 저장" title="사진 저장" disabled>${ICON.camera}</button>
      <button type="button" class="hs-icon" id="hsClose" aria-label="집 닫고 채팅방으로" title="채팅방으로">${ICON.close}</button>
    </span>
  </header>
  <canvas id="hsCanvas" tabindex="0" aria-label="AI들이 함께 짓는 3D 집. 캐릭터를 누르면 그 캐릭터의 시점으로 볼 수 있고, 내 캐릭터는 방향키로 걷고 E키로 상호작용해요."></canvas>
  <nav class="hs-rail" aria-label="집 보기와 정보">
    <button type="button" class="hs-rail-btn" id="hsReset" aria-pressed="true" title="집 전체 보기">${lineIcon('house')}<span>전체</span></button>
    <button type="button" class="hs-rail-btn" id="hsPlayer" title="내 캐릭터 시점으로 보기" hidden>${ICON.me}<span>나</span></button>
    <hr>
    ${PANELS.map(([id, name, icon]) => `<button type="button" class="hs-rail-btn" data-panel="${id}" aria-expanded="false" title="${name}">${icon}<span>${name}</span>${id === 'hsVotes' ? '<i class="hs-dot" data-vote-dot hidden></i>' : ''}</button>`).join('')}
  </nav>
  <div class="hs-viewbar" id="hsViewbar" hidden>
    <span id="hsViewWho"></span>
    <span class="hs-seg" role="group" aria-label="시점"><button type="button" data-view="overview">전체</button><button type="button" data-view="third">3인칭</button><button type="button" data-view="first">1인칭</button></span>
    <button type="button" class="hs-icon" id="hsViewClose" aria-label="선택 해제" title="선택 해제 (Esc)">${ICON.close}</button>
  </div>
  <p class="hs-empty" id="hsEmpty" hidden>아직 아무것도 없어요.<br>집 자동 실행을 켜면 AI들이 집을 짓기 시작해요.</p>
  <p class="hs-error" id="hsError" role="alert" hidden></p>
  <aside class="hs-room" id="hsRoom" aria-label="선택한 방" hidden></aside>
  <div class="hs-dock" id="hsDock" data-sheet="log" data-height="peek">
    <div class="hs-sheet-head">
      <button type="button" class="hs-grip" id="hsGrip" aria-label="패널 크기 바꾸기"><i></i></button>
      <div class="hs-tabs" role="tablist" aria-label="집 정보">${TABS.map(([id, name]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${id === 'log'}">${name}${id === 'hsVotes' ? '<i class="hs-dot" data-vote-dot hidden></i>' : ''}</button>`).join('')}</div>
    </div>
    <aside class="hs-side" id="hsSide" hidden>
      <section class="hs-part" id="hsPlan" data-part="hsPlan" hidden><h3>${ICON.plan}공동 계획</h3><p id="hsPlanText"></p></section>
      <section class="hs-part" id="hsProgress" data-part="hsProgress" aria-label="공사 진행" hidden></section>
      <section class="hs-part hs-diary" id="hsDiary" data-part="hsDiary" aria-label="집 기록" hidden>
        <header><h3>${lineIcon('book')}집 기록</h3><div class="hs-mode" id="hsMode" role="group" aria-label="집 운영 방식">
          <button type="button" data-mode="auto" title="AI들이 거의 모든 일을 알아서 정해요">${lineIcon('bot')}자율</button>
          <button type="button" data-mode="balanced" title="큰 일만 물어보고 나머지는 알아서 정해요 (기본)">${lineIcon('scale')}중요만</button>
          <button type="button" data-mode="together" title="작은 의견 차이도 한마디 할 기회를 줘요">${lineIcon('game')}함께</button></div></header>
        <section class="hs-selected-event" id="hsSelectedEvent" tabindex="-1" hidden></section>
        <div class="hs-ask" id="hsAsk" hidden></div><div class="hs-undo" id="hsUndo" hidden></div><div id="hsEvents"></div>
      </section>
      <section class="hs-part" id="hsVotes" data-part="hsVotes" aria-label="투표" hidden>
        <h3>${lineIcon('vote')}투표</h3>
        <div class="hs-vote" id="hsVote" aria-label="인테리어 투표" hidden></div>
        <div class="hs-story" id="hsStory" aria-label="공동 스토리 투표" hidden></div>
        <p class="hs-note" id="hsVotesEmpty">지금 열린 투표가 없어요. 의견이 갈리면 여기에 투표가 열려요.</p>
      </section>
    </aside>
    <aside class="hs-activity" id="hsActivity" data-part="activity" aria-label="작업현황">
      <h3>${lineIcon('tool')}작업현황 <small>눌러서 시점 선택</small></h3>
      <div id="hsActivityBody"></div>
      <p class="hs-activity-recent"><small>최근 완료</small><span id="hsActivityRecent"></span></p>
    </aside>
    <section class="hs-log" id="hsLog" data-part="log" aria-label="집 대화">
      <button type="button" id="hsLogToggle" aria-expanded="true">대화 접기 ▾</button>
      <div id="hsLogList" aria-live="polite"></div>
      <form id="hsChat" autocomplete="off"><input id="hsChatInput" maxlength="2000" placeholder="AI들에게 말 걸기 (@이름으로 지정)" aria-label="집에서 말하기"><button type="submit">보내기</button></form>
    </section>
  </div>
  <div class="hs-pad" id="hsPad" hidden>
    <div class="hs-stick" id="hsStick" role="application" aria-label="내 캐릭터 이동 조이스틱"><i id="hsKnob"></i></div>
    <button type="button" class="hs-act" id="hsInteract" aria-label="상호작용: 앉기·눕기·인사">E</button>
  </div>
  <p class="hs-help">드래그: 회전 · 휠: 확대/축소 · 우클릭/Shift 드래그: 이동 · 캐릭터 클릭: 시점 선택<br><span id="hsPlayerHelp" hidden>방향키: 걷기 · E: 앉기/눕기/AI에게 인사 · Esc: 전체 보기</span></p>`;
document.body.append(panel);
const $ = (s) => panel.querySelector(s);
const opener = document.querySelector('#houseBtn'), canvas = $('#hsCanvas'), dock = $('#hsDock');
const phone = matchMedia('(max-width: 640px)'), touch = matchMedia('(pointer: coarse)');
const guestPage = document.body.dataset.role === 'guest';
let data = null, timer = 0, raf = 0, logKey = '', diaryKey = '', voteSeen = '';
let scene = null, initializing = null, loading = false;
let selectedEventId = null, selectedRoom = -1, activityAt = 0;
const openPanels = new Set();
// Day or night is each viewer's own choice, remembered on this device.
let night = false;
try { night = localStorage.getItem('house-night') === '1'; } catch {}
function applyNight() {
  panel.classList.toggle('night', night);
  const button = $('#hsNight');
  button.innerHTML = night ? ICON.sun : ICON.moon;
  button.setAttribute('aria-pressed', String(night));
  button.setAttribute('aria-label', night ? '낮으로 바꾸기' : '밤으로 바꾸기'); button.title = button.getAttribute('aria-label');
  scene?.setNight(night);
}
$('#hsNight').onclick = () => { night = !night; try { localStorage.setItem('house-night', night ? '1' : '0'); } catch {} applyNight(); };
applyNight();
// Which part is showing: PC opens one side panel from the rail; the phone sheet shows the selected tab.
const isOpen = (part) => (phone.matches ? dock.dataset.sheet === part : openPanels.has(part));
const isPerson = (id) => id === 'user' || String(id).startsWith('guest:');
const nameOf = (id) => (id === 'user' ? data?.userName : data?.people?.[id]?.name || data?.names?.[id] || id);
// The joystick sits just above the phone sheet, whatever its height.
new ResizeObserver(() => panel.style.setProperty('--hs-sheet-h', `${Math.ceil(dock.getBoundingClientRect().height)}px`)).observe(dock);

function togglePanel(id) {
  const wasOpen = openPanels.has(id);
  openPanels.clear();
  if (!wasOpen) openPanels.add(id);
  diaryKey = ''; layout();
}
panel.querySelectorAll('[data-panel]').forEach((button) => { button.onclick = () => togglePanel(button.dataset.panel); });
function selectTab(id) {
  dock.dataset.sheet = id;
  if (dock.dataset.height === 'peek' && id !== 'log') dock.dataset.height = 'half';
  diaryKey = ''; layout();
}
panel.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => selectTab(button.dataset.tab); });
// The sheet grows peek -> half -> full on a tap, or follows a drag on the grip.
const HEIGHTS = ['peek', 'half', 'full'];
let grip = null;
$('#hsGrip').onpointerdown = (e) => { grip = { y: e.clientY, moved: false }; $('#hsGrip').setPointerCapture(e.pointerId); };
$('#hsGrip').onpointermove = (e) => {
  if (!grip || Math.abs(e.clientY - grip.y) < 40) return;
  const i = HEIGHTS.indexOf(dock.dataset.height) + (e.clientY < grip.y ? 1 : -1);
  dock.dataset.height = HEIGHTS[Math.max(0, Math.min(2, i))]; grip = { y: e.clientY, moved: true };
};
$('#hsGrip').onpointerup = () => {
  if (grip && !grip.moved) dock.dataset.height = HEIGHTS[(HEIGHTS.indexOf(dock.dataset.height) + 1) % 3];
  grip = null;
};
// Applies which parts show for the current screen size.
function layout() {
  panel.querySelectorAll('[data-panel]').forEach((b) => b.setAttribute('aria-expanded', String(openPanels.has(b.dataset.panel))));
  panel.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === dock.dataset.sheet)));
  $('#hsSide').hidden = !phone.matches && !openPanels.size;
  if (data) renderSide();
  renderPad();
}
phone.addEventListener('change', layout); touch.addEventListener('change', layout);

function error(message) { $('#hsError').hidden = false; $('#hsError').textContent = message; }
const controls = bindHouseControls(panel, {
  ready: () => !panel.hidden && !!data?.player && !!scene,
  angle: () => scene?.angle || 0,
  send: (body) => send('/api/house/player', body),
  error,
});
canvas.addEventListener('house-render-error', (e) => { error(e.detail); $('#hsPhoto').disabled = true; });
canvas.addEventListener('house-follow-change', renderView);
$('#hsContinueSolo').onclick = () => send('/api/house/continue-solo', {}).catch((e) => error(e.message));
$('#hsActive').onchange = (e) => send('/api/house/active', { active: e.target.checked }).catch((err) => { e.target.checked = !!data?.active; error(err.message); });
async function initialize() {
  if (scene) return;
  initializing ||= import('./house-scene.mjs').then(({ HouseScene }) => {
    scene = new HouseScene(canvas);
    scene.setNight(night);
    $('#hsPhoto').disabled = false;
    if (data) scene.update(data);
  });
  try { await initializing; } catch (e) { error(`3D 화면을 열 수 없어요: ${e.message}`); }
}
function frame(now) {
  if (panel.hidden) return;
  scene?.render(now);
  panel.querySelectorAll('[data-deadline]').forEach((el) => {
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
  $('#hsDiary').hidden = !isOpen('hsDiary');
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
  const canAct = current && (data.open.stage === 'conflict' || ask) && data.role !== 'guest';
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
  $('#hsUndo').hidden = !data.undo || data.role === 'guest';
  if (!$('#hsUndo').hidden) {
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
  const expanded = vote.status === 'open' || (target.querySelector('details')?.open ?? false);
  target.innerHTML = `<details ${expanded ? 'open' : ''}><summary class="joint-vote-summary">${voteHeaderHTML(vote)}<small>${story ? `EPISODE ${String(vote.episode).padStart(2, '0')} · ` : ''}${esc(vote.title || '공동 인테리어 투표')}</small></summary>${voteCardHTML(vote, data, { header: false })}</details>`;
  bindVoteCard(target, vote, async (body) => {
    await send('/api/house/ballot', body);
    window.dispatchEvent(new Event('house-update'));
  });
}
function renderVotes() {
  const story = data.story?.current, vote = data.vote;
  const open = [story?.status === 'open' && story, vote?.status === 'open' && vote].filter(Boolean);
  const waiting = open.filter((v) => v.myChoice === null || v.myChoice === undefined);
  panel.querySelectorAll('[data-vote-dot]').forEach((dot) => { dot.hidden = !waiting.length; });
  // A newly opened vote opens the vote panel once on PC (unless another panel is open) so it is not missed.
  const key = open.map((v) => v.id).join(',');
  if (key && key !== voteSeen && !phone.matches && !openPanels.size) { openPanels.add('hsVotes'); layout(); }
  voteSeen = key;
  const shown = isOpen('hsVotes');
  $('#hsVotes').hidden = !shown;
  if (!shown) return;
  renderJoint(story, $('#hsStory'), true);
  const votePanel = $('#hsVote');
  votePanel.hidden = !vote || vote.status !== 'open';
  if (!votePanel.hidden) {
    if (vote.ballots) renderJoint(vote, votePanel);
    else {
      votePanel.innerHTML = `<b>인테리어 의견이 갈렸어요</b><small>${time(vote.deadline)}까지 선택 · 미참여 시 기본안으로 진행 · 다른 공사는 계속됩니다.</small>`
        + vote.options.map((o, i) => `<button type="button" data-vote="${i}"><b>${esc(data.names[o.by] || o.by)}: ${esc(o.label)}</b><span>실제 발언: ${esc(o.say)}</span></button>`).join('');
      votePanel.querySelectorAll('[data-vote]').forEach((b) => {
        b.onclick = async () => {
          votePanel.querySelectorAll('button').forEach((button) => { button.disabled = true; });
          try { await send('/api/house/vote', { voteId: vote.id, choice: Number(b.dataset.vote) }); } catch (e) { error(e.message); await load(); }
        };
      });
    }
  }
  $('#hsVotesEmpty').hidden = !$('#hsStory').hidden || !votePanel.hidden;
}
function renderSide() {
  const guest = data.role === 'guest';
  $('#hsMode').hidden = guest;
  $('#hsActiveWrap').hidden = guest;
  $('#hsActive').checked = !!data.active;
  renderDiary();
  renderVotes();
  renderActivity();
  $('#hsPlayer').hidden = $('#hsPlayerHelp').hidden = !data.player;
  const talk = data.crew?.waiting ? '건축 AI 호출은 쉬고 있어요. 일반 채팅은 계속할 수 있습니다.'
    : data.talk ? (data.busy ? 'AI가 계획을 검토하고 있어요' : data.nextAt > Date.now() ? '호출 오류로 재시도 대기 중' : '집 자동 실행 켜짐 · 작업을 이어가요') : '집 자동 실행 꺼짐 · 켜면 다시 움직여요';
  $('#hsStatus').textContent = `${data.crew?.waiting ? '동료 복귀 대기' : data.progress?.stage === 'planning' ? 'AI 공동 계획 논의 중' : data.progress ? `전체 공사 ${data.progress.percent}%` : data.phase === 'life' ? '기본 집 완성' : '집 짓는 중'}${data.talk ? '' : ' · 일시정지'}`;
  $('#hsContinueSolo').hidden = guest || !data.crew?.waiting || Object.keys(data.agents).length !== 1;
  $('#hsStatus').title = talk;
  $('#hsEmpty').hidden = !!(data.floors.length || data.walls.length || data.items.length);
  $('#hsPlan').hidden = !isOpen('hsPlan');
  const handoff = data.crew?.handoff;
  $('#hsPlanText').textContent = (data.plan || '아직 공동 계획이 없어요.') + (handoff
    ? `\n최근 작업 인계 (${handoff.source === 'ai' ? 'AI가 남긴 다음 작업' : '저장 상태 기준'})\n완료: ${handoff.completed}\n남은 일: ${handoff.remaining}\n다음: ${handoff.next} (${handoff.location.x}, ${handoff.location.z})` : '');
  if (data.story) $('#hsPlanText').textContent += `\n공동 집 환경: 지붕 ${data.story.environment.roof} · 자재 ${data.story.environment.materials} · 마당 ${data.story.environment.yard || '미정'} · 다음 방 ${data.story.environment.room || '미정'}`;
  const p = data.progress, board = $('#hsProgress');
  board.hidden = !isOpen('hsProgress');
  if (!board.hidden) {
    const STAGE = { planning: 'AI가 목표와 방 구성을 정하고 있어요', floor: '바닥 목표 진행 중', wall: '벽·문 목표 진행 중', furniture: '가구·통로 목표 진행 중' };
    const bar = (done, all) => `<i style="width:${all ? Math.min(100, Math.round(done / all * 100)) : 0}%"></i>`;
    board.innerHTML = !p ? `<h3>${ICON.progress}진행 상세</h3><p class="hs-note">공동 계획이 정해지면 방별 진행이 보여요.</p>`
      : `<h3>${ICON.progress}진행 상세</h3><b>${p.percent === null ? '공동 계획 준비 중' : `AI 목표 진행 ${p.percent}%`}</b> <small>${p.percent === 100 ? '목표 완료!' : STAGE[p.stage]}</small><div class="hs-bar-all">${bar(p.percent, 100)}</div>
      ${p.rooms.map((r, i) => `<button type="button" data-room="${i}" title="이 방으로 이동"><span>${esc(r.name)}</span><em style="color:${COLORS[r.owner] || 'var(--muted)'}">${esc(data.names[r.owner] || r.owner || '참가자 대기')}</em>
        <div class="hs-bar-room">${bar(r.floor, r.floorTotal)}</div><small>바닥 ${r.floor}/${r.floorTotal} · 가구 ${r.count}/${r.min}</small></button>`).join('')}`;
  }
  renderRoom();
  renderView();
  renderPad();
  const next = JSON.stringify(data.log);
  if (next === logKey) return;
  logKey = next;
  const list = $('#hsLogList');
  list.innerHTML = data.log.slice(-30).map((l) => `<div class="hs-line ${esc(l.kind)}${isPerson(l.id) ? ' mine' : ''}"><b style="color:${COLORS[l.id] || 'inherit'}">${esc(l.id === 'house' ? '집' : nameOf(l.id))}</b> ${l.kind === 'build' ? lineIcon('tool', 'line-ic sm') : l.kind === 'event' ? '[자동 연출/기록] ' : ''}${esc(l.text.replace(/^\p{Extended_Pictographic}️?\s*/u, ''))}</div>`).join('') || '<div class="hs-line">아직 대화가 없어요.</div>';
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
// The selected character and how it is viewed: the bar offers overview / third / first person.
function renderView() {
  const id = scene?.follow || null, view = scene?.view || 'overview';
  $('#hsReset').setAttribute('aria-pressed', String(!id));
  $('#hsPlayer').setAttribute('aria-pressed', String(!!id && id === data?.selfPerson));
  $('#hsViewbar').hidden = !id;
  if (id) {
    $('#hsViewWho').textContent = `${nameOf(id)}${id === data?.selfPerson ? ' (나)' : ''} ${view === 'overview' ? '따라가기' : view === 'third' ? '3인칭 시점' : '1인칭 시점'}`;
    panel.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  }
  panel.classList.toggle('riding', view !== 'overview');
  panel.querySelectorAll('[data-activity-follow]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.activityFollow === id)));
}
function select(id, view = scene?.view || 'overview') {
  if (!scene || !scene.agents[id]) return;
  scene.follow = id;
  if (view === 'overview') { scene.view = 'overview'; scene.zoom = .65; } else scene.setView(view, id);
  renderView();
}
panel.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => { if (scene?.follow) select(scene.follow, b.dataset.view); }; });
$('#hsViewClose').onclick = () => { scene?.reset(); renderView(); };
$('#hsPlayer').onclick = () => { if (data?.selfPerson) select(data.selfPerson, 'third'); canvas.focus(); };
function renderActivity() {
  if (!data) return;
  const body = $('#hsActivityBody');
  const ids = [...Object.keys(data.agents), ...Object.keys(data.people || {})];
  if (body.dataset.ids !== ids.join(',')) {
    body.dataset.ids = ids.join(',');
    body.innerHTML = ids.map((id) => `<button type="button" class="hs-activity-row" data-activity-follow="${esc(id)}" aria-pressed="false">
      <i aria-hidden="true" style="background:${COLORS[id] || (isPerson(id) ? 'var(--accent)' : '#777')}"></i><b></b><span></span></button>`).join('')
      || '<p class="hs-note">참여 중인 캐릭터가 없어요.</p>';
  }
  body.querySelectorAll('[data-activity-follow]').forEach((button) => {
    const id = button.dataset.activityFollow, member = data.agents[id] || data.people?.[id];
    const name = `${nameOf(id)}${id === data.selfPerson ? ' (나)' : ''}`;
    const action = scene?.agents[id]?.action || actorActivity({ working: data.workingActor === id, doing: member?.doing, paused: !isPerson(id) && data.talk === false });
    button.querySelector('b').textContent = name;
    button.querySelector('span').textContent = action;
    button.disabled = !scene?.agents[id];
    button.setAttribute('aria-label', `${name} 시점 선택 · ${action}`);
  });
  const latest = scene ? scene.latestCompletion : data.log.findLast((entry) => entry.kind === 'build');
  const text = latest ? `${nameOf(latest.id)} · ${latest.text}` : '아직 완료한 작업이 없어요.';
  $('#hsActivityRecent').textContent = text;
  $('#hsActivityRecent').title = text;
}
$('#hsActivityBody').onclick = (e) => {
  const button = e.target.closest('[data-activity-follow]');
  if (!button) return;
  const id = button.dataset.activityFollow;
  if (scene?.follow === id) { scene.reset(); renderView(); } else select(id);
};
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
  if (room) { selectedRoom = Number(b.dataset.room); renderRoom(); scene?.focusAt(room.x, room.z); renderView(); }
};
$('#hsReset').onclick = () => { scene?.reset(); renderView(); };
$('#hsPhoto').onclick = () => {
  if (!scene || !data) return;
  scene.photo().toBlob((blob) => {
    if (!blob) { error('사진을 저장할 수 없어요.'); return; }
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `house-${new Date().toISOString().replaceAll(':', '-')}.png`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, 'image/png');
};
// Pointer input on the view: one finger/mouse drags to turn (right button or Shift pans), two fingers pinch to zoom
// and drag to pan, and a tap picks a character (to view as) or a room.
const pointers = new Map();
let drag = null, pinch = null;
const spread = () => { const [a, b] = [...pointers.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
canvas.oncontextmenu = (e) => e.preventDefault();
canvas.onpointerdown = (e) => {
  canvas.focus(); canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { pinch = spread(); drag = null; return; }
  drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false, pan: e.button === 2 || e.shiftKey };
};
canvas.onpointermove = (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const now = spread();
    scene?.magnify((pinch.d - now.d) * 4);
    if (scene?.view === 'overview') scene.orbit(now.x - pinch.x, now.y - pinch.y, true);
    pinch = now; return;
  }
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 6) drag.moved = true;
  if (!drag.moved) return;
  scene?.orbit(e.clientX - drag.x, e.clientY - drag.y, drag.pan);
  drag.x = e.clientX; drag.y = e.clientY;
};
const release = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (e.type === 'pointerup' && drag && !drag.moved && !drag.pan && pointers.size === 0) {
    const id = scene?.pickActor(e.clientX, e.clientY);
    if (id) select(id);
    else { selectedRoom = scene?.pickRoom(e.clientX, e.clientY) ?? -1; renderRoom(); }
  }
  if (!pointers.size) drag = null;
  renderView();
};
canvas.onpointerup = release;
canvas.onpointercancel = release;
canvas.addEventListener('wheel', (e) => { e.preventDefault(); scene?.magnify(e.deltaY); }, { passive: false });
// The on-screen joystick and E button appear on touch screens once the viewer's own character is in the house.
function renderPad() {
  $('#hsPad').hidden = !data?.player || !(phone.matches || touch.matches);
  // The button says what it would do next to whatever is near: 앉기 · 눕기 · 인사 · 일어나기; dim with nothing near.
  const near = data?.nearby, button = $('#hsInteract');
  const label = near?.label || 'E';
  if (button.textContent !== label) button.textContent = label;
  button.classList.toggle('is-idle', !near);
  button.classList.toggle('is-word', !!near);
  button.setAttribute('aria-label', near ? `${near.label}${near.target ? ` · ${nameOf(near.target)}` : ''}` : '상호작용 (근처에 앉거나 인사할 대상이 없어요)');
}
let stick = null;
const knob = $('#hsKnob');
$('#hsStick').onpointerdown = (e) => {
  const rect = $('#hsStick').getBoundingClientRect();
  stick = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  $('#hsStick').setPointerCapture(e.pointerId); moveStick(e);
};
function moveStick(e) {
  if (!stick) return;
  let dx = e.clientX - stick.x, dy = e.clientY - stick.y;
  const d = Math.hypot(dx, dy), max = 38;
  if (d > max) { dx = dx / d * max; dy = dy / d * max; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  controls.hold(stickKey(dx, dy));
}
$('#hsStick').onpointermove = moveStick;
$('#hsStick').onpointerup = $('#hsStick').onpointercancel = () => { stick = null; knob.style.transform = ''; controls.hold(null); };
$('#hsInteract').onclick = () => controls.interact();
$('#hsChat').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#hsChatInput'), text = input.value.trim();
  if (!text) return;
  try {
    const res = await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ...(guestPage ? { fromHouse: true } : { mode: 'house' }) }) });
    const value = await res.json();
    if (!res.ok) throw new Error(value.error || `요청 실패 (${res.status})`);
    input.value = ''; $('#hsError').hidden = true; load();
  } catch (err) { error(err.message); }
};
// On a phone the folded sheet shows only the last few lines; a tap on them, or on the message box, opens it to half.
const unfold = () => { if (phone.matches && dock.dataset.height === 'peek') { dock.dataset.height = 'half'; requestAnimationFrame(() => { $('#hsLogList').scrollTop = $('#hsLogList').scrollHeight; }); } };
$('#hsLogList').addEventListener('click', unfold);
$('#hsChatInput').addEventListener('focus', unfold);
$('#hsLogToggle').onclick = () => {
  const open = $('#hsLogList').hidden;
  $('#hsLogList').hidden = !open; $('#hsChat').hidden = !open; $('#hsLogToggle').setAttribute('aria-expanded', String(open));
  $('#hsLogToggle').textContent = open ? '대화 접기 ▾' : '대화 열기 ▴';
};
async function openHouse(eventId = null) {
  selectedEventId = eventId;
  if (eventId) {
    if (phone.matches) { dock.dataset.sheet = 'hsDiary'; dock.dataset.height = 'half'; } else { openPanels.clear(); openPanels.add('hsDiary'); }
    diaryKey = '';
  }
  panel.hidden = false; document.querySelector('#app').inert = true; opener.setAttribute('aria-expanded', 'true');
  layout();
  const ready = Promise.all([initialize(), load()]);
  clearInterval(timer); timer = setInterval(load, 20000);
  cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); $('#hsClose').focus();
  await ready;
  if (panel.hidden || !data) return;
  layout();
  if (eventId) {
    const event = data.events.find((e) => e.id === eventId);
    const actors = event?.actors || (data.open?.eventId === eventId ? data.open.pair : []);
    scene?.focusActors(actors); renderView();
    if (!$('#hsSelectedEvent').hidden) $('#hsSelectedEvent').focus();
  }
}
opener.onclick = () => openHouse();
window.addEventListener('house-open', () => openHouse());
window.addEventListener('house-open-event', (e) => {
  if (Number.isInteger(e.detail?.id) && e.detail.id > 0) openHouse(e.detail.id);
});
$('#hsClose').onclick = () => {
  controls.clear();
  panel.hidden = true; document.querySelector('#app').inert = false;
  opener.setAttribute('aria-expanded', 'false'); opener.focus();
  clearInterval(timer); cancelAnimationFrame(raf); raf = 0;
  if (scene) { scene.last = 0; scene.reset(); }
};
// Esc first leaves a character's view, then closes the house.
panel.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (scene?.follow) { scene.reset(); renderView(); } else $('#hsClose').click();
});
window.addEventListener('house-update', () => { if (!panel.hidden) load(); });
