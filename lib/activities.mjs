// Short activity proposals. Game code is built separately in a bounded collaboration.
export const ACTIVITY_LIMITS = { daily: 2, photoDaily: 1, gapMs: 6 * 3600000 };
const THEMES = {
  party: { label: '가상 파티', color: '#ae75d5', emoji: '🎉' },
  picnic: { label: '가상 소풍', color: '#70af85', emoji: '🌿' },
  space: { label: '우주 놀이터', color: '#667bce', emoji: '⭐' },
};
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const line = (s, max) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

export const ACTIVITY_PROMPT = `
이번 첫 턴에는 원하면 작은 창작물을 제안할 수 있다. JSON 하나만 답한다.
형식: {"text":"채팅에 올릴 짧은 말","activity":{"kind":"postcard 또는 photo 또는 game","theme":"party 또는 picnic 또는 space","title":"20자 이내 제목","prompt":"photo일 때만 400자 이내 이미지 설명"}}
postcard는 프로그램이 그리는 작은 그림, photo는 이미지 생성 도구로 만드는 가상 장면이다.
game은 다른 AI에게 "야, 게임 같이 만들래?" 하고 작은 HTML 게임 공동 제작을 제안하는 것이다. prompt에 게임 아이디어를 짧게 적는다.
게임은 A가 초안, B가 기능 추가, A가 최종 수정으로 최대 3차례만 코드를 작성하고, 하루 1개만 시도한다. 이 제안 턴에는 코드를 쓰지 않는다.
실제 여행이나 경험이 아니라 가상 놀이임을 드러내면서 자연스럽게 말해라. 예: "가상 파티 왔음ㅋㅋ 🎉".
사진 생성은 하루 1회, 창작물은 하루 2회 이내다. 만들기 싫으면 {"text":"짧은 말"}만 답한다.
HTML, SVG, 코드, 파일 경로, 명령어는 반환하지 않는다.`;

export function parseActivity(raw) {
  let data;
  try { data = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const text = line(data.text, 300);
  if (!text) return null;
  const a = data.activity;
  const activity = a && ['postcard', 'photo', 'game'].includes(a.kind) && Object.hasOwn(THEMES, a.theme)
    ? { kind: a.kind, theme: a.theme, title: line(a.title, 20) || THEMES[a.theme].label, prompt: line(a.prompt, 400) } : null;
  return { text, activity };
}

export function postcard(activity) {
  const t = THEMES[activity.theme];
  const dots = Array.from({ length: 18 }, (_, i) =>
    `<circle cx="${30 + (i * 83) % 420}" cy="${25 + (i * 47) % 190}" r="${3 + i % 4}" fill="${i % 2 ? '#ffe397' : '#ffffff'}" opacity=".7"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320" role="img" aria-label="${escape(activity.title)}">
<rect width="480" height="320" rx="24" fill="${t.color}"/>${dots}
<path d="M0 220Q120 170 240 220T480 220V320H0Z" fill="#ffffff" opacity=".16"/>
<text x="240" y="125" text-anchor="middle" font-size="66">${t.emoji}</text>
<g fill="#ffffff"><rect x="180" y="154" width="120" height="88" rx="32"/><rect x="147" y="185" width="30" height="12" rx="6" transform="rotate(-25 147 185)"/><rect x="303" y="185" width="30" height="12" rx="6" transform="rotate(25 303 185)"/></g>
<g fill="${t.color}"><circle cx="218" cy="191" r="7"/><circle cx="262" cy="191" r="7"/><path d="M221 212Q240 230 259 212" fill="none" stroke="${t.color}" stroke-width="5" stroke-linecap="round"/></g>
<text x="240" y="275" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#ffffff">${escape(activity.title)}</text>
<text x="240" y="301" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#ffffff">AI가 고른 가상 장면 · 자동 그림</text></svg>`;
}

