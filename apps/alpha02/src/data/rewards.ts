/**
 * Interaction rewards (VPFI) — pull-model, claimable after a loan
 * closes AND the cross-chain reward day finalizes. `waiting` captures
 * the finalization window so the UI can show an honest "being
 * finalized" state instead of a zero that looks like "no rewards".
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { idleAware } from '../lib/idle';

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
    refetchInterval: idleAware(60_000),
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
      } catch (err) {
        // Only a REVERT/zero-data means "rewards facet absent on this
        // chain" → the quiet empty state. A transport failure is NOT
        // "no rewards" — rethrow so the card shows unavailable instead
        // of telling a user with claimable VPFI there's nothing.
        const isRevert =
          err instanceof BaseError &&
          (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
            err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
        if (isRevert) return { pending: 0n, waiting: false };
        throw err;
      }
    },
  });
}
