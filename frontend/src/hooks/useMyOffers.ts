import { useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import {
  useDiamondPublicClient,
  useDiamondRead,
  useReadChain,
} from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';
import { batchCalls, encodeBatchCalls } from '../lib/multicall';
import { useLogIndex } from './useLogIndex';
import { readOfferSnapshot, writeOfferSnapshot } from '../lib/offerSnapshot';
import { toOfferData, type OfferData, type RawOffer } from '../pages/OfferBook';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/** What kind of offer the caller wants to see. */
export type MyOfferStatus = 'active' | 'filled' | 'cancelled' | 'all';

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
  status: 'active' | 'filled' | 'cancelled';
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

  // Walk the log-index ONCE per (events, address) pair to bucket the
  // caller's offers by status. The three buckets are derived purely
  // from events — no chain reads here. Chain reads happen in the
  // effect below for active + filled (cancelled doesn't need them).
  const buckets = useMemo(() => {
    const result = {
      activeIds: [] as bigint[],
      filledIds: [] as { offerId: string; loanId: string }[],
      cancelledStubs: [] as MyOfferRow[],
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
      } else if (ev.kind === 'OfferCanceledDetails') {
        const offerId = ev.args.offerId;
        if (typeof offerId !== 'string') continue;
        if (!myCreates.has(offerId)) continue;
        // Reconstruct an OfferData from the rich event payload — every
        // field the table needs is in the args bag.
        try {
          const offer: OfferData = {
            id: BigInt(offerId),
            creator: address,
            offerType: typeof ev.args.offerType === 'string' ? Number(ev.args.offerType) : 0,
            lendingAsset: typeof ev.args.lendingAsset === 'string' ? ev.args.lendingAsset : ZERO_ADDR,
            amount: typeof ev.args.amount === 'string' ? BigInt(ev.args.amount) : 0n,
            interestRateBps: typeof ev.args.interestRateBps === 'string'
              ? BigInt(ev.args.interestRateBps)
              : 0n,
            collateralAsset: typeof ev.args.collateralAsset === 'string'
              ? ev.args.collateralAsset
              : ZERO_ADDR,
            collateralAmount: typeof ev.args.collateralAmount === 'string'
              ? BigInt(ev.args.collateralAmount)
              : 0n,
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
            interestRateBps: 0n,
            collateralAsset: ZERO_ADDR,
            collateralAmount: 0n,
            durationDays: 0n,
            principalLiquidity: 0,
            collateralLiquidity: 0,
            accepted: false,
            assetType: 0,
            tokenId: 0n,
            allowsPartialRepay: false,
            periodicInterestCadence: 0,
          };
        result.cancelledStubs.push({ status: 'cancelled', offer });
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
    diamondRead,
    publicClient,
    activeReadChain.diamondAddress,
  ]);

  // Assemble the result, status-tagged. Newest first by id.
  const rows = useMemo<MyOfferRow[]>(() => {
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
    out.sort((a, b) =>
      a.offer.id > b.offer.id ? -1 : a.offer.id < b.offer.id ? 1 : 0,
    );
    return out;
  }, [liveOffers, buckets, status]);

  return { rows, loading };
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
