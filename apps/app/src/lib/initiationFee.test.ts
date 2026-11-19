import { describe, expect, it } from 'vitest';
import {
  formatLifRate,
  lifFeeOf,
  lifRateBpsDown,
  lifRateBpsUp,
  lifRatePercentText,
  sameLifTerms,
} from './initiationFee';

// The contract defaults (#3649): 0.2% up to 30 days, 0.5% at 365 days, then
// 0.5% a year pro rata.
const T = { baseBps: 20, baseTermDays: 30, yearlyBps: 50, yearDays: 365 };

describe('the initiation fee term rule (mirrors LibInitiationFee)', () => {
  it('charges the base rate up to the base term', () => {
    expect(lifFeeOf(1_000_000n, T, 1)).toBe(2_000n);
    expect(lifFeeOf(1_000_000n, T, 30)).toBe(2_000n);
    expect(formatLifRate(T, 30)).toBe('0.2%');
  });

  it('rises in a straight line to the yearly rate at the one-year point', () => {
    // 31 days: (20·334 + 50·1) / 335 = 20.089… bps.
    expect(lifRateBpsDown(T, 31)).toBe(20);
    expect(lifRateBpsUp(T, 31)).toBe(21);
    expect(lifFeeOf(1_000_000n, T, 31)).toBe(2_008n);
    expect(lifRatePercentText(T, 31)).toBe('0.201');
    expect(lifFeeOf(1_000_000n, T, 365)).toBe(5_000n);
    expect(formatLifRate(T, 365)).toBe('0.5%');
  });

  it('takes the yearly rate pro rata past one year, with no step', () => {
    expect(lifFeeOf(1_000_000n, T, 730)).toBe(10_000n);
    expect(lifRateBpsUp(T, 366)).toBe(51);
    expect(lifRateBpsDown(T, 366)).toBe(50);
    expect(lifFeeOf(3_650_000n, T, 366)).toBe(18_300n);
  });

  it('rounds the displayed rate up so it is never below the rate charged', () => {
    // 200 days: (20·165 + 50·170) / 335 = 35.223… bps → 0.35223…% → "0.353%".
    expect(formatLifRate(T, 200)).toBe('0.353%');
  });

  it('compares two reads, and an unread side never matches', () => {
    expect(sameLifTerms(T, { ...T })).toBe(true);
    expect(sameLifTerms(T, { ...T, yearlyBps: 60 })).toBe(false);
    expect(sameLifTerms(null, T)).toBe(false);
  });
});
