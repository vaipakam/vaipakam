import { describe, expect, it } from 'vitest';
import { concat, keccak256, type Hex } from 'viem';
import {
  CollateralSetKind,
  checkPublishedList,
  collateralSetLeaf,
  listedProof,
  processProof,
  setTakesWithoutProof,
  type CollateralSetView,
} from './collateralSet';

const pair = (a: Hex, b: Hex): Hex => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

function view(over: Partial<CollateralSetView>): CollateralSetView {
  return { kind: CollateralSetKind.Collection, low: 0n, high: 0n, root: '0x', listCount: 0, exclusions: [], ...over };
}

describe('collateral set (#3328 / #3688)', () => {
  it('takes any id of a Collection set, an exclusion winning', () => {
    const s = view({ exclusions: [5n] });
    expect(setTakesWithoutProof(s, 4n)).toBe(true);
    expect(setTakesWithoutProof(s, 5n)).toBe(false);
  });

  it('takes a Range set inclusively', () => {
    const s = view({ kind: CollateralSetKind.Range, low: 3n, high: 6n });
    expect([2n, 3n, 6n, 7n].map((t) => setTakesWithoutProof(s, t))).toEqual([false, true, true, false]);
  });

  it('leaves a Listed set to the proof and refuses a None set', () => {
    expect(setTakesWithoutProof(view({ kind: CollateralSetKind.Listed }), 1n)).toBeNull();
    expect(setTakesWithoutProof(view({ kind: CollateralSetKind.None }), 1n)).toBe(false);
  });

  it('builds the root the contract test builds for 7, 9, 11, 13, and proofs that verify', () => {
    // CollectionOfferTest._tree: hash(leaf7, leaf9) and hash(leaf11, leaf13), then their pair.
    const [l7, l9, l11, l13] = [7n, 9n, 11n, 13n].map(collateralSetLeaf);
    const root = pair(pair(l7, l9), pair(l11, l13));
    const ids = [7n, 9n, 11n, 13n];
    for (const id of ids) {
      const proof = listedProof(ids, { root, listCount: 4 }, id);
      expect(proof, `proof for ${id}`).not.toBeNull();
      expect(processProof(proof!, collateralSetLeaf(id))).toBe(root);
    }
    expect(listedProof(ids, { root, listCount: 4 }, 8n)).toBeNull();
  });

  it('matches a sorted-leaf tree too, for any list size', () => {
    for (const n of [1, 2, 3, 5, 8, 33]) {
      const ids = Array.from({ length: n }, (_, i) => BigInt(1000 + i * 3));
      // Root from the module's own sorted build, found through a self-consistent proof.
      const any = checkPublishedList(ids, { root: '0x00', listCount: n });
      expect(any).toEqual({ ok: false, problem: 'root' });
      // Recompute the sorted root independently by folding a proof.
      const leaves = ids.map(collateralSetLeaf).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      const nodes: Hex[] = new Array(2 * n - 1);
      leaves.forEach((l, i) => (nodes[nodes.length - 1 - i] = l));
      for (let i = nodes.length - 1 - n; i >= 0; i--) nodes[i] = pair(nodes[2 * i + 1], nodes[2 * i + 2]);
      const root = nodes[0];
      for (const id of ids) {
        const proof = listedProof(ids, { root, listCount: n }, id);
        expect(proof, `n=${n} id=${id}`).not.toBeNull();
        expect(processProof(proof!, collateralSetLeaf(id))).toBe(root);
      }
    }
  });

  it('refuses a list that does not check out against the offer', () => {
    const ids = [1n, 2n, 3n];
    expect(checkPublishedList([], { root: '0x00', listCount: 0 })).toEqual({ ok: false, problem: 'empty' });
    expect(checkPublishedList([1n, 1n], { root: '0x00', listCount: 2 })).toEqual({ ok: false, problem: 'duplicates' });
    expect(checkPublishedList(ids, { root: '0x00', listCount: 4 })).toEqual({ ok: false, problem: 'count' });
    expect(listedProof(ids, { root: '0x00', listCount: 3 }, 1n)).toBeNull();
  });
});
