import { describe, expect, it } from 'vitest';
import { filterCounts, inFilter, offerState, type MyOffer } from './myOffers';

const row = (state: MyOffer['state'], id = 1n): MyOffer => ({ id, state, terms: null, created: true, held: true });

describe('offerState', () => {
  it('reads the protocol’s state codes, and an unknown code as unknown', () => {
    expect([0, 1, 2, 3, 4].map(offerState)).toEqual(['open', 'accepted', 'cancelled', 'sale-consumed', 'expired']);
    expect(offerState(9)).toBe('unknown');
  });
});

describe('filters', () => {
  it('counts a sale-consumed offer as filled, and every row under All', () => {
    const rows = [row('open'), row('accepted'), row('sale-consumed'), row('expired'), row('cancelled'), row('unknown')];
    expect(filterCounts(rows)).toEqual({ open: 1, accepted: 2, expired: 1, cancelled: 1, all: 6 });
    expect(inFilter(row('sale-consumed'), 'accepted')).toBe(true);
    expect(inFilter(row('unknown'), 'open')).toBe(false);
  });
});
