/**
 * How a pass spends one run's window (#2572 r5).
 *
 * A run's deadline ({@link PassTick.deadlineMs}) bounds every send, so whatever
 * a run has not reached by then waits for the next run. Three rules keep that
 * from starving any work, and every pass that loops under the deadline follows
 * them:
 *
 *   1. Chains run side by side. One deadline covers the whole pass, so chains
 *      run in series would let a slow early chain spend the window of every
 *      chain after it, run after run.
 *   2. A list walked in a fixed order starts at a point that moves each run
 *      ({@link rotated}). Otherwise the deadline cuts the same tail off every
 *      run, and that tail is never reached.
 *   3. A pass that reads before it sends stops reading early enough to leave
 *      its sends time ({@link readCutoffMs}). Otherwise a slow read phase uses
 *      the whole window, every send is refused, and the next run repeats it.
 *
 * Leaf module: no keeper imports, so any pass (and the schedule) can use it.
 */
import type { PassTick } from './passSchedule';

/** What a run leaves for its own wrap-up (logging, alert de-dup writes). */
export const RUN_DEADLINE_MARGIN_MS = 30_000;

/** How much of a run's window a read phase leaves for the sends it feeds. */
export const SEND_RESERVE_MS = 10_000;

/** When a read phase that feeds sends must stop: the run's deadline less the
 *  send reserve. Pure. */
export function readCutoffMs(deadlineMs: number): number {
  return deadlineMs - SEND_RESERVE_MS;
}

/** Which run of a pass this is, counting `stepMs` steps from the tick's
 *  SCHEDULED time, so a late delivery does not repeat the previous run's
 *  starting point. Only an invocation that is not a cron tick reads the clock.
 *  `stepMs` is the pass's cadence. */
export function runIndex(tick: PassTick, stepMs: number, nowMs: number = Date.now()): number {
  return Math.floor((tick.scheduledTimeMs ?? nowMs) / stepMs);
}

/** `items` starting at position `index` (mod its length), wrapping round, so
 *  successive runs start successive items at the head. Pure; an empty list
 *  stays empty. */
export function rotated<T>(items: readonly T[], index: number): T[] {
  const n = items.length;
  if (n === 0) return [];
  const start = ((index % n) + n) % n;
  return [...items.slice(start), ...items.slice(0, start)];
}
