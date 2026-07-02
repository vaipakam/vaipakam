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
import { useActiveChain } from '../chain/useActiveChain';
import {
  fetchActiveOffers,
  fetchClaimables,
  fetchLoanById,
  fetchLoansByBorrower,
  fetchLoansByLender,
  fetchOffersByCreator,
  type IndexedLoan,
  type IndexedOffer,
} from './indexer';

const REFRESH_MS = 30_000;

/** Open offers on the current read chain (both sides). */
export function useActiveOffers(limit = 50) {
  const { readChain } = useActiveChain();
  return useQuery({
    queryKey: ['activeOffers', readChain.chainId, limit],
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<IndexedOffer[] | null> => {
      const page = await fetchActiveOffers(readChain.chainId, { limit });
      return page ? page.offers : null;
    },
  });
}

export interface PositionLoan extends IndexedLoan {
  role: 'lender' | 'borrower';
}

/** Every loan where the connected wallet is lender or borrower,
 *  newest first. `null` = indexer unavailable. */
export function useMyLoans() {
  const { readChain, address } = useActiveChain();
  return useQuery({
    queryKey: ['myLoans', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address),
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<PositionLoan[] | null> => {
      if (!address) return [];
      const [asLender, asBorrower] = await Promise.all([
        fetchLoansByLender(readChain.chainId, address),
        fetchLoansByBorrower(readChain.chainId, address),
      ]);
      if (asLender === null && asBorrower === null) return null;
      const rows: PositionLoan[] = [
        ...(asLender?.loans ?? []).map((l) => ({ ...l, role: 'lender' as const })),
        ...(asBorrower?.loans ?? []).map((l) => ({ ...l, role: 'borrower' as const })),
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

/** One loan by id on the read chain. */
export function useLoan(loanId: number | undefined) {
  const { readChain } = useActiveChain();
  return useQuery({
    queryKey: ['loan', readChain.chainId, loanId],
    enabled: loanId !== undefined && Number.isFinite(loanId),
    refetchInterval: REFRESH_MS,
    queryFn: () => fetchLoanById(readChain.chainId, loanId!),
  });
}

/** The connected wallet's open offers. */
export function useMyOffers() {
  const { readChain, address } = useActiveChain();
  return useQuery({
    queryKey: ['myOffers', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address),
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<IndexedOffer[] | null> => {
      if (!address) return [];
      const page = await fetchOffersByCreator(readChain.chainId, address);
      if (page === null) return null;
      return page.offers.filter((o) => o.status === 'active');
    },
  });
}

/** Claimable loans for the connected wallet, tagged with role. */
export function useMyClaimables() {
  const { readChain, address } = useActiveChain();
  return useQuery({
    queryKey: ['claimables', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address),
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<PositionLoan[] | null> => {
      if (!address) return [];
      const res = await fetchClaimables(readChain.chainId, address);
      if (res === null) return null;
      return [
        ...res.asLender.map((l) => ({ ...l, role: 'lender' as const })),
        ...res.asBorrower.map((l) => ({ ...l, role: 'borrower' as const })),
      ];
    },
  });
}
