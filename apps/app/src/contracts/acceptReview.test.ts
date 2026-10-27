import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  ACCEPT_TERMS_FIELD_SOURCE,
  illiquidAcknowledgements,
  illiquidLegUnreviewed,
  lifecycleRows,
  reviewedMismatches,
  reviewedTermsFromOrder,
  type ReviewedAcceptTerms,
} from './acceptReview';
import { ACCEPT_TERMS_TYPES, type AcceptTerms } from './useAcceptTerms';
import type { SignedOrderWire } from '../lib/signedOffer';
import { copy } from '../content/copy';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const ZERO_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;
const A = '0x1111111111111111111111111111111111111111' as Address;
const B = '0x2222222222222222222222222222222222222222' as Address;
const C = '0x3333333333333333333333333333333333333333' as Address;

function signedTerms(): AcceptTerms {
  return {
    acceptor: C,
    offerCreator: A,
    offerKey: ZERO_HASH,
    offerType: 0,
    lendingAsset: A,
    collateralAsset: B,
    amount: 1000n,
    collateralAmount: 2000n,
    interestRateBps: 500n,
    durationDays: 30n,
    tokenId: 0n,
    collateralTokenId: 0n,
    quantity: 0n,
    collateralQuantity: 0n,
    assetType: 0,
    collateralAssetType: 0,
    prepayAsset: ZERO,
    useFullTermInterest: false,
    allowsPartialRepay: true,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    linkedLoanId: 0n,
    parallelSaleOrderHash: ZERO_HASH,
    periodicInterestCadence: 0,
    riskAndTermsConsent: true,
    acknowledgedIlliquidLendingAsset: ZERO,
    acknowledgedIlliquidCollateralAsset: ZERO,
    nonce: 1n,
    deadline: 2n,
    riskTermsHash: ZERO_HASH,
    acceptorFull: false,
    acceptorMaxCStar: 0n,
    acceptorAllowFullDowngrade: false,
  };
}

function reviewedFrom(t: AcceptTerms): ReviewedAcceptTerms {
  const out: Record<string, unknown> = { illiquidLegs: { lending: false, collateral: false } };
  for (const [k, src] of Object.entries(ACCEPT_TERMS_FIELD_SOURCE)) {
    if (src === 'reviewed') out[k] = t[k as keyof AcceptTerms];
  }
  return out as unknown as ReviewedAcceptTerms;
}

/** A value of the same type that differs from `v`. */
function changed(v: unknown): unknown {
  if (typeof v === 'bigint') return v + 1n;
  if (typeof v === 'number') return v + 1;
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'string') {
    return v.length === 66
      ? '0x' + 'ab'.repeat(32)
      : '0x4444444444444444444444444444444444444444';
  }
  throw new Error(`unhandled value ${String(v)}`);
}

describe('#2725 accept-terms field classification', () => {
  it('classifies every signed EIP-712 field, and nothing else', () => {
    const signed = ACCEPT_TERMS_TYPES.AcceptTerms.map((f) => f.name).sort();
    expect(Object.keys(ACCEPT_TERMS_FIELD_SOURCE).sort()).toEqual(signed);
  });

  it('treats every term of the deal itself as reviewed', () => {
    for (const k of [
      'offerCreator',
      'offerType',
      'lendingAsset',
      'collateralAsset',
      'amount',
      'collateralAmount',
      'interestRateBps',
      'durationDays',
      'prepayAsset',
      'useFullTermInterest',
      'allowsPartialRepay',
      'allowsPrepayListing',
      'allowsParallelSale',
      'refinanceTargetLoanId',
      'linkedLoanId',
      'parallelSaleOrderHash',
      'periodicInterestCadence',
    ] as const) {
      expect(ACCEPT_TERMS_FIELD_SOURCE[k]).toBe('reviewed');
    }
  });
});

describe('#2725 reviewedMismatches', () => {
  it('passes when the signature binds exactly what was reviewed', () => {
    const t = signedTerms();
    expect(reviewedMismatches(reviewedFrom(t), t)).toEqual([]);
  });

  it('ignores address case', () => {
    const t = signedTerms();
    const r = reviewedFrom(t);
    r.lendingAsset = r.lendingAsset.toUpperCase().replace('0X', '0x') as Address;
    expect(reviewedMismatches(r, t)).toEqual([]);
  });

  it('catches a change to every reviewed field', () => {
    const t = signedTerms();
    const reviewedKeys = Object.entries(ACCEPT_TERMS_FIELD_SOURCE)
      .filter(([, src]) => src === 'reviewed')
      .map(([k]) => k as keyof AcceptTerms);
    for (const k of reviewedKeys) {
      const moved = { ...t, [k]: changed(t[k]) } as AcceptTerms;
      expect(reviewedMismatches(reviewedFrom(t), moved), k).toEqual([k]);
    }
  });

  it('does not compare acceptor or derived fields', () => {
    const t = signedTerms();
    const moved: AcceptTerms = {
      ...t,
      acceptor: B,
      nonce: 99n,
      deadline: 99n,
      riskAndTermsConsent: false,
      acceptorFull: true,
    };
    expect(reviewedMismatches(reviewedFrom(t), moved)).toEqual([]);
  });
});

describe('#2728 illiquid acknowledgements', () => {
  it('acknowledges only the legs the review showed as illiquid', () => {
    expect(illiquidAcknowledgements({ lending: false, collateral: false }, A, B)).toEqual({
      acknowledgedIlliquidLendingAsset: ZERO,
      acknowledgedIlliquidCollateralAsset: ZERO,
    });
    expect(illiquidAcknowledgements({ lending: false, collateral: true }, A, B)).toEqual({
      acknowledgedIlliquidLendingAsset: ZERO,
      acknowledgedIlliquidCollateralAsset: B,
    });
    expect(illiquidAcknowledgements({ lending: true, collateral: true }, A, B)).toEqual({
      acknowledgedIlliquidLendingAsset: A,
      acknowledgedIlliquidCollateralAsset: B,
    });
  });

  it('flags a leg that reads illiquid now but was not shown as illiquid', () => {
    const shown = { lending: false, collateral: true };
    expect(illiquidLegUnreviewed(shown, { lending: false, collateral: true })).toBe(false);
    expect(illiquidLegUnreviewed(shown, { lending: false, collateral: false })).toBe(false);
    expect(illiquidLegUnreviewed(shown, { lending: true, collateral: true })).toBe(true);
  });
});

describe('#2725 lifecycle rows', () => {
  const base = {
    useFullTermInterest: false,
    allowsPartialRepay: false,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    periodicInterestCadence: 0,
    refinanceTargetLoanId: 0n,
    linkedLoanId: 0n,
    parallelSaleOrderHash: ZERO_HASH,
  };

  it('always lists the five standing terms, defaults included', () => {
    const labels = lifecycleRows(base).map((r) => r.label);
    expect(labels).toEqual([
      copy.acceptTerms.interestLabel,
      copy.acceptTerms.scheduleLabel,
      copy.acceptTerms.partialRepayLabel,
      copy.acceptTerms.prepayListingLabel,
      copy.acceptTerms.parallelSaleLabel,
    ]);
  });

  it('adds a row for a live listing, a refinance target and a linked loan', () => {
    const rows = lifecycleRows({
      ...base,
      refinanceTargetLoanId: 7n,
      linkedLoanId: 9n,
      parallelSaleOrderHash: ('0x' + 'ab'.repeat(32)) as Hex,
    });
    const values = rows.map((r) => r.value);
    expect(values).toContain(copy.acceptTerms.liveListing);
    expect(values).toContain(copy.acceptTerms.refinanceOf('7'));
    expect(values).toContain(copy.acceptTerms.linkedTo('9'));
  });

  it('reads an unknown schedule as unknown, never as a known one', () => {
    const row = lifecycleRows({ ...base, periodicInterestCadence: 42 })[1];
    expect(row.value).toBe(copy.acceptTerms.cadenceUnknown);
  });
});

describe('#2725 signed-order review', () => {
  it('binds the role-correct endpoints and shows no illiquid leg', () => {
    const order = {
      signer: A,
      offerType: '0',
      lendingAsset: A,
      collateralAsset: B,
      amount: '100',
      amountMax: '500',
      collateralAmount: '50',
      interestRateBps: '300',
      interestRateBpsMax: '900',
      durationDays: '30',
      tokenId: '0',
      collateralTokenId: '0',
      quantity: '0',
      collateralQuantity: '0',
      assetType: '0',
      collateralAssetType: '0',
      prepayAsset: ZERO,
      useFullTermInterest: true,
      allowsPartialRepay: false,
      allowsPrepayListing: true,
      allowsParallelSale: false,
      periodicInterestCadence: '1',
      refinanceTargetLoanId: '0',
    } as unknown as SignedOrderWire;
    const lender = reviewedTermsFromOrder(order);
    expect(lender.amount).toBe(500n);
    expect(lender.interestRateBps).toBe(300n);
    expect(lender.illiquidLegs).toEqual({ lending: false, collateral: false });
    expect(lender.linkedLoanId).toBe(0n);
    expect(lender.parallelSaleOrderHash).toBe(ZERO_HASH);
    const borrower = reviewedTermsFromOrder({ ...order, offerType: '1' } as SignedOrderWire);
    expect(borrower.amount).toBe(100n);
    expect(borrower.interestRateBps).toBe(900n);
  });
});
