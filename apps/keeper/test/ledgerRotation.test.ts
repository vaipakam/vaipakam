/**
 * #2984 — the one rotation rule every ledger-nominated pass reads with
 * (`ledgerRotation.ts`): a page from where the last run stopped, a floor that
 * moves only on a page read from the floor, past rows finished at the head
 * AND at the finalized block, where a nominating row also needs its own
 * event finalized.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodePos, type EventLedger, type LedgerPos, type LedgerRow } from '../src/eventLedger';
import { attemptOrder, readLedgerRotation } from '../src/ledgerRotation';
import { PastRunDeadline } from '../src/batchRead';
import { memoryScanCursors } from '../src/scanCursors';

class Ledger implements EventLedger {
  constructor(readonly rows: LedgerRow[]) {}
  async matching(): Promise<LedgerRow[] | null> {
    throw new Error('unexpected');
  }
  async page(_c: number, _k: readonly string[], after: LedgerPos | null, limit: number) {
    const rest = this.rows.filter((r) => after === null || r.block > after.block || (r.block === after.block && r.log > after.log));
    return { rows: rest.slice(0, limit), more: rest.length > limit };
  }
}

const row = (block: number, id: string | null): LedgerRow => ({ kind: 'E', args: id === null ? {} : { id }, blockAt: block, block, log: 0, tx: '0x' });
const FINAL = { number: 100n, timestamp: 0n };

function rotation(rows: LedgerRow[], cursors = memoryScanCursors(), limit = 10, ledger: EventLedger = new Ledger(rows), cutoff = Number.POSITIVE_INFINITY) {
  return {
    cursors,
    read: () =>
      readLedgerRotation<string>({
        ledger,
        cursors,
        chainId: 1,
        kinds: ['E'],
        floorItem: 'floor',
        nextItem: 'next',
        limit,
        nominee: (r) => (typeof r.args.id === 'string' ? r.args.id : null),
        id: (k) => k,
        cutoff,
      }),
  };
}

describe('readLedgerRotation', () => {
  it('names each nominee once and passes a row that nominates nothing without asking', async () => {
    const { cursors, read } = rotation([row(1, null), row(2, 'a'), row(3, 'a'), row(4, 'b')]);
    const page = (await read())!;
    expect(page.nominees).toEqual(['a', 'b']);
    const asked: (readonly string[])[] = [];
    await page.liftFloor(async () => FINAL, (k) => k === 'a', async (ks) => {
      asked.push(ks);
      return (k) => k === 'a';
    });
    expect(asked).toEqual([['a']]);
    expect(cursors.rows.get('floor')).toBe(encodePos({ block: 3, log: 0 }));
  });

  it('holds the floor at a nominating row whose event is above the finalized block', async () => {
    const { cursors, read } = rotation([row(1, null), row(150, 'a')]);
    const page = (await read())!;
    await page.liftFloor(async () => FINAL, () => true, async () => () => true);
    expect(cursors.rows.get('floor')).toBe(encodePos({ block: 1, log: 0 }));
  });

  it('moves no floor without a finalized block, nor on a page read from the next cursor', async () => {
    const rows = [row(1, 'a'), row(2, 'b'), row(3, 'c')];
    const { cursors, read } = rotation(rows, memoryScanCursors(), 2);
    let page = (await read())!;
    await page.liftFloor(async () => null, () => true, async () => () => true);
    expect(cursors.rows.get('floor')).toBeUndefined();
    expect(cursors.rows.get('next')).toBe(encodePos({ block: 2, log: 0 }));
    page = (await read())!;
    expect(page.nominees).toEqual(['c']);
    await page.liftFloor(async () => FINAL, () => true, async () => () => true);
    expect(cursors.rows.get('floor'), 'a page from the next cursor lifts nothing').toBeUndefined();
    expect(cursors.rows.get('next'), 'past the last page the next run starts at the floor').toBe('');
  });

  it('stops a ledger page still unread at the cutoff, as a bounded read does', async () => {
    const hung: EventLedger = { matching: async () => null, page: () => new Promise<never>(() => {}) };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { read } = rotation([], memoryScanCursors(), 10, hung, Date.now() + 100);
      const done = read().then(
        () => 'read',
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(150);
      expect(await done).toBeInstanceOf(PastRunDeadline);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the page when a cursor write is not finished by the cutoff', async () => {
    const cursors = memoryScanCursors();
    const put = cursors.put.bind(cursors);
    cursors.put = (item: string, value: string) => (item === 'next' ? new Promise<never>(() => {}) : put(item, value));
    const rows = [row(1, 'a'), row(2, 'b'), row(3, 'c')];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { read } = rotation(rows, cursors, 2, new Ledger(rows), Date.now() + 100);
      const done = read();
      await vi.advanceTimersByTimeAsync(150);
      const page = (await done)!;
      expect(page.nominees, 'the next run reads this page again').toEqual(['a', 'b']);
      expect(cursors.rows.get('next')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('attemptOrder', () => {
  it('tries every nominee once, starting at a point that moves from run to run', () => {
    expect(attemptOrder(0, 5)).toEqual([]);
    expect(attemptOrder(1, 7)).toEqual([0]);
    for (const n of [2, 3, 7, 200]) {
      for (const v of [0, 1, 2, 31, 1_000_000]) {
        const o = attemptOrder(n, v);
        expect([...o].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
        expect(o.every((x, j) => j === 0 || x === (o[j - 1]! + 1) % n), 'one turn round the page').toBe(true);
      }
    }
    expect(attemptOrder(5, 0)[0]).toBe(0);
    expect(attemptOrder(3, 1)).toEqual([1, 2, 0]);
  });

  it('spreads the starts over the page, so a row far down is soon near a start', () => {
    // 20 runs over a page of 200: no stretch of the page is left without a
    // start for more than about 2.6 times the even spacing of 10.
    const starts = [...new Set(Array.from({ length: 20 }, (_, v) => attemptOrder(200, v)[0]!))].sort((a, b) => a - b);
    expect(starts).toHaveLength(20);
    const gaps = starts.map((x, i) => (i + 1 < starts.length ? starts[i + 1]! : starts[0]! + 200) - x);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(26);
  });
});
