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

export function roomAt(rooms, x, z) {
  return rooms.findIndex((r) => x >= r.x1 && x < r.x2 + 1 && z >= r.z1 && z < r.z2 + 1);
}

// Shared by the character label and activity card; these are state labels, not AI speech.
export function actorActivity({ job, working = false, moving = false, doing = '', paused = false } = {}) {
  if (job) return job.phase === 'walk' ? `${job.item?.def || '자재'} 운반 중`
    : job.phase === 'hammer' ? `${job.item?.def || '구조물'} 설치 중` : '배치 마무리';
  if (working) return '계획 검토 중';
  if (paused) return '일시정지';
  // Saved states from before may still start with an emoji; the label shows words only.
  return moving ? '이동 중' : String(doing || '').replace(/^\p{Extended_Pictographic}️?\s*/u, '') || '대기 중';
}

// A visual worker route uses the same saved floors, walls and furniture footprints.
export function workerPath(data, start, target) {
  const key = (x, z) => `${x},${z}`;
  const floor = new Set(data.floors.map(([x, z]) => key(x, z)));
  const blocked = new Set(data.walls.filter((w) => !w[3]).map(([x, z]) => key(x, z)));
  data.walls.filter((w) => w[3]).forEach(([x, z]) => floor.add(key(x, z)));
  for (const item of data.items) {
    const def = data.defs[item.def];
    if (!def) continue;
    const { fw, fd } = rotateParts(def.parts, item.rot);
    for (let x = 0; x < fw; x++) for (let z = 0; z < fd; z++) blocked.add(key(item.x + x, item.z + z));
  }
  const origin = [Math.floor(start.x), Math.floor(start.z)], queue = [origin], previous = new Map([[key(...origin), null]]);
  let best = origin, score = Infinity;
  for (let i = 0; i < queue.length; i++) {
    const [x, z] = queue[i], distance = Math.abs(x + .5 - target.x) + Math.abs(z + .5 - target.z);
    if (floor.has(key(x, z)) && !blocked.has(key(x, z)) && distance < score) { best = [x, z]; score = distance; }
    for (const [nx, nz] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]]) {
      const k = key(nx, nz);
      if (previous.has(k) || !floor.has(k) || blocked.has(k)) continue;
      previous.set(k, [x, z]); queue.push([nx, nz]);
    }
  }
  const path = [];
  for (let p = best; p && key(...p) !== key(...origin); p = previous.get(key(...p))) path.unshift({ x: p[0] + .5, z: p[1] + .5 });
  return path;
}

// Everyday movement follows the server's rule (lib/house.mjs walkable/reachable): any cell in the grid that is not a
// closed wall or furniture, one step at a time. null when the target cannot be reached on foot.
export function walkPath(data, start, target) {
  const key = (x, z) => `${x},${z}`;
  const blocked = new Set(data.walls.filter((w) => !w[3]).map(([x, z]) => key(x, z)));
  for (const item of data.items) {
    const def = data.defs[item.def];
    if (!def) continue;
    const { fw, fd } = rotateParts(def.parts, item.rot);
    for (let x = 0; x < fw; x++) for (let z = 0; z < fd; z++) blocked.add(key(item.x + x, item.z + z));
  }
  const open = (x, z) => x >= 0 && z >= 0 && x < data.size && z < data.size && !blocked.has(key(x, z));
  const origin = [Math.floor(start.x), Math.floor(start.z)], goal = key(target.x, target.z);
  if (key(...origin) === goal) return [];
  const previous = new Map([[key(...origin), null]]), queue = [origin];
  for (let i = 0; i < queue.length; i++) {
    const [x, z] = queue[i];
    for (const [nx, nz] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]]) {
      const k = key(nx, nz);
      if (previous.has(k) || !open(nx, nz)) continue;
      previous.set(k, [x, z]);
      if (k === goal) {
        const path = [];
        for (let p = [nx, nz]; p && key(...p) !== key(...origin); p = previous.get(key(...p))) path.unshift({ x: p[0] + .5, z: p[1] + .5 });
        return path;
      }
      queue.push([nx, nz]);
    }
  }
  return null;
}
