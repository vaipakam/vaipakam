/**
 * #2687 — registers the app's service worker (`sw/sw.ts`, built to
 * `/sw.js`) in production builds only, as the website spec requires.
 *
 * The build decides through `VITE_SERVICE_WORKER`, which `vite.config.ts`
 * sets on every build: `on` for a deployable build, `off` for the e2e
 * build, whose request stubbing a worker would sit in front of. It is
 * never read from an operator's env file.
 *
 * Fails safely: a browser without service workers, or a registration that
 * fails, leaves the app working exactly as it does without one.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || import.meta.env.VITE_SERVICE_WORKER !== 'on') return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err: unknown) => {
      console.warn('[sw] registration failed; the app works without it', err);
    });
  });
}
