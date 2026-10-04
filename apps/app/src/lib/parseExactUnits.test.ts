/** #2389 r3 — a typed amount is parsed exactly; excess precision is
 *  refused, never rounded into a different amount. */
import { describe, expect, it } from 'vitest';
import { exactUnitsOrNull, isTooPrecise, parseExactUnits } from './format';

describe('parseExactUnits', () => {
  it('parses within the token’s precision exactly', () => {
    expect(parseExactUnits('1.5', 6)).toBe(1_500_000n);
    expect(parseExactUnits('0.000001', 6)).toBe(1n);
    expect(parseExactUnits('.5', 2)).toBe(50n);
    expect(parseExactUnits('7', 0)).toBe(7n);
  });
  it('refuses more decimals than the token has instead of rounding', () => {
    expect(parseExactUnits('0.0000009', 6)).toBe('too-precise');
    expect(parseExactUnits('0.6', 0)).toBe('too-precise');
  });
  it('ignores trailing zeros past the precision', () => {
    expect(parseExactUnits('1.500000000', 6)).toBe(1_500_000n);
  });
  it('rejects text that is not a plain decimal', () => {
    for (const v of ['', '.', 'abc', '1e3', '-1', '1,5']) {
      expect(parseExactUnits(v, 18), v).toBe('invalid');
    }
  });
});

describe('exactUnitsOrNull / isTooPrecise (#2390)', () => {
  it('returns the exact amount, or null for anything it cannot send as typed', () => {
    expect(exactUnitsOrNull('2.25', 6)).toBe(2_250_000n);
    expect(exactUnitsOrNull('0.0000009', 6)).toBeNull();
    expect(exactUnitsOrNull('abc', 6)).toBeNull();
  });
  it('names only the excess-precision case', () => {
    expect(isTooPrecise('0.0000009', 6)).toBe(true);
    expect(isTooPrecise('0.6', 0)).toBe(true);
    expect(isTooPrecise('1.5', 6)).toBe(false);
    expect(isTooPrecise('abc', 6)).toBe(false);
    expect(isTooPrecise('', 6)).toBe(false);
  });
});
