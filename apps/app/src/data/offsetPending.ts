/**
 * Page-owned pending-OFFSET state (borrower preclose Option 3) —
 * sibling of useRefinancePending, same split of duties: the marker
 * and its live verification live OUTSIDE the OffsetFlow card so a
 * live offset keeps its banner, funding watch, and cancel affordance
 * through every strategy-card mount gate (mode, loanLive readiness,
 * sanctions, the loan settling another way).
 *
 * EXISTENCE is the CHAIN's say-so, not the marker's: the borrower
 * position NFT is natively locked (`positionLock(borrowerTokenId) ==
 * PrecloseOffset`) from posting until completion or cancel, so an
 * offset made on another device still shows here. The device-local
 * marker only remembers WHICH offer id was created (needed for
 * cancel); when the lock is live but the marker is missing, the
 * surface still renders with the cancel affordance degraded.
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { erc20Abi } from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { readPositionRoute } from '../contracts/positionNft';
import {
  CANCEL_COOLDOWN_SECONDS,
  LOAN_STATUS_ACTIVE,
  loanEndTimeOf,
  offsetCompletionBoundOf,
  readLoanLive,
} from '../contracts/loanLive';
import { ZERO_ADDRESS } from '../lib/offerSchema';
import { makePendingMarkerStore } from '../lib/pendingMarker';
import { useActiveChain } from '../chain/useActiveChain';
import { tipAware } from '../chain/railHealth';
import { boundOfferMoved, readLoanFlows, type FlowMoved } from './positionFlowMoved';

const marker = makePendingMarkerStore('app.offsetOffer');

/** LibERC721.LockReason.PrecloseOffset. */
export const LOCK_PRECLOSE_OFFSET = 1;

export interface OffsetPendingState {
  /** The borrower NFT carries the PrecloseOffset lock — the offset is
   *  live on-chain regardless of what this device remembers. */
  locked: boolean;
  /** Loan still Active on-chain. */
  loanActive: boolean;
  /** The marker's offer record still exists and is cancellable
   *  (cancelOffer DELETES the record — zeroed creator = gone). Only
   *  meaningful when a marker exists. */
  offerExists: boolean;
  /** Chain time says the protocol-wide cancel cooldown has elapsed. */
  cancelUnlocked: boolean;
  /** The linked offer's replacement term can no longer end by the
   *  original maturity (completion re-checks `now + durationDays`
   *  against the loan's fixed end, so a GTC offer posted near the
   *  maximum goes permanently unfillable as time passes) — only
   *  cancel-to-unwind remains. Judged only when the marker's offer
   *  record is readable; false otherwise. */
  termUnfillable: boolean;
  /** Standing approval no longer covers the completion pull bound
   *  (principal + remaining-term interest) — an accept would revert
   *  and the counterparty's transaction fails. Suppressed once the
   *  offset can no longer complete (loan settled / term unfillable):
   *  there is nothing left to fund. */
  allowanceShort: boolean;
  /** Wallet balance no longer covers the completion pull bound.
   *  Suppressed like `allowanceShort` once completion is impossible. */
  balanceShort: boolean;
  /** The completion pull's approval/balance bound. */
  completionBound: bigint;
  /** #3205 — the borrower position NFT moved since the offset was posted,
   *  per the indexer (the chain has no view of it yet, #3323). `'yes'`: the
   *  offset can never complete, and anyone may cancel its offer (the refund
   *  goes to the wallet that posted it). `'unknown'` is stated as such. */
  positionMoved: FlowMoved;
  /** The offset offer the indexer names for this loan when this device has
   *  no marker for it, verified to exist and be unaccepted; null otherwise.
   *  Lets a viewer who did not post the offset cancel one that moved. */
  indexedOfferId: string | null;
}

export function useOffsetPending(
  loanId: number,
  borrowerTokenId: string | undefined,
  principalAsset: `0x${string}` | undefined,
  enabled: boolean,
) {
  const { readChain, address } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });
  const [offerId, setOfferId] = useState<string | null>(() =>
    marker.read(readChain.chainId, loanId),
  );

  // Re-seed when the (chain, loan) identity changes, as a render-phase
  // ADJUSTMENT rather than in an effect (#1520). React re-runs the render
  // before painting, so the previous chain's marker is never displayed —
  // the effect version committed one frame carrying it, which on a network
  // switch meant briefly offering "cancel" against another chain's offer.
  // The initializer alone is not enough (it would freeze the first chain's
  // marker), which is what the effect was there for.
  const seedKey = `${readChain.chainId}:${loanId}`;
  const [seededFor, setSeededFor] = useState(seedKey);
  if (seededFor !== seedKey) {
    setSeededFor(seedKey);
    setOfferId(marker.read(readChain.chainId, loanId));
  }

  const remember = useCallback(
    (id: string) => {
      marker.write(readChain.chainId, loanId, id);
      setOfferId(id);
    },
    [readChain.chainId, loanId],
  );
  const clear = useCallback(() => {
    marker.write(readChain.chainId, loanId, null);
    setOfferId(null);
  }, [readChain.chainId, loanId]);

  const query = useQuery({
    queryKey: [
      'offsetPending',
      readChain.chainId,
      loanId,
      offerId,
      address?.toLowerCase(),
    ],
    // The LOCK read is the existence check, so this runs whenever the
    // caller says the loan looks open — not only when a marker exists.
    enabled:
      enabled &&
      Boolean(readClient) &&
      Boolean(borrowerTokenId) &&
      /^[1-9]\d*$/.test(borrowerTokenId ?? '') &&
      Boolean(principalAsset),
    refetchInterval: tipAware('offsetPending', 30_000, Boolean(readChain.wsUrl)),
    queryFn: async (): Promise<OffsetPendingState> => {
      const diamond = readChain.diamondAddress;
      const [lockRaw, live, latestBlock, offer, allowance, balance] =
        await Promise.all([
          readPositionRoute(readClient!, readChain.positionNft, BigInt(borrowerTokenId!)),
          readLoanLive(readClient!, diamond, loanId),
          readClient!.getBlock({ blockTag: 'latest' }),
          offerId
            ? (readClient!.readContract({
                address: diamond,
                abi: DIAMOND_ABI_VIEM,
                functionName: 'getOfferDetails',
                args: [BigInt(offerId)],
              }) as Promise<{
                creator: string;
                accepted: boolean;
                createdAt: bigint;
                durationDays: bigint;
              }>)
            : Promise.resolve(null),
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
      const locked = Number(lockRaw) === LOCK_PRECLOSE_OFFSET;
      // #3205 — the indexer's verdict on the loan's offset offer. Best
      // effort: no answer reads 'unknown', never "not moved".
      const flows = locked ? await readLoanFlows(readChain.chainId, loanId) : null;
      const indexed = boundOfferMoved(flows, 'offset', offerId);
      const positionMoved: FlowMoved = locked ? indexed.moved : 'no';
      let indexedOfferId: string | null = null;
      let indexedCreatedAt: bigint | null = null;
      if (offerId === null && indexed.offerId !== null) {
        try {
          const o = (await readClient!.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getOfferDetails',
            args: [BigInt(indexed.offerId)],
          })) as { creator: string; accepted: boolean; createdAt: bigint };
          if (o.creator !== ZERO_ADDRESS && !o.accepted) {
            indexedOfferId = indexed.offerId;
            indexedCreatedAt = o.createdAt;
          }
        } catch {
          // Unread: the cancel stays unavailable, as without the indexer.
        }
      }
      const offerExists =
        offer !== null && offer.creator !== ZERO_ADDRESS && !offer.accepted;
      const loanActive = live.status === LOAN_STATUS_ACTIVE;
      // The completion anti-drift bound: acceptance re-checks that the
      // replacement term still ends by the loan's EFFECTIVE maturity
      // (#668 / #935), so once chain time passes (end − duration) the
      // offer is unfillable and only cancel remains — unless a later
      // pause moves the maturity out again.
      const termUnfillable =
        offerExists &&
        latestBlock.timestamp + offer!.durationDays * 86_400n >
          loanEndTimeOf(live, latestBlock.timestamp);
      const completionBound = offsetCompletionBoundOf(live);
      // Disconnected wallet must not paint the funding warnings red
      // off zero placeholders; a dead offset (loan settled another
      // way, or the term no longer fits) has nothing left to fund, so
      // the warnings stop and cancel-to-unwind is the only story.
      const completable = locked && loanActive && !termUnfillable && positionMoved !== 'yes';
      const fundingKnown = Boolean(address);
      return {
        locked,
        loanActive,
        offerExists,
        cancelUnlocked:
          offer !== null
            ? latestBlock.timestamp >= offer.createdAt + CANCEL_COOLDOWN_SECONDS
            : indexedCreatedAt !== null &&
              latestBlock.timestamp >= indexedCreatedAt + CANCEL_COOLDOWN_SECONDS,
        termUnfillable,
        allowanceShort:
          fundingKnown && completable && allowance < completionBound,
        balanceShort: fundingKnown && completable && balance < completionBound,
        completionBound,
        positionMoved,
        indexedOfferId,
      };
    },
  });

  // Self-heal the marker when the chain says the offset is over (lock
  // released by completion or cancel), AND when the remembered offer
  // record itself is gone while a lock is still live — that lock then
  // belongs to a NEWER offset posted from another device after this
  // one's was cancelled there, and keeping the stale id would offer a
  // cancel against a deleted offer (Codex #1500 r1).
  useEffect(() => {
    if (
      query.data &&
      offerId !== null &&
      (!query.data.locked || !query.data.offerExists)
    ) {
      // Deliberately an effect (#1520): this INVALIDATES persisted device
      // state on verified chain evidence, so it is external-store
      // synchronisation rather than derived state. Deriving the returned id
      // during render would leave `offerId` — which is part of this hook's
      // query key — still naming the offer just disproved, so the hook would
      // keep verifying an offer it knows is gone.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      clear();
    }
  }, [query.data, offerId, clear]);

  return {
    /** Device-remembered linked offer id (may be null while the chain
     *  lock still says an offset is live — cancel degrades then). */
    offerId,
    /** Live-verified state; undefined while loading or errored. */
    state: query.data,
    /** True the moment the CHAIN says an offset is live. */
    pending: query.data?.locked === true,
    /** The lock read has ANSWERED (either way). While false the page
     *  must fail CLOSED: a cross-device offset could be live, and the
     *  settlement paths that would strand its funded linked offer
     *  (preclose, partial, refinance, handover, a second offset) must
     *  hold until the chain has spoken (Codex #1500 r1). */
    pendingKnown: query.data !== undefined,
    /** The verification read failed (distinct from still-loading) —
     *  surfaces the retrying state instead of an eternal "checking". */
    isError: query.isError,
    remember,
    clear,
  };
}
