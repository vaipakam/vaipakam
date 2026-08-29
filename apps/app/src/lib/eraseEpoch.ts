/**
 * A counter that increments when the user erases their local data
 * (#1960, review round 2).
 *
 * WHY THIS EXISTS. The data-rights erasure clears browser storage, but
 * the app is full of components that read storage ONCE — on mount, or
 * on an identity change — and hold the value in state afterwards.
 * Clearing the key underneath them changes nothing on screen. The page
 * deliberately does not reload (the reload would throw away the result
 * message, which on that page is the point), so those components have
 * to be told.
 *
 * Review found this twice, in two different components, which is the
 * argument for a shared signal rather than a third bespoke fix: the
 * theme and mode contexts needed a reset, and so did `NotificationBell`,
 * whose last-seen cursor otherwise kept notifications marked read after
 * the record saying so had been erased.
 *
 * A component participates by depending on `useEraseEpoch()` wherever
 * it already re-reads storage — usually an effect keyed on wallet and
 * chain. The epoch simply becomes another reason to re-read, so no new
 * code path is introduced and nothing has to be kept in sync.
 *
 * Deliberately NOT a React context: the components that need it are
 * mounted above the route that triggers it, so a provider would have to
 * wrap the shell for the benefit of one page. A module-level store with
 * `useSyncExternalStore` is the smaller thing, and it is the same shape
 * as the existing claim-verdict epoch.
 */

let epoch = 0;
const listeners = new Set<() => void>();

/** Called by the erasure once local data has been removed. */
export function bumpEraseEpoch(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

export function subscribeEraseEpoch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getEraseEpoch(): number {
  return epoch;
}

/** Test seam — the app never rewinds the epoch. */
export function __resetEraseEpoch(): void {
  epoch = 0;
  listeners.clear();
}
