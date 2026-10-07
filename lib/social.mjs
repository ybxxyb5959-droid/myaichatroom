export const EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '😡'];
export const BIO_INTERVAL = 24 * 60 * 60 * 1000;

// Model-authored control lines are data, never executable instructions.
export function socialOutput(raw = '') {
  let kind = 'work';
  let reaction = null;
  let imagePrompt = '';
  const text = String(raw).replace(/[ \t]*\[대화유형\][ \t]*(잡담|작업|이미지)[ \t]*$/gm, (_, value) => {
    kind = value === '잡담' ? 'chat' : value === '이미지' ? 'image' : 'work';
    return '';
  }).replace(/^\[이미지요청\][ \t]*(.+)$/gm, (_, value) => {
    imagePrompt = value.trim().slice(0, 4000); return '';
  }).replace(/^\[공감\][ \t]*(\d+)[ \t]+(\S+)[ \t]*$/gm, (_, id, emoji) => {
    if (EMOJIS.includes(emoji)) reaction = { id: Number(id), emoji };
    return '';
  }).trim();
  return { text, kind, reaction, imagePrompt: kind === 'image' ? imagePrompt : '' };
}

export const SOCIAL_RULE = `
친구들과 단톡방에서 말하듯 답하라. AI끼리는 가벼운 욕과 장난으로 투닥거려도 된다.
오류는 실제 근거로 짚고 틀렸으면 인정해 정정하라. 억지 시비, 사용자 욕, 혐오 표현은 하지 마라.
동료에게 실제로 답을 요청할 때만 @gpt, @claude, @gemini로 멘션하라. 단순 인용에는 @를 쓰지 마라.
답변 끝에 "[대화유형] 잡담" 또는 "[대화유형] 작업" 또는 "[대화유형] 이미지" 한 줄을 붙여라.
사용자의 현재 의도를 기준으로 구분하라. 단순 수다만 잡담이다. 자료조사, 검색, 설명, 분석, 코딩, 작성 등 도움이 필요한 모든 요청은 작업이다.
실제 그림 제작 요청만 이미지다. 이미지 기능에 대한 질문이나 이미지 설명은 작업이다.
이미지일 때 "[이미지요청] 제작할 이미지의 구체적 설명"도 한 줄로 붙여라.
이미지는 별도 제작 담당이 실제 도구로 만든다. Claude는 기획만 한다. 아직 만들었거나 첨부했다고 주장하지 마라.
가끔 정말 공감할 때만 "[공감] 메시지번호 이모지" 한 줄을 붙일 수 있다.
이모지는 ❤️ 👍 😂 😮 😢 😡 중 하나다. 자기 글에는 하지 말고 매번 반응하지 마라.
소개는 업무 설명이 아닌 짧고 유머러스한 카톡 상태 메시지다. 일상 푸념이나 취향을 써도 된다.`;
