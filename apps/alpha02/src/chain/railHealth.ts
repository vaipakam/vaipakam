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
  // Full recompute — INCLUDING the listener notify — so a reader being
  // the first to observe decay still triggers the healthy-to-down
  // catch-up subscription (Codex #1228 r2 P1: assigning lastComputed
  // without notifying swallowed the transition, and the next 15s tick
  // then saw no change).
  recompute();
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
 *  it to this machine's clock. A frame WITHOUT a cadence clears any
 *  previously learned one (Codex #1228 r1): after a partial worker
 *  rollback the CURRENT server didn't report a cadence, and keeping
 *  the old value would let an advancing cursor read healthy right past
 *  the documented unknown-metadata fail-safe. */
export function railCursorSignal(
  updatedAt: number | null,
  cadenceSec: number | null,
): void {
  const now = Date.now();
  state.lastSignalAtMs = now;
  state.cadenceSec = cadenceSec;
  if (updatedAt != null) {
    if (state.lastCursorUpdatedAt === null) {
      // FIRST observation is a BASELINE, never an advance (Codex #1228
      // r4): a tab opening against an already-stuck cursor would
      // otherwise read healthy for one full window and stand the
      // pollers down on unproven freshness. Health now requires a
      // second, LATER distinct value — at most one cadence away on a
      // genuinely live rail.
      state.lastCursorUpdatedAt = updatedAt;
    } else if (updatedAt !== state.lastCursorUpdatedAt) {
      state.lastCursorUpdatedAt = updatedAt;
      state.lastAdvanceAtMs = now;
    }
  }
  recompute();
}

/** Client-clock stamp of the last block the chain watcher delivered.
 *  Module-scope beside the rail state: LiveChainSync writes it per
 *  block, `tipAware` reads it. */
let lastBlockAtMs = 0;

/** How stale the block watch may go before tip roots stop trusting
 *  it. Base/OP mine ~2s blocks; 60s tolerates a deep hiccup while
 *  still catching a genuinely dead subscription well before the
 *  180s net could hide it. */
const TIP_BLOCK_STALE_MS = 60_000;

/** Writer: LiveChainSync saw a block on the WS subscription. This is
 *  what lets `tipAware` trust the tip rail as DELIVERING rather than
 *  merely configured (Codex #1228 r1: a broken WS endpoint with a
 *  healthy indexer rail must not leave action gates on the 180s net
 *  with no per-block nudge behind them). */
export function railBlockSignal(): void {
  lastBlockAtMs = Date.now();
}

/** Writer: the block watcher stopped or changed target (hidden tab,
 *  chain switch, unmount). The delivery stamp must not carry over —
 *  a stale stamp would let tipAware trust a NEW subscription that has
 *  not delivered anything yet (Codex #1228 r2). */
export function railBlockWatchReset(): void {
  lastBlockAtMs = 0;
}

/** True while the block watcher delivered within the trust window —
 *  the same predicate tipAware uses, exported for LiveChainSync's
 *  stall watchdog (Codex #1228 r5). `everDelivered` distinguishes a
 *  live-then-stalled subscription (watchdog fires a catch-up) from
 *  one that never delivered (tipAware never stretched, nothing to
 *  catch up). */
export function blockDeliveryFresh(): boolean {
  return Date.now() - lastBlockAtMs < TIP_BLOCK_STALE_MS;
}
export function blockEverDelivered(): boolean {
  return lastBlockAtMs > 0;
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
    // All three must hold: the indexer rail is healthy, the chain WS
    // is configured, AND the block watcher actually DELIVERED a block
    // recently — a configured-but-broken WS endpoint otherwise leaves
    // action gates on the net with no per-block nudge behind them
    // (Codex #1228 r1). A hidden tab stops the watcher; on return the
    // first block (~2s) re-qualifies the stretch, and until then the
    // base cadence is the honest posture.
    if (
      wsAvailable &&
      isRailHealthy() &&
      Date.now() - lastBlockAtMs < TIP_BLOCK_STALE_MS
    ) {
      return NET_REFRESH_MS;
    }
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
  lastBlockAtMs = 0;
}
