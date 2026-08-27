import { describe, it, expect } from 'vitest';
import {
  isUnderCollateralRevert,
  UNDER_COLLATERAL_ERROR_NAMES,
} from './collateralPrecheck';
import type { SimResult } from '../contracts/useTxSimulation';

const revert = (revertName?: string): SimResult => ({
  status: 'revert',
  revertReason: 'some friendly copy',
  revertName,
});

describe('isUnderCollateralRevert (#1112)', () => {
  it('is true for every under-collateral error name', () => {
    for (const name of UNDER_COLLATERAL_ERROR_NAMES) {
      expect(isUnderCollateralRevert(revert(name))).toBe(true);
    }
  });

  it('is false for reverts with an unrelated error name (no crying wolf)', () => {
    // These reach the review step's SimulationPreview, not the terms precheck.
    for (const name of ['SelfTrade', 'OfferDurationExceedsCap', 'InterestRateAboveCeiling']) {
      expect(isUnderCollateralRevert(revert(name))).toBe(false);
    }
  });

  it('is false when the revert has no decoded name', () => {
    expect(isUnderCollateralRevert(revert(undefined))).toBe(false);
  });

  it('is false for every non-revert verdict', () => {
    for (const status of ['idle', 'loading', 'ok', 'approval-needed', 'unavailable'] as const) {
      expect(isUnderCollateralRevert({ status })).toBe(false);
    }
  });

  it('does not treat approval-needed as under-collateral even if a name rides along', () => {
    // The submit path grants the allowance first; that benign verdict must
    // never surface as an under-collateral warning.
    expect(
      isUnderCollateralRevert({ status: 'approval-needed', revertName: 'MaxLendingAboveCeiling' }),
    ).toBe(false);
  });
});
