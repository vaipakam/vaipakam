/**
 * react-query hooks over the indexer client.
 *
 * Loading contract every page relies on:
 *   - `data === undefined`  → still loading (show a spinner)
 *   - `data === null`       → indexer unavailable (show "couldn't load",
 *                             NEVER an empty-market message — that
 *                             distinction is what fixes the
 *                             "No Open Offers / 6 hidden" class of bug
 *                             from the 2026-07-02 naive-user audit)
 *   - `data === {...}`      → real result (empty arrays mean truly empty)
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';
import {
  fetchActiveOffers,
  fetchLoanById,
  fetchLoansByBorrower,
  fetchLoansByLender,
  fetchOfferById,
  fetchOffersByCreator,
  fetchOffersByCurrentHolder,
  type IndexedLoan,
  type IndexedOffer,
} from './indexer';
import { readLoanRowLive } from './liveLoanRow';

const REFRESH_MS = 30_000;

/** Open offers on the current read chain (both sides). One shared
 *  cache entry for every surface (Offer Book, guided flows, rentals).
 *  Follows the indexer's `nextBefore` cursor up to a page cap so a
 *  busy book doesn't falsely report "no matching offers" for offers
 *  sitting past the first page. */
const ACTIVE_OFFERS_PAGE = 100;
const ACTIVE_OFFERS_MAX_PAGES = 5;

export function useActiveOffers() {
  const { readChain } = useActiveChain();
  return useQuery({
    queryKey: ['activeOffers', readChain.chainId],
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<IndexedOffer[] | null> => {
      // ANY page failing (including later cursor pages) → unavailable,
      // and so does hitting the page cap with a cursor still open —
      // publishing a confident half-book would let guided matching say
      // "no matching offers" while the match sits on the missing page.
      const all: IndexedOffer[] = [];
      let before: number | undefined;
      for (let i = 0; i < ACTIVE_OFFERS_MAX_PAGES; i++) {
        const page = await fetchActiveOffers(readChain.chainId, {
          limit: ACTIVE_OFFERS_PAGE,
          before,
        });
        if (page === null) return null;
        all.push(...page.offers);
        if (page.nextBefore === null) return all;
        before = page.nextBefore;
      }
      return null; // cap reached with more pages remaining → truncated
    },
  });
}

export interface PositionLoan extends IndexedLoan {
  role: 'lender' | 'borrower';
}

const MY_PAGES_MAX = 5;

/** Follow a cursor-paginated fetcher to exhaustion (page cap as a
 *  runaway bound). Returns null on ANY page failure — a partial list
 *  rendered as complete is exactly the dishonesty the null contract
 *  exists to prevent. */
export async function fetchAllPages<T>(
  fetchPage: (
    before: number | undefined,
  ) => Promise<{ rows: T[]; nextBefore: number | null } | null>,
): Promise<T[] | null> {
  const all: T[] = [];
  let before: number | undefined;
  for (let i = 0; i < MY_PAGES_MAX; i++) {
    const page = await fetchPage(before);
    if (page === null) return null;
    all.push(...page.rows);
    if (page.nextBefore === null) return all;
    before = page.nextBefore;
  }
  return null; // cap hit with a cursor still open — truncated ≠ complete
}

/** Every loan where the connected wallet is lender or borrower,
 *  newest first. `null` = indexer unavailable. Follows pagination so
 *  wallets with more than one page of positions see all of them. */
export function useMyLoans() {
  const { readChain, address } = useActiveChain();
  return useQuery({
    queryKey: ['myLoans', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address),
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<PositionLoan[] | null> => {
      if (!address) return [];
      const [asLender, asBorrower] = await Promise.all([
        fetchAllPages<IndexedLoan>((before) =>
          fetchLoansByLender(readChain.chainId, address, { limit: 100, before }).then(
            (p) => (p === null ? null : { rows: p.loans, nextBefore: p.nextBefore }),
          ),
        ),
        fetchAllPages<IndexedLoan>((before) =>
          fetchLoansByBorrower(readChain.chainId, address, { limit: 100, before }).then(
            (p) => (p === null ? null : { rows: p.loans, nextBefore: p.nextBefore }),
          ),
        ),
      ]);
      // EITHER side failing means the list would be silently partial —
      // that's "unavailable", never a confident half-answer.
      if (asLender === null || asBorrower === null) return null;
      const rows: PositionLoan[] = [
        ...asLender.map((l) => ({ ...l, role: 'lender' as const })),
        ...asBorrower.map((l) => ({ ...l, role: 'borrower' as const })),
      ];
      // A wallet can be both sides of one loan in odd cases; dedupe by
      // loanId+role and sort newest first.
      const seen = new Set<string>();
      return rows
        .filter((l) => {
          const key = `${l.loanId}:${l.role}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => b.startAt - a.startAt);
    },
  });
}

/** One offer by id on the read chain (deep-link target from the
 *  Offer Book's "Use this offer" action). */
export function useOffer(offerId: number | undefined) {
  const { readChain } = useActiveChain();
  return useQuery({
    queryKey: ['offer', readChain.chainId, offerId],
    enabled: offerId !== undefined && Number.isFinite(offerId),
    refetchInterval: REFRESH_MS,
    queryFn: () => fetchOfferById(readChain.chainId, offerId!),
  });
}

/** One loan by id on the read chain. */
export function useLoan(loanId: number | undefined) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['loan', readChain.chainId, loanId],
    enabled: loanId !== undefined && Number.isFinite(loanId),
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<IndexedLoan | null> => {
      const row = await fetchLoanById(readChain.chainId, loanId!);
      if (row) return row;
      // Indexer miss (lag on a brand-new loan, or indexer down) — fall
      // back to the live chain read so the detail page a chain-only
      // Claim Center entry deep-links to actually renders (#982
      // review). A revert (no such loan) or transport failure keeps
      // the indexer verdict: null = unavailable/not found.
      if (!publicClient) return null;
      try {
        return await readLoanRowLive(
          publicClient,
          readChain.diamondAddress,
          readChain.chainId,
          loanId!,
        );
      } catch {
        return null;
      }
    },
  });
}

/** Open offers the wallet is involved in: UNION of offers it CREATED
 *  (cancelOffer authorizes only the creator until expiry —
 *  OfferCancelFacet #195) and offers whose position NFT it currently
 *  HOLDS (visibility for secondary-market recipients). The UI keys
 *  the cancel action on `offer.creator === wallet`. */
export function useMyOffers() {
  const { readChain, address } = useActiveChain();
  return useQuery({
    queryKey: ['myOffers', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address),
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<IndexedOffer[] | null> => {
      if (!address) return [];
      const [created, held] = await Promise.all([
        fetchAllPages<IndexedOffer>((before) =>
          fetchOffersByCreator(readChain.chainId, address, {
            limit: 100,
            before,
          }).then((p) =>
            p === null ? null : { rows: p.offers, nextBefore: p.nextBefore },
          ),
        ),
        fetchAllPages<IndexedOffer>((before) =>
          fetchOffersByCurrentHolder(readChain.chainId, address, {
            limit: 100,
            before,
          }).then((p) =>
            p === null ? null : { rows: p.offers, nextBefore: p.nextBefore },
          ),
        ),
      ]);
      if (created === null || held === null) return null;
      const seen = new Set<number>();
      return [...created, ...held].filter((o) => {
        if (o.status !== 'active' || seen.has(o.offerId)) return false;
        seen.add(o.offerId);
        return true;
      });
    },
  });
}

// `useMyClaimables` now lives in `./claimables` and is on-chain-
// authoritative (issue #921 item 7 / #958): the indexer stays the fast
// candidate layer via `useMyLoans`, and `getClaimable` is the authority.
// Imported directly from `./claimables` by call sites (one-way dep, no
// cycle with this module).
