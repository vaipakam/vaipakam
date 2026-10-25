import { describe, expect, it } from 'vitest';
import { loanStateView, loanStateLabel, withGraceVerdict } from './loanState';
import { copySource } from '../content/copy';
import type { IndexedLoan } from '../data/indexer';

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

/** An indexed row, dated by the indexer's loan clock (#2808) as a loan the
 *  protocol never paused — unless the case supplies its own `deadlines`. */
function loan(p: Partial<IndexedLoan>, credit = 0): IndexedLoan {
  const startTime = p.startTime ?? now();
  const durationDays = p.durationDays ?? 30;
  const originalMaturity = startTime + durationDays * DAY;
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
    durationDays,
    startTime,
    deadlines: {
      available: true,
      originalMaturity,
      pauseCredit: credit,
      maturity: originalMaturity + credit,
      graceEnd: originalMaturity + credit + 3 * DAY,
      pauseInForce: false,
      asOf: now(),
    },
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

describe('loanStateView on the loan clock (#2808)', () => {
  it('dates an active loan by its MOVED due date, not start + duration', () => {
    // Originally due five days ago; a ten-day pause moved it five days out.
    const moved = loanStateView(
      loan({ status: 'active', startTime: now() - 35 * DAY, durationDays: 30 }, 10 * DAY),
    );
    expect(moved.labelKey).not.toBe('pastDue');
    expect(moved.daysRemaining).toBeGreaterThan(0);
  });

  it('says a pause in force is moving the date, and names no day count', () => {
    const view = loanStateView(
      loan({
        status: 'active',
        deadlines: {
          available: true,
          originalMaturity: now(),
          pauseCredit: DAY,
          maturity: now() + DAY,
          graceEnd: now() + 2 * DAY,
          pauseInForce: true,
          asOf: now(),
        },
      }),
    );
    expect(view.labelKey).toBe('duePaused');
    expect(view.daysRemaining).toBeNull();
  });

  it('says the date is unknown rather than show the original one', () => {
    const unread = loanStateView(
      loan({ status: 'active', deadlines: { available: false, reason: 'pause-log-unread' } }),
    );
    expect(unread.labelKey).toBe('dueUnknown');
    // A row with no loan-clock dates at all (a live-chain fallback row).
    const bare = loan({ status: 'active' });
    delete bare.deadlines;
    expect(loanStateView(bare).labelKey).toBe('dueUnknown');
    expect(loanStateLabel(loanStateView(bare), copySource.loanState)).toBe('Due date unknown');
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

describe('withGraceVerdict', () => {
  const overdue = () => loanStateView(loan({ status: 'active', startTime: now() - 40 * DAY }));
  it('turns past due into past grace only on the chain saying so', () => {
    expect(overdue().labelKey).toBe('pastDue');
    expect(withGraceVerdict(overdue(), true).labelKey).toBe('pastGrace');
    expect(loanStateLabel(withGraceVerdict(overdue(), true), copySource.loanState)).toBe(
      'Past grace',
    );
  });
  it('keeps past due while the verdict is unread or still in grace', () => {
    expect(withGraceVerdict(overdue(), undefined).labelKey).toBe('pastDue');
    expect(withGraceVerdict(overdue(), false).labelKey).toBe('pastDue');
  });
  it('follows the chain over this device clock for an open loan', () => {
    const onTrack = loanStateView(loan({ status: 'active', startTime: now() }));
    expect(withGraceVerdict(onTrack, true).labelKey).toBe('pastGrace');
    expect(withGraceVerdict(onTrack, false)).toEqual(onTrack);
  });
  it('never relabels a loan that is no longer open', () => {
    const repaid = loanStateView(loan({ status: 'repaid' }));
    expect(withGraceVerdict(repaid, true)).toEqual(repaid);
  });
});
