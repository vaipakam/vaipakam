/**
 * The lagging of two indexer cursors.
 *
 * WHY IT IS ITS OWN MODULE (round 41 self-review). It first landed as an
 * export from `pages/Analytics.tsx`, which meant its test — already in
 * `src/data/` alongside every other pure resolver in this app — imported
 * a page component to exercise six lines of arithmetic, dragging React,
 * wagmi and the whole page graph in with it. Pure decisions live here;
 * pages render them.
 *
 * WHY IT EXISTS (round 41 P2). `/analytics` states one freshness figure
 * over counters drawn from two separate indexer responses, and used to
 * take whichever response carried a cursor first. That let it quote the
 * offers read's coverage over loan counters from an older read. When a
 * claim spans two sources, only the LAGGING one is true of the whole.
 *
 * NOT a repair for the intra-response race (#2080): each endpoint reads
 * its aggregates and its cursor in separate queries, so a single
 * response can already be ahead of its own counters. Choosing the older
 * of two cannot fix that; it only stops the page borrowing the fresher.
 */
export function olderCursor<T extends { lastBlock?: number; updatedAt?: number }>(
  a: T | null,
  b: T | null,
): T | null {
  if (a === null) return b;
  if (b === null) return a;
  const ab = a.lastBlock;
  const bb = b.lastBlock;
  if (typeof ab !== 'number') return typeof bb === 'number' ? b : a;
  if (typeof bb !== 'number') return a;
  if (ab !== bb) return ab < bb ? a : b;
  const au = a.updatedAt ?? Number.POSITIVE_INFINITY;
  const bu = b.updatedAt ?? Number.POSITIVE_INFINITY;
  return au <= bu ? a : b;
}
