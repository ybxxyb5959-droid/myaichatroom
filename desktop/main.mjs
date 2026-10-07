import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createAssistantServer, loadConfig } from '../server.mjs';
import { Adapters, killAll } from '../lib/agents.mjs';
import { UsageMonitor } from '../lib/usage.mjs';
import { isLocalNavigation, isExternalWebLink } from './policy.mjs';

const smoke = process.argv.includes('--smoke-test');
let backend;
let window;
let stopping = false;

async function launch() {
  const root = process.env.CHATROOM_HOME || path.join(app.getPath('userData'), 'room');
  fs.mkdirSync(root, { recursive: true });
  const cfg = loadConfig(process.env.CHATROOM_CONFIG || path.join(root, 'config.json'));
  // The packaged smoke check must never sign in, query usage or invoke a real AI.
  const adapter = smoke ? { available: () => ({ gpt: false, claude: false, gemini: false }) } : new Adapters(root, cfg);
  backend = createAssistantServer({ root, cfg, adapter,
    usage: smoke ? null : new UsageMonitor(root, adapter.bins), greetings: !smoke });
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
      const pets = [...document.querySelectorAll('.empty-character svg')];
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
      document.querySelector('#shareBtn').click();
      const deadline = Date.now() + 5000;
      while (!document.querySelector('[data-usage]').textContent && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 25));
      const panel = document.querySelector('.share-dialog');
      const bounds = panel.getBoundingClientRect();
      const result = { open: panel.open, fits: bounds.left >= 0 && bounds.right <= innerWidth,
        usage: panel.querySelector('[data-usage]').textContent,
        ownerQR: panel.querySelector('[data-pair]').textContent,
        friendQR: panel.querySelector('[data-invite]').textContent,
        defaultLimit: panel.querySelector('[name=total]').value,
        manifest: document.querySelector('link[rel=manifest]').getAttribute('href') };
      panel.close();
      const registration = await navigator.serviceWorker.ready;
      result.worker = !!registration.active;
      return result;
    })()`);
    if (!sharingScreen.open || !sharingScreen.fits || sharingScreen.usage !== '오늘 0/15회 사용'
      || sharingScreen.ownerQR !== '내 휴대폰 QR' || sharingScreen.friendQR !== '친구 초대 QR'
      || sharingScreen.defaultLimit !== '15' || sharingScreen.manifest !== '/manifest.webmanifest' || !sharingScreen.worker)
      throw new Error('공유 메뉴·PWA 확인 실패: ' + JSON.stringify(sharingScreen));
    console.log('SHARING_SCREEN_SMOKE ' + JSON.stringify(sharingScreen));
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
    console.log('DESKTOP_SMOKE ' + JSON.stringify({ ok: true, packaged: app.isPackaged, title: ui.title,
      input: ui.input, sandbox: prefs.sandbox, members: state.members.length }));
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
