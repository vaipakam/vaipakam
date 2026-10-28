/**
 * #2984 — the one rotation rule every ledger-nominated pass reads with
 * (`ledgerRotation.ts`): a page from where the last run stopped, a floor that
 * moves only on a page read from the floor, past rows finished at the head
 * AND at the finalized block, where a nominating row also needs its own
 * event finalized.
 */
import { describe, expect, it } from 'vitest';
import { encodePos, type EventLedger, type LedgerPos, type LedgerRow } from '../src/eventLedger';
import { readLedgerRotation } from '../src/ledgerRotation';
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

function rotation(rows: LedgerRow[], cursors = memoryScanCursors(), limit = 10) {
  return {
    cursors,
    read: () =>
      readLedgerRotation<string>({
        ledger: new Ledger(rows),
        cursors,
        chainId: 1,
        kinds: ['E'],
        floorItem: 'floor',
        nextItem: 'next',
        limit,
        nominee: (r) => (typeof r.args.id === 'string' ? r.args.id : null),
        id: (k) => k,
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
});
