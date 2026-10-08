import * as THREE from '/vendor/three.module.js';
import { houseBounds, furnitureParts, roomAt, workerPath, actorActivity } from './house-view.mjs';
import { createBlockAvatar, animateBlockAvatar } from './house-avatar.mjs';
import { furniturePose } from './house-pose.mjs';

const COLORS = { claude: '#d97a3a', gpt: '#2f7cf6', gemini: '#5b6cf0', user: '#199b78' };
function dispose(group) {
  group.traverse((obj) => {
    obj.geometry?.dispose();
    if (obj.material) {
      obj.material.map?.dispose();
      obj.material.dispose();
    }
  });
  group.clear();
}

export class HouseScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#efe6d2');
    this.scene.add(new THREE.HemisphereLight('#fff8e9', '#879c83', 2.4));
    const sun = new THREE.DirectionalLight('#fff5db', 3);
    sun.position.set(8, 25, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, far: 80 });
    sun.target.position.set(10, 0, 10);
    this.scene.add(sun, sun.target);
    this.structure = new THREE.Group(); this.people = new THREE.Group();
    this.scene.add(this.structure, this.people);
    this.camera = new THREE.PerspectiveCamera(45, 1, .1, 150);
    this.agents = {};
    this.seenSpeech = null; this.previousItems = new Map();
    this.reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
    this.shown = null; this.jobs = []; this.pending = new Map(); // build animation: what is already in place, who is building what
    this.angle = Math.PI / 4; this.elevation = .85; this.zoom = 1; this.follow = null;
    this.pan = new THREE.Vector3();
    this.bounds = { x: 10, z: 10, span: 20 };
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); this.lost = true;
      canvas.dispatchEvent(new CustomEvent('house-render-error', { detail: '3D 그래픽 연결이 끊겼어요. 앱을 다시 열어 주세요.' }));
    });
  }

  mesh(shape, x, y, z, w, h, d, color, group = this.structure) {
    const geometry = shape === 'cyl' ? new THREE.CylinderGeometry(.5, .5, 1, 24)
      : shape === 'ball' ? new THREE.SphereGeometry(.5, 24, 16) : new THREE.BoxGeometry(1, 1, 1);
    const obj = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: .8 }));
    obj.scale.set(w, h, d); obj.position.set(x + w / 2, y + h / 2, z + d / 2);
    obj.castShadow = true; obj.receiveShadow = true; group.add(obj);
    return obj;
  }

  label(text, color, width = 3, avatarId = '') {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    const draw = (img) => {
      ctx.clearRect(0, 0, 512, 256);
      if (img) {
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(256, 168, 86, 0, Math.PI * 2); ctx.fill();
        ctx.save(); ctx.beginPath(); ctx.arc(256, 168, 78, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(img, 178, 90, 156, 156); ctx.restore();
      }
      ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'center';
      const w = Math.min(500, ctx.measureText(text).width + 56);
      ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(256 - w / 2, 28, w, 64, 32); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(text, 256, 72, w - 40);
      texture.needsUpdate = true;
    };
    draw(null);
    if (avatarId) { const img = new Image(); img.onload = () => draw(img); img.src = `/avatars/${avatarId}-pixel-128.png`; }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.scale.set(width, width / 2, 1);
    return sprite;
  }

  update(data) {
    this.data = data;
    const key = JSON.stringify([data.floors, data.walls, data.defs, data.items, data.story?.environment]);
    if (key !== this.structureKey) {
      this.structureKey = key; dispose(this.structure);
      this.bounds = houseBounds(data);
      this.mesh('box', -1, -.18, -1, data.size + 2, .12, data.size + 2, '#c5d4ab');
      const env = data.story?.environment;
      if (env?.yard === 'garden') {
        for (let z = 2; z < 6; z++) {
          this.mesh('cyl', -.85, 0, z, .5, .3, .5, '#b98550');
          this.mesh('ball', -.85, .3, z, .5, .5, .5, z % 2 ? '#ee93b4' : '#5fa660');
        }
      } else if (env?.yard === 'bbq') {
        this.mesh('box', -.85, 0, 3, .6, .8, 1.4, '#4f545e');
        this.mesh('box', -.85, .8, 3, .6, .1, 1.4, '#e8914a');
      }
      // Every floor cell, wall cell and furniture piece is one "cell": [key, color, parts to draw].
      const cells = [
        ...data.floors.map(([x, z, c]) => [`f${x},${z},${c}`, data.palette[c], [['box', x, -.06, z, 1, .06, 1, data.palette[c]]]]),
        // Door cells keep a real open passage beneath their lintel.
        ...data.walls.map(([x, z, c, door]) => [`w${x},${z},${c},${door}`, data.palette[c], [['box', x, door ? 1.7 : 0, z, 1, door ? .6 : 2.3, 1, data.palette[c]]]]),
        ...data.items.map((item) => {
          const parts = furnitureParts({ defs: data.defs, items: [item] });
          return [`i${item.id}@${item.x},${item.z}/${item.rot}/${JSON.stringify(parts)}`, data.palette[parts[0]?.c],
            parts.map((p) => [p.s, p.x, p.y, p.z, p.w, p.h, p.d, data.palette[p.c]]), item];
        }),
      ];
      this.planBuilds(data, cells);
      this.pending = new Map();
      for (const [cellKey, , parts] of cells) {
        const meshes = parts.map((p) => this.mesh(...p));
        if (this.shown.has(cellKey)) continue;
        // New work stays hidden until its builder has walked over and put it in place.
        meshes.forEach((m) => { m.visible = false; m.userData.base = m.scale.clone(); m.userData.position = m.position.clone(); });
        this.pending.set(cellKey, meshes);
      }
      this.previousItems = new Map(data.items.map((item) => [item.id, { ...item }]));
    }
    const actors = { ...data.agents, ...(data.player ? { user: data.player } : {}) };
    for (const id of Object.keys(this.agents)) if (!actors[id]) {
      this.people.remove(this.agents[id].group); dispose(this.agents[id].group); delete this.agents[id];
      if (this.follow === id) { this.follow = null; this.canvas.dispatchEvent(new Event('house-follow-change')); }
    }
    for (const [id, to] of Object.entries(actors)) {
      if (!this.agents[id]) {
        const rig = createBlockAvatar(THREE, this.mesh.bind(this), COLORS[id] || '#777', id);
        const { group } = rig;
        group.position.set(to.x + .5, 0, to.z + .5);
        this.people.add(group); this.agents[id] = { group, rig };
      }
      const actor = this.agents[id];
      if (to.spawn !== undefined && actor.spawn !== to.spawn) {
        actor.group.position.set(to.x + .5, 0, to.z + .5); actor.spawn = to.spawn;
      }
      actor.to = to;
      const job = this.jobs.find((j) => j.actor === id);
      const action = actorActivity({ job, working: data.workingActor === id,
        moving: actor.group.position.distanceTo(new THREE.Vector3(to.x + .5, 0, to.z + .5)) > .2,
        doing: data.crew?.waiting && data.crew.soloActor === id ? '동료 복귀 대기' : to.doing,
        paused: id !== 'user' && data.talk === false });
      actor.action = action;
      const text = [id === 'user' ? data.userName : data.names[id] || id, action].filter(Boolean).join(' · ');
      if (text !== actor.text) {
        if (actor.label) { actor.group.remove(actor.label); actor.label.material.map.dispose(); actor.label.material.dispose(); }
        actor.label = this.label(text, COLORS[id] || '#555', 2.4, id === 'user' ? '' : id);
        actor.label.position.y = 2.75; actor.group.add(actor.label); actor.text = text;
      }
    }
    if (!this.jobs.length) this.latestCompletion = data.log.findLast((l) => l.kind === 'build') || null;
    const speech = data.log.filter((l) => l.source === 'ai' && l.kind === 'say' && l.speechId);
    if (this.seenSpeech) for (const message of speech) {
      if (this.seenSpeech.has(message.speechId) || Date.now() - message.at > 30000) continue;
      const actor = this.agents[message.id];
      if (!actor) continue;
      if (actor.bubble) { actor.group.remove(actor.bubble); actor.bubble.material.map.dispose(); actor.bubble.material.dispose(); }
      actor.bubble = this.speechBubble(message.text);
      actor.bubble.position.y = 4.05; actor.group.add(actor.bubble);
      actor.bubbleUntil = performance.now() + 12000;
    }
    this.seenSpeech = new Set(speech.map((l) => l.speechId));
  }

  speechBubble(text) {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fffdf4'; ctx.beginPath(); ctx.roundRect(4, 4, 632, 230, 24); ctx.fill();
    ctx.beginPath(); ctx.moveTo(295, 228); ctx.lineTo(320, 256); ctx.lineTo(345, 228); ctx.fill();
    ctx.fillStyle = '#1b2638'; ctx.font = '26px sans-serif';
    const lines = []; let line = '';
    for (const char of String(text).slice(0, 200)) {
      if (ctx.measureText(line + char).width > 574) { lines.push(line); line = ''; }
      line += char;
    }
    if (line) lines.push(line);
    lines.slice(0, 5).forEach((value, i) => ctx.fillText(value + (i === 4 && lines.length > 5 ? '…' : ''), 30, 44 + i * 37));
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.scale.set(4.8, 1.92, 1);
    return sprite;
  }

  pickRoom(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2), this.camera);
    const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    return point ? roomAt(this.data?.progress?.rooms || [], point.x, point.z) : -1;
  }

  releaseJob(job) {
    if (!job.held) return;
    job.held.parent?.remove(job.held); job.held.geometry.dispose(); job.held.material.dispose(); job.held = null;
  }

  // Work that is new since the last drawing is given to the member who built last: they carry the material over,
  // hammer it into place, and only then does it appear (see stepJobs). The first drawing shows everything at once.
  planBuilds(data, cells) {
    const current = new Set(cells.map(([cellKey]) => cellKey));
    if (!this.shown) { this.shown = new Set(current); return; }
    for (const cellKey of this.shown) if (!current.has(cellKey)) this.shown.delete(cellKey);
    for (const job of this.jobs) {
      job.keys = job.keys.filter((cellKey) => current.has(cellKey));
      if (!job.keys.length) this.releaseJob(job);
    }
    this.jobs = this.jobs.filter((job) => job.keys.length);
    const queued = new Set(this.jobs.flatMap((job) => job.keys));
    const fresh = cells.filter(([cellKey]) => !this.shown.has(cellKey) && !queued.has(cellKey));
    const builder = data.log.findLast((l) => l.kind === 'build')?.id;
    if (!fresh.length) return;
    if (!builder || fresh.length > 400 || this.reducedMotion) { fresh.forEach(([cellKey]) => this.shown.add(cellKey)); return; }
    const structure = fresh.filter((entry) => !entry[3]);
    if (structure.length) this.jobs.push({ actor: builder, keys: structure.map(([cellKey]) => cellKey), color: structure[0][1], phase: 'walk', t: 0 });
    for (const [cellKey, color, , item] of fresh.filter((entry) => entry[3])) {
      this.jobs.push({ actor: item.lastBy || item.by || builder, keys: [cellKey], color, item,
        previous: this.previousItems.get(item.id), phase: 'walk', t: 0 });
    }
  }

  // One step of every build job (one job at a time per member): walk -> hammer ~1.5s -> cells pop in one by one.
  stepJobs(dt) {
    const busy = new Set();
    let changed = false;
    for (const job of [...this.jobs]) {
      if (busy.has(job.actor)) continue;
      busy.add(job.actor);
      const actor = this.agents[job.actor];
      job.t += dt;
      const phase = job.phase;
      if (!actor) job.phase = 'reveal';
      else if (job.phase === 'walk') {
        if (!job.held) {
          job.held = new THREE.Mesh(new THREE.BoxGeometry(.22, .22, .22), new THREE.MeshStandardMaterial({ color: job.color || '#c9a26b', roughness: .8 }));
          job.held.position.set(0, -.3, .26); actor.rig.joints.rightElbow.add(job.held);
        }
        if (!job.path) job.path = workerPath(this.data, actor.group.position,
          job.item ? { x: job.item.x + .5, z: job.item.z + .5 } : { x: actor.to.x + .5, z: actor.to.z + .5 });
        const next = job.path[0];
        if (next) {
          const target = new THREE.Vector3(next.x, 0, next.z), distance = actor.group.position.distanceTo(target);
          actor.group.rotation.y = Math.atan2(target.x - actor.group.position.x, target.z - actor.group.position.z);
          actor.group.position.lerp(target, Math.min(1, dt * 4 / Math.max(.001, distance)));
          if (distance < .08) job.path.shift();
        } else { job.phase = 'hammer'; job.t = 0; }
      } else if (job.phase === 'hammer') {
        actor.rig.joints.rightShoulder.rotation.x = -1.3 + Math.sin(job.t * 16) * .55;
        actor.rig.joints.rightElbow.rotation.x = -.5;
        if (job.t > 1.5) { job.phase = 'reveal'; job.t = 0; }
      }
      if (job.phase === 'reveal') {
        this.releaseJob(job);
        const stagger = Math.min(.06, 1.2 / job.keys.length);
        let done = 0;
        job.keys.forEach((cellKey, i) => {
          const p = (job.t - i * stagger) / (job.item ? .9 : .25);
          if (p <= 0) return;
          this.shown.add(cellKey);
          const k = Math.min(p, 1), pop = 1 + 2.7 * (k - 1) ** 3 + 1.7 * (k - 1) ** 2; // overshoots a little, then settles
          for (const m of this.pending.get(cellKey) || []) {
            m.visible = true; m.scale.copy(m.userData.base).multiplyScalar(job.previous ? 1 : pop);
            m.position.copy(m.userData.position);
            if (job.item) {
              m.position.y += Math.sin(k * Math.PI) * .5;
              if (job.previous) {
                m.position.x += (job.previous.x - job.item.x) * (1 - k);
                m.position.z += (job.previous.z - job.item.z) * (1 - k);
              }
            }
          }
          if (p >= 1) done++;
        });
        if (done === job.keys.length) {
          this.latestCompletion = { id: job.actor, text: `${job.item?.def || '구조물'} ${job.previous ? '이동' : '설치'} 완료` };
          job.keys.forEach((cellKey) => this.pending.delete(cellKey)); this.jobs.splice(this.jobs.indexOf(job), 1); changed = true;
        }
      }
      if (job.phase !== phase) changed = true;
    }
    // The name tag shows "작업 중" only while someone is building.
    if (changed) this.update(this.data);
  }

  reset() { this.angle = Math.PI / 4; this.elevation = .85; this.zoom = 1; this.pan.set(0, 0, 0); this.follow = null; }
  focusActors(ids) {
    const actors = ids.map((id) => this.agents[id]?.to).filter(Boolean);
    if (!actors.length) return;
    this.focusAt(actors.reduce((n, p) => n + p.x + .5, 0) / actors.length, actors.reduce((n, p) => n + p.z + .5, 0) / actors.length);
  }
  // Moves the view over a house position (a room, or a spot a member is at) and stops following anyone.
  focusAt(x, z) {
    this.follow = null;
    this.pan.set(x - this.bounds.x, 0, z - this.bounds.z);
    this.zoom = .65;
  }
  orbit(dx, dy, pan) {
    if (pan) {
      this.follow = null;
      const scale = this.bounds.span * this.zoom / Math.max(1, this.canvas.clientHeight);
      this.pan.x -= (Math.cos(this.angle) * dx + Math.sin(this.angle) * dy) * scale;
      this.pan.z += (Math.sin(this.angle) * dx - Math.cos(this.angle) * dy) * scale;
    } else {
      this.angle -= dx * .008;
      this.elevation = THREE.MathUtils.clamp(this.elevation + dy * .006, .25, 1.45);
    }
  }
  magnify(delta) {
    this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(delta * .001), .35, 2.5);
  }
  render(now) {
    if (!this.data || this.lost) return;
    if (!this.statusAt || now - this.statusAt > 1000) { this.statusAt = now; this.update(this.data); }
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const dt = Math.min(.1, (now - (this.last || now)) / 1000); this.last = now;
    for (const [id, actor] of Object.entries(this.agents)) {
      const { group, to, rig } = actor;
      if (actor.bubble && now >= actor.bubbleUntil) {
        group.remove(actor.bubble); actor.bubble.material.map.dispose(); actor.bubble.material.dispose(); actor.bubble = null;
      }
      const job = this.jobs.find((j) => j.actor === id);
      if (job) { animateBlockAvatar(rig, now / 1000, job.phase === 'walk'); continue; }
      const placement = furniturePose(this.data, to);
      const target = placement ? new THREE.Vector3(placement.x, placement.y, placement.z) : new THREE.Vector3(to.x + .5, 0, to.z + .5);
      const distance = group.position.distanceTo(target);
      const walking = distance > .02;
      if (walking) group.rotation.y = Math.atan2(target.x - group.position.x, target.z - group.position.z);
      group.position.lerp(target, distance ? Math.min(1, dt * 6 / distance) : 1);
      if (!walking && placement) group.rotation.y = placement.angle;
      const waving = to.waveUntil > Date.now() || to.pose === 'wave' && to.poseUntil > Date.now();
      animateBlockAvatar(rig, now / 1000, walking, waving ? 'wave' : placement?.pose);
    }
    this.stepJobs(dt);
    if (this.width !== w || this.height !== h) {
      this.renderer.setSize(w, h, false); this.width = w; this.height = h;
    }
    // Following a member glides the view over their character.
    const followed = this.follow && this.agents[this.follow];
    if (followed) {
      const p = followed.group.position;
      this.pan.lerp(new THREE.Vector3(p.x - this.bounds.x, 0, p.z - this.bounds.z), Math.min(1, dt * 4));
    }
    const camera = this.camera;
    this.renderer.setViewport(0, 0, w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const target = new THREE.Vector3(this.bounds.x, .4, this.bounds.z).add(this.pan);
    const distance = this.bounds.span * 1.8 * this.zoom * Math.max(1, h / w);
    camera.position.copy(target).add(new THREE.Vector3(
      Math.sin(this.angle) * Math.cos(this.elevation) * distance,
      Math.sin(this.elevation) * distance, Math.cos(this.angle) * Math.cos(this.elevation) * distance));
    camera.lookAt(target);
    this.renderer.render(this.scene, camera);
  }

  photo() {
    this.render(performance.now());
    const out = document.createElement('canvas');
    out.width = this.canvas.width; out.height = this.canvas.height;
    const ctx = out.getContext('2d'); ctx.drawImage(this.canvas, 0, 0);
    const scale = Math.max(1, out.width / 1000);
    ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(0, out.height - 44 * scale, out.width, 44 * scale);
    ctx.fillStyle = '#fff'; ctx.font = `${16 * scale}px sans-serif`;
    ctx.fillText(`집 · ${new Date().toLocaleString('ko-KR')}`, 12 * scale, out.height - 16 * scale);
    return out;
  }
}
