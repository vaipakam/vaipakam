/** #2373 r4 — one rule for reading an indexed loan row against the live
 *  chain status, shared by the loan page's action gate and its claim reads. */
import { describe, expect, it } from 'vitest';
import { LoanStatus, reconcileIndexedStatus } from './types';

describe('reconcileIndexedStatus', () => {
  it('keeps the indexed status when no live status is in hand', () => {
    expect(reconcileIndexedStatus('active', undefined)).toBe('active');
  });

  it('moves a stale active row to the settled status the chain reports', () => {
    expect(reconcileIndexedStatus('active', LoanStatus.Repaid)).toBe('repaid');
    expect(reconcileIndexedStatus('active', LoanStatus.InternalMatched)).toBe('internal_matched');
    expect(reconcileIndexedStatus('active', LoanStatus.Defaulted)).toBe('defaulted');
  });

  it('returns a cured fallback row to active', () => {
    expect(reconcileIndexedStatus('fallback_pending', LoanStatus.Active)).toBe('active');
  });

  it('never resurrects a closed row from a live active reading', () => {
    expect(reconcileIndexedStatus('repaid', LoanStatus.Active)).toBe('repaid');
    expect(reconcileIndexedStatus('defaulted', LoanStatus.Active)).toBe('defaulted');
  });

  it('ignores an unknown future status value', () => {
    expect(reconcileIndexedStatus('active', 99)).toBe('active');
  });
});
