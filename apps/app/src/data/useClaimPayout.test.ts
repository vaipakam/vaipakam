/**
 * UX3-005 (revised #2373 r1) — the line beside a defaulted lender claim.
 * It explains the recovery and never states a figure: the amount owed at
 * default is not available, and the loan's current principal is not what
 * the current holder lent (partial repayment moves it; a buyer of the
 * position never lent it).
 */
import { describe, expect, it } from 'vitest';
import { copy } from '../content/copy';
import { borrowerPayoutWhat, defaultRecoveryNote } from './useClaimPayout';

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

/**
 * #2373 r3 — the borrower's payout as one list of lanes. Each lane the
 * claim transaction pays must appear; a lane whose token details are still
 * loading appears as loading rather than vanishing.
 */
describe('borrowerPayoutWhat', () => {
  const base = {
    status: 'defaulted' as const,
    base: null,
    amountPending: false,
    returnedNft: null,
    rebate: null,
    surplus: null,
    extraCollateral: null,
    collateral: '1 WETH',
    labels,
  };

  it('keeps the base amount while its token details load, beside a rebate', () => {
    const what = borrowerPayoutWhat({ ...base, amountPending: true, rebate: '2 VPFI rebate' });
    expect(what).toBe(`${labels.amountLoading} + 2 VPFI rebate`);
  });

  it('never lets a rebate stand in for an unloaded base amount, in any status', () => {
    for (const status of ['repaid', 'defaulted', 'liquidated', 'internal_matched'] as const) {
      const what = borrowerPayoutWhat({ ...base, status, amountPending: true, rebate: '2 VPFI rebate' });
      expect(what).toContain(labels.amountLoading);
    }
  });

  it('states every lane the claim pays', () => {
    const what = borrowerPayoutWhat({
      ...base,
      status: 'repaid',
      base: '5 USDC',
      rebate: '2 VPFI rebate',
      surplus: '1 USDC',
      extraCollateral: '0.5 WETH',
    });
    expect(what).toBe(
      [
        labels.collateralBackWithAmount('5 USDC', ''),
        '2 VPFI rebate',
        labels.swapSurplus('1 USDC'),
        labels.extraCollateral('0.5 WETH'),
      ].join(' + '),
    );
  });

  it('says a lane is loading rather than dropping it', () => {
    const what = borrowerPayoutWhat({ ...base, base: '5 USDC', surplus: 'pending', extraCollateral: 'pending' });
    expect(what).toContain(labels.swapSurplusPending);
    expect(what).toContain(labels.extraCollateralPending);
  });

  it('keeps a returned NFT when a rebate is also paid', () => {
    const what = borrowerPayoutWhat({
      ...base,
      status: 'repaid',
      returnedNft: 'NFT 0xab…cd #7',
      rebate: '2 VPFI rebate',
    });
    expect(what).toBe(`${labels.collateralBack('NFT 0xab…cd #7')} + 2 VPFI rebate`);
  });

  it('opens with a capital when the only lane is written as a continuation', () => {
    const what = borrowerPayoutWhat({ ...base, surplus: 'pending' });
    expect(what.charAt(0)).toBe(what.charAt(0).toUpperCase());
  });

  it('falls back to a plain description only when no lane names anything', () => {
    expect(borrowerPayoutWhat(base)).toBe(labels.surplusAfterLiquidation);
    expect(borrowerPayoutWhat({ ...base, status: 'internal_matched' })).toBe(labels.residualAfterMatch);
    expect(borrowerPayoutWhat({ ...base, status: 'repaid' })).toBe(labels.collateralBack('1 WETH'));
  });
});
