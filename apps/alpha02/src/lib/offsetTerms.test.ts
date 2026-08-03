/**
 * The offset term bound (#1535).
 *
 * The regression these exist for: the form offered a maximum that
 * reverted on chain. `PrecloseFacet` compares seconds against a loan
 * that re-originates at MINE time; the app computes at READ time. The
 * old bound floored to whole days and treated that as slack, which
 * holds right up until the remaining term is an exact multiple of a
 * day — a loan opened moments ago, which is exactly when a borrower
 * reaches for an offset.
 */
import { describe, expect, it } from 'vitest';
import {
  OFFSET_MATURITY_MARGIN_SEC,
  offsetMaxDurationDays,
} from './offsetTerms';

const DAY = 86_400n;
/** Mirrors PrecloseFacet: the replacement maturity, measured from the
 *  block the transaction actually lands in, must not pass the
 *  original's. */
const contractAccepts = (
  durationDays: bigint,
  mineAt: bigint,
  loanEnd: bigint,
) => mineAt + durationDays * DAY <= loanEnd;

describe('offsetMaxDurationDays', () => {
  it('the exact-multiple case that shipped broken: a loan opened this second', () => {
    // 9-day loan, quoted at the instant it opened, so the remaining
    // term is exactly 9 days. Flooring alone returned 9 and left zero
    // head-room; one elapsed second then reverted.
    const chainNow = 1_000_000n;
    const loanEnd = chainNow + 9n * DAY;
    const max = offsetMaxDurationDays(loanEnd, chainNow, undefined);
    expect(max).toBe(8n);
    // Survives a mining delay far beyond anything realistic.
    expect(contractAccepts(max, chainNow + 1n, loanEnd)).toBe(true);
    expect(contractAccepts(max, chainNow + DAY - 1n, loanEnd)).toBe(true);
    // And the old, unmargined answer is exactly what would have failed.
    expect(contractAccepts(9n, chainNow + 1n, loanEnd)).toBe(false);
  });

  it('the offered maximum always survives the quote-to-mine gap', () => {
    // Sweep offsets around day boundaries — the old bound passed most
    // of these and failed only near the multiples, which is why it
    // looked fine.
    const chainNow = 1_000_000n;
    for (const extra of [
      0n, 1n, 59n, 600n, 3_599n, 3_600n, 3_601n,
      DAY / 2n, DAY - 1n, DAY, DAY + 1n,
    ]) {
      for (const days of [2n, 7n, 9n, 30n]) {
        const loanEnd = chainNow + days * DAY + extra;
        const max = offsetMaxDurationDays(loanEnd, chainNow, undefined);
        if (max < 1n) continue;
        expect(
          contractAccepts(max, chainNow + OFFSET_MATURITY_MARGIN_SEC, loanEnd),
          `days=${days} extra=${extra} max=${max}`,
        ).toBe(true);
      }
    }
  });

  it('takes the protocol ceiling when it is the tighter of the two', () => {
    const chainNow = 1_000_000n;
    const loanEnd = chainNow + 30n * DAY;
    expect(offsetMaxDurationDays(loanEnd, chainNow, 7n)).toBe(7n);
    // …and the maturity when THAT is tighter.
    expect(offsetMaxDurationDays(chainNow + 5n * DAY, chainNow, 7n)).toBe(4n);
  });

  it('an unread ceiling falls back to the maturity bound alone', () => {
    const chainNow = 1_000_000n;
    expect(
      offsetMaxDurationDays(chainNow + 10n * DAY + 3_601n, chainNow, undefined),
    ).toBe(10n);
  });

  it('returns 0 when no term fits, rather than a negative or huge value', () => {
    const chainNow = 1_000_000n;
    // Inside the margin.
    expect(offsetMaxDurationDays(chainNow + 60n, chainNow, undefined)).toBe(0n);
    // Exactly at the margin — still nothing fits.
    expect(
      offsetMaxDurationDays(chainNow + OFFSET_MATURITY_MARGIN_SEC, chainNow, undefined),
    ).toBe(0n);
    // Already matured, and well past.
    expect(offsetMaxDurationDays(chainNow, chainNow, undefined)).toBe(0n);
    expect(offsetMaxDurationDays(chainNow - 5n * DAY, chainNow, undefined)).toBe(0n);
  });

  it('a zero protocol ceiling wins and offers nothing', () => {
    const chainNow = 1_000_000n;
    expect(offsetMaxDurationDays(chainNow + 30n * DAY, chainNow, 0n)).toBe(0n);
  });
});
