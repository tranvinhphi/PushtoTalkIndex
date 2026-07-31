/**
 * Service Worker - Bộ Đàm Web v4.0.0
 * Nhiệm vụ:
 * 1. Cho phép cài đặt app ra màn hình chính (PWA) -> giúp app "sống" lâu hơn
 *    khi bị đưa xuống nền so với chạy trong 1 tab trình duyệt thường.
 * 2. Nhận Web Push từ server và hiện thông báo kèm rung khi có người bắt đầu
 *    nói, kể cả khi tab app đang không ở trên cùng (đã chuyển sang app khác).
 *
 * LƯU Ý QUAN TRỌNG (giới hạn thực tế của trình duyệt di động):
 * - Service Worker KHÔNG thể tự phát lại âm thanh đã nhận qua Socket.io khi
 *   tab bị hệ điều hành tạm dừng hoàn toàn - nó chỉ có thể hiện 1 thông báo
 *   hệ thống (kèm rung) để gọi người dùng quay lại mở app.
 * - Trên iOS Safari, Web Push chỉ hoạt động nếu app đã được "Thêm vào Màn
 *   hình chính" (Add to Home Screen) và chạy từ icon đó, từ iOS 16.4 trở lên.
 */

const CACHE_NAME = 'botdam-shell-v4';
const SHELL_FILES = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first cho index.html (luôn ưu tiên bản mới nhất khi có mạng),
// fallback về cache khi mất mạng - chỉ để mở được app, KHÔNG ảnh hưởng
// tới kết nối real-time (Socket.io tự lo phần đó).
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ============ WEB PUSH ============
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Bộ Đàm', body: event.data ? event.data.text() : '' }; }

  const title = data.title || '🎙️ Có người đang nói';
  const options = {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || 'botdam-speaking',
    renotify: true,
    vibrate: [80, 40, 80, 40, 160],
    data: { roomCode: data.roomCode || '' },
  };

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const hasFocused = clients.some((c) => c.focused);
      if (hasFocused) return; // app đang mở & đang xem -> không cần bắn thông báo hệ thống
      return self.registration.showNotification(title, options);
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
