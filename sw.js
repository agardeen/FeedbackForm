// Bump this on every deploy that changes cached files so clients pick up the update.
const CACHE_NAME = 'field-feedback-v2';

const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './icons/apple-touch-icon.png',
    './icons/favicon-32.png',
];

// Third-party assets needed for the page to render correctly offline.
const RUNTIME_SHELL = [
    'https://cdn.tailwindcss.com',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
];

// Hosts that should always hit the network (live lookups, never cached).
const NETWORK_ONLY_HOSTS = ['nominatim.openstreetmap.org'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            const shellReqs = APP_SHELL.map((url) => new Request(url, { cache: 'reload' }));
            const runtimeReqs = RUNTIME_SHELL.map((url) => new Request(url, { mode: 'no-cors', cache: 'reload' }));
            return Promise.all([
                cache.addAll(shellReqs),
                ...runtimeReqs.map((req) => fetch(req).then((res) => cache.put(req, res)).catch(() => {})),
            ]);
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (NETWORK_ONLY_HOSTS.includes(url.hostname)) return; // let the browser handle it natively

    // The page itself: network-first. A cache-first strategy here would mean edits never show
    // up for a returning visitor until the service worker script itself happens to change —
    // exactly the staleness bug this replaced. Always prefer a fresh copy when online; only
    // fall back to whatever's cached when the network request actually fails (i.e. offline).
    const isAppDocument = url.origin === self.location.origin
        && (request.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/manifest.json'));

    if (isAppDocument) {
        event.respondWith(
            fetch(request).then((response) => {
                const copy = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
                return response;
            }).catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
        );
        return;
    }

    // Google Fonts' font files (gstatic) and the OCR library's scripts/wasm/language data
    // (jsdelivr) aren't in RUNTIME_SHELL up front since their exact URLs are only known
    // once the page runs — cache them the first time they're actually requested instead.
    const RUNTIME_CACHEABLE_HOSTS = ['fonts.gstatic.com', 'cdn.jsdelivr.net'];
    const cacheable = url.origin === self.location.origin
        || RUNTIME_SHELL.includes(request.url)
        || RUNTIME_CACHEABLE_HOSTS.includes(url.hostname);

    if (!cacheable) return;

    // Everything else (icons, Tailwind, fonts, the OCR engine/data): cache-first. These are
    // large or effectively immutable, so an instant offline load beats a network round-trip.
    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) return cached;
            return fetch(request).then((response) => {
                const copy = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
                return response;
            }).catch(() => Response.error());
        })
    );
});
