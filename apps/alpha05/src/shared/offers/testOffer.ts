import { ZERO_ADDRESS, OFFER_LENDER, type StoredOffer } from './acceptTerms';

type Hex = `0x${string}`;

export const LENDER: Hex = '0x1111111111111111111111111111111111111111';
export const BORROWER: Hex = '0x2222222222222222222222222222222222222222';
export const WETH: Hex = '0x4200000000000000000000000000000000000006';
export const TLIQ: Hex = '0x3333333333333333333333333333333333333333';

/** A stored lender offer for unit tests, overridable field by field. */
export function offer(over: Partial<StoredOffer> = {}): StoredOffer {
  return {
    id: 7n,
    creator: LENDER,
    offerType: OFFER_LENDER,
    assetType: 0,
    collateralAssetType: 0,
    lendingAsset: WETH,
    collateralAsset: TLIQ,
    amount: 1n * 10n ** 18n,
    amountMax: 2n * 10n ** 18n,
    amountFilled: 0n,
    interestRateBps: 500n,
    interestRateBpsMax: 900n,
    collateralAmount: 5000n * 10n ** 18n,
    durationDays: 30n,
    tokenId: 0n,
    collateralTokenId: 0n,
    quantity: 0n,
    collateralQuantity: 0n,
    prepayAsset: ZERO_ADDRESS,
    useFullTermInterest: false,
    allowsPartialRepay: true,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    parallelSaleOrderHash: `0x${'00'.repeat(32)}`,
    periodicInterestCadence: 0,
    expiresAt: 0n,
    accepted: false,
    ...over,
  };
}
