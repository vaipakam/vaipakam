import type { OfferData } from '../pages/OfferBook';

/**
 * localStorage-backed snapshot of offer terms, keyed per
 * (chainId, diamondAddress, offerId). Two reasons we keep this:
 *
 *   1. **Pre-`OfferCanceledDetails` cancelled offers.** Offers cancelled
 *      on-chain BEFORE the `OfferCanceledDetails` event was added (i.e.
 *      against an older Diamond deploy) only emit the legacy
 *      `OfferCanceled(offerId, creator)` event. Snapshots written by
 *      the same browser at view-time fill the gap — when "Your Offers
 *      / Cancelled" renders, the hydrate path reads the event first,
 *      then falls back here.
 *
 *   2. **Fresh-cache cross-device.** A user who created and cancelled
 *      an offer on browser A, then opens "Your Offers / Cancelled" on
 *      browser B, will see the on-chain event-driven render but no
 *      snapshot. Browser A still has both. Snapshot lifecycle is
 *      browser-local by design.
 *
 * Storage cost is bounded: at typical use (~dozens of offers per user
 * per chain, ~600 bytes per row JSON) the per-key cost is small;
 * pruning hooks below cap retention to 200 most-recent entries.
 */

interface SerializedOffer {
  id: string;
  creator: string;
  offerType: number;
  lendingAsset: string;
  amount: string;
  /** #183 — optional; older snapshots written before the canonical
   *  Phase 2 mapping didn't include the `*Max` fields. Reads fall
   *  back to the floor field when absent (see `readOfferSnapshot`). */
  amountMax?: string;
  interestRateBps: string;
  /** #183 — same pattern as `amountMax`. */
  interestRateBpsMax?: string;
  collateralAsset: string;
  collateralAmount: string;
  /** #183 — same pattern as `amountMax`. */
  collateralAmountMax?: string;
  durationDays: string;
  principalLiquidity: number;
  collateralLiquidity: number;
  accepted: boolean;
  assetType: number;
  tokenId: string;
  /** Optional — older snapshots predate this field, so reads must
   *  default to false if absent. */
  allowsPartialRepay?: boolean;
  /** T-034 — optional; older snapshots predate this field, so reads
   *  must default to 0 (None) if absent. */
  periodicInterestCadence?: number;
  /** Unix-seconds timestamp the snapshot was last written. Used for
   *  pruning when storage gets full. */
  capturedAt: number;
}

const PREFIX = 'vaipakam:offerSnapshot:v1';
const PRUNE_THRESHOLD = 200;
const PRUNE_TARGET = 150;

function keyFor(chainId: number, diamond: string, offerId: bigint | string): string {
  const idStr = typeof offerId === 'bigint' ? offerId.toString() : offerId;
  return `${PREFIX}:${chainId}:${diamond.toLowerCase()}:${idStr}`;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Persist a full offer snapshot. Idempotent overwrite — every
 *  `useMyOffers` view-cycle re-saves all visible active offers. */
export function writeOfferSnapshot(
  chainId: number,
  diamond: string,
  offer: OfferData,
): void {
  const ls = safeStorage();
  if (!ls) return;
  const k = keyFor(chainId, diamond, offer.id);
  const payload: SerializedOffer = {
    id: offer.id.toString(),
    creator: offer.creator,
    offerType: offer.offerType,
    lendingAsset: offer.lendingAsset,
    amount: offer.amount.toString(),
    interestRateBps: offer.interestRateBps.toString(),
    collateralAsset: offer.collateralAsset,
    collateralAmount: offer.collateralAmount.toString(),
    durationDays: offer.durationDays.toString(),
    principalLiquidity: offer.principalLiquidity,
    collateralLiquidity: offer.collateralLiquidity,
    accepted: offer.accepted,
    assetType: offer.assetType,
    tokenId: offer.tokenId.toString(),
    allowsPartialRepay: offer.allowsPartialRepay,
    periodicInterestCadence: offer.periodicInterestCadence ?? 0,
    capturedAt: Math.floor(Date.now() / 1000),
  };
  try {
    ls.setItem(k, JSON.stringify(payload));
  } catch {
    // QuotaExceededError — try a prune-and-retry.
    pruneOldEntries(ls);
    try {
      ls.setItem(k, JSON.stringify(payload));
    } catch {
      // Still couldn't write — silently drop. The snapshot is best-
      // effort; the cancelled row will fall through to event-driven
      // or compact rendering.
    }
  }
}

/** Read a previously-written snapshot. Returns `null` if missing,
 *  malformed, or localStorage isn't available. */
export function readOfferSnapshot(
  chainId: number,
  diamond: string,
  offerId: bigint | string,
): OfferData | null {
  const ls = safeStorage();
  if (!ls) return null;
  const k = keyFor(chainId, diamond, offerId);
  const raw = ls.getItem(k);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as SerializedOffer;
    return {
      id: BigInt(p.id),
      creator: p.creator,
      offerType: p.offerType,
      lendingAsset: p.lendingAsset,
      amount: BigInt(p.amount),
      // #183 — fall back to the floor field when the localStorage
      // snapshot predates Phase 2 (pre-canonical-mapping clients
      // never wrote `*Max` fields into the snapshot). The hydrated
      // OfferData is only used for static cancelled-offer cells;
      // the floor-field fallback renders correctly there.
      amountMax: 'amountMax' in p && p.amountMax != null
        ? BigInt(p.amountMax)
        : BigInt(p.amount),
      interestRateBps: BigInt(p.interestRateBps),
      interestRateBpsMax: 'interestRateBpsMax' in p && p.interestRateBpsMax != null
        ? BigInt(p.interestRateBpsMax)
        : BigInt(p.interestRateBps),
      collateralAsset: p.collateralAsset,
      collateralAmount: BigInt(p.collateralAmount),
      collateralAmountMax: 'collateralAmountMax' in p && p.collateralAmountMax != null
        ? BigInt(p.collateralAmountMax)
        : BigInt(p.collateralAmount),
      durationDays: BigInt(p.durationDays),
      principalLiquidity: p.principalLiquidity,
      collateralLiquidity: p.collateralLiquidity,
      accepted: p.accepted,
      assetType: p.assetType,
      tokenId: BigInt(p.tokenId),
      allowsPartialRepay: p.allowsPartialRepay ?? false,
      periodicInterestCadence:
        typeof p.periodicInterestCadence === 'number' ? p.periodicInterestCadence : 0,
    };
  } catch {
    // Corrupted entry — clear it and move on.
    try {
      ls.removeItem(k);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Drop the oldest entries when localStorage hits its quota. Runs
 *  only as a fallback path inside `writeOfferSnapshot`'s catch — the
 *  steady-state cost is zero. */
function pruneOldEntries(ls: Storage): void {
  try {
    const ours: { key: string; capturedAt: number }[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      const raw = ls.getItem(k);
      if (!raw) continue;
      try {
        const p = JSON.parse(raw) as SerializedOffer;
        ours.push({ key: k, capturedAt: p.capturedAt ?? 0 });
      } catch {
        ls.removeItem(k);
      }
    }
    if (ours.length <= PRUNE_THRESHOLD) return;
    ours.sort((a, b) => a.capturedAt - b.capturedAt);
    const drop = ours.length - PRUNE_TARGET;
    for (let i = 0; i < drop; i++) {
      ls.removeItem(ours[i].key);
    }
  } catch {
    // pruning failed — nothing more to do
  }
}
