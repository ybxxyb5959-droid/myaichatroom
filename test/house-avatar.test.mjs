import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createBlockAvatar, animateBlockAvatar } from '../public/house-avatar.mjs';
import { houseEventHTML, lineIcon } from '../public/format.mjs';

const mesh = (_shape, x, y, z, w, h, d, color, parent) => {
  const part = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }));
  part.position.set(x + w / 2, y + h / 2, z + d / 2);
  parent.add(part); return part;
};
test('block avatars have independent shoulders, elbows, hips, knees and a head with grounded proportions', () => {
  const rig = createBlockAvatar(THREE, mesh, '#2f7cf6');
  assert.equal(Object.keys(rig.joints).length, 9);
  for (const side of ['left', 'right']) {
    assert.equal(rig.joints[`${side}Elbow`].parent, rig.joints[`${side}Shoulder`]);
    assert.equal(rig.joints[`${side}Knee`].parent, rig.joints[`${side}Hip`]);
  }
  const bounds = new THREE.Box3().setFromObject(rig.group);
  assert.ok(Math.abs(bounds.min.y - .02) < .001);
  assert.ok(Math.abs(bounds.max.y - 1.98) < .001);
});
test('walking swings opposite limbs and idle resets the legs without moving the character position', () => {
  const rig = createBlockAvatar(THREE, mesh, '#d97a3a');
  rig.group.position.set(3, 0, 4);
  animateBlockAvatar(rig, .1, true);
  assert.ok(rig.joints.leftHip.rotation.x > 0);
  assert.ok(rig.joints.rightHip.rotation.x < 0);
  assert.ok(rig.joints.leftShoulder.rotation.x < 0);
  assert.ok(rig.joints.rightShoulder.rotation.x > 0);
  animateBlockAvatar(rig, .1, false);
  for (const side of ['left', 'right']) {
    assert.equal(Math.abs(rig.joints[`${side}Hip`].rotation.x), 0);
    assert.equal(rig.joints[`${side}Knee`].rotation.x, 0);
  }
  assert.deepEqual(rig.group.position.toArray(), [3, 0, 4]);
});
test('event cards escape text and render a check-in button only for a valid event id', () => {
  assert.match(houseEventHTML('<img onerror=alert(1)>', 7), /&lt;img/);
  assert.match(houseEventHTML('Claude와 Gemini가 티격태격함', 7), /data-house-event="7">확인하러 가기/);
  assert.equal(houseEventHTML('hi', '"><script>'), `<span>${lineIcon('house')} hi</span>`);
});

test('sitting bends knees, lying rotates the body, waving raises an arm and walking resets poses', () => {
  const rig = createBlockAvatar(THREE, mesh, '#199b78');
  animateBlockAvatar(rig, 0, false, 'sit');
  assert.equal(rig.joints.leftHip.rotation.x, -Math.PI / 2);
  assert.equal(rig.joints.leftKnee.rotation.x, Math.PI / 2);
  animateBlockAvatar(rig, 0, false, 'lie');
  assert.equal(rig.body.rotation.x, -Math.PI / 2);
  animateBlockAvatar(rig, 0, false, 'wave');
  assert.ok(rig.joints.rightShoulder.rotation.z < -2);
  animateBlockAvatar(rig, 0, true);
  assert.equal(rig.body.rotation.x, 0);
  assert.deepEqual(rig.body.position.toArray(), [0, 0, 0]);
});

test('portrait models have distinct silhouettes and Claude has only orange skin and dark eyes, without headphones', () => {
  const silhouettes = [];
  for (const id of ['claude', 'gpt', 'gemini']) {
    const rig = createBlockAvatar(THREE, mesh, '#777777', id);
    const bounds = new THREE.Box3().setFromObject(rig.group);
    assert.ok(Math.abs(bounds.min.y - .02) < .001, `${id} feet meet the ground`);
    assert.ok(bounds.max.y < 2.1, `${id} fits below the name label`);
    const parts = [];
    const colors = new Set();
    rig.joints.head.traverse((part) => {
      if (!part.isMesh) return;
      colors.add(part.material.color.getHexString());
      parts.push([part.position.toArray(), part.geometry.parameters]);
    });
    silhouettes.push(JSON.stringify(parts));
    if (id === 'claude') assert.deepEqual([...colors].sort(), ['30312b', 'df8050']);
    if (id === 'gpt') assert.ok(colors.has('182c60') && colors.has('8bdeee'));
    if (id === 'gemini') assert.ok(colors.has('80d9f4') && colors.has('b49aff'));
  }
  assert.equal(new Set(silhouettes).size, 3);
});

test('all AI models retain articulated walking, sitting, lying and waving', () => {
  for (const id of ['claude', 'gpt', 'gemini']) {
    const rig = createBlockAvatar(THREE, mesh, '#777777', id);
    assert.equal(Object.keys(rig.joints).length, 9);
    rig.group.position.set(3, 0, 4);
    animateBlockAvatar(rig, .1, true);
    assert.ok(rig.joints.leftHip.rotation.x > 0);
    assert.ok(rig.joints.rightHip.rotation.x < 0);
    animateBlockAvatar(rig, 0, false, 'sit');
    assert.equal(rig.joints.leftHip.rotation.x, -Math.PI / 2);
    assert.equal(rig.joints.leftKnee.rotation.x, id === 'gemini' ? .25 : Math.PI / 2);
    assert.equal(rig.body.position.y, id === 'gpt' ? -.54 : -.42);
    assert.equal(rig.body.rotation.x, id === 'gemini' ? -.18 : 0);
    animateBlockAvatar(rig, 0, false, 'lie');
    assert.equal(rig.body.rotation.x, -Math.PI / 2);
    animateBlockAvatar(rig, 0, false, 'wave');
    assert.ok(id === 'gemini' ? rig.joints.rightShoulder.rotation.z > 1 : rig.joints.rightShoulder.rotation.z < -2);
    animateBlockAvatar(rig, 0, true);
    assert.equal(rig.body.rotation.x, 0);
    assert.deepEqual(rig.body.position.toArray(), [0, 0, 0]);
    assert.deepEqual(rig.group.position.toArray(), [3, 0, 4]);
  }
});

test('whole-body mascots keep limbs connected and faces on the front surface', () => {
  for (const id of ['claude', 'gpt', 'gemini']) {
    const rig = createBlockAvatar(THREE, mesh, '#777777', id);
    const torso = id === 'gpt' ? rig.body : rig.joints.head;
    for (const side of ['left', 'right']) {
      assert.equal(rig.joints[`${side}Shoulder`].parent, torso);
      assert.equal(rig.joints[`${side}Hip`].parent, torso);
      assert.equal(rig.joints[`${side}Elbow`].parent, rig.joints[`${side}Shoulder`]);
      assert.equal(rig.joints[`${side}Knee`].parent, rig.joints[`${side}Hip`]);
    }
    const faceColors = new Set(['30312b', '182c60', '253558', '8bdeee', 'f0faff']);
    rig.joints.head.traverse((part) => {
      if (!part.isMesh || !faceColors.has(part.material.color.getHexString())) return;
      assert.ok(part.geometry.parameters.depth <= .025, `${id} face detail is not extruded through the body`);
      assert.ok(part.position.z > .3, `${id} face is on the front`);
    });
    animateBlockAvatar(rig, 0, false, 'lie');
    const bounds = new THREE.Box3().setFromObject(rig.group);
    assert.ok(bounds.min.y >= 0, `${id} lies above the furniture surface`);
    const foot = rig.joints.rightKnee.children[0];
    animateBlockAvatar(rig, 0, false, 'sit');
    const seated = foot.getWorldPosition(new THREE.Vector3());
    assert.ok(seated.z > 0, `${id} seated feet extend forward`);
    const hand = rig.joints.rightElbow.children[0];
    animateBlockAvatar(rig, 0, false);
    const idle = hand.getWorldPosition(new THREE.Vector3()).y;
    animateBlockAvatar(rig, 0, false, 'wave');
    assert.ok(hand.getWorldPosition(new THREE.Vector3()).y > idle, `${id} wave raises its arm or star point`);
  }
});
