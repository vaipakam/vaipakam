import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';

interface StakingRewardsSnapshot {
  /** Pending VPFI claimable right now for the wallet (18-decimal wei). */
  pending: bigint;
  /** Wallet's current escrow-VPFI balance counted toward accrual. */
  staked: bigint;
  /** Annual percentage rate paid on staked VPFI, in basis points (e.g. 500 = 5%). */
  aprBps: bigint;
  /** Remaining VPFI in the protocol-wide staking pool. */
  poolRemaining: bigint;
  /** True when any of the views reverted and the snapshot is stale. */
  stale: boolean;
}

const EMPTY: StakingRewardsSnapshot = {
  pending: 0n,
  staked: 0n,
  aprBps: 500n,
  poolRemaining: 0n,
  stale: true,
};

/**
 * Read-only snapshot of the connected wallet's VPFI staking-rewards state
 * on the active read-chain. Pulls from the four `StakingRewardsFacet`
 * views in a single multicall; when any view is missing (older Diamond
 * deploy without the facet) the field falls back to the typed default
 * and `stale: true` is surfaced so the caller can hide the surface.
 */
export function useStakingRewards(address: string | null | undefined) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
  const [snapshot, setSnapshot] = useState<StakingRewardsSnapshot>(EMPTY);
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
          functionName: 'previewStakingRewards',
          args: [address as Address],
        }),
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getUserStakedVPFI',
          args: [address as Address],
        }),
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getStakingAPRBps',
          args: [],
        }),
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getStakingPoolRemaining',
          args: [],
        }),
      ]);
      const stale = reads.some((r) => r.status === 'rejected');
      setSnapshot({
        pending: reads[0].status === 'fulfilled' ? (reads[0].value as bigint) : 0n,
        staked: reads[1].status === 'fulfilled' ? (reads[1].value as bigint) : 0n,
        aprBps: reads[2].status === 'fulfilled' ? (reads[2].value as bigint) : 500n,
        poolRemaining: reads[3].status === 'fulfilled' ? (reads[3].value as bigint) : 0n,
        stale,
      });
    } finally {
      setLoading(false);
    }
  }, [address, publicClient, diamondAddress]);

  useEffect(() => { load(); }, [load]);

  return { ...snapshot, loading, reload: load };
}
