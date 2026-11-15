import { describe, expect, it } from 'vitest';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { claimedTotalsFrom, readClaimedTotals } from './claimedTotals';

const W = '0x00000000000000000000000000000000000000aa' as const;
const ok = {
  chainId: 84532,
  wallet: W,
  recordedBefore: '2026-11-12T00:01:00.000Z',
  pending: null,
  totals: { claimed: '145', vaultDelivered: '105', claimDays: 2, firstClaimDay: '2026-11-10', lastClaimDay: '2026-11-11' },
};

describe('the lifetime claimed totals (RW-31)', () => {
  it('reads the recorded totals with the moment they are recorded up to', () => {
    expect(claimedTotalsFrom(ok, W)).toEqual({
      kind: 'recorded',
      claimed: 145n,
      vaultDelivered: 105n,
      claimDays: 2,
      lastClaimDay: '2026-11-11',
      recordedBefore: Date.parse('2026-11-12T00:01:00.000Z'),
    });
  });

  it('passes on why the index has no totals yet, never a zero', () => {
    expect(claimedTotalsFrom({ ...ok, pending: 'unrecorded', recordedBefore: null, totals: null }, W)).toEqual({ kind: 'pending', why: 'unrecorded' });
    expect(claimedTotalsFrom({ ...ok, pending: 'replaying', totals: null }, W)).toEqual({ kind: 'pending', why: 'replaying' });
  });

  it('refuses an answer it cannot stand behind', () => {
    const bad = [
      { ...ok, wallet: '0x00000000000000000000000000000000000000bb' },
      { ...ok, recordedBefore: null },
      { ...ok, totals: null },
      { ...ok, pending: 'other' },
      { ...ok, totals: { ...ok.totals, claimed: '-1' } },
      { ...ok, totals: { ...ok.totals, vaultDelivered: '146' } },
      { ...ok, totals: { ...ok.totals, claimDays: 0 } },
      { ...ok, totals: { ...ok.totals, lastClaimDay: 'yesterday' } },
    ];
    for (const b of bad) expect(() => claimedTotalsFrom(b as Record<string, unknown>, W)).toThrow(IndexerUnavailable);
  });

  it('asks the index for this wallet on this network', async () => {
    let asked = '';
    const indexer = {
      origin: 'http://x',
      getJson: async <T>(path: string) => {
        asked = path;
        return ok as T;
      },
    };
    await readClaimedTotals(indexer, 84532, '0x00000000000000000000000000000000000000AA');
    expect(asked).toBe('/rewards/claimed?chainId=84532&wallet=0x00000000000000000000000000000000000000aa');
  });
});
