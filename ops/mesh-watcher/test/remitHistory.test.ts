import { describe, expect, it } from 'vitest';
import {
  readRemitHistoryPending,
  remitHistoryHidesAcked,
  remitHistoryPendingGap,
  REMIT_HISTORY_MAX_PAGES,
  REMIT_HISTORY_SCAN,
} from '../src/mesh';

// Codex #2489 r7/r8 — Base's acknowledged recycled share is compared with the
// mirror's relocated custody only once the WHOLE reservation history is booked.
describe('remitHistoryHidesAcked', () => {
  it('a fully booked, fully paged history is comparable', () => {
    expect(remitHistoryHidesAcked(0n, true)).toBe(false);
  });
  it('a single unbooked reservation hides the share', () => {
    // Mutation: compare anyway → the pre-upgrade cushion masks a misrouted arrival.
    expect(remitHistoryHidesAcked(1n, true)).toBe(true);
  });
  it('a history the tick did not page to the end hides it', () => {
    expect(remitHistoryHidesAcked(0n, false)).toBe(true);
  });
});

describe('readRemitHistoryPending', () => {
  const history = (nonce: bigint, pendingAt: Set<bigint>) => {
    const calls: [bigint, bigint][] = [];
    const read = async (fromId: bigint, count: bigint): Promise<readonly [bigint, bigint, bigint]> => {
      calls.push([fromId, count]);
      let pending = 0n;
      for (let id = fromId; id < fromId + count && id <= nonce; id++) if (pendingAt.has(id)) pending++;
      return [0n, pending, nonce];
    };
    return { read, calls };
  };

  it('pages 1..nonce in scan-sized steps and sums the pending count across pages (r8)', async () => {
    // 9,500 reservations, unbooked ones on pages 1 and 3: a single fixed page
    // would have read page 1 only and called the history pending for ever.
    const { read, calls } = history(9_500n, new Set([5n, 8_100n, 9_499n]));
    const h = await readRemitHistoryPending(read, REMIT_HISTORY_SCAN);
    expect(calls).toEqual([
      [1n, 4_000n],
      [4_001n, 4_000n],
      [8_001n, 4_000n],
    ]);
    expect(h).toEqual({ bookingPending: 3n, nonce: 9_500n, covered: true });
  });

  it('a short history takes one page and is covered', async () => {
    const { read, calls } = history(120n, new Set());
    expect(await readRemitHistoryPending(read)).toEqual({ bookingPending: 0n, nonce: 120n, covered: true });
    expect(calls).toHaveLength(1);
  });

  it('an empty history is covered by its first page', async () => {
    const { read } = history(0n, new Set());
    expect(await readRemitHistoryPending(read)).toEqual({ bookingPending: 0n, nonce: 0n, covered: true });
  });

  it('stops at the page budget and reports the history uncovered', async () => {
    const { read, calls } = history(100_000n, new Set());
    const h = await readRemitHistoryPending(read, 4_000n, 3);
    expect(calls).toHaveLength(3);
    expect(h.covered).toBe(false);
    expect(REMIT_HISTORY_MAX_PAGES * Number(REMIT_HISTORY_SCAN)).toBe(256_000);
  });
});

describe('remitHistoryPendingGap', () => {
  it('names the walk to run and the range', () => {
    const g = remitHistoryPendingGap(42161, 3n, 9_500n, true);
    expect(g.reason).toBe('history-pending');
    expect(g.source).toBe('base-books-relocation');
    expect(g.detail).toContain('backfillRemitHistory over 1..9500');
    expect(g.detail).toContain('3 reservation(s) in 1..9500');
    expect(g.detail).not.toContain('outgrew');
    const long = remitHistoryPendingGap(42161, 0n, 300_000n, false);
    expect(long.detail).toContain('outgrew what one tick pages through');
    expect(long.detail).not.toContain('reservation(s) in');
  });
});
