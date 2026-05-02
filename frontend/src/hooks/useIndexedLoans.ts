/**
 * T-041 Phase B — worker-cached loan list with browser fallback.
 *
 * Three variants exposed:
 *   - `useIndexedActiveLoans()` — protocol-wide active loans, paged
 *     newest-first. Powers Risk Watch + Analytics.
 *   - `useIndexedLoansForWallet(address)` — wallet's loans on either
 *     side. Powers the Dashboard "Your Loans" card and the wallet
 *     menu's "My Loans" view. Returns lender-side + borrower-side
 *     concatenated and de-duplicated.
 *
 * All variants follow the same `{ source, loans, loading }`
 * contract as `useIndexedActiveOffers`. When `source === 'fallback'`
 * the caller falls through to the existing `useLogIndex` flow; the
 * worker is a CACHE, not an oracle.
 */

import { useEffect, useState } from 'react';
import {
  fetchActiveLoans,
  fetchLoansByBorrower,
  fetchLoansByLender,
  type IndexedLoan,
} from '../lib/indexerClient';
import { useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';

const PAGE_LIMIT = 200;
const REFRESH_MS = 30_000;

interface UseIndexedLoansResult {
  loans: IndexedLoan[] | null;
  source: 'indexer' | 'fallback' | null;
  loading: boolean;
}

/** Per-loan role tag for the wallet variant. The by-lender /
 *  by-borrower endpoints already live-filtered via ownerOf, so the
 *  side that returned a row IS the wallet's current role on it. */
export interface IndexedLoanWithRole extends IndexedLoan {
  role: 'lender' | 'borrower';
}

interface UseIndexedLoansForWalletResult {
  loans: IndexedLoanWithRole[] | null;
  source: 'indexer' | 'fallback' | null;
  loading: boolean;
}

export function useIndexedActiveLoans(): UseIndexedLoansResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const [loans, setLoans] = useState<IndexedLoan[] | null>(null);
  const [source, setSource] = useState<'indexer' | 'fallback' | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      const page = await fetchActiveLoans(chainId, { limit: PAGE_LIMIT });
      if (cancelled) return;
      if (page) {
        setLoans(page.loans);
        setSource('indexer');
      } else {
        setLoans(null);
        setSource('fallback');
      }
      setLoading(false);
    }
    void tick();
    const interval = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [chainId]);

  return { loans, source, loading };
}

export function useIndexedLoansForWallet(
  address: string | undefined,
): UseIndexedLoansForWalletResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const [loans, setLoans] = useState<IndexedLoanWithRole[] | null>(null);
  const [source, setSource] = useState<'indexer' | 'fallback' | null>(null);
  const [loading, setLoading] = useState(Boolean(address));

  useEffect(() => {
    if (!address) {
      setLoans(null);
      setSource(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function tick() {
      const wallet = address as string;
      // Run both sides in parallel — typical wallet has loans on
      // ≤1 side, so the second call usually returns an empty list.
      // Both endpoints already live-filter via multicall(ownerOf), so
      // the wallet's role on each returned loan is whichever side
      // produced it.
      const [lenderPage, borrowerPage] = await Promise.all([
        fetchLoansByLender(chainId, wallet, { limit: PAGE_LIMIT }),
        fetchLoansByBorrower(chainId, wallet, { limit: PAGE_LIMIT }),
      ]);
      if (cancelled) return;
      if (!lenderPage || !borrowerPage) {
        setLoans(null);
        setSource('fallback');
        setLoading(false);
        return;
      }
      const seen = new Set<number>();
      const merged: IndexedLoanWithRole[] = [];
      for (const loan of lenderPage.loans) {
        if (seen.has(loan.loanId)) continue;
        seen.add(loan.loanId);
        merged.push({ ...loan, role: 'lender' });
      }
      for (const loan of borrowerPage.loans) {
        // A wallet that holds BOTH the lender NFT and the borrower
        // NFT for the same loan (rare but possible after secondary
        // trades) gets the lender-side row first; the borrower row
        // is dropped via the seen set. Dashboard renders one row
        // per loan; the dual-role case shows up as 'lender' which
        // is fine — the loan-detail page surfaces both sides.
        if (seen.has(loan.loanId)) continue;
        seen.add(loan.loanId);
        merged.push({ ...loan, role: 'borrower' });
      }
      merged.sort((a, b) => b.loanId - a.loanId);
      setLoans(merged);
      setSource('indexer');
      setLoading(false);
    }
    void tick();
    const interval = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [chainId, address]);

  return { loans, source, loading };
}
