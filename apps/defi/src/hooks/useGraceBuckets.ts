/**
 * T-044 — admin-console reader for the loan-default grace schedule.
 *
 * Reads the current 6-slot grace table AND the per-slot policy bounds
 * in one parallel pair of calls. The schedule is a `GraceBucket[]`
 * where length 0 signals "no override — defaults are in force"; the
 * bounds are 4 parallel uint256 arrays describing each slot's
 * `[minDays, maxDays]` and `[minGrace, maxGrace]` windows.
 *
 * Lives outside the standard `useAdminKnobValues` map because the
 * shape (array-of-tuples) doesn't fit the scalar `KnobReadResult`
 * the other 17 knobs share. The `GraceBucketsCard` consumes it
 * directly.
 */

import { useEffect, useState } from 'react';
import type { Abi } from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/abis';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';

export interface GraceBucket {
  /** Loan-duration upper bound (exclusive) for this slot. `0` marks
   *  the catch-all (last slot — covers any duration above the
   *  previous slot's threshold). */
  maxDurationDays: bigint;
  /** Grace period in seconds applied to loans whose duration falls
   *  into this slot. */
  graceSeconds: bigint;
}

export interface GraceSlotBounds {
  /** Per-slot lower bound on `maxDurationDays`. `0` for the
   *  catch-all (its only legal value is `0`). */
  minDays: bigint;
  /** Per-slot upper bound on `maxDurationDays`. */
  maxDays: bigint;
  /** Per-slot lower bound on `graceSeconds`. */
  minGrace: bigint;
  /** Per-slot upper bound on `graceSeconds`. */
  maxGrace: bigint;
}

export interface GraceBucketsState {
  /** The configured schedule — empty when the contract is using
   *  compile-time defaults. The card renders the canonical default
   *  values in that case so admins can see what's in force. */
  buckets: GraceBucket[] | null;
  /** Per-slot policy bounds (always 6 entries). */
  slotBounds: GraceSlotBounds[] | null;
  /** True when storage is empty (defaults in force). */
  usingDefaults: boolean;
  loading: boolean;
  error: string | null;
  /** Force a re-fetch (called after a successful Safe proposal). */
  reload: () => void;
}

/**
 * Canonical compile-time default schedule. Mirrors the fallback baked
 * into `LibVaipakam.gracePeriod()` exactly. Used to populate the card
 * when the contract returns an empty array (no admin override).
 */
export const CANONICAL_GRACE_BUCKETS: GraceBucket[] = [
  { maxDurationDays: 7n, graceSeconds: 3600n },          // 1 hour
  { maxDurationDays: 30n, graceSeconds: 86400n },        // 1 day
  { maxDurationDays: 90n, graceSeconds: 259200n },       // 3 days
  { maxDurationDays: 180n, graceSeconds: 604800n },      // 1 week
  { maxDurationDays: 365n, graceSeconds: 1209600n },     // 2 weeks
  { maxDurationDays: 0n, graceSeconds: 2592000n },       // 30 days (catch-all)
];

export function useGraceBuckets(): GraceBucketsState {
  const client = useDiamondPublicClient();
  const chain = useReadChain();
  const [state, setState] = useState<GraceBucketsState>({
    buckets: null,
    slotBounds: null,
    usingDefaults: false,
    loading: true,
    error: null,
    reload: () => {},
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!chain.diamondAddress) return;
    let cancelled = false;
    const reload = () => setTick((t) => t + 1);

    setState((s) => ({ ...s, loading: true, error: null, reload }));

    const target = chain.diamondAddress as `0x${string}`;
    const abi = DIAMOND_ABI_VIEM as unknown as Abi;

    Promise.all([
      client.readContract({
        address: target,
        abi,
        functionName: 'getGraceBuckets',
      }) as Promise<readonly { maxDurationDays: bigint; graceSeconds: bigint }[]>,
      client.readContract({
        address: target,
        abi,
        functionName: 'getGraceSlotBounds',
      }) as Promise<readonly [bigint[], bigint[], bigint[], bigint[]]>,
    ])
      .then(([raw, bounds]) => {
        if (cancelled) return;
        const stored: GraceBucket[] = raw.map((b) => ({
          maxDurationDays: b.maxDurationDays,
          graceSeconds: b.graceSeconds,
        }));
        const usingDefaults = stored.length === 0;
        const buckets = usingDefaults ? CANONICAL_GRACE_BUCKETS : stored;
        const [minDays, maxDays, minGrace, maxGrace] = bounds;
        const slotBounds: GraceSlotBounds[] = minDays.map((_, i) => ({
          minDays: minDays[i],
          maxDays: maxDays[i],
          minGrace: minGrace[i],
          maxGrace: maxGrace[i],
        }));
        setState({
          buckets,
          slotBounds,
          usingDefaults,
          loading: false,
          error: null,
          reload,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState({
          buckets: null,
          slotBounds: null,
          usingDefaults: false,
          loading: false,
          error: msg.slice(0, 160),
          reload,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [client, chain.diamondAddress, tick]);

  return state;
}
