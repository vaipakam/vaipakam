import { useEffect, useState } from 'react';
import { getAddress, type Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM } from '../contracts/abis';

export interface EscrowRentalState {
  user: string;
  expires: bigint;
  quantity: bigint;
}

/**
 * Subscribes to the Diamond's EscrowRentalUpdated event for a single
 * (lender, nftContract, tokenId) tuple and keeps a live snapshot of the
 * escrow's aggregate rental state. Works uniformly for 4907-native and
 * non-4907 NFTs since the Diamond emits on every wrapper state change.
 *
 * Returns `null` while the initial read is in flight or if the Diamond
 * address is not known.
 */
export function useEscrowRental(
  lender: string | undefined,
  nftContract: string | undefined,
  tokenId: bigint | undefined,
): EscrowRentalState | null {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = chain.diamondAddress as Address | null;
  const [state, setState] = useState<EscrowRentalState | null>(null);

  useEffect(() => {
    if (!lender || !nftContract || tokenId === undefined) return;
    if (!diamondAddress) return;
    let cancelled = false;

    const readNow = async () => {
      try {
        const [user, expires, quantity] = await Promise.all([
          publicClient.readContract({
            address: diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'escrowGetNFTUserOf',
            args: [getAddress(lender), getAddress(nftContract), tokenId],
          }),
          publicClient.readContract({
            address: diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'escrowGetNFTUserExpires',
            args: [getAddress(lender), getAddress(nftContract), tokenId],
          }),
          publicClient.readContract({
            address: diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'escrowGetNFTQuantity',
            args: [getAddress(lender), getAddress(nftContract), tokenId],
          }),
        ]);
        if (!cancelled) {
          setState({
            user: String(user),
            expires: BigInt(expires as bigint),
            quantity: BigInt(quantity as bigint),
          });
        }
      } catch {
        if (!cancelled) setState(null);
      }
    };

    readNow();

    // Narrow the subscription by indexed topics (lender, nftContract,
    // tokenId) — viem filters on `args` to do the same thing ethers'
    // `filters.EscrowRentalUpdated(...)` did.
    const unwatch = publicClient.watchContractEvent({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      eventName: 'EscrowRentalUpdated',
      args: {
        lender: getAddress(lender),
        nftContract: getAddress(nftContract),
        tokenId,
      },
      onLogs: () => { readNow(); },
    });

    return () => {
      cancelled = true;
      unwatch();
    };
  }, [publicClient, diamondAddress, lender, nftContract, tokenId]);

  return state;
}
