import { dotCharacter } from './dot-characters.mjs';
const IDS = ['gpt', 'gemini', 'claude'];
const NAMES = { gpt: '코덱스', gemini: '제미나이', claude: '클로드코드' };
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
    title: active ? '토론 중' : '토론 대기 · 질문을 보내 주세요',
    characters: IDS.map((id) => {
      const current = active?.states[id];
      return {
        id, name: NAMES[id],
        phase: current?.status === '생성 중' ? current.phase || 'opinion' : 'idle',
        status: current?.status === '생성 중'
          ? PHASES[current.phase] || '생각 중'
          : current?.status || (room.enabled[id] ? '대기' : '참여 꺼짐'),
        muted: active ? !current || current.status === '제외' : !room.enabled[id],
      };
    }),
  };
}

export function createDiscussionStage(root) {
  let speaker = null;
  let runId = null;
  const doc = root.ownerDocument;
  const title = doc.createElement('div');
  title.className = 'discussion-stage-title';
  title.setAttribute('role', 'status');
  const cast = doc.createElement('div');
  cast.className = 'discussion-cast';
  const characters = IDS.map((id, i) => {
    const node = doc.createElement('div');
    node.className = `discussion-character character-${id}`;
    node.style.setProperty('--turn', i);
    node.innerHTML = `<div class="discussion-actor" aria-hidden="true">
      <div class="pixel-speech" hidden><i></i><i></i><i></i></div>
      ${dotCharacter(i)}
      </div><strong>${NAMES[id]}</strong><small></small>`;
    cast.append(node);
    return node;
  });
  root.replaceChildren(title, cast);
  return (room) => {
    if (runId !== room.active?.id) speaker = null;
    runId = room.active?.id;
    const scene = discussionScene(room, speaker);
    speaker = scene.speaker;
    root.hidden = !scene.visible;
    root.classList.toggle('is-running', scene.visible && scene.running);
    const heading = scene.speaker
      ? `${scene.title} · ${NAMES[scene.speaker]} ${scene.characters.find((c) => c.id === scene.speaker).status}`
      : scene.title;
    if (title.textContent !== heading) title.textContent = heading;
    characters.forEach((node, i) => {
      const character = scene.characters[i];
      const speaking = scene.visible && character.id === scene.speaker;
      node.classList.toggle('is-speaking', speaking);
      node.classList.toggle('is-muted', character.muted);
      node.dataset.phase = character.phase;
      node.querySelector('.pixel-speech').hidden = !speaking;
      const status = node.querySelector('small');
      if (status.textContent !== character.status) status.textContent = character.status;
    });
  };
}
