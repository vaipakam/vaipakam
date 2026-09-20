/**
 * Bound a wait without cancelling the work.
 *
 * Extracted from `dataRights.ts` when a second caller appeared (round 52
 * — the forced-close card's disposition watch). It was already written,
 * already reviewed across several rounds, and already carried the one
 * distinction that makes it correct; copying it would have created a
 * second definition of a timing rule, which is the defect that round
 * raised about the live-driver credential check.
 *
 * NOTHING IS CANCELLED. `promise` keeps running after the reject — there
 * is no cancellation primitive for a bare promise — so a caller that
 * must not let the abandoned work land needs its own fence. That is not
 * a shortcoming to fix here; it is the reason `TimeoutError` is a
 * distinct type.
 */

/**
 * Thrown when the WAIT expired, as opposed to the awaited work rejecting
 * on its own.
 *
 * The distinction is load-bearing (`dataRights` round 11 P2). Late
 * cleanup exists for work that is STILL RUNNING after we stopped waiting
 * for it; a promise that rejected promptly has finished, will write
 * nothing more, and needs no cleanup. Treating the two alike scheduled
 * that cleanup immediately — and since it clears IndexedDB, it raced
 * `eraseMyDataFully`'s own counted clear and could empty the stores
 * first, so the erasure reported zero database records over records it
 * had removed.
 *
 * A caller that only needs "did this finish in time" can ignore the
 * type; a caller with something to unwind must not.
 */
export class TimeoutError extends Error {}

/** Reject after `ms` if `promise` has not settled. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}
