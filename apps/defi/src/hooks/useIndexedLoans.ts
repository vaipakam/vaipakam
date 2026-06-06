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

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Address } from 'viem';
import {
  fetchActiveLoans,
  fetchLoansByBorrower,
  fetchLoansByLender,
  type IndexedLoan,
} from '../lib/indexerClient';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { useLiveWatermark } from './useLiveWatermark';
import { watermarkPolicy } from './watermarkPolicy';
import { useDataFreshness } from '../context/DataFreshnessContext';
import {
  chunkedGetLogs,
  decodeLoanDelta,
  TOPIC0,
} from '../lib/rpcCatchUp';

const PAGE_LIMIT = 200;

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
  /** Imperative trigger — re-runs the lender + borrower indexer
   *  fetches in parallel. Wired into the Dashboard rescan button so
   *  users who want fresh data right now don't have to wait for the
   *  next watermark probe. */
  refetch: () => Promise<void>;
}

export function useIndexedActiveLoans(): UseIndexedLoansResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const diamond = chain.diamondAddress;
  const publicClient = useDiamondPublicClient();
  // Slower-moving surface (Risk Watch, Analytics, Dashboard) — 20 s
  // probe is enough to keep counter-driven changes visible without
  // the OfferBook's 5 s cadence. ~3 probes/min on idle.
  const { version, snapshot } = useLiveWatermark(watermarkPolicy('warm'));
  // `fallbackVersion` covers the indexer-unreachable edge case — see
  // `DataFreshnessContext` for the trigger logic. Without it, a loan
  // repayment or default (events that DON'T bump `nextLoanId`) would
  // stay invisible on Risk Watch / Analytics until someone initiates a
  // new loan.
  const { report, fallbackVersion } = useDataFreshness();
  const [loans, setLoans] = useState<IndexedLoan[] | null>(null);
  const [source, setSource] = useState<'indexer' | 'fallback' | null>(null);
  const [loading, setLoading] = useState(true);

  // Snapshot in a ref so the watermark probe's 5 s tick doesn't
  // refire this effect every probe (the snapshot's `safeBlock`
  // changes every block even when the create counters didn't move).
  // Refetches now fire only on actual `version` advance.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      report('activeLoans', { loading: true });
      const page = await fetchActiveLoans(chainId, { limit: PAGE_LIMIT });
      if (cancelled) return;
      if (!page) {
        setLoans(null);
        setSource('fallback');
        setLoading(false);
        report('activeLoans', { loading: false });
        return;
      }
      // RPC catch-up over the indexer-tail → safe-head gap. Drops
      // loans that closed (repaid / defaulted) in the gap so Risk
      // Watch + Analytics don't show a stale "active" row that's
      // actually been settled in the last 60 seconds.
      let terminalIds = new Set<string>();
      let catchUpFrontier: bigint | undefined;
      const fromBlock =
        page.loans.length > 0
          ? BigInt(page.loans.reduce((m, l) => (l.startBlock > m ? l.startBlock : m), 0))
          : 0n;
      const liveSnapshot = snapshotRef.current;
      if (publicClient && diamond && liveSnapshot && liveSnapshot.safeBlock > fromBlock) {
        const logs = await chunkedGetLogs(publicClient, {
          fromBlock: fromBlock + 1n,
          toBlock: liveSnapshot.safeBlock,
          address: diamond as Address,
          topics: [
            // T-090 Sub 3 — SwapToRepayExecuted is also a terminal
            // close (Active → Repaid) and must filter the loan out of
            // the active-loans surface during the near-realtime
            // catch-up window.
            [
              TOPIC0.LOAN_REPAID,
              TOPIC0.LOAN_DEFAULTED,
              TOPIC0.SWAP_TO_REPAY_EXECUTED,
            ],
          ],
        });
        if (cancelled) return;
        const delta = decodeLoanDelta(logs);
        terminalIds = new Set(delta.terminal.map((id) => id.toString()));
        catchUpFrontier = liveSnapshot.safeBlock;
      }
      setLoans(page.loans.filter((l) => !terminalIds.has(l.loanId.toString())));
      setSource('indexer');
      setLoading(false);
      report('activeLoans', {
        loading: false,
        frontier: catchUpFrontier !== undefined ? Number(catchUpFrontier) : undefined,
      });
    }
    void tick();
    return () => {
      cancelled = true;
    };
  }, [chainId, version, publicClient, diamond, report, fallbackVersion]);

  return { loans, source, loading };
}

export function useIndexedLoansForWallet(
  address: string | undefined,
): UseIndexedLoansForWalletResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  // Same rationale as `useIndexedActiveLoans` — Dashboard's "Your
  // Loans" card uses the 20 s slower-page cadence.
  const { version } = useLiveWatermark(watermarkPolicy('warm'));
  const { report } = useDataFreshness();
  const [loans, setLoans] = useState<IndexedLoanWithRole[] | null>(null);
  const [source, setSource] = useState<'indexer' | 'fallback' | null>(null);
  const [loading, setLoading] = useState(Boolean(address));

  const tick = useCallback(
    async (signal?: { cancelled: boolean }) => {
      if (!address) {
        setLoans(null);
        setSource(null);
        setLoading(false);
        report('roleLoans', { loading: false });
        return;
      }
      report('roleLoans', { loading: true });
      const wallet = address;
      // Run both sides in parallel — typical wallet has loans on
      // ≤1 side, so the second call usually returns an empty list.
      // Both endpoints already live-filter via multicall(ownerOf), so
      // the wallet's role on each returned loan is whichever side
      // produced it.
      const [lenderPage, borrowerPage] = await Promise.all([
        fetchLoansByLender(chainId, wallet, { limit: PAGE_LIMIT }),
        fetchLoansByBorrower(chainId, wallet, { limit: PAGE_LIMIT }),
      ]);
      if (signal?.cancelled) return;
      if (!lenderPage || !borrowerPage) {
        setLoans(null);
        setSource('fallback');
        setLoading(false);
        report('roleLoans', { loading: false });
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
      // No RPC tail-scan here — the by-lender / by-borrower endpoints
      // are server-side ownerOf-filtered and return current state as of
      // the indexer's lastBlock (already folded into the registry by
      // useOfferStats). So this hook reports only its loading flag.
      report('roleLoans', { loading: false });
    },
    [chainId, address, report],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void tick(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [version, tick]);

  const refetch = useCallback(async () => {
    await tick();
  }, [tick]);

  return { loans, source, loading, refetch };
}
