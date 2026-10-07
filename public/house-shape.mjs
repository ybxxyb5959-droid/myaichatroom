// Furniture geometry shared by the server (placement checks) and the 3D house view.
// A furniture definition is a few primitive parts in tile units, relative to the item's
// top-left corner: {s:'box'|'cyl'|'ball', x, y, z, w, h, d, c}.
export const MAX_SIDE = 4;

export function footprintOf(parts) {
  return {
    fw: Math.max(1, Math.ceil(Math.max(...parts.map((p) => p.x + p.w)) - 1e-9)),
    fd: Math.max(1, Math.ceil(Math.max(...parts.map((p) => p.z + p.d)) - 1e-9)),
  };
}

// Rotate by rot quarter turns (clockwise seen from above); returns parts and the new footprint.
export function rotateParts(parts, rot = 0) {
  let { fw, fd } = footprintOf(parts);
  let list = parts;
  for (let i = 0; i < ((rot % 4) + 4) % 4; i++) {
    list = list.map((p) => ({ ...p, x: fd - (p.z + p.d), z: p.x, w: p.d, d: p.w }));
    [fw, fd] = [fd, fw];
  }
  return { parts: list, fw, fd };
}
