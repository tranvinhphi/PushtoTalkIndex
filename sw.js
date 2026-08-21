/**
 * Service Worker - Bộ Đàm Web v10.0.0
 * NEW: Chat push notifications với nội dung tin nhắn
 *      postMessage relay để trigger TTS khi tab focus lại
 */
const CACHE_NAME = 'botdam-shell-v10';
const SHELL_FILES = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).catch(() => {}));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;
  // Bỏ qua external API calls - không cache
  if (url.includes('overpass') || url.includes('socket.io') || 
      url.includes('tile.openstreetmap') || url.includes('leaflet') ||
      url.includes('googleapis') || url.includes('cdnjs') ||
      url.includes('jsdelivr') || url.includes('unpkg') ||
      url.includes('socket.io')) return;
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── WEB PUSH ──────────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) { data = { title:'Bộ Đàm', body: event.data?.text()||'' }; }

  const title = data.title || '💬 Tin nhắn mới';
  const options = {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || 'botdam-chat',
    renotify: true,
    vibrate: data.tag === 'botdam-sos' ? [300,100,300,100,300] : [80,40,80],
    data: { roomCode: data.roomCode||'', chatText: data.chatText||'', sender: data.sender||'' },
  };

  event.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(clients => {
      // Nếu có tab đang focused → không hiện notification hệ thống
      // nhưng vẫn postMessage để trigger TTS nếu tab đang mở mà không focused
      const focusedClient = clients.find(c => c.focused);
      if (focusedClient) return; // tab đang xem → app tự xử lý

      // Gửi postMessage đến tất cả tab đang mở để trigger TTS khi focus lại
      clients.forEach(c => {
        c.postMessage({ type:'CHAT_TTS', text: data.chatText, sender: data.sender });
      });

      return self.registration.showNotification(title, options);
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { chatText, sender } = event.notification.data || {};
  event.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(clients => {
      for (const c of clients) {
        // Focus tab + gửi lệnh đọc TTS ngay khi user click notification
        c.postMessage({ type:'NOTIFICATION_CLICK_TTS', text: chatText, sender });
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
