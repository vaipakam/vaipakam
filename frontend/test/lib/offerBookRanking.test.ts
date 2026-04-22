import { describe, it, expect } from 'vitest';
import {
  matchesFilter,
  absDelta,
  rankLenderSide,
  rankBorrowerSide,
  type OfferFilters,
} from '../../src/lib/offerBookRanking';

const USDC = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WETH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NFT = '0xcccccccccccccccccccccccccccccccccccccccc';

function mkOffer(over: Partial<any> = {}) {
  return {
    id: 1n,
    interestRateBps: 500n,
    lendingAsset: USDC,
    collateralAsset: WETH,
    durationDays: 30n,
    principalLiquidity: 0,
    ...over,
  };
}

const NO_FILTERS: OfferFilters = {
  lendingAsset: '',
  collateralAsset: '',
  minDuration: '',
  maxDuration: '',
  liquidity: 'any',
};

describe('absDelta', () => {
  it('returns |a - b| as a non-negative bigint', () => {
    expect(absDelta(10n, 3n)).toBe(7n);
    expect(absDelta(3n, 10n)).toBe(7n);
    expect(absDelta(5n, 5n)).toBe(0n);
  });
});

describe('matchesFilter', () => {
  it('accepts every offer when no filters are set', () => {
    expect(matchesFilter(mkOffer(), NO_FILTERS)).toBe(true);
  });

  it('matches lendingAsset case-insensitively', () => {
    expect(
      matchesFilter(mkOffer({ lendingAsset: USDC }), {
        ...NO_FILTERS,
        lendingAsset: USDC.toUpperCase(),
      }),
    ).toBe(true);
    expect(
      matchesFilter(mkOffer({ lendingAsset: USDC }), {
        ...NO_FILTERS,
        lendingAsset: WETH,
      }),
    ).toBe(false);
  });

  it('matches collateralAsset case-insensitively', () => {
    expect(
      matchesFilter(mkOffer({ collateralAsset: WETH }), {
        ...NO_FILTERS,
        collateralAsset: WETH.toUpperCase(),
      }),
    ).toBe(true);
    expect(
      matchesFilter(mkOffer({ collateralAsset: NFT }), {
        ...NO_FILTERS,
        collateralAsset: WETH,
      }),
    ).toBe(false);
  });

  it('enforces minDuration / maxDuration inclusively', () => {
    expect(
      matchesFilter(mkOffer({ durationDays: 30n }), { ...NO_FILTERS, minDuration: '30' }),
    ).toBe(true);
    expect(
      matchesFilter(mkOffer({ durationDays: 29n }), { ...NO_FILTERS, minDuration: '30' }),
    ).toBe(false);
    expect(
      matchesFilter(mkOffer({ durationDays: 60n }), { ...NO_FILTERS, maxDuration: '60' }),
    ).toBe(true);
    expect(
      matchesFilter(mkOffer({ durationDays: 61n }), { ...NO_FILTERS, maxDuration: '60' }),
    ).toBe(false);
  });

  it('filters by liquidity category (0 liquid / 1 illiquid)', () => {
    expect(
      matchesFilter(mkOffer({ principalLiquidity: 0 }), { ...NO_FILTERS, liquidity: 'liquid' }),
    ).toBe(true);
    expect(
      matchesFilter(mkOffer({ principalLiquidity: 1 }), { ...NO_FILTERS, liquidity: 'liquid' }),
    ).toBe(false);
    expect(
      matchesFilter(mkOffer({ principalLiquidity: 1 }), { ...NO_FILTERS, liquidity: 'illiquid' }),
    ).toBe(true);
    expect(
      matchesFilter(mkOffer({ principalLiquidity: 0 }), { ...NO_FILTERS, liquidity: 'illiquid' }),
    ).toBe(false);
  });

  it('combines filters (AND semantics)', () => {
    const f: OfferFilters = {
      lendingAsset: USDC,
      collateralAsset: WETH,
      minDuration: '10',
      maxDuration: '90',
      liquidity: 'liquid',
    };
    expect(matchesFilter(mkOffer(), f)).toBe(true);
    expect(matchesFilter(mkOffer({ lendingAsset: WETH }), f)).toBe(false);
    expect(matchesFilter(mkOffer({ durationDays: 5n }), f)).toBe(false);
  });
});

describe('rankLenderSide', () => {
  it('orders by newest id descending when there is no anchor', () => {
    const list = [
      mkOffer({ id: 1n, interestRateBps: 300n }),
      mkOffer({ id: 3n, interestRateBps: 500n }),
      mkOffer({ id: 2n, interestRateBps: 400n }),
    ];
    const out = rankLenderSide(list, null);
    expect(out.map((o) => o.id)).toEqual([3n, 2n, 1n]);
  });

  it('places rate>=anchor rows first, nearest to anchor', () => {
    // Anchor is 500. Correct side = 500, 600, 800. Wrong side = 400, 300.
    const list = [
      mkOffer({ id: 1n, interestRateBps: 300n }),
      mkOffer({ id: 2n, interestRateBps: 400n }),
      mkOffer({ id: 3n, interestRateBps: 500n }),
      mkOffer({ id: 4n, interestRateBps: 600n }),
      mkOffer({ id: 5n, interestRateBps: 800n }),
    ];
    const out = rankLenderSide(list, 500n);
    expect(out.map((o) => o.interestRateBps)).toEqual([500n, 600n, 800n, 400n, 300n]);
  });

  it('breaks ties on rate by newest id first', () => {
    const list = [
      mkOffer({ id: 1n, interestRateBps: 600n }),
      mkOffer({ id: 5n, interestRateBps: 600n }),
      mkOffer({ id: 3n, interestRateBps: 600n }),
    ];
    const out = rankLenderSide(list, 500n);
    expect(out.map((o) => o.id)).toEqual([5n, 3n, 1n]);
  });

  it('returns an empty array unchanged', () => {
    expect(rankLenderSide([], 500n)).toEqual([]);
  });
});

describe('rankBorrowerSide', () => {
  it('places rate<=anchor rows first, nearest to anchor', () => {
    const list = [
      mkOffer({ id: 1n, interestRateBps: 300n }),
      mkOffer({ id: 2n, interestRateBps: 400n }),
      mkOffer({ id: 3n, interestRateBps: 500n }),
      mkOffer({ id: 4n, interestRateBps: 600n }),
      mkOffer({ id: 5n, interestRateBps: 800n }),
    ];
    const out = rankBorrowerSide(list, 500n);
    // Correct side (<=500) ordered nearest to anchor first = 500, 400, 300.
    // Wrong side (>500) appended nearest-first = 600, 800.
    expect(out.map((o) => o.interestRateBps)).toEqual([500n, 400n, 300n, 600n, 800n]);
  });

  it('falls back to newest-id ordering with no anchor', () => {
    const list = [
      mkOffer({ id: 1n, interestRateBps: 100n }),
      mkOffer({ id: 2n, interestRateBps: 200n }),
    ];
    expect(rankBorrowerSide(list, null).map((o) => o.id)).toEqual([2n, 1n]);
  });
});
