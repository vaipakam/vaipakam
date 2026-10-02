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
  type Address,
  type PublicClient,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { signalAware } from '../chain/railHealth';

export interface RewardsSnapshot {
  /** Claimable VPFI (18-dec) right now. */
  pending: bigint;
  /** True when a reward day is still finalizing for this user. */
  waiting: boolean;
}

/**
 * The EXACT claimable figure, read BY EXECUTION (A2-iii): the Diamond's
 * `simulateClaimInteractionRewards` runs the real claim for `user` and then
 * always reverts with `InteractionRewardsSimulation(paid, fromDay, toDay)`,
 * so an `eth_call` (viem's `simulateContract`) carries the figure in its
 * revert data and nothing it did survives. A different revert is what the
 * claim itself would revert with — nothing to claim, a staging reservation,
 * the pause — and reads here as nothing claimable now. The lens's
 * `previewInteractionRewards` view still exists for on-chain readers, as a
 * conservative lower bound; the app reads the exact figure.
 */
export async function previewClaimByExecution(
  client: Pick<PublicClient, 'simulateContract'>,
  diamond: Address,
  user: Address,
): Promise<bigint> {
  try {
    await client.simulateContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'simulateClaimInteractionRewards',
      args: [user, 0 /* RewardDelivery.Default */],
      account: user,
    });
  } catch (err) {
    const revert =
      err instanceof BaseError
        ? err.walk((e) => e instanceof ContractFunctionRevertedError)
        : null;
    if (revert instanceof ContractFunctionRevertedError) {
      if (revert.data?.errorName === 'InteractionRewardsSimulation') {
        const [paid] = (revert.data.args ?? [0n]) as readonly [bigint, bigint, bigint];
        return paid;
      }
      return 0n;
    }
    const zero =
      err instanceof BaseError &&
      err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null;
    if (zero) return 0n;
    throw err;
  }
  // The entry cannot return: it reverts by construction. A return means the
  // routed code is not this one, and a figure invented here would be wrong.
  throw new Error('simulateClaimInteractionRewards returned without reverting');
}

export function useInteractionRewards() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  return useQuery({
    queryKey: ['interactionRewards', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address) && Boolean(publicClient),
    // RPC read-diet PR A — receipt + focus + push + 180s net (§4.1.2).
    refetchInterval: signalAware(60_000),
    queryFn: async (): Promise<RewardsSnapshot> => {
      try {
        const [pending, claimability] = await Promise.all([
          previewClaimByExecution(publicClient!, readChain.diamondAddress, address!),
          publicClient!.readContract({
            address: readChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getInteractionClaimability',
            args: [address!],
          }) as Promise<readonly [bigint, bigint, bigint, boolean, bigint]>,
        ]);
        return {
          pending,
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
