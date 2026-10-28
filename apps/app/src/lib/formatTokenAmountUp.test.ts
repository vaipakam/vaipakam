import { describe, expect, it } from 'vitest';

import { formatTokenAmountDown, formatTokenAmountUp } from './format';

const e18 = (s: string) => {
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const v = BigInt(i + f.padEnd(18, '0'));
  return neg ? -v : v;
};

describe('formatTokenAmountUp', () => {
  it('rounds up at the shown precision instead of to nearest', () => {
    expect(formatTokenAmountUp(e18('1.23441'), 18)).toBe('1.2345');
    expect(formatTokenAmountUp(e18('33.333333333333333334'), 18)).toBe('33.3334');
  });
  it('leaves an exact figure alone', () => {
    expect(formatTokenAmountUp(e18('1.2345'), 18)).toBe('1.2345');
    expect(formatTokenAmountUp(e18('7'), 18)).toBe('7');
    expect(formatTokenAmountUp(0n, 18)).toBe('0');
  });
  it('carries into the integer part', () => {
    expect(formatTokenAmountUp(e18('0.99995'), 18)).toBe('1');
    expect(formatTokenAmountUp(e18('9999.99999'), 18)).toBe('10,000');
  });
  it('keeps four significant digits below one, rounded up', () => {
    expect(formatTokenAmountUp(e18('0.000123401'), 18)).toBe('0.0001235');
  });
  it('never states less than the exact value', () => {
    for (const s of ['1.99999', '0.00099999', '123.45678', '9.9999999', '0.000000000000000001']) {
      const shown = formatTokenAmountUp(e18(s), 18).replace(/,/g, '');
      expect(e18(shown) >= e18(s), s).toBe(true);
    }
  });
  it('bounds a negative amount from above, and the down bound from below', () => {
    expect(formatTokenAmountUp(e18('-1.23456'), 18)).toBe('-1.2345');
    expect(formatTokenAmountDown(e18('-1.23456'), 18)).toBe('-1.2346');
  });
});
