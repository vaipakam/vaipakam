/**
 * Interaction rewards (VPFI) — pull-model, claimable after a loan
 * closes AND the cross-chain reward day finalizes. `waiting` captures
 * the finalization window so the UI can show an honest "being
 * finalized" state instead of a zero that looks like "no rewards".
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';

export interface RewardsSnapshot {
  /** Claimable VPFI (18-dec) right now. */
  pending: bigint;
  /** True when a reward day is still finalizing for this user. */
  waiting: boolean;
}

export function useInteractionRewards() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  return useQuery({
    queryKey: ['interactionRewards', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address) && Boolean(publicClient),
    refetchInterval: 60_000,
    queryFn: async (): Promise<RewardsSnapshot> => {
      try {
        const [preview, claimability] = await Promise.all([
          publicClient!.readContract({
            address: readChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'previewInteractionRewards',
            args: [address!],
          }) as Promise<readonly [bigint, bigint, bigint]>,
          publicClient!.readContract({
            address: readChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getInteractionClaimability',
            args: [address!],
          }) as Promise<readonly [bigint, bigint, bigint, boolean, bigint]>,
        ]);
        return {
          pending: preview[0] ?? 0n,
          waiting: (claimability[4] ?? 0n) > 0n,
        };
      } catch {
        // Rewards facet absent / read failure — show the quiet empty
        // state; rewards are never load-bearing for the main journeys.
        return { pending: 0n, waiting: false };
      }
    },
  });
}
