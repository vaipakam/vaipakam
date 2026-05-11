/**
 * Vaipakam — PWA service worker.
 *
 * Caching strategy, by request kind:
 *
 *   1. **Navigations / HTML (`/`, `/index.html`, any `Accept: text/html`)
 *      — NETWORK-FIRST.** The HTML is the *mutable* document: every
 *      deploy rewrites it to reference new content-hashed JS/CSS
 *      bundles (`index-<hash>.js`). Serving a stale HTML pins the
 *      browser to an old bundle — which, for this dApp, can mean
 *      "scanning the chain from genesis, rate-limited, broken"
 *      (the `getLogs 0-9` incident). So always try the network;
 *      fall back to the cached HTML only when offline. A deploy is
 *      then picked up on the very next load, not "eventually".
 *
 *   2. **Hashed build assets (`/assets/...`) — CACHE-FIRST.** These
 *      are immutable: `index-CC6jk9-t.js` never changes content; a
 *      new build emits a new filename. So once cached, serve from
 *      cache forever — no revalidation needed. (Stale-while-revalidate
 *      would also work but adds a pointless background fetch.)
 *
 *   3. **Static shell assets (icons, manifest, logos) —
 *      STALE-WHILE-REVALIDATE.** Rarely change, fine to serve stale
 *      once then refresh.
 *
 *   4. **Everything dynamic (cross-origin RPC, subgraph, Cloudflare
 *      worker APIs, `/api/*`, Vite HMR) — BYPASS.** Never cache a
 *      blockchain RPC response; these must be live or fail loudly.
 *
 * Cache-version constant: bump `CACHE_VERSION` whenever the caching
 * SHAPE changes (not on every deploy — hashed assets self-version).
 * `activate` purges every cache whose name doesn't match, so a bump
 * forces a clean slate on the next SW activation.
 */

const CACHE_VERSION = 'v2';
const HTML_CACHE = `vaipakam-html-${CACHE_VERSION}`;
const ASSET_CACHE = `vaipakam-assets-${CACHE_VERSION}`;
const SHELL_CACHE = `vaipakam-shell-${CACHE_VERSION}`;
const KNOWN_CACHES = new Set([HTML_CACHE, ASSET_CACHE, SHELL_CACHE]);

// Static shell files precached on install — best-effort.
const PRECACHE = [
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
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined)),
  );
  // Take over from any previous SW immediately — combined with
  // `clients.claim()` below and the network-first HTML strategy, a
  // deployed SW change reaches users on their next load, not after a
  // tab close + reopen.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => !KNOWN_CACHES.has(k)).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Does this request want an HTML document? Covers SPA navigations
 *  (`mode === 'navigate'`) and explicit `Accept: text/html` fetches. */
function isHtmlRequest(req, url) {
  if (req.mode === 'navigate') return true;
  if (url.pathname === '/' || url.pathname.endsWith('.html')) return true;
  const accept = req.headers.get('Accept') || '';
  return accept.includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Same-origin only — cross-origin (RPC, subgraph, Cloudflare workers,
  // analytics, fonts) bypasses the SW entirely; the browser handles
  // those and they stay live.
  if (url.origin !== self.location.origin) return;

  // Dev-server + API endpoints: never cache.
  if (
    url.pathname.startsWith('/@vite') ||
    url.pathname.startsWith('/__vite_ping') ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  // ── HTML: network-first ───────────────────────────────────────────
  if (isHtmlRequest(req, url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(HTML_CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
          }
          return res;
        })
        .catch(async () => {
          // Offline — fall back to the last good HTML (this request's
          // path, then `/` as the SPA shell).
          const c = await caches.open(HTML_CACHE);
          return (
            (await c.match(req)) ||
            (await c.match('/')) ||
            new Response('<h1>Offline</h1>', {
              status: 503,
              headers: { 'Content-Type': 'text/html' },
            })
          );
        }),
    );
    return;
  }

  // ── Hashed build assets: cache-first (immutable) ──────────────────
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && res.status === 200 && res.type === 'basic') {
          cache.put(req, res.clone()).catch(() => undefined);
        }
        return res;
      }),
    );
    return;
  }

  // ── Static shell (icons, manifest, logos): stale-while-revalidate ─
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const networkPromise = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            cache.put(req, res.clone()).catch(() => undefined);
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkPromise;
    }),
  );
});
