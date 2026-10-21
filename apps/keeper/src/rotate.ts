// apps/keeper/src/rotate.ts
//
// The keeper's one stateless rotation: a list started at `step mod length`.
// A pass that can reach only part of a list per run rotates its start with the
// run, so every item is reached within a bounded number of runs without any
// state carried between them.

/** The items starting at `step mod length`. Pure. */
export function rotate<T>(items: readonly T[], step: number): T[] {
  if (items.length === 0) return [];
  const start = ((step % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/** The fractional golden ratio, the step of {@link walkStart}. */
const GOLDEN_STEP = 0.6180339887498949;

/** Where run `run` starts a walk over `total` items read in pages (#2572 r7).
 *
 *  A paged list cannot use {@link rotate} on its pages: that moves the start a
 *  whole page at a time, so an item deep inside a page is never first, and a
 *  run that stops partway through its first page never reaches it. The start
 *  here moves by the golden ratio of the list each run (a Weyl sequence), so
 *  it lands on every item and spreads evenly: after n consecutive runs no gap
 *  between their starts is wider than 2 × total ÷ n (measured for every n up
 *  to 3,000, from several run offsets, in `test/rotate.test.ts`). A run that reaches k items before it stops therefore
 *  leaves no item unreached for longer than about 2 × total ÷ k runs, and
 *  nothing is carried between runs. Pure. */
export function walkStart(run: number, total: number): number {
  if (total <= 0) return 0;
  const frac = (run * GOLDEN_STEP) % 1;
  return Math.min(total - 1, Math.floor((frac < 0 ? frac + 1 : frac) * total));
}

/** One page read of a {@link pagedWalk}: `limit` items from `cursor`. */
export interface WalkPage {
  cursor: bigint;
  limit: bigint;
}

/** The page reads that walk `total` items from {@link walkStart}`(run, total)`
 *  to the end and then from the start, each at most `pageSize` long. Every item
 *  is in exactly one page. Pure. */
export function pagedWalk(total: bigint, pageSize: bigint, run: number): WalkPage[] {
  if (total <= 0n || pageSize <= 0n) return [];
  const start = BigInt(walkStart(run, Number(total)));
  const pages: WalkPage[] = [];
  const segment = (from: bigint, to: bigint): void => {
    for (let cursor = from; cursor < to; cursor += pageSize) {
      pages.push({ cursor, limit: to - cursor < pageSize ? to - cursor : pageSize });
    }
  };
  segment(start, total);
  segment(0n, start);
  return pages;
}

/** A list held whole but read in chunks (#2607 r13): the items starting at
 *  {@link walkStart}`(run, length)`, so the start moves by item, not by chunk,
 *  and a run the deadline cuts partway through leaves a different tail unread
 *  each time. Chunk the result in order. Pure. */
export function walkFrom<T>(items: readonly T[], run: number): T[] {
  return rotate(items, walkStart(run, items.length));
}
