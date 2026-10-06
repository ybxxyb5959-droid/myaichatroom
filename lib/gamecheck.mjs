// A fresh, headless browser checks a game in the same restricted iframe as the UI.
// No generated JavaScript is ever executed by Node or given a local file origin.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { withHeadlessPage } from './worldshot.mjs';
import { GAME_CSP, gameDocument, syntaxCheck } from './game.mjs';

export async function checkGame({ title, code, signal }) {
  const syntax = syntaxCheck(code);
  if (!syntax.ok) return syntax;
  const nonce = crypto.randomUUID();
  const probe = `<script>
const gameErrors=[];
addEventListener('error',e=>gameErrors.push(String(e.message).slice(0,300)));
addEventListener('unhandledrejection',e=>gameErrors.push(String(e.reason).slice(0,300)));
addEventListener('load',()=>{setTimeout(()=>{
  const start=document.querySelector('button');
  if(!start)gameErrors.push('게임 시작 버튼이 없습니다.');
  else start.click();
  setTimeout(()=>parent.postMessage({nonce:'${nonce}',ok:!gameErrors.length,errors:gameErrors.slice(0,4)},'*'),500);
},100);});
</script>`;
  const html = gameDocument(title, code, probe);
  const parent = `<!doctype html><meta charset="utf-8"><div id="game-check-result"></div>
<iframe id="game" sandbox="allow-scripts" src="/game"></iframe><script>
addEventListener('message',e=>{
 if(e.source===document.getElementById('game').contentWindow&&e.data?.nonce==='${nonce}')
 document.getElementById('game-check-result').setAttribute('data-result',encodeURIComponent(JSON.stringify(e.data)));
});</script>`;
  const server = http.createServer((req, res) => {
    if (!['/', '/game'].includes(req.url)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': req.url === '/game' ? GAME_CSP
        : "default-src 'none'; script-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'" });
    res.end(req.url === '/game' ? html : parent);
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-game-check-'));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return await withHeadlessPage(profile, { width: 640, height: 480, timeoutMs: 15000, signal }, async (send, deadline) => {
      await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
      while (Date.now() < deadline) {
        const result = await send('Runtime.evaluate', {
          expression: "document.getElementById('game-check-result')?.getAttribute('data-result')", returnByValue: true,
        });
        const encoded = result.result?.value;
        if (encoded) {
          const check = JSON.parse(decodeURIComponent(encoded));
          return { ok: check.ok === true, errors: check.errors.map((s) => String(s).slice(0, 300)).slice(0, 4) };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ok: false, errors: ['게임 실행 확인 시간이 초과되었습니다.'] };
    });
  } catch (e) {
    return { ok: false, errors: [String(e.message).slice(0, 300)] };
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
