// Service Worker: macht die App offline-fähig.
// Beim Ändern von Dateien VERSION erhöhen, damit Geräte die neue Version laden.
const VERSION = 'v5';
const INBOX = 'share-inbox'; // per „Teilen“ empfangene Datei, bis die App sie übernimmt
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
      if (key !== SHELL && key !== OCR && key !== INBOX) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// Teilen-Ziel: Android schickt geteilte Links/Dateien als POST an ./share-target.
// Links werden als Query-Parameter weitergereicht, Dateien zwischengelagert.
async function handleShare(req) {
  const form = await req.formData();
  const params = new URLSearchParams();
  for (const key of ['title', 'text', 'url']) {
    const v = form.get(key);
    if (typeof v === 'string' && v) params.set(key, v);
  }
  const file = form.get('file');
  if (file && typeof file !== 'string' && file.size) {
    await (await caches.open(INBOX)).put('inbox', new Response(file));
    params.set('inbox', '1');
  }
  return Response.redirect(new URL(`./?${params}`, self.registration.scope).href, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET') return;
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
