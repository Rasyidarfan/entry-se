const CACHE_NAME = 'se2026-static-v10';
const ASSETS = [
  '/login.html',
  '/data.html',
  '/index.html',
  '/respondent',
  '/respondent.html',
  '/styles.css?v=10',
  '/data.css?v=10',
  '/auth-client.js?v=10',
  '/data.js?v=10',
  '/app.js?v=10',
  '/respondent.js?v=10',
  '/engine.js?v=10',
  '/pdf-rules.js?v=10',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
      return res;
    }))
  );
});
