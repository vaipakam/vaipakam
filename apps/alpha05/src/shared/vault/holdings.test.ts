import { describe, expect, it } from 'vitest';
import { holdingFigures, holdingSubjects, isDust, isEmpty, positionAssets, readDepositoryAssets, shownRows, type HoldingRow } from './holdings';

type Hex = `0x${string}`;
const A = '0x00000000000000000000000000000000000000a1' as Hex;
const B = '0x00000000000000000000000000000000000000b2' as Hex;
const N = '0x00000000000000000000000000000000000000c3' as Hex;
const ZERO = '0x0000000000000000000000000000000000000000' as Hex;

function row(p: Partial<HoldingRow>): HoldingRow {
  return { standard: 'erc20', asset: A, tokenId: 0n, sources: ['deposit'], inVault: 0n, tracked: 0n, withdrawable: 0n, untracked: 0n, ...p };
}

describe('readDepositoryAssets', () => {
  it('pages to the stated length', async () => {
    const all = [A, B, N];
    const r = await readDepositoryAssets(async (o, l) => [all.slice(Number(o), Number(o + l)), 3n], { page: 2, maxPages: 5 });
    expect(r).toEqual({ assets: all, complete: true });
  });
  it('never reads an empty page before the end as the end', async () => {
    const r = await readDepositoryAssets(async () => [[], 4n], { page: 2, maxPages: 5 });
    expect(r.complete).toBe(false);
  });
  it('says incomplete past the page cap', async () => {
    const r = await readDepositoryAssets(async (o) => [[A], 10n + o], { page: 1, maxPages: 3 });
    expect(r).toEqual({ assets: [A, A, A], complete: false });
  });
  it('an empty list is complete', async () => {
    expect(await readDepositoryAssets(async () => [[], 0n])).toEqual({ assets: [], complete: true });
  });
});

describe('holdingSubjects', () => {
  it('merges the reasons an asset is read, once per asset', () => {
    const { subjects, collections } = holdingSubjects(
      [
        { asset: A, standard: 'erc20' },
        { asset: N, standard: 'erc721' },
      ],
      {
        erc20: [
          { asset: A.toUpperCase().replace('0X', '0x') as Hex, source: 'loan' },
          { asset: B, source: 'offer' },
          { asset: ZERO, source: 'offer' },
        ],
        nfts: [],
        complete: true,
      },
    );
    expect(subjects.map((s) => [s.asset.toLowerCase(), s.sources])).toEqual([
      [A, ['deposit', 'loan']],
      [B, ['offer']],
    ]);
    // A deposited collection no position names: named apart, without figures.
    expect(collections).toEqual([N]);
  });
  it('reads a deposited NFT token a loan names, with the deposit reason', () => {
    const { subjects, collections } = holdingSubjects([{ asset: N, standard: 'erc721' }], {
      erc20: [],
      nfts: [{ standard: 'erc721', asset: N, tokenId: 7n, source: 'loan' }],
      complete: true,
    });
    // Still named: the record keeps no token ids, so another deposited token
    // of the collection may be missing.
    expect(collections).toEqual([N]);
    expect(subjects).toEqual([{ standard: 'erc721', asset: N, tokenId: 7n, sources: ['loan', 'deposit'] }]);
  });
});

describe('positionAssets', () => {
  it('names both legs of a loan and every leg of an offer', () => {
    const p = positionAssets(
      [{ principalAsset: A, assetType: 0, tokenId: 0n, collateralAsset: N, collateralAssetType: 1, collateralTokenId: 3n }],
      [{ lendingAsset: B, assetType: 0, tokenId: 0n, prepayAsset: ZERO, collateralAsset: A, collateralAssetType: 0, collateralTokenId: 0n }],
      false,
    );
    expect(p.erc20).toEqual([
      { asset: A, source: 'loan' },
      { asset: B, source: 'offer' },
      { asset: A, source: 'offer' },
    ]);
    expect(p.nfts).toEqual([{ standard: 'erc721', asset: N, tokenId: 3n, source: 'loan' }]);
    expect(p.complete).toBe(false);
  });
  it('names a rental’s fee asset', () => {
    const p = positionAssets([], [{ lendingAsset: N, assetType: 2, tokenId: 4n, prepayAsset: B, collateralAsset: ZERO, collateralAssetType: 0, collateralTokenId: 0n }], true);
    expect(p.erc20).toEqual([
      { asset: ZERO, source: 'offer' },
      { asset: B, source: 'offer' },
    ]);
    expect(p.nfts).toEqual([{ standard: 'erc1155', asset: N, tokenId: 4n, source: 'offer' }]);
  });
});

describe('holdingFigures', () => {
  it('shows the smaller of held and counted, and the protocol’s free figure', () => {
    const f = holdingFigures(row({ inVault: 120n, tracked: 100n, withdrawable: 40n, untracked: 20n }));
    expect(f).toMatchObject({ counted: 100n, withdrawable: 40n, held: 60n, untracked: 20n, short: false, allHeld: false, unread: false });
  });
  it('says when the vault holds less than the protocol counts', () => {
    const f = holdingFigures(row({ inVault: 90n, tracked: 100n, withdrawable: 90n }));
    expect(f.counted).toBe(90n);
    expect(f.short).toBe(true);
  });
  it('says when every counted unit is held', () => {
    expect(holdingFigures(row({ inVault: 5n, tracked: 5n, withdrawable: 0n })).allHeld).toBe(true);
  });
  it('an unread figure leaves the derived ones unread', () => {
    const f = holdingFigures(row({ withdrawable: null, inVault: 5n, tracked: 5n }));
    expect(f).toMatchObject({ counted: 5n, withdrawable: null, held: null, unread: true, allHeld: false });
  });
  it('any unread figure withholds the free and held figures, even when the free one was read', () => {
    const f = holdingFigures(row({ untracked: null, inVault: 5n, tracked: 5n, withdrawable: 0n }));
    expect(f).toMatchObject({ counted: 5n, withdrawable: null, held: null, unread: true, allHeld: false });
  });
  it('a free figure above the counted one is never turned into a negative held figure', () => {
    expect(holdingFigures(row({ inVault: 5n, tracked: 5n, withdrawable: 6n })).held).toBeNull();
  });
});

describe('dust and empty rows', () => {
  it('dust is above zero and below 1e-11 of a whole token', () => {
    expect(isDust(row({ inVault: 9_999_999n, tracked: 9_999_999n }), 18)).toBe(true);
    expect(isDust(row({ inVault: 10_000_000n, tracked: 10_000_000n }), 18)).toBe(false);
    expect(isDust(row({ inVault: 0n, tracked: 0n }), 18)).toBe(false);
    // Unknown decimals, or too few to go that small: never dust.
    expect(isDust(row({ inVault: 1n, tracked: 1n }), null)).toBe(false);
    expect(isDust(row({ inVault: 1n, tracked: 1n }), 6)).toBe(false);
    // An uncounted balance is never hidden.
    expect(isDust(row({ inVault: 2n, tracked: 1n, untracked: 1n }), 18)).toBe(false);
  });
  it('a row the record still lists after a full withdrawal is empty; an unread one never is', () => {
    expect(isEmpty(row({}))).toBe(true);
    expect(isEmpty(row({ inVault: null }))).toBe(false);
    expect(isEmpty(row({ untracked: 1n, inVault: 1n }))).toBe(false);
  });
  it('hides small and empty rows by default and counts them', () => {
    const rows = [row({ asset: A, inVault: 5n * 10n ** 18n, tracked: 5n * 10n ** 18n }), row({ asset: B }), row({ asset: N, inVault: 1n, tracked: 1n })];
    const d = () => 18;
    expect(shownRows(rows, d, false)).toEqual({ rows: [rows[0]], hidden: 2 });
    expect(shownRows(rows, d, true)).toEqual({ rows, hidden: 2 });
  });
});
