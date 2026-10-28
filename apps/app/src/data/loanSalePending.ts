/**
 * Page-owned pending-sale state for the lender Option-2 listing
 * (createLoanSaleOffer). Unlike the refinance marker, EXISTENCE is a
 * pure chain read — `positionLock(lenderTokenId) ==
 * EarlyWithdrawalSale` is authoritative — so a listing made on
 * another device still shows here. The device-local marker remembers
 * the offer id (needed for cancel and for the listing's own record;
 * there is no on-chain loanId→saleOfferId view), verified live via
 * getOfferLinkedLoanId before it is trusted; when it is missing the
 * hook attempts RECOVERY by probing the connected wallet's own open
 * offers for one linked to this loan.
 *
 * There is no funding watch (#2674). A buyer's acceptance escrows the
 * buyer's payment and the completion deducts the seller's settlement
 * from it (net settlement, #1659), so a listing needs no token approval
 * and nothing about the seller's wallet can make it fail.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import {
  CANCEL_COOLDOWN_SECONDS,
  LOAN_STATUS_ACTIVE,
  readLoanLive,
  sellerEconomics,
  type LoanLive,
} from '../contracts/loanLive';
import { fetchOffersByCreator } from './indexer';
import { makePendingMarkerStore } from '../lib/pendingMarker';
import { useActiveChain } from '../chain/useActiveChain';
import { tipAware } from '../chain/railHealth';

/** LibERC721.LockReason.EarlyWithdrawalSale. */
export const LOCK_EARLY_WITHDRAWAL_SALE = 2;

/** The settlement a buyer's acceptance would deduct from their payment to
 *  the seller RIGHT NOW: max(accrued interest forfeited, rate top-up). */
export function saleSettlementNow(
  live: LoanLive,
  saleRateBps: bigint,
): bigint {
  return sellerEconomics(live, saleRateBps).cost;
}

const marker = makePendingMarkerStore('app.loanSaleOffer');

export interface LoanSalePendingState {
  /** The lender NFT is lock-tagged for a sale — a listing exists. */
  listed: boolean;
  /** The loan is still Active — a settled loan's listing can never
   *  complete (accepts revert); cancel-to-unlock is the only move. */
  loanActive: boolean;
  /** Connected wallet currently HOLDS the lender NFT — the only wallet
   *  that may cancel the listing, and the one its payout goes to. */
  isHolder: boolean;
  /** Live-verified listing offer id (marker or recovered); null when
   *  unknown — cancel is unavailable then. */
  offerId: string | null;
  /** `offerId` is null because the link read FAILED, not because it
   *  proved absent (Codex r18 P2).
   *
   *  The two were conflated: `getOfferLinkedLoanId` throwing was caught
   *  as `resolvedId = null`, which the reconciliation effect below then
   *  treats as "the marker is stale" and CLEARS — destroying the only
   *  id this device holds on a transient RPC failure. If the indexer
   *  probe later exhausts its budget or the offer falls outside its
   *  50-row window, that id is gone and the lender loses their cancel
   *  path with it.
   *
   *  Callers must not read a null `offerId` as "listed elsewhere" while
   *  this is true; it means "we could not tell". */
  offerIdVerifyFailed: boolean;
  /** The listing's expiry (seconds), from its own offer record; null when
   *  that record was not read (#1848). */
  expiresAt: bigint | null;
  /** Whether a buyer has accepted the listing; null when not read. */
  accepted: boolean | null;
  /** Can a buyer still TAKE the listing now (#1848)? THREE-valued on
   *  purpose: `'unknown'` when the listing's record was not read, and it
   *  never collapses into either answer. `'no'` when the loan is no longer
   *  active, a buyer has already accepted, or the listing has expired. A
   *  `'yes'` says only that the listing's own terms still admit a buyer: the
   *  seller bounds it recorded are not readable here (#1810), so a sale can
   *  still be refused for having moved past them. */
  fillable: SaleListingVerdict;
  /** Can the sale still COMPLETE, so that its costs may still fall on the
   *  seller (#1848)? Differs from `fillable` in one case: an accepted
   *  listing whose settlement has not finished can still complete. `'no'`
   *  when the loan is no longer active or the listing expired unsold. */
  completable: SaleListingVerdict;
  /** Chain time says the cancel cooldown has elapsed. */
  cancelUnlocked: boolean;
}

export type SaleListingVerdict = 'yes' | 'no' | 'unknown';

/** Which text the listing card's status line shows (#1848, Codex #2673 r3).
 *
 *  Everything past "a listing exists" comes from the listing's record and
 *  the loan's status, and both can move: TanStack keeps the last success
 *  through a failed poll, and a loan in fallback can be cured back to
 *  Active. So when `stale` the card makes no claim drawn from them — not
 *  settled, not accepted, not expired, no end time — and says the current
 *  state could not be read. Only the lock itself, which is what mounted the
 *  card, is still stated. */
export type SaleListingCardView =
  | 'stale'
  | 'settled'
  | 'accepted'
  | 'expired'
  | 'open'
  | 'unread';

export function saleListingCardView(
  state: LoanSalePendingState,
  stale: boolean,
): SaleListingCardView {
  if (stale) return 'stale';
  if (!state.loanActive) return 'settled';
  if (state.accepted === true) return 'accepted';
  if (state.fillable === 'no' && state.expiresAt !== null) return 'expired';
  return state.fillable === 'yes' ? 'open' : 'unread';
}

/** #1848 — what a listing's own record says about it, from its offer fields
 *  and the chain time. A record that was not read gives `'unknown'` for both,
 *  never a guess. The expiry rule is the accept path's: a listing is expired
 *  once chain time reaches `expiresAt` (`expiresAt == 0` never expires). */
export function saleListingVerdicts(args: {
  loanActive: boolean;
  record: { expiresAt: bigint; accepted: boolean } | null;
  chainNow: bigint;
}): { fillable: SaleListingVerdict; completable: SaleListingVerdict } {
  if (!args.loanActive) return { fillable: 'no', completable: 'no' };
  if (!args.record) return { fillable: 'unknown', completable: 'unknown' };
  const { expiresAt, accepted } = args.record;
  if (accepted) return { fillable: 'no', completable: 'yes' };
  const expired = expiresAt !== 0n && args.chainNow >= expiresAt;
  return expired
    ? { fillable: 'no', completable: 'no' }
    : { fillable: 'yes', completable: 'yes' };
}

export function useLoanSalePending(
  loanId: number,
  lenderTokenId: string | undefined,
  enabled: boolean,
) {
  const { readChain, address } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });
  const [markerId, setMarkerId] = useState<string | null>(() =>
    marker.read(readChain.chainId, loanId),
  );
  // The recovery probe is expensive (indexer page + serial link
  // reads) — budget a few attempts per (chain, loan, wallet) episode
  // instead of re-firing on every 30s tick forever.
  const probeBudgetRef = useRef(3);

  // Re-seed the marker when the (chain, loan, wallet) identity changes, as
  // a render-phase ADJUSTMENT rather than in an effect (#1520): React
  // re-runs the render before painting, so the previous identity's marker
  // is never displayed, where the effect version committed one frame
  // carrying it. The initializer alone would freeze the first identity's
  // marker, which is what the effect was there for.
  const seedKey = `${readChain.chainId}:${loanId}:${address ?? ''}`;
  const [seededFor, setSeededFor] = useState(seedKey);
  if (seededFor !== seedKey) {
    setSeededFor(seedKey);
    setMarkerId(marker.read(readChain.chainId, loanId));
  }

  // The probe budget stays in an effect on purpose: writing a ref during
  // render is what `react-hooks/refs` (promoted in #1670) forbids, and
  // unlike the marker this value is never read during render, so a
  // post-commit reset is not observable.
  useEffect(() => {
    probeBudgetRef.current = 3;
  }, [readChain.chainId, loanId, address]);

  const remember = useCallback(
    (id: string) => {
      marker.write(readChain.chainId, loanId, id);
      setMarkerId(id);
    },
    [readChain.chainId, loanId],
  );
  const clear = useCallback(() => {
    marker.write(readChain.chainId, loanId, null);
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
    // Runs for the LENDER-side viewer (the only audience of the card) or
    // whenever this device holds a marker — never for borrowers or
    // spectators.
    enabled:
      (enabled || markerId !== null) &&
      Boolean(readClient) &&
      Boolean(lenderTokenId) &&
      /^[1-9]\d*$/.test(lenderTokenId ?? ''),
    // RPC read-diet PR A — pending-card accept gate: tip-nudged per
    // block on WS deploys (§4.1.2), so the interval is only the net.
    refetchInterval: tipAware('loanSalePending', 30_000, Boolean(readChain.wsUrl)),
    queryFn: async (): Promise<LoanSalePendingState> => {
      const diamond = readChain.diamondAddress;
      const [lock, live, latestBlock, holder] = await Promise.all([
        readClient!.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'positionLock',
          args: [BigInt(lenderTokenId!)],
        }) as Promise<number | bigint>,
        readLoanLive(readClient!, diamond, loanId),
        readClient!.getBlock({ blockTag: 'latest' }),
        readClient!
          .readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'ownerOf',
            args: [BigInt(lenderTokenId!)],
          })
          .catch(() => null) as Promise<string | null>,
      ]);
      const listed = Number(lock) === LOCK_EARLY_WITHDRAWAL_SALE;
      // Only the CURRENT lender-NFT holder may cancel the listing, and the
      // recovery probe looks for the listing among that wallet's offers.
      const isHolder =
        Boolean(address) &&
        holder !== null &&
        holder.toLowerCase() === address!.toLowerCase();

      // Resolve the listing's offer id: verify the marker; on any
      // failure fall through to probing the holder's own open offers
      // (the indexer has no linked-loan column; getOfferLinkedLoanId
      // is the authoritative link). All recovery reads are BEST
      // EFFORT — a hiccup here must never discard the authoritative
      // lock verdict above (the card would silently vanish over a
      // live lock, resurrecting the listing form).
      let resolvedId: string | null = null;
      let verifyFailed = false;
      if (listed) {
        try {
          const candidateIds: string[] = [];
          if (markerId !== null) candidateIds.push(markerId);
          if (isHolder && probeBudgetRef.current > 0) {
            // Recovery probe: capped at the most recent offers, and
            // budgeted so a permanently-unresolvable listing doesn't
            // re-fire ~50 serial reads every 30s forever.
            probeBudgetRef.current -= 1;
            const page = await fetchOffersByCreator(readChain.chainId, address!, {
              limit: 50,
            });
            for (const o of page?.offers ?? []) {
              if (o.status === 'active' && o.offerType === 1) {
                const id = String(o.offerId);
                if (!candidateIds.includes(id)) candidateIds.push(id);
              }
            }
          }
          for (const id of candidateIds) {
            const linked = (await readClient!.readContract({
              address: diamond,
              abi: DIAMOND_ABI_VIEM,
              functionName: 'getOfferLinkedLoanId',
              args: [BigInt(id)],
            })) as bigint;
            if (linked === BigInt(loanId)) {
              resolvedId = id;
              break;
            }
          }
        } catch {
          resolvedId = null;
          verifyFailed = true;
        }
      }
      let createdAt = 0n;
      // #1848 — the same response carries the listing's expiry and whether a
      // buyer has accepted it; kept rather than narrowed away, so the cards can
      // tell a listing a buyer can still take from one that is merely locked.
      let record: { expiresAt: bigint; accepted: boolean } | null = null;
      if (resolvedId !== null) {
        try {
          const offer = (await readClient!.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getOfferDetails',
            args: [BigInt(resolvedId)],
          })) as {
            createdAt: bigint;
            expiresAt: number | bigint;
            accepted: boolean;
          };
          createdAt = offer.createdAt;
          record = { expiresAt: BigInt(offer.expiresAt), accepted: offer.accepted };
        } catch {
          record = null;
        }
      }
      const loanActive = live.status === LOAN_STATUS_ACTIVE;
      const { fillable, completable } = listed
        ? saleListingVerdicts({ loanActive, record, chainNow: latestBlock.timestamp })
        : { fillable: 'no' as const, completable: 'no' as const };

      return {
        listed,
        loanActive,
        isHolder,
        offerId: resolvedId,
        offerIdVerifyFailed: verifyFailed,
        expiresAt: record?.expiresAt ?? null,
        accepted: record?.accepted ?? null,
        fillable,
        completable,
        cancelUnlocked:
          resolvedId !== null &&
          record !== null &&
          latestBlock.timestamp >= createdAt + CANCEL_COOLDOWN_SECONDS,
      };
    },
  });

  // Recovery found the id but the marker didn't have it — persist.
  // Conversely, a marker that FAILED verification while a listing
  // stands is stale (cancel + relist from another device): clear it
  // so the next tick's probe can find the real one.
  // Deliberately an effect (#1520): this RECONCILES two external stores —
  // the device marker in localStorage and what the chain/indexer verified —
  // so it is synchronisation, not derived state. It cannot move into render:
  // the reconciled id is persisted, and it feeds this hook's query key, so a
  // render-derived value would leave the key pointing at the id it just
  // disproved. The cascade is one extra render on a rare reconciliation.
  useEffect(() => {
    const d = query.data;
    if (d?.listed && d.offerId !== null && d.offerId !== markerId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      remember(d.offerId);
    }
    // Only a SUCCESSFUL disproof clears the marker. A failed
    // verification leaves it alone — see `offerIdVerifyFailed`.
    if (
      d?.listed &&
      d.offerId === null &&
      !d.offerIdVerifyFailed &&
      markerId !== null
    ) {
      clear();
    }
  }, [query.data, markerId, remember, clear]);

  // The listing ended (accepted or cancelled elsewhere) while our
  // marker was set — surface the outcome once, then self-heal.
  const [endedNotice, setEndedNotice] = useState(false);
  useEffect(() => {
    const d = query.data;
    if (d !== undefined && !d.listed && markerId !== null) {
      // A LATCH, which is why deriving this during render is not an option
      // (#1520): the triggering condition stops holding the instant `clear()`
      // runs, so a derived value would flash on and off in the same pass. The
      // notice has to outlive its own cause and persist until the user
      // dismisses it via `clearEndedNotice`.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEndedNotice(true);
      clear();
    }
  }, [query.data, markerId, clear]);
  const clearEndedNotice = useCallback(() => setEndedNotice(false), []);

  return {
    state: query.data,
    /** Whether the LAST revalidation failed (Codex #1839 r9 P2).
     *
     *  TanStack retains the previous success through a failed refetch,
     *  so `state` alone cannot distinguish "the chain says no listing"
     *  from "the chain said no listing, and we have not been able to
     *  ask since". Callers that gate an ACTION on `listed === false`
     *  need the difference: another device can create a listing inside
     *  that window, and a cached clear would keep offering both sale
     *  paths on a position that is now locked. */
    isError: query.isError,
    /** TanStack's own fetch state, surfaced so a consumer can tell a
     *  settled answer from one whose background poll is still in
     *  flight (Codex #1858 r10). `state` and `isError` are both
     *  retained across a refetch, so neither can carry it. */
    fetchStatus: query.fetchStatus,
    endedNotice,
    clearEndedNotice,
    remember,
    clear,
  };
}
