import { describe, expect, it } from 'vitest';
import type { IndexedLoanStatus } from '../data/indexer';
import { initiatedPrincipal, lockedCollateralLine, type LockedLineLabels } from './positionAmounts';

describe('initiatedPrincipal (#2453)', () => {
  it('reads the initiation snapshot, not the live principal', () => {
    // An internally matched loan: live principal 0, initiated with 1e18.
    expect(initiatedPrincipal({ initPrincipal: '1000000000000000000' })).toBe(10n ** 18n);
  });

  it('is null — never the live principal — when the row does not carry it', () => {
    expect(initiatedPrincipal({ initPrincipal: null })).toBeNull();
    expect(initiatedPrincipal({})).toBeNull(); // a worker that predates the field
    expect(initiatedPrincipal({ initPrincipal: '' })).toBeNull();
  });

  it('refuses a value that is not a whole decimal amount', () => {
    for (const bad of ['-1', '1.5', '0x10', '1e18', ' 1']) {
      expect(initiatedPrincipal({ initPrincipal: bad })).toBeNull();
    }
  });

  it('keeps a recorded zero as zero', () => {
    expect(initiatedPrincipal({ initPrincipal: '0' })).toBe(0n);
  });
});

describe('lockedCollateralLine (#2454)', () => {
  const labels: LockedLineLabels = {
    lockedCollateralBorrower: (c) => `${c} collateral (borrower’s)`,
    noCollateral: 'No collateral',
    nothingLockedClosed: 'CLOSED',
    nothingLockedInternalMatch: 'MATCHED',
  };
  const line = (hasCollateral: boolean, status: IndexedLoanStatus) =>
    lockedCollateralLine({ hasCollateral, status, collateral: '4,000 mUSDC', labels });

  it('names the held collateral whenever some is held, whatever the status', () => {
    for (const s of ['active', 'fallback_pending', 'internal_matched', 'repaid', 'settled'] as const) {
      expect(line(true, s)).toBe('4,000 mUSDC collateral (borrower’s)');
    }
  });

  it('never puts the empty placeholder inside the held-collateral sentence', () => {
    const all: IndexedLoanStatus[] = [
      'active',
      'repaid',
      'defaulted',
      'liquidated',
      'settled',
      'fallback_pending',
      'internal_matched',
    ];
    for (const s of all) {
      expect(line(false, s)).not.toMatch(/collateral \(borrower’s\)/);
    }
  });

  it('says where an internal match took the collateral', () => {
    expect(line(false, 'internal_matched')).toBe('MATCHED');
  });

  it('says a closed loan holds nothing any more, rather than that it never had collateral', () => {
    for (const s of ['repaid', 'defaulted', 'liquidated', 'settled'] as const) {
      expect(line(false, s)).toBe('CLOSED');
    }
  });

  it('keeps "No collateral" for an open loan that holds none', () => {
    expect(line(false, 'active')).toBe('No collateral');
    expect(line(false, 'fallback_pending')).toBe('No collateral');
  });
});
