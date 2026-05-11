/**
 * Live-tail watermark hook — thin subscriber over the singleton-backed
 * `WatermarkProvider` (in `context/WatermarkContext.tsx`).
 *
 * The provider runs ONE probe loop per `(chainId, diamondAddress)`. This
 * hook registers as a subscriber and reads the shared
 * `{version, snapshot, status}`. No per-instance timer, no fan-out of
 * `eth_call` + `getBlock({safe})` traffic when N callers mount on the
 * same page.
 *
 * The cadence the subscriber asks for influences the provider's NEXT
 * scheduled tick: the provider takes the min of all active subscribers'
 * intervals. A subscriber that asks for slower cadence than another
 * mounted subscriber gets more probes than it specified — which is
 * harmless: re-renders are still gated by `version` advances, which
 * only happen when the on-chain counters move.
 *
 * `version` semantics (preserved from the pre-singleton hook):
 *   - bumps every time `nextOfferId` or `nextLoanId` advances
 *   - subscribers list it in their useEffect deps to drive refetch
 *
 * Activity / visibility logic now lives globally in the provider — see
 * `WatermarkContext.tsx` for the gating rules.
 */
import { useEffect } from 'react';
import { useWatermarkContext } from '../context/WatermarkContext';
import {
  TICK_MS,
  type UseLiveWatermarkOptions,
  type UseLiveWatermarkResult,
  type WatermarkSnapshot,
  type WatermarkStatus,
} from './watermarkInternals';

// Re-export the types so existing imports from this module keep working
// (watermarkPolicy.ts imports `UseLiveWatermarkOptions` from here).
export type {
  UseLiveWatermarkOptions,
  UseLiveWatermarkResult,
  WatermarkSnapshot,
  WatermarkStatus,
};

export function useLiveWatermark(
  options: UseLiveWatermarkOptions = {},
): UseLiveWatermarkResult {
  const { register, unregister, version, snapshot, status } = useWatermarkContext();
  const {
    pollIntervalMs = TICK_MS,
    idlePollIntervalMs = null,
    idleAfterMs = null,
    pausedAfterMs = null,
  } = options;

  useEffect(() => {
    const id = register({
      pollIntervalMs,
      idlePollIntervalMs,
      idleAfterMs,
      pausedAfterMs,
    });
    return () => unregister(id);
  }, [register, unregister, pollIntervalMs, idlePollIntervalMs, idleAfterMs, pausedAfterMs]);

  return { version, snapshot, status };
}
