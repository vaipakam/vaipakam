import {
  collateralLiquidityLabel,
  formatHealthFactor,
  formatLtvBps,
  isHealthFactorAtRisk,
  MIN_HEALTH_FACTOR_1E18,
} from '@vaipakam/defi-client';
import { describe, expect, it } from 'vitest';

describe('risk formatters', () => {
  it('formats 1e18-scaled health factor', () => {
    expect(formatHealthFactor(15n * 10n ** 17n)).toBe('1.5');
    expect(formatHealthFactor(2n * 10n ** 18n)).toBe('2');
  });

  it('formats LTV basis points', () => {
    expect(formatLtvBps(7000n)).toBe('70.00%');
    expect(formatLtvBps(6550n)).toBe('65.50%');
  });

  it('flags HF below protocol minimum', () => {
    expect(isHealthFactorAtRisk(MIN_HEALTH_FACTOR_1E18)).toBe(false);
    expect(isHealthFactorAtRisk(MIN_HEALTH_FACTOR_1E18 - 1n)).toBe(true);
    expect(isHealthFactorAtRisk(null)).toBe(false);
    expect(isHealthFactorAtRisk(0n)).toBe(true);
    expect(isHealthFactorAtRisk(2n * 10n ** 18n, 25n * 10n ** 17n)).toBe(true);
  });

  it('labels collateral liquidity from indexer classification', () => {
    expect(collateralLiquidityLabel(0)).toContain('Liquid');
    expect(collateralLiquidityLabel(1)).toContain('Illiquid');
    expect(collateralLiquidityLabel(undefined, 1)).toContain('Illiquid');
  });
});