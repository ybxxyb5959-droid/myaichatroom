// Helpful results built from the shared activity log by rules only (no AI call):
//  - todayDigest: "오늘 AI들 뭐 했어?" — a short list of what happened
//  - buildNote:   an occasional memo (what was done, topics, house news, three suggested next steps,
//                 commit message drafts) when enough meaningful activity piled up. It is a draft in the
//                 room's workspace; project files are never touched.
const HOUR = 3600000;
export const NOTE_GAP = 8 * HOUR;     // at least this long between two memos
export const NOTE_SCORE = 6;          // how much meaningful activity a memo needs
// 24-hour HH:MM, built by hand so the list reads the same whatever locale data Node ships with.
const time = (at) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const topicOf = (text) => /"([^"]+)"/.exec(text)?.[1] || null;

// Asked "오늘 뭐 했어?" / "나 없는 동안 뭐 했어?": answered from the log, newest last, without any AI call.
export const TODAY_QUESTION = /(오늘|아까|요즘|하루|나\s*없는\s*동안|없는\s*동안|자리\s*비운\s*동안|그동안)[^?!.\n]{0,15}(뭐\s*했|뭐\s*하고\s*있었|뭐하고\s*놀|무슨\s*일\s*있었|뭐\s*하고\s*지냈)/;
export function todayDigest(entries, { since, label = '오늘' }) {
  const list = entries.filter((e) => e.at >= since && e.kind !== 'system').reverse();
  if (!list.length) return `${label} AI들은 아직 기록된 활동이 없어요.`;
  const shown = list.slice(-12);
  return [`📋 ${label} AI들은:`, ...shown.map((e) => `- ${time(e.at)} ${e.text}`),
    ...(list.length > shown.length ? [`- …그 밖에 ${list.length - shown.length}건`] : []), '', '*앱의 활동 기록으로 만든 목록이에요 (AI 호출 없음).*'].join('\n');
}

// Whether today's activity is worth a memo, and what goes in it.
export function noteScore(entries) {
  let score = 0;
  for (const e of entries) {
    if (e.kind === 'task') score += / 작업 완료$/.test(e.text) ? 3 : 2;
    else if (e.kind === 'chat') score += 1;
    else if (e.kind === 'game') score += 1;
    else if (e.kind === 'house' && /의견|화해|중재|완성/.test(e.text)) score += 1;
  }
  return score;
}
export function buildNote(entries, { now }) {
  if (noteScore(entries) < NOTE_SCORE) return null;
  const tasks = entries.filter((e) => e.kind === 'task');
  const done = tasks.filter((e) => / 작업 완료$/.test(e.text));
  const stopped = tasks.filter((e) => / 작업 (중단|실패)$/.test(e.text));
  const reverted = tasks.filter((e) => /되돌림/.test(e.text));
  const topics = [...new Set(entries.filter((e) => e.kind === 'chat').map((e) => topicOf(e.text)).filter(Boolean))].slice(0, 5);
  const house = entries.filter((e) => e.kind === 'house' && /의견|화해|중재|완성/.test(e.text)).slice(0, 3);
  const games = entries.filter((e) => e.kind === 'game').slice(0, 2);
  const todo = [
    ...stopped.map((e) => `중단된 ${topicOf(e.text) ? `"${topicOf(e.text)}"` : '작업'} 다시 확인하기`),
    ...reverted.map(() => '되돌린 변경이 왜 필요했는지 확인하기'),
    ...done.slice(0, 2).map((e) => `${topicOf(e.text) ? `"${topicOf(e.text)}"` : '완료한 작업'} 결과를 직접 실행해 보기`),
    ...topics.map((t) => `"${t}" 이야기 이어서 정리하기`),
  ].slice(0, 3);
  const day = new Date(now).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
  const section = (title, lines) => (lines.length ? [`## ${title}`, ...lines, ''] : []);
  const markdown = [`# ${day} 정리 (초안)`, '',
    ...section('한 작업', tasks.slice(0, 5).map((e) => `- ${e.text}`)),
    ...section('이야기 나온 것', topics.map((t) => `- ${t}`)),
    ...section('집 소식', house.map((e) => `- ${e.text}`)),
    ...section('놀이', games.map((e) => `- ${e.text}`)),
    ...section('다음에 해볼 것 (제안)', todo.map((t, i) => `${i + 1}. ${t}`)),
    ...section('커밋 메시지 후보 (초안)', done.slice(0, 3).map((e) => `- \`feat: ${topicOf(e.text) || '작업 반영'}\``)),
    '*앱의 활동 기록으로 만든 메모예요. 프로젝트 파일은 바꾸지 않았어요.*'].join('\n');
  const short = todo.length ? `다음에 해볼 것:\n${todo.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : '';
  return { title: `${day} 정리`, markdown, short };
}
