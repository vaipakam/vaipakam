/**
 * A full walk of a row-bounded index view (#2930's `LibScanPage` rule): each
 * call reads at most `maxScan` rows of the index from `cursor` and returns
 * the matches among them and the position to resume from. A page may be
 * EMPTY with the walk unfinished, so an empty page is never read as the end;
 * the end is a call that read fewer rows than it was allowed to.
 *
 * The walk is capped: past `maxPages` it stops and says it is incomplete,
 * and the surface states that rather than presenting a partial list as all
 * of it.
 */
export interface ScanResult<T> {
  rows: T[];
  complete: boolean;
}

export async function scanAll<T>(
  readPage: (cursor: bigint, maxScan: number) => Promise<{ rows: readonly T[]; nextCursor: bigint }>,
  opts: { maxScan: number; maxPages: number },
): Promise<ScanResult<T>> {
  const rows: T[] = [];
  let cursor = 0n;
  for (let page = 0; page < opts.maxPages; page++) {
    const { rows: got, nextCursor } = await readPage(cursor, opts.maxScan);
    rows.push(...got);
    if (nextCursor < cursor) throw new Error(`scan: the cursor moved backwards (${cursor} → ${nextCursor})`);
    // Fewer index rows read than allowed: the walk reached the index's end.
    if (nextCursor - cursor < BigInt(opts.maxScan)) return { rows, complete: true };
    cursor = nextCursor;
  }
  return { rows, complete: false };
}
