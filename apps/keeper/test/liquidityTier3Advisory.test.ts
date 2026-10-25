/**
 * #2746 — the Tier-3 "battle-tested elsewhere" advisory requires evidence that
 * the asset is used as COLLATERAL elsewhere, and market presence cannot stand
 * in for it.
 */
import { describe, expect, it } from 'vitest';
import { collateralListed, joinCollateralPools, tier3Verdict } from '../src/liquidityConfidence';

const TOKEN = '0x' + 'a'.repeat(40);
const pool = (over: Record<string, unknown>) => ({
  project: 'aave-v3',
  chain: 'Ethereum',
  pool: 'p1',
  tvlUsd: 50_000_000,
  underlyingTokens: ['0x' + 'A'.repeat(40)],
  ...over,
});

describe('#2746 Tier-3 collateral advisory', () => {
  it('CoinGecko alone never passes: the collateral listing is required', () => {
    expect(tier3Verdict(false, true, true)).toBe(false);
    expect(tier3Verdict(true, false, false)).toBe(false);
    expect(tier3Verdict(true, true, false)).toBe(true);
    expect(tier3Verdict(true, false, true)).toBe(true);
  });

  it('counts a curated pool that enables the asset as collateral', () => {
    const pools = joinCollateralPools({ data: [pool({})] }, [{ pool: 'p1', ltv: 0.8 }]);
    expect(collateralListed(pools, 'Ethereum', TOKEN, 10_000_000)).toBe(true);
  });

  it('a supply-only pool (LTV 0) is not a collateral listing', () => {
    const pools = joinCollateralPools({ data: [pool({})] }, [{ pool: 'p1', ltv: 0 }]);
    expect(collateralListed(pools, 'Ethereum', TOKEN, 10_000_000)).toBe(false);
  });

  it('a pool with no lendBorrow row has no stated LTV and is dropped', () => {
    const pools = joinCollateralPools({ data: [pool({})] }, [{ pool: 'other', ltv: 0.8 }]);
    expect(pools).toEqual([]);
  });

  it('Morpho Blue does not count: its LLTV is above zero by construction', () => {
    const pools = joinCollateralPools({ data: [pool({ project: 'morpho-blue' })] }, [{ pool: 'p1', ltv: 0.86 }]);
    expect(collateralListed(pools, 'Ethereum', TOKEN, 10_000_000)).toBe(false);
  });

  it('respects the chain and the TVL floor', () => {
    const pools = joinCollateralPools(
      { data: [pool({}), pool({ pool: 'p2', chain: 'Base', tvlUsd: 5_000_000 })] },
      [
        { pool: 'p1', ltv: 0.8 },
        { pool: 'p2', ltv: 0.8 },
      ],
    );
    expect(collateralListed(pools, 'Base', TOKEN, 10_000_000)).toBe(false);
    expect(collateralListed(pools, 'Arbitrum', TOKEN, 10_000_000)).toBe(false);
  });

  it('malformed responses yield no rows (fail closed)', () => {
    expect(joinCollateralPools(null, null)).toEqual([]);
    expect(joinCollateralPools({ data: 'x' }, [])).toEqual([]);
    expect(joinCollateralPools({ data: [pool({ tvlUsd: '1' })] }, [{ pool: 'p1', ltv: 0.8 }])).toEqual([]);
  });
});
