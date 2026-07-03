import { describe, expect, it } from 'vitest';
import { parseInterestBps, toBorrowerOfferPayload, toCreateOfferPayload } from '@vaipakam/defi-client';

const baseForm = {
  offerType: 'lender' as const,
  assetType: 'erc20' as const,
  lendingAsset: '0x0000000000000000000000000000000000000001',
  amount: '100',
  interestRate: '5',
  collateralAsset: '0x0000000000000000000000000000000000000002',
  collateralAmount: '1',
  durationDays: '30',
  riskAndTermsConsent: true,
};

describe('parseInterestBps', () => {
  it('rejects rates above the protocol cap', () => {
    expect(() => parseInterestBps('100.01')).toThrow(/protocol cap/);
    expect(parseInterestBps('100')).toBe(10_000n);
  });
});

describe('toCreateOfferPayload', () => {
  it('uses ABI field names and partial fill for lender ERC-20 offers', () => {
    const payload = toCreateOfferPayload(baseForm, { lending: 6, collateral: 18 });
    expect(payload).toMatchObject({
      creatorRiskAndTermsConsent: true,
      allowsPrepayListing: false,
      fillMode: 0,
    });
    expect(payload).not.toHaveProperty('riskAndTermsConsent');
    expect(payload.amount).toBeLessThan(payload.amountMax);
  });

  it('uses AON fill mode for borrower single-value offers', () => {
    const payload = toBorrowerOfferPayload(
      { ...baseForm, offerType: 'borrower', interestRate: '8' },
      { lending: 6, collateral: 18 },
    );
    expect(payload.fillMode).toBe(1);
    expect(payload.amount).toBe(payload.amountMax);
    expect(payload.creatorRiskAndTermsConsent).toBe(true);
  });
});