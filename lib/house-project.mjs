// The old layout is retained only to read legacy saves. Live rooms opt into
// AI-authored plans; no legacy dimensions or owners are imposed on those plans.
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
const legacy = { title: '기존 집', rooms: PROJECT_ROOMS, corridors: PROJECT_CORRIDORS,
  walls: PROJECT_WALLS, doors: PROJECT_DOORS, entry: PROJECT_DOORS[0] };
const layoutOf = house => house.s.planning ? house.s.planning.design : house.s.project === 'spacious' ? legacy : null;
const uniqueCells = cells => [...new Map(cells.map(p => [key(...p), p])).values()];
const floorsOf = layout => uniqueCells([...layout.rooms, ...layout.corridors].flatMap(rectangleCells));
const wallsOf = layout => uniqueCells(layout.walls.flatMap(([x1, z1, x2, z2]) => rectangleCells({ x1, z1, x2, z2 })));

function reachableFrom(entry, allowed) {
  const reachable = new Set(), queue = [];
  if (allowed(...entry)) { reachable.add(key(...entry)); queue.push(entry); }
  for (let i = 0; i < queue.length; i++) for (const [x, z] of neighbors(...queue[i])) {
    const k = key(x, z);
    if (!reachable.has(k) && allowed(x, z)) { reachable.add(k); queue.push([x, z]); }
  }
  return reachable;
}

export function assignedRooms(rooms, participants) {
  return rooms.map((room, i) => ({ ...room,
    owner: participants.includes(room.owner) ? room.owner : participants[i % participants.length] || null,
  }));
}

// Validate the AI's explicit geometry, not guessed room names or prose.
export function validateDesign(raw, participants, limits, uses) {
  const fail = message => { throw new Error(`공동 계획: ${message}`); };
  const text = (value, max) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f<>]/.test(value)) fail('이름·설명을 확인하세요.');
    return value.trim();
  };
  const cell = value => {
    if (!Number.isInteger(value) || value < 0 || value >= PROJECT_SIZE) fail('좌표가 격자 범위를 벗어났어요.');
    return value;
  };
  const area = value => {
    if (!value || typeof value !== 'object') fail('방의 영역이 필요해요.');
    const x1 = cell(value.x1), z1 = cell(value.z1), x2 = cell(value.x2), z2 = cell(value.z2);
    if (x1 > x2 || z1 > z2) fail('영역의 시작·끝 순서를 확인하세요.');
    return { x1, z1, x2, z2 };
  };
  const list = (value, max) => {
    if (!Array.isArray(value) || value.length > max) fail(`목록은 최대 ${max}개예요.`);
    return value;
  };
  if (!raw || typeof raw !== 'object') fail('설계 객체가 필요해요.');
  const names = new Set(), occupied = new Set();
  const rooms = list(raw.rooms, 12).map(r => {
    const rect = area(r), name = text(r.name, 24);
    if (names.has(name)) fail('방 이름은 중복할 수 없어요.');
    names.add(name);
    if (!participants.includes(r.owner)) fail('현재 참가한 AI만 담당으로 정하세요.');
    const required = [...new Set(list(r.uses ?? [], uses.length))];
    if (required.some(use => !uses.includes(use))) fail('지원하는 가구 용도를 사용하세요.');
    if (!Number.isInteger(r.min) || r.min < required.length || r.min > limits.items) fail('가구 목표 수를 확인하세요.');
    for (const p of rectangleCells(rect)) {
      if (occupied.has(key(...p))) fail('방 영역이 겹쳐요.');
      occupied.add(key(...p));
    }
    return { ...rect, name, owner: r.owner, min: r.min, uses: required };
  });
  if (!rooms.length || rooms.reduce((n, r) => n + r.min, 0) > limits.items) fail('방·가구 목표 수를 확인하세요.');
  const corridors = list(raw.corridors ?? [], 24).map(area);
  for (const p of corridors.flatMap(rectangleCells)) if (occupied.has(key(...p))) fail('복도와 방 영역이 겹쳐요.');
  const walls = list(raw.walls ?? [], 64).map(line => {
    if (!Array.isArray(line) || line.length !== 4) fail('벽은 좌표 4개로 지정하세요.');
    const [x1, z1, x2, z2] = line.map(cell);
    if (x1 > x2 || z1 > z2 || (x1 !== x2 && z1 !== z2)) fail('벽은 가로·세로 선분이어야 해요.');
    return [x1, z1, x2, z2];
  });
  const point = value => {
    if (!Array.isArray(value) || value.length !== 2) fail('위치는 좌표 2개로 지정하세요.');
    return value.map(cell);
  };
  const doors = uniqueCells(list(raw.doors ?? [], limits.walls).map(point));
  const design = { title: text(raw.title, 120), rooms, corridors, walls, doors, entry: point(raw.entry) };
  const floors = new Set(floorsOf(design).map(p => key(...p)));
  const wallSet = new Set(wallsOf(design).map(p => key(...p))), doorSet = new Set(doors.map(p => key(...p)));
  if (wallSet.size > limits.walls) fail('벽 목표가 저장 가능한 최대 칸 수를 넘었어요.');
  if (doors.some(p => !wallSet.has(key(...p)))) fail('문은 계획한 벽에 있어야 해요.');
  if ([...wallSet].some(k => floors.has(k) && !doorSet.has(k))) fail('벽이 실내 바닥이나 복도를 가로막아요.');
  const reachable = reachableFrom(design.entry, (x, z) => floors.has(key(x, z)) || doorSet.has(key(x, z)));
  if ([...floors, ...doorSet].some(k => !reachable.has(k))) fail('출입 지점에서 모든 방과 복도가 연결되어야 해요.');
  return design;
}

export function updateDesign(house, actor, reply, participants, limits, uses, now) {
  const planning = house.s.planning;
  if (!planning || (!reply.design && !reply.designDecision)) return '';
  if (!participants.includes(actor) || typeof reply.say !== 'string' || !reply.say.trim()) throw new Error('공동 계획은 현재 참가 AI의 실제 설명과 함께 제출하세요.');
  if (reply.design && reply.designDecision) throw new Error('새 설계와 검토 결정 중 하나만 제출하세요.');
  const accept = design => {
    planning.design = design; planning.pending = null; planning.feedback = '';
    house.s.plan = design.title; house.s.phase = 'build';
    return 'approved';
  };
  if (reply.design) {
    const design = validateDesign(reply.design, participants, limits, uses);
    if (participants.length === 1) return accept(design);
    planning.pending = { id: planning.nextId++, by: actor, design, at: now };
    planning.feedback = '';
    return 'proposed';
  }
  const decision = reply.designDecision, pending = planning.pending;
  if (!pending || decision.id !== pending.id || !['approve', 'reject'].includes(decision.choice)) throw new Error('현재 설계 제안 ID와 검토 결정을 확인하세요.');
  if (actor === pending.by && participants.length > 1) throw new Error('다른 참가 AI가 설계를 검토해야 해요.');
  if (decision.choice === 'reject') {
    planning.pending = null;
    planning.feedback = String(decision.reason || reply.say).slice(0, 200);
    return 'rejected';
  }
  return accept(validateDesign({ ...pending.design, rooms: assignedRooms(pending.design.rooms, participants) }, participants, limits, uses));
}

export function projectStatus(house) {
  const layout = layoutOf(house);
  if (!layout) return { floorMissing: 0, wallMissing: 0, doorMissing: 0, rooms: [], passagesOpen: false, complete: false };
  const floorCells = floorsOf(layout), wallCells = wallsOf(layout);
  const { floors, walls, items } = house.s;
  const floorMissing = floorCells.filter(([x, z]) => !floors[key(x, z)]).length;
  const wallMissing = wallCells.filter(([x, z]) => !walls[key(x, z)]).length;
  const doorMissing = layout.doors.filter(([x, z]) => !walls[key(x, z)]?.door).length;
  const allowed = (x, z) => x >= 0 && z >= 0 && x < PROJECT_SIZE && z < PROJECT_SIZE
    && (floors[key(x, z)] || walls[key(x, z)]?.door) && house.walkable(x, z);
  const reachable = reachableFrom(layout.entry, allowed);
  const rooms = layout.rooms.map((room) => {
    const placed = items.filter((item) => {
      const cells = house.cellsOf(item);
      return cells.length && cells.every(([x, z]) => x >= room.x1 && x <= room.x2 && z >= room.z1 && z <= room.z2);
    });
    const missingUses = room.uses.filter((use) => !placed.some((item) => house.def(item.def)?.use === use));
    const accessible = rectangleCells(room).some(([x, z]) => reachable.has(key(x, z)))
      && placed.every((item) => house.cellsOf(item).some(([x, z]) => neighbors(x, z).some(([nx, nz]) => reachable.has(key(nx, nz)))));
    return { name: room.name, count: placed.length, min: room.min, missingUses, accessible };
  });
  const passagesOpen = layout.doors.every(([x, z]) => reachable.has(key(x, z)))
    && layout.rooms.every(room => rectangleCells(room).some(p => reachable.has(key(...p))));
  return { floorMissing, wallMissing, doorMissing, rooms, passagesOpen,
    complete: !floorMissing && !wallMissing && !doorMissing && passagesOpen
      && rooms.every((room) => room.count >= room.min && !room.missingUses.length && room.accessible) };
}

// What the house screen shows as the construction board: floors per room, furniture per room, and an overall percent.
export function projectProgress(house, participants = house.ids) {
  const layout = layoutOf(house);
  if (!layout) return { rooms: [], percent: null, stage: 'planning' };
  const floorCells = floorsOf(layout), wallCells = wallsOf(layout);
  const { floors } = house.s;
  const status = projectStatus(house);
  const rooms = assignedRooms(layout.rooms, participants).map((room, i) => {
    const cells = rectangleCells(room);
    return { name: room.name, owner: room.owner, x1: room.x1, z1: room.z1, x2: room.x2, z2: room.z2,
      accessible: status.rooms[i].accessible, missingUses: status.rooms[i].missingUses,
      x: (room.x1 + room.x2 + 1) / 2, z: (room.z1 + room.z2 + 1) / 2,
      floor: cells.filter(([x, z]) => floors[key(x, z)]).length, floorTotal: cells.length,
      count: status.rooms[i].count, min: room.min };
  });
  const total = floorCells.length + wallCells.length + layout.doors.length + layout.rooms.reduce((n, r) => n + r.min, 0);
  const left = status.floorMissing + status.wallMissing + status.doorMissing + rooms.reduce((n, r) => n + Math.max(0, r.min - r.count), 0);
  return { rooms, percent: status.complete ? 100 : Math.min(99, Math.round((total - left) / total * 100)),
    stage: status.floorMissing ? 'floor' : status.wallMissing || status.doorMissing ? 'wall' : 'furniture' };
}

export function projectPrompt(house, participants = house.ids) {
  const planning = house.s.planning, layout = layoutOf(house);
  if (planning) {
    const effective = layout && { ...layout, rooms: assignedRooms(layout.rooms, participants) };
    return '\n[AI 자율 공동 계획 — 현재 참가자와 현재 집이 기준]\n'
      + '방 수·방 이름·크기·담당·가구 목표·작업 순서는 코드가 정하지 않는다. 기존 집을 보존하며 너희가 정한다. 완료율은 승인된 설계와 실제 배치로만 계산한다.\n'
      + (effective ? `승인된 설계(부재 담당은 현재 참가자가 임시 대행): ${JSON.stringify(effective)}\n현재 진행: ${JSON.stringify(projectProgress(house, participants))}\n` : '아직 승인된 설계가 없다. 기존 집의 지도와 가구를 보고 다음 목표를 design으로 제안한다. 설계 승인 전에는 집을 바꾸지 않는다.\n')
      + (planning.pending ? `검토할 실제 제안 #${planning.pending.id}, 제안 당시 작성자 ${planning.pending.by}: ${JSON.stringify({
        ...planning.pending.design, rooms: assignedRooms(planning.pending.design.rooms, participants),
      })}\n다른 참가자는 동의하면 designDecision으로 승인하고, 반대하면 이유를 설명하거나 새 design을 제안한다.\n` : '')
      + (planning.feedback ? `직전 계획 피드백: ${planning.feedback}\n` : '')
      + '새 design은 목표가 바뀔 때만 제출하고, 매 턴 다시 설계하지 않는다. 혼자 참여하면 직접 결정한다. 완료율을 올리려고 미완료 목표를 지우지 않는다.\n';
  }
  return layout ? `\n[이전 저장 형식의 배치 참고 — 새 설계를 강제하는 지시가 아님]\n${JSON.stringify({
    ...layout, rooms: assignedRooms(layout.rooms, participants),
  })}\n현재 진행: ${JSON.stringify(projectProgress(house, participants))}\n` : '';
}
