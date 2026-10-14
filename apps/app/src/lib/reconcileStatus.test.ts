/** #2373 r4 — one rule for reading an indexed loan row against the live
 *  chain status, shared by the loan page's action gate and its claim reads. */
import { describe, expect, it } from 'vitest';
import { isLiveReadUsable, LoanStatus, reconcileIndexedStatus, usableLiveData } from './types';

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

describe('usableLiveData (#2470, #2477 r1-r2)', () => {
  const read = { status: 1, principal: 5n };
  const healthy = { enabled: true, data: read, isError: false, isPaused: false, failureCount: 0 };
  const status = (r: { data: typeof read | undefined } & typeof healthy) => usableLiveData(r)?.status;

  it('passes a running, healthy read through whole', () => {
    expect(usableLiveData(healthy)).toBe(read);
  });

  it('never uses a stopped query’s cached snapshot', () => {
    // The indexed row is terminal, so the query stopped; its last result is
    // pre-transition. Reconciling with it would regress `settled` to `repaid`.
    expect(usableLiveData({ ...healthy, enabled: false })).toBeUndefined();
    expect(reconcileIndexedStatus('settled', status({ ...healthy, enabled: false }))).toBe('settled');
  });

  it('never uses data kept across a failed refetch, a pending retry, or a paused (offline) query', () => {
    expect(usableLiveData({ ...healthy, isError: true })).toBeUndefined();
    expect(usableLiveData({ ...healthy, failureCount: 1 })).toBeUndefined();
    expect(usableLiveData({ ...healthy, isPaused: true })).toBeUndefined();
    // e.g. a cached FallbackPending must not hold an indexed `active` row in
    // the pre-cure state while the refetch is retrying.
    expect(
      reconcileIndexedStatus('active', status({ ...healthy, data: { ...read, status: 4 }, failureCount: 1 })),
    ).toBe('active');
  });

  it('agrees with isLiveReadUsable exactly', () => {
    for (const st of [
      healthy,
      { ...healthy, enabled: false },
      { ...healthy, isError: true },
      { ...healthy, isPaused: true },
      { ...healthy, failureCount: 2 },
    ]) {
      expect(usableLiveData(st) !== undefined).toBe(isLiveReadUsable(st));
    }
  });
});
