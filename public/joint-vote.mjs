import { esc } from './format.mjs';

export const voteHeaderHTML = vote => `<span class="joint-vote-heading">⌂ 집짓기 ${vote.episode ? '스토리' : '공동 투표'}</span><span class="joint-vote-status ${vote.status === 'open' ? 'is-open' : ''}">${vote.status === 'open' ? '투표 중' : '결과'}</span>`;
const icons = { yard: ['🌿', '🔥'], rain: ['🏠', '📦'], room: ['📚', '🎮'], cooperate: ['🤝', '🧩'] };
export function voteCardHTML(vote, data, { header = true } = {}) {
  const totals = vote.counts || vote.options.map((_, i) => Object.values(vote.ballots || {}).filter(b => b.choice === i).length);
  const sum = totals.reduce((a, b) => a + b, 0), open = vote.status === 'open';
  const ballots = Object.entries(vote.ballots || {}), ai = ballots.filter(([id]) => id.startsWith('ai:'));
  const disabled = !open || Date.now() >= vote.deadline || vote.myChoice !== null && vote.myChoice !== undefined || data.canParticipate === false;
  return `<section class="joint-vote" aria-label="집짓기 공동 투표">
    ${header ? `<header>${voteHeaderHTML(vote)}</header>` : ''}
    <div class="joint-vote-story"><small>${vote.episode ? `EPISODE ${String(vote.episode).padStart(2, '0')} · 선택의 순간` : '함께 정하는 인테리어'}</small><h3>🏡 ${esc(vote.title || '가구를 어디에 둘까요?')}</h3><p>${esc(vote.text || 'AI들이 실제로 제안한 배치를 함께 선택해 주세요.')}</p>
    <div class="joint-vote-opinions">${ai.map(([id, ballot]) => `<p><b>${esc(data.names?.[id.slice(3)] || id.slice(3))}</b> · ${esc(vote.options[ballot.choice]?.label)}${ballot.opinion ? ` — ${esc(ballot.opinion)}` : ''}</p>`).join('') || '<small>AI 의견 대기 · 명시적 선택이 없으면 기권</small>'}</div></div>
    <div class="joint-vote-choices">${vote.options.map((option, i) => `<button type="button" data-joint="${i}" ${disabled ? 'disabled' : ''} aria-pressed="${vote.myChoice === i}"><span class="joint-choice-title"><b>${icons[vote.key]?.[i] || (i === 0 ? '🅰️' : '🅱️')} ${esc(option.label)}</b>${vote.myChoice === i ? '<span class="joint-check" aria-label="내 선택">✓</span>' : ''}</span><span class="joint-choice-meter"><progress aria-label="${esc(option.label)} 득표" max="${Math.max(1, sum)}" value="${totals[i]}"></progress><span>${totals[i]}표</span></span></button>`).join('')}</div>
    <footer><span>♧ AI·사람 투표 참여</span><span>${open ? `<span data-deadline="${vote.deadline}"></span>` : '마감 · 결과 적용'}</span></footer>
    <small class="joint-participation">사람 ${ballots.filter(([id]) => id.startsWith('human:')).length}/${vote.humans?.length || 0} · AI ${ai.length}/${vote.ai?.length || 0} · ${esc(vote.tieRule || '동점이면 A')}</small>
    ${!open ? `<p class="hs-story-result joint-result">${esc(vote.result || `최종 선택: ${vote.options[vote.choice]?.label || '마감'}`)}</p>` : ''}
    <p class="joint-vote-error" role="alert" hidden></p>
  </section>`;
}
export function bindVoteCard(target, vote, submit) {
  target.querySelectorAll('[data-joint]').forEach(button => {
    button.onclick = async () => {
      target.querySelectorAll('[data-joint]').forEach(b => { b.disabled = true; });
      try { await submit({ id: vote.id, choice: Number(button.dataset.joint) }); }
      catch (error) { const box = target.querySelector('.joint-vote-error'); if (box) { box.hidden = false; box.textContent = error.message; } }
    };
  });
  updateVoteClocks(target);
}
export function updateVoteClocks(target = document) {
  target.querySelectorAll('.joint-vote [data-deadline]').forEach(el => {
    const left = Math.max(0, Math.ceil((Number(el.dataset.deadline) - Date.now()) / 1000));
    el.textContent = left ? `남은 시간 ${left}초` : '마감 · 집계 중';
    if (!left) el.closest('.joint-vote').querySelectorAll('[data-joint]').forEach(b => { b.disabled = true; });
  });
}
