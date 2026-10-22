import { describe, expect, it } from 'vitest';
import { copy } from '../content/copy';
import { lenderCollateralLine, refinanceRequestOf } from './refinanceRequestReview';

describe('refinanceRequestOf (#2421)', () => {
  it('is null for an untagged offer, whatever the carry-over slot holds', () => {
    expect(refinanceRequestOf({ refinanceTargetLoanId: 0n, refinanceCarryOver: false })).toBeNull();
    expect(refinanceRequestOf({ refinanceTargetLoanId: 0n, refinanceCarryOver: true })).toBeNull();
  });
  it('names the target loan and the recorded carry-over decision', () => {
    expect(refinanceRequestOf({ refinanceTargetLoanId: 22n, refinanceCarryOver: true })).toEqual({
      targetLoanId: 22n,
      carryOver: true,
    });
  });
});

describe('lenderCollateralLine (#2421)', () => {
  it('keeps the plain line for a fresh borrow request', () => {
    expect(lenderCollateralLine(null, '100 tCOL')).toBe(
      copy.offerFlow.receipts.lenderCollateralLock('100 tCOL'),
    );
  });
  it('says carried-over collateral is already locked, never a new pledge', () => {
    const line = lenderCollateralLine({ targetLoanId: 22n, carryOver: true }, '100 tCOL');
    expect(line).toBe(copy.offerFlow.receipts.lenderCollateralCarriedOver('100 tCOL', '22'));
    expect(line).toContain('#22');
    expect(line).not.toBe(copy.offerFlow.receipts.lenderCollateralLock('100 tCOL'));
  });
  it('says a fresh pledge is new, and that the old loan’s collateral goes back', () => {
    expect(lenderCollateralLine({ targetLoanId: 22n, carryOver: false }, '100 tCOL')).toBe(
      copy.offerFlow.receipts.lenderCollateralFreshPledge('100 tCOL', '22'),
    );
  });
});
