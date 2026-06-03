import { useCallback, useEffect, useState } from 'react';
import { useDiamondContract, useDiamondPublicClient } from '../contracts/useDiamond';
import { useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { fetchLoanById, type IndexedPrepayListing } from '../lib/indexerClient';
import { decodeContractError } from '@vaipakam/lib/decodeContractError';
import { beginStep } from '../lib/journeyLog';
import { publishPrepayListingToOpenSea } from '../lib/openseaPublish';
import { postPrepayMatchSource } from '../lib/indexerClient';
import type { Hex } from 'viem';

/** T-086 Round-5 Block A (#313) — borrower-supplied fee leg
 *  passed to `postPrepayListing` / `updatePrepayListing`. Maps
 *  one-to-one with the on-chain `FeeLeg` struct's calldata
 *  shape. Block A is fixed-price so `startAmount == endAmount`
 *  on every leg; the union type names both fields so Block B's
 *  Dutch path can reuse the same shape with `startAmount >
 *  endAmount`. */
export interface FeeLegInput {
  recipient: `0x${string}`;
  startAmount: bigint;
  endAmount: bigint;
}

/** #335 — payload the dapp passes through to the indexer's
 *  `POST /loans/:loanId/prepay-listing/match-source` endpoint
 *  after a successful Match-rotation tx. The fields name the
 *  OpenSea offer that triggered the rotation so analytics
 *  queries can distinguish offer-driven rotations from manual
 *  repricings. Sent best-effort: any failure (network blip,
 *  indexer down) is logged but doesn't fail the rotation. */
export interface MatchSourceBreadcrumb {
  orderHash: string;
  bidder: string;
}

/** Minimal subset of viem's `TransactionReceipt` the OpenSea publish
 *  path consumes — kept structural so a stricter / future viem
 *  shape change doesn't break the hook's contract. */
interface WriteReceipt {
  transactionHash: string;
  blockNumber: bigint;
  logs: ReadonlyArray<{ address: string; topics: readonly Hex[]; data: Hex }>;
}

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
    /** T-086 Round-5 Block A (#313) — fee schedule from OpenSea.
     *  Empty array for fee-free collections. The dapp fetches
     *  this from `/opensea/collection/{slug}` on the agent proxy
     *  before posting and computes the amounts against the gross
     *  askPrice. */
    feeLegs: ReadonlyArray<FeeLegInput>,
  ) => Promise<boolean>;
  updatePrepayListing: (
    loanId: bigint,
    newAskPrice: bigint,
    newSalt: bigint,
    newConduitKey: `0x${string}`,
    /** T-086 Round-5 Block A (#313) — re-derived fee schedule
     *  against `newAskPrice`. Per the §15.3 errata: the dapp
     *  re-fetches the OpenSea schedule on every match-offer
     *  rotation, not from a session cache. */
    feeLegs: ReadonlyArray<FeeLegInput>,
    /** #335 — when set, the hook POSTs an analytics breadcrumb to
     *  the indexer after the rotation tx confirms so downstream
     *  queries can distinguish offer-driven rotations from
     *  manual repricings. Best-effort: failures here don't fail
     *  the rotation. Manual repricings (PrepayListingActions's
     *  handleUpdate) omit this param. */
    matchSource?: MatchSourceBreadcrumb,
  ) => Promise<boolean>;
  /** T-086 Round-5 Block B (#309) — Dutch-decay post. The borrower
   *  remainder leg decays linearly from `startAskPrice` at
   *  block.timestamp down to `endAskPrice` at `auctionEndTime`.
   *  Lender + treasury legs stay fixed at the projected-max under
   *  sign-time governance config (the diamond reads them at
   *  `auctionEndTime`). Fee legs follow the same shape with their
   *  own start/end decay. The Seaport `endTime` is
   *  `auctionEndTime` (not `gracePeriodEnd`) — past that tick the
   *  listing becomes Seaport-unfillable.
   *  See {NFTPrepayDutchListingFacet.postPrepayDutchListing}. */
  postPrepayDutchListing: (
    loanId: bigint,
    startAskPrice: bigint,
    endAskPrice: bigint,
    auctionEndTime: bigint,
    salt: bigint,
    conduitKey: `0x${string}`,
    feeLegs: ReadonlyArray<FeeLegInput>,
  ) => Promise<boolean>;
  /** T-086 Round-5 Block B (#309) — Dutch-decay update. Atomic
   *  rotation of the live listing's parameters; lock stays
   *  continuous so no re-locking race opens. Can rotate a
   *  fixed-price listing into Dutch (the lock semantics are
   *  mode-agnostic). */
  updatePrepayDutchListing: (
    loanId: bigint,
    newStartAskPrice: bigint,
    newEndAskPrice: bigint,
    newAuctionEndTime: bigint,
    newSalt: bigint,
    newConduitKey: `0x${string}`,
    feeLegs: ReadonlyArray<FeeLegInput>,
    /** #335 — same shape as `updatePrepayListing` above. */
    matchSource?: MatchSourceBreadcrumb,
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
  const publicClient = useDiamondPublicClient();
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
      flow: 'postPrepayListing' | 'postPrepayDutchListing' | 'updatePrepayListing' | 'updatePrepayDutchListing' | 'cancelPrepayListing',
      prior: IndexedPrepayListing | null | undefined,
    ): Promise<{
      /** True iff a poll observed the expected transition. */
      sawTransition: boolean;
      /** The latest indexer view we got. Undefined when no poll
       *  returned a row (e.g. indexer outage). */
      latest: IndexedPrepayListing | null | undefined;
    }> => {
      if (!loanId) return { sawTransition: false, latest: undefined };
      // 1 s, 2 s, 3 s, 4 s, 5 s → ~15 s total worst case. Short enough
      // to keep the user in-flow; long enough for a healthy indexer
      // (block-time-aligned scans) to catch up.
      const delays = [1000, 2000, 3000, 4000, 5000];
      let latest: IndexedPrepayListing | null | undefined = undefined;
      let indexerEverResponded = false;
      for (const d of delays) {
        await new Promise((r) => setTimeout(r, d));
        const row = await fetchLoanById(chainId, Number(loanId));
        if (!row) continue;
        indexerEverResponded = true;
        latest = row.prepayListing;
        if (flow === 'cancelPrepayListing') {
          if (!row.prepayListing) return { sawTransition: true, latest: undefined };
        } else if (flow === 'postPrepayListing' || flow === 'postPrepayDutchListing') {
          if (row.prepayListing) return { sawTransition: true, latest: row.prepayListing };
        } else {
          // update path (fixed or Dutch) — wait for orderHash to rotate
          if (
            row.prepayListing &&
            (!prior || row.prepayListing.orderHash !== prior.orderHash)
          ) {
            return { sawTransition: true, latest: row.prepayListing };
          }
        }
      }
      return { sawTransition: false, latest: indexerEverResponded ? latest : undefined };
    },
    [chainId, loanId],
  );

  const runWrite = useCallback(
    async (
      flow: 'postPrepayListing' | 'postPrepayDutchListing' | 'updatePrepayListing' | 'updatePrepayDutchListing' | 'cancelPrepayListing',
      loanIdArg: bigint,
      submit: () => Promise<{ hash: string; wait: () => Promise<unknown> }>,
    ): Promise<{ success: boolean; receipt?: WriteReceipt }> => {
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
      let receipt: WriteReceipt | undefined;
      try {
        const tx = await submit();
        setTxHash(tx.hash);
        // viem's `wait()` returns the receipt; capture it so the
        // callers that need the post-tx block.timestamp + event
        // logs (i.e. the OpenSea publish path for post / update)
        // don't have to re-fetch by hash.
        receipt = (await tx.wait()) as WriteReceipt;
        // Poll the indexer for the expected transition; this writes
        // the freshest listing into `listing` state so the banner
        // and child action mode flip atomically with the tx.
        const { sawTransition, latest } = await waitForIndexer(flow, prior);
        if (flow === 'cancelPrepayListing') {
          // Cancel's on-chain final state is KNOWN once `tx.wait()`
          // resolves: the listing is gone. Stale indexer rows
          // returned during the poll window (the worker hasn't
          // ingested the cancel yet) must NOT override that. Codex
          // round-6 P2 fix on PR #308 — without this short-circuit,
          // a lagging-indexer cancel would settle the pre-cancel
          // row back into `listing`, keeping the banner visible
          // and making a second cancel attempt revert with
          // `PrepayListingNotFound`.
          setListing(undefined);
        } else if (sawTransition) {
          // Post / update: indexer caught up and confirmed the
          // expected transition (post → listing exists; update →
          // orderHash differs from prior).
          setListing(latest);
        } else if (latest !== undefined) {
          // Post / update: indexer responded but transition not
          // observed within the budget — settle to its latest view
          // (best effort). For update this is still better than
          // reverting to prior; the borrower will see the previous
          // orderHash and pull the new one on the next user-driven
          // refresh.
          setListing(latest);
        }
        // Else (post / update + total indexer outage): leave
        // `listing` alone — the on-chain write succeeded; treating
        // an unavailable cache as "no listing" would hide a live
        // post/update and put the borrower back into post mode.
        // Codex round-4 P3 fix on PR #308.
        step.success({ note: `tx ${tx.hash}` });
      } catch (err) {
        setActionError(decodeContractError(err, `${flow} failed`));
        step.failure(err);
        return { success: false };
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
      return { success: true, receipt };
    },
    [waitForIndexer, onAfterSuccess, listing],
  );

  /** Best-effort fire-and-forget OpenSea publish after a successful
   *  post / update tx. The indexer's autonomous PrepayListingPosted /
   *  Updated handlers are the canonical safety net (they also
   *  publish via the same shared `prepayOrderShape` reconstruction);
   *  this frontend path exists purely for UX-latency — borrower
   *  sees the listing on OpenSea within seconds of tx-confirm
   *  rather than waiting for the indexer's next scan tick. Errors
   *  are diagnostic-only (console.warn) so a transient agent /
   *  OpenSea outage never rolls back the post-tx UI. */
  const runOpenSeaPublish = useCallback(
    async (
      receipt: WriteReceipt,
      lid: bigint,
      askPrice: bigint,
      salt: bigint,
      conduitKey: `0x${string}`,
      // T-086 Round-5 Block A (#313) — Codex P1: thread the
      // borrower's fee legs through to the JS reconstruction so the
      // canonical hash matches the on-chain hash on fee-enforced
      // collections. Empty array for fee-free posts collapses to the
      // Round-4 3-leg shape unchanged.
      feeLegs: ReadonlyArray<FeeLegInput>,
      // T-086 Round-5 Block C v1.1 (#332) — Dutch decay parameters.
      // When set, the publish helper rebuilds the Dutch shape via
      // `LibPrepayOrder.buildAndHashDutch` (Seaport `endTime ==
      // auctionEndTime`, projected legs at `auctionEndTime`).
      // Omitted on fixed-price posts/updates and on cancel paths.
      dutch?: { endAskPrice: bigint; auctionEndTime: bigint },
    ): Promise<void> => {
      if (!chain.diamondAddress) return;
      let agentOrigin: string | null = null;
      try {
        agentOrigin =
          (import.meta.env.VITE_AGENT_ORIGIN as string | undefined) ?? null;
      } catch {
        agentOrigin = null;
      }
      const result = await publishPrepayListingToOpenSea({
        publicClient,
        agentOrigin,
        diamondAddress: chain.diamondAddress as `0x${string}`,
        chainId,
        txReceipt: receipt,
        loanId: lid,
        askPrice,
        salt,
        conduitKey,
        feeLegs,
        dutch,
      });
      if (!result.published) {
        // eslint-disable-next-line no-console
        console.warn(
          `[useNFTPrepayListing] frontend-direct OpenSea publish failed (${result.error}); ` +
            `indexer-side autonomous republish will retry on its next event scan`,
        );
      }
    },
    [chain.diamondAddress, chainId, publicClient],
  );

  // T-086 Round-5 Block A (#313) — see hook type comments above
  // for why feeLegs is a calldata array passed in by the caller
  // (computed against the live OpenSea Collection API response).
  const postPrepayListing = useCallback(
    async (
      lid: bigint,
      askPrice: bigint,
      salt: bigint,
      conduitKey: `0x${string}`,
      feeLegs: ReadonlyArray<FeeLegInput>,
    ): Promise<boolean> => {
      const r = await runWrite('postPrepayListing', lid, () =>
        diamond.postPrepayListing(lid, askPrice, salt, conduitKey, feeLegs),
      );
      if (r.success && r.receipt) {
        await runOpenSeaPublish(r.receipt, lid, askPrice, salt, conduitKey, feeLegs);
      }
      return r.success;
    },
    [diamond, runWrite, runOpenSeaPublish],
  );

  const updatePrepayListing = useCallback(
    async (
      lid: bigint,
      newAskPrice: bigint,
      newSalt: bigint,
      newConduitKey: `0x${string}`,
      feeLegs: ReadonlyArray<FeeLegInput>,
      matchSource?: MatchSourceBreadcrumb,
    ): Promise<boolean> => {
      const r = await runWrite('updatePrepayListing', lid, () =>
        diamond.updatePrepayListing(lid, newAskPrice, newSalt, newConduitKey, feeLegs),
      );
      if (r.success && r.receipt) {
        await runOpenSeaPublish(r.receipt, lid, newAskPrice, newSalt, newConduitKey, feeLegs);
        // #335 — best-effort analytics breadcrumb. The rotation
        // tx is already on-chain; this POST is fire-and-forget.
        if (matchSource) {
          await postPrepayMatchSource(lid, {
            txHash: r.receipt.transactionHash as `0x${string}`,
            orderHash: matchSource.orderHash,
            bidder: matchSource.bidder,
            matchedAt: Math.floor(Date.now() / 1000),
          });
        }
      }
      return r.success;
    },
    [diamond, runWrite, runOpenSeaPublish],
  );

  const cancelPrepayListing = useCallback(
    async (lid: bigint): Promise<boolean> => {
      const r = await runWrite('cancelPrepayListing', lid, () =>
        diamond.cancelPrepayListing(lid),
      );
      // Cancel doesn't push to OpenSea — the vault's ERC-1271
      // stops authorising the orderHash, so OpenSea drops the
      // listing on its next validation pass (minutes). See
      // `apps/agent/src/openseaProxy.ts` for the rationale on not
      // exposing a /cancel proxy endpoint.
      return r.success;
    },
    [diamond, runWrite],
  );

  // T-086 Round-5 Block B (#309) — Dutch posting + update entries.
  // T-086 Round-5 Block C v1.1 (#332) — frontend-direct OpenSea
  // publish ON for the Dutch path. Original Block B comment said
  // "A future iteration can mirror the fixed-price's
  // `runOpenSeaPublish` here; for now the autonomous path covers
  // both modes uniformly" — that "future iteration" landed in
  // PR #340 because the English-match-on-Dutch flow needs the
  // rotated order published immediately for the bidder to fulfill
  // within the race window (the autonomous indexer cron's
  // ~10-30 s latency is too slow for that surface).
  const postPrepayDutchListing = useCallback(
    async (
      lid: bigint,
      startAskPrice: bigint,
      endAskPrice: bigint,
      auctionEndTime: bigint,
      salt: bigint,
      conduitKey: `0x${string}`,
      feeLegs: ReadonlyArray<FeeLegInput>,
    ): Promise<boolean> => {
      const r = await runWrite('postPrepayDutchListing', lid, () =>
        diamond.postPrepayDutchListing(
          lid, startAskPrice, endAskPrice, auctionEndTime,
          salt, conduitKey, feeLegs,
        ),
      );
      if (r.success && r.receipt) {
        await runOpenSeaPublish(r.receipt, lid, startAskPrice, salt, conduitKey, feeLegs, {
          endAskPrice,
          auctionEndTime,
        });
      }
      return r.success;
    },
    [diamond, runWrite, runOpenSeaPublish],
  );

  const updatePrepayDutchListing = useCallback(
    async (
      lid: bigint,
      newStartAskPrice: bigint,
      newEndAskPrice: bigint,
      newAuctionEndTime: bigint,
      newSalt: bigint,
      newConduitKey: `0x${string}`,
      feeLegs: ReadonlyArray<FeeLegInput>,
      matchSource?: MatchSourceBreadcrumb,
    ): Promise<boolean> => {
      const r = await runWrite('updatePrepayDutchListing', lid, () =>
        diamond.updatePrepayDutchListing(
          lid, newStartAskPrice, newEndAskPrice, newAuctionEndTime,
          newSalt, newConduitKey, feeLegs,
        ),
      );
      if (r.success && r.receipt) {
        await runOpenSeaPublish(r.receipt, lid, newStartAskPrice, newSalt, newConduitKey, feeLegs, {
          endAskPrice: newEndAskPrice,
          auctionEndTime: newAuctionEndTime,
        });
        // #335 — same best-effort match-source breadcrumb as the
        // fixed-price `updatePrepayListing` path.
        if (matchSource) {
          await postPrepayMatchSource(lid, {
            txHash: r.receipt.transactionHash as `0x${string}`,
            orderHash: matchSource.orderHash,
            bidder: matchSource.bidder,
            matchedAt: Math.floor(Date.now() / 1000),
          });
        }
      }
      return r.success;
    },
    [diamond, runWrite, runOpenSeaPublish],
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
    postPrepayDutchListing,
    updatePrepayDutchListing,
    cancelPrepayListing,
  };
}
