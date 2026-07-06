/**
 * Page-owned pending-sale state for the lender Option-2 listing
 * (createLoanSaleOffer). Unlike the refinance marker, EXISTENCE is a
 * pure chain read — `positionLock(lenderTokenId) ==
 * EarlyWithdrawalSale` is authoritative — so a listing made on
 * another device still shows here. The device-local marker remembers
 * the offer id (needed for cancel and for the shortfall leg of the
 * funding watch; there is no on-chain loanId→saleOfferId view),
 * verified live via getOfferLinkedLoanId before it is trusted; when
 * it is missing the hook attempts RECOVERY by probing the connected
 * wallet's own open offers for one linked to this loan, and if that
 * fails the funding verdict is reported as UNKNOWN — never a false
 * green computed from the wrong rate.
 *
 * Funding watch: the buyer's accept pulls max(accrued-at-acceptance,
 * rate shortfall) from the SELLER's wallet via the standing
 * approval. `accrued` uses RAW elapsed seconds (the facet never
 * clamps it), so a listing that outlives the interest window keeps
 * needing more — the standing approval is sized generously
 * (full-window interest + a re-accrual pad) and the watch + restore
 * action cover the long tail. All money math is
 * `sellerEconomics` — the single facet-exact mirror.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { erc20Abi } from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import {
  BASIS_POINTS,
  CANCEL_COOLDOWN_SECONDS,
  LOAN_STATUS_ACTIVE,
  SECONDS_PER_YEAR,
  interestRemainingDaysOf,
  readLoanLive,
  sellerEconomics,
  type LoanLive,
} from '../contracts/loanLive';
import { fetchOffersByCreator } from './indexer';
import { makePendingMarkerStore } from '../lib/pendingMarker';
import { useActiveChain } from '../chain/useActiveChain';
import { idleAware } from '../lib/idle';

/** LibERC721.LockReason.EarlyWithdrawalSale. */
export const LOCK_EARLY_WITHDRAWAL_SALE = 2;

/** Extra accrual headroom the standing approval carries past the
 *  interest window's total — the listing never expires on-chain, so
 *  an accept can land after the window ends and the (unclamped)
 *  accrued keeps growing. Beyond this pad the funding watch + the
 *  restore action are the safety net. */
const REACCRUAL_PAD_DAYS = 30n;

/** The standing-approval target: covers the whole interest window's
 *  accrual PLUS the re-accrual pad, or the current shortfall if
 *  larger. NOT a forever bound — see REACCRUAL_PAD_DAYS. */
export function saleSettlementBound(
  live: LoanLive,
  saleRateBps: bigint,
  chainNow: bigint,
): bigint {
  const econ = sellerEconomics(live, saleRateBps, chainNow);
  const denom = SECONDS_PER_YEAR * BASIS_POINTS;
  const paddedWindowSecs =
    (interestRemainingDaysOf(live) + REACCRUAL_PAD_DAYS) * 86_400n;
  const paddedAccrual =
    (live.principal * live.interestRateBps * paddedWindowSecs) / denom;
  return paddedAccrual > econ.shortfall ? paddedAccrual : econ.shortfall;
}

/** What a buyer's acceptance would pull RIGHT NOW. */
export function saleSettlementNow(
  live: LoanLive,
  saleRateBps: bigint,
  chainNow: bigint,
): bigint {
  return sellerEconomics(live, saleRateBps, chainNow).cost;
}

const marker = makePendingMarkerStore('alpha02.loanSaleOffer');

export interface LoanSalePendingState {
  /** The lender NFT is lock-tagged for a sale — a listing exists. */
  listed: boolean;
  /** The loan is still Active — a settled loan's listing can never
   *  complete (accepts revert); cancel-to-unlock is the only move. */
  loanActive: boolean;
  /** Connected wallet currently HOLDS the lender NFT — the only
   *  wallet the settlement pull binds to. Funding legs and the
   *  cancel/restore actions are meaningless for anyone else. */
  isHolder: boolean;
  /** Live-verified listing offer id (marker or recovered); null when
   *  unknown — cancel is unavailable and funding is UNKNOWN then. */
  offerId: string | null;
  /** The listing's sale rate (bps); null when the id is unknown. */
  saleRateBps: bigint | null;
  /** Chain time says the cancel cooldown has elapsed. */
  cancelUnlocked: boolean;
  /** What acceptance would pull right now / the approval target.
   *  Zero + fundingKnown=false when the sale rate is unknown. */
  requiredNow: bigint;
  requiredBound: bigint;
  /** False when the listing's rate couldn't be determined — the
   *  watch must show "can't verify", never a false green. */
  fundingKnown: boolean;
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
  // The recovery probe is expensive (indexer page + serial link
  // reads) — budget a few attempts per (chain, loan, wallet) episode
  // instead of re-firing on every 30s tick forever.
  const probeBudgetRef = useRef(3);

  useEffect(() => {
    setMarkerId(marker.read(readChain.chainId, loanId));
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
    // Runs for the LENDER-side viewer (the only audience of the
    // card/watch) or whenever this device holds a marker — never for
    // borrowers/spectators, whose wallets the funding legs would
    // misread anyway.
    enabled:
      (enabled || markerId !== null) &&
      Boolean(readClient) &&
      Boolean(lenderTokenId) &&
      Boolean(principalAsset) &&
      /^[1-9]\d*$/.test(lenderTokenId ?? ''),
    refetchInterval: idleAware(30_000),
    queryFn: async (): Promise<LoanSalePendingState> => {
      const diamond = readChain.diamondAddress;
      const [lock, live, latestBlock, allowance, balance, holder] =
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
      // The settlement pull binds to the CURRENT lender-NFT holder —
      // funding math and card actions for any other connected wallet
      // would be wrong (and Restore would grant a dangling approval
      // from a wallet the facet never pulls from).
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
        }
      }
      let saleRateBps: bigint | null = null;
      let createdAt = 0n;
      if (resolvedId !== null) {
        try {
          const offer = (await readClient!.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getOfferDetails',
            args: [BigInt(resolvedId)],
          })) as { interestRateBps: number; createdAt: bigint };
          saleRateBps = BigInt(offer.interestRateBps);
          createdAt = offer.createdAt;
        } catch {
          saleRateBps = null;
        }
      }

      const fundingKnown = isHolder && listed && saleRateBps !== null;
      const requiredNow = fundingKnown
        ? saleSettlementNow(live, saleRateBps!, latestBlock.timestamp)
        : 0n;
      const requiredBound = fundingKnown
        ? saleSettlementBound(live, saleRateBps!, latestBlock.timestamp)
        : 0n;
      return {
        listed,
        loanActive: live.status === LOAN_STATUS_ACTIVE,
        isHolder,
        offerId: resolvedId,
        saleRateBps,
        cancelUnlocked:
          resolvedId !== null &&
          saleRateBps !== null &&
          latestBlock.timestamp >= createdAt + CANCEL_COOLDOWN_SECONDS,
        requiredNow,
        requiredBound,
        fundingKnown,
        // The funding watch only matters while the sale can still
        // complete — a settled loan's listing is cancel-only.
        allowanceShort:
          fundingKnown &&
          live.status === LOAN_STATUS_ACTIVE &&
          allowance < requiredNow,
        balanceShort:
          fundingKnown &&
          live.status === LOAN_STATUS_ACTIVE &&
          balance < requiredNow,
      };
    },
  });

  // Recovery found the id but the marker didn't have it — persist.
  // Conversely, a marker that FAILED verification while a listing
  // stands is stale (cancel + relist from another device): clear it
  // so the next tick's probe can find the real one.
  useEffect(() => {
    const d = query.data;
    if (d?.listed && d.offerId !== null && d.offerId !== markerId) {
      remember(d.offerId);
    }
    if (d?.listed && d.offerId === null && markerId !== null) {
      clear();
    }
  }, [query.data, markerId, remember, clear]);

  // The listing ended (accepted or cancelled elsewhere) while our
  // marker was set — surface the outcome once, then self-heal.
  const [endedNotice, setEndedNotice] = useState(false);
  useEffect(() => {
    const d = query.data;
    if (d !== undefined && !d.listed && markerId !== null) {
      setEndedNotice(true);
      clear();
    }
  }, [query.data, markerId, clear]);
  const clearEndedNotice = useCallback(() => setEndedNotice(false), []);

  return {
    state: query.data,
    endedNotice,
    clearEndedNotice,
    remember,
    clear,
  };
}
