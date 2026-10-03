/**
 * UX3-005 (revised #2373 r1) — the line beside a defaulted lender claim.
 * It explains the recovery and never states a figure: the amount owed at
 * default is not available, and the loan's current principal is not what
 * the current holder lent (partial repayment moves it; a buyer of the
 * position never lent it).
 */
import { describe, expect, it } from 'vitest';
import { copy } from '../content/copy';
import { defaultRecoveryNote } from './useClaimPayout';

const labels = copy.claims.row;

describe('defaultRecoveryNote', () => {
  it('says held proceeds cannot be stated as one amount', () => {
    expect(defaultRecoveryNote({ hasHeld: true, inKind: false, labels })).toBe(labels.compareUnknownHeld);
  });

  it('says an in-kind recovery is the collateral itself, not cash', () => {
    expect(defaultRecoveryNote({ hasHeld: false, inKind: true, labels })).toBe(labels.compareInKind);
  });

  it('states the unknown for a cash recovery instead of computing a shortfall', () => {
    expect(defaultRecoveryNote({ hasHeld: false, inKind: false, labels })).toBe(labels.recoveryNotComparable);
  });

  // The #2373 r1 P1 defect: the note told a holder "the 500 WETH you lent",
  // computed from the loan's current principal. No case may claim the
  // holder lent anything, or state a number.
  it('never tells the holder what they lent, and never states a figure, in any case', () => {
    for (const hasHeld of [false, true]) {
      for (const inKind of [false, true]) {
        const note = defaultRecoveryNote({ hasHeld, inKind, labels });
        expect(note).not.toMatch(/you lent/i);
        expect(note).not.toMatch(/\d/);
      }
    }
  });
});
