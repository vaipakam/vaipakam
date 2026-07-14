/**
 * Indexer push-rail health — the signal that lets polling stand down
 * (RPC read-diet PR A; docs/DesignsAndPlans/Alpha02RpcReadDietDesign.md
 * §4.1.1).
 *
 * OWNERSHIP: `IndexerPushSync` is the single writer — it feeds this
 * store from the WS frames the ingest Durable Object sends (`hello`
 * cursor metadata + the per-scan `cursor` heartbeat that PR 0 added).
 * Everything else only READS, via `isRailHealthy()` /
 * `subscribeRailHealth()` / the `signalAware()` interval helper.
 *
 * "Healthy" means ALL of:
 *   - the push socket is OPEN and the DO said ingest is active;
 *   - the server reported its expected scan cadence (unknown cadence ⇒
 *     NOT healthy — the fail-safe the design review demanded: an older
 *     worker without the metadata keeps today's polling posture, the
 *     client never guesses);
 *   - the ingest cursor ADVANCED within a cadence-derived window
 *     (cadence × STALE_FACTOR). Two stall shapes are covered without
 *     trusting cross-machine clocks: heartbeats STOPPING (socket alive
 *     but scans dead) age out `lastSignalAtMs`; heartbeats CONTINUING
 *     with a frozen persisted `updatedAt` (wedged RPC safe head — the
 *     DO deliberately reports the persisted cursor row, PR 0) age out
 *     `lastAdvanceAtMs`, because we only stamp it when `updatedAt`
 *     MOVES. Both timestamps are client-clock, so server/client skew
 *     never enters the comparison.
 *
 * `VITE_FRESHNESS_TIMERS=legacy` pins the store unhealthy forever —
 * the escape hatch that makes PR A byte-for-byte revertible to the
 * timer behaviour without a redeploy of the worker side.
 */

import { isIdle } from '../lib/idle';

/** Stale after cadence × this. 1.5 tolerates one hiccuped scan without
 *  flapping; two missed scans in a row demote to polling. */
const STALE_FACTOR = 1.5;

/** Interval refetch when the rail is healthy: the 180s safety net the
 *  design sets — push carries freshness, this only catches a silently
 *  lost frame. */
export const NET_REFRESH_MS = 180_000;

/** Re-evaluation tick. Health can only DEGRADE between frames (frames
 *  themselves refresh it), so a coarse tick is enough — it exists so a
 *  gone-quiet rail is noticed without waiting for a React render. */
const EVAL_TICK_MS = 15_000;

interface RailState {
  socketLive: boolean;
  /** Server-reported expected scan cadence (sec); null = unknown. */
  cadenceSec: number | null;
  /** Last persisted-cursor `updated_at` we saw (server seconds). Only
   *  used to detect ADVANCEMENT, never compared to a client clock. */
  lastCursorUpdatedAt: number | null;
  /** Client-clock stamp of the last frame carrying cursor metadata. */
  lastSignalAtMs: number;
  /** Client-clock stamp of the last time `lastCursorUpdatedAt` MOVED. */
  lastAdvanceAtMs: number;
}

const legacyPinned =
  (import.meta.env?.VITE_FRESHNESS_TIMERS as string | undefined) === 'legacy';

let state: RailState = {
  socketLive: false,
  cadenceSec: null,
  lastCursorUpdatedAt: null,
  lastSignalAtMs: 0,
  lastAdvanceAtMs: 0,
};

let lastComputed = false;
const listeners = new Set<() => void>();

function compute(): boolean {
  if (legacyPinned) return false;
  if (!state.socketLive) return false;
  if (state.cadenceSec == null || state.cadenceSec <= 0) return false;
  const windowMs = state.cadenceSec * 1000 * STALE_FACTOR;
  const now = Date.now();
  return (
    now - state.lastSignalAtMs < windowMs &&
    now - state.lastAdvanceAtMs < windowMs
  );
}

function recompute(): void {
  const next = compute();
  if (next !== lastComputed) {
    lastComputed = next;
    for (const l of listeners) l();
  }
}

// Health can silently degrade between frames — tick it. (Module-level
// like idle.ts's listeners; one interval per tab is the point.)
if (typeof window !== 'undefined' && !legacyPinned) {
  setInterval(recompute, EVAL_TICK_MS);
}

/** True while the push rail is verifiably delivering (see header). */
export function isRailHealthy(): boolean {
  // Recompute inline so reads between ticks never act on a stale
  // verdict (the tick only exists to NOTIFY subscribers of decay).
  lastComputed = compute();
  return lastComputed;
}

/** Subscribe to health transitions (for `useSyncExternalStore`). */
export function subscribeRailHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Writer: a frame carrying cursor metadata arrived (hello or the
 *  per-scan heartbeat). `updatedAt` is the PERSISTED cursor stamp the
 *  DO reports — advancement is judged by it moving, not by comparing
 *  it to this machine's clock. */
export function railCursorSignal(
  updatedAt: number | null,
  cadenceSec: number | null,
): void {
  const now = Date.now();
  state.lastSignalAtMs = now;
  if (cadenceSec != null) state.cadenceSec = cadenceSec;
  if (updatedAt != null && updatedAt !== state.lastCursorUpdatedAt) {
    state.lastCursorUpdatedAt = updatedAt;
    state.lastAdvanceAtMs = now;
  }
  recompute();
}

/** Writer: socket lifecycle. Opening seeds nothing (health waits for
 *  the first cursor-bearing frame); closing demotes immediately. */
export function railSocketLive(live: boolean): void {
  state.socketLive = live;
  if (!live) {
    // Next connect must re-prove freshness — a reconnect after a long
    // gap can't inherit the old advance stamps.
    state.lastSignalAtMs = 0;
    state.lastAdvanceAtMs = 0;
    state.lastCursorUpdatedAt = null;
  }
  recompute();
}

/** Drop-in for a constant `refetchInterval` on INDEXER-PUSH-COVERED
 *  roots: 180s net while the rail is verifiably delivering, otherwise
 *  exactly the idle-aware base cadence the app has today. TanStack
 *  re-evaluates after every fetch, so a rail transition takes effect
 *  within one tick; the explicit focus refetch (IndexerPushSync) and
 *  the push frames themselves carry the between-ticks freshness. */
export function signalAware(baseMs: number): () => number {
  const idleFactor = 4; // mirror idle.ts IDLE_FACTOR for the fallback leg
  return () => {
    if (isRailHealthy()) return NET_REFRESH_MS;
    return isIdle() ? baseMs * idleFactor : baseMs;
  };
}

/** Drop-in for a constant `refetchInterval` on ACTION-GATING chain
 *  roots (the §4.1.2 tip subset: detail-page cluster, pending-card
 *  gates, crossable band). These stretch to the net ONLY when BOTH
 *  freshness rails cover them: the indexer push rail is healthy AND
 *  the chain has a WebSocket RPC (`wsAvailable`) so LiveChainSync's
 *  per-block tip nudge actually fires — on an HTTP-only chain deploy
 *  there is no tip nudge, and a 180s interval would leave an
 *  action-decisive gate stale for minutes (§4.1.1: "HTTP-only deploy
 *  ⇒ intervals restore to today's 30s"). */
export function tipAware(baseMs: number, wsAvailable: boolean): () => number {
  const idleFactor = 4;
  return () => {
    if (wsAvailable && isRailHealthy()) return NET_REFRESH_MS;
    return isIdle() ? baseMs * idleFactor : baseMs;
  };
}

/** TEST-ONLY: reset the store between unit tests. */
export function _railResetForTests(): void {
  state = {
    socketLive: false,
    cadenceSec: null,
    lastCursorUpdatedAt: null,
    lastSignalAtMs: 0,
    lastAdvanceAtMs: 0,
  };
  lastComputed = false;
}
