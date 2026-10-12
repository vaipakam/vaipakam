/** #2389 r2 — an upper bound is displayed truncated, never rounded up. */
import { describe, expect, it } from 'vitest';
import { formatTokenAmountDown } from './format';

const e18 = (s: string) => {
  const [i, f = ''] = s.split('.');
  return BigInt(i + f.padEnd(18, '0'));
};

describe('formatTokenAmountDown', () => {
  it('truncates instead of rounding up', () => {
    expect(formatTokenAmountDown(e18('1.23456'), 18)).toBe('1.2345');
    expect(formatTokenAmountDown(e18('0.99999'), 18)).toBe('0.9999');
  });
  it('keeps four significant digits below one, truncated', () => {
    expect(formatTokenAmountDown(e18('0.000123456'), 18)).toBe('0.0001234');
  });
  it('groups the integer part and drops trailing zeros', () => {
    expect(formatTokenAmountDown(e18('12345.5'), 18)).toBe('12,345.5');
    expect(formatTokenAmountDown(e18('7'), 18)).toBe('7');
    expect(formatTokenAmountDown(0n, 18)).toBe('0');
  });
  it('never states more than the exact value', () => {
    for (const s of ['1.99999', '0.00099999', '123.45678', '9.9999999']) {
      const shown = formatTokenAmountDown(e18(s), 18).replace(/,/g, '');
      expect(e18(shown) <= e18(s), s).toBe(true);
    }
  });
});
