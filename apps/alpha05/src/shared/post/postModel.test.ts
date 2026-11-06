import { describe, expect, it } from 'vitest';
import {
  advancedSet,
  bucketsWithin,
  createParams,
  DEFAULT_INPUT,
  durationOk,
  expiresAt,
  fillModeBlock,
  isRanged,
  parseAmount,
  parseDays,
  parseRateBps,
  partCollateral,
  partError,
  rangeError,
  postFigures,
  lenderPostFigures,
  stakeOf,
} from './postModel';

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
      {
        amount: 10n,
        amountMax: 10n,
        collateral: 20n,
        collateralFloor: 20n,
        fillMode: DEFAULT_INPUT.fillMode,
        cadence: 0,
        rateBps: 850n,
        durationDays: 30,
        expiry: '7d',
        fullTerm: DEFAULT_INPUT.fullTerm,
        allowsPartialRepay: false,
        tariff: null,
      },
      { lending, collateral, leg: { kind: 'erc20' } },
      99n,
      'borrower',
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
    expect(p.fillMode).toBe(0);
  });
});

describe('createParams for a lending offer', () => {
  it('sends a lender offer whose one collateral figure is both ends, and escrows the amount', () => {
    const parsed = {
      amount: 10n,
      amountMax: 10n,
      collateral: 20n,
      collateralFloor: 20n,
      fillMode: 'partial' as const,
      cadence: 0 as const,
      rateBps: 850n,
      durationDays: 30,
      expiry: '7d' as const,
      fullTerm: true,
      allowsPartialRepay: true,
      tariff: null,
    };
    const p = createParams(parsed, { lending, collateral, leg: { kind: 'erc20' } }, 99n, 'lender');
    expect(p.offerType).toBe(0);
    expect([p.amount, p.amountMax]).toEqual([10n, 10n]);
    expect([p.interestRateBps, p.interestRateBpsMax]).toEqual([850n, 850n]);
    expect([p.collateralAmount, p.collateralAmountMax]).toEqual([20n, 20n]);
    expect(p.allowsPartialRepay).toBe(true);
    expect(stakeOf('lender', parsed, { lending, collateral })).toEqual({ asset: lending, amount: 10n });
    expect(stakeOf('borrower', parsed, { lending, collateral })).toEqual({ asset: collateral, amount: 20n });
  });
});

describe('lenderPostFigures', () => {
  it("takes the borrower's fee from what they receive, never from the amount lent, and keeps at most today's share of the interest", () => {
    const f = lenderPostFigures(365_000n, 1_000n, 365, 20n, 200n);
    expect(f.fee).toBe(730n);
    expect(f.borrowerGets).toBe(365_000n - 730n);
    expect(f.interest).toBe(36_500n);
    expect(f.protocolShare).toBe(730n);
    expect(f.backAtDue).toBe(365_000n + 36_500n - 730n);
  });
});

describe('createParams for an NFT', () => {
  it('names the one ERC-721 token by its id and carries no collateral amount', () => {
    const p = createParams(
      {
        amount: 10n,
        amountMax: 10n,
        collateral: 1n,
        collateralFloor: 1n,
        fillMode: 'partial',
        cadence: 0,
        rateBps: 850n,
        durationDays: 30,
        expiry: '7d',
        fullTerm: true,
        allowsPartialRepay: false,
        tariff: null,
      },
      { lending, collateral, leg: { kind: 'erc721', tokenId: 7n } },
      99n,
      'borrower',
    );
    expect([p.collateralAssetType, p.collateralTokenId, p.collateralQuantity]).toEqual([1, 7n, 1n]);
    expect([p.collateralAmount, p.collateralAmountMax]).toEqual([0n, 0n]);
    expect([p.assetType, p.amount]).toEqual([0, 10n]);
  });
});

describe('postFigures', () => {
  it('takes the list fee from the amount and adds the term interest to what is owed', () => {
    const f = postFigures(1_000_000n, 1_000n, 365, 20n);
    expect(f.fee).toBe(2_000n);
    expect(f.received).toBe(998_000n);
    expect(f.interest).toBe(100_000n);
    expect(f.owedAtDue).toBe(1_100_000n);
  });
});

describe('a range and a fill mode (OFF-10 / OFF-11)', () => {
  const ranged = {
    amount: 10n,
    amountMax: 40n,
    collateral: 100n,
    collateralFloor: 30n,
    fillMode: 'ioc' as const,
    cadence: 2 as const,
    rateBps: 850n,
    durationDays: 30,
    expiry: '7d' as const,
    fullTerm: true,
    allowsPartialRepay: false,
    tariff: null,
  };
  it('sends the smallest and largest amount, the floor and the locked collateral, one rate, and the fill mode', () => {
    const p = createParams(ranged, { lending, collateral, leg: { kind: 'erc20' } }, 99n, 'borrower');
    expect([p.amount, p.amountMax]).toEqual([10n, 40n]);
    expect([p.collateralAmount, p.collateralAmountMax]).toEqual([30n, 100n]);
    expect([p.interestRateBps, p.interestRateBpsMax]).toEqual([850n, 850n]);
    expect(p.fillMode).toBe(2);
    expect(p.periodicInterestCadence).toBe(2);
    expect(isRanged(ranged)).toBe(true);
    expect(isRanged({ ...ranged, amountMax: 10n, collateralFloor: 100n })).toBe(false);
    expect(isRanged({ ...ranged, amountMax: 10n })).toBe(true);
  });
  it('never sends a floor for an NFT leg', () => {
    const p = createParams({ ...ranged, collateral: 1n, collateralFloor: 1n }, { lending, collateral, leg: { kind: 'erc721', tokenId: 7n } }, 99n, 'borrower');
    expect([p.collateralAmount, p.collateralAmountMax]).toEqual([0n, 0n]);
  });
  it('refuses a largest amount below the smallest and a floor above what is locked', () => {
    expect(rangeError(10n, 9n, 100n, 30n)).toBe('max-below-min');
    expect(rangeError(10n, 10n, 100n, 101n)).toBe('floor-above-lock');
    expect(rangeError(10n, 10n, 100n, 100n)).toBeNull();
  });
  it('refuses all-or-none with a range and immediate-or-cancel without an expiry, as the protocol does', () => {
    expect(fillModeBlock('aon', true, '7d')).toBe('aon-range');
    expect(fillModeBlock('aon', false, 'never')).toBeNull();
    expect(fillModeBlock('ioc', false, 'never')).toBe('ioc-open');
    expect(fillModeBlock('ioc', true, '1d')).toBeNull();
    expect(fillModeBlock('partial', true, 'never')).toBeNull();
  });
  it('names the Advanced options a request carries, so Basic can say they still apply', () => {
    expect(advancedSet(DEFAULT_INPUT)).toEqual([]);
    expect(advancedSet({ ...DEFAULT_INPUT, ranged: true, fillMode: 'aon' })).toEqual(['range', 'fill']);
    expect(advancedSet({ ...DEFAULT_INPUT, cadence: 1 })).toEqual(['cadence']);
  });
});

describe("a lending offer's parts (OFF-10 / OFF-11)", () => {
  // The whole amount is 40, the smallest part one match may lend 10, and the
  // borrower must lock 100 for the whole amount.
  const parts = {
    amount: 10n,
    amountMax: 40n,
    collateral: 100n,
    collateralFloor: 100n,
    fillMode: 'ioc' as const,
    cadence: 0 as const,
    rateBps: 850n,
    durationDays: 30,
    expiry: '7d' as const,
    fullTerm: true,
    allowsPartialRepay: false,
    tariff: null,
  };
  it('sends the smallest part as the minimum, the whole amount as the maximum and escrow, one collateral figure, and the fill mode', () => {
    const p = createParams(parts, { lending, collateral, leg: { kind: 'erc20' } }, 99n, 'lender');
    expect([p.amount, p.amountMax]).toEqual([10n, 40n]);
    expect([p.collateralAmount, p.collateralAmountMax]).toEqual([100n, 100n]);
    expect([p.interestRateBps, p.interestRateBpsMax]).toEqual([850n, 850n]);
    expect(p.fillMode).toBe(2);
    expect(stakeOf('lender', parts, { lending, collateral })).toEqual({ asset: lending, amount: 40n });
    expect(isRanged(parts)).toBe(true);
  });
  it('refuses a smallest part above the whole amount, and allows it equal', () => {
    expect(partError(41n, 40n)).toBe('part-above-amount');
    expect(partError(40n, 40n)).toBeNull();
    expect(partError(1n, 40n)).toBeNull();
  });
  it('pro-rates the collateral a part asks as the protocol does, rounding down', () => {
    expect(partCollateral(100n, 10n, 40n)).toBe(25n);
    expect(partCollateral(100n, 13n, 40n)).toBe(32n);
    expect(partCollateral(100n, 40n, 40n)).toBe(100n);
    expect(partCollateral(100n, 10n, 0n)).toBe(100n);
  });
});
