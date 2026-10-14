/**
 * #2489 (Codex r2) — the verified insertion hints for a crowded transport day.
 *
 * The keeper derives the predecessor the contract's own bounded walk would
 * find, from the chain's views, so an old delivery indexed behind more than
 * 128 newer epochs can still be indexed. The contract verifies a hint and
 * refuses a wrong one, so a wrong derivation costs a refused simulation, not a
 * mis-ordered list — but a wrong one would leave the batch stuck exactly as
 * before. So the walk is pinned two ways: hand-built lists for each rule (the
 * cursor floor, the tie on arrival, the late chain only off the tail, paging),
 * and a seeded comparison against a reference implementation of the
 * contract's unhinted back-walk (`LibRewardCustody._linkIntoDay` / `_linkLate`)
 * over many random days.
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { ZERO32, hintsForDay, hintsForDays, keyBefore, type DayOrderReader } from '../src/transportHints';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

interface Node {
  id: Hex;
  at: bigint;
}

/** A day as the chain holds it: the list in order, the cursor (index into
 *  the list, or -1), and the late chain in order. Pages honour `limit`. */
function reader(list: Node[], cursorIdx: number, late: Node[]): DayOrderReader & { reads: number } {
  const pageOf = (arr: Node[], from: Hex, limit: number) => {
    const start = from === ZERO32 ? 0 : arr.findIndex((n) => n.id === from);
    if (start < 0) return { page: [], arrivedAt: [], next: ZERO32 };
    const slice = arr.slice(start, start + limit);
    const nxt = arr[start + limit];
    return { page: slice.map((n) => n.id), arrivedAt: slice.map((n) => n.at), next: nxt ? nxt.id : ZERO32 };
  };
  const r = {
    reads: 0,
    cursor: async () => {
      r.reads++;
      return cursorIdx >= 0 ? list[cursorIdx].id : ZERO32;
    },
    listFrom: async (_d: bigint, from: Hex, limit: number) => {
      r.reads++;
      return pageOf(list, from, limit);
    },
    lateFrom: async (_d: bigint, from: Hex, limit: number) => {
      r.reads++;
      return pageOf(late, from, limit);
    },
  };
  return r;
}

const A = { id: id(0xa), at: 10n };
const B = { id: id(0xb), at: 20n };
const C = { id: id(0xc), at: 30n };
const D = { id: id(0xd), at: 40n };

describe('hintsForDay — each rule', () => {
  it('an empty day: the head, and no late link', async () => {
    expect(await hintsForDay(reader([], -1, []), 1n, id(1), 5n)).toEqual({ prev: ZERO32, latePrev: ZERO32 });
  });

  it('the last node that sorts before it; at the tail, no late hint', async () => {
    expect(await hintsForDay(reader([A, B, C], -1, []), 1n, id(1), 25n)).toEqual({ prev: B.id, latePrev: ZERO32 });
    expect(await hintsForDay(reader([A, B, C], -1, []), 1n, id(1), 35n), 'newest: the tail').toEqual({
      prev: C.id,
      latePrev: ZERO32,
    });
    expect(await hintsForDay(reader([A, B, C], -1, []), 1n, id(1), 5n), 'oldest, no cursor: the head').toEqual({
      prev: ZERO32,
      latePrev: ZERO32,
    });
  });

  it('never before the cursor: an epoch older than the cursor takes the cursor as its predecessor', async () => {
    const late = [
      { id: id(0x31), at: 3n },
      { id: id(0x32), at: 8n },
    ];
    expect(await hintsForDay(reader([A, B, C, D], 1, late), 1n, id(1), 5n)).toEqual({
      prev: B.id, // the cursor, not the head
      latePrev: id(0x31), // the last late link older than it
    });
  });

  it('a tie on arrival is broken by the batch id, as the contract keys it', async () => {
    const tie = { id: id(0x50), at: 20n };
    expect(keyBefore(20n, id(0x40), 20n, tie.id)).toBe(true);
    expect(keyBefore(20n, id(0x60), 20n, tie.id)).toBe(false);
    expect((await hintsForDay(reader([A, B, C], -1, []), 1n, id(0x0c), 20n)).prev, 'same arrival as B, larger id').toBe(B.id);
    expect((await hintsForDay(reader([A, B, C], -1, []), 1n, id(0x01), 20n)).prev, 'same arrival as B, smaller id').toBe(A.id);
  });

  it('a batch already listed is a no-op link', async () => {
    expect((await hintsForDay(reader([A, B, C], -1, []), 1n, B.id, 20n)).prev).toBe(A.id);
  });

  it('pages through a list and a late chain longer than one read', async () => {
    // Arrivals spaced two apart, so the new link (an odd arrival) ties none.
    const list = Array.from({ length: 250 }, (_, i) => ({ id: id(0x1000 + i), at: BigInt(200 + 2 * i) }));
    const late = Array.from({ length: 230 }, (_, i) => ({ id: id(0x5000 + i), at: BigInt(10 + i) }));
    const r = reader(list, -1, late);
    // Arrives between list[219] (638) and list[220] (640); every late link is older.
    const h = await hintsForDay(r, 1n, id(0x1), 639n);
    expect(h.prev).toBe(list[219].id);
    expect(h.latePrev).toBe(late[229].id);
    expect(r.reads, 'one cursor read, three list pages, three late pages').toBe(7);
  });
});

describe('hintsForDays — aligned with the whole list, hinted only where the call links', () => {
  it('fills [from, to) and leaves the rest zero', async () => {
    const h = await hintsForDays(reader([A, B, C], -1, []), [1n, 2n, 3n, 4n], 1, 3, id(1), 25n);
    expect(h.hints).toEqual([ZERO32, B.id, B.id, ZERO32]);
    expect(h.lateHints).toEqual([ZERO32, ZERO32, ZERO32, ZERO32]);
  });
});

/** The contract's UNHINTED walk, as `_linkIntoDay` / `_linkLate` write it:
 *  back from the tail while the node is not passed and the new link sorts
 *  before it; the late walk the same over the late chain. */
function contractWalk(list: Node[], cursorIdx: number, late: Node[], nid: Hex, at: bigint) {
  let i = list.length - 1;
  while (i >= 0 && i > cursorIdx && keyBefore(at, nid, list[i].at, list[i].id)) i--;
  const prev = i >= 0 ? list[i].id : ZERO32;
  const atTail = i === list.length - 1;
  let j = late.length - 1;
  while (j >= 0 && keyBefore(at, nid, late[j].at, late[j].id)) j--;
  return { prev, latePrev: atTail ? ZERO32 : j >= 0 ? late[j].id : ZERO32 };
}

describe('hintsForDay agrees with the contract walk', () => {
  it('on 500 seeded random days', async () => {
    let seed = 2489;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let t = 0; t < 500; t++) {
      const n = rnd(40);
      // A list sorted by key after the cursor; before it, anything (passed).
      const list: Node[] = [];
      for (let k = 0; k < n; k++) list.push({ id: id(0x100 + k), at: BigInt(rnd(50)) });
      const cursorIdx = n > 0 && rnd(2) === 1 ? rnd(n) : -1;
      const tailPart = list.slice(cursorIdx + 1).sort((x, y) => (keyBefore(x.at, x.id, y.at, y.id) ? -1 : 1));
      const sorted = [...list.slice(0, cursorIdx + 1), ...tailPart];
      const late = Array.from({ length: rnd(10) }, (_, k) => ({ id: id(0x900 + k), at: BigInt(rnd(50)) })).sort((x, y) =>
        keyBefore(x.at, x.id, y.at, y.id) ? -1 : 1,
      );
      const nid = id(0x50000 + t);
      const at = BigInt(rnd(50));
      expect(await hintsForDay(reader(sorted, cursorIdx, late), 1n, nid, at), `day ${t}`).toEqual(
        contractWalk(sorted, cursorIdx, late, nid, at),
      );
    }
  });
});
