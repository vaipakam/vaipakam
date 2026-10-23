/**
 * The connected app's service worker (#2687).
 *
 * The `serviceWorker` plugin in `vite.config.ts` builds this into
 * `dist/sw.js` as a classic script, so every browser that supports service
 * workers can run it. The plugin sets `__SHELL_VERSION__` to the build it
 * belongs to. Only production builds register it
 * (`src/lib/registerServiceWorker.ts`).
 *
 * What it does, and all it does (the policy is `src/lib/swPolicy.ts`):
 *  - A static build file is answered from this build's cache when present
 *    and refreshed from the network either way (stale-while-revalidate).
 *  - Nothing else is intercepted:
 *    - page loads, which therefore always come from the network, so a
 *      deploy replaces the shell on the next load;
 *    - chain reads, the indexer, the agent, quotes and transaction
 *      previews, none of which is ever cached.
 *  - A new build takes over at once and deletes earlier builds' caches.
 */
import { mayStore, shellCacheName, staleShellCaches, swRoute } from '../src/lib/swPolicy';

declare const self: ServiceWorkerGlobalScope;
declare const __SHELL_VERSION__: string;

const CACHE = shellCacheName(__SHELL_VERSION__);

self.addEventListener('install', () => {
  // Nothing is fetched ahead of time: shell files are cached as they are
  // used. An earlier build's worker has nothing this one needs, so take
  // over now rather than wait for every tab to close.
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(staleShellCaches(names, __SHELL_VERSION__).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  if (swRoute(event.request, self.location.origin) === 'shell-asset') {
    event.respondWith(assetFromCacheThenRefresh(event));
  }
  // Anything else: no respondWith, so the browser fetches it as if no
  // worker existed.
});

async function assetFromCacheThenRefresh(event: FetchEvent): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  const refreshed = fetch(event.request).then(async (res) => {
    if (mayStore({ ok: res.ok, type: res.type, contentType: res.headers.get('content-type') })) {
      await cache.put(event.request, res.clone()).catch(() => undefined);
    }
    return res;
  });
  if (cached) {
    event.waitUntil(refreshed.then(() => undefined, () => undefined));
    return cached;
  }
  return refreshed;
}
