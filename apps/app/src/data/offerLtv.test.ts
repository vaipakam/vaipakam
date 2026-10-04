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
    // A single-size lend offer: amount == amountMax, nothing taken.
    expect(offerLtv(offer({ amount: '1000000000' }), PRICED)).toEqual({
      kind: 'value',
      bps: 5000n,
      ranged: false,
    });
  });
  it('marks a ranged or part-taken lend offer — a fill of another size can differ (r1)', () => {
    expect(offerLtv(offer(), PRICED)).toEqual({ kind: 'value', bps: 5000n, ranged: true });
    expect(
      offerLtv(offer({ amount: '1000000000', amountFilled: '1' }), PRICED),
    ).toEqual({ kind: 'value', bps: 5000n, ranged: true });
  });
  it('never presents a borrow request’s figure as exact or as a ceiling (r1)', () => {
    // Single-size on purpose (amount == amountMax, nothing taken), so the
    // only thing marking it is its being a borrow request — the floor
    // collateral whose ceiling the row does not carry.
    expect(
      offerLtv(offer({ offerType: 1, amount: '500000000', amountMax: '500000000' }), PRICED),
    ).toEqual({
      kind: 'value',
      bps: 2500n,
      ranged: true,
    });
  });
  it('keeps precision for small offers instead of flooring to 0%', () => {
    // 1 USDC against 0.001 WETH ($2) → 50%, not a whole-dollar 0.
    expect(
      offerLtv(
        offer({ amount: '1000000', amountMax: '1000000', collateralAmount: '1000000000000000' }),
        PRICED,
      ),
    ).toEqual({ kind: 'value', bps: 5000n, ranged: false });
  });
  it('says too small — never 0% — when EITHER side’s value rounds to nothing (r1)', () => {
    // A sub-cent, 18-decimal lending token: 1 base unit values to 0.
    const m = new Map(PRICED);
    m.set(USDC, { kind: 'priced', price: 1n, feedDecimals: 8, tokenDecimals: 18 });
    expect(offerLtv(offer({ amount: '1', amountMax: '1' }), m)).toEqual({ kind: 'tooSmall' });
    const c = new Map(PRICED);
    c.set(WETH, { kind: 'priced', price: 1n, feedDecimals: 8, tokenDecimals: 18 });
    expect(offerLtv(offer({ collateralAmount: '1' }), c)).toEqual({ kind: 'tooSmall' });
  });
  it('names an illiquid leg as such, whatever the other read did (r1)', () => {
    const m = new Map(PRICED);
    m.set(WETH, { kind: 'illiquid' });
    expect(offerLtv(offer(), m)).toEqual({ kind: 'illiquid' });
    m.set(USDC, { kind: 'failed' });
    expect(offerLtv(offer(), m)).toEqual({ kind: 'illiquid' });
  });
  it('says unknown — not illiquid — when a read failed', () => {
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
