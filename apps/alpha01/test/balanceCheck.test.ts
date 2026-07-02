import { describe, expect, it } from 'vitest';
import { assessCollateralBalance } from '../src/lib/balanceCheck';

const balance = {
  wallet: 50_000_000_000_000_000n,
  vault: 50_000_000_000_000_000n,
  total: 100_000_000_000_000_000n,
  decimals: 18,
  symbol: 'mWETH',
};

const tokenAddress = '0x4200000000000000000000000000000000000006';

describe('assessCollateralBalance', () => {
  it('shows available balance before an amount is entered', () => {
    const result = assessCollateralBalance({
      needHuman: '',
      balance,
      tokenAddress,
      meta: null,
      loading: false,
    });
    expect(result.available?.amount).toBe('0.1');
    expect(result.available?.meta?.symbol).toBe('mWETH');
    expect(result.shortfall).toBeNull();
    expect(result.sufficient).toBeNull();
  });

  it('flags shortfall when total is below need', () => {
    const result = assessCollateralBalance({
      needHuman: '0.2',
      balance,
      tokenAddress,
      meta: null,
      loading: false,
    });
    expect(result.sufficient).toBe(false);
    expect(result.shortfall?.need.amount).toBe('0.2');
    expect(result.shortfall?.have.amount).toBe('0.1');
  });

  it('passes when total covers need', () => {
    const result = assessCollateralBalance({
      needHuman: '0.1',
      balance,
      tokenAddress,
      meta: null,
      loading: false,
    });
    expect(result.sufficient).toBe(true);
    expect(result.shortfall).toBeNull();
  });

  it('reports loading state', () => {
    const result = assessCollateralBalance({
      needHuman: '0.1',
      balance,
      tokenAddress,
      meta: null,
      loading: true,
    });
    expect(result.loading).toBe(true);
    expect(result.available).toBeNull();
  });
});