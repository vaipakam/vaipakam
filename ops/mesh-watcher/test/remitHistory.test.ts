import { describe, expect, it } from 'vitest';
import { remitHistoryHidesAcked, remitHistoryPendingGap, REMIT_HISTORY_SCAN } from '../src/mesh';

// Codex #2489 r7 — Base's acknowledged recycled share is compared with the
// mirror's relocated custody only once the reservation history is booked.
describe('remitHistoryHidesAcked', () => {
  it('a fully booked history inside one scan is comparable', () => {
    expect(remitHistoryHidesAcked(0n, 120n, REMIT_HISTORY_SCAN)).toBe(false);
    expect(remitHistoryHidesAcked(0n, REMIT_HISTORY_SCAN, REMIT_HISTORY_SCAN), 'exactly the scan').toBe(false);
  });
  it('a single unbooked reservation hides the share', () => {
    // Mutation: compare anyway → the pre-upgrade cushion masks a misrouted arrival.
    expect(remitHistoryHidesAcked(1n, 120n, REMIT_HISTORY_SCAN)).toBe(true);
  });
  it('a history the scan did not reach hides it even with nothing pending in the scanned range', () => {
    expect(remitHistoryHidesAcked(0n, REMIT_HISTORY_SCAN + 1n, REMIT_HISTORY_SCAN)).toBe(true);
  });
  it('the gap names the walk to run and the range', () => {
    const g = remitHistoryPendingGap(42161, 3n, 120n, REMIT_HISTORY_SCAN);
    expect(g.reason).toBe('history-pending');
    expect(g.source).toBe('base-books-relocation');
    expect(g.detail).toContain('backfillRemitHistory over 1..120');
    expect(g.detail).toContain('3 finalized reservation(s)');
    const long = remitHistoryPendingGap(42161, 0n, 5_000n, REMIT_HISTORY_SCAN);
    expect(long.detail).toContain('longer than one view call scans (4000)');
    expect(long.detail).not.toContain('finalized reservation(s)');
  });
});
