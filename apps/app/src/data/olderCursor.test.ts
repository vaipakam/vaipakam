/**
 * `olderCursor` — round 41 P2.
 *
 * The analytics page states one freshness line for counters drawn from
 * two separate indexer responses. It used to take the first cursor that
 * existed, so it could claim the offers response's coverage while the
 * loan counters came from an older read. When a claim spans two sources,
 * only the LAGGING one is true of the whole.
 */
import { describe, expect, it } from 'vitest';
import { olderCursor } from '../pages/Analytics';

const A = { lastBlock: 100, updatedAt: 1000 };
const B = { lastBlock: 200, updatedAt: 2000 };

describe('olderCursor', () => {
  it('returns the lower block regardless of argument order', () => {
    expect(olderCursor(A, B)).toBe(A);
    expect(olderCursor(B, A)).toBe(A);
  });

  it('falls back to the one that exists', () => {
    expect(olderCursor(A, null)).toBe(A);
    expect(olderCursor(null, B)).toBe(B);
    expect(olderCursor(null, null)).toBe(null);
  });

  // A cursor with no block cannot be compared, so it must not win by
  // accident and silently suppress a real one.
  it('prefers a comparable cursor over one with no block', () => {
    const noBlock = { updatedAt: 1 };
    expect(olderCursor(noBlock, B)).toBe(B);
    expect(olderCursor(A, noBlock)).toBe(A);
  });

  it('returns the blockless one only when neither has a block', () => {
    const x = { updatedAt: 1 };
    const y = { updatedAt: 2 };
    expect(olderCursor(x, y)).toBe(x);
  });

  it('breaks a block tie on the older timestamp', () => {
    const older = { lastBlock: 100, updatedAt: 500 };
    const newer = { lastBlock: 100, updatedAt: 900 };
    expect(olderCursor(newer, older)).toBe(older);
    expect(olderCursor(older, newer)).toBe(older);
  });

  it('treats a missing timestamp on a tie as the newer one', () => {
    const dated = { lastBlock: 100, updatedAt: 500 };
    const undated = { lastBlock: 100 };
    expect(olderCursor(undated, dated)).toBe(dated);
  });
});
