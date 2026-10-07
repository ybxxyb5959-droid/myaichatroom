// Block characters with shoulder/elbow and hip/knee pivots for future poses.
export function createBlockAvatar(THREE, mesh, color) {
  const group = new THREE.Group(), joints = {};
  const skin = '#ead0ae';
  const part = (parent, x, y, z, w, h, d, c) => mesh('box', x, y, z, w, h, d, c, parent);
  const pivot = (parent, name, x, y, z) => {
    const joint = new THREE.Group(); joint.name = name; joint.position.set(x, y, z);
    parent.add(joint); joints[name] = joint; return joint;
  };
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
  return { group, joints };
}

export function animateBlockAvatar(rig, seconds, walking) {
  const swing = walking ? Math.sin(seconds * 9) : 0;
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    rig.joints[`${side}Hip`].rotation.x = sign * swing * .45;
    rig.joints[`${side}Knee`].rotation.x = walking ? Math.max(0, -sign * swing) * .5 : 0;
    rig.joints[`${side}Shoulder`].rotation.x = -sign * swing * .55;
    rig.joints[`${side}Shoulder`].rotation.z = sign * (.04 + (walking ? 0 : Math.sin(seconds * 1.5) * .025));
    rig.joints[`${side}Elbow`].rotation.x = .08 + (walking ? Math.abs(swing) * .12 : 0);
  }
  rig.joints.head.rotation.y = walking ? 0 : Math.sin(seconds * .7) * .06;
}
