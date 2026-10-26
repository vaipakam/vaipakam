/** #2729 — an ERC-20 loan against ERC-20 collateral must post collateral;
 *  the form refuses an empty or zero amount, as the contract does. */
import { describe, expect, it } from 'vitest';
import { initialOfferForm, validateOfferForm, type OfferFormState } from './offerSchema';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const form = (over: Partial<OfferFormState> = {}): OfferFormState => ({
  ...initialOfferForm,
  assetType: 'erc20',
  collateralAssetType: 'erc20',
  lendingAsset: A,
  collateralAsset: B,
  amount: '100',
  collateralAmount: '1',
  interestRate: '5',
  riskAndTermsConsent: true,
  ...over,
});

describe('validateOfferForm — collateral must be positive (#2729)', () => {
  it.each(['', '0', '0.0', '-1', 'abc'])('refuses collateral %j on an ERC-20 pair', (c) => {
    expect(validateOfferForm(form({ collateralAmount: c }))).toEqual({
      code: 'collateralNonPositive',
    });
  });
  it('accepts a positive collateral amount', () => {
    expect(validateOfferForm(form({ collateralAmount: '0.5' }))).toBeNull();
  });
  it('leaves NFT collateral alone: it is locked by token id, not an amount', () => {
    expect(
      validateOfferForm(form({ collateralAssetType: 'erc721', collateralAmount: '' })),
    ).not.toEqual({ code: 'collateralNonPositive' });
  });
});
