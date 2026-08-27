import { describe, it, expect } from 'vitest';
import { parseUnits } from 'viem';
import { isCeilingOvertaken, shouldBlockOnCeiling } from './fullTariffCeiling';

const v = (s: string) => parseUnits(s, 18);
const base = {
  full: true,
  featureEnabled: true,
  fullBlocked: false,
  quoted: v('2'),
  ceiling: v('1'),
};

describe('isCeilingOvertaken', () => {
  it('is true when the live quote has passed the authorized ceiling', () => {
    expect(isCeilingOvertaken(base)).toBe(true);
  });
  it('is false at the boundary — the contract compares cStar > maxCStar', () => {
    expect(isCeilingOvertaken({ ...base, ceiling: v('2') })).toBe(false);
  });
  it('is false when Full is not engaged', () => {
    expect(isCeilingOvertaken({ ...base, full: false })).toBe(false);
  });
  it('defers to a REAL blocker rather than masking it (#1700 r1)', () => {
    // A cached successful quote can outlive the liquidity verdict turning
    // illiquid; the ceiling notice must not promise that raising the ceiling
    // would let the user continue when it would not.
    expect(isCeilingOvertaken({ ...base, fullBlocked: true })).toBe(false);
    expect(isCeilingOvertaken({ ...base, featureEnabled: false })).toBe(false);
  });
  it('is false with no quote or no ceiling expressed', () => {
    expect(isCeilingOvertaken({ ...base, quoted: undefined })).toBe(false);
    expect(isCeilingOvertaken({ ...base, ceiling: undefined })).toBe(false);
  });
  it('treats a zero ceiling as unexpressed — that is the maxCStarRequired path', () => {
    expect(isCeilingOvertaken({ ...base, ceiling: 0n })).toBe(false);
  });
  it('catches a sub-display-precision overtake (#1700 r1)', () => {
    expect(
      isCeilingOvertaken({ ...base, quoted: v('1.00002'), ceiling: v('1.00001') }),
    ).toBe(true);
  });
});

describe('shouldBlockOnCeiling', () => {
  it('BLOCKS a strict opt-in whose ceiling the quote has passed', () => {
    expect(
      shouldBlockOnCeiling({ ceilingOvertaken: true, allowDowngrade: false }),
    ).toBe(true);
  });

  // The branch no other tier reaches. #1700 shipped this as a block and round 3
  // corrected it: the downgrade checkbox promises the loan still opens without
  // Full in exactly this situation, and the contract obliges via `_downgrade`,
  // so refusing would break that promise and reject an acceptance that works.
  // The fork arm asserts the box is UNTICKED before testing the block, so this
  // direction is asserted here or nowhere.
  it('does NOT block when the acceptor permitted a downgrade — the loan opens without Full', () => {
    expect(
      shouldBlockOnCeiling({ ceilingOvertaken: true, allowDowngrade: true }),
    ).toBe(false);
  });

  it('does not block when the ceiling has not been overtaken, either way', () => {
    expect(
      shouldBlockOnCeiling({ ceilingOvertaken: false, allowDowngrade: false }),
    ).toBe(false);
    expect(
      shouldBlockOnCeiling({ ceilingOvertaken: false, allowDowngrade: true }),
    ).toBe(false);
  });
});
