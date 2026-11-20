/**
 * #3858 — what a wallet still holds on a Closed network, read from the
 * network itself.
 *
 * A Closed network's indexer has stopped reading the chain (its stored rows
 * stay), so the closed view must not depend on it: every figure here is one
 * view call on the Diamond. Two lists, both the owner's own balance under
 * the owner's own hold, and both kept withdrawable with no end date:
 *   - the wallet's open offers (`getUserActiveOffers`), each cancellable by
 *     its creator;
 *   - the capital still held in the wallet's Auto-lend slots
 *     (`getLenderIntentsByOwner`), each returnable with
 *     `withdrawLenderIntentCapital`.
 * The vault balance and the claims have their own pages, which already read
 * the chain directly when the indexer is not answering.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';

/** Slots read per page; the view says when there are more. */
export const CLOSED_SLOT_PAGE = 50;

/** One Auto-lend slot that still holds capital the owner can take back. */
export interface HeldSlot {
  lendingAsset: `0x${string}`;
  collateralAsset: `0x${string}`;
  slot: number;
  /** Capital in the slot that no loan is using, in the lending asset's units. */
  available: bigint;
}

export interface ClosedNetworkHoldings {
  /** The wallet's open offers, by id. */
  offerIds: bigint[];
  /** Slots with capital left in them, in the order the network lists them. */
  slots: HeldSlot[];
  /** How many slots the wallet has on this network, read or not. */
  slotTotal: number;
}

interface IntentRow {
  intent: {
    lendingAsset: `0x${string}`;
    collateralAsset: `0x${string}`;
    slot: number;
    availableCapital: bigint;
  };
  active: boolean;
}

/** Keeps the slots that still hold capital. Exported for its test. */
export function heldSlots(rows: readonly IntentRow[]): HeldSlot[] {
  return rows
    .filter((r) => r.intent.availableCapital > 0n)
    .map((r) => ({
      lendingAsset: r.intent.lendingAsset,
      collateralAsset: r.intent.collateralAsset,
      slot: Number(r.intent.slot),
      available: r.intent.availableCapital,
    }));
}

/**
 * The connected wallet's holdings on the read chain. Undefined while
 * loading or disconnected; a failed read is the query's error, never an
 * empty list.
 */
export function useClosedNetworkHoldings() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['closedNetworkHoldings', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address) && Boolean(publicClient),
    queryFn: async (): Promise<ClosedNetworkHoldings> => {
      const [offerIds, intents] = await Promise.all([
        publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getUserActiveOffers',
          args: [address!],
        }) as Promise<readonly bigint[]>,
        publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getLenderIntentsByOwner',
          args: [address!, 0n, BigInt(CLOSED_SLOT_PAGE)],
        }) as Promise<readonly [readonly IntentRow[], bigint]>,
      ]);
      return {
        offerIds: [...offerIds],
        slots: heldSlots(intents[0]),
        slotTotal: Number(intents[1]),
      };
    },
  });
}
