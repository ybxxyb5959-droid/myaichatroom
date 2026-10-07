import * as THREE from '/vendor/three.module.js';
import { houseBounds, cameraViews, furnitureParts } from './house-view.mjs';
import { createBlockAvatar, animateBlockAvatar } from './house-avatar.mjs';

const COLORS = { claude: '#d97a3a', gpt: '#2f7cf6', gemini: '#5b6cf0' };
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
  constructor(canvas, thumbnails) {
    this.canvas = canvas;
    this.thumbnails = thumbnails;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.preview = new THREE.WebGLRenderer({ antialias: true });
    this.preview.setSize(480, 270);
    for (const renderer of [this.renderer, this.preview]) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
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
    this.cameras = Array.from({ length: 4 }, () => new THREE.PerspectiveCamera(60, 480 / 270, .1, 150));
    this.agents = {};
    this.angle = Math.PI / 4; this.elevation = .85; this.zoom = 1; this.selected = -1;
    this.pan = new THREE.Vector3();
    this.bounds = { x: 10, z: 10, span: 20 };
    this.lastPreview = 0;
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

  label(text, color, width = 3) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(0, 0, 512, 128, 30); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(text, 256, 78, 480);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
    sprite.scale.set(width, width / 4, 1);
    return sprite;
  }

  update(data, bubbles) {
    this.data = data;
    this.bubbles = bubbles;
    const key = JSON.stringify([data.floors, data.walls, data.defs, data.items]);
    if (key !== this.structureKey) {
      this.structureKey = key; dispose(this.structure);
      this.bounds = houseBounds(data);
      this.mesh('box', -1, -.18, -1, data.size + 2, .12, data.size + 2, '#c5d4ab');
      for (const [x, z, c] of data.floors) this.mesh('box', x, -.06, z, 1, .06, 1, data.palette[c]);
      for (const [x, z, c, door] of data.walls) {
        // Door cells keep a real open passage beneath their lintel.
        this.mesh('box', x, door ? 1.7 : 0, z, 1, door ? .6 : 2.3, 1, data.palette[c]);
      }
      for (const p of furnitureParts(data)) this.mesh(p.s, p.x, p.y, p.z, p.w, p.h, p.d, data.palette[p.c]);
      this.views = cameraViews(this.bounds);
      this.views.forEach((view, i) => {
        this.cameras[i].position.fromArray(view.position);
        this.cameras[i].lookAt(...view.target);
      });
    }
    for (const [id, to] of Object.entries(data.agents)) {
      if (!this.agents[id]) {
        const rig = createBlockAvatar(THREE, this.mesh.bind(this), COLORS[id] || '#777');
        const { group } = rig;
        const texture = new THREE.TextureLoader().load(`/avatars/${id}-pixel-128.png`);
        texture.colorSpace = THREE.SRGBColorSpace;
        const badge = new THREE.Mesh(new THREE.PlaneGeometry(.38, .38), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
        badge.position.set(0, 1.04, .185); group.add(badge);
        group.position.set(to.x + .5, 0, to.z + .5);
        this.people.add(group); this.agents[id] = { group, rig };
      }
      const actor = this.agents[id];
      actor.to = to;
      const speech = bubbles[id]?.until > Date.now() ? bubbles[id].text : '';
      const text = [data.names[id] || id, data.phase === 'life' ? to.doing : '', speech].filter(Boolean).join(' · ');
      if (text !== actor.text) {
        if (actor.label) { actor.group.remove(actor.label); actor.label.material.map.dispose(); actor.label.material.dispose(); }
        actor.label = this.label(text, COLORS[id] || '#555', speech ? 6 : 3);
        actor.label.position.y = 2.4; actor.group.add(actor.label); actor.text = text;
      }
      actor.speechUntil = speech ? bubbles[id].until : 0;
    }
    this.lastPreview = 0;
  }

  reset() { this.angle = Math.PI / 4; this.elevation = .85; this.zoom = 1; this.pan.set(0, 0, 0); }
  focusActors(ids) {
    const actors = ids.map((id) => this.agents[id]?.to).filter(Boolean);
    if (!actors.length) return;
    this.selected = -1;
    this.pan.set(actors.reduce((n, p) => n + p.x + .5, 0) / actors.length - this.bounds.x, 0,
      actors.reduce((n, p) => n + p.z + .5, 0) / actors.length - this.bounds.z);
    this.zoom = .65;
  }
  orbit(dx, dy, pan) {
    if (this.selected !== -1) return;
    if (pan) {
      const scale = this.bounds.span * this.zoom / Math.max(1, this.canvas.clientHeight);
      this.pan.x -= (Math.cos(this.angle) * dx + Math.sin(this.angle) * dy) * scale;
      this.pan.z += (Math.sin(this.angle) * dx - Math.cos(this.angle) * dy) * scale;
    } else {
      this.angle -= dx * .008;
      this.elevation = THREE.MathUtils.clamp(this.elevation + dy * .006, .25, 1.45);
    }
  }
  magnify(delta) {
    if (this.selected === -1) this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(delta * .001), .35, 2.5);
  }
  render(now) {
    if (!this.data || this.lost) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const dt = Math.min(.1, (now - (this.last || now)) / 1000); this.last = now;
    if (Object.values(this.agents).some((actor) => actor.speechUntil && actor.speechUntil <= Date.now())) {
      this.update(this.data, this.bubbles);
    }
    for (const { group, to, rig } of Object.values(this.agents)) {
      const target = new THREE.Vector3(to.x + .5, 0, to.z + .5);
      const distance = group.position.distanceTo(target);
      const walking = distance > .02;
      if (walking) group.rotation.y = Math.atan2(target.x - group.position.x, target.z - group.position.z);
      group.position.lerp(target, distance ? Math.min(1, dt * 2.2 / distance) : 1);
      animateBlockAvatar(rig, now / 1000, walking);
    }
    // Thumbnails share one small renderer rather than four extra WebGL contexts.
    if (now - this.lastPreview > 250 || !this.lastPreview) {
      this.cameras.forEach((camera, i) => {
        this.preview.render(this.scene, camera);
        const thumbnail = this.thumbnails[i];
        thumbnail.width = 480; thumbnail.height = 270;
        thumbnail.getContext('2d').drawImage(this.preview.domElement, 0, 0);
      });
      this.lastPreview = now;
    }
    if (this.width !== w || this.height !== h) {
      this.renderer.setSize(w, h, false); this.width = w; this.height = h;
    }
    const camera = this.selected === -1 ? this.camera : this.cameras[this.selected];
    if (this.selected === -1) {
      this.renderer.setViewport(0, 0, w, h);
      camera.aspect = w / h;
    } else {
      // Keep the fixed CCTV framing on narrow screens instead of cropping it.
      const width = Math.min(w, h * 16 / 9), height = width * 9 / 16;
      this.renderer.setViewport((w - width) / 2, (h - height) / 2, width, height);
      camera.aspect = 16 / 9;
    }
    camera.updateProjectionMatrix();
    if (this.selected === -1) {
      const target = new THREE.Vector3(this.bounds.x, .4, this.bounds.z).add(this.pan);
      const distance = this.bounds.span * 1.8 * this.zoom * Math.max(1, h / w);
      camera.position.copy(target).add(new THREE.Vector3(
        Math.sin(this.angle) * Math.cos(this.elevation) * distance,
        Math.sin(this.elevation) * distance, Math.cos(this.angle) * Math.cos(this.elevation) * distance));
      camera.lookAt(target);
    }
    this.renderer.render(this.scene, camera);
    // Restore thumbnail aspect after rendering an enlarged CCTV.
    camera.aspect = camera === this.camera ? w / h : 480 / 270; camera.updateProjectionMatrix();
  }

  photo() {
    this.render(performance.now());
    const out = document.createElement('canvas');
    out.width = this.canvas.width; out.height = this.canvas.height;
    const ctx = out.getContext('2d'); ctx.drawImage(this.canvas, 0, 0);
    const scale = Math.max(1, out.width / 1000);
    ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(0, out.height - 44 * scale, out.width, 44 * scale);
    ctx.fillStyle = '#fff'; ctx.font = `${16 * scale}px sans-serif`;
    const title = this.selected === -1 ? '집 전체' : this.views[this.selected].name;
    ctx.fillText(`${title} · ${new Date().toLocaleString('ko-KR')}`, 12 * scale, out.height - 16 * scale);
    return out;
  }
}
