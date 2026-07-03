import { describe, expect, it } from 'vitest';
import type { IndexedActivityEvent } from '@vaipakam/defi-client';
import {
  activityKindLabel,
  filterVisibleActivity,
  groupActivityByTx,
} from '../src/lib/activityLabels';

const base = (overrides: Partial<IndexedActivityEvent>): IndexedActivityEvent => ({
  chainId: 84532,
  blockNumber: 100,
  logIndex: 1,
  txHash: '0x' + 'b'.repeat(64),
  kind: 'OfferCreated',
  loanId: null,
  offerId: 1,
  actor: '0xe87319e4f4cd0a0bd6ff2c087d038ac90d6023cb',
  args: {},
  blockAt: 1_700_000_000,
  ...overrides,
});

describe('activityLabels', () => {
  it('maps known kinds to friendly labels', () => {
    expect(activityKindLabel('OfferAccepted')).toBe('Offer accepted');
    expect(activityKindLabel('LoanInitiated')).toBe('Loan opened');
  });

  it('hides transfer noise', () => {
    const visible = filterVisibleActivity([
      base({ kind: 'OfferCreated' }),
      base({ kind: 'Transfer', logIndex: 2 }),
    ]);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.kind).toBe('OfferCreated');
  });

  it('groups events in the same transaction', () => {
    const tx = '0x' + 'c'.repeat(64);
    const groups = groupActivityByTx([
      base({ txHash: tx, kind: 'OfferAccepted', loanId: 3, offerId: 5, logIndex: 10 }),
      base({ txHash: tx, kind: 'LoanInitiated', loanId: 3, offerId: 5, logIndex: 11 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.primaryKind).toBe('OfferAccepted');
    expect(groups[0]?.loanId).toBe(3);
    expect(groups[0]?.events).toHaveLength(2);
  });
});