import { rotateParts } from './house-shape.mjs';

// The saved grid remains the source of truth, including quarter-turn furniture.
export function houseBounds(data) {
  const cells = [...data.floors, ...data.walls];
  if (!cells.length) return { x: data.size / 2, z: data.size / 2, span: data.size };
  const xs = cells.map(([x]) => x), zs = cells.map(([, z]) => z);
  const minX = Math.min(...xs), maxX = Math.max(...xs) + 1;
  const minZ = Math.min(...zs), maxZ = Math.max(...zs) + 1;
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2,
    span: Math.max(6, maxX - minX, maxZ - minZ) };
}

export function furnitureParts(data) {
  return data.items.flatMap((item) => {
    const def = data.defs[item.def];
    if (!def) return [];
    return rotateParts(def.parts, item.rot).parts.map((part) => ({
      ...part, x: item.x + part.x, z: item.z + part.z,
    }));
  });
}
