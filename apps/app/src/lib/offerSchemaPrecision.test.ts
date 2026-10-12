/** #2390 — offer amounts scale exactly: excess precision is a named
 *  validation error and the payload builder refuses it, never rounds. */
import { describe, expect, it } from 'vitest';
import {
  OfferAmountError,
  initialOfferForm,
  toCreateOfferPayload,
  validateOfferForm,
  type OfferFormState,
} from './offerSchema';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const form = (over: Partial<OfferFormState> = {}): OfferFormState => ({
  ...initialOfferForm,
  lendingAsset: A,
  collateralAsset: B,
  amount: '100',
  collateralAmount: '1',
  interestRate: '5',
  riskAndTermsConsent: true,
  ...over,
});

describe('validateOfferForm — precision (#2390)', () => {
  it('names a lending amount finer than the token', () => {
    expect(
      validateOfferForm(form({ amount: '1.0000001' }), { decimals: { lending: 6 } }),
    ).toEqual({ code: 'amountTooPrecise', decimals: 6 });
  });
  it('names a collateral amount finer than the token', () => {
    expect(
      validateOfferForm(form({ collateralAmount: '0.6' }), {
        decimals: { lending: 6, collateral: 0 },
      }),
    ).toEqual({ code: 'collateralTooPrecise', decimals: 0 });
  });
  it('passes amounts within precision, and skips the check when decimals are unknown', () => {
    expect(validateOfferForm(form({ amount: '1.5' }), { decimals: { lending: 6 } })).toBeNull();
    expect(validateOfferForm(form({ amount: '1.0000001' }))).toBeNull();
  });
});

describe('toCreateOfferPayload — exact scaling (#2390)', () => {
  it('scales within precision exactly', () => {
    const p = toCreateOfferPayload(form({ amount: '2.5', collateralAmount: '3' }), {
      lending: 6,
      collateral: 18,
    });
    expect(p.amountMax).toBe(2_500_000n);
    expect(p.collateralAmount).toBe(3n * 10n ** 18n);
  });
  it('refuses rather than rounds a too-precise amount', () => {
    expect(() =>
      toCreateOfferPayload(form({ amount: '0.0000009' }), { lending: 6, collateral: 18 }),
    ).toThrow(OfferAmountError);
    expect(() =>
      toCreateOfferPayload(form({ collateralAmount: '0.6' }), { lending: 6, collateral: 0 }),
    ).toThrow(OfferAmountError);
  });
});
