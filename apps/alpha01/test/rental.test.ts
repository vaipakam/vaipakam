import {
  ASSET_TYPE_ERC721,
  OFFER_TYPE_BORROWER,
  OFFER_TYPE_LENDER,
  computeRentalPrepayWei,
  filterBorrowerNftRentalDemands,
  filterLenderNftOffersForRent,
  isNftRentalLoan,
  isNftRentalOffer,
  rentalPrepayForOffer,
  toNftRentalBorrowerDemandPayload,
  toNftRentalLenderPayload,
  type IndexedOffer,
} from '@vaipakam/defi-client';
import { describe, expect, it } from 'vitest';

function baseOffer(overrides: Partial<IndexedOffer> = {}): IndexedOffer {
  return {
    offerId: 1,
    chainId: 84532,
    status: 'active',
    offerType: OFFER_TYPE_LENDER,
    assetType: ASSET_TYPE_ERC721,
    collateralAssetType: 0,
    lendingAsset: '0x1111',
    collateralAsset: '0x2222',
    amount: '10000000',
    amountMax: '10000000',
    interestRateBps: 0,
    interestRateBpsMax: 0,
    collateralAmount: '0',
    collateralQuantity: '0',
    durationDays: 7,
    tokenId: '42',
    quantity: '1',
    prepayAsset: '0x3333',
    creator: '0xabc',
    useFullTermInterest: false,
    creatorRiskAndTermsConsent: true,
    allowsPartialRepay: false,
    ...overrides,
  } as IndexedOffer;
}

describe('rental prepay math', () => {
  it('computes daily × days × (1 + buffer)', () => {
    const daily = 10_000_000n;
    expect(computeRentalPrepayWei(daily, 7, 500)).toBe(73_500_000n);
  });

  it('maps offer rows to total prepay', () => {
    expect(rentalPrepayForOffer(baseOffer(), 500)).toBe(73_500_000n);
  });
});

describe('nft rental filters', () => {
  it('keeps lender NFT listings for browse', () => {
    const pool = [
      baseOffer(),
      baseOffer({ offerId: 2, assetType: 0 }),
      baseOffer({ offerId: 3, offerType: OFFER_TYPE_BORROWER }),
    ];
    expect(filterLenderNftOffersForRent(pool).map((o) => o.offerId)).toEqual([1]);
  });

  it('keeps borrower rental demands', () => {
    const pool = [
      baseOffer({ offerId: 10, offerType: OFFER_TYPE_BORROWER }),
      baseOffer({ offerId: 11, assetType: 0, offerType: OFFER_TYPE_BORROWER }),
    ];
    expect(filterBorrowerNftRentalDemands(pool).map((o) => o.offerId)).toEqual([10]);
  });
});

describe('nft rental payload', () => {
  it('builds lender listing with scaled daily fee', () => {
    const payload = toNftRentalLenderPayload(
      {
        nftAssetKind: 'erc721',
        nftContract: '0x00000000000000000000000000000000000000a1',
        tokenId: '42',
        quantity: '1',
        dailyFee: '10',
        prepayAsset: '0x00000000000000000000000000000000000000b2',
        durationDays: '7',
        riskAndTermsConsent: true,
      },
      { lending: 6 },
    );
    expect(payload.amount).toBe(10_000_000n);
    expect(payload.assetType).toBe(1);
    expect(payload.tokenId).toBe(42n);
  });

  it('rejects ERC-1155 quantity greater than 1', () => {
    const base = {
      nftAssetKind: 'erc1155' as const,
      nftContract: '0x00000000000000000000000000000000000000a1',
      tokenId: '42',
      quantity: '2',
      dailyFee: '10',
      prepayAsset: '0x00000000000000000000000000000000000000b2',
      durationDays: '7',
      riskAndTermsConsent: true,
    };
    expect(() => toNftRentalLenderPayload(base, { lending: 6 })).toThrow(/quantity 1 only/);
    expect(() =>
      toNftRentalBorrowerDemandPayload(
        { ...base, maxDailyFee: base.dailyFee },
        { lending: 6 },
      ),
    ).toThrow(/quantity 1 only/);
  });
});

describe('rental loan detection', () => {
  it('detects NFT principal loans', () => {
    expect(isNftRentalOffer(baseOffer())).toBe(true);
    expect(isNftRentalLoan({ assetType: ASSET_TYPE_ERC721 })).toBe(true);
    expect(isNftRentalLoan({ assetType: 0 })).toBe(false);
  });
});