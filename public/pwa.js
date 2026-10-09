let installation;
const connection = document.createElement('div');
connection.className = 'pwa-connection'; connection.setAttribute('role', 'status'); connection.hidden = true;
document.body.append(connection);
function offline() {
  connection.hidden = navigator.onLine;
  connection.textContent = '오프라인 · 다시 연결하는 중입니다. 방장 PC와 단톡방 서버가 켜져 있어야 합니다.';
}
addEventListener('offline', offline);
addEventListener('online', () => { offline(); dispatchEvent(new Event('room-reconnect')); });
addEventListener('pageshow', () => { if (navigator.onLine) dispatchEvent(new Event('room-reconnect')); });
offline();
if ('serviceWorker' in navigator && isSecureContext)
  navigator.serviceWorker.register('/sw.js').catch(error => console.warn('PWA 등록 실패', error));
const button = document.createElement('button');
button.type = 'button'; button.className = 'pwa-install';
const menuHost = document.body.dataset.role !== 'guest' && document.querySelector('[data-owner-install]');
const toolbar = menuHost || document.querySelector('[data-pwa-install]');
function label(text) {
  button.setAttribute('aria-label', text); button.title = text;
  if (menuHost) button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>앱 설치 · 홈 화면 추가</span>';
  else if (!toolbar) button.textContent = text;
}
if (toolbar && !menuHost) {
  button.classList.add('icon-btn');
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
label('이 기기에 앱 설치');
const host = toolbar || document.querySelector('.phone-page header') || document.body;
host.append(button);
const standalone = matchMedia('(display-mode: standalone)');
let installed = standalone.matches || navigator.standalone === true;
function updateInstallation() {
  button.hidden = installed || standalone.matches;
  if (document.body.dataset.role === 'guest') {
    const leave = document.querySelector('#guestLeave'), actions = document.querySelector('.head-actions');
    if (button.hidden && leave && actions) actions.append(leave);
  }
}
async function detectInstalled() {
  if (navigator.getInstalledRelatedApps) {
    try {
      const apps = await navigator.getInstalledRelatedApps();
      installed ||= apps.some(app => app.platform === 'webapp' && (app.id === new URL('/', location.href).href || app.url === new URL('/manifest.webmanifest', location.href).href));
    } catch { /* Unsupported browsers still use display-mode and appinstalled. */ }
  }
  updateInstallation();
}
updateInstallation(); detectInstalled();
standalone.addEventListener('change', () => { installed ||= standalone.matches; updateInstallation(); });
addEventListener('beforeinstallprompt', event => { event.preventDefault(); installation = event; label('이 기기에 앱 설치'); updateInstallation(); });
addEventListener('appinstalled', () => { installed = true; installation = null; updateInstallation(); });
const help = document.createElement('dialog'); help.className = 'pwa-help'; help.setAttribute('aria-label', '앱 설치 안내');
const heading = document.createElement('h2'), message = document.createElement('p'), close = document.createElement('button');
heading.textContent = '앱 설치'; close.type = 'button'; close.textContent = '확인'; close.onclick = () => help.close();
help.append(heading, message, close); document.body.append(help);
button.onclick = async () => {
  if (installation) {
    const prompt = installation; installation = null;
    try { await prompt.prompt(); await prompt.userChoice; }
    catch { message.textContent = '설치 창을 열지 못했습니다. 브라우저 메뉴에서 앱 설치를 선택해 주세요.'; help.showModal(); }
    return;
  }
  await detectInstalled();
  if (installed) return;
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  message.textContent = mobile
    ? /iPhone|iPad/i.test(navigator.userAgent) ? 'Safari 공유 메뉴 → 홈 화면에 추가를 선택해 주세요.' : 'Chrome 메뉴 → 앱 설치 또는 홈 화면에 추가를 선택해 주세요. 브라우저가 설치를 준비하면 이 버튼으로 설치 창을 바로 열 수 있습니다.'
    : '이미 설치했다면 주소창의 ‘앱에서 열기’를 누르세요. 처음 설치하는 경우 Chrome/Edge 메뉴에서 앱 설치를 선택하세요. 브라우저가 설치를 준비하면 이 버튼으로 설치 창을 바로 열 수 있습니다.';
  help.showModal();
};