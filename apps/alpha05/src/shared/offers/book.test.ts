import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';
import { bookRowFrom, inBook, lapsed, readBookPage, type BookRow } from './book';
import { BORROWER, LENDER, TLIQ, WETH } from './testOffer';

const ZERO = '0x0000000000000000000000000000000000000000';

/** One row as the indexer answers `/offers/active` (amounts as text). */
function json(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    offerId: 12,
    status: 'active',
    creator: LENDER,
    offerType: 0,
    lendingAsset: WETH,
    collateralAsset: TLIQ,
    assetType: 0,
    collateralAssetType: 0,
    tokenId: '0',
    collateralTokenId: '0',
    collateralQuantity: '0',
    amount: '1000',
    amountMax: '2000',
    amountFilled: '0',
    interestRateBps: 500,
    interestRateBpsMax: 900,
    collateralAmount: '5000',
    durationDays: 30,
    prepayAsset: ZERO,
    expiresAt: 0,
    isSaleVehicle: false,
    isOffsetVehicle: false,
    refinanceTargetLoanId: null,
    positionFlow: null,
    ...over,
  };
}

function indexer(answer: unknown): IndexerClient & { paths: string[] } {
  const paths: string[] = [];
  return {
    origin: 'https://index.test',
    paths,
    getJson: async <T>(path: string) => {
      paths.push(path);
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
}

describe('the offer book', () => {
  it('reads a row with every amount exact and names what it is for', () => {
    const r = bookRowFrom(json({ amount: '123456789012345678901234567890' }));
    expect(r.id).toBe(12n);
    expect(r.amount).toBe(123456789012345678901234567890n);
    // A lender's offer is never a refinance request, read or not.
    expect(r.kind).toBe('plain');
    expect(bookRowFrom(json({ offerType: 1, creator: BORROWER })).kind).toBe('refinance-unknown');
    expect(bookRowFrom(json({ offerType: 1, refinanceTargetLoanId: 0 })).kind).toBe('plain');
    expect(bookRowFrom(json({ offerType: 1, refinanceTargetLoanId: 4 })).kind).toBe('refinance');
    expect(bookRowFrom(json({ offerType: 1, isSaleVehicle: true })).kind).toBe('loan-sale');
    expect(bookRowFrom(json({ isOffsetVehicle: true })).kind).toBe('offset');
  });
  it('states a moved position only when the index says so', () => {
    expect(bookRowFrom(json({ positionFlow: { movedSinceOpened: true } })).moved).toBe(true);
    expect(bookRowFrom(json({ positionFlow: { movedSinceOpened: null } })).moved).toBeNull();
    expect(bookRowFrom(json({ positionFlow: undefined })).moved).toBeNull();
  });
  it('keeps a request’s collateral ceiling, unknown when the index has not read it', () => {
    expect(bookRowFrom(json({ offerType: 1, collateralAmountMax: '9000' })).collateralAmountMax).toBe(9000n);
    expect(bookRowFrom(json({ offerType: 1, collateralAmountMax: null })).collateralAmountMax).toBeNull();
    expect(bookRowFrom(json({ offerType: 0, collateralAmount: '5', collateralAmountMax: null })).collateralAmountMax).toBe(5n);
  });
  it('shows an address the index stored lowercased in checksum form', () => {
    expect(bookRowFrom(json({ creator: LENDER.toLowerCase() })).creator).toBe(getAddress(LENDER));
  });
  it('refuses a row it cannot read rather than guessing a field', () => {
    expect(() => bookRowFrom(json({ amount: '-1' }))).toThrow();
    expect(() => bookRowFrom(json({ creator: 'nobody' }))).toThrow();
    expect(() => bookRowFrom(json({ durationDays: 1.5 }))).toThrow();
  });
  it('counts unreadable rows and carries where the next page starts', async () => {
    const ix = indexer({ offers: [json(), json({ offerId: 'x' }), json({ offerId: 9 })], nextBefore: 9 });
    const page = await readBookPage(ix, 84532, null, 3);
    expect(page.rows.map((r) => r.id)).toEqual([12n, 9n]);
    expect(page.unread).toBe(1);
    expect(page.nextBefore).toBe('9');
    expect(ix.paths[0]).toBe('/offers/active?chainId=84532&limit=3');
    await readBookPage(ix, 84532, '9', 3);
    expect(ix.paths[1]).toBe('/offers/active?chainId=84532&limit=3&before=9');
  });
  it('throws on a failed read or an answer without a list, never returning an empty book', async () => {
    await expect(readBookPage(indexer(new IndexerUnavailable('network', 'down')), 1, null)).rejects.toBeInstanceOf(IndexerUnavailable);
    await expect(readBookPage(indexer({ error: 'active-failed' }), 1, null)).rejects.toThrow();
    expect((await readBookPage(indexer({ offers: [], nextBefore: null }), 1, null)).nextBefore).toBeNull();
  });
  it('filters by tab, side and the wallet’s own offers', () => {
    const lend = bookRowFrom(json());
    const ask = bookRowFrom(json({ offerId: 2, offerType: 1, creator: BORROWER }));
    const rental: BookRow = { ...lend, id: 3n, assetType: 1 };
    const rows = [lend, ask, rental];
    const ids = (f: Parameters<typeof inBook>[1]) => rows.filter((r) => inBook(r, f)).map((r) => r.id);
    expect(ids({ tab: 'loans', side: 'all', hide: null })).toEqual([12n, 2n]);
    expect(ids({ tab: 'rentals', side: 'all', hide: null })).toEqual([3n]);
    expect(ids({ tab: 'loans', side: 'lender', hide: null })).toEqual([12n]);
    expect(ids({ tab: 'loans', side: 'borrower', hide: null })).toEqual([2n]);
    expect(ids({ tab: 'loans', side: 'all', hide: LENDER.toUpperCase().replace('0X', '0x') as `0x${string}` })).toEqual([2n]);
  });
  it('calls an offer lapsed once its expiry has passed, and never one with none', () => {
    expect(lapsed({ expiresAt: 0n }, 2_000_000_000)).toBe(false);
    expect(lapsed({ expiresAt: 100n }, 100)).toBe(true);
    expect(lapsed({ expiresAt: 101n }, 100.9)).toBe(false);
  });
});
