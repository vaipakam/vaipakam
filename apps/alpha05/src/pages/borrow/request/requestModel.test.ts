import { describe, expect, it } from 'vitest';
import { bucketsWithin, createParams, DEFAULT_INPUT, durationOk, expiresAt, parseAmount, parseDays, parseRateBps, requestFigures } from './requestModel';

type Hex = `0x${string}`;
const lending = '0x00000000000000000000000000000000000000a1' as Hex;
const collateral = '0x00000000000000000000000000000000000000c1' as Hex;

describe('parseAmount', () => {
  it('reads a typed amount exactly in base units', () => {
    expect(parseAmount('12.5', 18)).toEqual({ ok: true, value: 125n * 10n ** 17n });
    expect(parseAmount(' 3 ', 6)).toEqual({ ok: true, value: 3_000_000n });
    expect(parseAmount('.5', 2)).toEqual({ ok: true, value: 50n });
    expect(parseAmount('7.', 0)).toEqual({ ok: true, value: 7n });
  });
  it('refuses more decimals than the token has, never rounding', () => {
    expect(parseAmount('1.1234567', 6)).toEqual({ ok: false, error: 'decimals' });
    expect(parseAmount('1.5', 0)).toEqual({ ok: false, error: 'decimals' });
  });
  it('names empty, malformed and zero input', () => {
    expect(parseAmount('', 18)).toEqual({ ok: false, error: 'empty' });
    expect(parseAmount('.', 18)).toEqual({ ok: false, error: 'invalid' });
    expect(parseAmount('1,000', 18)).toEqual({ ok: false, error: 'invalid' });
    expect(parseAmount('-1', 18)).toEqual({ ok: false, error: 'invalid' });
    expect(parseAmount('1e3', 18)).toEqual({ ok: false, error: 'invalid' });
    expect(parseAmount('0.000', 18)).toEqual({ ok: false, error: 'zero' });
  });
});

describe('parseRateBps', () => {
  it('reads a yearly percent as basis points, up to 100%', () => {
    expect(parseRateBps('8.5')).toEqual({ ok: true, value: 850n });
    expect(parseRateBps('100')).toEqual({ ok: true, value: 10_000n });
    expect(parseRateBps('100.01')).toEqual({ ok: false, error: 'high' });
    expect(parseRateBps('8.555')).toEqual({ ok: false, error: 'decimals' });
  });
});

describe('terms and expiry', () => {
  it('offers only the buckets inside the live maximum', () => {
    expect(bucketsWithin(90n)).toEqual([7, 14, 30, 60, 90]);
    expect(bucketsWithin(3n)).toEqual([]);
    expect(durationOk(30, 30n)).toBe(true);
    expect(durationOk(31, 30n)).toBe(false);
    expect(durationOk(0, 30n)).toBe(false);
  });
  it('stores never as 0 and a choice as an absolute time', () => {
    expect(expiresAt('never', 1_000n)).toBe(0n);
    expect(expiresAt('7d', 1_000n)).toBe(1_000n + 7n * 86_400n);
    expect(expiresAt('custom', 1_000n, 45)).toBe(1_000n + 45n * 86_400n);
  });
  it('reads typed days as a whole number within the bound', () => {
    expect(parseDays('45', 365)).toEqual({ ok: true, value: 45 });
    expect(parseDays('366', 365)).toEqual({ ok: false, error: 'high' });
    expect(parseDays('1.5', 365)).toEqual({ ok: false, error: 'invalid' });
    expect(parseDays('0', 365)).toEqual({ ok: false, error: 'zero' });
    expect(parseDays(' ', 365)).toEqual({ ok: false, error: 'empty' });
  });
});

describe('createParams', () => {
  it('sends a single-value borrower request with every unoffered option at its default', () => {
    const p = createParams(
      { amount: 10n, collateral: 20n, rateBps: 850n, durationDays: 30, expiry: '7d', fullTerm: DEFAULT_INPUT.fullTerm, allowsPartialRepay: false },
      { lending, collateral, leg: { kind: 'erc20' } },
      99n,
    );
    expect(p.offerType).toBe(1);
    expect([p.amount, p.amountMax]).toEqual([10n, 10n]);
    expect([p.interestRateBps, p.interestRateBpsMax]).toEqual([850n, 850n]);
    expect([p.collateralAmount, p.collateralAmountMax]).toEqual([20n, 20n]);
    expect(p.durationDays).toBe(30n);
    expect(p.expiresAt).toBe(99n);
    expect(p.useFullTermInterest).toBe(true);
    expect([p.periodicInterestCadence, p.allowsPrepayListing, p.allowsParallelSale, p.refinanceTargetLoanId]).toEqual([0, false, false, 0n]);
    expect(p.creatorRiskAndTermsConsent).toBe(true);
  });
});

describe('createParams for an NFT', () => {
  it('names the one ERC-721 token by its id and carries no collateral amount', () => {
    const p = createParams(
      { amount: 10n, collateral: 1n, rateBps: 850n, durationDays: 30, expiry: '7d', fullTerm: true, allowsPartialRepay: false },
      { lending, collateral, leg: { kind: 'erc721', tokenId: 7n } },
      99n,
    );
    expect([p.collateralAssetType, p.collateralTokenId, p.collateralQuantity]).toEqual([1, 7n, 1n]);
    expect([p.collateralAmount, p.collateralAmountMax]).toEqual([0n, 0n]);
    expect([p.assetType, p.amount]).toEqual([0, 10n]);
  });
});

describe('requestFigures', () => {
  it('takes the list fee from the amount and adds the term interest to what is owed', () => {
    const f = requestFigures(1_000_000n, 1_000n, 365, 20n);
    expect(f.fee).toBe(2_000n);
    expect(f.received).toBe(998_000n);
    expect(f.interest).toBe(100_000n);
    expect(f.owedAtDue).toBe(1_100_000n);
  });
});
