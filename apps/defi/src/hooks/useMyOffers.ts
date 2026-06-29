import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import {
  useDiamondPublicClient,
  useDiamondRead,
  useReadChain,
} from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';
import { batchCalls, encodeBatchCalls } from '@vaipakam/lib/multicall';
import { useLogIndex } from './useLogIndex';
import { useLiveWatermark } from './useLiveWatermark';
import { watermarkPolicy } from './watermarkPolicy';
import { readOfferSnapshot, writeOfferSnapshot } from '../lib/offerSnapshot';
import {
  fetchOffersByCreator,
  indexedToRawOffer,
  type IndexedOffer,
} from '../lib/indexerClient';
import { toOfferData, type OfferData, type RawOffer } from '../pages/OfferBook';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/** What kind of offer the caller wants to see. */
export type MyOfferStatus =
  | 'active'
  | 'filled'
  | 'cancelled'
  | 'sold' // T-086 Round-8 §19.7e — parallel-sale Scenario A terminal
  | 'all';

/**
 * Status-tagged offer row. Cancelled rows carry only `id`, `creator`,
 * and `offerType` because:
 *
 *   - `cancelOffer` `delete`s the offer storage slot, so a live
 *     `getOffer(...)` returns zero for a cancelled id.
 *   - The persistent `OfferCanceled` event only emits
 *     `(offerId, creator)`, and the original `OfferCreated` event
 *     only emits `(offerId, creator, offerType)`. Neither carries
 *     the financial terms (asset, amount, rate, duration, collateral).
 *
 * So cancelled rows render as compact identity-only entries —
 * "you cancelled offer #N (Lender)" — without lying about terms
 * we no longer have access to. Rich-detail recovery would require
 * either a richer event (contract upgrade) or a per-create
 * localStorage cache; both are out of scope for the first cut.
 */
export interface MyOfferRow {
  status: 'active' | 'filled' | 'cancelled' | 'sold';
  /** Full `OfferData` for active + filled rows. For cancelled rows,
   *  only `id`, `creator`, and `offerType` are meaningful — every
   *  other field is its zero-value default and must NOT be rendered
   *  as a real number. Use the `status` discriminator to gate
   *  per-column rendering in the table. */
  offer: OfferData;
  /** Loan id (decimal string) for `filled` rows, undefined otherwise. */
  loanId?: string;
}

/**
 * Read the connected wallet's offers in three lifecycle states:
 *
 *  - **active**   — created, not yet accepted or cancelled. Live read
 *                   via `getOffer` (the storage slot still exists).
 *  - **filled**   — accepted; consumed by an `acceptOffer` and now
 *                   represented by a loan. Live read via `getOffer`
 *                   (the storage slot is preserved with `accepted=true`).
 *                   Loan id pulled from the `OfferAccepted` event arg.
 *  - **cancelled** — `cancelOffer` was called. The on-chain storage slot
 *                   is `delete`d at cancel time; events carry only
 *                   identity (id + creator + offerType). Compact rows
 *                   only — see `MyOfferRow` doc for rationale.
 *
 * The `'all'` filter returns active + filled + cancelled. Filled offers
 * also surface as loans in the Your Loans card directly below the
 * Your Offers card on the Dashboard, so a user comparing the two
 * views sees the through-line: "this offer became that loan."
 */
export function useMyOffers(
  address: string | null,
  status: MyOfferStatus,
) {
  const { events, openOfferIds, loading: indexLoading } = useLogIndex();
  const diamondRead = useDiamondRead();
  const publicClient = useDiamondPublicClient();
  const activeReadChain = useReadChain();
  const chainId = activeReadChain.chainId ?? DEFAULT_CHAIN.chainId;
  // Watermark-driven refresh trigger. When the protocol-wide create
  // counter advances (or the manual rescan kicks the watermark) the
  // indexer fetch effect re-runs. 20 s cadence matches the rest of
  // the slower-page polling tier (Dashboard, Risk Watch, Analytics).
  const { version: watermarkVersion } = useLiveWatermark(watermarkPolicy('warm'));

  // ── Indexer-first path ──
  //
  // Pre-Phase-9, this hook fed exclusively off `useLogIndex` (the
  // local browser-side log scan), which lags the worker's snapshot
  // by however long it takes the local cursor to reach the latest
  // safe block. On a fresh page load that lag was 5–60 s typically,
  // and during that window recently-created offers were INVISIBLE on
  // the Dashboard "Your Offers" card while the OfferBook (which
  // reads from `useIndexedActiveOffers`) already showed them. The
  // user reported a 2-vs-5 mismatch under that exact pattern.
  //
  // The indexer endpoint `/offers/by-creator/{addr}` returns every
  // offer the wallet has ever created with full struct fields and
  // a status enum (active / accepted / cancelled / expired). When
  // reachable, we use it as the SOLE source of truth — no chain
  // reads at all (the existing `getOffer` multicall is gated off).
  // When unreachable, the fallback path's `getOffer` multicall
  // takes over via the existing useLogIndex-driven flow below.
  //
  // RPC budget impact: zero new chain reads on the happy path; on
  // worker-down the cost is identical to before.
  const [indexerRaw, setIndexerRaw] = useState<IndexedOffer[] | null>(null);
  const [indexerLoading, setIndexerLoading] = useState<boolean>(Boolean(address));
  // Bumped by `refetch()` to force the effect to re-run even when
  // none of its other deps changed (e.g. user clicked the manual
  // rescan button after an action they want reflected immediately).
  const [refetchTick, setRefetchTick] = useState(0);

  useEffect(() => {
    if (!address) {
      setIndexerRaw(null);
      setIndexerLoading(false);
      return;
    }
    let cancelled = false;
    setIndexerLoading(true);
    (async () => {
      try {
        const all: IndexedOffer[] = [];
        let before: number | undefined = undefined;
        // Paginate up to 5 × 200 = 1000 offers. A single wallet hitting
        // that ceiling would be vanishingly rare; if it ever happens
        // we lift the cap. Caps a runaway server response too.
        for (let i = 0; i < 5; i++) {
          const page = await fetchOffersByCreator(chainId, address, {
            limit: 200,
            before,
          });
          if (!page) {
            // Worker unreachable — bail out and let the logIndex
            // fallback path below produce the rows.
            if (!cancelled) {
              setIndexerRaw(null);
              setIndexerLoading(false);
            }
            return;
          }
          all.push(...page.offers);
          if (page.nextBefore === null) break;
          before = page.nextBefore;
        }
        if (!cancelled) {
          setIndexerRaw(all);
          setIndexerLoading(false);
        }
      } catch {
        if (!cancelled) {
          setIndexerRaw(null);
          setIndexerLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, chainId, watermarkVersion, refetchTick]);

  // OfferAccepted event → loanId map. Used for the indexer-first
  // path too: the indexer surfaces status='accepted' but doesn't
  // currently return the linked loanId in the by-creator endpoint,
  // so we still need the local events for that mapping. The events
  // array is already in scope for the fallback path; no extra cost.
  // While useLogIndex catches up on a fresh just-accepted offer, the
  // row renders with `loanId: undefined` for a moment — the
  // "View loan" link is hidden until the event lands.
  const loanByOfferEvents = useMemo(() => {
    const m = new Map<string, string>();
    for (const ev of events) {
      if (ev.kind !== 'OfferAccepted') continue;
      const oid = ev.args.offerId;
      const lid = ev.args.loanId;
      if (typeof oid === 'string' && typeof lid === 'string') {
        m.set(oid, lid);
      }
    }
    return m;
  }, [events]);

  // Walk the log-index ONCE per (events, address) pair to bucket the
  // caller's offers by status. The three buckets are derived purely
  // from events — no chain reads here. Chain reads happen in the
  // effect below for active + filled (cancelled doesn't need them).
  const buckets = useMemo(() => {
    const result = {
      activeIds: [] as bigint[],
      filledIds: [] as { offerId: string; loanId: string }[],
      cancelledStubs: [] as MyOfferRow[],
      // T-086 Round-8 §19.7e + Codex round-14 P2 — sold-via-OpenSea
      // bucket for the fallback path. Same shape as `cancelledStubs`
      // (full OfferData when available, identity-only stub otherwise).
      soldStubs: [] as MyOfferRow[],
    };
    if (!address) return result;
    const lower = address.toLowerCase();
    const openSet = new Set(openOfferIds.map((id) => id.toString()));

    // First pass: collect my creates.
    const myCreates = new Map<string, { offerType: number }>();
    for (const ev of events) {
      if (ev.kind !== 'OfferCreated') continue;
      const creator = ev.args.creator;
      if (typeof creator !== 'string' || creator.toLowerCase() !== lower) continue;
      const offerId = ev.args.offerId;
      if (typeof offerId !== 'string') continue;
      const offerType =
        typeof ev.args.offerType === 'string'
          ? Number(ev.args.offerType)
          : 0;
      myCreates.set(offerId, { offerType });
    }

    // Second pass: classify accepts + cancels for ids I authored.
    // Cancelled offers carry two flavours of event in the log-index:
    //   - `OfferCanceled`: legacy lightweight (id + creator only)
    //   - `OfferCanceledDetails`: companion with full offer terms
    // Newer deploys emit both; older deploys emit only the legacy.
    // We index both — `OfferCanceledDetails` populates the rich
    // payload map below, the legacy is the marker that drives
    // `cancelledIds`.
    const filledLoanByOffer = new Map<string, string>();
    const cancelledIds = new Set<string>();
    const cancelledDetailsByOffer = new Map<string, OfferData>();
    // T-086 Round-8 §19.7e + Codex round-14 P2 — sold-via-OpenSea
    // terminal ids. Parallel to `cancelledIds` but bucketed into
    // `soldStubs` (status: 'sold') downstream so the user sees the
    // sold-history row even when the worker is unreachable and the
    // fallback path is in effect.
    const soldIds = new Set<string>();
    for (const ev of events) {
      if (ev.kind === 'OfferAccepted') {
        const offerId = ev.args.offerId;
        const loanId = ev.args.loanId;
        if (typeof offerId !== 'string' || typeof loanId !== 'string') continue;
        if (!myCreates.has(offerId)) continue;
        filledLoanByOffer.set(offerId, loanId);
      } else if (ev.kind === 'OfferCanceled') {
        const offerId = ev.args.offerId;
        if (typeof offerId !== 'string') continue;
        if (!myCreates.has(offerId)) continue;
        cancelledIds.add(offerId);
      } else if (ev.kind === 'OfferConsumedBySale') {
        // T-086 Round-8 §19.7e + Codex round-14 P2 + round-22 P2 #2 —
        // fallback path sold-bucket marker. Original implementation
        // gated on `myCreates.has(offerId)` to mirror cancelled /
        // accepted, but the catchup pass (round-20 P2) can discover
        // sale events whose OfferCreated was fast-forwarded past
        // (NOT in myCreates). The round-22 enrichment patches
        // `participants` with the creator address via the indexer
        // callback in those cases. So when the connected wallet
        // matches the event's enriched participants but isn't in
        // myCreates, still bucket the offer as sold — the
        // alternative is the borrower-of-a-fast-forwarded-offer
        // never seeing their sold row.
        const offerId = ev.args.offerId;
        if (typeof offerId !== 'string') continue;
        const eventTagsMe = ev.participants.includes(lower);
        if (!myCreates.has(offerId) && !eventTagsMe) continue;
        // Codex round-22 P2 #2 — also seed myCreates so the
        // classification loop below reaches the sold branch. The
        // contract gates `consumed_by_sale` to borrower offers
        // (OfferParallelSaleFacet's `_validatePostParallelSale` rejects
        // lender offers), so seed `offerType: 1` when no prior
        // OfferCreated landed in myCreates.
        if (!myCreates.has(offerId)) {
          myCreates.set(offerId, { offerType: 1 });
        }
        soldIds.add(offerId);
      } else if (ev.kind === 'OfferCanceledDetails') {
        const offerId = ev.args.offerId;
        if (typeof offerId !== 'string') continue;
        if (!myCreates.has(offerId)) continue;
        // Reconstruct an OfferData from the rich event payload — every
        // field the table needs is in the args bag.
        try {
          const amountField = typeof ev.args.amount === 'string' ? BigInt(ev.args.amount) : 0n;
          const rateField = typeof ev.args.interestRateBps === 'string'
            ? BigInt(ev.args.interestRateBps)
            : 0n;
          const collateralField = typeof ev.args.collateralAmount === 'string'
            ? BigInt(ev.args.collateralAmount)
            : 0n;
          // PR #187 Codex P2 — `OfferCanceledDetails` event emits the
          // canonical Phase 2 max fields. Prefer those when present
          // (post-Phase-2 deploys), falling back to the floor field
          // when absent (pre-Phase-2 indexers that haven't replayed
          // the new ABI shape yet, or replayed-from-archive rows).
          // Without this, the role-aware table reads (lender Principal
          // = amountMax; borrower Rate = interestRateBpsMax) would
          // mis-report cancelled lender offers as the 10% minPartialFill
          // floor instead of the headline ceiling.
          const amountMaxField = typeof ev.args.amountMax === 'string'
            ? BigInt(ev.args.amountMax)
            : amountField;
          const rateMaxField = typeof ev.args.interestRateBpsMax === 'string'
            ? BigInt(ev.args.interestRateBpsMax)
            : rateField;
          const collateralMaxField = typeof ev.args.collateralAmountMax === 'string'
            ? BigInt(ev.args.collateralAmountMax)
            : collateralField;
          const offer: OfferData = {
            id: BigInt(offerId),
            creator: address,
            offerType: typeof ev.args.offerType === 'string' ? Number(ev.args.offerType) : 0,
            lendingAsset: typeof ev.args.lendingAsset === 'string' ? ev.args.lendingAsset : ZERO_ADDR,
            amount: amountField,
            amountMax: amountMaxField,
            interestRateBps: rateField,
            interestRateBpsMax: rateMaxField,
            collateralAsset: typeof ev.args.collateralAsset === 'string'
              ? ev.args.collateralAsset
              : ZERO_ADDR,
            collateralAmount: collateralField,
            collateralAmountMax: collateralMaxField,
            durationDays: typeof ev.args.durationDays === 'string'
              ? BigInt(ev.args.durationDays)
              : 0n,
            principalLiquidity: 0,
            collateralLiquidity: 0,
            accepted: false,
            assetType: typeof ev.args.assetType === 'string' ? Number(ev.args.assetType) : 0,
            tokenId: typeof ev.args.tokenId === 'string' ? BigInt(ev.args.tokenId) : 0n,
            // Cancelled-offer event payload doesn't carry the partial-
            // repay flag (no resulting loan exists, so the field has no
            // surface meaning); default to false for the stub render.
            allowsPartialRepay: false,
            // #784 — same: the cancelled-stub render never drives the accept
            // disclosure; default to the protocol default (full-term).
            useFullTermInterest: true,
            periodicInterestCadence: 0,
          };
          cancelledDetailsByOffer.set(offerId, offer);
        } catch {
          // Malformed args — fall through to legacy + snapshot path.
        }
      }
    }

    // Final classification.
    const diamondAddrLc = (activeReadChain.diamondAddress ?? '').toLowerCase();
    for (const [offerId, meta] of myCreates) {
      if (cancelledIds.has(offerId)) {
        // Three-tier hydrate:
        //   1. OfferCanceledDetails event payload (best — on-chain,
        //      universally readable on a synced cache).
        //   2. localStorage snapshot written when the offer was active
        //      (same-browser fallback for older deploys / fresh caches).
        //   3. Identity-only stub (last resort: `—` cells in the UI).
        const fromEvent = cancelledDetailsByOffer.get(offerId);
        const fromSnapshot = !fromEvent && diamondAddrLc
          ? readOfferSnapshot(activeReadChain.chainId, diamondAddrLc, offerId)
          : null;
        const offer: OfferData = fromEvent ??
          fromSnapshot ?? {
            id: BigInt(offerId),
            creator: address,
            offerType: meta.offerType,
            lendingAsset: ZERO_ADDR,
            amount: 0n,
            // #183 — identity-only stub for a cancelled offer with no
            // event payload AND no localStorage snapshot. All values
            // are placeholder zeros; the UI renders `—` cells.
            amountMax: 0n,
            interestRateBps: 0n,
            interestRateBpsMax: 0n,
            collateralAsset: ZERO_ADDR,
            collateralAmount: 0n,
            collateralAmountMax: 0n,
            durationDays: 0n,
            principalLiquidity: 0,
            collateralLiquidity: 0,
            accepted: false,
            assetType: 0,
            tokenId: 0n,
            allowsPartialRepay: false,
            useFullTermInterest: true, // #784 — identity stub; default full-term
            periodicInterestCadence: 0,
          };
        result.cancelledStubs.push({ status: 'cancelled', offer });
      } else if (soldIds.has(offerId)) {
        // T-086 Round-8 §19.7e + Codex round-14 P2 — sold bucket.
        // The fallback path has no companion-details event for the
        // sold terminal (the Round-8 contract only emits
        // `OfferConsumedBySale(offerId, executor)` — no payload), so
        // the hydrate priority simplifies to:
        //   1. localStorage snapshot of the offer (written when the
        //      offer was active in the same browser).
        //   2. Identity-only stub (`—` cells for non-id fields).
        const fromSnapshot = diamondAddrLc
          ? readOfferSnapshot(activeReadChain.chainId, diamondAddrLc, offerId)
          : null;
        const offer: OfferData = fromSnapshot ?? {
          id: BigInt(offerId),
          creator: address,
          offerType: meta.offerType,
          lendingAsset: ZERO_ADDR,
          amount: 0n,
          amountMax: 0n,
          interestRateBps: 0n,
          interestRateBpsMax: 0n,
          collateralAsset: ZERO_ADDR,
          collateralAmount: 0n,
          collateralAmountMax: 0n,
          durationDays: 0n,
          principalLiquidity: 0,
          collateralLiquidity: 0,
          accepted: false,
          assetType: 0,
          tokenId: 0n,
          allowsPartialRepay: false,
          useFullTermInterest: true, // #784 — identity stub; default full-term
          periodicInterestCadence: 0,
        };
        result.soldStubs.push({ status: 'sold', offer });
      } else if (filledLoanByOffer.has(offerId)) {
        result.filledIds.push({
          offerId,
          loanId: filledLoanByOffer.get(offerId)!,
        });
      } else if (openSet.has(offerId)) {
        result.activeIds.push(BigInt(offerId));
      }
      // else: stale (open-set hasn't yet reflected an accept/cancel
      // we know happened; rare). Skip — next index reload reconciles.
    }

    return result;
  }, [events, openOfferIds, address]);

  // Decide which ids to fetch live this tick based on the requested
  // status filter. Cancelled rows never need a live read.
  const idsToFetch = useMemo(() => {
    const ids: bigint[] = [];
    if (status === 'active' || status === 'all') ids.push(...buckets.activeIds);
    if (status === 'filled' || status === 'all') {
      for (const r of buckets.filledIds) ids.push(BigInt(r.offerId));
    }
    return ids;
  }, [buckets, status]);

  const [liveOffers, setLiveOffers] = useState<OfferData[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (indexLoading) return;
    // Indexer-first short-circuit: when the worker returned a full
    // by-creator page, the chain-read multicall is redundant — every
    // field the table renders already lives on the indexer struct.
    // Skipping here is the load-bearing "no unnecessary RPC spam"
    // gate. If the worker is unreachable, `indexerRaw` stays null
    // and we fall through to the multicall below.
    if (indexerRaw !== null) {
      setLiveOffers([]);
      setLoading(false);
      return;
    }
    if (!address || idsToFetch.length === 0) {
      setLiveOffers([]);
      return;
    }
    let aborted = false;
    setLoading(true);
    (async () => {
      try {
        const target = (activeReadChain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
        let decoded: Array<RawOffer | null>;
        try {
          const calls = encodeBatchCalls(
            target,
            DIAMOND_ABI,
            'getOffer',
            idsToFetch.map((id) => [id] as const),
          );
          decoded = await batchCalls<RawOffer>(publicClient, DIAMOND_ABI, 'getOffer', calls);
          if (decoded.every((d) => d === null)) throw new Error('multicall empty');
        } catch {
          decoded = [];
          for (const id of idsToFetch) {
            try {
              decoded.push((await diamondRead.getOffer(id)) as RawOffer);
            } catch {
              decoded.push(null);
            }
          }
        }
        if (aborted) return;
        const fresh = decoded
          .filter((raw): raw is RawOffer => !!raw && raw.creator?.toLowerCase() !== ZERO_ADDR)
          .map(toOfferData);
        // Snapshot every live-fetched offer to localStorage. Cheap
        // (one synchronous setItem per row) and gives us a same-
        // browser fallback for cancelled rows whose on-chain
        // `OfferCanceledDetails` event isn't available (older Diamond
        // deploy that pre-dates the rich event, or fresh cache that
        // hasn't backfilled the relevant block range yet).
        const diamondAddr = activeReadChain.diamondAddress ?? '';
        if (diamondAddr) {
          for (const o of fresh) {
            writeOfferSnapshot(activeReadChain.chainId, diamondAddr, o);
          }
        }
        setLiveOffers(fresh);
      } finally {
        if (!aborted) setLoading(false);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [
    address,
    idsToFetch,
    indexLoading,
    indexerRaw,
    diamondRead,
    publicClient,
    activeReadChain.diamondAddress,
  ]);

  // Assemble the result, status-tagged. Newest first by id.
  //
  // Indexer-first: when `indexerRaw` is populated the rows derive
  // directly from the indexer payload (every field comes from the
  // worker's snapshot, no chain reads). The fallback branch — a
  // longer arm that consumes `useLogIndex` events plus the
  // multicall-fetched `liveOffers` — only runs when the worker is
  // unreachable.
  const rows = useMemo<MyOfferRow[]>(() => {
    if (indexerRaw !== null) {
      const out: MyOfferRow[] = [];
      for (const o of indexerRaw) {
        const offer = toOfferData(indexedToRawOffer(o));
        // Status mapping: indexer 'active'/'accepted'/'cancelled'/
        // 'consumed_by_sale' map onto MyOfferRow's four buckets.
        // 'expired' offers (created but never accepted before
        // duration elapsed) are dropped here — they have no UI
        // surface today; revisit if we ever build an "expired" tab.
        if (o.status === 'active') {
          out.push({ status: 'active', offer });
        } else if (o.status === 'accepted') {
          out.push({
            status: 'filled',
            offer,
            loanId: loanByOfferEvents.get(String(o.offerId)),
          });
        } else if (o.status === 'cancelled') {
          out.push({ status: 'cancelled', offer });
        } else if (o.status === 'consumed_by_sale') {
          // T-086 Round-8 §19.7e — Scenario A parallel-sale terminal
          // (buyer won the race; no loan was created). Carries the
          // full offer fields for display; the UI renders "Sold via
          // OpenSea" instead of "Cancelled".
          out.push({ status: 'sold', offer });
        }
      }
      out.sort((a, b) =>
        a.offer.id > b.offer.id ? -1 : a.offer.id < b.offer.id ? 1 : 0,
      );
      return out.filter((r) => status === 'all' || r.status === status);
    }

    // Fallback path — same shape as before the indexer-first refactor.
    const filledLoanMap = new Map(
      buckets.filledIds.map((r) => [r.offerId, r.loanId]),
    );
    const out: MyOfferRow[] = [];
    if (status === 'active' || status === 'all') {
      for (const o of liveOffers) {
        if (!o.accepted) {
          out.push({ status: 'active', offer: o });
        }
      }
    }
    if (status === 'filled' || status === 'all') {
      for (const o of liveOffers) {
        if (o.accepted) {
          out.push({
            status: 'filled',
            offer: o,
            loanId: filledLoanMap.get(o.id.toString()),
          });
        }
      }
    }
    if (status === 'cancelled' || status === 'all') {
      out.push(...buckets.cancelledStubs);
    }
    // T-086 Round-8 §19.7e + Codex round-14 P2 — wire the new sold
    // bucket into the fallback path. Filter parity with the indexer-
    // first branch: a sold offer shows under `'sold'` and `'all'`.
    if (status === 'sold' || status === 'all') {
      out.push(...buckets.soldStubs);
    }
    out.sort((a, b) =>
      a.offer.id > b.offer.id ? -1 : a.offer.id < b.offer.id ? 1 : 0,
    );
    return out;
  }, [indexerRaw, loanByOfferEvents, liveOffers, buckets, status]);

  // Combined loading: while the indexer has never resolved we show
  // its loading state; once it has data, loading is false. If the
  // indexer is unreachable, fall through to the fallback path's
  // existing `loading` (driven by the multicall fetch).
  const combinedLoading =
    indexerRaw !== null
      ? false
      : indexerLoading
        ? true
        : loading;

  // Imperative refetch — bumps `refetchTick` to re-run the indexer
  // effect even when none of its other deps changed. Wired into the
  // Dashboard rescan button so users who want fresh data right now
  // don't have to wait for the next watermark probe.
  const refetch = useCallback(async () => {
    setRefetchTick((n) => n + 1);
  }, []);

  return { rows, loading: combinedLoading, refetch };
}

/**
 * Backwards-compatible thin wrapper. Existing callers that just want
 * the wallet's currently-open offers (the pre-chip-filter Dashboard
 * card) keep working with `{ offers, loading }` shape.
 */
export function useMyActiveOffers(address: string | null) {
  const { rows, loading } = useMyOffers(address, 'active');
  const offers = useMemo(() => rows.map((r) => r.offer), [rows]);
  return { offers, loading };
}
