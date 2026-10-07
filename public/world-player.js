import * as THREE from 'three';

// Screen-relative cardinal grid movement, shared by keyboard and joystick.
export function movementStep(horizontal, vertical, forward) {
  const length = Math.hypot(forward.x, forward.z);
  const fx = length ? forward.x / length : 0, fz = length ? forward.z / length : -1;
  const x = -fz * horizontal - fx * vertical, z = fx * horizontal - fz * vertical;
  if (Math.max(Math.abs(x), Math.abs(z)) < .15) return null;
  return Math.abs(x) >= Math.abs(z) ? { dx: Math.sign(x), dz: 0 } : { dx: 0, dz: Math.sign(z) };
}

export class BlockHold {
  constructor(complete, duration = 650) { this.complete = complete; this.duration = duration; this.active = null; }
  start(x, y, now) { this.active = { x, y, now }; }
  cancel() { this.active = null; }
  move(x, y) {
    if (this.active && Math.hypot(x - this.active.x, y - this.active.y) > 7) this.cancel();
  }
  tick(now) {
    if (!this.active) return 0;
    const progress = Math.max(0, (now - this.active.now) / this.duration);
    if (progress < 1) return progress;
    this.cancel(); this.complete(); return 0;
  }
}

export function createUserAvatar() {
  const group = new THREE.Group(), body = new THREE.Group();
  group.add(body);
  const materials = {};
  const part = (w, h, d, color, x, y, z, parent = body) => {
    const material = materials[color] ||= new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  };
  part(.86, .7, .46, '#26b7a1', 0, 1.1, 0);
  part(.82, .18, .48, '#ffda46', 0, .79, 0);
  part(.76, .64, .65, '#ffd18d', 0, 1.8, 0);
  part(.84, .16, .72, '#8b5cf6', 0, 2.15, 0);
  part(.65, .07, .34, '#8b5cf6', 0, 2.08, .42);
  part(.085, .105, .025, '#252031', -.17, 1.84, .337);
  part(.085, .105, .025, '#252031', .17, 1.84, .337);
  part(.24, .055, .026, '#252031', 0, 1.62, .338);
  part(.05, .08, .026, '#252031', -.13, 1.66, .338);
  part(.05, .08, .026, '#252031', .13, 1.66, .338);
  const limbs = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group(); arm.position.set(side * .58, 1.38, 0); body.add(arm);
    part(.28, .5, .32, '#ffd18d', 0, -.24, 0, arm); limbs.push(arm);
    const leg = new THREE.Group(); leg.position.set(side * .23, .75, 0); body.add(leg);
    part(.34, .53, .37, '#477eea', 0, -.25, 0, leg);
    part(.37, .18, .49, '#fff2dc', 0, -.64, .07, leg); limbs.push(leg);
  }
  return { group, body, limbs, target: new THREE.Vector3(), bubble: null, bubbleUntil: 0,
    animate(now, moving) {
      const swing = moving ? Math.sin(now / 105) * .55 : 0;
      limbs[0].rotation.x = swing; limbs[1].rotation.x = -swing;
      limbs[2].rotation.x = -swing; limbs[3].rotation.x = swing;
    } };
}

export function initWorldPlayer({ scene, camera, controls, canvas, getWorld, setUser, followUser, applyPatch, addChat, nameOf }) {
  const $ = (s) => document.querySelector(s);
  const play = document.createElement('div');
  play.className = 'play-bar';
  play.innerHTML = '<button class="enter-world" id="enterWorld" type="button">🎮 직접 입장</button>';
  $('.world-info').append(play);
  const panel = document.createElement('section');
  panel.className = 'hud world-chat';
  panel.setAttribute('aria-label', '월드 채팅');
  panel.innerHTML = `<header><strong>같이 수다 떨기</strong><button type="button" id="hideWorldChat" aria-label="채팅 접기">접기</button></header>
    <div id="chatMessages"></div><form id="worldChatForm"><input id="worldChatInput" aria-label="월드 채팅 메시지" placeholder="애들한테 말 걸기…" maxlength="4000" autocomplete="off"><button type="submit">전송</button></form>
    <div class="chat-state" id="worldChatState" role="status">채팅방과 대화가 이어집니다.</div>`;
  const oldChat = $('#chat');
  panel.querySelector('#chatMessages').replaceWith(oldChat);
  oldChat.hidden = false;
  oldChat.setAttribute('role', 'log');
  oldChat.setAttribute('aria-live', 'polite');
  oldChat.setAttribute('aria-relevant', 'additions');
  document.body.append(panel);
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'hud chat-toggle'; toggle.textContent = '💬 채팅';
  toggle.setAttribute('aria-controls', 'worldChatForm');
  document.body.append(toggle);
  const tools = document.createElement('section');
  tools.className = 'player-tools'; tools.hidden = true;
  tools.setAttribute('aria-label', '블록 조작');
  tools.innerHTML = '<div class="edit-buttons" role="group" aria-label="꾹 누르기 모드"><button type="button" class="break-block" id="breakBlock" aria-pressed="true">🔨 부수기</button><button type="button" class="place-block" id="placeBlock" aria-pressed="false">＋ 놓기</button></div>';
  document.body.append(tools);
  const status = document.createElement('div'); status.className = 'hud player-status'; status.setAttribute('role', 'status'); document.body.append(status);
  const stick = document.createElement('button');
  stick.type = 'button'; stick.className = 'joystick hud'; stick.hidden = true; stick.setAttribute('aria-label', '이동 조이스틱'); stick.innerHTML = '<span></span>';
  document.body.append(stick);
  let token = null, position = null, busy = false, moving = false, lastMove = 0, selected = null, keyboard = new Set(), axis = [0, 0], pointer = null;
  let chatBusy = false, messageTimer, editMode = 'remove';
  const hold = new BlockHold(() => { if (canEdit(editMode)) edit(editMode); });
  const cancelHold = () => { hold.cancel(); };
  const ray = new THREE.Raycaster(), forward = new THREE.Vector3();
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04)),
    new THREE.LineBasicMaterial({ color: 0xffd84d, depthTest: false }));
  outline.renderOrder = 20; outline.visible = false; scene.add(outline);
  const hint = (text) => { clearTimeout(messageTimer); status.textContent = text; messageTimer = setTimeout(() => { status.textContent = ''; }, 5000); };
  const stop = () => { keyboard.clear(); axis = [0, 0]; stick.firstElementChild.style.transform = ''; cancelHold(); };
  const typing = () => !!document.activeElement?.closest('input, textarea, select, [contenteditable="true"]');
  const layout = () => {
    document.documentElement.style.setProperty('--hud-top', `${$('.top').getBoundingClientRect().bottom + 12}px`);
    document.documentElement.style.setProperty('--visible-height', `${visualViewport?.height || innerHeight}px`);
    document.documentElement.style.setProperty('--keyboard-inset', `${visualViewport ? Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop) : 0}px`);
  };
  new ResizeObserver(layout).observe($('.top'));
  visualViewport?.addEventListener('resize', layout);
  visualViewport?.addEventListener('scroll', layout);
  const showChat = (open) => {
    panel.classList.toggle('collapsed', !open); panel.inert = !open;
    panel.setAttribute('aria-hidden', String(!open));
    toggle.hidden = open; toggle.setAttribute('aria-expanded', String(open)); layout();
  };
  $('#hideWorldChat').onclick = () => { $('#worldChatInput').blur(); showChat(false); };
  toggle.onclick = () => showChat(true);
  showChat(!matchMedia('(max-width: 800px), (pointer: coarse)').matches);
  $('#worldChatInput').addEventListener('focus', () => { stop(); document.body.classList.add('chat-typing'); controls.enabled = false; });
  $('#worldChatInput').addEventListener('blur', () => { document.body.classList.remove('chat-typing'); controls.enabled = true; });
  async function request(action, data = {}) {
    const r = await fetch(`/api/world/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...data }) });
    const value = await r.json();
    if (!r.ok) throw Object.assign(new Error(value.error || '월드 요청에 실패했어요.'), { status: r.status });
    return value;
  }
  function accept(value) {
    if (value.position) { position = value.position; setUser(value.position); }
    refreshSelection();
  }
  function setPlaying(on) {
    document.body.classList.toggle('playing', on);
    tools.hidden = stick.hidden = !on;
    $('#enterWorld').textContent = on ? '👀 관람 모드' : '🎮 직접 입장';
    $('#enterWorld').setAttribute('aria-pressed', String(on));
    if (!on) { stop(); token = null; position = null; selected = null; outline.visible = false; followUser(false); }
    layout();
  }
  $('#enterWorld').onclick = async () => {
    if (busy) return;
    busy = true; $('#enterWorld').disabled = true;
    try {
      if (token) { await request('leave'); setPlaying(false); setUser(null); }
      else {
        const value = await request('join');
        token = value.token; accept(value); setPlaying(true); followUser(true);
        hint(matchMedia('(pointer: coarse)').matches ? '오른쪽 조이스틱으로 이동 · 블록을 꾹 눌러 조작' : 'WASD / 방향키로 이동 · 블록을 꾹 눌러 부수기/놓기');
      }
    } catch (e) { hint(e.message); }
    finally { busy = false; $('#enterWorld').disabled = false; }
  };
  function inReach(at) { return position && Math.hypot(at[0] - position.x, at[1] - position.y, at[2] - position.z) <= 4; }
  function canEdit(op) {
    if (!selected || !token || busy || typing()) return false;
    const w = getWorld();
    if (op === 'remove') return w.blocks.has(selected.at.join(',')) && inReach(selected.at);
    const at = selected.place;
    return at && inReach(at) && at[1] >= 1 && at[1] < w.size.y && at[0] >= 0 && at[0] < w.size.x
      && at[2] >= 0 && at[2] < w.size.z && !w.blocks.has(at.join(','));
  }
  function refreshSelection() {
    $('#breakBlock').disabled = $('#placeBlock').disabled = !token || busy;
  }
  async function edit(op) {
    if (!token || busy || typing()) return;
    busy = true; refreshSelection();
    try {
      const value = await request('edit', {
        op, at: op === 'remove' ? selected.at : selected.place, block: 'planks',
      });
      applyPatch(value); accept(value);
      hint(op === 'remove' ? '블록을 부쉈어요.' : '나무 블록을 놓았어요.');
    } catch (e) { hint(e.message); }
    finally { busy = false; refreshSelection(); }
  }
  function chooseMode(mode) {
    cancelHold(); editMode = mode;
    $('#breakBlock').setAttribute('aria-pressed', String(mode === 'remove'));
    $('#placeBlock').setAttribute('aria-pressed', String(mode === 'place'));
    hint(mode === 'remove' ? '부수기 모드 · 가까운 블록을 0.65초 꾹 누르세요.' : '놓기 모드 · 땅이나 블록 면을 0.65초 꾹 누르세요.');
  }
  $('#breakBlock').onclick = () => chooseMode('remove');
  $('#placeBlock').onclick = () => chooseMode('place');
  const touches = new Set();
  canvas.addEventListener('pointerdown', (e) => {
    touches.add(e.pointerId);
    cancelHold();
    if (!token || touches.size !== 1 || e.button !== 0 || typing()) return;
    const rect = canvas.getBoundingClientRect(), w = getWorld();
    ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = ray.intersectObjects([...w.meshes.values(), w.ground.children[0]], false)[0];
    if (!hit) { selected = null; outline.visible = false; refreshSelection(); return; }
    const at = hit.object.userData.cells?.[hit.instanceId]?.split(',').map(Number)
      || [Math.floor(hit.point.x), 0, Math.floor(hit.point.z)];
    const normal = hit.face.normal;
    const place = [at[0] + Math.round(normal.x), at[1] + Math.round(normal.y), at[2] + Math.round(normal.z)];
    selected = { at, place };
    outline.position.set(at[0] + .5, at[1] - .5, at[2] + .5); outline.visible = true;
    refreshSelection();
    if (canEdit(editMode)) hold.start(e.clientX, e.clientY, performance.now());
    else hint(!inReach(at) ? '4칸 안으로 더 가까이 가 주세요.' : editMode === 'remove' ? '잔디 땅이나 빈칸은 부술 수 없어요.' : '빈 땅이나 블록의 빈 면을 꾹 눌러 주세요.');
  });
  canvas.addEventListener('pointermove', (e) => { hold.move(e.clientX, e.clientY); if (!hold.active) cancelHold(); });
  const releaseBlock = (e) => { touches.delete(e.pointerId); cancelHold(); };
  canvas.addEventListener('pointerup', releaseBlock);
  canvas.addEventListener('pointercancel', releaseBlock);
  canvas.addEventListener('lostpointercapture', releaseBlock);
  const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']);
  addEventListener('keydown', (e) => {
    if (!token || typing() || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || !movementKeys.has(e.code)) return;
    e.preventDefault(); keyboard.add(e.code);
  });
  addEventListener('keyup', (e) => keyboard.delete(e.code));
  addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  document.addEventListener('focusin', () => { if (typing()) stop(); });
  const stickMove = (e) => {
    if (e.pointerId !== pointer) return;
    const r = stick.getBoundingClientRect(), x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
    const len = Math.hypot(x, y), scale = Math.max(1, len / 32);
    axis = len < 9 ? [0, 0] : [x / scale / 32, y / scale / 32];
    stick.firstElementChild.style.transform = `translate(${x / scale}px, ${y / scale}px)`;
  };
  stick.onpointerdown = (e) => { if (!token || typing() || pointer !== null) return; e.preventDefault(); pointer = e.pointerId; stick.setPointerCapture(pointer); stickMove(e); };
  stick.onpointermove = stickMove;
  const releaseStick = (e) => { if (e.pointerId === pointer) { pointer = null; stop(); } };
  stick.onpointerup = stick.onpointercancel = stick.onlostpointercapture = releaseStick;
  $('#worldChatForm').onsubmit = async (e) => {
    e.preventDefault();
    if (chatBusy) return;
    const input = $('#worldChatInput'), text = input.value.trim();
    if (!text) return;
    chatBusy = true; $('#worldChatForm button').disabled = true;
    const state = $('#worldChatState'); state.classList.remove('chat-error');
    try {
      const r = await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const value = await r.json();
      if (!r.ok) throw new Error(value.error || '전송하지 못했어요.');
      if (value.msg) addChat(value.msg);
      if (input.value.trim() === text) input.value = '';
      state.textContent = value.running ? '전송했어요.' : '전송했어요. Talk이 꺼져 있으면 AI는 답하지 않아요.';
    } catch (error) { state.textContent = error.message; state.classList.add('chat-error'); }
    finally { chatBusy = false; $('#worldChatForm button').disabled = false; }
  };
  const heartbeat = setInterval(async () => {
    if (!token || document.hidden) return;
    try { accept(await request('heartbeat')); }
    catch (e) { hint(e.message); if (e.status === 409) { setPlaying(false); setUser(null); } }
  }, 10000);
  addEventListener('pagehide', () => {
    stop(); clearInterval(heartbeat);
    if (token) fetch('/api/world/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }), keepalive: true }).catch(() => {});
  });
  return {
    update() { refreshSelection(); },
    tick(now) {
      const progress = hold.tick(now);
      outline.material.color.setHSL(.14, 1, .5 + progress * .4);
      if (!token || typing() || document.hidden || moving || now - lastMove < 190) return;
      const horizontal = axis[0] || Number(keyboard.has('KeyD') || keyboard.has('ArrowRight')) - Number(keyboard.has('KeyA') || keyboard.has('ArrowLeft'));
      const vertical = axis[1] || Number(keyboard.has('KeyS') || keyboard.has('ArrowDown')) - Number(keyboard.has('KeyW') || keyboard.has('ArrowUp'));
      camera.getWorldDirection(forward);
      const step = movementStep(horizontal, vertical, forward);
      if (!step) return;
      cancelHold();
      moving = true; lastMove = now;
      request('move', step).then((value) => { if (token) { accept(value); if (value.blocked) hint('벽이나 월드 경계예요. 다른 방향으로 가 보세요.'); } })
        .catch((e) => { hint(e.message); if (e.status === 409) { setPlaying(false); setUser(null); } })
        .finally(() => { moving = false; });
    },
  };
}
