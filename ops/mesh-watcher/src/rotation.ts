/**
 * Which chain a tick observes.
 *
 * A tick that read every chain at once did not fit one Worker invocation:
 * at three chains the RPC fan-out passed the 50-subrequest cap of Workers
 * Free, so the last chain's reads and every Telegram send were refused.
 * Every check this Worker runs compares Base's row FOR one chain with THAT
 * chain's own books (see `invariants.ts`: each finding carries one chain
 * id, and no check sums across chains). So the mesh can be observed one
 * chain per tick without losing a check, as long as each tick reads Base
 * and the one chain together, from the same moment.
 *
 * The rotation order is the canonical chain first, then the expected
 * source set in ascending chain id. It is derived from
 * `getExpectedSourceChainIds()` on every tick, never configured, so a
 * newly wired mirror joins the rotation without a redeploy.
 *
 * CADENCE. Each chain is observed once per `order.length × step` seconds.
 * At three chains and a 300 s step that is 900 s, the same 15 minutes the
 * single-tick Worker used, so the tick-counted windows
 * (`STUCK_WINDOW_TICKS`, `REPORT_LAG_WINDOW_TICKS`) keep their meaning.
 * Those windows count OBSERVATIONS OF ONE CHAIN. Wiring a fourth chain
 * stretches each chain's cycle to 20 minutes, which lengthens both
 * windows. That is the safe direction (later, never spurious), but it is
 * a retune point, stated in the README.
 */

/** How a tick picks its chain. */
export type TickScope =
  /** Cron: the slot index derived from the scheduled time. */
  | { kind: 'slot'; index: number }
  /** Manual `POST /run?chain=<id>`: one named chain. */
  | { kind: 'chain'; chainId: number };

/** Canonical first, then every other expected chain in ascending order. */
export function rotationOrder(
  canonicalChainId: number,
  expected: readonly number[],
): number[] {
  const rest = [...new Set(expected.map(Number))]
    .filter((id) => id !== canonicalChainId)
    .sort((a, b) => a - b);
  return [canonicalChainId, ...rest];
}

/**
 * The chain this tick observes, or `null` when a manually named chain is
 * not in the mesh (the caller reports that as a configuration gap rather
 * than observing nothing silently).
 */
export function pickChain(order: readonly number[], scope: TickScope): number | null {
  if (scope.kind === 'chain') return order.includes(scope.chainId) ? scope.chainId : null;
  if (order.length === 0) return null;
  const i = ((scope.index % order.length) + order.length) % order.length;
  return order[i]!;
}

/**
 * The slot for a scheduled time. Derived from the clock rather than kept
 * as a counter, so a missed or doubled invocation cannot shift the
 * rotation and no state has to survive between ticks.
 */
export function slotIndex(scheduledTimeMs: number, stepSeconds: number): number {
  return Math.floor(scheduledTimeMs / 1000 / stepSeconds);
}

/**
 * The chain ids whose stored alert records this tick may prune.
 *
 * `retainAlerts` forgets an alert that is no longer firing, so a
 * recurrence pages at once instead of waiting out the repeat window. A
 * tick that observed one chain only knows which of THAT chain's alerts
 * cleared. Pruning every other chain's records would make each of them
 * look new on its own next tick and re-send it every cycle. So a tick owns
 * its observed chain plus chain 0, the id watcher-level findings use.
 */
export function ownedAlertChainIds(observedChainId: number | null): number[] {
  return observedChainId === null ? [0] : [observedChainId, 0];
}

/** The chain id a finding key carries (`<code>/<variant>:<chainId>`). */
export function alertKeyChainId(key: string): number | null {
  const tail = key.slice(key.lastIndexOf(':') + 1);
  const id = Number(tail);
  return tail.length > 0 && Number.isInteger(id) ? id : null;
}
