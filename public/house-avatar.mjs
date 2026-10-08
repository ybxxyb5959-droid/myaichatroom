// Whole-body block mascots: a single orange body, an articulated robot,
// and a volumetric star whose side points are its arms.
const CHARACTERS = {
  claude: { hip: .42, shoulder: .95, width: .59, limb: '#df8050', lieHeight: .36 },
  gpt: { hip: .54, shoulder: 1.03, width: .43, limb: '#597bec', lieHeight: .35 },
  gemini: { hip: .42, shoulder: 1.05, width: .43, limb: '#b49aff', lieHeight: .36 },
};

// Keep the same joints for walking, building and furniture poses.
export function createBlockAvatar(THREE, mesh, color, id = 'user') {
  const root = new THREE.Group(), group = new THREE.Group(), joints = {};
  root.add(group);
  const skin = '#ead0ae';
  const part = (parent, x, y, z, w, h, d, c) => mesh('box', x, y, z, w, h, d, c, parent);
  const pivot = (parent, name, x, y, z) => {
    const joint = new THREE.Group(); joint.name = name; joint.position.set(x, y, z);
    parent.add(joint); joints[name] = joint; return joint;
  };
  const character = CHARACTERS[id];
  if (character) {
    const { hip: hipY, shoulder: shoulderY, width, limb } = character;
    const head = pivot(group, 'head', 0, id === 'gpt' ? 1.14 : 0, 0);
    // A unified mascot turns as a whole, so its limbs stay attached.
    const torso = id === 'gpt' ? group : head;
    if (id === 'claude') {
      part(torso, -.52, .42, -.32, 1.04, 1.08, .64, limb);
      part(torso, -.44, 1.50, -.26, .88, .12, .52, limb);
      for (const x of [-.34, .22]) part(torso, x, 1.15, .322, .12, .14, .025, '#30312b');
    } else if (id === 'gpt') {
      // A stepped shell, not facial pixels extruded through the head.
      part(head, -.48, .10, -.30, .96, .60, .60, limb);
      part(head, -.38, 0, -.25, .76, .80, .50, limb);
      part(head, -.27, .80, -.20, .54, .10, .40, '#839df8');
      part(head, -.36, .18, .302, .72, .43, .025, '#182c60');
      for (const [x, y] of [[-.22, .45], [-.16, .39], [-.22, .33], [.10, .33], [.16, .33]]) {
        part(head, x, y, .33, .065, .065, .02, '#8bdeee');
      }
      part(torso, -.32, .54, -.24, .64, .56, .48, limb);
      part(torso, -.24, 1.10, -.19, .48, .08, .38, '#839df8');
      part(torso, -.24, .66, .242, .48, .26, .025, '#3454bc');
      for (const [x, y] of [[-.16, .82], [-.10, .76], [-.16, .70], [.08, .70], [.14, .70]]) {
        part(torso, x, y, .27, .06, .06, .02, '#8bdeee');
      }
      part(torso, -.23, .67, -.28, .46, .32, .08, '#3454bc');
    } else {
      // Thick central volume with narrower top/bottom points. Separate side
      // points below are articulated arms, rather than human arms under a head.
      const diamond = (parent, bottom, step, widths, depth, c) => {
        widths.forEach((w, i) => part(parent, -w / 2, bottom + i * step, -depth / 2, w, step, depth, c));
      };
      diamond(torso, .42, .12, [.16, .32, .48, .64, .88, 1.04, .88, .64, .48, .32, .16], .48, limb);
      diamond(torso, .54, .12, [.16, .32, .48, .64, .80, .64, .48, .32, .16], .64, '#80d9f4');
      for (const x of [-.23, .15]) {
        part(torso, x, 1.05, .322, .08, .12, .025, '#253558');
        part(torso, x, 1.12, .35, .035, .035, .015, '#f0faff');
      }
      part(torso, -.08, .93, .322, .16, .045, .025, '#253558');
      for (const x of [-.34, .26]) part(torso, x, .96, .322, .08, .06, .025, limb);
    }
    for (const [side, sign] of [['left', -1], ['right', 1]]) {
      const shoulder = pivot(torso, `${side}Shoulder`, sign * width, shoulderY, 0);
      if (id === 'gemini') {
        part(shoulder, sign < 0 ? -.22 : 0, -.15, -.22, .22, .30, .44, limb);
        part(shoulder, sign < 0 ? -.18 : 0, -.09, -.25, .18, .18, .50, '#80d9f4');
        const elbow = pivot(shoulder, `${side}Elbow`, sign * .20, 0, 0);
        part(elbow, sign < 0 ? -.19 : 0, -.075, -.13, .19, .15, .26, limb);
      } else {
        part(shoulder, -.10, -.20, -.14, .20, .24, .28, limb);
        const elbow = pivot(shoulder, `${side}Elbow`, 0, -.20, 0);
        part(elbow, -.10, -.18, -.14, .20, .18, .28, limb);
        if (id === 'gpt') part(elbow, -.11, -.20, -.15, .22, .12, .30, '#839df8');
      }
      const hip = pivot(torso, `${side}Hip`, sign * (id === 'claude' ? .32 : .18), hipY, 0);
      const leg = (hipY - .02) / 2;
      part(hip, -.10, -leg, -.12, .20, leg, .24, limb);
      const knee = pivot(hip, `${side}Knee`, 0, -leg, 0);
      part(knee, -.10, -leg, -.12, .20, leg, .24, limb);
      part(knee, -.12, -leg, -.14, .24, .10, .34, limb);
    }
    return { group: root, body: group, joints, character: id, seatedDrop: hipY, lieHeight: character.lieHeight };
  }
  part(group, -.32, .70, -.18, .64, .65, .36, color);
  part(group, -.1, 1.35, -.1, .2, .07, .2, skin);
  const head = pivot(group, 'head', 0, 1.42, 0);
  part(head, -.27, 0, -.27, .54, .54, .54, skin);
  part(head, -.29, .44, -.29, .58, .12, .58, color);
  part(head, -.17, .26, .271, .075, .07, .02, '#202735');
  part(head, .095, .26, .271, .075, .07, .02, '#202735');
  part(head, -.09, .12, .271, .18, .035, .02, '#8d5e4b');
  for (const [side, sign] of [['left', -1], ['right', 1]]) {
    const shoulder = pivot(group, `${side}Shoulder`, sign * .42, 1.28, 0);
    part(shoulder, -.1, -.33, -.12, .2, .33, .24, color);
    const elbow = pivot(shoulder, `${side}Elbow`, 0, -.33, 0);
    part(elbow, -.1, -.22, -.12, .2, .22, .24, color);
    part(elbow, -.1, -.34, -.12, .2, .12, .24, skin);
    const hip = pivot(group, `${side}Hip`, sign * .17, .70, 0);
    part(hip, -.12, -.34, -.13, .24, .34, .26, '#36445a');
    const knee = pivot(hip, `${side}Knee`, 0, -.34, 0);
    part(knee, -.12, -.27, -.13, .24, .27, .26, '#36445a');
    part(knee, -.13, -.34, -.16, .26, .09, .38, '#252b34');
  }
  return { group: root, body: group, joints };
}

export function animateBlockAvatar(rig, seconds, walking, pose = '') {
  const starSitting = !walking && pose === 'sit' && rig.character === 'gemini';
  rig.body.rotation.x = !walking && pose === 'lie' ? -Math.PI / 2 : starSitting ? -.18 : 0;
  rig.body.position.set(0, !walking && pose === 'sit' ? -(rig.seatedDrop ?? .7) : !walking && pose === 'lie' ? (rig.lieHeight ?? .3) : 0,
    !walking && pose === 'lie' ? 1 : 0);
  const swing = walking ? Math.sin(seconds * 9) : 0;
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    rig.joints[`${side}Hip`].rotation.x = sign * swing * .45;
    rig.joints[`${side}Knee`].rotation.x = walking ? Math.max(0, -sign * swing) * .5 : 0;
    rig.joints[`${side}Shoulder`].rotation.x = -sign * swing * .55;
    rig.joints[`${side}Shoulder`].rotation.z = sign * (.04 + (walking ? 0 : Math.sin(seconds * 1.5) * .025));
    rig.joints[`${side}Elbow`].rotation.x = .08 + (walking ? Math.abs(swing) * .12 : 0);
  }
  rig.joints.head.rotation.y = walking ? 0 : Math.sin(seconds * .7) * .06;
  if (!walking && pose === 'sit') {
    for (const side of ['left', 'right']) {
      rig.joints[`${side}Hip`].rotation.x = -Math.PI / 2;
      rig.joints[`${side}Knee`].rotation.x = starSitting ? .25 : Math.PI / 2;
    }
  }
  if (!walking && pose === 'wave') {
    rig.joints.rightShoulder.rotation.z = (rig.character === 'gemini' ? 1.1 : -2.4) + Math.sin(seconds * 12) * .2;
    rig.joints.rightElbow.rotation.x = -.4;
  }
}
