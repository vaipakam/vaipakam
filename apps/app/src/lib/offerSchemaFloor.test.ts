import { describe, expect, it } from 'vitest';
import { lenderSmallestFill, openOfferStanding } from './offerSchema';

// #3242 — the lender's smallest fill is 10% of the whole amount, raised to
// the offer-book floor's amount when it binds, never above the whole amount.
describe('lenderSmallestFill', () => {
  it('keeps the 10% default when the floor does not bind', () => {
    expect(lenderSmallestFill(1000n, undefined)).toBe(100n);
  });
  it('keeps the 10% default when it already meets the floor', () => {
    expect(lenderSmallestFill(1000n, 50n)).toBe(100n);
  });
  it('raises the smallest fill to the floor', () => {
    // $50 offer, $10 floor: a $5 default fill would be refused.
    expect(lenderSmallestFill(50n, 10n)).toBe(10n);
  });
  it('never exceeds the whole amount', () => {
    expect(lenderSmallestFill(8n, 10n)).toBe(8n);
  });
  it('is at least one base unit', () => {
    expect(lenderSmallestFill(5n, undefined)).toBe(1n);
  });
});

describe('openOfferStanding (#3242)', () => {
  it('stops the post at the cap and names the count near it', () => {
    expect(openOfferStanding({ open: 25n, cap: 25n }, false)).toBe('full');
    expect(openOfferStanding({ open: 20n, cap: 25n }, false)).toBe('near');
    expect(openOfferStanding({ open: 19n, cap: 25n }, false)).toBe('room');
  });
  it('says nothing while the count is unknown, and never caps a refinance request', () => {
    expect(openOfferStanding(undefined, false)).toBe('room');
    expect(openOfferStanding({ open: 25n, cap: 25n }, true)).toBe('room');
  });
});
