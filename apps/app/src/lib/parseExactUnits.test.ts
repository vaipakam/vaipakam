/** #2389 r3 — a typed amount is parsed exactly; excess precision is
 *  refused, never rounded into a different amount. */
import { describe, expect, it } from 'vitest';
import { parseExactUnits } from './format';

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
