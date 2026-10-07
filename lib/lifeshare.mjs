// AI life sharing: a small picture and a one-line remark posted by a member, like a friend sharing a photo.
// Pictures are drawn by the app as SVG (a top-down snapshot of the real house, or a template scene with
// the members' avatars). Remarks come from varied templates. No AI call is made for any of this; the
// existing real image generation (lib/activities.mjs, server.mjs) stays separate with its own safety cap.
import fs from 'node:fs';

const MIN = 60000, HOUR = 60 * MIN;
// Cooldown between spontaneous shares per activity level (randomised); a long absence doubles it.
export const SHARE_GAP = { low: 6 * HOUR, medium: 3 * HOUR, high: 90 * MIN };
const RECENT_MS = 60 * MIN;  // how fresh a house event, task or game must be to be shared
const AVATAR = Object.fromEntries(['claude', 'gpt', 'gemini'].map((id) => [id,
  `data:image/webp;base64,${fs.readFileSync(new URL(`../public/avatars/${id}-128.webp`, import.meta.url)).toString('base64')}`]));
const COLOR = { claude: '#d97a3a', gpt: '#2f7cf6', gemini: '#5b6cf0' };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Themes drawn from the house itself, and template places. {a} is the sharer, {b} the friend in the picture.
export const HOUSE_THEMES = ['home', 'sofa', 'desk', 'read', 'plant', 'change', 'reconcile', 'done', 'game'];
const PLACES = {
  cafe: { sky: ['#f6e3c7', '#e9c9a1'], ground: '#b98550', props: '☕ 🍰', label: '카페 느낌' },
  park: { sky: ['#bfe3ff', '#e6f6ff'], ground: '#7cbf6b', props: '🌳 🌼 🌳', label: '공원' },
  rain: { sky: ['#8796a8', '#b9c3cf'], ground: '#5d6b7a', props: '☔ 🌧️', label: '비 오는 날', rain: true },
  snack: { sky: ['#2b2f4a', '#43487a'], ground: '#3a3f63', props: '🍜 🍗 🌙', label: '야식' },
  party: { sky: ['#5b3b8f', '#ae75d5'], ground: '#3d2766', props: '🎉 🎈 🎊', label: '파티', confetti: true },
  halloween: { sky: ['#2b1d3a', '#5a2d5c'], ground: '#2a1a24', props: '🎃 👻 🦇', label: '할로윈' },
  christmas: { sky: ['#1d3557', '#457b9d'], ground: '#e8f1f2', props: '🎄 🎁 ⛄', label: '크리스마스', snow: true },
  newyear: { sky: ['#14213d', '#3a4a7a'], ground: '#1f2b4d', props: '🎆 🥂 ✨', label: '새해', confetti: true },
};
const CAPTIONS = {
  home: ['오늘 거실 분위기 괜찮은데', '그냥 집에 있는 중ㅋㅋ', '우리 집 지금 이럼', '평화로운 오후', '다들 집에 있네', '여기 은근 아늑함'],
  sofa: ['소파가 날 놔주지 않음', '잠깐 누워있는 중', '소파 최고ㅋㅋ', '오늘은 여기서 안 움직일래', '쉬는 것도 일이다', '소파에서 멍 때리는 중'],
  desk: ['책상 앞에 앉아 있음', '집중 모드 ON', '오늘 할 거 조금만 더', '책상 정리했더니 일이 잘 됨', '모니터 앞 고정', '조용히 작업 중'],
  read: ['책 몇 장 읽는 중', '책장 앞이 제일 조용함', '오늘은 독서 각', '이 구역 내가 접수함ㅋㅋ', '읽다가 졸 뻔'],
  plant: ['화분 물 줬음', '얘 좀 큰 것 같지 않아?', '식물 관리 중🌱', '초록초록하네', '화분 자리 옮겨봄'],
  change: ['집 좀 바뀜. 어때?', '{b}가 또 옮겨놨길래 찍어둠', '배치 바꿨더니 넓어 보임', '이거 누가 옮겼냐ㅋㅋ', '새 배치 공유함'],
  reconcile: ['{b}랑 정리 끝. 이제 괜찮음', '결국 이렇게 하기로 함ㅋㅋ', '{b} 말도 일리 있었음', '사이좋게 마무리', '다시 평화'],
  done: ['일 끝. 소파 간다', '작업 하나 끝냈음', '오늘 몫 끝ㅋㅋ', '끝냈다… 이제 쉰다', '완료 찍고 퇴근 각', '마무리 했음'],
  game: ['방금 게임 결과ㅋㅋ', '이겼다 인증', '한 판 더 할 사람?', '게임 끝. 다들 수고', '오늘 승자 공개'],
  cafe: ['카페 느낌으로 쉬는 중', '오늘은 여기서 쉬고 싶은 기분', '커피 한 잔 각', '분위기 좋다ㅋㅋ', '디저트까지 상상 중'],
  park: ['공원 산책 기분', '바람 좋다', '초록 보니까 좋네', '잠깐 바깥 공기 상상 중', '오늘 날씨 이런 느낌'],
  rain: ['비 오는 날 분위기', '창밖에 비 오는 느낌', '이런 날은 집이 최고', '빗소리 상상 중', '오늘은 촉촉하네'],
  snack: ['야식 생각나는 시간', '배고프다ㅋㅋ', '라면 각 아님?', '이 시간엔 야식이지', '참아야 하는데…'],
  party: ['나 파티옴ㅋㅋ', '조명 장난아님', '오늘은 신나는 날', '다들 모여!', '파티 분위기 내봄'],
  halloween: ['할로윈 분위기 내봄🎃', '사탕 줄 사람?', '오늘은 좀 으스스하게', '분장 뭐 할까'],
  christmas: ['크리스마스 느낌🎄', '선물 뭐 받고 싶어?', '눈 오는 상상 중', '연말 분위기 좋다'],
  newyear: ['새해 분위기✨', '올해도 잘 부탁해', '새해 목표 세우는 중', '카운트다운 상상 중'],
};
export function seasonOf(ms) {
  const d = new Date(ms), m = d.getMonth() + 1, day = d.getDate();
  if (m === 10 && day >= 25) return 'halloween';
  if (m === 12 && day >= 20 && day <= 26) return 'christmas';
  if ((m === 12 && day === 31) || (m === 1 && day <= 2)) return 'newyear';
  return null;
}
const pickFrom = (list, rand) => list[Math.floor(rand() * list.length)];
export function captionFor(theme, { a, b = '', recent = [], rand = Math.random }) {
  const options = CAPTIONS[theme].map((t) => t.replaceAll('{a}', a).replaceAll('{b}', b)).filter((t) => !t.includes('{'));
  const fresh = options.filter((t) => !recent.includes(t));
  return pickFrom(fresh.length ? fresh : options, rand);
}

// What to share now, or null. Fresh real events go first (a reconciliation, a house change, a finished
// task, a game result); otherwise a member shares what it is doing or a template place. The theme of
// the previous share is never repeated, and an event is shared only once.
export function chooseShare({ house, entries = [], ids, now, rand = Math.random, last = {} }) {
  if (!ids.length) return null;
  const used = new Set(last.refs || []);
  const fresh = (at) => now - at <= RECENT_MS;
  const ok = (theme) => theme !== last.theme;
  const ev = house?.s.phase === 'life' ? [...house.s.events].reverse().find((e) => fresh(e.at) && !used.has(`ev:${e.id}`) && e.actors.some((x) => ids.includes(x))) : null;
  if (ev && ['reconcile', 'mediate', 'owner'].includes(ev.type) && ok('reconcile')) {
    const [a, b] = ev.actors.filter((x) => ids.includes(x));
    return { actor: a, friends: b ? [b] : [], theme: 'reconcile', ref: `ev:${ev.id}` };
  }
  const changed = house?.s.phase === 'life' && house.s.undo && fresh(house.s.undo.at) && !used.has(`undo:${house.s.undo.at}`);
  if (changed && ok('change')) {
    const by = house.s.undo.by;
    const actor = ids.find((x) => x !== by) || ids[0];
    return { actor, friends: ids.includes(by) && by !== actor ? [by] : [], theme: 'change', ref: `undo:${house.s.undo.at}` };
  }
  const task = entries.find((e) => e.kind === 'task' && / 작업 완료$/.test(e.text) && fresh(e.at) && !used.has(`act:${e.id}`) && e.actors.some((x) => ids.includes(x)));
  if (task && ok('done')) return { actor: task.actors.find((x) => ids.includes(x)), friends: [], theme: 'done', ref: `act:${task.id}` };
  const game = entries.find((e) => e.kind === 'game' && fresh(e.at) && !used.has(`act:${e.id}`) && e.actors.some((x) => ids.includes(x)));
  if (game && ok('game')) return { actor: game.actors.find((x) => ids.includes(x)), friends: [], theme: 'game', ref: `act:${game.id}`, note: game.text };
  // Ambient: someone other than the last sharer shares its spot in the house or a template place.
  const pool = ids.length > 1 ? ids.filter((x) => x !== last.actor) : ids;
  const actor = pickFrom(pool, rand);
  const act = house?.s.phase === 'life' ? house.s.agents[actor]?.act : null;
  const spot = { sit: 'sofa', rest: 'sofa', 'after-work': 'sofa', desk: 'desk', work: 'desk', read: 'read', plant: 'plant', visit: 'home', talk: 'home' }[act];
  const season = seasonOf(now);
  const places = [...(season ? [season, season] : []), 'cafe', 'park', 'rain', 'snack', 'party'];
  const themes = [...(spot ? [spot, spot] : []), ...(house?.s.phase === 'life' ? ['home'] : []), ...places].filter(ok);
  const theme = pickFrom(themes, rand);
  const friend = ['home', 'party', 'cafe', 'park'].includes(theme) && ids.length > 1 && rand() < 0.5 ? pickFrom(ids.filter((x) => x !== actor), rand) : null;
  return { actor, friends: friend ? [friend] : [], theme };
}

// ---------- drawing ----------
const avatar = (id, x, y, r, name) => `<g><circle cx="${x}" cy="${y}" r="${r + 3}" fill="#fff" stroke="${COLOR[id] || '#888'}" stroke-width="3"/>
<clipPath id="c-${id}-${Math.round(x)}"><circle cx="${x}" cy="${y}" r="${r}"/></clipPath>
<image href="${AVATAR[id]}" x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}" clip-path="url(#c-${id}-${Math.round(x)})"/>
<rect x="${x - 34}" y="${y + r + 6}" width="68" height="18" rx="9" fill="${COLOR[id] || '#888'}"/><text x="${x}" y="${y + r + 19}" text-anchor="middle" font-size="11" fill="#fff" font-family="sans-serif">${escape(name)}</text></g>`;
const frame = (inner, caption, label) => `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320" role="img" aria-label="${escape(caption)}">
${inner}<rect x="0" y="270" width="480" height="50" fill="#000" opacity=".45"/>
<text x="16" y="292" font-family="sans-serif" font-size="15" fill="#fff">${escape(caption)}</text>
<text x="16" y="311" font-family="sans-serif" font-size="10" fill="#fff" opacity=".8">${escape(label)} · 앱이 그린 장면</text></svg>`;
function placeScene(theme, people, names, caption) {
  const p = PLACES[theme];
  const drops = p.rain ? Array.from({ length: 40 }, (_, i) => `<line x1="${(i * 53) % 480}" y1="${(i * 37) % 200}" x2="${(i * 53) % 480 - 6}" y2="${(i * 37) % 200 + 14}" stroke="#fff" opacity=".5"/>`).join('') : '';
  const dots = p.confetti || p.snow ? Array.from({ length: 30 }, (_, i) => `<circle cx="${(i * 71) % 480}" cy="${(i * 43) % 220}" r="${p.snow ? 3 : 2 + (i % 3)}" fill="${p.snow ? '#fff' : ['#ffd166', '#ef476f', '#06d6a0', '#ffffff'][i % 4]}" opacity=".8"/>`).join('') : '';
  const gap = 480 / (people.length + 1);
  return frame(`<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset="1" stop-color="${p.sky[1]}"/></linearGradient></defs>
<rect width="480" height="320" fill="url(#sky)"/><rect y="200" width="480" height="120" fill="${p.ground}"/>${drops}${dots}
<text x="240" y="90" text-anchor="middle" font-size="44">${p.props}</text>
${people.map((id, i) => avatar(id, gap * (i + 1), 190, 30, names[id] || id)).join('')}`, caption, p.label);
}
// A top-down snapshot of the real house: floor, walls, furniture and where each member stands.
function houseScene(theme, house, people, names, caption) {
  const s = house.s, cells = [...Object.keys(s.floors), ...Object.keys(s.walls)].map((k) => k.split(',').map(Number));
  const xs = cells.map(([x]) => x), zs = cells.map(([, z]) => z);
  const x0 = Math.min(...xs, 0) - 1, z0 = Math.min(...zs, 0) - 1, w = Math.max(...xs, 1) - x0 + 2, h = Math.max(...zs, 1) - z0 + 2;
  const size = Math.max(8, Math.min(26, Math.floor(Math.min(460 / w, 250 / h))));
  const ox = (480 - w * size) / 2, oz = (265 - h * size) / 2;
  const at = (x, z) => [ox + (x - x0) * size, oz + (z - z0) * size];
  const palette = { wood: '#b98550', beige: '#d8c3a0', cream: '#efe3c8', white: '#f4f1ea', gray: '#9ea3ab', blue: '#4f8fe0', navy: '#2f4a8a', green: '#5fa660', brown: '#5e3b22', darkwood: '#7a4e2d', red: '#d9534f', yellow: '#ecc94b', pink: '#ee93b4', purple: '#8b6bd1', teal: '#3aa6a0', orange: '#e8914a', lime: '#a6cf5a', black: '#23262d', darkgray: '#4f545e' };
  const floors = Object.entries(s.floors).map(([k, c]) => { const [x, z] = k.split(',').map(Number); const [px, py] = at(x, z); return `<rect x="${px}" y="${py}" width="${size}" height="${size}" fill="${palette[c] || '#ccc'}"/>`; }).join('');
  const walls = Object.entries(s.walls).map(([k, v]) => { const [x, z] = k.split(',').map(Number); const [px, py] = at(x, z); return `<rect x="${px}" y="${py}" width="${size}" height="${size}" fill="${v.door ? '#f4f1ea' : '#6b5b4b'}" opacity="${v.door ? 0.6 : 1}"/>`; }).join('');
  const focus = { sofa: /소파|의자|침대|쿠션/, desk: /책상|컴퓨터|데스크/, read: /책/, plant: /화분|식물|꽃|나무/ }[theme];
  const items = s.items.map((it) => {
    const cellsOf = house.cellsOf(it);
    const minX = Math.min(...cellsOf.map(([x]) => x)), minZ = Math.min(...cellsOf.map(([, z]) => z));
    const cw = Math.max(...cellsOf.map(([x]) => x)) - minX + 1, ch = Math.max(...cellsOf.map(([, z]) => z)) - minZ + 1;
    const [px, py] = at(minX, minZ), color = palette[house.def(it.def)?.parts?.[0]?.c] || '#999';
    const hot = focus?.test(it.def);
    return `<rect x="${px + 1}" y="${py + 1}" width="${cw * size - 2}" height="${ch * size - 2}" rx="3" fill="${color}" stroke="${hot ? '#ffd166' : '#0003'}" stroke-width="${hot ? 3 : 1}"/>`;
  }).join('');
  const marks = people.map((id) => { const a = s.agents[id] || { x: 0, z: 0 }; const [px, py] = at(a.x, a.z); return avatar(id, px + size / 2, py + size / 2 - 6, Math.max(12, size * 0.7), names[id] || id); }).join('');
  return frame(`<rect width="480" height="320" fill="#efe6d2"/>${floors}${walls}${items}${marks}`, caption, { done: '작업 끝', game: '게임 결과', change: '집 변화', reconcile: '화해' }[theme] || '집');
}
export function renderShare({ theme, actor, friends = [], house, names, caption }) {
  const people = [actor, ...friends];
  const houseOk = house && Object.keys(house.s.floors).length && HOUSE_THEMES.includes(theme);
  return houseOk ? houseScene(theme, house, people, names, caption) : placeScene(PLACES[theme] ? theme : 'cafe', people, names, caption);
}
