import { dotCharacter } from './dot-characters.mjs';
const IDS = ['gpt', 'gemini', 'claude'];
const NAMES = { gpt: 'ChatGPT', gemini: 'Gemini', claude: 'Claude' };
const PHASES = { opinion: '의견 작성 중', review: '서로 검토 중', final: '최종 정리 중' };

// Keep the spotlight until that actual call finishes; never invent a timed turn.
export function discussionScene(room, previous = null) {
  const active = room.active?.mode === 'discussion' ? room.active : null;
  const busy = IDS.filter((id) => active?.states[id]?.status === '생성 중');
  const speaker = busy.includes(previous) ? previous : busy[0] || null;
  return {
    visible: !!room.discussion || !!active,
    speaker,
    running: busy.length > 0,
    // stage: 'idle' before a question, then the discussion's own phase; synth: who writes the final answer.
    stage: active ? active.phase || 'opinion' : 'idle', synth: active?.synthesizer || null,
    title: active?.phase === 'selection' ? '최종 답변 AI 선정 중' : active?.synthesizer
      ? `최종 답변 담당: ${active.synthesizer === 'gpt' ? 'GPT' : active.synthesizer === 'claude' ? 'Claude' : 'Gemini'}`
      : active ? '토론 중' : '토론 대기 · 질문을 보내 주세요',
    characters: IDS.map((id) => {
      const current = active?.states[id];
      return {
        id, name: NAMES[id],
        phase: current?.status === '생성 중' ? current.phase || 'opinion' : 'idle',
        status: current?.status === '생성 중'
          ? PHASES[current.phase] || '생각 중'
          : current?.status || (room.enabled[id] ? '대기' : '참여 꺼짐'),
        muted: active ? !current || current.status === '제외' : !room.enabled[id],
        done: current?.status === '완료',
      };
    }),
  };
}

// A round table: Codex front-left, Gemini at the back, Claude Code front-right. Switching the discussion on walks
// everyone to their chair once; a question card on the table starts the talk; only members whose call is really
// running move, so the picture never runs ahead of the discussion. A member left out keeps an empty, faded chair.
const SEATS = ['front-left', 'back', 'front-right'];
export function createDiscussionStage(root) {
  let speaker = null;
  let runId = null;
  let shown = false;
  const doc = root.ownerDocument;
  const title = doc.createElement('div');
  title.className = 'discussion-stage-title';
  title.setAttribute('role', 'status');
  const table = doc.createElement('div');
  table.className = 'round-stage';
  table.innerHTML = `<div class="round-table" aria-hidden="true"><i class="round-card">?</i><i class="round-pile"></i></div>`;
  const characters = IDS.map((id, i) => {
    const node = doc.createElement('div');
    node.className = `discussion-character character-${id} seat-${SEATS[i]}`;
    node.style.setProperty('--turn', i);
    node.innerHTML = `<i class="round-chair" aria-hidden="true"></i><div class="discussion-actor" aria-hidden="true">
      <i class="round-flag"></i>
      <div class="pixel-speech" hidden><i></i><i></i><i></i></div>
      ${dotCharacter(i)}
      </div><i class="round-note" aria-hidden="true"></i><strong>${NAMES[id]}</strong><small></small>`;
    table.append(node);
    return node;
  });
  root.replaceChildren(title, table);
  return (room) => {
    if (runId !== room.active?.id) speaker = null;
    runId = room.active?.id;
    const scene = discussionScene(room, speaker);
    speaker = scene.speaker;
    root.hidden = !scene.visible;
    // Walking in to the chairs happens once, when the stage appears.
    if (scene.visible && !shown) {
      root.classList.remove('is-entering'); void root.offsetWidth; root.classList.add('is-entering');
      setTimeout(() => root.classList.remove('is-entering'), 1400);
    }
    shown = scene.visible;
    root.classList.toggle('is-running', scene.visible && scene.running);
    root.classList.toggle('is-active', scene.stage !== 'idle');
    root.dataset.stage = scene.stage;
    const heading = scene.speaker
      ? `${scene.title} · ${NAMES[scene.speaker]} ${scene.characters.find((c) => c.id === scene.speaker).status}`
      : scene.title;
    if (title.textContent !== heading) title.textContent = heading;
    characters.forEach((node, i) => {
      const character = scene.characters[i];
      const speaking = scene.visible && character.id === scene.speaker;
      node.classList.toggle('is-speaking', speaking);
      node.classList.toggle('is-muted', character.muted);
      node.classList.toggle('is-done', scene.stage !== 'idle' && !character.muted && (character.done || ['review', 'selection', 'final'].includes(scene.stage)));
      node.classList.toggle('is-synth', character.id === scene.synth);
      node.dataset.phase = character.phase;
      node.querySelector('.pixel-speech').hidden = !speaking;
      const status = node.querySelector('small');
      if (status.textContent !== character.status) status.textContent = character.status;
    });
    const synthSeat = SEATS[IDS.indexOf(scene.synth)];
    table.dataset.synth = scene.stage === 'final' && synthSeat ? synthSeat : '';
  };
}
