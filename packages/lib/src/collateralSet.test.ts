import { describe, expect, it } from 'vitest';
import { concat, keccak256, type Hex } from 'viem';
import {
  CollateralSetKind,
  buildTree,
  canonicalListFile,
  checkPublishedList,
  listFileHash,
  parseListFile,
  collateralSetLeaf,
  listedProof,
  processProof,
  setTakesWithoutProof,
  type CollateralSetView,
} from './collateralSet';

const pair = (a: Hex, b: Hex): Hex => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

function view(over: Partial<CollateralSetView>): CollateralSetView {
  return { kind: CollateralSetKind.Collection, low: 0n, high: 0n, root: '0x', listCount: 0, listHash: '0x', exclusions: [], ...over };
}

/** The offer fields a listed set over `ids` carries: the sorted standard
 *  tree's root recomputed here by hand, so the test does not take the
 *  module's word for it, and the hash of the canonical file. */
function setFor(ids: bigint[]): { root: Hex; listCount: number; listHash: Hex } {
  const n = ids.length;
  const leaves = ids.map(collateralSetLeaf).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const nodes: Hex[] = new Array(2 * n - 1);
  leaves.forEach((l, i) => (nodes[nodes.length - 1 - i] = l));
  for (let i = nodes.length - 1 - n; i >= 0; i--) nodes[i] = pair(nodes[2 * i + 1], nodes[2 * i + 2]);
  expect(buildTree(ids).nodes[0]).toBe(nodes[0]);
  return { root: nodes[0], listCount: n, listHash: listFileHash(canonicalListFile(ids)) };
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

  it('builds the one standard tree for any list size, and proofs that verify', () => {
    for (const n of [1, 2, 3, 4, 5, 8, 33]) {
      const ids = Array.from({ length: n }, (_, i) => BigInt(1000 + i * 3));
      const set = setFor(ids);
      for (const id of ids) {
        const proof = listedProof(ids, set, id);
        expect(proof, `n=${n} id=${id}`).not.toBeNull();
        expect(processProof(proof!, collateralSetLeaf(id))).toBe(set.root);
      }
      expect(listedProof(ids, set, 1n)).toBeNull();
    }
  });

  it('refuses a root built in list order instead of the sorted standard tree', () => {
    // CollectionOfferTest._tree: hash(leaf7, leaf9) and hash(leaf11, leaf13), then their pair.
    const ids = [7n, 9n, 11n, 13n];
    const [l7, l9, l11, l13] = ids.map(collateralSetLeaf);
    const listOrder = pair(pair(l7, l9), pair(l11, l13));
    if (listOrder !== setFor(ids).root) {
      expect(checkPublishedList(ids, { ...setFor(ids), root: listOrder })).toEqual({ ok: false, problem: 'root' });
    }
  });

  it('writes and reads only the canonical list file', () => {
    const file = canonicalListFile([13n, 7n, 100n]);
    expect(file).toBe('["7","13","100"]');
    expect(listFileHash(file)).toBe(keccak256(new TextEncoder().encode(file)));
    expect(parseListFile(file)).toEqual([7n, 13n, 100n]);
    for (const bad of ['["7", "13"]', '["13","7"]', '["7","7"]', '["07"]', '[7]', '["7"]\n', '\ufeff["7"]', '{}', 'x']) {
      expect(parseListFile(bad), bad).toBeNull();
    }
    expect(parseListFile('[]')).toEqual([]);
  });

  it('checks the published ids against the offer hash, in whatever order they were published', () => {
    const ids = [13n, 7n, 9n];
    expect(checkPublishedList(ids, setFor(ids)).ok).toBe(true);
    expect(checkPublishedList(ids, { ...setFor(ids), listHash: `0x${'00'.repeat(32)}` })).toEqual({ ok: false, problem: 'hash' });
  });

  it('refuses a list that does not check out against the offer', () => {
    const ids = [1n, 2n, 3n];
    const set = setFor(ids);
    expect(checkPublishedList([], { ...set, listCount: 0 })).toEqual({ ok: false, problem: 'empty' });
    expect(checkPublishedList([1n, 1n], { ...set, listCount: 2 })).toEqual({ ok: false, problem: 'duplicates' });
    expect(checkPublishedList(ids, { ...set, listCount: 4 })).toEqual({ ok: false, problem: 'count' });
    expect(checkPublishedList(ids, { ...set, root: `0x${'00'.repeat(32)}` })).toEqual({ ok: false, problem: 'root' });
    expect(listedProof(ids, { ...set, root: `0x${'00'.repeat(32)}` }, 1n)).toBeNull();
  });
});
