// Only camera data is passed to the local screenshot renderer, never a model-supplied URL.
export function worldShotOptions(world, value) {
  const v = value && typeof value === 'object' ? value : {};
  const num = (x) => Number.isFinite(Number(x)) ? Number(x) : undefined;
  const vec = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => num(x) !== undefined) ? a.map(Number) : null;
  const at = Array.isArray(v.at) ? v.at : [v.x, v.z];
  const from = vec(v.from, 3), lookAt = vec(v.look_at, 3), quat = vec(v.quat, 4);
  if (from) {
    const [x, y, z] = from.map(Math.round);
    let free = Math.max(1, y);
    while (free < 40) {
      const block = world.blocks.get(`${x},${free},${z}`);
      if (!block || String(block).startsWith('door')) break;
      free++;
    }
    from[1] = free;
  }
  return {
    night: v.night === true || v.night === 'true' || v.night === 1, view: v.view === 'top' ? 'top' : 'iso',
    tx: num(at[0]) === undefined ? undefined : num(at[0]) + .5,
    tz: num(at[1]) === undefined ? undefined : num(at[1]) + .5,
    dist: num(v.dist), angle: num(v.angle), elev: from ? undefined : num(v.pitch),
    cx: from?.[0], cy: from?.[1], cz: from?.[2], lx: lookAt?.[0], ly: lookAt?.[1], lz: lookAt?.[2],
    yaw: from ? num(v.yaw) : undefined, pitch: from ? num(v.pitch) : undefined,
    qx: quat?.[0], qy: quat?.[1], qz: quat?.[2], qw: quat?.[3], fov: num(v.fov), cut: num(v.cut_y),
  };
}
