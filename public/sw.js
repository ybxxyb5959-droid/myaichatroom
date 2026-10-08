const CACHE = 'chatroom-public-v5';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/offline.html', '/icon-192.png?v=20261008', '/icon-512.png?v=20261008'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('chatroom-public-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
// Never cache authenticated pages, QR links, API data, conversation history or workspace files.
self.addEventListener('fetch', event => {
  if (event.request.method === 'GET' && event.request.mode === 'navigate' && new URL(event.request.url).origin === self.location.origin) {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
  }
});
// Web Push: the payload carries only a title, who and what kind; tapping opens (or focuses) the room.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  event.waitUntil(self.registration.showNotification(data.title || 'AI 단톡방', {
    body: data.body || '새 메시지가 있어요', tag: data.tag || 'room', renotify: data.tag === 'mention',
    icon: '/icon-192.png?v=20261008', badge: '/icon-192.png?v=20261008', data: { url: '/' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(client => new URL(client.url).origin === self.location.origin);
    return open ? open.focus() : self.clients.openWindow('/');
  }));
});
