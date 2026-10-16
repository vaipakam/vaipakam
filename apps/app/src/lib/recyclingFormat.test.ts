/**
 * The recycling surfaces' display rules (#1349 M5), pinned at the helper
 * level so a regression shows up here before it shows up as a wrong cell.
 *
 * Each rule is from TokenomicsTechSpec §"Recycling transparency series":
 * a positive amount is never shown as zero; a share rounds in the direction
 * that cannot overstate; a caveat's condition is judged at the displayed
 * precision. The float cases are here because the obvious implementation
 * of "round down" gets an exact 57% wrong.
 */
import { describe, expect, it } from 'vitest';
import { copy } from '../content/copy';
import {
  displayedUnits,
  formatRoundedDownPercent,
  formatVpfiWei,
  formatVpfiWeiCeil,
  isWeiString,
  MIN_DISPLAYABLE_WEI,
  partsVisiblyExceed,
  roundedDownTenths,
  roundedDownTenthsOfPercent,
} from './recyclingFormat';

const E18 = 10n ** 18n;
const wei = (n: bigint) => n.toString();

describe('formatVpfiWei — a positive amount is never shown as zero', () => {
  it('the display precision is four decimals of VPFI (1e14 wei)', () => {
    expect(MIN_DISPLAYABLE_WEI).toBe(10n ** 14n);
  });

  it('labels 1 wei as below the precision, not 0', () => {
    expect(formatVpfiWei('1', 'en')).toBe(copy.recycling.belowPrecision('0.0001'));
    expect(formatVpfiWei('1', 'en')).toBe('less than 0.0001');
  });

  it('labels the largest below-precision amount too (boundary − 1)', () => {
    expect(formatVpfiWei(wei(MIN_DISPLAYABLE_WEI - 1n), 'en')).toBe('less than 0.0001');
  });

  it('shows the precision boundary itself as a figure', () => {
    expect(formatVpfiWei(wei(MIN_DISPLAYABLE_WEI), 'en')).toBe('0.0001');
  });

  it('shows a genuine zero as zero — the label means small, not unknown', () => {
    expect(formatVpfiWei('0', 'en')).toBe('0');
  });

  it('groups whole tokens in the reader’s locale', () => {
    expect(formatVpfiWei(wei(1234n * E18), 'en')).toBe('1,234');
    expect(formatVpfiWei(wei(1234n * E18 + E18 / 2n), 'de')).toBe('1.234,5');
  });

  it('TRUNCATES past four decimals — rounding up would overstate', () => {
    // 0.99995 VPFI must not display as 1.
    expect(formatVpfiWei(wei((99995n * E18) / 100000n), 'en')).toBe('0.9999');
    expect(formatVpfiWei(wei(1234567890000000000n), 'en')).toBe('1.2345');
  });

  it('keeps every digit of a figure beyond double precision', () => {
    // 123456789012345678 VPFI + 0.0001 — far past Number.MAX_SAFE_INTEGER.
    const big = 123456789012345678n * E18 + MIN_DISPLAYABLE_WEI;
    expect(formatVpfiWei(wei(big), 'en')).toBe('123,456,789,012,345,678.0001');
  });

  it('throws on a malformed figure rather than coercing it to zero', () => {
    expect(() => formatVpfiWei('12,34', 'en')).toThrow(RangeError);
    expect(() => formatVpfiWei('', 'en')).toThrow(RangeError);
    expect(() => formatVpfiWei('-1', 'en')).toThrow(RangeError);
  });
});

describe('formatVpfiWeiCeil — a shortfall is never shown smaller than published', () => {
  it('rounds a shortfall of 25.00009 VPFI UP to 25.0001, never down to 25', () => {
    const gap = wei(25n * E18 + 9n * 10n ** 13n); // 25.00009
    expect(formatVpfiWei(gap, 'en')).toBe('25'); // the truncating formatter flatters it
    expect(formatVpfiWeiCeil(gap, 'en')).toBe('25.0001');
  });

  it('leaves an exact display unit unchanged', () => {
    expect(formatVpfiWeiCeil(wei(25n * E18), 'en')).toBe('25');
    expect(formatVpfiWeiCeil(wei(MIN_DISPLAYABLE_WEI), 'en')).toBe('0.0001');
  });

  it('keeps the below-precision label rather than rounding dust up to 0.0001', () => {
    expect(formatVpfiWeiCeil('1', 'en')).toBe('less than 0.0001');
    expect(formatVpfiWeiCeil(wei(MIN_DISPLAYABLE_WEI - 1n), 'en')).toBe('less than 0.0001');
    expect(formatVpfiWeiCeil('0', 'en')).toBe('0');
  });

  it('throws on a malformed figure rather than coercing it', () => {
    expect(() => formatVpfiWeiCeil('-1', 'en')).toThrow(RangeError);
  });
});

describe('isWeiString', () => {
  it('accepts only unsigned integer decimal strings', () => {
    expect(isWeiString('0')).toBe(true);
    expect(isWeiString('123')).toBe(true);
    for (const bad of ['', ' 1', '1.0', '-1', '1e18', '0x10', 12, null, undefined]) {
      expect(isWeiString(bad)).toBe(false);
    }
  });
});

describe('displayedUnits — what the reader actually sees', () => {
  it('agrees with the formatter at the boundary', () => {
    expect(displayedUnits(wei(MIN_DISPLAYABLE_WEI - 1n))).toBe(0n);
    expect(displayedUnits(wei(MIN_DISPLAYABLE_WEI))).toBe(1n);
    expect(displayedUnits(wei(5n * E18))).toBe(50_000n);
  });
});

describe('shares round DOWN', () => {
  it('never rounds a partially self-funded day up to 100%', () => {
    expect(roundedDownTenthsOfPercent(0.9995)).toBe(999);
    expect(formatRoundedDownPercent(0.9995, 'en')).toBe('99.9%');
    expect(formatRoundedDownPercent(0.999999, 'en')).toBe('99.9%');
  });

  it('shows 100% only when the ratio is exactly 1', () => {
    expect(formatRoundedDownPercent(1, 'en')).toBe('100%');
  });

  it('keeps an exact published share exact', () => {
    // A ×1000 scaling would trip here (0.57 * 1000 = 569.9999999999999);
    // the ×1e6 recovery does not.
    expect(roundedDownTenthsOfPercent(0.57)).toBe(570);
    expect(formatRoundedDownPercent(0.57, 'en')).toBe('57%');
    expect(roundedDownTenthsOfPercent(0.29)).toBe(290);
  });

  it('a value finer than six decimals is floored, never rounded up into 100%', () => {
    // The indexer never sends one, but the recovery step must not be the
    // thing that overstates if it ever did: 0.9999996 is not 100%.
    expect(roundedDownTenthsOfPercent(0.9999996)).toBe(999);
    expect(formatRoundedDownPercent(0.9999996, 'en')).toBe('99.9%');
  });

  it('still floors a genuinely-below value at the next tenth', () => {
    expect(roundedDownTenthsOfPercent(0.569999)).toBe(569);
    expect(roundedDownTenthsOfPercent(0.000999)).toBe(0);
  });

  it('a positive share below a tenth of a percent is LABELLED, never "0%"', () => {
    // The floor value is 0 tenths — but what the reader SEES must not be.
    expect(formatRoundedDownPercent(0.000999, 'en')).toBe(
      copy.recycling.shareBelowPrecision('0.1'),
    );
    expect(formatRoundedDownPercent(0.000999, 'en')).toBe('less than 0.1%');
    expect(formatRoundedDownPercent(0.000001, 'en')).toBe('less than 0.1%');
    // The boundary itself is a figure.
    expect(formatRoundedDownPercent(0.001, 'en')).toBe('0.1%');
    // In the reader's number format.
    expect(formatRoundedDownPercent(0.000001, 'de')).toBe('less than 0,1%');
  });

  it('a genuine zero share is still "0%" — the label means small, not unknown', () => {
    expect(formatRoundedDownPercent(0, 'en')).toBe('0%');
  });

  it('does not clamp a ratio above 1 (loop closure can exceed it)', () => {
    expect(formatRoundedDownPercent(1.5, 'en')).toBe('150%');
  });

  it('formats the percentage in the reader’s locale', () => {
    expect(formatRoundedDownPercent(0.255, 'de')).toBe('25,5%');
  });

  it('floors a runway day count to tenths', () => {
    expect(roundedDownTenths(3.99)).toBe(39);
    expect(roundedDownTenths(0.04)).toBe(0);
  });

  it('does not turn an exact published runway into the tenth below it', () => {
    // 4.1 * 1e6 is 4099999.9999999995 in floating point: a naive floor
    // shows a published 4.1 days as 4.0. Each of these trips it.
    for (const [v, tenths] of [[4.1, 41], [8.2, 82], [16.4, 164], [33.3, 333]] as const) {
      expect(roundedDownTenths(v)).toBe(tenths);
    }
  });
});

describe('partsVisiblyExceed — a caveat judged at the displayed precision', () => {
  const E14 = MIN_DISPLAYABLE_WEI;
  it('a units excess is visible', () => {
    expect(partsVisiblyExceed([wei(5n * E18), wei(3n * E18)], wei(5n * E18))).toBe(true);
  });

  it('equal figures are not an excess', () => {
    expect(partsVisiblyExceed([wei(5n * E18), wei(3n * E18)], wei(8n * E18))).toBe(false);
  });

  it('a wei-level excess hidden in every cell is not visible', () => {
    expect(partsVisiblyExceed(['5', '3'], '5')).toBe(false);
  });

  it('a "less than 0.0001" part beside a combined "0" IS visible', () => {
    // displayedUnits counts both sides as 0; a reader sees positive > 0.
    expect(partsVisiblyExceed(['1', '0'], '0')).toBe(true);
    expect(partsVisiblyExceed(['0', wei(E14 - 1n)], '0')).toBe(true);
  });

  it('all-zero parts over a zero total are not an excess', () => {
    expect(partsVisiblyExceed(['0', '0'], '0')).toBe(false);
  });

  it('a below-precision part does not, alone, close a whole-unit gap', () => {
    // Shown "1" + "less than 0.0001" over "1": the parts may EQUAL the
    // total once truncation is undone, so no excess is claimed.
    const local = E14 / 2n; // "less than 0.0001"
    const mirror = E18 + E14 / 4n; // "1"
    const total = local + mirror; // "1" — exactly the parts' sum
    expect(formatVpfiWei(wei(total), 'en')).toBe('1');
    expect(partsVisiblyExceed([wei(local), wei(mirror)], wei(total))).toBe(false);
  });

  it('parts of at least one unit over a below-precision total are visible', () => {
    expect(partsVisiblyExceed([wei(E14), '0'], '1')).toBe(true);
  });
});
