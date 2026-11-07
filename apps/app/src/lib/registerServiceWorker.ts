/**
 * #2687 — registers the app's service worker (`sw/sw.ts`, built to
 * `/sw.js`) in production builds only, as the website spec requires.
 *
 * The build decides through `VITE_SERVICE_WORKER`, which `vite.config.ts`
 * sets on every build: `on` for a deployable build, `off` for the e2e
 * build, whose request stubbing a worker would sit in front of. It is
 * never read from an operator's env file.
 *
 * #3236 — a production build also removes every service-worker registration
 * on this origin that is not the app's own `/sw.js`. A worker stays
 * registered after the page that installed it is gone, so a bad build that
 * shipped one (or a script injected into a page) could otherwise go on
 * answering requests after the genuine build is back. The check runs on
 * every load of the genuine app, before it registers its own worker, and it
 * runs even when this build does not register a worker. Its limit is stated
 * in the incident runbook (section 9): it only runs when the genuine page
 * loads, so a foreign worker that intercepts page loads is removed by the
 * host's emergency `Clear-Site-Data` response instead.
 *
 * Fails safely: a browser without service workers, or a registration that
 * fails, leaves the app working exactly as it does without one.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;
  const origin = window.location.origin;
  window.addEventListener('load', () => {
    void removeForeignRegistrations(container, origin)
      .catch((err: unknown) => {
        console.warn('[sw] could not check for foreign service workers', err);
      })
      .then(() => {
        if (import.meta.env.VITE_SERVICE_WORKER !== 'on') return;
        return container.register(OWN_SCRIPT_PATH, { scope: '/' }).then(() => undefined);
      })
      .catch((err: unknown) => {
        console.warn('[sw] registration failed; the app works without it', err);
      });
  });
}

/** The one service-worker script the app ever registers. */
export const OWN_SCRIPT_PATH = '/sw.js';

/** The parts of a `ServiceWorkerRegistration` the check reads. */
export interface RegistrationFacts {
  installing: { scriptURL: string } | null;
  waiting: { scriptURL: string } | null;
  active: { scriptURL: string } | null;
  unregister(): Promise<boolean>;
}

/**
 * Whether a registration belongs to the app: every worker it holds
 * (installing, waiting, active) runs exactly `<origin>/sw.js`. A
 * registration holding no worker at all runs nothing and is left alone.
 */
export function isOwnRegistration(reg: Pick<RegistrationFacts, 'installing' | 'waiting' | 'active'>, origin: string): boolean {
  const own = `${origin}${OWN_SCRIPT_PATH}`;
  return [reg.installing, reg.waiting, reg.active].every((w) => w === null || w.scriptURL === own);
}

/**
 * Unregisters every registration on this origin that is not the app's own,
 * and returns how many it removed. One registration that refuses to go does
 * not stop the others from being removed.
 */
export async function removeForeignRegistrations(container: { getRegistrations(): Promise<ReadonlyArray<RegistrationFacts>> }, origin: string): Promise<number> {
  const regs = await container.getRegistrations();
  const foreign = regs.filter((r) => !isOwnRegistration(r, origin));
  const results = await Promise.allSettled(foreign.map((r) => r.unregister()));
  const removed = results.filter((r) => r.status === 'fulfilled' && r.value).length;
  if (foreign.length > 0) {
    console.warn(`[sw] removed ${removed} of ${foreign.length} service worker(s) this app did not install`);
  }
  return removed;
}
