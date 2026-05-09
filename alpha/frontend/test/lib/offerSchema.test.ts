import { describe, it, expect } from 'vitest';
import { parseUnits } from 'ethers';
import {
  validateOfferForm,
  isNFTRental,
  toCreateOfferPayload,
  gracePeriodLabel,
  initialOfferForm,
  type OfferFormState,
} from '../../src/lib/offerSchema';

const GOOD_ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BAD_ADDR = '0xnothex';

function mkForm(over: Partial<OfferFormState> = {}): OfferFormState {
  return {
    ...initialOfferForm,
    lendingAsset: GOOD_ADDR,
    amount: '100',
    interestRate: '5',
    durationDays: '30',
    ...over,
  };
}

describe('validateOfferForm', () => {
  it('rejects a malformed lending address', () => {
    expect(validateOfferForm(mkForm({ lendingAsset: BAD_ADDR }))).toEqual({
      code: 'lendingAssetInvalid',
    });
  });

  it('rejects a missing or non-positive amount', () => {
    expect(validateOfferForm(mkForm({ amount: '' }))).toEqual({ code: 'amountNonPositive' });
    expect(validateOfferForm(mkForm({ amount: '0' }))).toEqual({ code: 'amountNonPositive' });
    expect(validateOfferForm(mkForm({ amount: '-5' }))).toEqual({ code: 'amountNonPositive' });
  });

  it('rejects negative or blank interest rates but allows zero', () => {
    expect(validateOfferForm(mkForm({ interestRate: '' }))).toEqual({ code: 'rateNegative' });
    expect(validateOfferForm(mkForm({ interestRate: '-1' }))).toEqual({ code: 'rateNegative' });
    expect(validateOfferForm(mkForm({ interestRate: '0' }))).toBeNull();
  });

  it('enforces duration bounds [1, 365]', () => {
    expect(validateOfferForm(mkForm({ durationDays: '0' }))).toEqual({
      code: 'durationOutOfRange',
      min: 1,
      max: 365,
    });
    expect(validateOfferForm(mkForm({ durationDays: '366' }))).toEqual({
      code: 'durationOutOfRange',
      min: 1,
      max: 365,
    });
    expect(validateOfferForm(mkForm({ durationDays: 'nope' }))).toEqual({
      code: 'durationOutOfRange',
      min: 1,
      max: 365,
    });
    expect(validateOfferForm(mkForm({ durationDays: '1' }))).toBeNull();
    expect(validateOfferForm(mkForm({ durationDays: '365' }))).toBeNull();
  });

  it('requires a tokenId for NFT rentals (ERC-721 / ERC-1155)', () => {
    expect(
      validateOfferForm(mkForm({ assetType: 'erc721', tokenId: '' })),
    ).toEqual({ code: 'nftTokenIdRequired' });
    expect(
      validateOfferForm(mkForm({ assetType: 'erc1155', tokenId: '' })),
    ).toEqual({ code: 'nftTokenIdRequired' });
    expect(
      validateOfferForm(mkForm({ assetType: 'erc721', tokenId: '42' })),
    ).toBeNull();
  });

  it('validates collateral + prepay addresses when provided', () => {
    expect(
      validateOfferForm(mkForm({ collateralAsset: BAD_ADDR })),
    ).toEqual({ code: 'collateralAssetInvalid' });
    expect(
      validateOfferForm(mkForm({ prepayAsset: BAD_ADDR })),
    ).toEqual({ code: 'prepayAssetInvalid' });
  });

  it('passes a minimally-valid lender-side ERC-20 offer', () => {
    expect(validateOfferForm(mkForm())).toBeNull();
  });
});

describe('isNFTRental', () => {
  it('returns true for erc721 and erc1155', () => {
    expect(isNFTRental('erc721')).toBe(true);
    expect(isNFTRental('erc1155')).toBe(true);
  });
  it('returns false for erc20', () => {
    expect(isNFTRental('erc20')).toBe(false);
  });
});

describe('gracePeriodLabel', () => {
  it('maps duration bands to labels', () => {
    expect(gracePeriodLabel(1)).toBe('1 hour');
    expect(gracePeriodLabel(6)).toBe('1 hour');
    expect(gracePeriodLabel(7)).toBe('1 day');
    expect(gracePeriodLabel(29)).toBe('1 day');
    expect(gracePeriodLabel(30)).toBe('3 days');
    expect(gracePeriodLabel(89)).toBe('3 days');
    expect(gracePeriodLabel(90)).toBe('1 week');
    expect(gracePeriodLabel(179)).toBe('1 week');
    expect(gracePeriodLabel(180)).toBe('2 weeks');
    expect(gracePeriodLabel(365)).toBe('2 weeks');
  });
});

describe('toCreateOfferPayload', () => {
  it('scales ERC-20 amounts by the provided decimals', () => {
    const payload = toCreateOfferPayload(
      mkForm({ amount: '100', collateralAmount: '2.5', collateralAsset: GOOD_ADDR }),
      { lending: 6, collateral: 18 },
    );
    expect(payload.amount).toBe(parseUnits('100', 6));
    expect(payload.collateralAmount).toBe(parseUnits('2.5', 18));
  });

  it('defaults to 18 decimals when not provided', () => {
    const payload = toCreateOfferPayload(mkForm({ amount: '1' }));
    expect(payload.amount).toBe(parseUnits('1', 18));
  });

  it('converts NFT tokenId/quantity as raw BigInt (unscaled)', () => {
    const payload = toCreateOfferPayload(
      mkForm({
        assetType: 'erc721',
        amount: '1',
        tokenId: '42',
        quantity: '1',
      }),
    );
    expect(payload.amount).toBe(1n);
    expect(payload.tokenId).toBe(42n);
    expect(payload.assetType).toBe(1);
  });

  it('encodes ERC-1155 collateral with tokenId+quantity', () => {
    const payload = toCreateOfferPayload(
      mkForm({
        collateralAssetType: 'erc1155',
        collateralAsset: GOOD_ADDR,
        collateralAmount: '7',
        collateralTokenId: '99',
        collateralQuantity: '7',
      }),
    );
    expect(payload.collateralAssetType).toBe(2);
    expect(payload.collateralAmount).toBe(7n);
    expect(payload.collateralTokenId).toBe(99n);
    expect(payload.collateralQuantity).toBe(7n);
  });

  it('converts percent interest rate to BPS, rounding half-up', () => {
    expect(toCreateOfferPayload(mkForm({ interestRate: '5' })).interestRateBps).toBe(500);
    expect(toCreateOfferPayload(mkForm({ interestRate: '12.345' })).interestRateBps).toBe(1235);
    expect(toCreateOfferPayload(mkForm({ interestRate: '0' })).interestRateBps).toBe(0);
  });

  it('maps offer side to the contract enum (lender=0, borrower=1)', () => {
    expect(toCreateOfferPayload(mkForm({ offerType: 'lender' })).offerType).toBe(0);
    expect(toCreateOfferPayload(mkForm({ offerType: 'borrower' })).offerType).toBe(1);
  });

  it('defaults collateral + prepay to the zero address when blank', () => {
    const payload = toCreateOfferPayload(mkForm({ collateralAsset: '', prepayAsset: '' }));
    expect(payload.collateralAsset).toBe('0x0000000000000000000000000000000000000000');
    expect(payload.prepayAsset).toBe('0x0000000000000000000000000000000000000000');
  });

  it('propagates illiquidConsent and keeperAccess flags', () => {
    const payload = toCreateOfferPayload(
      mkForm({ illiquidConsent: true, keeperAccess: true }),
    );
    expect(payload.creatorIlliquidConsent).toBe(true);
    expect(payload.keeperAccessEnabled).toBe(true);
  });

  it('coerces empty collateral/quantity/tokenId strings to 0n', () => {
    const payload = toCreateOfferPayload(
      mkForm({
        collateralAmount: '',
        collateralTokenId: '',
        collateralQuantity: '',
        tokenId: '',
      }),
    );
    expect(payload.collateralAmount).toBe(0n);
    expect(payload.collateralTokenId).toBe(0n);
    expect(payload.collateralQuantity).toBe(0n);
    expect(payload.tokenId).toBe(0n);
  });
});
