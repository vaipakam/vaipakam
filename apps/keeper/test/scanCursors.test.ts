/**
 * The scan-cursor store (#2984): one row per pass and item on the keeper's
 * private schema, so two passes that use the same item name never move each
 * other's cursor.
 */
import { describe, expect, it } from 'vitest';
import { d1ScanCursors, scanCursorKey } from '../src/scanCursors';
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
