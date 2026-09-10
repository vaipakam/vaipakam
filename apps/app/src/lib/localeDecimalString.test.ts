/**
 * `localeDecimalString` — round 66 P2.
 *
 * The protocol console shows a `uint256` VPFI tier threshold. It is a
 * figure a reader is invited to check against the chain, so the page may
 * neither round it nor print it in a convention the reader did not
 * choose. Those two requirements pull against each other:
 * `localeNumber(Number(s), …)` satisfies the second by breaking the
 * first, because an 18-decimal threshold has more significant digits
 * than a double carries.
 *
 * The cases below pin the resolution — exact digits preserved through a
 * locale format — and, just as importantly, pin what happens when the
 * input is not a plain decimal or the runtime cannot format exactly: the
 * raw string comes back untouched. Losing separators is cosmetic; losing
 * a digit is not.
 */
import { describe, it, expect } from 'vitest';
import { localeDecimalString } from './format';

describe('localeDecimalString', () => {
  it('keeps every digit of an 18-decimal threshold', () => {
    // 1000 VPFI + 1 wei. `Number()` collapses the trailing 1 — that is
    // the whole reason this helper exists rather than a `Number` cast.
    const exact = '1000.000000000000000001';
    expect(Number(exact).toString()).not.toContain('000000000000000001');
    expect(localeDecimalString(exact, 'en')).toBe('1,000.000000000000000001');
  });

  it('applies the locale grouping and decimal mark', () => {
    expect(localeDecimalString('1234567.5', 'de')).toBe('1.234.567,5');
  });

  it('formats an integer threshold without inventing a fraction', () => {
    expect(localeDecimalString('10000', 'en')).toBe('10,000');
  });

  it('handles a value below one', () => {
    expect(localeDecimalString('0.000000000000000001', 'en')).toBe(
      '0.000000000000000001',
    );
  });

  it('handles a negative value', () => {
    expect(localeDecimalString('-1234.25', 'en')).toBe('-1,234.25');
  });

  it('returns a non-numeric string unchanged rather than NaN', () => {
    // A malformed value from the indexer is passed through as-is. The
    // caller's job is to show what the source sent; turning it into
    // "NaN" would assert the page had understood it.
    expect(localeDecimalString('not-a-number', 'en')).toBe('not-a-number');
    expect(localeDecimalString('', 'en')).toBe('');
    expect(localeDecimalString('1e18', 'en')).toBe('1e18');
    expect(localeDecimalString('0x10', 'en')).toBe('0x10');
  });

  it('falls back to the raw string for an unknown locale rather than throwing', () => {
    // `Intl` throws a RangeError on a malformed language tag. A figure
    // rendered unformatted is a worse-looking page; a thrown error is a
    // blank one.
    expect(localeDecimalString('1234.5', 'not a tag')).toBe('1234.5');
  });

  it('treats undefined as the runtime default rather than failing', () => {
    expect(localeDecimalString('1234.5', undefined)).toMatch(/1.?234/);
  });
});
