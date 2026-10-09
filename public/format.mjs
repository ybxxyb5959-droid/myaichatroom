// Pure text helpers shared by the browser UI and the tests (no DOM access).
// Line icons in the header's style (24px grid, 1.8 stroke), used instead of emoji wherever the house and chat show one.
const LINE_ICONS = {
  house: 'M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5h4v5',
  build: 'M3 20h18M5 20v-5h6v5M13 20v-9h6v9M7 15v-3h6',
  tool: 'm14 11-8 9a2 2 0 0 1-3-3l9-8m-2-4 4-3 7 7-3 3-3-3-3 3-4-4z',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7',
  bot: 'M7 8h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zM12 4v4M9.5 13v.5M14.5 13v.5',
  scale: 'M12 4v16M7 20h10M5 7h14M5 7l-2.5 6a2.5 2.5 0 0 0 5 0zM19 7l-2.5 6a2.5 2.5 0 0 0 5 0z',
  game: 'M7 7h10a4 4 0 0 1 4 4v3a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-3a4 4 0 0 1 4-4zM8 10.5v4M6 12.5h4M15.5 11.5v.5M17.5 13.5v.5',
  vote: 'M5 11h14v9H5zM9 11V5h6v6M10 8l1.5 1.5L14 7',
  leaf: 'M5 19c0-8 5-13 14-14 0 9-5 14-13 14M5 19l7-7',
  fire: 'M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z',
  box: 'M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8',
  users: 'M9 11.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5M17 11.5a2.5 2.5 0 1 0 0-5M16 14.2c2.6.1 4.4 1.7 5 4.3',
  puzzle: 'M5 5h5a2 2 0 1 1 4 0h5v5a2 2 0 1 0 0 4v5h-5a2 2 0 1 0-4 0H5v-5a2 2 0 1 0 0-4z',
  chat: 'M4 5h16v11H9l-5 4z',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18',
};
export function lineIcon(name, cls = 'line-ic') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${LINE_ICONS[name] || LINE_ICONS.sparkle}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
export function houseNoticeHTML(name, text) {
  return `${lineIcon('build')} <span class="who">${esc(name)}</span> ${esc(text)}`;
}
export function houseEventHTML(text, eventId) {
  return `<span>${lineIcon('house')} ${esc(text)}</span>` + (Number.isInteger(eventId) && eventId > 0
    ? `<button type="button" class="house-event-link" data-house-event="${eventId}">확인하러 가기</button>` : '');
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
