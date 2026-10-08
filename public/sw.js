const CACHE = 'chatroom-public-v4';
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
