import { describe, expect, it } from 'vitest';
import { walkOrderFor } from './walkOrder.mjs';

const ACTIVE = 1;
const PENDING = 2;
const loan = (id, status = ACTIVE) => ({ id, status });
const ids = (out) => out.map((l) => l.id);

describe('walkOrderFor', () => {
  it('leaves a non-lender run in discovery order', () => {
    const loans = [loan(1, PENDING), loan(2), loan(3, PENDING)];
    expect(ids(walkOrderFor({ loans, role: 'borrower', activeStatus: ACTIVE }))).toEqual([1, 2, 3]);
  });

  it('puts Active candidates first (round 9)', () => {
    const loans = [loan(1, PENDING), loan(2, PENDING), loan(3), loan(4, PENDING), loan(5)];
    expect(ids(walkOrderFor({ loans, role: 'lender', activeStatus: ACTIVE }))).toEqual([
      3, 5, 1, 2, 4,
    ]);
  });

  it('demotes an Active position whose sale was accepted (round 28)', () => {
    const loans = [loan(1), loan(2), loan(3), loan(4, PENDING)];
    expect(
      ids(
        walkOrderFor({
          loans,
          role: 'lender',
          activeStatus: ACTIVE,
          acceptedSale: new Set([1, 2]),
        }),
      ),
    ).toEqual([3, 1, 2, 4]);
  });

  it('promotes positions the protocol would accept a close-out on (round 72)', () => {
    const loans = [loan(1), loan(2), loan(3), loan(4)];
    expect(
      ids(
        walkOrderFor({
          loans,
          role: 'lender',
          activeStatus: ACTIVE,
          acceptsCloseOut: new Set([3]),
        }),
      ),
    ).toEqual([3, 1, 2, 4]);
  });

  it('keeps every band stable within itself', () => {
    // The point of a partition rather than a sort: discovery order
    // survives inside each band, so this reorders which loans are
    // sampled and never how a sampled one is judged.
    const loans = [loan(1), loan(2), loan(3), loan(4), loan(5), loan(6, PENDING)];
    expect(
      ids(
        walkOrderFor({
          loans,
          role: 'lender',
          activeStatus: ACTIVE,
          acceptedSale: new Set([2]),
          acceptsCloseOut: new Set([4, 5]),
        }),
      ),
    ).toEqual([4, 5, 1, 3, 2, 6]);
  });

  it('ranks nothing on a read that could not be taken', () => {
    // Both inputs are sets of ANSWERS. A probe that failed contributes
    // no id, and the loan must keep its place rather than be demoted on
    // a failed read — one bad RPC response would otherwise cost the run
    // the coverage this promotion exists to secure.
    const loans = [loan(1), loan(2), loan(3)];
    expect(
      ids(
        walkOrderFor({
          loans,
          role: 'lender',
          activeStatus: ACTIVE,
          acceptedSale: new Set(),
          acceptsCloseOut: new Set(),
        }),
      ),
    ).toEqual([1, 2, 3]);
  });

  it('is a no-op when every candidate is equally ranked', () => {
    const loans = [loan(1), loan(2), loan(3)];
    expect(
      ids(
        walkOrderFor({
          loans,
          role: 'lender',
          activeStatus: ACTIVE,
          acceptsCloseOut: new Set([1, 2, 3]),
        }),
      ),
    ).toEqual([1, 2, 3]);
  });

  it('never drops or duplicates a candidate', () => {
    const loans = [loan(1), loan(2, PENDING), loan(3), loan(4), loan(5, PENDING)];
    const out = walkOrderFor({
      loans,
      role: 'lender',
      activeStatus: ACTIVE,
      acceptedSale: new Set([3]),
      acceptsCloseOut: new Set([4]),
    });
    expect(out).toHaveLength(loans.length);
    expect([...new Set(ids(out))].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('tolerates a missing or malformed candidate list', () => {
    expect(walkOrderFor({ loans: undefined, role: 'lender', activeStatus: ACTIVE })).toEqual([]);
    expect(walkOrderFor({ loans: [], role: 'lender', activeStatus: ACTIVE })).toEqual([]);
  });

  it('returns a new array rather than the caller’s', () => {
    const loans = [loan(1), loan(2)];
    expect(walkOrderFor({ loans, role: 'borrower', activeStatus: ACTIVE })).not.toBe(loans);
  });
});
