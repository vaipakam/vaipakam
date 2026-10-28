import { describe, expect, it } from 'vitest';
import { GAS_LIMIT_MARGIN_PCT, gasLimitFromEstimate } from './gasLimit';

describe('gasLimitFromEstimate', () => {
  it('adds the margin to the estimate', () => {
    expect(GAS_LIMIT_MARGIN_PCT).toBe(30n);
    expect(gasLimitFromEstimate(1_000_000n)).toBe(1_300_000n);
  });

  it('rounds up, so the limit never falls below estimate plus margin', () => {
    expect(gasLimitFromEstimate(23_306n)).toBe(30_298n); // 30,297.8
    expect(gasLimitFromEstimate(1n)).toBe(2n);
    expect(gasLimitFromEstimate(0n)).toBe(0n);
  });

  it('covers the drift #2997 measured', () => {
    // remitRewardBudget: estimated 917,454 and reverted when mined having
    // used 903,572; a limit of 1.3x is far above the extra the mined block
    // needed.
    expect(gasLimitFromEstimate(917_454n) > 917_454n + 917_454n / 64n).toBe(true);
  });

  it('refuses a negative estimate', () => {
    expect(() => gasLimitFromEstimate(-1n)).toThrow(RangeError);
  });
});
