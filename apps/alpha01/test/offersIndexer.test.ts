import {
  ASSET_TYPE_ERC20,
  ASSET_TYPE_ERC721,
  OFFER_TYPE_BORROWER,
  OFFER_TYPE_LENDER,
  filterBorrowerOffersForLend,
  filterLenderOffersForBorrow,
  isAlpha01Erc20Offer,
  isDirectAcceptableOffer,
  matchOffersToBorrowIntent,
  type IndexedOffer,
} from '@vaipakam/defi-client';
import { describe, expect, it } from 'vitest';

function baseOffer(overrides: Partial<IndexedOffer> = {}): IndexedOffer {
  return {
    offerId: 1,
    chainId: 84532,
    status: 'active',
    offerType: OFFER_TYPE_LENDER,
    assetType: ASSET_TYPE_ERC20,
    collateralAssetType: ASSET_TYPE_ERC20,
    lendingAsset: '0x1111',
    collateralAsset: '0x2222',
    amount: '1000',
    amountMax: '1000',
    interestRateBps: 500,
    interestRateBpsMax: 500,
    collateralAmount: '100',
    collateralQuantity: '0',
    durationDays: 30,
    creator: '0xabc',
    ...overrides,
  } as IndexedOffer;
}

describe('isAlpha01Erc20Offer', () => {
  it('accepts ERC-20 principal and collateral', () => {
    expect(isAlpha01Erc20Offer(baseOffer())).toBe(true);
  });

  it('rejects NFT collateral', () => {
    expect(isAlpha01Erc20Offer(baseOffer({ collateralAssetType: ASSET_TYPE_ERC721 }))).toBe(false);
  });
});

describe('isDirectAcceptableOffer', () => {
  it('rejects expired GTT offers', () => {
    expect(isDirectAcceptableOffer(baseOffer({ expiresAt: 1 }), 100)).toBe(false);
  });

  it('rejects partially filled offers', () => {
    expect(isDirectAcceptableOffer(baseOffer({ amountFilled: '1' }))).toBe(false);
  });
});

describe('offer filters', () => {
  it('hides non-ERC20 and stale offers from borrow/lend pickers', () => {
    const lenderPool = [
      baseOffer(),
      baseOffer({ offerId: 2, collateralAssetType: ASSET_TYPE_ERC721 }),
      baseOffer({ offerId: 3, amountFilled: '1' }),
      baseOffer({ offerId: 4, offerType: OFFER_TYPE_BORROWER }),
    ];
    expect(filterLenderOffersForBorrow(lenderPool).map((o) => o.offerId)).toEqual([1]);

    const borrowerPool = [
      baseOffer({ offerId: 10, offerType: OFFER_TYPE_BORROWER }),
      baseOffer({ offerId: 11, offerType: OFFER_TYPE_BORROWER, collateralAssetType: ASSET_TYPE_ERC721 }),
      baseOffer({ offerId: 12, offerType: OFFER_TYPE_BORROWER, amountFilled: '1' }),
    ];
    expect(filterBorrowerOffersForLend(borrowerPool).map((o) => o.offerId)).toEqual([10]);
  });
});

describe('matchOffersToBorrowIntent', () => {
  it('matches only offers whose principal equals the entered borrow amount', () => {
    const pool = [
      baseOffer({ offerId: 1, amount: '500', amountMax: '500' }),
      baseOffer({ offerId: 2, amount: '2000', amountMax: '2000' }),
      baseOffer({ offerId: 3, amount: '1000', amountMax: '1000' }),
    ];
    const matched = matchOffersToBorrowIntent(pool, { minBorrowAmountWei: 1000n });
    expect(matched.map((o) => o.offerId)).toEqual([3]);
  });

  it('treats zero amountMax as absent for legacy lender offers', () => {
    const pool = [baseOffer({ offerId: 9, amount: '1000', amountMax: '0' })];
    const matched = matchOffersToBorrowIntent(pool, { minBorrowAmountWei: 1000n });
    expect(matched.map((o) => o.offerId)).toEqual([9]);
  });
});