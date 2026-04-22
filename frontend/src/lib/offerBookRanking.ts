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
 * Lender offers: correct side = rate >= anchor, sorted nearest to anchor.
 * Wrong-side rows (rate < anchor) are appended after the correct side, also
 * sorted nearest-first. With no anchor, rows are ordered newest-id-first.
 */
export function rankLenderSide<T extends RankableOffer>(list: T[], anchor: bigint | null): T[] {
  if (anchor === null) return [...list].sort((a, b) => (a.id < b.id ? 1 : -1));
  const correct = list.filter((o) => o.interestRateBps >= anchor);
  const wrong = list.filter((o) => o.interestRateBps < anchor);
  const byDeltaThenId = (a: T, b: T) => {
    const d = absDelta(a.interestRateBps, anchor) - absDelta(b.interestRateBps, anchor);
    if (d !== 0n) return d < 0n ? -1 : 1;
    return a.id < b.id ? 1 : -1;
  };
  correct.sort(byDeltaThenId);
  wrong.sort(byDeltaThenId);
  return [...correct, ...wrong];
}

/** Borrower offers: mirror of `rankLenderSide` — correct side = rate <= anchor. */
export function rankBorrowerSide<T extends RankableOffer>(list: T[], anchor: bigint | null): T[] {
  if (anchor === null) return [...list].sort((a, b) => (a.id < b.id ? 1 : -1));
  const correct = list.filter((o) => o.interestRateBps <= anchor);
  const wrong = list.filter((o) => o.interestRateBps > anchor);
  const byDeltaThenId = (a: T, b: T) => {
    const d = absDelta(a.interestRateBps, anchor) - absDelta(b.interestRateBps, anchor);
    if (d !== 0n) return d < 0n ? -1 : 1;
    return a.id < b.id ? 1 : -1;
  };
  correct.sort(byDeltaThenId);
  wrong.sort(byDeltaThenId);
  return [...correct, ...wrong];
}
