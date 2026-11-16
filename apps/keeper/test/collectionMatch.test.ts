/**
 * #3688 — the matcher's collection-offer step: which borrower offers a
 * collection offer can take, the proof a listed set needs, and how the step
 * spends its budget and reads refusals.
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { CollateralSetKind, collateralSetLeaf, processProof } from '@vaipakam/lib/collateralSet';
import {
  MAX_TRIES_PER_PARENT,
  TakeFailure,
  borrowerFitsCollection,
  checkedTree,
  collectionProof,
  liftCollectionOffer,
  publishedIdsFromArgs,
  readPublishedLists,
  runCollectionMatches,
  type CollectionMatchIO,
  type CollectionParent,
  type CollectionSimVerdict,
  type ListState,
} from '../src/collectionMatch';
import { partitionByBucket, type OfferLite } from '../src/matcher';
import type { EventLedger } from '../src/eventLedger';

const LEND = '0x00000000000000000000000000000000000000c1';
const NFT = '0x00000000000000000000000000000000000000c2';
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const LENDER = addr(0x1e4d);

function offer(id: number, creator: `0x${string}`, offerType: 0 | 1, o: Partial<OfferLite> = {}): OfferLite {
  return {
    id: BigInt(id), creator, offerType, accepted: false, assetType: 0, collateralAssetType: 1,
    lendingAsset: LEND, collateralAsset: NFT, durationDays: 30n, interestRateBps: 500n,
    tokenId: 0n, quantity: 0n, collateralTokenId: 0n, collateralQuantity: 0n,
    amount: 100n, amountMax: 100n, amountFilled: 0n, interestRateBpsMax: 1000n, fillMode: 0,
    useFullTermInterest: true, allowsPartialRepay: false, createdAt: 0n, termsSetAt: 0n,
    ...o,
  };
}

const borrower = (id: number, token: bigint, o: Partial<OfferLite> = {}) =>
  offer(id, addr(0xb000 + id), 1, { collateralTokenId: token, ...o });

function parent(
  id: number,
  set: Partial<CollectionParent['set']> = {},
  o: { perLoan?: bigint; loansLeft?: number; offer?: Partial<OfferLite> } = {},
): CollectionParent {
  return {
    offer: offer(id, LENDER, 0, { amount: 300n, amountMax: 300n, interestRateBpsMax: 500n, fillMode: 1, ...o.offer }),
    set: { kind: CollateralSetKind.Collection, low: 0n, high: 0n, root: `0x${'00'.repeat(32)}`, listCount: 0, exclusions: [], ...set },
    perLoan: o.perLoan ?? 100n,
    loansLeft: o.loansLeft ?? 3,
  };
}

/** A listed set over `ids`, with the sorted standard tree's root. */
function listedSet(ids: bigint[]): Partial<CollectionParent['set']> {
  return { kind: CollateralSetKind.Listed, root: rootOf(ids), listCount: ids.length };
}

/** The root of the sorted standard tree over `ids` (reimplemented here, so
 *  the test does not take the lib's word for it). */
function rootOf(ids: bigint[]): Hex {
  const leaves = ids.map(collateralSetLeaf).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const nodes: Hex[] = new Array(2 * leaves.length - 1);
  leaves.forEach((l, i) => (nodes[nodes.length - 1 - i] = l));
  for (let i = nodes.length - 1 - leaves.length; i >= 0; i--) {
    nodes[i] = processProof([nodes[2 * i + 2]], nodes[2 * i + 1]);
  }
  return nodes[0];
}

interface Recorded {
  sims: string[];
  sends: string[];
}

function io(
  verdict: (p: CollectionParent, b: OfferLite) => CollectionSimVerdict,
  rec: Recorded,
  lists: Map<bigint, ListState> = new Map(),
  submitOk = true,
): CollectionMatchIO {
  return {
    lists: async () => lists,
    simulate: async (p, b) => {
      rec.sims.push(`${p.offer.id}:${b.id}`);
      return verdict(p, b);
    },
    submit: async (p, b) => {
      rec.sends.push(`${p.offer.id}:${b.id}`);
      return submitOk;
    },
  };
}

function args(parents: CollectionParent[], borrowers: OfferLite[], i: CollectionMatchIO, over: Record<string, unknown> = {}) {
  return {
    parents,
    borrowers,
    run: 0,
    maxSims: 100,
    maxSubmits: 25,
    passEndMs: Number.MAX_SAFE_INTEGER,
    uncertainBorrowers: new Set<string>(),
    io: i,
    log: () => {},
    ...over,
  };
}

describe('borrowerFitsCollection', () => {
  const p = parent(1);
  it('takes a borrower offer on the same pair that wants one loan', () => {
    expect(borrowerFitsCollection(p, borrower(10, 7n))).toBe(true);
  });
  it('refuses another asset pair, the lender itself, a lender offer and a taken offer', () => {
    expect(borrowerFitsCollection(p, borrower(10, 7n, { collateralAsset: addr(0xdd) }))).toBe(false);
    expect(borrowerFitsCollection(p, borrower(10, 7n, { creator: LENDER }))).toBe(false);
    expect(borrowerFitsCollection(p, offer(10, addr(0xb), 0, { collateralTokenId: 7n }))).toBe(false);
    expect(borrowerFitsCollection(p, borrower(10, 7n, { accepted: true }))).toBe(false);
  });
  it('refuses another token quantity, a rate ceiling below the offer, and a term the core refuses', () => {
    expect(borrowerFitsCollection(p, borrower(10, 7n, { collateralQuantity: 2n }))).toBe(false);
    expect(borrowerFitsCollection(p, borrower(10, 7n, { interestRateBpsMax: 499n }))).toBe(false);
    expect(borrowerFitsCollection(p, borrower(10, 7n, { durationDays: 60n }))).toBe(false);
  });
  it('needs one loan of exactly perLoan to fit the borrower window', () => {
    expect(borrowerFitsCollection(p, borrower(10, 7n, { amount: 150n, amountMax: 200n }))).toBe(false);
    expect(borrowerFitsCollection(p, borrower(10, 7n, { amount: 50n, amountMax: 200n, amountFilled: 150n }))).toBe(false);
    expect(borrowerFitsCollection(p, borrower(10, 7n, { amount: 50n, amountMax: 200n }))).toBe(true);
    expect(borrowerFitsCollection(p, borrower(10, 7n, { amount: 200n, amountMax: 200n, fillMode: 1 }))).toBe(false);
  });
});

describe('collectionProof', () => {
  it('needs no proof for a collection or a range, and an exclusion wins', () => {
    expect(collectionProof(parent(1), 7n, null)).toEqual([]);
    expect(collectionProof(parent(1, { exclusions: [7n] }), 7n, null)).toBeNull();
    const range = parent(1, { kind: CollateralSetKind.Range, low: 5n, high: 9n });
    expect(collectionProof(range, 9n, null)).toEqual([]);
    expect(collectionProof(range, 10n, null)).toBeNull();
  });
  it('proves a listed token against the checked list, and refuses one outside it or excluded', () => {
    const ids = [7n, 9n, 11n, 13n, 21n];
    const p = parent(1, listedSet(ids));
    const t = checkedTree(p, { ids });
    if (!('tree' in t)) throw new Error('list should check out');
    const proof = collectionProof(p, 11n, t.tree)!;
    expect(processProof(proof, collateralSetLeaf(11n))).toBe(p.set.root);
    expect(collectionProof(p, 8n, t.tree)).toBeNull();
    expect(collectionProof({ ...p, set: { ...p.set, exclusions: [11n] } }, 11n, t.tree)).toBeNull();
  });
  it('says why a listed set is left alone', () => {
    const ids = [7n, 9n, 11n];
    const p = parent(1, listedSet(ids));
    expect(checkedTree(p, undefined)).toEqual({ missing: 'its list was not read' });
    expect(checkedTree(p, { missing: 'x' })).toEqual({ missing: 'x' });
    expect(checkedTree(p, { ids: [7n, 9n] })).toEqual({ missing: expect.stringContaining('number of ids') });
    expect(checkedTree(p, { ids: [7n, 9n, 12n] })).toEqual({ missing: expect.stringContaining('root') });
  });
});

describe('runCollectionMatches', () => {
  it('matches each borrower once and stops a parent at its loan count', async () => {
    const rec = { sims: [], sends: [] } as Recorded;
    const p = parent(1, {}, { loansLeft: 2 });
    const bs = [borrower(10, 1n), borrower(11, 2n), borrower(12, 3n)];
    const r = await runCollectionMatches(args([p], bs, io(() => ({ ok: true }), rec)));
    expect(r.submits).toBe(2);
    expect(rec.sends).toHaveLength(2);
    expect(p.loansLeft).toBe(0);
    expect(bs.filter((b) => b.amountFilled === 100n)).toHaveLength(2);
  });

  it('gives parents turns, so one parent cannot spend the whole budget', async () => {
    const rec = { sims: [], sends: [] } as Recorded;
    const a = parent(1);
    const b = parent(2, {}, { offer: { creator: addr(0x2e4d) } });
    const bs = Array.from({ length: 6 }, (_, i) => borrower(10 + i, BigInt(i)));
    await runCollectionMatches(args([a, b], bs, io(() => ({ refused: 'LTVExceeded' }), rec), { maxSims: 4 }));
    const byParent = rec.sims.map((s) => s.split(':')[0]);
    expect(byParent.filter((x) => x === '1')).toHaveLength(2);
    expect(byParent.filter((x) => x === '2')).toHaveLength(2);
  });

  it('caps the simulations one parent may use', async () => {
    const rec = { sims: [], sends: [] } as Recorded;
    const bs = Array.from({ length: 20 }, (_, i) => borrower(10 + i, BigInt(i)));
    await runCollectionMatches(args([parent(1)], bs, io(() => ({ refused: 'LTVExceeded' }), rec)));
    expect(rec.sims).toHaveLength(MAX_TRIES_PER_PARENT);
  });

  it('ends a parent on a refusal about the parent, and moves on after one about the pair', async () => {
    const rec = { sims: [], sends: [] } as Recorded;
    const bs = [borrower(10, 1n), borrower(11, 2n), borrower(12, 3n)];
    await runCollectionMatches(
      args([parent(1)], bs, io(() => ({ refused: 'CollectionTakeRefused', takeFailure: TakeFailure.Expired }), rec)),
    );
    expect(rec.sims).toEqual(['1:10']);
    const rec2 = { sims: [], sends: [] } as Recorded;
    await runCollectionMatches(
      args([parent(1)], bs, io(() => ({ refused: 'CollectionTakeRefused', takeFailure: TakeFailure.NotInSet }), rec2)),
    );
    expect(rec2.sims).toHaveLength(3);
  });

  it('stops the step on spent capacity or a switched-off matcher', async () => {
    const rec = { sims: [], sends: [] } as Recorded;
    const r = await runCollectionMatches(
      args([parent(1), parent(2)], [borrower(10, 1n), borrower(11, 2n)], io(() => ({ refused: 'ServiceCapacityExhausted' }), rec)),
    );
    expect(r.capacitySpent).toBe(true);
    expect(rec.sims).toHaveLength(1);
    const rec2 = { sims: [], sends: [] } as Recorded;
    await runCollectionMatches(
      args([parent(1), parent(2)], [borrower(10, 1n)], io(() => ({ refused: 'FunctionDisabled' }), rec2)),
    );
    expect(rec2.sims).toHaveLength(1);
  });

  it('marks the borrower uncertain and leaves the parent after a send that did not land', async () => {
    const rec = { sims: [], sends: [] } as Recorded;
    const uncertain = new Set<string>();
    await runCollectionMatches(
      args([parent(1)], [borrower(10, 1n), borrower(11, 2n)], io(() => ({ ok: true }), rec, new Map(), false), {
        uncertainBorrowers: uncertain,
      }),
    );
    expect(rec.sends).toEqual(['1:10']);
    expect([...uncertain]).toEqual(['10']);
  });

  it('passes over borrowers already in flight and parents with no loans left', async () => {
    const rec = { sims: [], sends: [] } as Recorded;
    await runCollectionMatches(
      args([parent(1), parent(2, {}, { loansLeft: 0 })], [borrower(10, 1n), borrower(11, 2n)], io(() => ({ ok: true }), rec), {
        uncertainBorrowers: new Set(['10']),
      }),
    );
    expect(rec.sims).toEqual(['1:11']);
  });

  it('proves listed tokens and leaves a listed set whose list it does not hold', async () => {
    const ids = [3n, 5n, 8n];
    const listed = parent(1, listedSet(ids));
    const unlisted = parent(2, { ...listedSet(ids) }, { offer: { creator: addr(0x2e4d) } });
    const seen: { id: string; proof: readonly Hex[] }[] = [];
    const lists = new Map<bigint, ListState>([[1n, { ids }], [2n, { missing: 'its list is kept as a file' }]]);
    const lines: string[] = [];
    await runCollectionMatches({
      ...args([listed, unlisted], [borrower(10, 5n), borrower(11, 6n)], {
        lists: async () => lists,
        simulate: async (p, b, proof) => {
          seen.push({ id: `${p.offer.id}:${b.id}`, proof });
          return { refused: 'LTVExceeded' };
        },
        submit: async () => false,
      }),
      log: (l: string) => lines.push(l),
    });
    expect(seen.map((s) => s.id)).toEqual(['1:10']);
    expect(processProof(seen[0].proof, collateralSetLeaf(5n))).toBe(listed.set.root);
    expect(lines.some((l) => l.includes('offer 2 left alone'))).toBe(true);
  });

  it('respects the budget it is handed', async () => {
    const rec = { sims: [], sends: [] } as Recorded;
    const bs = [borrower(10, 1n), borrower(11, 2n)];
    expect((await runCollectionMatches(args([parent(1)], bs, io(() => ({ ok: true }), rec), { maxSubmits: 0 }))).sims).toBe(0);
    const r = await runCollectionMatches(args([parent(1)], bs, io(() => ({ ok: true }), rec), { maxSubmits: 1 }));
    expect(r.submits).toBe(1);
  });
});

describe('reading collection offers', () => {
  it('lifts a getCollectionOffer answer, and none for an ordinary offer', () => {
    const o = offer(1, LENDER, 0);
    const set = { kind: 2, listCount: 0, low: 5n, high: 9n, root: `0x${'00'.repeat(32)}`, listHash: `0x${'00'.repeat(32)}`, label: '', exclusions: [7n] };
    expect(liftCollectionOffer(o, [set, 100n, 5, 2])).toEqual({
      offer: o,
      set: { kind: 2, low: 5n, high: 9n, root: set.root, listCount: 0, exclusions: [7n] },
      perLoan: 100n,
      loansLeft: 3,
    });
    expect(liftCollectionOffer(o, [{ ...set, kind: 0 }, 0n, 0, 0])).toBeNull();
  });

  it('reads published ids from the event ledger, and says why a list is missing', async () => {
    expect(publishedIdsFromArgs({ publishedIds: ['7', 9] })).toEqual([7n, 9n]);
    expect(publishedIdsFromArgs({})).toBeNull();
    const ledger: EventLedger = {
      matching: async () => [
        { kind: 'CollectionOfferCreated', args: { offerId: '1', publishedIds: ['3', '5'] }, blockAt: 0, block: 1, log: 0, tx: '0x' },
        { kind: 'CollectionOfferCreated', args: { offerId: '2', publishedIds: [] }, blockAt: 0, block: 1, log: 1, tx: '0x' },
      ],
      page: async () => null,
    };
    const ps = [parent(1), parent(2), parent(3)];
    const lists = await readPublishedLists(ledger, 1, ps);
    expect(lists.get(1n)).toEqual({ ids: [3n, 5n] });
    expect(lists.get(2n)).toEqual({ missing: expect.stringContaining('file') });
    expect(lists.get(3n)).toEqual({ missing: expect.stringContaining('not in the ledger') });
    const unread = await readPublishedLists({ matching: async () => null, page: async () => null }, 1, ps);
    expect(unread.get(1n)).toEqual({ missing: expect.stringContaining('could not be read') });
  });
});

describe('the ordinary walk buckets NFT legs by token', () => {
  it('keeps a lender offer on one token apart from a borrower offer on another', () => {
    const { lenders, borrowers } = partitionByBucket([
      offer(1, LENDER, 0, { collateralTokenId: 7n }),
      borrower(10, 7n),
      borrower(11, 8n),
    ]);
    const lenderKey = [...lenders.keys()][0];
    expect(borrowers.get(lenderKey)?.map((b) => b.id)).toEqual([10n]);
  });
});
