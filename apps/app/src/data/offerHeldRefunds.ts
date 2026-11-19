/**
 * #3744 — offer escrow held for the wallet's offer position tokens.
 *
 * When a step someone else triggered (a match, a fill, an expired cleanup)
 * returns an offer's escrow to a holder who could not be paid right then, the
 * contract keeps the amount in the creator's vault, held for the offer's
 * position token. Only the token's holder of record may collect it, into its
 * own vault as free balance (`collectOfferRefund`); from there the ordinary
 * Withdraw reaches a wallet.
 *
 * The indexer lists candidates from its event log. Each one is confirmed
 * LIVE before it is shown with a Collect step: the amount from
 * `getOfferRefundHeld`, the holder of record from the PositionNFT's
 * `holderOf` (the contract's own test, retired token or not). A line the live
 * reads do not confirm is dropped; a line whose live read fails is shown as
 * unconfirmed, with no step, rather than dropped or guessed.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { POSITION_NFT_ABI, positionNftForDiamond } from '../contracts/positionNft';
import { fetchOfferHeldRefunds, type IndexedHeldRefundLine } from './indexer';

export interface HeldRefundLine extends IndexedHeldRefundLine {
  /** The live held amount; null when the live read failed (unconfirmed). */
  liveAmount: bigint | null;
}

export interface HeldRefundsState {
  lines: HeldRefundLine[];
  /** The indexer's log scan hit its cap: there may be more lines. */
  truncated: boolean;
}

/** Keep the lines the live reads confirm for `address`. Exported for test. */
export function confirmHeldLines(
  lines: readonly IndexedHeldRefundLine[],
  live: readonly ({ amount: bigint; holder: string } | null)[],
  address: string,
): HeldRefundLine[] {
  const me = address.toLowerCase();
  const out: HeldRefundLine[] = [];
  lines.forEach((line, i) => {
    const r = live[i];
    if (r === null || r === undefined) {
      out.push({ ...line, liveAmount: null });
      return;
    }
    if (r.amount === 0n || r.holder.toLowerCase() !== me) return;
    out.push({ ...line, liveAmount: r.amount });
  });
  return out;
}

/** The wallet's held offer amounts, confirmed live. `data === null` = the
 *  indexer could not be read, so nothing can be said either way. */
export function useOfferHeldRefunds() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['offerHeldRefunds', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address) && Boolean(publicClient),
    staleTime: 60_000,
    queryFn: async (): Promise<HeldRefundsState | null> => {
      if (!address || !publicClient) return { lines: [], truncated: false };
      const page = await fetchOfferHeldRefunds(readChain.chainId, address);
      if (page === null) return null;
      if (page.lines.length === 0) return { lines: [], truncated: page.truncated };
      const nft = positionNftForDiamond(readChain.diamondAddress).nft;
      const live = await Promise.all(
        page.lines.map(async (line) => {
          try {
            const [amount, holder] = await Promise.all([
              publicClient.readContract({
                address: readChain.diamondAddress,
                abi: DIAMOND_ABI_VIEM,
                functionName: 'getOfferRefundHeld',
                args: [BigInt(line.positionToken), line.asset as `0x${string}`, BigInt(line.tokenId)],
              }) as Promise<bigint>,
              publicClient.readContract({
                address: nft as `0x${string}`,
                abi: POSITION_NFT_ABI,
                functionName: 'holderOf',
                args: [BigInt(line.positionToken)],
              }) as Promise<string>,
            ]);
            return { amount, holder };
          } catch {
            return null;
          }
        }),
      );
      return { lines: confirmHeldLines(page.lines, live, address), truncated: page.truncated };
    },
  });
}
