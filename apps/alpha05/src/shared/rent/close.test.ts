import { describe, expect, it } from 'vitest';
import { figuresAt, rentDaysAt, settledDays, type RentTerms } from './closeReview';

const DAY = 86_400n;
const START = 1_000_000n;
const terms: RentTerms = { principal: 2n, durationDays: 5n, startTime: START, lastDeductTime: START, useFullTermInterest: false };

describe('rent days at a close (the settler’s rule)', () => {
  it('counts at least one day, even in the starting block', () => {
    expect(rentDaysAt(terms, START)).toBe(1n);
    expect(rentDaysAt(terms, START + 1n)).toBe(1n);
  });
  it('counts a part day as a whole day, and an exact day boundary as no extra day', () => {
    expect(rentDaysAt(terms, START + DAY)).toBe(1n);
    expect(rentDaysAt(terms, START + DAY + 1n)).toBe(2n);
  });
  it('never counts past the term', () => {
    expect(rentDaysAt(terms, START + 9n * DAY)).toBe(5n);
  });
  it('leaves out the days already settled', () => {
    const settled = { ...terms, lastDeductTime: START + 2n * DAY };
    expect(settledDays(settled)).toBe(2n);
    expect(rentDaysAt(settled, START + 2n * DAY + 5n)).toBe(1n);
    expect(rentDaysAt(settled, START + DAY)).toBe(0n);
  });
  it('pays every unsettled agreed day on a full-term rental, however early', () => {
    const full = { ...terms, useFullTermInterest: true };
    expect(rentDaysAt(full, START)).toBe(5n);
    expect(rentDaysAt({ ...full, lastDeductTime: START + 3n * DAY }, START)).toBe(2n);
  });
});

describe('what a close settles', () => {
  const loan = { ...terms, prepayAmount: 10n, bufferAmount: 1n, treasuryFeeBpsAtInit: 1_000 };
  it('refunds the prepayment less rent and late fee, and splits rent plus late fee with the protocol', () => {
    const f = figuresAt(loan, START + DAY + 1n, 0n);
    expect(f).toMatchObject({ days: 2n, rent: 4n, lateFee: 0n, refund: 7n });
    expect(f.protocolShare + f.ownerShare).toBe(4n);
  });
  it('draws a late fee on the buffer', () => {
    expect(figuresAt(loan, START + 7n * DAY, 1n)).toMatchObject({ rent: 10n, refund: 0n });
  });
  it('has no refund when the prepayment cannot cover the close (the protocol refuses)', () => {
    expect(figuresAt(loan, START + 7n * DAY, 2n).refund).toBeNull();
    expect(figuresAt({ ...loan, prepayAmount: 3n }, START + DAY + 1n, 0n).refund).toBeNull();
  });
  it('takes the older fixed share for a rental that recorded none', () => {
    const f = figuresAt({ ...loan, treasuryFeeBpsAtInit: 0, principal: 100n, prepayAmount: 1000n }, START, 0n);
    expect(f.protocolShare).toBe(1n);
  });
});
