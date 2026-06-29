/**
 * #600 — fetch every child loan spawned by an offer, for the OfferDetails page.
 *
 * A range / partial-fill offer can produce MANY loans (one offer → many fills).
 * The page previously linked only the single loan behind the offer's position
 * NFT (last-fill, last-write-wins). This hook surfaces the complete set.
 *
 * Source of truth = the indexer's activity feed. Every fill emits an
 * `OfferAccepted` event whose row carries BOTH `offer_id` and the child
 * `loan_id` (see the indexer's `pluckActivityRefs`), so `/activity?offerId=N&
 * kind=OfferAccepted` enumerates all children regardless of who currently holds
 * them — unlike the on-chain `offerIdToLoanId` map, which only holds the most
 * recent loan. Each loanId is then hydrated via `/loans/:id` and grouped through
 * the SAME `groupLoansByOffer` logic the Dashboard's "Loans by offer" uses, so
 * the per-group aggregates (total principal, weighted-avg rate, min HF, status
 * counts, collateral buckets) are computed identically.
 */
import { useEffect, useState } from 'react';
import { useReadChain } from '../contracts/useDiamond';
import {
  fetchActivity,
  fetchLoanById,
  indexedToLoanSummary,
} from '../lib/indexerClient';
import { groupLoansByOffer, type OfferGroup } from './useOfferGroupedLoans';
import type { LoanSummary } from '../types/loan';
import type { LoanRisk } from './useLoanRisks';

/** Risks only drive the group's `minHf` aggregate; OfferDetails doesn't compute
 *  live HF here, so the group reports `minHf = null` (rendered as "—"). */
const EMPTY_RISKS = new Map<string, LoanRisk>();
/** Bound the fan-out (activity pages × per-loan reads) for a pathologically
 *  large range offer. Beyond this the section reports a partial view. */
const MAX_CHILD_LOANS = 500;
const ACTIVITY_PAGE = 100;
const MAX_ACTIVITY_PAGES = 10;

interface UseOfferChildLoansResult {
  /** The single grouped row for this offer, or `null` until loaded / if none. */
  group: OfferGroup | null;
  /** Number of child loans found (drives the single-vs-multi fall-back). */
  count: number;
  loading: boolean;
  /** True when the fan-out hit `MAX_CHILD_LOANS` and the view is partial. */
  truncated: boolean;
}

export function useOfferChildLoans(
  offerId: bigint | null,
  /** 0 = lender offer (creator is lender), 1 = borrower offer. */
  offerType: number | null,
): UseOfferChildLoansResult {
  const chain = useReadChain();
  const [group, setGroup] = useState<OfferGroup | null>(null);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (offerId === null || offerType === null) {
      setGroup(null);
      setCount(0);
      setTruncated(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        // 1. Enumerate child loanIds from the offer's OfferAccepted activity.
        const loanIds = new Set<number>();
        let before: string | undefined;
        let hitCap = false;
        for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
          const res = await fetchActivity(chain.chainId, {
            offerId: Number(offerId),
            kind: 'OfferAccepted',
            limit: ACTIVITY_PAGE,
            before,
          });
          if (!res || res.events.length === 0) break;
          for (const ev of res.events) {
            if (ev.loanId !== null) loanIds.add(ev.loanId);
          }
          if (loanIds.size >= MAX_CHILD_LOANS) {
            hitCap = true;
            break;
          }
          if (!res.nextBefore) break;
          before = res.nextBefore;
        }
        if (cancelled) return;

        // 2. Hydrate each child loan → LoanSummary (creator-side role).
        const role: 'lender' | 'borrower' =
          offerType === 0 ? 'lender' : 'borrower';
        const ids = Array.from(loanIds).slice(0, MAX_CHILD_LOANS);
        const hydrated = await Promise.all(
          ids.map(async (id) => {
            const il = await fetchLoanById(chain.chainId, id);
            return il ? indexedToLoanSummary(il, role) : null;
          }),
        );
        if (cancelled) return;
        const summaries = hydrated.filter(
          (l): l is LoanSummary => l !== null,
        );

        // 3. Group through the shared logic → the single row for this offer.
        const groups = groupLoansByOffer(summaries, EMPTY_RISKS);
        const match = groups.find((g) => g.offerId === offerId) ?? null;
        setGroup(match);
        setCount(summaries.length);
        setTruncated(hitCap);
      } catch {
        if (!cancelled) {
          setGroup(null);
          setCount(0);
          setTruncated(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chain.chainId, offerId, offerType]);

  return { group, count, loading, truncated };
}
