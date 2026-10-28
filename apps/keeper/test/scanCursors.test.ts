/**
 * The scan-cursor store (#2984): one row per pass and item on the keeper's
 * private schema, so two passes that use the same item name never move each
 * other's cursor. And the floor rule every pass shares: a floor moves only on
 * what the finalized block shows (Codex #2993 r4).
 */
import { describe, expect, it } from 'vitest';
import { d1ScanCursors, finalFloor, finalizedBlockOnce, scanCursorKey } from '../src/scanCursors';
import type { KeeperD1 } from '../src/db';
import { createKeeperD1 } from './helpers/schemas';

describe('d1ScanCursors', () => {
  it('keys each cursor by its pass as well as its item name', async () => {
    const h = createKeeperD1();
    const closeOut = d1ScanCursors(h.d1 as KeeperD1, 421614, '0xAB', 'rewardCloseOut');
    const zeroed = d1ScanCursors(h.d1 as KeeperD1, 421614, '0xab', 'rewardZeroedDay');
    await closeOut.put('entry-floor', '700:0');
    await zeroed.put('entry-floor', '12:3');
    expect(await closeOut.get(['entry-floor', 'era-floor'])).toEqual(new Map([['entry-floor', '700:0']]));
    expect(await zeroed.get(['entry-floor'])).toEqual(new Map([['entry-floor', '12:3']]));
    const rows = h.db.prepare(`SELECT item FROM keeper_work_open WHERE kind = 'scan_cursor' ORDER BY item`).all() as { item: string }[];
    expect(rows.map((r) => r.item)).toEqual([scanCursorKey('rewardCloseOut', 'entry-floor'), scanCursorKey('rewardZeroedDay', 'entry-floor')]);
  });
});

describe('finalFloor', () => {
  const block = { number: 9n, timestamp: 90n };
  const at = (b: typeof block | null) => async () => b;

  it('moves only past the leading items finished at the head AND at finality', async () => {
    const asked: number[][] = [];
    const final = async (items: readonly number[]) => {
      asked.push([...items]);
      return new Set([3, 4, 6]);
    };
    const f = await finalFloor(3, [3, 4, 5, 6, 7], (i) => i !== 7, at(block), final);
    expect(f, 'item 5 is finished at the head but not yet final').toBe(5);
    expect(asked, 'finality is asked only about what the head reading passes').toEqual([[3, 4, 5, 6]]);
  });

  it('reads nothing when the head reading passes nothing, and holds without a finalized block', async () => {
    let reads = 0;
    const final = async () => {
      reads += 1;
      return new Set<number>([0, 1]);
    };
    expect(await finalFloor(0, [0, 1], () => false, at(block), final)).toBe(0);
    expect(await finalFloor(0, [0, 1], () => true, at(null), final)).toBe(0);
    expect(reads).toBe(0);
  });

  it('reads the finalized block once per reader, and reads a failure as none', async () => {
    let calls = 0;
    const ok = finalizedBlockOnce({ getBlock: (async () => (calls++, { number: 9n, timestamp: 90n })) as never });
    expect(await ok()).toEqual(block);
    expect(await ok()).toEqual(block);
    expect(calls).toBe(1);
    const failing = finalizedBlockOnce({ getBlock: (async () => { throw new Error('no finalized tag'); }) as never });
    expect(await failing()).toBeNull();
    const numberless = finalizedBlockOnce({ getBlock: (async () => ({ timestamp: 90n })) as never });
    expect(await numberless(), 'a block without a number is no finalized block').toBeNull();
    const throwing = finalizedBlockOnce({ getBlock: (() => { throw new Error('synchronous'); }) as never });
    expect(await throwing(), 'a client that throws before it returns a promise').toBeNull();
  });
});
