import { describe, expect, it } from 'vitest';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';
import { parseLentShare, parseSlotRates, readSlotHistory } from './slotHistory';

const O = '0x1111111111111111111111111111111111111111' as const;
const L = '0x2222222222222222222222222222222222222222' as const;
const C = '0x3333333333333333333333333333333333333333' as const;
const ref = { chainId: 84532, owner: O, lendingAsset: L, collateralAsset: C, slot: 2 };
const rates = {
  periodStart: 1,
  periodEnd: 2,
  slotMinimumBps: 500,
  minLoans: 5,
  minBorrowers: 3,
  comparison: { enough: true, loanCount: 7, borrowerCount: 4, lowestBps: 400, highestBps: 900, halfAmountBps: '600' },
  excluded: { selfLoans: 1, belowMinimumFill: 0, partiesUnknown: 0 },
  truncated: false,
};
const answer = { ...ref, owner: O.toUpperCase().replace('0X', '0x'), basis: 'past-loans-not-a-forecast', terms: {}, lentShare: { available: false, periodStart: 1, periodEnd: 2, daysOfRecord: 0, reason: 'no-record-at-period-start' }, rates };
const client = (body: unknown, status = 200): IndexerClient => ({
  origin: 'https://i',
  getJson: async <T,>() => {
    if (status !== 200) throw new IndexerUnavailable('status', 'x', status);
    return body as T;
  },
});

describe('slot history', () => {
  it('reads the slot asked for, with the share unavailable and its reason', async () => {
    const r = await readSlotHistory(client(answer), ref);
    expect(r.kind).toBe('history');
    if (r.kind !== 'history') return;
    expect(r.history.lentShare).toMatchObject({ available: false, reason: 'no-record-at-period-start' });
    expect(r.history.rates.comparison).toMatchObject({ enough: true, lowestBps: 400n, highestBps: 900n, halfAmountBps: 600n });
  });
  it('states a slot the index has not filed, and refuses another slot or a missing basis', async () => {
    expect(await readSlotHistory(client(null, 404), ref)).toEqual({ kind: 'not-indexed' });
    await expect(readSlotHistory(client({ ...answer, slot: 3 }), ref)).rejects.toThrow('different Auto-lend');
    await expect(readSlotHistory(client({ ...answer, basis: 'x' }), ref)).rejects.toThrow('basis');
    await expect(readSlotHistory(client(null, 503), ref)).rejects.toThrow(IndexerUnavailable);
  });
  it('refuses a share above the whole period, a range out of order, and an unexplained shape', () => {
    expect(parseLentShare({ available: true, periodStart: 1, periodEnd: 2, daysOfRecord: 30, shareBps: null })).toMatchObject({ shareBps: null });
    expect(() => parseLentShare({ available: true, periodStart: 1, periodEnd: 2, daysOfRecord: 30, shareBps: 10_001 })).toThrow();
    expect(() => parseLentShare({ available: false, periodStart: 1, periodEnd: 2, daysOfRecord: 30, reason: 'other' })).toThrow();
    expect(() => parseSlotRates({ ...rates, comparison: { ...rates.comparison, lowestBps: 1000 } })).toThrow('out of order');
    expect(parseSlotRates({ ...rates, comparison: { enough: false } }).comparison).toEqual({ enough: false });
  });
});
