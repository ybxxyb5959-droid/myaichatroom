// Rules create events; only explicit provider choices create AI ballots.
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
export const counts = vote => vote.options.map((_, i) => Object.values(vote.ballots || {}).filter(b => b.choice === i).length);
export const winner = vote => {
  const totals = counts(vote);
  return totals.indexOf(Math.max(...totals)); // A wins all ties, declared before voting.
};
export function enroll(vote, humans, ai) {
  vote.ballots ??= {};
  vote.humans ??= [...humans];
  vote.ai ??= [...ai];
  vote.tieRule = '동점·전원 기권이면 A';
}
export function cast(vote, voter, choice, now, { humans = [], ai = [], opinion = '' } = {}) {
  if (!vote || vote.status !== 'open' || now >= vote.deadline) fail('이미 마감된 투표입니다.');
  if (!Number.isInteger(choice) || choice < 0 || choice >= vote.options.length) fail('선택지를 확인하세요.');
  const isAI = voter.startsWith('ai:');
  const id = voter.slice(isAI ? 3 : 6);
  if (isAI ? !ai.includes(id) || !vote.ai.includes(id) : !humans.includes(id)) fail('접속 중인 참여자만 투표할 수 있습니다.');
  if (vote.ballots[voter]) fail('이미 투표했습니다. 한 참여자는 한 표만 가능합니다.');
  if (!isAI && !vote.humans.includes(id)) vote.humans.push(id);
  vote.ballots[voter] = { choice, at: now, opinion: String(opinion || '').slice(0, 160), source: isAI ? 'ai' : 'human' };
}
const episodes = [
  { key: 'yard', title: '우리 집 마당', text: '함께 쉴 마당을 무엇으로 꾸밀까요?', options: ['정원', '바비큐장'] },
  { key: 'rain', title: '갑작스러운 폭우', text: '비가 오기 전에 무엇부터 지킬까요?', options: ['지붕 수리', '자재 보호'] },
  { key: 'room', title: '새로운 방의 용도', text: '다음 공동 작업의 방향을 정해 주세요.', options: ['서재', '게임방'] },
  { key: 'cooperate', title: '서로 다른 작업 의견', text: '다음 사건을 준비할 공동 작업 방식을 정해 주세요.', options: ['함께 정리', '역할 나누기'] },
];
export function advanceStory(house, now, humans, ai) {
  const s = house.s.story ??= { episode: 0, nextAt: 0, current: null, history: [], environment: { roof: 50, materials: 50 } };
  const vote = s.current;
  if (vote?.status === 'open' && now >= vote.deadline) {
    const choice = winner(vote), env = s.environment;
    if (vote.key === 'yard') env.yard = choice === 0 ? 'garden' : 'bbq';
    if (vote.key === 'rain') {
      env.roof = Math.min(100, env.roof + (choice === 0 ? 30 : -10));
      env.materials = Math.min(100, Math.max(0, env.materials + (choice === 1 ? 30 : env.yard === 'garden' ? -5 : -15)));
    }
    if (vote.key === 'room') env.room = choice === 0 ? 'library' : 'game';
    if (vote.key === 'cooperate') env.cooperation = choice === 0 ? 'together' : 'roles';
    Object.assign(vote, { status: 'applied', choice, appliedAt: now,
      result: `${vote.options[choice].label} · ${counts(vote).join(':')} (${vote.tieRule})` });
    s.history.push(structuredClone(vote));
    s.nextAt = now + 5 * 60000;
    house.s.rev++;
    house.s.events.push({ id: house.s.nextEventId++, at: now, type: 'story', tone: 'positive', actors: [], text: `EPISODE ${vote.episode} · ${vote.title}: ${vote.result}` });
    house.s.log.push({ kind: 'event', id: 'house', source: 'system', at: now, text: vote.result });
    return true;
  }
  if (!humans.length || vote?.status === 'open' || now < s.nextAt || house.s.decorVote?.status === 'open') return false;
  // Damaged roofs make the next episode a rain decision, so prior choices matter.
  const item = s.environment.roof < 40 ? episodes[1] : episodes[s.episode % episodes.length];
  s.episode++;
  s.current = { id: `episode-${s.episode}`, episode: s.episode, key: item.key, title: item.title,
    text: item.text, options: item.options.map(label => ({ label })), status: 'open', deadline: now + 60000 };
  enroll(s.current, humans, ai);
  return true;
}
export function storyPrompt(house) {
  const s = house.s.story;
  const v = s?.current?.status === 'open' ? s.current : house.s.decorVote?.ballots && house.s.decorVote.status === 'open' ? house.s.decorVote : null;
  return (s ? `\n[실제 공동 선택으로 정해진 집 환경] ${JSON.stringify(s.environment)}. 다음 작업에서 참고한다.\n` : '')
    + (v ? `\n[공동 투표 ${v.id}] ${v.title || '가구 배치'}: ${v.options.map((o, i) => `${i === 0 ? 'A' : 'B'}=${o.label}`).join(', ')}. 명확한 선택이 있으면 이번 JSON에 "vote":{"id":${JSON.stringify(v.id)},"choice":0 또는 1}과 say에 실제 이유를 쓴다. 선택하지 않으면 기권이다. 다른 AI의 선택은 만들지 않는다.\n` : '');
}
export function ballotView(vote, self = 'owner') {
  if (!vote) return null;
  return { ...vote, options: vote.options.map(({ label, by, say }) => ({ label, by, say })),
    counts: counts(vote), myChoice: vote.ballots?.[`human:${self}`]?.choice ?? null };
}
