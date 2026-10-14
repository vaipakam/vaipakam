/** #2373 r4 — one rule for reading an indexed loan row against the live
 *  chain status, shared by the loan page's action gate and its claim reads. */
import { describe, expect, it } from 'vitest';
import { isLiveReadUsable, LoanStatus, reconcileIndexedStatus, usableLiveStatus } from './types';

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

describe('usableLiveStatus (#2470, #2477 r1)', () => {
  const healthy = { enabled: true, status: 1, isError: false, isPaused: false, failureCount: 0 };

  it('passes a running, healthy read through', () => {
    expect(usableLiveStatus(healthy)).toBe(1);
  });

  it('never uses a stopped query’s cached snapshot', () => {
    // The indexed row is terminal, so the query stopped; its last result is
    // pre-transition. Reconciling with it would regress `settled` to `repaid`.
    expect(usableLiveStatus({ ...healthy, enabled: false })).toBeUndefined();
    expect(reconcileIndexedStatus('settled', usableLiveStatus({ ...healthy, enabled: false }))).toBe('settled');
  });

  it('never uses data kept across a failed refetch, a pending retry, or a paused (offline) query', () => {
    expect(usableLiveStatus({ ...healthy, isError: true })).toBeUndefined();
    expect(usableLiveStatus({ ...healthy, failureCount: 1 })).toBeUndefined();
    expect(usableLiveStatus({ ...healthy, isPaused: true })).toBeUndefined();
    // e.g. a cached FallbackPending must not hold an indexed `active` row in
    // the pre-cure state while the refetch is retrying.
    expect(reconcileIndexedStatus('active', usableLiveStatus({ ...healthy, status: 4, failureCount: 1 }))).toBe('active');
  });
});

describe('isLiveReadUsable (#2477 r1) — one predicate for status and amounts', () => {
  const healthy = { enabled: true, isError: false, isPaused: false, failureCount: 0 };
  it('is true only for a running, healthy read', () => {
    expect(isLiveReadUsable(healthy)).toBe(true);
    for (const bad of [
      { ...healthy, enabled: false },
      { ...healthy, isError: true },
      { ...healthy, isPaused: true },
      { ...healthy, failureCount: 2 },
    ]) {
      expect(isLiveReadUsable(bad)).toBe(false);
    }
  });
  it('usableLiveStatus agrees with it exactly', () => {
    for (const st of [healthy, { ...healthy, isPaused: true }, { ...healthy, failureCount: 1 }]) {
      expect(usableLiveStatus({ ...st, status: 2 }) !== undefined).toBe(isLiveReadUsable(st));
    }
  });
});
