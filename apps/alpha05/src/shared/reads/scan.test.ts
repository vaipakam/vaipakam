import { describe, expect, it } from 'vitest';
import { scanAll } from './scan';

/** An index of `length` rows where `match(i)` decides the rows a page returns. */
function index(length: number, match: (i: number) => boolean) {
  const calls: Array<[bigint, number]> = [];
  const readPage = async (cursor: bigint, maxScan: number) => {
    calls.push([cursor, maxScan]);
    const start = Number(cursor);
    const end = Math.min(length, start + maxScan);
    const rows: number[] = [];
    for (let i = start; i < end; i++) if (match(i)) rows.push(i);
    return { rows, nextCursor: BigInt(end) };
  };
  return { readPage, calls };
}

describe('scanAll', () => {
  it('walks past an empty page, which is not the end', async () => {
    const { readPage } = index(25, (i) => i >= 20);
    const out = await scanAll(readPage, { maxScan: 10, maxPages: 10 });
    expect(out).toEqual({ rows: [20, 21, 22, 23, 24], complete: true });
  });

  it('reads one more page when the index ends exactly on a page boundary', async () => {
    const { readPage, calls } = index(20, () => true);
    const out = await scanAll(readPage, { maxScan: 10, maxPages: 10 });
    expect(out.rows).toHaveLength(20);
    expect(out.complete).toBe(true);
    expect(calls.map(([c]) => c)).toEqual([0n, 10n, 20n]);
  });

  it('says it is incomplete when the page cap stops it', async () => {
    const { readPage } = index(100, () => true);
    const out = await scanAll(readPage, { maxScan: 10, maxPages: 3 });
    expect(out).toEqual({ rows: Array.from({ length: 30 }, (_, i) => i), complete: false });
  });

  it('refuses a cursor that moves backwards', async () => {
    await expect(scanAll(async () => ({ rows: [], nextCursor: -1n }), { maxScan: 10, maxPages: 2 })).rejects.toThrow(/backwards/);
  });
});
