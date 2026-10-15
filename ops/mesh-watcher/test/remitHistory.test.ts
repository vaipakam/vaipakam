import { describe, expect, it } from 'vitest';
import {
  readRemitHistoryBooked,
  readRemitHistoryPending,
  reconstructHistoryActual,
  remitHistoryHidesAcked,
  remitHistoryPendingGap,
  remitHistoryReadUnavailableGap,
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

// Codex #2489 r10 — the history is RECONSTRUCTED from the destination's receipts.
describe('reconstructHistoryActual', () => {
  const rows = [
    { id: 1n, recycled: 10n, total: 30n },
    { id: 2n, recycled: 5n, total: 20n },
    { id: 3n, recycled: 7n, total: 0n },
  ];
  it('a full delivery is the declared share; a short one scales with the receiver\'s flooring; a zero total is declared', () => {
    const r = reconstructHistoryActual(rows, new Map([
      [1n, { receivedAt: 100n, amount: 30n }],
      [2n, { receivedAt: 100n, amount: 19n }], // 5 × 19 / 20 = 4 (floor)
      [3n, { receivedAt: 100n, amount: 1n }],
    ]));
    expect(r).toEqual({ actual: 10n + 4n + 7n, missing: 0 });
  });
  it('an over-delivery is the declared share, never more', () => {
    expect(reconstructHistoryActual([rows[0]!], new Map([[1n, { receivedAt: 1n, amount: 40n }]]))).toEqual({ actual: 10n, missing: 0 });
  });
  it('a missing receipt, or one never delivered (receivedAt 0), is COUNTED, not guessed', () => {
    // Mutation: substitute the declared share for a missing receipt → a pre-upgrade
    // short delivery reads as a critical again.
    const r = reconstructHistoryActual(rows, new Map([
      [1n, { receivedAt: 100n, amount: 30n }],
      [2n, undefined],
      [3n, { receivedAt: 0n, amount: 0n }],
    ]));
    expect(r.missing).toBe(2);
    expect(r.actual).toBe(10n);
  });
});

describe('readRemitHistoryBooked', () => {
  it('pages 1..nonce and concatenates the rows in id order; undefined past the page budget', async () => {
    const page = async (fromId: bigint, count: bigint): Promise<readonly [readonly bigint[], readonly bigint[], readonly bigint[]]> => {
      const ids: bigint[] = [];
      for (let id = fromId; id < fromId + count && id <= 9_000n; id++) if (id % 4_000n === 1n) ids.push(id);
      return [ids, ids.map(() => 3n), ids.map(() => 9n)];
    };
    const rows = await readRemitHistoryBooked(page, 9_000n);
    expect(rows?.map((r) => r.id)).toEqual([1n, 4_001n, 8_001n]);
    expect(await readRemitHistoryBooked(page, 9_000n, 4_000n, 1), 'budget too small: uncovered').toBeUndefined();
    expect(await readRemitHistoryBooked(page, 0n), 'empty history: no page needed').toEqual([]);
  });
});

describe('remitHistoryReadUnavailableGap', () => {
  it('says which read failed and that the hard leg still ran', () => {
    const g = remitHistoryReadUnavailableGap(42161, new Error('boom'), 'getChainRemittedRecycledHistory');
    expect(g.reason).toBe('view-unavailable');
    expect(g.detail).toContain('getChainRemittedRecycledHistory() could not be read');
    expect(g.detail).toContain('ADVISORY was skipped');
    expect(g.detail).toContain('hard relocated leg on the exact acknowledged share still ran');
    const r = remitHistoryReadUnavailableGap(42161, new Error('boom'), 'getReceivedRemit');
    expect(r.detail).toContain('receipt records could not be read');
    expect(r.detail).toContain('declared-share advisory stood in');
  });
});
