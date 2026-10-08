let installation;
if ('serviceWorker' in navigator && isSecureContext)
  navigator.serviceWorker.register('/sw.js').catch(error => console.warn('PWA 등록 실패', error));
const button = document.createElement('button');
button.type = 'button'; button.className = 'pwa-install'; button.textContent = '이 기기의 홈 화면 추가 안내';
const host = document.querySelector('[data-pwa-install]') || document.querySelector('.phone-page header') || document.querySelector('main') || document.body;
host.append(button);
button.hidden = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
addEventListener('beforeinstallprompt', event => { event.preventDefault(); installation = event; button.textContent = '이 기기에 앱 추가'; button.hidden = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; });
addEventListener('appinstalled', () => { button.hidden = true; installation = null; });
button.onclick = async () => {
  if (installation) {
    await installation.prompt(); await installation.userChoice; installation = null;
  } else {
    alert('Android: Chrome 메뉴에서 “앱 설치” 또는 “홈 화면에 추가”를 선택하세요.\n\niPhone: Safari에서 공유 → “홈 화면에 추가”를 선택하세요.\n\nQR만 찍으면 자동 설치되는 것은 아닙니다. 방장 PC와 단톡방 앱의 공유 연결은 계속 켜져 있어야 합니다.');
  }
};
