// The shared house: an isometric canvas view of what the AI members built (GET /api/house).
// Plain 2D canvas on purpose: the page allows only same-origin scripts, so no 3D library is loaded.
import { rotateParts } from './house-shape.mjs';
import { esc } from './format.mjs';

const IDS = ['claude', 'gpt', 'gemini'];
const COLORS = { claude: '#d97a3a', gpt: '#2f7cf6', gemini: '#5b6cf0' };
const TW = 64, TH = 32, UNIT = 30;
// A full-screen view opened from the 🏠 button in the chat header.
const panel = document.createElement('section');
panel.id = 'house'; panel.className = 'house'; panel.hidden = true;
panel.setAttribute('aria-label', '집');
panel.innerHTML = `
  <header class="hs-bar"><b>집</b><span id="hsStatus" role="status"></span><button type="button" id="hsClose" aria-label="집 닫고 채팅방으로" title="채팅방으로"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></header>
  <canvas id="hsCanvas" aria-label="AI들이 함께 짓는 집"></canvas>
  <p class="hs-empty" id="hsEmpty" hidden>아직 아무것도 없어요.<br>Talk가 켜져 있으면 AI들이 천천히 집을 짓기 시작해요.</p>
  <aside class="hs-plan" id="hsPlan" hidden><b>공동 계획</b><p id="hsPlanText"></p></aside>
  <aside class="hs-diary" id="hsDiary" hidden aria-label="집 기록">
    <header><b>📖 집 기록</b><div class="hs-mode" id="hsMode" role="group" aria-label="집 운영 방식">
      <button type="button" data-mode="auto" title="AI들이 거의 모든 일을 알아서 정해요">🤖 자율</button>
      <button type="button" data-mode="balanced" title="큰 일만 물어보고 나머지는 알아서 정해요 (기본)">⚖️ 중요만</button>
      <button type="button" data-mode="together" title="작은 의견 차이도 한마디 할 기회를 줘요">🎮 함께</button></div></header>
    <div class="hs-ask" id="hsAsk" hidden></div>
    <div class="hs-undo" id="hsUndo" hidden></div>
    <div id="hsEvents"></div>
    <small class="hs-note">캐릭터들의 생활 기록이에요. 실제 감정이 아니라 앱이 정한 캐릭터 상태예요.</small>
  </aside>
  <section class="hs-log" id="hsLog" aria-label="집 대화"><button type="button" id="hsLogToggle" aria-expanded="true">대화 접기 ▾</button><div id="hsLogList" aria-live="polite"></div></section>
  <p class="hs-help">드래그: 이동 · 휠: 확대/축소</p>`;
document.body.append(panel);
const $ = (s) => panel.querySelector(s);
const opener = document.querySelector('#houseBtn');
const canvas = $('#hsCanvas'), ctx = canvas.getContext('2d');
let data = null, timer = 0, raf = 0, logKey = '';
const cam = { x: 0, y: 0, s: 1 };
const pos = {}, bubbles = {};
let seenAt = 0, sized = false;
const faces = Object.fromEntries(IDS.map((id) => { const img = new Image(); img.src = `/avatars/${id}-pixel-128.png`; return [id, img]; }));

const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
};
const P = (x, y, z) => [(x - z) * TW / 2, (x + z) * TH / 2 - y * UNIT];
const poly = (pts, fill, stroke) => {
  ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
};
function box(x, y, z, w, h, d, hex) {
  const line = 'rgba(0,0,0,.18)';
  poly([P(x, y + h, z), P(x + w, y + h, z), P(x + w, y + h, z + d), P(x, y + h, z + d)], shade(hex, 1), line);
  poly([P(x, y, z + d), P(x + w, y, z + d), P(x + w, y + h, z + d), P(x, y + h, z + d)], shade(hex, .82), line);
  poly([P(x + w, y, z), P(x + w, y, z + d), P(x + w, y + h, z + d), P(x + w, y + h, z)], shade(hex, .66), line);
}
function ellipse(cx, cy, rx, ry, fill) { ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); }
function cylinder(x, y, z, w, h, d, hex) {
  const [cx, bottom] = P(x + w / 2, y, z + d / 2), [, top] = P(x + w / 2, y + h, z + d / 2);
  const rx = Math.max(w, d) / 2 * TW * .5, ry = rx / 2;
  ellipse(cx, bottom, rx, ry, shade(hex, .66));
  ctx.fillStyle = shade(hex, .8); ctx.fillRect(cx - rx, top, rx * 2, bottom - top);
  ellipse(cx, top, rx, ry, shade(hex, 1));
}
function ball(x, y, z, w, h, d, hex) {
  const [cx, cy] = P(x + w / 2, y + h / 2, z + d / 2), r = Math.max(w, d, h) / 2 * TW * .5;
  const g = ctx.createRadialGradient(cx - r / 3, cy - r / 3, r / 6, cx, cy, r);
  g.addColorStop(0, shade(hex, 1.15)); g.addColorStop(1, shade(hex, .65));
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
}
const DRAW = { box, cyl: cylinder, ball };

function bubble(text, x, y, color) {
  ctx.font = '12px "Pretendard Variable", Pretendard, system-ui, sans-serif';
  const lines = []; let line = '';
  for (const ch of text) { line += ch; if (ctx.measureText(line).width > 150) { lines.push(line); line = ''; } }
  if (line) lines.push(line);
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14, h = lines.length * 15 + 10;
  const bx = x - w / 2, by = y - h;
  ctx.fillStyle = '#fff'; ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(bx, by, w, h, 8); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#1b1f2a'; ctx.textAlign = 'center';
  lines.forEach((l, i) => ctx.fillText(l, x, by + 17 + i * 15));
  ctx.textAlign = 'start';
}
function agent(id) {
  const p = pos[id]; if (!p) return;
  const [sx, sy] = P(p.x + .5, 0, p.z + .5), color = COLORS[id];
  ellipse(sx, sy, 16, 8, 'rgba(0,0,0,.22)');
  const r = 22, cy = sy - r - 8, img = faces[id];
  ctx.save(); ctx.beginPath(); ctx.arc(sx, cy, r, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#f3ead8'; ctx.fillRect(sx - r, cy - r, r * 2, r * 2);
  if (img.complete && img.naturalWidth) ctx.drawImage(img, sx - r, cy - r, r * 2, r * 2);
  ctx.restore();
  ctx.beginPath(); ctx.arc(sx, cy, r, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke();
  const name = data.names[id] || id;
  ctx.font = 'bold 11px "Pretendard Variable", Pretendard, system-ui, sans-serif';
  const w = ctx.measureText(name).width + 12;
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(sx - w / 2, cy - r - 20, w, 17, 8); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(name, sx, cy - r - 8); ctx.textAlign = 'start';
  // What the character is doing in the lived-in house, under its feet.
  const doing = data.phase === 'life' ? data.agents[id]?.doing : '';
  if (doing) {
    ctx.font = '10px "Pretendard Variable", Pretendard, system-ui, sans-serif';
    const dw = ctx.measureText(doing).width + 10;
    ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.beginPath(); ctx.roundRect(sx - dw / 2, sy + 4, dw, 15, 7); ctx.fill();
    ctx.fillStyle = '#1b1f2a'; ctx.textAlign = 'center'; ctx.fillText(doing, sx, sy + 15); ctx.textAlign = 'start';
  }
  const b = bubbles[id];
  if (b && b.until > Date.now()) bubble(b.text, sx, cy - r - 26, color);
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  if (panel.hidden || !data) return;
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return; // the workspace panel is closed
  if (sized === false) { sized = true; fit(); }
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.translate(w / 2 + cam.x, h / 2 + cam.y); ctx.scale(cam.s, cam.s);
  const N = data.size, [cx, cy] = P(N / 2, 0, N / 2);
  ctx.translate(-cx, -cy);
  // walking: straight toward the saved spot at about two tiles a second
  const dt = Math.min(.1, (now - (frame.last || now)) / 1000); frame.last = now;
  for (const id of IDS) {
    const to = data.agents[id]; if (!to) continue;
    const p = pos[id] ||= { x: to.x, z: to.z };
    const dx = to.x - p.x, dz = to.z - p.z, dist = Math.hypot(dx, dz), step = 2.2 * dt;
    if (dist <= step) { p.x = to.x; p.z = to.z; } else { p.x += dx / dist * step; p.z += dz / dist * step; }
  }
  poly([P(0, 0, 0), P(N, 0, 0), P(N, 0, N), P(0, 0, N)], 'rgba(150,190,120,.28)', 'rgba(120,150,100,.35)');
  ctx.strokeStyle = 'rgba(120,150,100,.18)'; ctx.lineWidth = 1;
  for (let i = 1; i < N; i++) {
    ctx.beginPath(); ctx.moveTo(...P(i, 0, 0)); ctx.lineTo(...P(i, 0, N)); ctx.moveTo(...P(0, 0, i)); ctx.lineTo(...P(N, 0, i)); ctx.stroke();
  }
  for (const [x, z, c] of data.floors) poly([P(x, 0, z), P(x + 1, 0, z), P(x + 1, 0, z + 1), P(x, 0, z + 1)], shade(data.palette[c] || '#cccccc', 1), 'rgba(0,0,0,.1)');
  const list = [];
  for (const [x, z, c, door] of data.walls) list.push({ depth: x + z + 1, draw: () => (door ? box(x, 1.6, z, 1, .7, 1, data.palette[c]) : box(x, 0, z, 1, 2.3, 1, data.palette[c])) });
  for (const item of data.items) {
    const def = data.defs[item.def]; if (!def) continue;
    for (const part of rotateParts(def.parts, item.rot).parts) {
      const X = item.x + part.x, Z = item.z + part.z;
      list.push({ depth: X + part.w / 2 + Z + part.d / 2 + part.y * .01, draw: () => DRAW[part.s](X, part.y, Z, part.w, part.h, part.d, data.palette[part.c] || '#cccccc') });
    }
  }
  for (const id of IDS) if (pos[id]) list.push({ depth: pos[id].x + pos[id].z + 1.2, draw: () => agent(id) });
  list.sort((a, b) => a.depth - b.depth).forEach((o) => o.draw());
}

function fit() {
  const cells = [...data.floors, ...data.walls].map(([x, z]) => [x, z]);
  if (!cells.length) { cam.x = cam.y = 0; cam.s = 1; return; }
  const xs = cells.map(([x, z]) => P(x + .5, 0, z + .5)[0]), ys = cells.map(([x, z]) => P(x + .5, 0, z + .5)[1]);
  const [cx, cy] = P(data.size / 2, 0, data.size / 2);
  const w = Math.max(...xs) - Math.min(...xs) + TW * 2, h = Math.max(...ys) - Math.min(...ys) + TH * 8;
  cam.s = Math.max(.6, Math.min(1.6, Math.min(canvas.clientWidth / w, canvas.clientHeight / h)));
  cam.x = -((Math.max(...xs) + Math.min(...xs)) / 2 - cx) * cam.s;
  cam.y = -((Math.max(...ys) + Math.min(...ys)) / 2 - cy) * cam.s;
}

async function send(route, body) {
  const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await res.json();
  if (!res.ok || value.error) throw new Error(value.error || `요청 실패 (${res.status})`);
  data = value; renderSide();
}
const day = (at) => new Date(at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
const time = (at) => new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
let diaryKey = '';
function renderDiary() {
  const life = data.phase === 'life';
  $('#hsDiary').hidden = !life;
  if (!life) return;
  const key = JSON.stringify([data.mode, data.open, data.undo, data.events.map((e) => e.id)]);
  if (key === diaryKey) return;
  diaryKey = key;
  $('#hsMode').querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === data.mode)));
  // An open matter the owner may (but need not) step into; the AIs settle it on their own otherwise.
  const ask = data.open?.ask;
  $('#hsAsk').hidden = !ask;
  if (ask) {
    $('#hsAsk').innerHTML = `<p>${esc(data.open.text)}</p><small>${time(ask.deadline)}까지 아무것도 안 하면 AI들이 알아서 정해요.</small>
      <div><button type="button" data-decide="ai">AI들에게 맡기기</button><button type="button" data-say>내가 한마디 하기</button></div>
      <form hidden><input maxlength="60" placeholder="예: 창가 쪽으로 두자" aria-label="방장 한마디"><button type="submit">정하기</button></form>`;
    $('#hsAsk').querySelector('[data-decide]').onclick = () => send('/api/house/decide', { choice: 'ai' }).catch((e) => alert(e.message));
    $('#hsAsk').querySelector('[data-say]').onclick = () => { const f = $('#hsAsk form'); f.hidden = false; f.querySelector('input').focus(); };
    $('#hsAsk form').onsubmit = (e) => { e.preventDefault(); send('/api/house/decide', { choice: 'owner', note: e.target.querySelector('input').value }).catch((err) => alert(err.message)); };
  }
  $('#hsUndo').hidden = !data.undo;
  if (data.undo) {
    $('#hsUndo').innerHTML = `<span>${esc(data.undo.text)}</span><button type="button">되돌리기</button>`;
    $('#hsUndo').querySelector('button').onclick = () => send('/api/house/undo', {}).catch((e) => alert(e.message));
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
  if (b) send('/api/house/mode', { mode: b.dataset.mode }).catch((err) => alert(err.message));
});
function renderSide() {
  renderDiary();
  const talk = data.talk ? (data.busy ? '지금 짓는 중…' : data.phase === 'life' ? 'Talk 켜짐 · 생활 중' : `Talk 켜짐 · 다음 작업 ${Math.max(1, Math.round((data.nextAt - Date.now()) / 60000))}분 뒤쯤`) : 'Talk 꺼짐 · 켜면 다시 움직여요';
  $('#hsStatus').textContent = `${data.phase === 'life' ? '🏠 생활 중' : '🔨 짓는 중'} · 가구 ${data.items.length}개 · ${talk}`;
  $('#hsEmpty').hidden = !!(data.floors.length || data.walls.length || data.items.length);
  $('#hsPlan').hidden = !data.plan;
  $('#hsPlanText').textContent = data.plan;
  const next = JSON.stringify(data.log.map((l) => l.at));
  if (next === logKey) return;
  logKey = next;
  const list = $('#hsLogList');
  const who = (id) => data.names[id] || (id === 'user' ? data.userName : id === 'house' ? '🏠 집' : id);
  list.innerHTML = data.log.slice(-30).map((l) => `<div class="hs-line ${l.kind}"><b style="color:${COLORS[l.id] || 'inherit'}">${esc(who(l.id))}</b> ${l.kind === 'build' ? '🔨 ' : ''}${esc(l.text)}</div>`).join('') || '<div class="hs-line">아직 대화가 없어요.</div>';
  list.scrollTop = list.scrollHeight;
}
function noteBubbles(first) {
  for (const l of data.log) {
    if (l.at <= seenAt) continue;
    if (l.kind === 'say' && !first) bubbles[l.id] = { text: l.text, until: Date.now() + 12000 };
  }
  seenAt = Math.max(seenAt, ...data.log.map((l) => l.at), 0);
}
async function load() {
  try {
    const first = !data;
    data = await (await fetch('/api/house')).json();
    noteBubbles(first); renderSide();
    if (first) sized = false; // fitted on the next frame, once the canvas has a size
  } catch { /* keep the last picture */ }
}

let drag = null;
canvas.onpointerdown = (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); };
canvas.onpointermove = (e) => { if (!drag) return; cam.x += e.clientX - drag.x; cam.y += e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY }; };
canvas.onpointerup = () => { drag = null; };
canvas.onwheel = (e) => { e.preventDefault(); cam.s = Math.max(.4, Math.min(2.5, cam.s * (e.deltaY < 0 ? 1.1 : .9))); };
$('#hsLogToggle').onclick = () => {
  const open = $('#hsLogList').hidden;
  $('#hsLogList').hidden = !open; $('#hsLogToggle').setAttribute('aria-expanded', String(open));
  $('#hsLogToggle').textContent = open ? '대화 접기 ▾' : '대화 열기 ▴';
};
opener.onclick = () => {
  panel.hidden = false; document.querySelector('#app').inert = true; opener.setAttribute('aria-expanded', 'true');
  sized = false; load();
  clearInterval(timer); timer = setInterval(load, 20000);
  cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
  $('#hsClose').focus();
};
$('#hsClose').onclick = () => {
  panel.hidden = true; document.querySelector('#app').inert = false; opener.setAttribute('aria-expanded', 'false'); opener.focus();
  clearInterval(timer); cancelAnimationFrame(raf); raf = 0; frame.last = 0;
};
window.addEventListener('house-update', () => { if (!panel.hidden) load(); });
