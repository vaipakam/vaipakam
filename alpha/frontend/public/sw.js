/**
 * Vaipakam — Phase 9 PWA service worker.
 *
 * Strategy: stale-while-revalidate for the app shell (HTML / JS / CSS
 * / images). Network-first for everything else (RPC, subgraph,
 * /quote/* worker — these MUST be live or fail loudly; never serve a
 * cached blockchain RPC response).
 *
 * Why minimal: full Workbox is overkill for a dApp where most user
 * interactions hit RPC nodes that change every block. We only need:
 *   1. App shell stays installable (manifest + cached HTML + JS) so
 *      the home-screen icon launches a real Vaipakam standalone view.
 *   2. Logo + icon assets cached for instant render.
 *   3. Everything dynamic (chain calls, quote API, subgraph) is
 *      uncached — always fresh.
 *
 * If you change the shell version constant below, every client gets a
 * fresh cache on next load (old cache is purged in `activate`).
 */

const SHELL_CACHE = 'vaipakam-shell-v1';

// Files that get cached on install — only the static shell. Anything
// dynamic (HTML / JS bundles) is fetched on demand and stored in the
// runtime cache below.
const PRECACHE = [
  '/',
  '/manifest.json',
  '/logo-dark.png',
  '/logo-light.png',
  '/logo-stacked-dark.png',
  '/logo-stacked-light.png',
  '/icon-dark.png',
  '/icon-light.png',
  '/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // PRECACHE entries are best-effort — a failed icon shouldn't
      // block install. addAll throws on any 4xx; addAll is fine here
      // because every entry in PRECACHE is a known static file.
      cache.addAll(PRECACHE).catch(() => undefined),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Only handle same-origin requests. Cross-origin (RPC, subgraph,
  // Cloudflare worker, gtag, fonts) bypasses the SW entirely — those
  // need to stay live and the browser handles them directly.
  if (url.origin !== self.location.origin) return;

  // Skip caching for any explicit "no-cache" request and for the
  // Vite dev server's HMR endpoints.
  if (
    url.pathname.startsWith('/@vite') ||
    url.pathname.startsWith('/__vite_ping') ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  // Stale-while-revalidate: respond from cache immediately if we have
  // it, then refresh the cache in the background. Falls back to
  // network on first request.
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const networkPromise = fetch(req)
        .then((res) => {
          // Only cache successful, basic-typed responses; opaque
          // (CORS-without-credentials) responses don't have a body
          // length we can rely on.
          if (res && res.status === 200 && res.type === 'basic') {
            cache.put(req, res.clone()).catch(() => undefined);
          }
          return res;
        })
        .catch(() => cached); // network failure → fall back to cache
      return cached || networkPromise;
    }),
  );
});
