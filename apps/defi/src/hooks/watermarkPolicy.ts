import type { UseLiveWatermarkOptions } from './useLiveWatermark';

/**
 * Watermark cadence policy tier.
 *
 *   - **hot** — live market surfaces (OfferBook). 5 s probe, 30 s on
 *     idle, pause after 15 min walked-away.
 *   - **warm** — personal-position surfaces (Dashboard, VaultAssets,
 *     OfferDetails, Activity). 20 s probe, 60 s on idle, pause after
 *     15 min walked-away. Slower than hot because the relevant state
 *     mostly changes via the user's own actions (already captured by
 *     post-tx receipt callbacks); the watermark only catches
 *     other-user actions on positions the wallet holds.
 *   - **cool** — aggregate metric surfaces (Analytics). 180 s probe,
 *     600 s on idle, pause after 15 min walked-away. Stats are
 *     slow-moving aggregates over thousands of loans — sub-minute
 *     refresh would be theatre.
 *
 * The pause semantics are uniform across tiers: 15 min walked-away
 * (no mouse / keyboard / scroll / touch) drops the probe entirely
 * until the user comes back. Plus visibility-pause is unconditional
 * — every tier stops the timer when the tab is hidden, regardless of
 * activity state.
 */
export type WatermarkTier = 'hot' | 'warm' | 'cool';

const FIVE_MIN = 5 * 60_000;
const FIFTEEN_MIN = 15 * 60_000;

const POLICIES: Record<WatermarkTier, UseLiveWatermarkOptions> = {
  hot: {
    pollIntervalMs: 5_000,
    idlePollIntervalMs: 30_000,
    idleAfterMs: FIVE_MIN,
    pausedAfterMs: FIFTEEN_MIN,
  },
  warm: {
    // 30 s active cadence (was 20 s) — aligned with `useOfferStats` periodic
    // refetch for a uniform "warm tier refreshes every 30 s" heartbeat
    // across the badge, drawer panel, and the row hooks (useMyOffers,
    // useIndexedLoans, useIndexedActivity, etc.).
    pollIntervalMs: 30_000,
    idlePollIntervalMs: 60_000,
    idleAfterMs: FIVE_MIN,
    pausedAfterMs: FIFTEEN_MIN,
  },
  cool: {
    pollIntervalMs: 180_000,
    idlePollIntervalMs: 600_000,
    idleAfterMs: FIVE_MIN,
    pausedAfterMs: FIFTEEN_MIN,
  },
};

/**
 * Returns the `useLiveWatermark` options bundle for a given tier.
 * Centralised so cadence tuning happens in one place — call sites
 * don't carry magic numbers.
 */
export function watermarkPolicy(tier: WatermarkTier): UseLiveWatermarkOptions {
  return POLICIES[tier];
}

/**
 * #843 delta 1 — push-backed cadence floor.
 *
 * When the realtime push transport is HEALTHY (`live`), the background
 * watermark poll is no longer the primary freshness mechanism — the WS
 * invalidation frames nudge a refetch within seconds of any state change. The
 * poll becomes a BACKSTOP for a (rare) missed push, so we relax it to a longer
 * floor. On ANY disconnect / polling fallback the floor is dropped and the
 * tier cadence resumes immediately (the watermark provider reschedules on the
 * `setPushHealthy` toggle).
 *
 * 60 s catches a dropped push within a minute while cutting the hot-tier 5 s
 * heartbeat 12× and the warm 30 s 2×; the cool 180 s tier is already slower, so
 * the floor is a no-op there. This is the main RPC/Worker-load win from #757's
 * push investment — v1 deliberately left polling at full cadence.
 */
export const PUSH_BACKED_MIN_INTERVAL_MS = 60_000;

/**
 * Apply the push-backed floor to a chosen poll interval.
 *
 *   - `tierInterval === null` (no subscriber demand / all paused) → `null`.
 *     Push being healthy NEVER creates poll demand.
 *   - push unhealthy → the tier interval, unchanged (today's cadence restored).
 *   - push healthy → `max(tierInterval, PUSH_BACKED_MIN_INTERVAL_MS)` — never
 *     faster than the tier asked for, only relaxed.
 *
 * Pure + exported so the cadence-switching behaviour is unit-testable without
 * standing up the whole watermark provider + WebSocket.
 */
export function pushBackedInterval(
  tierInterval: number | null,
  pushHealthy: boolean,
): number | null {
  if (tierInterval === null) return null;
  return pushHealthy
    ? Math.max(tierInterval, PUSH_BACKED_MIN_INTERVAL_MS)
    : tierInterval;
}
