/**
 * Page-owned pending-sale state for the lender Option-2 listing
 * (createLoanSaleOffer). Unlike the refinance marker, EXISTENCE is a
 * pure chain read — `positionLock(lenderTokenId) ==
 * EarlyWithdrawalSale` is authoritative — so a listing made on
 * another device still shows here. The device-local marker only
 * remembers the offer id (needed for cancelOffer; there is no
 * on-chain loanId→saleOfferId view), verified live via
 * getOfferLinkedLoanId before it is trusted.
 *
 * The funding watch mirrors the completion pull: the buyer's accept
 * tx pulls max(accrued-at-acceptance, rate shortfall) from the
 * SELLER's wallet via the standing approval — if that approval or
 * the balance goes short, every accept reverts and the listing is
 * silently unfillable. `requiredNow` tracks the figure as of chain
 * time; the standing approval targets the bounded worst case.
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { erc20Abi } from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import {
  BASIS_POINTS,
  SECONDS_PER_YEAR,
  interestAccrualStartOf,
  interestRemainingDaysOf,
  readLoanLive,
  type LoanLive,
} from '../contracts/loanLive';
import { useActiveChain } from '../chain/useActiveChain';

/** LibERC721.LockReason.EarlyWithdrawalSale. */
export const LOCK_EARLY_WITHDRAWAL_SALE = 2;

/** The bounded worst case of the completion pull: accrued can grow
 *  until acceptance but never past the interest window's total, and
 *  the shortfall only shrinks as the remaining term shortens. The
 *  standing approval covers max of both so it never needs topping up
 *  from mere passage of time. */
export function saleSettlementBound(
  live: LoanLive,
  saleRateBps: bigint,
  chainNow: bigint,
): bigint {
  const start = interestAccrualStartOf(live);
  const elapsed = chainNow > start ? chainNow - start : 0n;
  const totalSecs = interestRemainingDaysOf(live) * 86_400n;
  const remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0n;
  const denom = SECONDS_PER_YEAR * BASIS_POINTS;
  const fullWindowInterest =
    (live.principal * live.interestRateBps * totalSecs) / denom;
  const shortfallNow =
    saleRateBps > live.interestRateBps
      ? (live.principal * (saleRateBps - live.interestRateBps) * remainingSecs) /
        denom
      : 0n;
  return fullWindowInterest > shortfallNow ? fullWindowInterest : shortfallNow;
}

/** What a buyer's acceptance would pull RIGHT NOW. */
export function saleSettlementNow(
  live: LoanLive,
  saleRateBps: bigint,
  chainNow: bigint,
): bigint {
  const start = interestAccrualStartOf(live);
  const elapsed = chainNow > start ? chainNow - start : 0n;
  const totalSecs = interestRemainingDaysOf(live) * 86_400n;
  const remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0n;
  const denom = SECONDS_PER_YEAR * BASIS_POINTS;
  const accrued = (live.principal * live.interestRateBps * elapsed) / denom;
  const shortfall =
    saleRateBps > live.interestRateBps
      ? (live.principal * (saleRateBps - live.interestRateBps) * remainingSecs) /
        denom
      : 0n;
  return accrued > shortfall ? accrued : shortfall;
}

function storageKey(chainId: number, loanId: number): string {
  return `alpha02.loanSaleOffer.${chainId}.${loanId}`;
}
function readStored(chainId: number, loanId: number): string | null {
  try {
    return window.localStorage.getItem(storageKey(chainId, loanId));
  } catch {
    return null;
  }
}
function writeStored(chainId: number, loanId: number, id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(storageKey(chainId, loanId));
    else window.localStorage.setItem(storageKey(chainId, loanId), id);
  } catch {
    // Losing the marker only costs the cancel affordance.
  }
}

export interface LoanSalePendingState {
  /** The lender NFT is lock-tagged for a sale — a listing exists. */
  listed: boolean;
  /** Marker offer id, live-verified to link back to this loan
   *  (null when listed from another device or marker stale). */
  offerId: string | null;
  /** The listing's sale rate (bps) from the live offer record. */
  saleRateBps: bigint | null;
  /** What acceptance would pull right now / the standing bound. */
  requiredNow: bigint;
  requiredBound: bigint;
  allowanceShort: boolean;
  balanceShort: boolean;
}

export function useLoanSalePending(
  loanId: number,
  lenderTokenId: string | undefined,
  principalAsset: `0x${string}` | undefined,
  enabled: boolean,
) {
  const { readChain, address } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });
  const [markerId, setMarkerId] = useState<string | null>(null);

  useEffect(() => {
    setMarkerId(readStored(readChain.chainId, loanId));
  }, [readChain.chainId, loanId]);

  const remember = useCallback(
    (id: string) => {
      writeStored(readChain.chainId, loanId, id);
      setMarkerId(id);
    },
    [readChain.chainId, loanId],
  );
  const clear = useCallback(() => {
    writeStored(readChain.chainId, loanId, null);
    setMarkerId(null);
  }, [readChain.chainId, loanId]);

  const query = useQuery({
    queryKey: [
      'loanSalePending',
      readChain.chainId,
      loanId,
      markerId,
      address?.toLowerCase(),
    ],
    enabled:
      enabled &&
      Boolean(readClient) &&
      Boolean(lenderTokenId) &&
      Boolean(principalAsset) &&
      /^[1-9]\d*$/.test(lenderTokenId ?? ''),
    refetchInterval: 30_000,
    queryFn: async (): Promise<LoanSalePendingState> => {
      const diamond = readChain.diamondAddress;
      const [lock, live, latestBlock, allowance, balance, linkedLoanId, offer] =
        await Promise.all([
          readClient!.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'positionLock',
            args: [BigInt(lenderTokenId!)],
          }) as Promise<number | bigint>,
          readLoanLive(readClient!, diamond, loanId),
          readClient!.getBlock({ blockTag: 'latest' }),
          address
            ? (readClient!.readContract({
                address: principalAsset!,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [address, diamond],
              }) as Promise<bigint>)
            : Promise.resolve(0n),
          address
            ? (readClient!.readContract({
                address: principalAsset!,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [address],
              }) as Promise<bigint>)
            : Promise.resolve(0n),
          markerId
            ? (readClient!.readContract({
                address: diamond,
                abi: DIAMOND_ABI_VIEM,
                functionName: 'getOfferLinkedLoanId',
                args: [BigInt(markerId)],
              }) as Promise<bigint>)
            : Promise.resolve(0n),
          markerId
            ? (readClient!
                .readContract({
                  address: diamond,
                  abi: DIAMOND_ABI_VIEM,
                  functionName: 'getOfferDetails',
                  args: [BigInt(markerId)],
                })
                .catch(() => null) as Promise<{ interestRateBps: number } | null>)
            : Promise.resolve(null),
        ]);
      const listed = Number(lock) === LOCK_EARLY_WITHDRAWAL_SALE;
      const markerValid =
        markerId !== null && listed && linkedLoanId === BigInt(loanId);
      // The sale rate comes from the live offer; without a valid
      // marker the funding watch can't know the shortfall leg, so it
      // conservatively watches the accrued leg alone (rate = loan's).
      const saleRateBps = markerValid && offer
        ? BigInt(offer.interestRateBps)
        : null;
      const watchRate = saleRateBps ?? live.interestRateBps;
      const requiredNow = saleSettlementNow(live, watchRate, latestBlock.timestamp);
      const requiredBound = saleSettlementBound(
        live,
        watchRate,
        latestBlock.timestamp,
      );
      const fundingKnown = Boolean(address);
      return {
        listed,
        offerId: markerValid ? markerId : null,
        saleRateBps,
        requiredNow,
        requiredBound,
        allowanceShort: fundingKnown && listed && allowance < requiredNow,
        balanceShort: fundingKnown && listed && balance < requiredNow,
      };
    },
  });

  // A marker whose offer no longer links to this loan is stale
  // (cancelled/completed elsewhere) — self-heal it once we know.
  useEffect(() => {
    if (
      markerId !== null &&
      query.data !== undefined &&
      query.data.offerId === null &&
      !query.data.listed
    ) {
      clear();
    }
  }, [markerId, query.data, clear]);

  return { state: query.data, remember, clear };
}
