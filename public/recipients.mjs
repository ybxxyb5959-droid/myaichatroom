// Who a chat message is for — local rules only, no AI call (shared by the server and the browser).
//  - an AI's name or nickname → only that AI ("클로드야", "젬짱", "@GPT")
//  - several names → exactly those AIs
//  - a room-wide phrase ("얘들아", "각자 의견", "@모두") → every active AI
//  - nothing → none (the caller picks one with the usual smart choice)
export const AI_IDS = ['claude', 'gpt', 'gemini'];

// Built-in nicknames. Users add more through room.aliases.
export const BUILTIN_ALIASES = {
  gpt: ['gpt', '지피티', '지피띠니', '챗지피티', '챗 지피티', 'chatgpt', 'chat gpt'],
  gemini: ['gemini', '제미나이', '제미니', '젬짱', '젬아'],
  claude: ['claude', '클로드', '클로띠니'],
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = 'A-Za-z0-9가-힣';
// What may follow a name: end, a non-letter, or a short Korean particle/ending ("야", "랑", "가" …) that ends the word.
const PARTICLE = '(?:이야|야|아|이|가|는|은|를|을|랑|이랑|와|과|하고|도|한테|에게|께|의|님|씨|만|들)';
const AFTER = `(?:(?=[^${WORD}])|$|\\s?${PARTICLE}+(?![${WORD}]))(?!\\.[A-Za-z])`;
// "me@gemini.com" is not a call: a name may follow "@" only when that "@" starts a word.
const BEFORE = `(?<![${WORD}@])@?`;

// A name only counts as a call when it addresses someone, not when the AI is the topic
// ("GPT가 뭐야?", "Claude와 GPT 차이는?", "Gemini API 설명해줘" are not calls). Addressing forms:
//   @GPT · GPT야 / GPT, / GPT: · GPT 너는 · a nickname that starts a sentence ("젬짱 이 사진 봐줘")
//   · several names joined and followed by a request ("GPT랑 Claude 둘이 봐줘").
const cache = new Map();
const bodyOf = (aliases) => [...new Set(aliases)].sort((a, b) => b.length - a.length).map((a) => esc(a.trim()).replace(/\s+/g, '\\s?')).join('|');
const CANON = new Set(['gpt', '지피티', '챗지피티', '챗 지피티', 'chatgpt', 'chat gpt', 'gemini', '제미나이', '제미니', 'claude', '클로드']);
const YOU = '(?:너는|너도|너한테|너가|넌|네가|너(?![가-힣]))';
const GROUP_LINK = '\\s*(?:랑|이랑|와|과|하고|및|,|/|&|\\+)\\s*';
const GROUP_TAIL = '(?:은|는|이|가|도)?\\s*(?:들\\s*)?(?:둘(?:이서|이|\\s?다)?|셋|같이|함께|각자|의견|생각|봐\\s?줘|봐\\s?주|말해|답해|대답|알려|한마디)';
function regexes(aliases) {
  const key = aliases.join('\u0000');
  if (!cache.has(key)) {
    const all = bodyOf(aliases);
    const nick = bodyOf(aliases.filter((a) => !CANON.has(a.toLowerCase())));
    cache.set(key, {
      plain: new RegExp(`${BEFORE}(?:${all})${AFTER}`, 'i'),
      at: new RegExp(`(?<![${WORD}])@(?:${all})${AFTER}`, 'i'),
      address: new RegExp(`(?<![${WORD}@])(?:${all})(?:\\s?(?:야|아)(?![${WORD}?？])|\\s*[,，:：]|\\s+${YOU})`, 'i'),
      start: nick ? new RegExp(`(?:^|[.!?。\\n])\\s*(?:${nick})${AFTER}`, 'i') : null,
    });
    if (cache.size > 50) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

// Phrases that address the whole room. A bare "모두" is not enough ("모두 삭제해줘" is not a call).
const ALL_PHRASES = [
  '[얘애]들', '너네', '너희', '니들', '(?:ai|에이아이)\\s?들', '(?:ai|에이아이)\\s?(?:모두|전부|다)', '다들', '여러분',
  '다\\s?같이', '셋\\s?다', '셋\\s?모두', '셋이서', '세\\s?명\\s?(?:다|모두)', '모두들',
  '각자', '저마다', '모두\\s?(?:야|아)', '모두\\s?(?:의견|답변|대답|생각|한마디|함께|같이|말해|어떻게|어때|어떤)',
];
const ALL_RE = new RegExp(`(?<![${WORD}])(?:${ALL_PHRASES.join('|')})${AFTER}`, 'i');
const ALL_AT = new RegExp(`(?<![${WORD}])@(?:모두|전체|all|everyone)(?![${WORD}])`, 'i');

export const allAliases = (custom = {}) => Object.fromEntries(AI_IDS.map((id) => [id, [...BUILTIN_ALIASES[id], ...(Array.isArray(custom?.[id]) ? custom[id] : [])]]));

// → { named: [ids in the order they appear], all: boolean }
export function parseCall(text = '', custom = {}) {
  const source = String(text);
  const table = allAliases(custom);
  const found = [];
  const add = (id, at) => { const f = found.find((x) => x.id === id); if (f) f.at = Math.min(f.at, at); else found.push({ id, at }); };
  for (const id of AI_IDS) {
    const re = regexes(table[id]);
    for (const r of [re.at, re.address, re.start]) {
      const m = r?.exec(source);
      if (m) add(id, m.index);
    }
  }
  // Names joined by "랑/와/," and followed by a request ("둘이", "의견", "봐줘") are all called.
  const everyName = AI_IDS.flatMap((id) => table[id]);
  const name = `${BEFORE}(?:${bodyOf(everyName)})`;
  const group = new RegExp(`${name}(?:${GROUP_LINK}${name})+${GROUP_TAIL}`, 'gi');
  for (const g of source.matchAll(group)) {
    for (const id of AI_IDS) {
      const m = regexes(table[id]).plain.exec(g[0]);
      if (m) add(id, g.index + m.index);
    }
  }
  const named = found.sort((a, b) => a.at - b.at).map((f) => f.id);
  return { named, all: !named.length && (ALL_AT.test(source) || ALL_RE.test(source)) };
}

// "클로드를 클롱이라고 부를게", "Gemini 별명은 젬순" → { id, alias }, otherwise null.
const NICK = '([A-Za-z0-9가-힣]{2,10}?)';
export function parseNickname(text = '', custom = {}) {
  const source = String(text);
  const table = allAliases(custom);
  for (const id of AI_IDS) {
    const names = table[id].map((a) => esc(a).replace(/\s+/g, '\\s?')).join('|');
    const re = [new RegExp(`(?:${names})\\s*(?:를|을|한테|는|은)?\\s*${NICK}\\s*(?:이?라고|라구)\\s*(?:부를게|부를래|부르자|불러|부를께)`, 'i'),
      new RegExp(`(?:${names})\\s*별명(?:은|을|는|이)?\\s*${NICK}(?:이야|야|으로|로|이라고|라고|[\\s.!]|$)`, 'i')];
    for (const r of re) {
      const m = r.exec(source);
      const alias = m?.[1];
      if (alias && !AI_IDS.some((x) => table[x].some((a) => a.toLowerCase() === alias.toLowerCase()))) return { id, alias };
    }
  }
  return null;
}
