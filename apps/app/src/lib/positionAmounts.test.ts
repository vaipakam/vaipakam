import { describe, expect, it } from 'vitest';
import type { IndexedLoanStatus } from '../data/indexer';
import {
  initiatedPrincipal,
  lockedCollateralLine,
  withIndexedInitPrincipal,
  type LockedLineLabels,
} from './positionAmounts';

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

describe('withIndexedInitPrincipal (#2461 r1)', () => {
  const live = [
    { loanId: 1, initPrincipal: null, role: 'lender' as const },
    { loanId: 2, initPrincipal: null, role: 'borrower' as const },
    { loanId: 3, initPrincipal: null, role: 'lender' as const },
  ];

  it('takes the initiated amount from the indexed row with the same loan id', () => {
    const out = withIndexedInitPrincipal(live, [
      { loanId: 1, initPrincipal: '100' },
      { loanId: 2, initPrincipal: '200' },
    ]);
    expect(out.map((r) => r.initPrincipal)).toEqual(['100', '200', null]);
    // Everything else on the chain row stays the chain's.
    expect(out.map((r) => r.role)).toEqual(['lender', 'borrower', 'lender']);
  });

  it('keeps null where the indexer has no value, and when the indexed leg failed', () => {
    expect(withIndexedInitPrincipal(live, [{ loanId: 1, initPrincipal: null }])[0].initPrincipal).toBeNull();
    expect(withIndexedInitPrincipal(live, null).map((r) => r.initPrincipal)).toEqual([null, null, null]);
  });

  it('adds no row the chain did not return', () => {
    expect(withIndexedInitPrincipal(live, [{ loanId: 99, initPrincipal: '1' }])).toHaveLength(3);
  });
});
