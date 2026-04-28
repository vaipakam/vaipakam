/**
 * Pure, React-free helpers for OfferBook filtering and anchor-based ranking.
 *
 * Extracted from `pages/OfferBook.tsx` so the filter predicate and side-of-
 * anchor ordering can be exercised in unit tests without mounting the full
 * page. The page component imports these and wires them into its memoised
 * state.
 */

export type LiquidityFilter = 'any' | 'liquid' | 'illiquid';

export interface OfferFilters {
  lendingAsset: string;
  collateralAsset: string;
  minDuration: string;
  maxDuration: string;
  liquidity: LiquidityFilter;
}

interface FilterableOffer {
  lendingAsset: string;
  collateralAsset: string;
  durationDays: bigint;
  principalLiquidity: number;
}

export interface RankableOffer {
  id: bigint;
  interestRateBps: bigint;
}

export function matchesFilter(o: FilterableOffer, f: OfferFilters): boolean {
  if (f.lendingAsset && o.lendingAsset.toLowerCase() !== f.lendingAsset.toLowerCase()) return false;
  if (f.collateralAsset && o.collateralAsset.toLowerCase() !== f.collateralAsset.toLowerCase()) return false;
  const minD = f.minDuration ? BigInt(f.minDuration) : null;
  const maxD = f.maxDuration ? BigInt(f.maxDuration) : null;
  if (minD !== null && o.durationDays < minD) return false;
  if (maxD !== null && o.durationDays > maxD) return false;
  // principalLiquidity is the LiquidityCategory enum: 0 = Liquid, 1 = Illiquid.
  if (f.liquidity === 'liquid' && o.principalLiquidity !== 0) return false;
  if (f.liquidity === 'illiquid' && o.principalLiquidity !== 1) return false;
  return true;
}

export function absDelta(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/**
 * Lender offers: rate DESCENDING by default. With `rankBorrowerSide`
 * sorted ASCENDING, the market-anchor rate sits naturally in the visual
 * middle when both side cards are shown together (highest lender rates
 * at top, lowest borrower rates at bottom, anchor near where the two
 * lists' median rates meet). Mirrors the standard order-book depth-
 * chart convention so the spread is centred and easy to read.
 *
 * The `anchor` parameter is kept in the signature for API stability
 * (the rate-delta annotation still consults it) but is not used in
 * the ordering — the sort is now purely rate-direction-based.
 *
 * Ties on rate fall back to newest-id-first so two offers at the same
 * rate have a deterministic order.
 */
export function rankLenderSide<T extends RankableOffer>(
  list: T[],
  _anchor: bigint | null,
): T[] {
  return [...list].sort((a, b) => {
    if (a.interestRateBps !== b.interestRateBps) {
      return a.interestRateBps > b.interestRateBps ? -1 : 1;
    }
    return a.id < b.id ? 1 : -1;
  });
}

/**
 * Borrower offers: rate ASCENDING — mirror of `rankLenderSide`. Lowest
 * borrower rates surface first; the highest borrower rates (closest to
 * the lender side) sit at the bottom of the card so the market anchor
 * lands in the visual middle when both sides are shown together.
 */
export function rankBorrowerSide<T extends RankableOffer>(
  list: T[],
  _anchor: bigint | null,
): T[] {
  return [...list].sort((a, b) => {
    if (a.interestRateBps !== b.interestRateBps) {
      return a.interestRateBps < b.interestRateBps ? -1 : 1;
    }
    return a.id < b.id ? 1 : -1;
  });
}
