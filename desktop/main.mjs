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
