// Chat cards for polls, the balance game, the quiz battle and bookmarks.
// The server owns every tally and answer; these cards only render its view and send one action.
import { esc } from './format.mjs';

const left = (deadline) => {
  const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  return s >= 60 ? `남은 ${Math.ceil(s / 60)}분` : `남은 ${s}초`;
};
export function updatePlayClocks(root = document) {
  root.querySelectorAll('[data-play-deadline]').forEach((el) => {
    const deadline = Number(el.dataset.playDeadline);
    el.textContent = Date.now() >= deadline ? '마감 · 집계 중' : left(deadline);
  });
}
const bar = (count, total) => `<span class="play-bar"><i style="width:${total ? Math.round(count / total * 100) : 0}%"></i></span>`;

// ctx: { play, person, owner, nameOf(personId), canStart }
function pollHTML(poll, ctx) {
  const total = poll.counts.reduce((a, b) => a + b, 0), open = poll.status === 'open';
  const voted = poll.mine !== null;
  return `<header><b>📊 투표</b><span class="play-status">${open ? poll.deadline ? `<span data-play-deadline="${poll.deadline}">${left(poll.deadline)}</span>` : '진행 중' : '마감'}</span></header>
    <h4>${esc(poll.question)}</h4>
    <div class="play-options">${poll.options.map((option, i) => `<button type="button" class="play-option ${poll.mine === i ? 'mine' : ''} ${poll.result?.winners.includes(i) ? 'win' : ''}" data-poll-vote="${i}" ${!open || voted ? 'disabled' : ''} aria-pressed="${poll.mine === i}">
      <span class="play-option-top"><b>${esc(option)}</b><span>${poll.counts[i]}표${poll.mine === i ? ' · 내 선택' : ''}</span></span>${bar(poll.counts[i], total)}
      ${poll.voters[i].length ? `<small>${poll.voters[i].map((v) => esc(ctx.nameOf(v))).join(', ')}</small>` : ''}</button>`).join('')}</div>
    <footer><span>총 ${total}표 · 1인 1표 · ${esc(ctx.nameOf(poll.by))}님이 만듦</span>
      <span class="play-actions">${open ? `<button type="button" class="link-btn" data-poll-ask>AI 의견 묻기</button>` : ''}${open && (ctx.owner || poll.by === ctx.person) ? '<button type="button" class="link-btn" data-poll-close>마감하기</button>' : ''}</span></footer>`;
}
function balanceHTML(game, ctx) {
  if (game.status === 'preparing') return `<header><b>⚖️ 밸런스게임</b><span class="play-status">준비 중</span></header><p class="play-wait">AI가 질문을 만드는 중이에요…</p>${ctx.owner ? '<footer><span></span><button type="button" class="link-btn" data-game-end>게임 종료</button></footer>' : ''}`;
  const total = game.counts[0] + game.counts[1], open = game.status === 'open';
  return `<header><b>⚖️ 밸런스게임</b><span class="play-status">${open ? `<span data-play-deadline="${game.deadline}">${left(game.deadline)}</span>` : '결과'}</span></header>
    <h4>${esc(game.question)}</h4>
    <div class="play-options two">${game.options.map((option, i) => `<button type="button" class="play-option big ${game.mine === i ? 'mine' : ''} ${game.result?.winner === i ? 'win' : ''}" data-game-choose="${i}" ${!open || game.mine !== null ? 'disabled' : ''} aria-pressed="${game.mine === i}">
      <b>${i ? '🅱️' : '🅰️'} ${esc(option)}</b><span>${game.counts[i]}명</span>${bar(game.counts[i], total)}</button>`).join('')}</div>
    <footer><span>${open ? `${game.chosen.length}명 선택 완료${game.mine !== null ? ' · 내 선택 완료' : ''}` : game.endReason === 'done' ? (game.result.winner === null ? '동점!' : `"${esc(game.options[game.result.winner])}" 승!`) : '종료됨'}${game.author ? ` · 출제 ${esc(ctx.nameOf(game.author))}` : ''}</span>
      ${open && ctx.owner ? '<button type="button" class="link-btn" data-game-end>게임 종료</button>' : ''}</footer>`;
}
function quizHTML(game, ctx) {
  const head = `<header><b>🧠 퀴즈 배틀</b><span class="play-status">${game.status === 'open' ? `문제 ${game.index + 1}/${game.total} · <span data-play-deadline="${game.deadline}">${left(game.deadline)}</span>` : game.status === 'preparing' ? '준비 중' : '결과'}</span></header>`;
  if (game.status === 'preparing') return `${head}<p class="play-wait">AI가 5문제를 준비하는 중이에요…</p>${ctx.owner ? '<footer><span></span><button type="button" class="link-btn" data-game-end>게임 종료</button></footer>' : ''}`;
  const last = game.review.at(-1);
  const lastLine = last && game.status === 'open' ? `<p class="play-review">지난 문제 정답: <b>${esc(last.choices[last.answer])}</b>${last.mine ? last.mine.correct ? ` · 정답! +${last.mine.points}점` : ' · 아쉬워요' : ' · 미응답'}</p>` : '';
  const board = game.scores.length ? `<ol class="play-board">${game.scores.slice(0, 5).map((s) => `<li class="${s.id === ctx.person ? 'me' : ''}">${esc(ctx.nameOf(s.id))} <b>${s.score}점</b></li>`).join('')}</ol>` : '';
  if (game.status !== 'open') {
    const mine = game.review.filter((r) => r.mine?.correct).length;
    return `${head}${game.endReason === 'done' ? board || '<p class="play-wait">참여자가 없었어요.</p>' : '<p class="play-wait">게임을 종료했어요.</p>'}
      <details class="play-details"><summary>정답 보기 · 내 정답 ${mine}/${game.review.length}</summary><ol>${game.review.map((r) => `<li>${esc(r.q)} → <b>${esc(r.choices[r.answer])}</b>${r.mine ? r.mine.correct ? ' ✓' : ' ✗' : ''}</li>`).join('')}</ol></details>
      ${game.author ? `<footer><span>출제 ${esc(ctx.nameOf(game.author))}${game.aiQuestions < game.total ? ' · 일부 기본 문제' : ''}</span></footer>` : '<footer><span>기본 문제로 진행</span></footer>'}`;
  }
  return `${head}${lastLine}<h4>${esc(game.question.q)}</h4>
    <div class="play-options">${game.question.choices.map((choice, i) => `<button type="button" class="play-option ${game.myAnswer?.choice === i ? 'mine' : ''}" data-quiz-answer="${i}" ${game.myAnswer ? 'disabled' : ''} aria-pressed="${game.myAnswer?.choice === i}"><b>${'①②③④'[i]} ${esc(choice)}</b></button>`).join('')}</div>
    <footer><span>${game.myAnswer ? '제출 완료 · 정답은 문제가 끝나면 공개' : '빨리 맞힐수록 점수가 높아요'} · ${game.answered.length}명 응답</span>${ctx.owner ? '<button type="button" class="link-btn" data-game-end>게임 종료</button>' : ''}</footer>${board}`;
}
export function playCardNode(message, ctx, act) {
  const node = document.createElement('div');
  node.dataset.id = message.id; node.className = 'sys k-play';
  const poll = ctx.play?.polls.find((p) => p.id === message.playId);
  const game = ctx.play?.games.find((g) => g.id === message.playId);
  const item = poll || game;
  if (!item) { node.textContent = message.text; return node; }
  const card = document.createElement('section');
  card.className = `play-card ${poll ? 'poll' : game.kind}`;
  card.setAttribute('aria-label', poll ? '투표' : game.kind === 'quiz' ? '퀴즈 배틀' : '밸런스게임');
  card.innerHTML = poll ? pollHTML(poll, ctx) : game.kind === 'quiz' ? quizHTML(game, ctx) : balanceHTML(game, ctx);
  const send = (body) => act(body).catch(() => {});
  card.querySelectorAll('[data-poll-vote]').forEach((b) => { b.onclick = () => send({ action: 'poll.vote', id: poll.id, choice: Number(b.dataset.pollVote) }); });
  card.querySelector('[data-poll-close]')?.addEventListener('click', () => send({ action: 'poll.close', id: poll.id }));
  card.querySelector('[data-poll-ask]')?.addEventListener('click', () => ctx.askAI(`@${ctx.aiName} 이 투표 어떻게 생각해? "${poll.question}" (${poll.options.join(' / ')})`));
  card.querySelectorAll('[data-game-choose]').forEach((b) => { b.onclick = () => send({ action: 'game.choose', id: game.id, choice: Number(b.dataset.gameChoose) }); });
  card.querySelectorAll('[data-quiz-answer]').forEach((b) => { b.onclick = () => send({ action: 'game.choose', id: game.id, index: game.index, choice: Number(b.dataset.quizAnswer) }); });
  card.querySelector('[data-game-end]')?.addEventListener('click', () => send({ action: 'game.end' }));
  node.append(card);
  return node;
}
