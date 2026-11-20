import { describe, expect, it } from 'vitest';
import {
  checkTakeoverTerms,
  maxTakeoverDays,
  takeoverRequestExpiry,
  takeoverScope,
  toTakeoverOfferPayload,
  type TakeoverSourceLoan,
} from './takeoverRequest';

const DAY = 86_400n;
const loan: TakeoverSourceLoan = {
  status: 0,
  principal: 1_000n * 10n ** 6n,
  principalAsset: '0x00000000000000000000000000000000000000a1',
  assetType: 0,
  collateralAsset: '0x00000000000000000000000000000000000000c1',
  collateralAssetType: 0,
  collateralAmount: 5n * 10n ** 17n,
  prepayAsset: '0x00000000000000000000000000000000000000a1',
  allowsPartialRepay: true,
  useFullTermInterest: false,
};
const now = 1_800_000_000n;
const maturity = now + 10n * DAY + 3_600n;

describe('takeover request rules (#3845)', () => {
  it('offers whole days that end by the due date', () => {
    expect(maxTakeoverDays(maturity, now)).toBe(10);
    expect(maxTakeoverDays(now + DAY - 1n, now)).toBe(0);
    expect(maxTakeoverDays(now - 1n, now)).toBe(0);
  });

  it('expires the request when its term no longer fits', () => {
    expect(takeoverRequestExpiry(maturity, 10)).toBe(now + 3_600n);
    // At the expiry, now + term lands exactly on the due date: still usable.
    const exp = takeoverRequestExpiry(maturity, 4);
    expect(exp + 4n * DAY).toBe(maturity);
  });

  it('scopes the form to ERC-20 loans with ERC-20 collateral and term left', () => {
    expect(takeoverScope(loan, maturity, now)).toBeNull();
    expect(takeoverScope({ ...loan, status: 1 }, maturity, now)).toBe('not-active');
    expect(takeoverScope({ ...loan, assetType: 1 }, maturity, now)).toBe('rental');
    expect(takeoverScope({ ...loan, collateralAssetType: 1 }, maturity, now)).toBe('nft-collateral');
    expect(takeoverScope(loan, now + DAY - 1n, now)).toBe('no-term-left');
  });

  it('refuses terms the handover would refuse', () => {
    const ok = { rateBps: 800, durationDays: 10, collateralAmount: loan.collateralAmount };
    expect(checkTakeoverTerms(loan, ok, maturity, now)).toBeNull();
    expect(checkTakeoverTerms(loan, { ...ok, durationDays: 11 }, maturity, now)).toBe('duration');
    expect(checkTakeoverTerms(loan, { ...ok, durationDays: 0 }, maturity, now)).toBe('duration');
    expect(checkTakeoverTerms(loan, { ...ok, rateBps: 10_001 }, maturity, now)).toBe('rate');
    expect(
      checkTakeoverTerms(loan, { ...ok, collateralAmount: loan.collateralAmount - 1n }, maturity, now),
    ).toBe('collateral-short');
  });

  it('builds an all-or-nothing request for exactly the principal, with the loan assets', () => {
    const p = toTakeoverOfferPayload(loan, {
      rateBps: 750,
      durationDays: 7,
      collateralAmount: loan.collateralAmount + 1n,
      expiresAt: takeoverRequestExpiry(maturity, 7),
      consent: true,
    });
    expect(p.offerType).toBe(1);
    expect(p.amount).toBe(loan.principal);
    expect(p.amountMax).toBe(loan.principal);
    expect(p.interestRateBps).toBe(750);
    expect(p.interestRateBpsMax).toBe(750);
    expect(p.collateralAmount).toBe(loan.collateralAmount + 1n);
    expect(p.collateralAmountMax).toBe(loan.collateralAmount + 1n);
    expect(p.lendingAsset).toBe(loan.principalAsset);
    expect(p.collateralAsset).toBe(loan.collateralAsset);
    expect(p.prepayAsset).toBe(loan.prepayAsset);
    expect(p.fillMode).toBe(1);
    expect(p.allowsParallelSale).toBe(false);
    expect(p.refinanceTargetLoanId).toBe(0n);
    expect(p.expiresAt).toBe(maturity - 7n * DAY);
    expect(p.creatorRiskAndTermsConsent).toBe(true);
  });
});
