import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server.mjs';
import { isLocalNavigation, isExternalWebLink } from '../desktop/policy.mjs';

test('데스크톱 창은 자기 로컬 서버만 열고 외부 브라우저에는 HTTP(S) 링크만 넘긴다', () => {
  const origin = 'http://127.0.0.1:32123';
  assert.equal(isLocalNavigation(origin + '/', origin), true);
  assert.equal(isLocalNavigation(origin + '/ws/game.html', origin), true);
  for (const value of ['http://127.0.0.1:32124/', 'http://localhost:32123/', 'https://example.com/',
    'file:///C:/Windows/', 'javascript:alert(1)', 'not a URL']) assert.equal(isLocalNavigation(value, origin), false);
  assert.equal(isExternalWebLink('https://example.com/help', origin), true);
  assert.equal(isExternalWebLink('http://example.com/help', origin), true);
  for (const value of [origin, 'file:///C:/Windows/', 'javascript:alert(1)', 'ms-settings:privacy',
    'https://user:password@example.com/', 'not a URL']) assert.equal(isExternalWebLink(value, origin), false);
});

test('설치 앱은 지정한 사용자 데이터 폴더의 설정을 읽고 설정이 없으면 기본값으로 시작한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-desktop-config-'));
  try {
    const config = path.join(root, 'config.json');
    assert.equal(loadConfig(config).roomName, 'AI 단톡방');
    fs.writeFileSync(config, JSON.stringify({ roomName: '내 설치 앱', agents: { claude: { model: 'sonnet' } } }));
    const value = loadConfig(config);
    assert.equal(value.roomName, '내 설치 앱');
    assert.equal(value.agents.claude.model, 'sonnet');
    assert.ok(value.agents.gpt.model);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
