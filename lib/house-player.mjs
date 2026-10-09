import { useOf } from './life.mjs';
import { SIZE } from './house.mjs';

// People in the house: the owner's character is house.s.player (key 'user'); each friend who opens the house gets
// house.s.visitors['guest:<id>']. Everyone walks one cell at a time on any walkable cell (lib/house.mjs walkable),
// during construction too, so walls and furniture block people exactly as they block the AI members.
const stand = (house, x, z) => Number.isInteger(x) && Number.isInteger(z) && house.walkable(x, z);
export const isPerson = (who) => who === 'user' || /^guest:[\w-]{1,80}$/.test(who);
export function people(house) {
  return [['user', house.s.player], ...Object.entries(house.s.visitors || {})].filter(([, p]) => p);
}
function slotOf(house, who) {
  if (who === 'user') return { get: () => house.s.player, set: (p) => { house.s.player = p; } };
  house.s.visitors ||= {};
  return { get: () => house.s.visitors[who], set: (p) => { if (p) house.s.visitors[who] = p; else delete house.s.visitors[who]; } };
}
// A free cell to appear on: a floor cell if there is one, otherwise open ground near the front of the plot.
function entrySpot(house) {
  const taken = new Set([...Object.values(house.s.agents), ...people(house).map(([, p]) => p)].map((p) => `${p.x},${p.z}`));
  const ok = (x, z) => stand(house, x, z) && !taken.has(`${x},${z}`);
  const floor = Object.keys(house.s.floors).map((k) => k.split(',').map(Number)).find(([x, z]) => ok(x, z));
  if (floor) return floor;
  const size = SIZE, cx = Math.floor(size / 2);
  for (let r = 0; r < size; r++) for (let dx = -r; dx <= r; dx++) {
    const x = cx + dx, z = size - 1 - (r - Math.abs(dx));
    if (ok(x, z)) return [x, z];
  }
  return null;
}

export function playerView(house, who = 'user') {
  const slot = slotOf(house, who);
  let player = slot.get();
  if (!player || !stand(house, player.x, player.z)) {
    const spot = entrySpot(house);
    if (!spot) return null;
    player = { ...(player || {}), x: spot[0], z: spot[1], doing: '집에 놀러 왔어요' };
    delete player.pose; delete player.furnitureId;
    slot.set(player);
  }
  if (player.furnitureId && !house.s.items.some((it) => it.id === player.furnitureId)) {
    delete player.furnitureId; delete player.pose; player.doing = '';
  }
  return player;
}
// What the interact (E) button would do right now, so the button can say it: sit, lie down or wave; null = nothing near.
export function nearbyAction(house, who = 'user', participants = house.ids) {
  const player = who === 'user' ? house.s.player : house.s.visitors?.[who];
  if (!player) return null;
  if (['sit', 'lie'].includes(player.pose)) return { kind: 'up', label: '일어나기' };
  const item = house.s.items.find((it) => ['sit', 'rest'].includes(useOf(house.def(it.def), it.def))
    && house.cellsOf(it).some(([x, z]) => Math.abs(x - player.x) + Math.abs(z - player.z) === 1));
  if (item) return useOf(house.def(item.def), item.def) === 'rest' ? { kind: 'lie', label: '눕기', target: item.def } : { kind: 'sit', label: '앉기', target: item.def };
  const friend = Object.entries(house.s.agents).find(([id, a]) => participants.includes(id) && Math.abs(a.x - player.x) + Math.abs(a.z - player.z) <= 1);
  return friend ? { kind: 'wave', label: '인사', target: friend[0] } : null;
}
export function leaveHouse(house, who) { if (who !== 'user') slotOf(house, who).set(null); }

export function playerAction(house, body, names, now = Date.now(), participants = house.ids, who = 'user') {
  const player = playerView(house, who);
  if (!player) throw new Error('집 안에 설 자리가 없어요. 잠시 뒤 다시 시도해 주세요.');
  const others = people(house).filter(([id]) => id !== who).map(([, p]) => p);
  if (body.action === 'move') {
    const { dx, dz } = body;
    if (!Number.isInteger(dx) || !Number.isInteger(dz) || Math.abs(dx) + Math.abs(dz) !== 1)
      throw new Error('한 번에 한 칸씩 이동할 수 있어요.');
    delete player.pose; delete player.furnitureId; player.doing = '';
    const x = player.x + dx, z = player.z + dz;
    if (stand(house, x, z)) Object.assign(player, { x, z });
  } else if (body.action === 'interact' && ['sit', 'lie'].includes(player.pose)) {
    delete player.pose; delete player.furnitureId; player.doing = '';
  } else if (body.action === 'interact') {
    const nearby = house.s.items.find((it) => ['sit', 'rest'].includes(useOf(house.def(it.def), it.def))
      && house.cellsOf(it).some(([x, z]) => Math.abs(x - player.x) + Math.abs(z - player.z) === 1));
    if (nearby) {
      if (Object.entries(house.s.agents).some(([id, a]) => participants.includes(id) && a.furnitureId === nearby.id && ['sit', 'lie'].includes(a.pose))
        || others.some((p) => p.furnitureId === nearby.id && ['sit', 'lie'].includes(p.pose)))
        throw new Error('지금 다른 사람이 사용 중이에요. 빈 소파나 침대를 이용해 주세요.');
      player.furnitureId = nearby.id;
      player.pose = useOf(house.def(nearby.def), nearby.def) === 'rest' ? 'lie' : 'sit';
      player.doing = `${nearby.def}에서 ${player.pose === 'lie' ? '누워 쉬는 중' : '앉아 쉬는 중'}`;
    } else {
      const friend = Object.entries(house.s.agents).find(([id, a]) => participants.includes(id) && Math.abs(a.x - player.x) + Math.abs(a.z - player.z) <= 1);
      if (!friend) throw new Error('소파·침대나 AI 옆에서 상호작용(E) 버튼을 눌러 주세요.');
      const [id, actor] = friend;
      Object.assign(player, { pose: 'wave', poseUntil: now + 2000, doing: `${names[id] || id}에게 인사!` });
      Object.assign(actor, { waveUntil: now + 2000 });
    }
  } else throw new Error('지원하지 않는 캐릭터 행동입니다.');
  house.save();
  return player;
}
