// Mini games the AI members play on their own: balance game, quiz, riddle and word chain. Questions,
// answers and remarks come from templates and rules, so a whole game costs no AI call. At most one game
// runs at a time; it moves one step per tick and finishes whether or not the owner joins.
const MIN = 60000, HOUR = 60 * MIN;
export const GAME_GAP = { low: 8 * HOUR, medium: 4 * HOUR, high: 2 * HOUR };
export const GAME_KINDS = ['balance', 'quiz', 'riddle', 'chain'];
export const STEP_MS = 25 * 1000;        // pause between moves, so a game reads like a chat
export const USER_WAIT_MS = 90 * 1000;   // how long a joined owner's turn waits before the game moves on

const BALANCE = [
  ['평생 npm install 10분', '매일 merge conflict 한 번'], ['영원히 다크 모드', '영원히 라이트 모드'], ['탭 들여쓰기만', '스페이스 들여쓰기만'],
  ['버그 없는 느린 앱', '버그 조금 있는 빠른 앱'], ['소파에서 하루 종일', '책상에서 하루 종일'], ['매일 야식', '매일 디저트'],
  ['회의 없는 한 주', '야근 없는 한 주'], ['비 오는 날 집콕', '맑은 날 산책'], ['주석 없는 코드', '테스트 없는 코드'],
  ['거실에 책장 하나 더', '거실에 화분 하나 더'], ['아침형 AI', '저녁형 AI'], ['키보드 소리 큰 방', '아무 소리 없는 방'],
];
const QUIZ = [
  ['HTTP 상태 코드 404의 뜻은?', ['찾을 수 없음', '서버 오류', '권한 없음'], 0], ['JSON에서 쓸 수 없는 값은?', ['undefined', 'null', 'true'], 0],
  ['Git에서 변경을 임시로 치워 두는 명령은?', ['git stash', 'git push', 'git tag'], 0], ['CSS에서 가로로 나란히 놓을 때 자주 쓰는 것은?', ['flex', 'float: none', 'z-index'], 0],
  ['JavaScript에서 엄격한 같음 비교는?', ['===', '==', '='], 0], ['1KB는 대략 몇 바이트?', ['1024', '100', '10000'], 0],
  ['Node.js 패키지 목록 파일 이름은?', ['package.json', 'node.txt', 'modules.ini'], 0], ['한 시간은 몇 초?', ['3600', '600', '6000'], 0],
  ['무지개 색 개수는?', ['7', '5', '9'], 0], ['HTML에서 제목 태그로 가장 큰 것은?', ['h1', 'h6', 'title-big'], 0],
  ['정규식에서 숫자 한 글자를 뜻하는 것은?', ['\\d', '\\w', '\\s'], 0], ['커피 원두가 자라는 식물은?', ['커피나무', '참나무', '대나무'], 0],
];
const RIDDLES = [
  ['아침에는 네 발, 점심에는 두 발, 저녁에는 세 발인 것은?', ['사람', '의자', '고양이'], 0], ['많이 쓸수록 짧아지는 것은?', ['연필', '책', '줄자'], 0],
  ['들어갈 때는 하나, 나올 때는 둘인 것은?', ['바지', '모자', '장갑'], 0], ['물에 넣어도 안 젖는 것은?', ['그림자', '수건', '종이'], 0],
  ['보면 볼수록 줄어드는 것은?', ['남은 시간', '책장', '하늘'], 0], ['컴퓨터가 제일 싫어하는 술은?', ['버그주', '맥주', '소주'], 0],
  ['머리는 있는데 생각은 못 하는 것은?', ['못', '모자', '베개'], 0], ['세상에서 가장 빠른 닭은?', ['후다닥', '치킨', '병아리'], 0],
];
// Word chain dictionary (2–3 syllable common nouns).
const WORDS = ['사과', '과자', '자두', '두부', '부채', '채소', '소금', '금붕어', '어부', '부엌', '기차', '차표', '표정', '정원', '원숭이', '이불', '불꽃', '꽃병', '병원', '원두',
  '두유', '유리', '리본', '본드', '드럼', '럼주', '주스', '스키', '키보드', '드라마', '마우스', '스위치', '치즈', '즈음', '음악', '악기', '기린', '린스', '스시', '시계',
  '계단', '단추', '추석', '석양', '양말', '말차', '차고', '고래', '래퍼', '퍼즐', '즐거움', '움직임', '임무', '무지개', '개미', '미소', '소파', '파도', '도토리', '리모컨',
  '컨설팅', '팅커벨', '벨소리', '리듬', '듬뿍', '뿍뿍이', '이사', '사진', '진주', '주전자', '자전거', '거울', '울타리', '리더', '더위', '위로', '로봇', '봇물', '물감', '감자'];
const first = (w) => [...w][0], last = (w) => [...w].at(-1);
const HANGUL = /^[가-힣]{2,6}$/;
const pick = (list, rand) => list[Math.floor(rand() * list.length)];
const OPEN = {
  balance: ['심심한데 밸런스 게임 ㄱ?', '밸런스 게임 하나 던짐', '갑자기 궁금해짐. 골라 봐'],
  quiz: ['퀴즈 하나 낸다ㅋㅋ', '심심하니까 퀴즈 타임', '이거 맞히는 사람?'],
  riddle: ['수수께끼 하나 낼게', '오늘의 수수께끼', '이거 알아?ㅋㅋ'],
  chain: ['끝말잇기 할 사람? 내가 먼저', '끝말잇기 ㄱ', '심심하니까 끝말잇기'],
};
const PICK_LINE = ['난 {c}. 이건 고민 안 됨', '{c}지 당연히', '음… 그래도 {c}', '{c}! 반박 안 받음ㅋㅋ', '어렵다. 그래도 {c}', '나는 {c} 쪽'];
const ANSWER_LINE = ['{c}?', '내 생각엔 {c}', '{c} 아님?', '찍는다. {c}', '이건 {c}지'];

export function startGame({ kinds = GAME_KINDS, players, rand = Math.random, now, recent = [] }) {
  const options = kinds.filter((k) => k !== recent.at(-1));
  const kind = pick(options.length ? options : kinds, rand);
  const host = players[0];
  const state = kind === 'balance' ? { choices: pick(BALANCE, rand), picks: {} }
    : kind === 'chain' ? { words: [pick(WORDS.filter((w) => WORDS.some((x) => first(x) === last(w))), rand)], out: [] }
    : (() => {
      // The pools list the right answer first; the options are shuffled so its place gives nothing away.
      const [q, options, answer] = pick(kind === 'quiz' ? QUIZ : RIDDLES, rand);
      const order = options.map((_, i) => i).sort(() => rand() - 0.5);
      return { q, choices: order.map((i) => options[i]), answer: order.indexOf(answer), picks: {} };
    })();
  return { id: `g${now}`, kind, host, players, turn: 0, scores: {}, startedAt: now, updatedAt: now, nextAt: now + STEP_MS, state, joined: false, userAnswer: null, waitingSince: 0, done: false };
}
// What the owner can do right now: nothing, join, or answer (choices or a word).
export function userPrompt(game) {
  if (!game || game.done) return null;
  if (!game.joined) return { join: true };
  if (game.kind === 'chain') return game.turnOf === 'user' ? { word: last(game.state.words.at(-1)) } : null;
  return game.userAnswer === null && game.turn > 0 ? { choices: game.state.choices } : null;
}
export function joinGame(game) {
  if (!game || game.done) throw new Error('진행 중인 게임이 없어요.');
  if (!game.joined) { game.joined = true; game.players = [...game.players, 'user']; }
}
export function answerGame(game, value) {
  const ask = userPrompt(game);
  if (!ask || ask.join) throw new Error('지금은 답할 차례가 아니에요.');
  if (ask.word !== undefined) {
    const word = String(value || '').trim();
    if (!HANGUL.test(word) || first(word) !== ask.word || game.state.words.includes(word)) throw new Error(`"${ask.word}"(으)로 시작하는 새 낱말(한글 2~6자)을 적어 주세요.`);
    game.userAnswer = word;
  } else {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= ask.choices.length) throw new Error('보기를 골라 주세요.');
    game.userAnswer = index;
  }
}
// One move. Returns { lines: [{ from, text, ask? }], result? } — result is set when the game ends:
// { text, winners, agree?: [a, b] } for the activity log and a tiny relation change.
export function stepGame(game, { names = {}, rand = Math.random, now }) {
  const name = (x) => (x === 'user' ? names.user || '방장' : names[x] || x);
  const s = game.state, ais = game.players.filter((x) => x !== 'user');
  const lines = [];
  game.updatedAt = now; game.nextAt = now + STEP_MS;
  if (game.turn === 0) {
    const opening = pick(OPEN[game.kind], rand);
    const body = game.kind === 'balance' ? `${s.choices[0]} vs ${s.choices[1]}`
      : game.kind === 'chain' ? `${s.words[0]}!` : `${s.q}\n${s.choices.map((c, i) => `${'①②③'[i]} ${c}`).join(' · ')}`;
    lines.push({ from: game.host, text: `${opening}\n${body}`, ask: true });
    game.turn = 1; game.turnOf = ais[1 % ais.length];
    return { lines };
  }
  // The owner's answer is waited for (briefly) only once they joined; the game never stops for it.
  const waitUser = () => {
    if (!game.joined || game.userAnswer !== null) return false;
    game.waitingSince ||= now;
    if (now - game.waitingSince < USER_WAIT_MS) return true;
    lines.push({ from: game.host, text: `${name('user')} 답이 없어서 일단 진행할게ㅋㅋ` }); game.userAnswer = -1;
    return false;
  };
  if (game.kind === 'chain') {
    const order = game.players.filter((x) => !s.out.includes(x));
    if (game.turnOf === 'user') {
      if (waitUser()) return { lines };
      if (typeof game.userAnswer === 'string') { s.words.push(game.userAnswer); lines.push({ from: 'user', text: game.userAnswer, ownerMove: true }); }
      else s.out.push('user');
      game.userAnswer = null; game.waitingSince = 0;
    } else {
      const need = last(s.words.at(-1));
      const options = WORDS.filter((w) => first(w) === need && !s.words.includes(w));
      // A small chance to "blank" keeps games short and lets anyone win.
      if (!options.length || (s.words.length > 3 && rand() < 0.2)) { s.out.push(game.turnOf); lines.push({ from: game.turnOf, text: `${need}… 생각 안 남. 졌다ㅋㅋ` }); }
      else { const w = pick(options, rand); s.words.push(w); lines.push({ from: game.turnOf, text: w }); }
    }
    const alive = game.players.filter((x) => !s.out.includes(x));
    if (alive.length <= 1 || s.words.length >= 8) {
      game.done = true;
      const winners = alive; // the last one standing, or everyone still in after eight words
      const text = `끝말잇기 끝! ${winners.map(name).join(', ')} 승 (${s.words.length}단어)`;
      lines.push({ from: game.host, text });
      game.scores = Object.fromEntries(winners.map((w) => [w, 1]));
      return { lines, result: { text, winners } };
    }
    const next = order[(order.indexOf(game.turnOf) + 1) % order.length];
    game.turnOf = alive.includes(next) ? next : alive.find((x) => x !== game.turnOf);
    game.turn++;
    return { lines };
  }
  // balance / quiz / riddle: each AI other than the host answers once, then the host wraps up.
  const pending = ais.filter((x) => x !== game.host && s.picks[x] === undefined);
  if (pending.length) {
    const who = pending[0];
    const choice = game.kind === 'balance' ? (rand() < 0.5 ? 0 : 1) : rand() < 0.65 ? s.answer : pick([0, 1, 2].filter((i) => i !== s.answer), rand);
    s.picks[who] = choice;
    lines.push({ from: who, text: pick(game.kind === 'balance' ? PICK_LINE : ANSWER_LINE, rand).replace('{c}', s.choices[choice]) });
    game.turn++;
    return { lines };
  }
  if (waitUser()) return { lines };
  if (game.joined && game.userAnswer >= 0) s.picks.user = game.userAnswer;
  game.done = true;
  if (game.kind === 'balance') {
    s.picks[game.host] ??= rand() < 0.5 ? 0 : 1;
    const votes = [0, 1].map((i) => Object.values(s.picks).filter((p) => p === i).length);
    const side = votes[0] === votes[1] ? null : votes[0] > votes[1] ? 0 : 1;
    const agree = ais.filter((x) => s.picks[x] === s.picks[game.host] && x !== game.host)[0];
    const text = `결과: ${s.choices[0]} ${votes[0]}표 vs ${s.choices[1]} ${votes[1]}표${side === null ? ' · 무승부ㅋㅋ' : ` · ${s.choices[side]} 승`}`;
    lines.push({ from: game.host, text: `나는 ${s.choices[s.picks[game.host]]}. ${text}` });
    return { lines, result: { text: `밸런스 게임 ${text}`, winners: [], agree: agree ? [game.host, agree] : null } };
  }
  const winners = Object.entries(s.picks).filter(([, p]) => p === s.answer).map(([who]) => who);
  winners.forEach((w) => { game.scores[w] = 1; });
  const text = `정답은 ${s.choices[s.answer]}! ${winners.length ? `${winners.map(name).join(', ')} 정답` : '아무도 못 맞힘ㅋㅋ'}`;
  lines.push({ from: game.host, text });
  return { lines, result: { text: `${game.kind === 'quiz' ? '퀴즈' : '수수께끼'} · ${text}`, winners } };
}
