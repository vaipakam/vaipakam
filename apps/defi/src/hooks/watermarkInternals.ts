/**
 * Shared watermark internals.
 *
 * Lives separately from `useLiveWatermark.ts` and `WatermarkContext.tsx`
 * to avoid a circular import: the Context imports the ABI + types, the
 * hook imports the Context. Putting these in a leaf module keeps both
 * sides clean.
 */
import { type Abi } from 'viem';

/** Minimal ABI surface for the watermark probe. The signature must match
 *  the on-chain selector exactly:
 *  `getGlobalCounts() returns (uint256 totalLoansCreated, uint256 totalOffersCreated)`. */
export const WATERMARK_ABI = [
  {
    type: 'function',
    name: 'getGlobalCounts',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'totalLoansCreated', type: 'uint256' },
      { name: 'totalOffersCreated', type: 'uint256' },
    ],
  },
] as const satisfies Abi;

export interface WatermarkSnapshot {
  /** Lifetime offer count — `s.nextOfferId` on-chain. */
  nextOfferId: bigint;
  /** Lifetime loan count — `s.nextLoanId` on-chain. */
  nextLoanId: bigint;
  /** Last `safe`-tag block at which the probe last succeeded. Subscribers
   *  use this as the upper bound of their RPC catch-up windows so the
   *  catch-up doesn't read past the tip and pick up a soon-to-reorg log. */
  safeBlock: bigint;
  /** UNIX seconds — when the probe completed. */
  fetchedAt: number;
}

export type WatermarkStatus = 'idle' | 'live' | 'unreachable';

export interface UseLiveWatermarkResult {
  /** Bumps every time the probe sees either counter advance. Subscribers
   *  list this in their useEffect deps to refetch their data set. Also
   *  bumps once on initial mount so first-paint subscribers fire. */
  version: number;
  /** Latest watermark observation, or `null` while we haven't completed
   *  a successful probe yet. */
  snapshot: WatermarkSnapshot | null;
  /** Probe health. `unreachable` means the diamond / RPC isn't responding
   *  — subscribers should fall back to whatever they did pre-watermark
   *  (e.g. plain indexer poll without RPC catch-up). */
  status: WatermarkStatus;
}

export interface UseLiveWatermarkOptions {
  /**
   * Active-state poll cadence in ms. Pass `null` to disable this
   * subscriber's cadence demand — the provider's shared timer still
   * runs if any OTHER subscriber demands one, and this subscriber
   * still sees `version`/`snapshot` updates.
   *
   * Defaults to 5_000 ms (the OfferBook cadence), so callers that don't
   * pass anything keep the previous behaviour.
   */
  pollIntervalMs?: number | null;
  /**
   * Slower cadence used while the user is "idle" — tab is focused but
   * no mouse / keyboard / scroll / touch input has been observed for
   * `idleAfterMs`. Set to `null` to skip the idle tier.
   */
  idlePollIntervalMs?: number | null;
  /**
   * Inactivity threshold (ms) after which this subscriber drops from
   * `pollIntervalMs` to `idlePollIntervalMs`. Default 5 minutes when
   * `idlePollIntervalMs` is set; `null` disables the activity-aware
   * backoff for this subscriber.
   */
  idleAfterMs?: number | null;
  /**
   * Inactivity threshold (ms) after which this subscriber stops
   * demanding a timer. Catches the tab-focused-but-user-walked-away
   * case so an OfferBook left open for hours doesn't keep probing.
   * `null` disables the pause for this subscriber (visibility-pause
   * still applies globally).
   */
  pausedAfterMs?: number | null;
}

/** Default active-state poll interval — the OfferBook (hot tier) cadence. */
export const TICK_MS = 5_000;
