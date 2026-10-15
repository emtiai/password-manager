// Service Worker: macht die App offline-fähig.
// Beim Ändern von Dateien VERSION erhöhen, damit Geräte die neue Version laden.
const VERSION = 'v4';
const SHELL = `shell-${VERSION}`;
const OCR = `ocr-${VERSION}`;

const SHELL_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/vault.js',
  'js/crypto.js',
  'js/storage.js',
  'js/webauthn.js',
  'js/domain.js',
  'js/ocr.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' umgeht den HTTP-Cache des Browsers. Sonst könnte ein Update
  // (GitHub Pages erlaubt 10 Min. Zwischenspeicherung) wieder die alten Dateien übernehmen.
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== SHELL && key !== OCR) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Teilen-Ziel und Start: immer die App-Shell ausliefern (Query-Parameter ignorieren).
  if (req.mode === 'navigate') {
    event.respondWith(caches.match('index.html').then((r) => r || fetch(req)));
    return;
  }

  // Texterkennung (~6 MB) erst bei der ersten Nutzung laden und dann offline vorhalten.
  const cacheName = url.pathname.includes('/vendor/') ? OCR : SHELL;
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    const res = await fetch(req);
    if (res.ok) (await caches.open(cacheName)).put(req, res.clone());
    return res;
  })());
});
