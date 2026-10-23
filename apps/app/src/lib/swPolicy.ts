/**
 * #2687 — what the connected app's service worker may answer from its own
 * cache, and what it must leave to the network untouched.
 *
 * The rule is the website spec's ("PWA requirements"): cache only the static
 * app shell, let a deploy replace the shell on the next load, and never
 * cache dynamic data. Here that is an allowlist rather than a list of things
 * to avoid. Anything this function does not name as a shell file goes to the
 * network exactly as if there were no service worker. That includes:
 *  - every cross-origin request (chain RPC, the indexer, the agent, quote
 *    and wallet services);
 *  - every same-origin path that is not a build file;
 *  - every page load.
 *
 * Page loads are never answered from a cache, not even when the network
 * fails. The page decides which scripts run, and a stored page would run
 * the build that was current when it was stored, with that build's contract
 * addresses and interfaces, at a time when the app has no way to know it is
 * old. That is the stale client the host's no-cache rule on the page exists
 * to prevent, so the worker does not reintroduce it as an offline fallback.
 *
 * Pure so it can be tested without a browser. `sw/sw.ts` is the only caller
 * at runtime; `src/lib/swPolicy.test.ts` pins the classification.
 */

/** How the service worker handles one request. */
export type SwRoute =
  /** A static build file: served from cache, then refreshed from the network. */
  | 'shell-asset'
  /** Not the service worker's business: the browser fetches it as usual. */
  | 'network';

/** The parts of a `Request` the classification reads. */
export interface SwRequestFacts {
  url: string;
  method: string;
  mode: string;
}

/** Same-origin static files outside `/assets/` that belong to the shell. */
export const SHELL_FILES: readonly string[] = [
  '/logo.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

/** Cache names carry this prefix and the build they belong to. */
export const SHELL_CACHE_PREFIX = 'vaipakam-shell-';

export function shellCacheName(version: string): string {
  return `${SHELL_CACHE_PREFIX}${version}`;
}

/** Caches a new build may delete: earlier builds' shells, and nothing else
 *  (a cache another script on this origin made is not ours to remove). */
export function staleShellCaches(names: readonly string[], version: string): string[] {
  const current = shellCacheName(version);
  return names.filter((n) => n.startsWith(SHELL_CACHE_PREFIX) && n !== current);
}

/**
 * Classify one request. `origin` is the service worker's own origin.
 */
export function swRoute(req: SwRequestFacts, origin: string): SwRoute {
  if (req.method !== 'GET') return 'network';
  // A page load, of any path. See the header: never from a cache.
  if (req.mode === 'navigate') return 'network';
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return 'network';
  }
  if (url.origin !== origin) return 'network';
  // Build files are requested without a query string. One that carries
  // one is not the file the build wrote, so it is not cached.
  if (url.search !== '') return 'network';
  if (url.pathname.startsWith('/assets/') || SHELL_FILES.includes(url.pathname)) {
    return 'shell-asset';
  }
  return 'network';
}

/** The response facts the store decision reads. */
export interface SwResponseFacts {
  ok: boolean;
  type: string;
  contentType: string | null;
}

/**
 * Whether a network response may be stored as a shell file.
 *
 * Only a successful same-origin response that is not HTML. The host answers
 * a request for a missing file with the app's page (its single-page
 * fallback), so an HTML answer to a file request is that fallback, and
 * storing it under a script's address would serve a page where code was
 * expected, and would store a page, which the header rules out.
 */
export function mayStore(res: SwResponseFacts): boolean {
  if (!res.ok || res.type !== 'basic') return false;
  return !(res.contentType ?? '').toLowerCase().startsWith('text/html');
}
