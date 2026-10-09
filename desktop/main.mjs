import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createAssistantServer, loadConfig } from '../server.mjs';
import { Adapters, killAll } from '../lib/agents.mjs';
import { UsageMonitor } from '../lib/usage.mjs';
import { isLocalNavigation, isExternalWebLink } from './policy.mjs';

const smoke = process.argv.includes('--smoke-test');
if (smoke && process.env.CHATROOM_HOME) app.setPath('userData', path.join(process.env.CHATROOM_HOME, 'electron-profile'));
let backend;
let window;
let stopping = false;
const smokeTargets = {};

async function launch() {
  const root = process.env.CHATROOM_HOME || path.join(app.getPath('appData'), 'AI 단톡방', 'room');
  fs.mkdirSync(root, { recursive: true });
  const cfg = loadConfig(process.env.CHATROOM_CONFIG || path.join(root, 'config.json'));
  // The packaged smoke check must never sign in, query usage or invoke a real AI.
  const adapter = smoke ? { available: () => ({ gpt: false, claude: false, gemini: false }) } : new Adapters(root, cfg);
  backend = createAssistantServer({ root, cfg, adapter,
    folderPicker: async () => {
      if (!window || window.isDestroyed()) throw new Error('앱 창에서 폴더를 선택해 주세요.');
      const selected = await dialog.showOpenDialog(window, {
        title: '작업대 프로젝트 폴더 선택', buttonLabel: '폴더 연결', properties: ['openDirectory', 'dontAddToRecent'],
      });
      return selected.canceled ? null : selected.filePaths[0];
    },
    usage: smoke ? null : new UsageMonitor(root, adapter.bins), greetings: !smoke,
    ...(smoke ? {
      tailscaleFunnel: async target => { smokeTargets.guest = target; return { url: 'https://smoke.example.ts.net:8443', public: true, stop: async () => {} }; },
      tailscaleServe: async target => { smokeTargets.owner = target; return { url: 'https://smoke.example.ts.net:8444', public: false, stop: async () => {} }; },
    } : {}) });
  await new Promise((resolve, reject) => {
    backend.server.once('error', reject);
    backend.server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${backend.server.address().port}`;
  if (!smoke) {
    try { await backend.startExternal(); }
    catch (error) { dialog.showErrorBox('외부 접속 실패 — PC에서는 계속 사용 가능', error.message); }
  }
  const openExternal = (url) => {
    if (isExternalWebLink(url, origin)) shell.openExternal(url).catch((error) => console.error(error));
  };
  window = new BrowserWindow({
    title: 'AI 단톡방',
    icon: path.join(import.meta.dirname, '../public/icon-512.png'),
    width: 1320,
    height: 900,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#141820',
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isLocalNavigation(url, origin)) { event.preventDefault(); openExternal(url); }
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' && isLocalNavigation(contents.getURL(), origin));
  });
  window.webContents.session.setPermissionCheckHandler((contents, permission) =>
    permission === 'clipboard-sanitized-write' && !!contents && isLocalNavigation(contents.getURL(), origin));
  window.on('closed', () => { window = null; });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '앱', submenu: [
      { label: '휴대폰 연결 (Tailscale)', click: async () => {
        try {
          await window.webContents.executeJavaScript("document.querySelector('#shareBtn').click()");
        } catch (error) { dialog.showErrorBox('휴대폰 연결 안내', error.message); }
      } },
      { label: '대화 데이터 폴더 열기', click: () => shell.openPath(root).then((error) => { if (error) dialog.showErrorBox('폴더 열기 실패', error); }) },
      { type: 'separator' },
      { label: '종료', role: 'quit' },
    ] },
    { label: '보기', submenu: [
      { label: '새로고침', role: 'reload' },
      { label: '확대', role: 'zoomIn' },
      { label: '축소', role: 'zoomOut' },
      { label: '기본 크기', role: 'resetZoom' },
      { label: '전체 화면', role: 'togglefullscreen' },
    ] },
  ]));
  await window.loadURL(origin);
  if (smoke) {
    window.setMinimumSize(0, 0);
    window.setContentSize(390, 844);
    const emptyScreen = await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 5000;
      while (document.querySelector('#empty').hidden && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 25));
      const empty = document.querySelector('#empty');
      const title = document.querySelector('#emptyDotTitle');
      const pets = [...document.querySelectorAll('#empty .empty-character svg')];
      const examples = [...document.querySelectorAll('#examples button')];
      const theme = document.documentElement.getAttribute('data-theme');
      document.documentElement.setAttribute('data-theme', 'light');
      const light = pets.map(pet => getComputedStyle(pet).fill);
      const pixels = title.getContext('2d').getImageData(0, 0, title.width, title.height).data;
      let visibleDots = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i + 3] > 0 && pixels[i] < 40 && pixels[i + 1] < 40 && pixels[i + 2] < 40) visibleDots++;
      document.documentElement.setAttribute('data-theme', 'dark');
      const dark = pets.map(pet => getComputedStyle(pet).fill);
      const darkTitle = getComputedStyle(title).filter;
      if (theme === null) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
      examples[0]?.click();
      const exampleFilled = document.querySelector('#input').value === '최근 1년 사이 바뀐 국내 전기차 보조금 제도를 출처 링크와 함께 정리해 줘.';
      const fits = [title, ...pets, ...examples].every(node => {
        const r = node.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth;
      });
      return { visible: !empty.hidden, title: title.getAttribute('aria-label'), count: pets.length,
        examples: examples.length, exampleFilled, fits, width: innerWidth, visibleDots, light, dark, darkTitle,
        delays: pets.map(pet => getComputedStyle(pet).animationDelay),
        animation: pets.map(pet => getComputedStyle(pet).animationName),
        below: document.querySelector('#examples').getBoundingClientRect().top >= title.getBoundingClientRect().bottom };
    })()`);
    if (!emptyScreen.visible || emptyScreen.title !== '대화를 시작해볼까요?' || emptyScreen.count !== 3
      || emptyScreen.examples !== 4 || !emptyScreen.exampleFilled || !emptyScreen.fits || emptyScreen.width !== 390
      || !emptyScreen.below || emptyScreen.visibleDots < 100
      || emptyScreen.light.some(color => color !== 'rgb(17, 17, 17)')
      || emptyScreen.dark.some(color => color !== 'rgb(238, 238, 238)') || emptyScreen.darkTitle !== 'invert(1)'
      || emptyScreen.delays.join(',') !== '0s,0.2s,0.4s'
      || emptyScreen.animation.some(name => name !== 'empty-wave'))
      throw new Error('새 채팅방 도트 화면 확인 실패: ' + JSON.stringify(emptyScreen));
    console.log('EMPTY_SCREEN_SMOKE ' + JSON.stringify(emptyScreen));
    const sharingScreen = await window.webContents.executeJavaScript(`(async () => {
      const loaded = Date.now() + 5000;
      while (!document.querySelector('.share-dialog [data-go]') && Date.now() < loaded)
        await new Promise(resolve => setTimeout(resolve, 25));
      if (!document.querySelector('.share-dialog [data-go]')) throw new Error('공유 화면 모듈이 로드되지 않았습니다.');
      document.querySelector('#shareBtn').click();
      const panel = document.querySelector('.share-dialog');
      const bounds = panel.getBoundingClientRect();
      const choices = [...panel.querySelectorAll('[data-view="home"] .share-choice b')].map(b => b.textContent);
      panel.querySelector('[data-go="manage"]').click();
      const managed = Date.now() + 5000;
      while (!panel.querySelector('[data-usage]').textContent && Date.now() < managed)
        await new Promise(resolve => setTimeout(resolve, 25));
      const result = { open: panel.open, fits: bounds.left >= 0 && bounds.right <= innerWidth, choices,
        usage: panel.querySelector('[data-usage]').textContent,
        defaultLimit: panel.querySelector('[name=total]').value,
        steps: [...document.querySelectorAll('#setupSteps li')].map(li => li.textContent),
        manifest: document.querySelector('link[rel=manifest]').getAttribute('href') };
      panel.close();
      const registration = await navigator.serviceWorker.ready;
      result.worker = !!registration.active;
      return result;
    })()`);
    if (!sharingScreen.open || !sharingScreen.fits || sharingScreen.choices.join(',') !== '친구 초대하기,내 폰 연결하기'
      || !sharingScreen.usage.startsWith('오늘 0 / 100회 사용') || sharingScreen.defaultLimit !== '100'
      || sharingScreen.steps.join(',') !== 'AI 연결,모델 고르기,폰·친구,시작'
      || sharingScreen.manifest !== '/manifest.webmanifest' || !sharingScreen.worker)
      throw new Error('공유 메뉴·PWA 확인 실패: ' + JSON.stringify(sharingScreen));
    console.log('SHARING_SCREEN_SMOKE ' + JSON.stringify(sharingScreen));
    const localRequest = async (route, body) => {
      const res = await fetch(origin + route, body === undefined ? {} : { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`데스크톱 공유 API 실패: ${route} (${res.status})`);
      return res.json();
    };
    const remoteRequest = async (role, route, body, cookie) => {
      const remoteOrigin = `https://smoke.example.ts.net:${role === 'owner' ? 8444 : 8443}`;
      const res = await fetch(smokeTargets[role] + route, { method: body === undefined ? 'GET' : 'POST', headers: { Host: new URL(remoteOrigin).host, Origin: remoteOrigin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0] };
    };
    await localRequest('/api/share/connect', { public: false });
    const ownerInvite = await localRequest('/api/share/invite', { role: 'owner' });
    const ownerToken = new URLSearchParams(new URL(ownerInvite.link).hash.slice(1)).get('token');
    const pending = await remoteRequest('owner', '/api/share/redeem', { token: ownerToken });
    if (pending.status !== 202 || pending.cookie) throw new Error('PC 승인 전 방장 인증이 발급됨');
    const requests = await localRequest('/api/share/pairing');
    await localRequest('/api/share/pairing', { id: requests.requests[0].id, approve: true });
    const paired = await remoteRequest('owner', '/api/share/pair-status', { token: ownerToken, challenge: pending.data.challenge });
    if (paired.status !== 200 || (await remoteRequest('owner','/api/state',undefined,paired.cookie)).status !== 200) throw new Error('방장 폰 페어링 실패');
    // The friend guide opens the public (Funnel) connection first, as the sharing window does.
    await localRequest('/api/share/connect', { public: true });
    const friendInvite = await localRequest('/api/share/invite', { role: 'guest' });
    const friendToken = new URLSearchParams(new URL(friendInvite.link).hash.slice(1)).get('token');
    const joined = await remoteRequest('guest','/api/share/redeem',{token:friendToken,name:'스모크 친구'});
    if (joined.status !== 200 || (await remoteRequest('guest','/api/house',undefined,joined.cookie)).status !== 200
      || (await remoteRequest('guest','/api/gallery',undefined,joined.cookie)).status !== 200
      || (await remoteRequest('guest','/api/tasks',undefined,joined.cookie)).status !== 403
      || (await remoteRequest('guest','/api/share',undefined,paired.cookie)).status !== 403) throw new Error('친구 초대 또는 권한 분리 실패');
    console.log('PAIRING_INVITE_SMOKE ' + JSON.stringify({ ownerPairing:true,guestJoin:true,house:true,gallery:true,adminBlocked:true,mockedTailscale:true }));
    const ui = await window.webContents.executeJavaScript(`({
      input: document.querySelector('#input')?.placeholder,
      node: typeof require,
      process: typeof process,
      title: document.title
    })`);
    const response = await fetch(`${origin}/api/state`);
    const state = await response.json();
    const prefs = window.webContents.getLastWebPreferences();
    if (!response.ok || !ui.input || ui.node !== 'undefined' || ui.process !== 'undefined'
      || !prefs.sandbox || !prefs.contextIsolation || prefs.nodeIntegration || state.members.length !== 3) {
      throw new Error('데스크톱 실행 또는 렌더러 격리 확인에 실패했습니다.');
    }
    const receipt = { ok: true, packaged: app.isPackaged, title: ui.title,
      input: ui.input, sandbox: prefs.sandbox, members: state.members.length,
      sharing: { ownerPairing:true,guestJoin:true,house:true,gallery:true,adminBlocked:true,mockedTailscale:true } };
    console.log('DESKTOP_SMOKE ' + JSON.stringify(receipt));
    if (process.env.CHATROOM_SMOKE_RECEIPT) fs.writeFileSync(process.env.CHATROOM_SMOKE_RECEIPT, JSON.stringify(receipt));
    app.quit();
  } else {
    window.show();
  }
}

if (!smoke && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (stopping || !backend) return;
    event.preventDefault();
    stopping = true;
    killAll();
    backend.close().catch((error) => console.error(error)).finally(() => app.quit());
  });
  app.whenReady().then(launch).catch((error) => {
    console.error(error);
    if (!smoke) dialog.showErrorBox('AI 단톡방 실행 실패', error.message);
    killAll();
    app.exit(1);
  });
}
