import { useEffect, useState } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';

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
  const diamond = useDiamondRead();
  const [state, setState] = useState<EscrowRentalState | null>(null);

  useEffect(() => {
    if (!lender || !nftContract || tokenId === undefined) return;
    let cancelled = false;

    const readNow = async () => {
      try {
        const [user, expires, quantity] = await Promise.all([
          diamond.escrowGetNFTUserOf(lender, nftContract, tokenId),
          diamond.escrowGetNFTUserExpires(lender, nftContract, tokenId),
          diamond.escrowGetNFTQuantity(lender, nftContract, tokenId),
        ]);
        if (!cancelled) {
          setState({
            user: String(user),
            expires: BigInt(expires),
            quantity: BigInt(quantity),
          });
        }
      } catch {
        if (!cancelled) setState(null);
      }
    };

    readNow();

    // Narrow the filter by indexed topics (lender, nftContract, tokenId).
    const filter = diamond.filters.EscrowRentalUpdated(lender, nftContract, tokenId);
    const onEvent = () => { readNow(); };
    diamond.on(filter, onEvent);

    return () => {
      cancelled = true;
      diamond.off(filter, onEvent);
    };
  }, [diamond, lender, nftContract, tokenId]);

  return state;
}
