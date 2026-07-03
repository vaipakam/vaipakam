/**
 * Page-owned pending-refinance state — deliberately OUTSIDE the
 * RefinanceFlow component. The marker and its live verification must
 * not depend on the strategy card's mount gates (loanLive readiness,
 * sanctions resolution, advanced mode, loan still active): a live
 * request keeps its banner, its cancel affordance, and the
 * partial-repay interlock through ALL of those windows, or a lender
 * can accept a request the page no longer admits exists.
 *
 * The marker is device-local (localStorage — the indexer has no
 * column for the refinance tag yet) and every render of the pending
 * surface verifies it against the chain in one batch: the offer
 * record (cancel DELETES it → zeroed creator self-heals the marker),
 * the LIVE loan (payoff recomputed from chain, never a cached prop),
 * LIVE fees (the top-up figure must track a governance retune), the
 * standing allowance + wallet balance (a sibling repay flow's
 * zero-first approve can strand the request silently), and chain
 * time (the cancel cooldown gate must not trust the device clock).
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { erc20Abi } from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import {
  LOAN_STATUS_ACTIVE,
  readLoanLive,
  refinancePayoffOf,
} from '../contracts/loanLive';
import { readLiveProtocolFees } from './fees';
import { ZERO_ADDRESS } from '../lib/offerSchema';
import { useActiveChain } from '../chain/useActiveChain';

/** Mirrors LibVaipakam.MIN_OFFER_CANCEL_DELAY — cancels inside this
 *  window revert CancelCooldownActive. */
export const CANCEL_COOLDOWN_SECONDS = 300n;

function storageKey(chainId: number, loanId: number): string {
  return `alpha02.refinanceOffer.${chainId}.${loanId}`;
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
    // Private-browsing storage failures only cost the pending banner.
  }
}

export interface RefinancePendingState {
  /** Loan still Active on-chain (a request on a settled loan is dead
   *  weight — cancel + revoke is the only remaining action). */
  loanActive: boolean;
  accepted: boolean;
  /** Unix-seconds the request expires (its on-chain Good-Til-Time). */
  expiresAt: bigint;
  /** Chain time says the cancel cooldown has elapsed. */
  cancelUnlocked: boolean;
  /** Standing approval no longer covers the live payoff. */
  allowanceShort: boolean;
  /** Wallet balance no longer covers the live top-up figure. */
  balanceShort: boolean;
  /** Live payoff (approval target) and spare-balance figure. */
  payoff: bigint;
  topUp: bigint;
}

export function useRefinancePending(
  loanId: number,
  principalAsset: `0x${string}` | undefined,
) {
  const { readChain, address } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });
  const [offerId, setOfferId] = useState<string | null>(null);

  // Re-seed whenever the chain (or loan) changes — a state initializer
  // would freeze the first chain's marker across a network switch.
  useEffect(() => {
    setOfferId(readStored(readChain.chainId, loanId));
  }, [readChain.chainId, loanId]);

  const remember = useCallback(
    (id: string) => {
      writeStored(readChain.chainId, loanId, id);
      setOfferId(id);
    },
    [readChain.chainId, loanId],
  );
  const clear = useCallback(() => {
    writeStored(readChain.chainId, loanId, null);
    setOfferId(null);
  }, [readChain.chainId, loanId]);

  const query = useQuery({
    queryKey: [
      'refinancePending',
      readChain.chainId,
      loanId,
      offerId,
      address?.toLowerCase(),
    ],
    enabled: Boolean(readClient) && offerId !== null && Boolean(principalAsset),
    refetchInterval: 30_000,
    queryFn: async (): Promise<RefinancePendingState | 'gone'> => {
      const diamond = readChain.diamondAddress;
      const [offer, live, fees, latestBlock, allowance, balance] =
        await Promise.all([
          readClient!.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getOfferDetails',
            args: [BigInt(offerId!)],
          }) as Promise<{
            creator: string;
            accepted: boolean;
            refinanceTargetLoanId: bigint;
            createdAt: bigint;
            expiresAt: bigint;
          }>,
          readLoanLive(readClient!, diamond, loanId),
          readLiveProtocolFees(readClient!, diamond),
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
        ]);
      // cancelOffer DELETES the record — zeroed creator = gone. Also
      // treat a marker pointing at some other loan's offer as gone.
      if (
        offer.creator === ZERO_ADDRESS ||
        offer.refinanceTargetLoanId !== BigInt(loanId)
      ) {
        return 'gone';
      }
      const payoff = refinancePayoffOf(live);
      const topUp =
        payoff -
        live.principal +
        (live.principal * BigInt(fees.loanInitiationFeeBps)) / 10_000n;
      // Disconnected wallet (address undefined) must not paint the
      // funding warnings red off zero placeholders.
      const fundingKnown = Boolean(address);
      return {
        loanActive: live.status === LOAN_STATUS_ACTIVE,
        accepted: offer.accepted,
        expiresAt: offer.expiresAt,
        cancelUnlocked:
          latestBlock.timestamp >= offer.createdAt + CANCEL_COOLDOWN_SECONDS,
        allowanceShort: fundingKnown && !offer.accepted && allowance < payoff,
        balanceShort: fundingKnown && !offer.accepted && balance < topUp,
        payoff,
        topUp,
      };
    },
  });

  // Self-heal: a deleted/foreign record clears the marker.
  useEffect(() => {
    if (query.data === 'gone') clear();
  }, [query.data, clear]);

  return {
    /** Non-null while a marker exists (state may still be loading). */
    offerId,
    /** Live-verified state; undefined while loading or errored. */
    state: query.data === 'gone' ? undefined : query.data,
    remember,
    clear,
  };
}
