// "💬 자동" chat: one main answerer, chosen by rules only (no AI call is spent on choosing).
// Nothing here ranks the models' ability. It looks at what the room already knows:
//  - members that are on and connected (candidates)
//  - remaining usage from the CLI reports: nearly-out members are avoided when another can answer;
//    an unknown share is neutral (counted as the middle)
//  - the current conversation partner (an AI the user called a moment ago) comes first
//  - lightweight requests continue with whoever answered the user last, then the user's chosen AI
//  - heavier requests (code, file work, calculation, multi-step reasoning — router.heavyReason) go to
//    the member with the most usage left, because long answers use more of it
import { heavyReason } from './router.mjs';

const NEUTRAL = 50;
export function pickPrimary({ candidates, text = '', selected = null, recent = [], quota = {}, partner = null }) {
  if (!candidates.length) return null;
  const usable = candidates.filter((id) => !quota[id]?.low);
  const pool = usable.length ? usable : candidates;
  // The AI the user was just talking to keeps the conversation (unless it is nearly out of usage).
  if (partner && pool.includes(partner)) return { id: partner, reason: '대화를 이어서' };
  const heavy = heavyReason(String(text));
  if (!heavy) {
    const last = recent.find((id) => pool.includes(id));
    if (last) return { id: last, reason: '최근 대화를 이어서' };
    if (pool.includes(selected)) return { id: selected, reason: '기본으로 고른 AI' };
  }
  const score = (id) => (quota[id]?.known ? quota[id].pct : NEUTRAL);
  const order = (id) => (id === selected ? -1 : candidates.indexOf(id));
  const best = [...pool].sort((a, b) => score(b) - score(a) || order(a) - order(b))[0];
  return { id: best, reason: heavy ? `${heavy} · 사용량 여유` : '사용량 여유' };
}
