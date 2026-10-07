import { useOf } from './life.mjs';

const floor = (house, x, z) => Number.isInteger(x) && Number.isInteger(z)
  && !!house.s.floors[`${x},${z}`] && house.walkable(x, z);

export function playerView(house) {
  if (house.s.phase !== 'life') return null;
  let player = house.s.player;
  if (!player || !floor(house, player.x, player.z)) {
    const spot = Object.keys(house.s.floors).map((k) => k.split(',').map(Number))
      .find(([x, z]) => floor(house, x, z));
    if (!spot) return null;
    player = house.s.player = { x: spot[0], z: spot[1], doing: '집에 놀러 왔어요' };
  }
  if (player.furnitureId && !house.s.items.some((it) => it.id === player.furnitureId)) {
    delete player.furnitureId; delete player.pose; player.doing = '';
  }
  return player;
}

export function playerAction(house, body, names, now = Date.now()) {
  const player = playerView(house);
  if (!player) throw new Error('집이 완성되면 함께 놀 수 있어요.');
  if (body.action === 'move') {
    const { dx, dz } = body;
    if (!Number.isInteger(dx) || !Number.isInteger(dz) || Math.abs(dx) + Math.abs(dz) !== 1)
      throw new Error('한 번에 한 칸씩 이동할 수 있어요.');
    delete player.pose; delete player.furnitureId; player.doing = '';
    const x = player.x + dx, z = player.z + dz;
    if (floor(house, x, z)) Object.assign(player, { x, z });
  } else if (body.action === 'interact') {
    const nearby = house.s.items.find((it) => ['sit', 'rest'].includes(useOf(house.def(it.def), it.def))
      && house.cellsOf(it).some(([x, z]) => Math.abs(x - player.x) + Math.abs(z - player.z) === 1));
    if (nearby) {
      if (Object.values(house.s.agents).some((a) => a.furnitureId === nearby.id && ['sit', 'lie'].includes(a.pose)))
        throw new Error('지금 AI가 사용 중이에요. 빈 소파나 침대를 이용해 주세요.');
      player.furnitureId = nearby.id;
      player.pose = useOf(house.def(nearby.def), nearby.def) === 'rest' ? 'lie' : 'sit';
      player.doing = `${nearby.def}에서 ${player.pose === 'lie' ? '누워 쉬는 중' : '앉아 쉬는 중'}`;
    } else {
      const friend = Object.entries(house.s.agents).find(([, a]) => Math.abs(a.x - player.x) + Math.abs(a.z - player.z) <= 1);
      if (!friend) throw new Error('소파·침대나 AI 옆에서 E키를 눌러 주세요.');
      const [id, actor] = friend;
      Object.assign(player, { pose: 'wave', poseUntil: now + 2000, doing: `${names[id] || id}에게 인사!` });
      Object.assign(actor, { waveUntil: now + 2000 });
    }
  } else throw new Error('지원하지 않는 캐릭터 행동입니다.');
  house.save();
  return player;
}
