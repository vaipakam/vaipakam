/**
 * ACC-11 — every load of a production build removes any service worker on
 * this origin that is not this app's own `/sw.js`, before it registers its
 * own. A worker stays registered after the page that installed it is gone,
 * so one left by a bad build or an injected script (possibly under a narrower
 * scope such as `/settings/`) would otherwise go on answering requests once
 * the genuine app is back. One registration that will not go does not stop
 * the others from being removed.
 *
 * Its limit: it runs only when the genuine page loads, so a foreign worker
 * that answers page loads itself is removed by the host's emergency response
 * instead (the incident runbook says how).
 */

/** The one worker script this app ever registers. */
export const OWN_WORKER_PATH = '/sw.js';

/** The parts of a registration the check reads. */
export interface WorkerRegistrationFacts {
  installing: { scriptURL: string } | null;
  waiting: { scriptURL: string } | null;
  active: { scriptURL: string } | null;
  unregister(): Promise<boolean>;
}

/** A registration is the app's own when every worker it holds runs exactly
 *  `<origin>/sw.js`; one holding no worker runs nothing and is left alone. */
export function isOwnRegistration(reg: Pick<WorkerRegistrationFacts, 'installing' | 'waiting' | 'active'>, origin: string): boolean {
  const own = `${origin}${OWN_WORKER_PATH}`;
  return [reg.installing, reg.waiting, reg.active].every((w) => w === null || w.scriptURL === own);
}

/** Unregisters every foreign registration and says how many went and how many were found. */
export async function removeForeignWorkers(
  container: { getRegistrations(): Promise<ReadonlyArray<WorkerRegistrationFacts>> },
  origin: string,
): Promise<{ found: number; removed: number }> {
  const foreign = (await container.getRegistrations()).filter((r) => !isOwnRegistration(r, origin));
  const results = await Promise.allSettled(foreign.map((r) => r.unregister()));
  return { found: foreign.length, removed: results.filter((r) => r.status === 'fulfilled' && r.value).length };
}
