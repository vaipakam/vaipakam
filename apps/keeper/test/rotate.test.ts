/**
 * The keeper's stateless rotations (src/rotate.ts). `pagedWalk` (#2572 r7)
 * moves a paged scan's start by item, so a run that stops partway through its
 * first page does not leave that page's tail unreached run after run.
 */
import { describe, expect, it } from 'vitest';
import { pagedWalk, rotate, walkFrom, walkStart } from '../src/rotate';

describe('rotate', () => {
  it('starts at step mod length', () => {
    expect(rotate([1, 2, 3], 4)).toEqual([2, 3, 1]);
    expect(rotate([], 4)).toEqual([]);
  });
});

describe('walkStart', () => {
  it('stays inside the list', () => {
    for (let run = 0; run < 500; run++) {
      const s = walkStart(29_000_000 + run, 7);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(7);
    }
    expect(walkStart(5, 0)).toBe(0);
  });

  it('leaves no gap wider than 2 x total / n after n consecutive runs', () => {
    const total = 1_000;
    for (const base of [0, 29_000_000, 123_456_789]) {
      for (const n of [10, 50, 200, 1_000]) {
        const starts = [...new Set(Array.from({ length: n }, (_, r) => walkStart(base + r, total)))].sort((a, b) => a - b);
        let widest = total - starts[starts.length - 1] + starts[0];
        for (let i = 1; i < starts.length; i++) widest = Math.max(widest, starts[i] - starts[i - 1]);
        expect(widest).toBeLessThanOrEqual(Math.ceil((2 * total) / n) + 1);
      }
    }
  });

  it('reaches an item deep inside a page as the start, which a page rotation never does', () => {
    const total = 400;
    const deep = new Set<number>();
    for (let run = 0; run < 2_000; run++) deep.add(walkStart(run, total));
    // Item 137 is mid-page for a 200-item page; a start moving by page is 0 or 200.
    expect(deep.has(137)).toBe(true);
    expect(deep.size).toBe(total);
  });
});

describe('pagedWalk', () => {
  it('covers every item exactly once in pages no longer than pageSize', () => {
    for (const total of [1n, 199n, 200n, 201n, 1_037n]) {
      for (const run of [0, 1, 29_000_017]) {
        const seen: bigint[] = [];
        for (const { cursor, limit } of pagedWalk(total, 200n, run)) {
          expect(limit).toBeGreaterThan(0n);
          expect(limit).toBeLessThanOrEqual(200n);
          for (let i = 0n; i < limit; i++) seen.push(cursor + i);
        }
        expect(seen.length).toBe(Number(total));
        expect(new Set(seen.map(String)).size).toBe(Number(total));
        expect(seen[0]).toBe(BigInt(walkStart(run, Number(total))));
      }
    }
  });

  it('is empty for an empty list', () => {
    expect(pagedWalk(0n, 200n, 3)).toEqual([]);
  });
});

describe('walkFrom — a held list read in chunks (Codex #2607 r13)', () => {
  it('keeps every item once, and over runs puts every item in the first chunk', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const reached = new Set<number>();
    for (let run = 0; run < 40; run++) {
      const order = walkFrom(items, run);
      expect([...order].sort((a, b) => a - b)).toEqual(items);
      order.slice(0, 100).forEach((i) => reached.add(i));
    }
    expect(reached.size).toBe(items.length);
  });
});
