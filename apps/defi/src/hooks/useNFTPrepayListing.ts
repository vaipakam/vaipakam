import { useCallback, useEffect, useState } from 'react';
import { useDiamondContract } from '../contracts/useDiamond';
import { useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { fetchLoanById, type IndexedPrepayListing } from '../lib/indexerClient';
import { decodeContractError } from '@vaipakam/lib/decodeContractError';
import { beginStep } from '../lib/journeyLog';

/**
 * T-086 step 13 — borrower-side controller for the Seaport prepay-listing flow.
 *
 * Reads the live listing state (orderHash, askPrice, conduit, lister, posted /
 * updated anchors, grace boundary) from the indexer's `/loans/:id` join and
 * exposes the three borrower entry points on the diamond:
 *
 *   • `postPrepayListing(loanId, askPrice, salt, conduitKey)`
 *   • `updatePrepayListing(loanId, askPrice, salt, conduitKey)`
 *   • `cancelPrepayListing(loanId)`
 *
 * Reading from the indexer rather than from `getPrepayListingOrderHash` keeps
 * the off-chain detail (askPrice, conduit, postedAt) co-located with the hash
 * — those fields only live in event logs / D1, never in diamond storage.
 *
 * The hook is intentionally read-only when wallet's chain has no diamond
 * deployed (`useDiamondContract` returns a write-disabled handle in that
 * case); the action functions then throw the same "wallet not connected"
 * error the rest of the diamond proxy raises.
 */
export interface UseNFTPrepayListingResult {
  /** Indexer-derived live listing state. `null` while loading, `undefined`
   *  when no listing exists for the loan. */
  listing: IndexedPrepayListing | null | undefined;
  loading: boolean;
  reload: () => Promise<void>;

  // Action surface.
  actionLoading: boolean;
  actionError: string | null;
  txHash: string | null;

  /** Returns `true` when the tx confirmed AND the post-write refresh
   *  (indexer + optional `onAfterSuccess`) ran cleanly; `false` on any
   *  failure (signer rejection, contract revert, refresh blow-up).
   *  Callers gate any "fire-and-forget" follow-up effects on the
   *  boolean — the hook itself already touches `actionError` /
   *  `txHash` / `listing` so no UI state needs the caller's help. */
  postPrepayListing: (
    loanId: bigint,
    askPrice: bigint,
    salt: bigint,
    conduitKey: `0x${string}`,
  ) => Promise<boolean>;
  updatePrepayListing: (
    loanId: bigint,
    newAskPrice: bigint,
    newSalt: bigint,
    newConduitKey: `0x${string}`,
  ) => Promise<boolean>;
  cancelPrepayListing: (loanId: bigint) => Promise<boolean>;
}

export interface UseNFTPrepayListingOptions {
  /** Optional side-effect to run AFTER the hook's own indexer-reload
   *  completes on a successful write. Used by the loan-details page to
   *  also refresh the on-chain loan + holders state (the `useLoan`
   *  reload) so every consumer the page wires sees the post-write
   *  reality in lockstep. The callback is awaited; throws are caught
   *  and logged via the journey step but do NOT fail the write — the
   *  on-chain tx already succeeded by the time we get here. */
  onAfterSuccess?: () => void | Promise<void>;
}

export function useNFTPrepayListing(
  loanId: string | undefined,
  options?: UseNFTPrepayListingOptions,
): UseNFTPrepayListingResult {
  const diamond = useDiamondContract();
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const onAfterSuccess = options?.onAfterSuccess;

  const [listing, setListing] = useState<IndexedPrepayListing | null | undefined>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!loanId) return;
    setLoading(true);
    try {
      const row = await fetchLoanById(chainId, Number(loanId));
      // `row === null` → indexer transient unavailable; keep last-good
      // rather than blanking the banner mid-flight. Same staleness
      // handling useRecentLoans uses.
      if (row) setListing(row.prepayListing);
    } finally {
      setLoading(false);
    }
  }, [chainId, loanId]);

  useEffect(() => {
    let cancelled = false;
    // Clear stale state from the previous loan / chain immediately —
    // BEFORE the new fetch starts — so the banner + action mode for
    // the new (loanId, chainId) tuple can't briefly inherit the
    // previous loan's listing while the indexer request is in flight.
    // Codex round-2 P2 fix on PR #308.
    setListing(null);
    void (async () => {
      if (!loanId) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const row = await fetchLoanById(chainId, Number(loanId));
        if (!cancelled && row) setListing(row.prepayListing);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chainId, loanId]);

  // ── Action implementations ────────────────────────────────────────────
  // The diamond proxy returns `{ hash, wait }` where `wait` throws on
  // on-chain revert (see useDiamond.ts:171); the `try/catch` flow below
  // surfaces both kinds of failure (signer rejection + on-chain revert)
  // through `actionError` in the user-friendly decoded form.

  /** After a successful tx, the indexer worker is event-driven and
   *  may not have ingested the write by the time we hit `/loans/:id`.
   *  Poll up to ~15 s for the listing JOIN to reflect the expected
   *  transition (post → listing exists; cancel → listing gone), with
   *  a short backoff. Returns the final indexer view (which the
   *  caller writes into `listing` state). If the indexer never
   *  catches up within the budget we return whatever it last gave us
   *  — the on-chain tx already succeeded, so this is a UI freshness
   *  guarantee, not a correctness one. Codex round-2 P2 fix on PR
   *  #308. */
  const waitForIndexer = useCallback(
    async (
      flow: 'postPrepayListing' | 'updatePrepayListing' | 'cancelPrepayListing',
    ): Promise<IndexedPrepayListing | null | undefined> => {
      if (!loanId) return undefined;
      // 1 s, 2 s, 3 s, 4 s, 5 s → ~15 s total worst case. Short enough
      // to keep the user in-flow; long enough for a healthy indexer
      // (block-time-aligned scans) to catch up.
      const delays = [1000, 2000, 3000, 4000, 5000];
      let lastRow: IndexedPrepayListing | null | undefined = undefined;
      for (const d of delays) {
        await new Promise((r) => setTimeout(r, d));
        const row = await fetchLoanById(chainId, Number(loanId));
        if (!row) continue;
        lastRow = row.prepayListing;
        // For `cancel`, expected state is "listing gone" (undefined).
        // For `post` / `update`, expected state is "listing present" —
        // we don't know the new orderHash by the time the diamond
        // call resolves (it returns the hash but we don't thread it
        // through this helper), so "present" is good enough; the next
        // user-driven action will fetch the up-to-date hash. The
        // alternative — passing newOrderHash down — couples the hook
        // tighter to the diamond return shape without a real benefit.
        if (flow === 'cancelPrepayListing') {
          if (!row.prepayListing) return undefined;
        } else {
          if (row.prepayListing) return row.prepayListing;
        }
      }
      return lastRow;
    },
    [chainId, loanId],
  );

  const runWrite = useCallback(
    async (
      flow: 'postPrepayListing' | 'updatePrepayListing' | 'cancelPrepayListing',
      loanIdArg: bigint,
      submit: () => Promise<{ hash: string; wait: () => Promise<unknown> }>,
    ): Promise<boolean> => {
      setActionLoading(true);
      setActionError(null);
      setTxHash(null);
      const step = beginStep({
        area: 'prepay-listing',
        flow,
        step: 'submit-tx',
        loanId: loanIdArg.toString(),
      });
      try {
        const tx = await submit();
        setTxHash(tx.hash);
        await tx.wait();
        // Poll the indexer for the expected transition; this writes
        // the freshest listing into `listing` state so the banner
        // and child action mode flip atomically with the tx.
        const fresh = await waitForIndexer(flow);
        setListing(fresh);
        // Fire the parent's refresh hook AFTER the indexer poll — so
        // the parent's on-chain `getLoanDetails` read and the
        // indexer's listing JOIN both reflect the post-write reality
        // by the time any sibling re-render kicks in.
        if (onAfterSuccess) await onAfterSuccess();
        step.success({ note: `tx ${tx.hash}` });
        return true;
      } catch (err) {
        setActionError(decodeContractError(err, `${flow} failed`));
        step.failure(err);
        return false;
      } finally {
        setActionLoading(false);
      }
    },
    [waitForIndexer, onAfterSuccess],
  );

  const postPrepayListing = useCallback(
    async (
      lid: bigint,
      askPrice: bigint,
      salt: bigint,
      conduitKey: `0x${string}`,
    ): Promise<boolean> =>
      runWrite('postPrepayListing', lid, () =>
        diamond.postPrepayListing(lid, askPrice, salt, conduitKey),
      ),
    [diamond, runWrite],
  );

  const updatePrepayListing = useCallback(
    async (
      lid: bigint,
      newAskPrice: bigint,
      newSalt: bigint,
      newConduitKey: `0x${string}`,
    ): Promise<boolean> =>
      runWrite('updatePrepayListing', lid, () =>
        diamond.updatePrepayListing(lid, newAskPrice, newSalt, newConduitKey),
      ),
    [diamond, runWrite],
  );

  const cancelPrepayListing = useCallback(
    async (lid: bigint): Promise<boolean> =>
      runWrite('cancelPrepayListing', lid, () =>
        diamond.cancelPrepayListing(lid),
      ),
    [diamond, runWrite],
  );

  return {
    listing,
    loading,
    reload,
    actionLoading,
    actionError,
    txHash,
    postPrepayListing,
    updatePrepayListing,
    cancelPrepayListing,
  };
}
