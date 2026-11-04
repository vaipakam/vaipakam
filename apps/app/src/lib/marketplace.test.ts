import { describe, it, expect } from 'vitest';
import type { IndexedLoan, IndexedOffer, RecentLoansPage } from '../data/indexer';
import { marketplaceOffers, marketplaceRemaining, verifiedMarketplaceHistory, type MarketplaceSelection } from './marketplace';

const selection: MarketplaceSelection = {
  chainId: 1, side: 'lender', lendingAsset: '0xAA', collateralAsset: '0xBB', durationDays: null,
};
const offer = (id: number, patch: Partial<IndexedOffer> = {}): IndexedOffer => ({
  chainId: 1, offerId: id, status: 'active', offerType: 1,
  lendingAsset: '0xaa', collateralAsset: '0xbb', assetType: 0, collateralAssetType: 0,
  amount: '100', amountMax: '100', amountFilled: '0',
  interestRateBps: 100, interestRateBpsMax: 900, durationDays: 30,
  ...patch,
} as IndexedOffer);
const page = (patch: Partial<RecentLoansPage> = {}): RecentLoansPage => ({
  chainId: 1, loans: [], nextBefore: null,
  scope: { lendingAsset: '0xaa', collateralAsset: '0xbb', durationDays: null, placement: null, excludeSaleVehicles: true },
  ...patch,
});

describe('marketplace offer discovery', () => {
  it('shows borrower ceilings descending for a lender without mutating source', () => {
    const rows = [offer(1, { interestRateBpsMax: 500 }), offer(2), offer(3, { offerType: 0 })];
    expect(marketplaceOffers(rows, selection, 100).map((o) => o.offerId)).toEqual([2, 1]);
    expect(rows.map((o) => o.offerId)).toEqual([1, 2, 3]);
  });
  it('shows lender floors ascending for a borrower, including zero APR', () => {
    const rows = [offer(1, { offerType: 0, interestRateBps: 500 }), offer(2, { offerType: 0, interestRateBps: 0 }), offer(3)];
    expect(marketplaceOffers(rows, { ...selection, side: 'borrower' }, 100).map((o) => o.offerId)).toEqual([2, 1]);
  });
  it('excludes wrong networks, assets, lifecycle states, NFT and bookkeeping rows', () => {
    const patches: Partial<IndexedOffer>[] = [
      { chainId: 2 }, { lendingAsset: '0xcc' }, { collateralAsset: '0xcc' },
      { status: 'accepted' }, { assetType: 1 }, { collateralAssetType: 1 },
      { isSaleVehicle: true }, { isOffsetVehicle: true }, { amountFilled: '100' },
      { amountMax: 'malformed' },
    ];
    expect(marketplaceOffers(patches.map((patch, id) => offer(id, patch)), selection, 100)).toEqual([]);
  });
  it('expires at the boundary, keeps no-expiry rows, and filters duration', () => {
    const rows = [offer(1, { expiresAt: 100 }), offer(2, { expiresAt: 101 }), offer(3, { expiresAt: 0, durationDays: 7 })];
    expect(marketplaceOffers(rows, selection, 100).map((o) => o.offerId)).toEqual([3, 2]);
    expect(marketplaceOffers(rows, { ...selection, durationDays: 7 }, 100).map((o) => o.offerId)).toEqual([3]);
  });
  it('uses exact remaining base units for the minimum size', () => {
    const rows = [offer(1, { amountMax: '90071992547409930', amountFilled: '1' }), offer(2, { amountMax: '90071992547409930' })];
    expect(marketplaceOffers(rows, { ...selection, minimumAmount: 90071992547409930n }, 100).map((o) => o.offerId)).toEqual([2]);
  });
  it('includes an unfilled borrower range when the size filter exceeds its match floor', () => {
    const row = offer(1, { amount: '100', amountMax: '1000' });
    expect(marketplaceRemaining(row)).toEqual(1000n);
    expect(marketplaceOffers([row], { ...selection, minimumAmount: 500n }, 100)).toEqual([row]);
  });
  it('keeps borrower liquidity after fills reach the match floor and respects the remaining boundary', () => {
    const row = offer(1, { amount: '100', amountMax: '1000', amountFilled: '100' });
    expect(marketplaceRemaining(row)).toEqual(900n);
    expect(marketplaceOffers([row], { ...selection, minimumAmount: 900n }, 100)).toEqual([row]);
    expect(marketplaceOffers([row], { ...selection, minimumAmount: 901n }, 100)).toEqual([]);
    expect(marketplaceOffers([{ ...row, amountFilled: '1000' }], selection, 100)).toEqual([]);
  });
  it('uses the same ceiling rule for lender ranges', () => {
    const row = offer(1, { offerType: 0, amount: '100', amountMax: '1000', amountFilled: '100' });
    expect(marketplaceRemaining(row)).toEqual(900n);
    expect(marketplaceOffers([row], { ...selection, side: 'borrower', minimumAmount: 900n }, 100)).toEqual([row]);
    expect(marketplaceOffers([row], { ...selection, side: 'borrower', minimumAmount: 901n }, 100)).toEqual([]);
  });
});

describe('marketplace history provenance', () => {
  it('distinguishes a verified empty pair from an unavailable or old unscoped response', () => {
    expect(verifiedMarketplaceHistory(page(), selection)?.loans).toEqual([]);
    expect(verifiedMarketplaceHistory(null, selection)).toBeNull();
    expect(verifiedMarketplaceHistory(page({ scope: undefined }), selection)).toBeNull();
    expect(verifiedMarketplaceHistory(page({ chainId: 2 }), selection)).toBeNull();
    expect(verifiedMarketplaceHistory(page({ scope: { ...page().scope!, collateralAsset: '0xcc' } }), selection)).toBeNull();
    expect(verifiedMarketplaceHistory(page({ scope: { ...page().scope!, durationDays: 30 } }), selection)).toBeNull();
  });
  it('rejects mismatched rows and sales even when the server echoes the scope', () => {
    const row = { chainId: 2, lendingAsset: '0xaa', collateralAsset: '0xbb', assetType: 0, collateralAssetType: 0 } as IndexedLoan;
    expect(verifiedMarketplaceHistory(page({ loans: [row] }), selection)).toBeNull();
    expect(verifiedMarketplaceHistory(page({ loans: [{ ...row, chainId: 1, isSaleVehicle: true }] }), selection)).toBeNull();
  });
  it('sorts loan IDs without inventing missing original amounts or terms', () => {
    const row = { chainId: 1, loanId: 1, lendingAsset: '0xaa', collateralAsset: '0xbb', assetType: 0, collateralAssetType: 0 } as IndexedLoan;
    const result = verifiedMarketplaceHistory(page({ loans: [row, { ...row, loanId: 2 }] }), selection);
    expect(result?.loans.map((loan) => loan.loanId)).toEqual([2, 1]);
    expect(result?.loans[0].initPrincipal).toBeUndefined();
    expect(result?.loans[0].initRateBps).toBeUndefined();
  });
});
