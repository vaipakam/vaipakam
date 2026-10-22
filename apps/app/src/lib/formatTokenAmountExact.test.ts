/** #2537 — a review receipt shows the exact figure, never a rounded one. */
import { describe, expect, it } from 'vitest';
import { formatTokenAmount, formatTokenAmountExact } from './format';

describe('formatTokenAmountExact', () => {
  it('keeps every digit the token carries, where the display form rounds', () => {
    const raw = BigInt('1000000' + '123456789012345'.padEnd(18, '0'));
    expect(formatTokenAmountExact(raw, 18)).toBe('1,000,000.123456789012345');
    expect(formatTokenAmount(raw, 18)).toBe('1,000,000.1235'); // rounded up
  });
  it('round-trips to the same base units', () => {
    for (const raw of [1n, 5_370_000_000_000_000n, 123_456_789_123_456_789_123n, 999_999n]) {
      const shown = formatTokenAmountExact(raw, 18).replace(/,/g, '');
      const [i, f = ''] = shown.split('.');
      expect(BigInt(i + f.padEnd(18, '0'))).toBe(raw);
    }
  });
  it('groups the integer part and drops trailing zeros', () => {
    expect(formatTokenAmountExact(12_345_500_000n, 6)).toBe('12,345.5');
    expect(formatTokenAmountExact(7_000_000n, 6)).toBe('7');
    expect(formatTokenAmountExact(0n, 18)).toBe('0');
  });
  it('accepts the decimal-string form indexed rows carry', () => {
    expect(formatTokenAmountExact('100000000000000000001', 18)).toBe('100.000000000000000001');
  });
});
