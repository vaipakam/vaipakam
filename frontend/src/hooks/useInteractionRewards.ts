import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';

interface InteractionRewardsSnapshot {
  /** Pending VPFI claimable right now for the wallet (18-decimal wei). */
  pending: bigint;
  /** Annual percentage rate the interaction-rewards pool is currently
   *  paying, in basis points. Display-only context. */
  aprBps: bigint;
  /** Spec §4a finalization gate. The Diamond rejects a claim until
   *  `dayId`'s cross-chain global denominator has been broadcast to this
   *  chain. While `false` AND `waitingForDay > 0`, the UI should show
   *  "waiting on day X" instead of a claim button — claim would revert. */
  finalizedPrefix: boolean;
  waitingForDay: bigint;
  /** True when any of the views reverted and the snapshot is stale. */
  stale: boolean;
}

const EMPTY: InteractionRewardsSnapshot = {
  pending: 0n,
  aprBps: 0n,
  finalizedPrefix: false,
  waitingForDay: 0n,
  stale: true,
};

/**
 * Read-only snapshot of the connected wallet's interaction-rewards state.
 * Reads `previewInteractionRewards(address)` for the pending amount and
 * `getInteractionClaimability(address)` for the cross-chain finalization
 * gate that drives the "Claim" / "Waiting" button state. Pulls the live
 * APR from `getInteractionSnapshot` for context. All reads run in
 * parallel; any reverts surface via the `stale` flag so callers can hide
 * the surface on an older Diamond deploy without that facet wired in.
 */
export function useInteractionRewards(address: string | null | undefined) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
  const [snapshot, setSnapshot] = useState<InteractionRewardsSnapshot>(EMPTY);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!address) {
      setSnapshot(EMPTY);
      return;
    }
    setLoading(true);
    try {
      const reads = await Promise.allSettled([
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'previewInteractionRewards',
          args: [address as Address],
        }),
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getInteractionClaimability',
          args: [address as Address],
        }),
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getInteractionSnapshot',
          args: [],
        }),
      ]);
      const stale = reads.some((r) => r.status === 'rejected');
      // `previewInteractionRewards` returns `(amount, fromDay, toDay)`.
      let pending = 0n;
      if (reads[0].status === 'fulfilled') {
        const tuple = reads[0].value as readonly [bigint, bigint, bigint];
        pending = tuple[0] ?? 0n;
      }
      // `getInteractionClaimability` returns
      // `(fromDay, windowToDay, effectiveTo, finalizedPrefix, waitingForDay)`.
      let finalizedPrefix = false;
      let waitingForDay = 0n;
      if (reads[1].status === 'fulfilled') {
        const tuple = reads[1].value as readonly [bigint, bigint, bigint, boolean, bigint];
        finalizedPrefix = tuple[3] ?? false;
        waitingForDay = tuple[4] ?? 0n;
      }
      // `getInteractionSnapshot` returns
      // `(cap, paidOut, remaining, launch, today, aprBps)`.
      let aprBps = 0n;
      if (reads[2].status === 'fulfilled') {
        const tuple = reads[2].value as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
        aprBps = tuple[5] ?? 0n;
      }
      setSnapshot({ pending, aprBps, finalizedPrefix, waitingForDay, stale });
    } finally {
      setLoading(false);
    }
  }, [address, publicClient, diamondAddress]);

  useEffect(() => { load(); }, [load]);

  return { ...snapshot, loading, reload: load };
}
