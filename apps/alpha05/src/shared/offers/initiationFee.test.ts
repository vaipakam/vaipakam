import { describe, expect, it } from 'vitest';
import { lifFeeOf, lifRateBpsUp, lifRateText, sameLifTerms } from './initiationFee';

// The protocol defaults (#3649): 0.2% up to 30 days, 0.5% at 365 days, then
// 0.5% a year pro rata.
const T = { baseBps: 20n, baseTermDays: 30n, yearlyBps: 50n, yearDays: 365n };

describe('the initiation fee term rule', () => {
  it('is the base rate up to the base term, the yearly rate at a year, and pro rata beyond', () => {
    expect(lifFeeOf(1_000_000n, T, 30)).toBe(2_000n);
    expect(lifFeeOf(1_000_000n, T, 31)).toBe(2_008n);
    expect(lifFeeOf(1_000_000n, T, 365n)).toBe(5_000n);
    expect(lifFeeOf(1_000_000n, T, 730)).toBe(10_000n);
  });

  it('rounds a cap and a shown rate up', () => {
    expect(lifRateBpsUp(T, 30)).toBe(20n);
    expect(lifRateBpsUp(T, 31)).toBe(21n);
    expect(lifRateText(T, 30)).toBe('0.2');
    expect(lifRateText(T, 200)).toBe('0.353');
  });

  it('compares two reads', () => {
    expect(sameLifTerms(T, { ...T })).toBe(true);
    expect(sameLifTerms(T, { ...T, baseTermDays: 31n })).toBe(false);
  });
});
