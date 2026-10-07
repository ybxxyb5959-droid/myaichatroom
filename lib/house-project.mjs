// A fixed spacious rebuild brief. Old saved houses keep their existing completion rules.
export const PROJECT_SIZE = 32;
export const PROJECT_ROOMS = [
  { name: '거실', owner: 'claude', x1: 3, z1: 3, x2: 15, z2: 13, min: 5, uses: ['sit'], furniture: '3인용 소파·안락의자·탁자·TV장·수납장' },
  { name: '주방·식당', owner: 'gpt', x1: 17, z1: 3, x2: 28, z2: 13, min: 5, uses: [], furniture: '조리대·싱크대·냉장고·식탁·의자' },
  { name: '침실 1', owner: 'claude', x1: 3, z1: 18, x2: 10, z2: 28, min: 3, uses: ['rest'], furniture: '침대·협탁·옷장' },
  { name: '침실 2', owner: 'gemini', x1: 12, z1: 18, x2: 18, z2: 28, min: 3, uses: ['rest'], furniture: '침대·협탁·옷장' },
  { name: '서재', owner: 'gpt', x1: 23, z1: 18, x2: 28, z2: 23, min: 4, uses: ['desk', 'read'], furniture: '책상·의자·책장·수납장' },
  { name: '욕실', owner: 'gemini', x1: 23, z1: 25, x2: 28, z2: 28, min: 3, uses: [], furniture: '욕조·세면대·변기' },
];
export const PROJECT_CORRIDORS = [
  { x1: 3, z1: 15, x2: 28, z2: 16 },
  { x1: 20, z1: 18, x2: 21, z2: 28 },
];
export const PROJECT_WALLS = [
  [2, 2, 29, 2], [2, 29, 29, 29], [2, 3, 2, 28], [29, 3, 29, 28],
  [3, 14, 28, 14], [3, 17, 28, 17], [16, 3, 16, 13],
  [11, 18, 11, 28], [19, 18, 19, 28], [22, 18, 22, 28], [23, 24, 28, 24],
];
export const PROJECT_DOORS = [[20, 29], [9, 14], [23, 14], [6, 17], [15, 17], [20, 17], [22, 20], [22, 26]];
const key = (x, z) => `${x},${z}`;
const neighbors = (x, z) => [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]];
export function rectangleCells({ x1, z1, x2, z2 }) {
  const cells = [];
  for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) cells.push([x, z]);
  return cells;
}
const floorCells = [...PROJECT_ROOMS, ...PROJECT_CORRIDORS].flatMap(rectangleCells);
const wallCells = PROJECT_WALLS.flatMap(([x1, z1, x2, z2]) => rectangleCells({ x1, z1, x2, z2 }));

export function projectStatus(house) {
  const { floors, walls, items } = house.s;
  const floorMissing = floorCells.filter(([x, z]) => !floors[key(x, z)]).length;
  const wallMissing = wallCells.filter(([x, z]) => !walls[key(x, z)]).length;
  const doorMissing = PROJECT_DOORS.filter(([x, z]) => !walls[key(x, z)]?.door).length;
  const reachable = new Set(), queue = [];
  const allowed = (x, z) => x >= 0 && z >= 0 && x < PROJECT_SIZE && z < PROJECT_SIZE
    && (floors[key(x, z)] || walls[key(x, z)]?.door) && house.walkable(x, z);
  const [entryX, entryZ] = PROJECT_DOORS[0];
  if (allowed(entryX, entryZ)) { reachable.add(key(entryX, entryZ)); queue.push([entryX, entryZ]); }
  for (let i = 0; i < queue.length; i++) {
    for (const [x, z] of neighbors(...queue[i])) {
      const k = key(x, z);
      if (!reachable.has(k) && allowed(x, z)) { reachable.add(k); queue.push([x, z]); }
    }
  }
  const rooms = PROJECT_ROOMS.map((room) => {
    const placed = items.filter((item) => {
      const cells = house.cellsOf(item);
      return cells.length && cells.every(([x, z]) => x >= room.x1 && x <= room.x2 && z >= room.z1 && z <= room.z2);
    });
    const missingUses = room.uses.filter((use) => !placed.some((item) => house.def(item.def)?.use === use));
    const accessible = rectangleCells(room).some(([x, z]) => reachable.has(key(x, z)))
      && placed.every((item) => house.cellsOf(item).some(([x, z]) => neighbors(x, z).some(([nx, nz]) => reachable.has(key(nx, nz)))));
    return { name: room.name, count: placed.length, min: room.min, missingUses, accessible };
  });
  const passagesOpen = PROJECT_DOORS.every(([x, z]) => reachable.has(key(x, z)));
  return { floorMissing, wallMissing, doorMissing, rooms, passagesOpen,
    complete: !floorMissing && !wallMissing && !doorMissing && passagesOpen
      && rooms.every((room) => room.count >= room.min && !room.missingUses.length && room.accessible) };
}

export function projectPrompt(house) {
  const status = projectStatus(house);
  const phase = status.floorMissing ? '1단계: 각 방과 복도 바닥을 작은 구역씩 깔기'
    : status.wallMissing || status.doorMissing ? '2단계: 외벽·칸막이·문을 작은 구간씩 만들기'
      : '3단계: 방별 필수 가구를 하나씩 설계·배치한 뒤 장식 더하기';
  return `\n[주인님이 승인한 넓은 집 재건축 — 이 배치를 축소하지 않는다]
실내 좌표(끝 좌표 포함), 담당, 최소 가구:
${PROJECT_ROOMS.map((r) => `- ${r.name}: (${r.x1},${r.z1})~(${r.x2},${r.z2}), 담당 ${house.names[r.owner] || r.owner}, 최소 ${r.min}개: ${r.furniture}${r.uses.length ? `; 필수 use=${r.uses.join(',')}` : ''}`).join('\n')}
복도: (3,15)~(28,16), (20,18)~(21,28). 복도에는 가구를 놓지 않는다.
벽 구간: ${PROJECT_WALLS.map(([x1, z1, x2, z2]) => `(${x1},${z1})~(${x2},${z2})`).join(', ')}. 긴 벽은 턴 제한에 맞게 나눠 만든다.
문: ${PROJECT_DOORS.map(([x, z]) => `(${x},${z})`).join(', ')}. (20,29)가 현관이다. 벽을 만든 뒤 해당 칸을 door로 바꾼다.
현재 ${phase}. 남은 바닥 ${status.floorMissing}칸, 벽 ${status.wallMissing}칸, 문 ${status.doorMissing}개.
가구 진행: ${status.rooms.map((r) => `${r.name} ${r.count}/${r.min}${r.missingUses.length ? ` (필수 use ${r.missingUses.join(',')} 부족)` : ''}`).join('; ')}.
담당은 쉬는 동료가 있으면 대신 이어서 한다. 전체 바닥 → 벽·문 → 방별 가구 → 장식 순서를 지킨다.
구조 단계가 끝나기 전에 작은 거실만 꾸미고 완성했다고 선언하지 않는다. 가구는 방 안에 놓고 문 앞과 가구 옆에 최소 1칸의 통로를 남긴다. 소파·침대·책상·책장의 define에는 올바른 use를 반드시 붙인다.
plan에는 현재 단계, 방별 완료/남은 작업과 다음 담당을 간결하게 갱신한다.`;
}
