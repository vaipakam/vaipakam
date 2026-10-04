/** #2384 — the LTV an Offer Book card states, and its honest unknowns. */
import { describe, expect, it } from 'vitest';
import { offerLtv, pricingFacts, type AssetPricing } from './offerLtv';
import { AssetType } from '../lib/types';

const USDC = '0x00000000000000000000000000000000000000a1';
const WETH = '0x00000000000000000000000000000000000000b2';
// USDC: 6 decimals at $1 (8-dec feed). WETH: 18 decimals at $2,000.
const PRICED: ReadonlyMap<string, AssetPricing> = new Map<string, AssetPricing>([
  [USDC, { kind: 'priced', price: 100_000_000n, feedDecimals: 8, tokenDecimals: 6 }],
  [WETH, { kind: 'priced', price: 200_000_000_000n, feedDecimals: 8, tokenDecimals: 18 }],
]);

const offer = (over: Partial<Parameters<typeof offerLtv>[0]> = {}) => ({
  offerType: 0,
  assetType: AssetType.ERC20,
  collateralAssetType: AssetType.ERC20,
  lendingAsset: USDC,
  collateralAsset: WETH,
  // Lend 1,000 USDC against 1 WETH ($2,000) → 50%.
  amount: '100000000',
  amountMax: '1000000000',
  collateralAmount: '1000000000000000000',
  ...over,
});

describe('offerLtv', () => {
  it('values each leg by its own token decimals — mixed-decimal pairs are right (#2403)', () => {
    expect(offerLtv(offer(), PRICED)).toEqual({ kind: 'value', bps: 5000n, bound: 'exact' });
  });
  it('uses the lend offer’s full amount, and states a borrow request’s figure as a ceiling', () => {
    expect(offerLtv(offer({ offerType: 1, amount: '500000000' }), PRICED)).toEqual({
      kind: 'value',
      bps: 2500n,
      bound: 'atMost',
    });
  });
  it('keeps precision for small offers instead of flooring to 0%', () => {
    // 1 USDC against 0.001 WETH ($2) → 50%, not a whole-dollar 0.
    expect(
      offerLtv(offer({ amountMax: '1000000', collateralAmount: '1000000000000000' }), PRICED),
    ).toEqual({ kind: 'value', bps: 5000n, bound: 'exact' });
  });
  it('says a leg can’t be priced when it is illiquid, whatever the other read did', () => {
    const m = new Map(PRICED);
    m.set(WETH, { kind: 'illiquid' });
    expect(offerLtv(offer(), m)).toEqual({ kind: 'unpriced' });
    m.set(USDC, { kind: 'failed' });
    expect(offerLtv(offer(), m)).toEqual({ kind: 'unpriced' });
  });
  it('says unknown — not unpriced — when a read failed', () => {
    const m = new Map(PRICED);
    m.set(USDC, { kind: 'failed' });
    expect(offerLtv(offer(), m)).toEqual({ kind: 'unknown' });
    expect(offerLtv(offer(), null)).toEqual({ kind: 'unknown' });
  });
  it('is loading until the batch answers', () => {
    expect(offerLtv(offer(), undefined)).toEqual({ kind: 'loading' });
    expect(offerLtv(offer(), new Map())).toEqual({ kind: 'loading' });
  });
  it('states nothing for rows with no ratio', () => {
    expect(offerLtv(offer({ assetType: AssetType.ERC721 }), PRICED)).toEqual({ kind: 'none' });
    expect(offerLtv(offer({ collateralAssetType: AssetType.ERC1155 }), PRICED)).toEqual({ kind: 'none' });
    expect(offerLtv(offer({ collateralAmount: '0' }), PRICED)).toEqual({ kind: 'none' });
    expect(offerLtv(offer({ isSaleVehicle: true }), PRICED)).toEqual({ kind: 'none' });
  });
});

describe('pricingFacts', () => {
  const plan = [{ asset: USDC }];
  const ok = (result: unknown) => ({ status: 'success' as const, result });
  const bad = { status: 'failure' as const };
  it('maps a liquid, priced asset', () => {
    expect(pricingFacts(plan, [ok(0), ok([100_000_000n, 8]), ok(6)], 0).get(USDC)).toEqual({
      kind: 'priced',
      price: 100_000_000n,
      feedDecimals: 8,
      tokenDecimals: 6,
    });
  });
  it('reads a non-liquid status as illiquid', () => {
    expect(pricingFacts(plan, [ok(1), bad, bad], 0).get(USDC)).toEqual({ kind: 'illiquid' });
  });
  it('never reads a failed liquidity check as illiquid', () => {
    expect(pricingFacts(plan, [bad, ok([1n, 8]), ok(6)], 0).get(USDC)).toEqual({ kind: 'failed' });
  });
  it('fails a liquid asset whose price or decimals did not answer', () => {
    expect(pricingFacts(plan, [ok(0), bad, ok(6)], 0).get(USDC)).toEqual({ kind: 'failed' });
    expect(pricingFacts(plan, [ok(0), ok([1n, 8]), bad], 0).get(USDC)).toEqual({ kind: 'failed' });
  });
});
