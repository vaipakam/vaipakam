import { describe, expect, it } from 'vitest';
import { loanStateView, loanStateLabel } from './loanState';
import { copySource } from '../content/copy';
import type { IndexedLoan } from '../data/indexer';

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

function loan(p: Partial<IndexedLoan>): IndexedLoan {
  return {
    loanId: 1,
    role: 'borrower',
    status: 'active',
    lendingAsset: '0x0000000000000000000000000000000000000001',
    collateralAsset: '0x0000000000000000000000000000000000000002',
    assetType: 0,
    principal: '0',
    collateralAmount: '0',
    interestRateBps: 0,
    durationDays: 30,
    startTime: now(),
    ...p,
  } as IndexedLoan;
}

describe('loanStateView labelKey', () => {
  it('maps terminal statuses to stable keys', () => {
    expect(loanStateView(loan({ status: 'repaid' })).labelKey).toBe('repaid');
    expect(loanStateView(loan({ status: 'defaulted' })).labelKey).toBe('defaulted');
    expect(loanStateView(loan({ status: 'liquidated' })).labelKey).toBe('defaulted');
    expect(loanStateView(loan({ status: 'settled' })).labelKey).toBe('closed');
    // The failed-default-settling case is a DISTINCT label from 'closed'.
    expect(loanStateView(loan({ status: 'fallback_pending' })).labelKey).toBe(
      'beingSettled',
    );
  });

  it('distinguishes overdue / due-today / due-in-N for active loans', () => {
    const overdue = loanStateView(
      loan({ status: 'active', startTime: now() - 40 * DAY, durationDays: 30 }),
    );
    expect(overdue.labelKey).toBe('pastDue');

    const dueLater = loanStateView(
      loan({ status: 'active', startTime: now(), durationDays: 30 }),
    );
    expect(dueLater.labelKey).toBe('dueInDays');
    expect(dueLater.daysRemaining).toBeGreaterThan(0);
  });
});

describe('loanStateLabel resolves through the catalog', () => {
  it('uses the static label for a terminal key', () => {
    const view = loanStateView(loan({ status: 'fallback_pending' }));
    expect(loanStateLabel(view, copySource.loanState)).toBe('Being settled');
  });

  it('parametrizes the due-in-N label with the day count', () => {
    const view = loanStateView(
      loan({ status: 'active', startTime: now(), durationDays: 30 }),
    );
    expect(loanStateLabel(view, copySource.loanState)).toBe(
      `Due in ${view.daysRemaining} days`,
    );
  });
});
