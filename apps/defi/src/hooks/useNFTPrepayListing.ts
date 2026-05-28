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
   *  transition with a short backoff. Returns the final indexer
   *  view (which the caller writes into `listing` state). If the
   *  indexer never catches up within the budget we return whatever
   *  it last gave us — the on-chain tx already succeeded, so this
   *  is a UI freshness guarantee, not a correctness one. Codex
   *  round-2 P2 fix on PR #308.
   *
   *  The transition test compares against the `prior` listing the
   *  caller observed BEFORE the write. For `update`, "any listing
   *  is present" would match the pre-update row immediately and
   *  settle stale state back into `listing` — Codex round-3 P2 fix
   *  on PR #308. The comparison now uses orderHash transition for
   *  post + update, and listing-disappearance for cancel. */
  const waitForIndexer = useCallback(
    async (
      flow: 'postPrepayListing' | 'updatePrepayListing' | 'cancelPrepayListing',
      prior: IndexedPrepayListing | null | undefined,
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
        if (flow === 'cancelPrepayListing') {
          // Expected: listing gone.
          if (!row.prepayListing) return undefined;
        } else if (flow === 'postPrepayListing') {
          // Expected: a listing now exists. `prior` was nullish; any
          // present listing is the new one (diamond enforces "at most
          // one live listing per loan" so we can't conflate with a
          // prior-loan row here).
          if (row.prepayListing) return row.prepayListing;
        } else {
          // Update: a listing was already there; expected transition
          // is "orderHash changes from `prior.orderHash`". A row that
          // STILL returns the prior orderHash means the indexer is
          // lagging; keep polling.
          if (
            row.prepayListing &&
            (!prior || row.prepayListing.orderHash !== prior.orderHash)
          ) {
            return row.prepayListing;
          }
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
      // Snapshot the prior listing BEFORE the write so the indexer
      // poll can detect a transition (especially for update, where a
      // row already exists pre-write — Codex round-3 P2 fix).
      const prior = listing;
      try {
        const tx = await submit();
        setTxHash(tx.hash);
        await tx.wait();
        // Poll the indexer for the expected transition; this writes
        // the freshest listing into `listing` state so the banner
        // and child action mode flip atomically with the tx.
        const fresh = await waitForIndexer(flow, prior);
        setListing(fresh);
        step.success({ note: `tx ${tx.hash}` });
      } catch (err) {
        setActionError(decodeContractError(err, `${flow} failed`));
        step.failure(err);
        return false;
      } finally {
        setActionLoading(false);
      }
      // Parent-refresh side-effect is OUT of the main try/catch — a
      // throw here means a transient `loadLoan` failure AFTER an
      // on-chain success, which we surface to the diagnostics log
      // but DO NOT report back to the caller as "the write failed".
      // Codex round-3 P2 fix on PR #308 — a stale on-chain-loan
      // read shouldn't roll back the cancel-confirm close /
      // success-only UI on a write that already landed.
      if (onAfterSuccess) {
        try {
          await onAfterSuccess();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[useNFTPrepayListing] onAfterSuccess threw after a successful ${flow}; ` +
              `on-chain write already confirmed, parent refresh will retry on next render.`,
            err,
          );
        }
      }
      return true;
    },
    [waitForIndexer, onAfterSuccess, listing],
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
