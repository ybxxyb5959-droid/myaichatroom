// Pure text helpers shared by the browser UI and the tests (no DOM access).
// Chat -> workbench: the user's question and the replies of that one run, within the workbench's
// 12,000-character request limit. A final summary comes first; opinions are kept short.
export const HANDOFF_MAX = 12000;
export function houseNoticeHTML(name, text) {
  return `🧱 <span class="who">${esc(name)}</span> ${esc(text)}`;
}
const clip = (text, max) => {
  const t = String(text || '').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 12)).trimEnd()}\n…(이하 생략)`;
};
export function buildHandoff(messages, targetId, nameOf) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const target = byId.get(targetId);
  if (!target) return '';
  let question = target;
  for (let i = 0; question && question.from !== 'user' && i < 10; i++) question = byId.get(question.replyTo);
  const replies = target.runId ? messages.filter((m) => m.runId === target.runId && !['user', 'system'].includes(m.from) && m.text) : [target];
  const final = replies.find((m) => m.phase === 'final');
  const opinions = replies.filter((m) => m.phase === 'opinion');
  const answers = replies.filter((m) => !m.phase || m.phase === 'answer');
  // The first line becomes the task title in the workbench, so it names the question itself.
  const topic = String(question?.from === 'user' ? question.text : target.text).trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 50) || `${nameOf(target.from)} 답변`;
  const head = `채팅에서 이어온 작업: ${topic}\n아래는 채팅방에서 나눈 대화입니다. 이 내용을 바탕으로 프로젝트에서 필요한 작업을 진행해 주세요.`;
  const tail = '[요청]\n위 대화에서 정리된 방향대로 작업해 주세요. 수정 전에 관련 파일을 먼저 확인해 주세요.';
  const parts = [head];
  if (question?.from === 'user') {
    parts.push(`[사용자 질문]\n${clip(question.text, 2500)}${question.attach?.path ? '\n(채팅에 첨부한 사진은 함께 넘어가지 않아요)' : ''}`);
  }
  let room = HANDOFF_MAX - parts.join('\n\n').length - tail.length - 200;
  if (final) {
    const block = `[최종 정리 · ${nameOf(final.from)}]\n${clip(final.text, Math.floor(room * (opinions.length ? 0.6 : 1)))}`;
    parts.push(block); room -= block.length;
  }
  const list = opinions.length ? opinions : answers;
  if (list.length) {
    const each = Math.max(200, Math.floor((room - 40) / list.length) - 20);
    parts.push(opinions.length
      ? `[AI별 핵심 의견]\n${list.map((m) => `- ${nameOf(m.from)}: ${clip(m.text, Math.min(each, final ? 800 : each))}`).join('\n')}`
      : list.map((m) => `[AI 답변 · ${nameOf(m.from)}]\n${clip(m.text, each)}`).join('\n\n'));
  }
  parts.push(tail);
  return parts.join('\n\n').slice(0, HANDOFF_MAX);
}
export const esc =(s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only the URL shape is checked (http/https); nothing says the page exists or supports the claim.
export function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()"'`\]]*[^\s<>()"'`\].,;:!?])/g;

function emphasis(text) {
  return esc(text).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
}
function links(text) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    out += emphasis(text.slice(last, m.index));
    const url = safeUrl(m[2] || m[3]);
    out += url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(m[1] || m[3])}</a>` : esc(m[0]);
    last = m.index + m[0].length;
  }
  return out + emphasis(text.slice(last));
}
export function mdInline(s) {
  return String(s).split(/(`[^`\n]+`)/).map((part, i) => (i % 2 ? `<code>${esc(part.slice(1, -1))}</code>` : links(part)))
    .join('').replace(/\n/g, '<br>');
}

// Long text is folded from the first paragraph break after `limit` characters, so the room stays
// readable. A code block is never cut in the middle, and a short remainder is simply shown.
export function splitFold(text, limit = 450) {
  const src = String(text);
  if (src.length <= limit * 1.3) return { head: src, tail: '' };
  const re = /\n{2,}/g;
  let m;
  while ((m = re.exec(src))) {
    if (m.index < limit) continue;
    const before = src.slice(0, m.index);
    if ((before.match(/^```/gm) || []).length % 2) continue;
    if (/(^|\n)#{1,4}\s[^\n]*$/.test(before)) continue; // never leave a heading dangling at the end
    const tail = src.slice(m.index + m[0].length).trimStart();
    return tail.length < 150 ? { head: src, tail: '' } : { head: src.slice(0, m.index).trimEnd(), tail };
  }
  return { head: src, tail: '' };
}

const LONG_CODE_LINES = 15;
export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${mdInline(para.join('\n'))}</p>`); para.length = 0; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const long = buf.length > LONG_CODE_LINES;
      out.push(`<div class="code-block"><div class="code-head"><span>${esc(lang || '코드')}${long ? ` · ${buf.length}줄` : ''}</span><span class="code-actions">${long ? '<button type="button" class="code-expand">펼치기</button>' : ''}<button type="button" class="copy-code">복사</button></span></div><pre${long ? ' class="collapsed"' : ''}><code>${esc(buf.join('\n'))}</code></pre></div>`);
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      flush(); const n = Math.min(m[1].length, 3);
      out.push(`<h${n}>${mdInline(m[2])}</h${n}>`); i++; continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) {
      flush(); const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${mdInline(buf.join('\n'))}</blockquote>`); continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush(); const ordered = /^\s*\d/.test(line); const buf = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${buf.map((b) => `<li>${mdInline(b)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush(); const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line); const body = []; i += 2;
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line); i++;
  }
  flush();
  return out.join('\n');
}

// Links written in an answer (outside code blocks), deduplicated, http/https only.
export function extractLinks(src, max = 20) {
  const text = String(src).replace(/```[\s\S]*?(```|$)/g, '').replace(/`[^`\n]+`/g, '');
  const seen = new Map();
  for (const m of text.matchAll(LINK)) {
    const url = safeUrl(m[2] || m[3]);
    if (!url || seen.has(url)) continue;
    const u = new URL(url);
    seen.set(url, { url, host: u.hostname.replace(/^www\./, ''), label: m[1] || '' });
    if (seen.size >= max) break;
  }
  return [...seen.values()];
}
