import { describe, expect, it } from 'vitest';
import type { StoredOffer } from '../offers/acceptTerms';
import type { Matches, MatchRow } from '../offers/matches';
import type { PostDraft } from './postReview';
import { fitsDraft, takeNowPicks, TAKE_NOW_SHOWN } from './takeNow';

type Hex = `0x${string}`;
const lending: Hex = '0x00000000000000000000000000000000000000aa';
const collateral: Hex = '0x00000000000000000000000000000000000000bb';

function offer(over: Partial<StoredOffer> = {}): StoredOffer {
  return {
    id: 1n,
    creator: '0x00000000000000000000000000000000000000cc',
    offerType: 0,
    assetType: 0,
    collateralAssetType: 0,
    lendingAsset: lending,
    collateralAsset: collateral,
    amount: 1_000n,
    amountMax: 1_000n,
    amountFilled: 0n,
    interestRateBps: 700n,
    interestRateBpsMax: 700n,
    collateralAmount: 4_000n,
    collateralAmountMax: 4_000n,
    collateralAmountFilled: 0n,
    durationDays: 30n,
    tokenId: 0n,
    collateralTokenId: 0n,
    quantity: 0n,
    collateralQuantity: 0n,
    prepayAsset: lending,
    useFullTermInterest: true,
    allowsPartialRepay: false,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    parallelSaleOrderHash: '0x00',
    periodicInterestCadence: 0,
    expiresAt: 0n,
    accepted: false,
    creatorFull: false,
    ...over,
  } as StoredOffer;
}

function row(o: StoredOffer, over: Partial<MatchRow> = {}): MatchRow {
  return {
    offer: o,
    state: 'open',
    preview: {
      effectivePrincipal: o.amountMax,
      interestRateBps: o.interestRateBps,
      collateralAmount: o.collateralAmount,
      lifEstimate: 2n,
      collateralResidualRefund: 0n,
      error: 'None',
      referralCut: 0n,
    },
    ltv: { kind: 'bps', bps: 5_000n },
    blocked: null,
    ...over,
  } as MatchRow;
}

function draft(side: 'borrower' | 'lender' = 'borrower', over: Partial<PostDraft['parsed']> = {}): PostDraft {
  return {
    side,
    parsed: {
      amount: 1_000n,
      amountMax: 1_000n,
      collateral: 5_000n,
      collateralFloor: 5_000n,
      fillMode: 'aon',
      cadence: 0,
      tariff: null,
      guardBps: null,
      rateBps: 800n,
      durationDays: 30,
      expiry: '7d',
      fullTerm: true,
      allowsPartialRepay: false,
      ...over,
    },
    pair: { lending, collateral, leg: { kind: 'erc20' } },
    expiresAt: 0n,
  } as PostDraft;
}

describe('take it now at posting (#3622 B1)', () => {
  it('offers a lender offer whose direct accept stays inside the borrower’s limits', () => {
    expect(fitsDraft(draft(), row(offer()))).toBe(true);
  });
  it('refuses any term, option, rate, amount or collateral outside the draft', () => {
    const d = draft();
    expect(fitsDraft(d, row(offer({ durationDays: 60n })))).toBe(false);
    expect(fitsDraft(d, row(offer({ useFullTermInterest: false })))).toBe(false);
    expect(fitsDraft(d, row(offer({ allowsPartialRepay: true })))).toBe(false);
    expect(fitsDraft(d, row(offer({ periodicInterestCadence: 1 })))).toBe(false);
    expect(fitsDraft(d, row(offer({ allowsPrepayListing: true })))).toBe(false);
    expect(fitsDraft(d, row(offer({ refinanceTargetLoanId: 3n })))).toBe(false);
    expect(fitsDraft(d, row(offer({ interestRateBps: 900n })))).toBe(false);
    // A borrower accepting takes the lender's largest amount.
    expect(fitsDraft(d, row(offer({ amountMax: 2_000n, collateralAmount: 8_000n })))).toBe(false);
    expect(fitsDraft(d, row(offer({ collateralAmount: 6_000n })))).toBe(false);
    expect(fitsDraft(d, row(offer({ collateralAsset: lending })))).toBe(false);
    expect(fitsDraft(d, row(offer({ offerType: 1 })))).toBe(false);
  });
  it('scales the borrower’s collateral to the amount a ranged draft takes', () => {
    const d = draft('borrower', { amount: 500n, amountMax: 1_000n, collateral: 5_000n, collateralFloor: 2_500n });
    expect(fitsDraft(d, row(offer({ amount: 500n, amountMax: 500n, collateralAmount: 2_500n })))).toBe(true);
    expect(fitsDraft(d, row(offer({ amount: 500n, amountMax: 500n, collateralAmount: 2_501n })))).toBe(false);
  });
  it('for a lender, takes a request at the borrower’s ceiling rate and at least the asked collateral', () => {
    const d = draft('lender', { rateBps: 600n, collateral: 4_000n });
    const req = offer({ offerType: 1, interestRateBps: 500n, interestRateBpsMax: 650n, collateralAmount: 4_000n });
    expect(fitsDraft(d, row(req))).toBe(true);
    expect(fitsDraft(d, row({ ...req, interestRateBpsMax: 550n }))).toBe(false);
    expect(fitsDraft(d, row({ ...req, collateralAmount: 3_999n }))).toBe(false);
  });
  it('never picks a blocked, ended or unpreviewed offer, nor for a draft with the Full tariff, a price-move guard or an NFT leg', () => {
    const o = offer();
    expect(fitsDraft(draft(), row(o, { blocked: { kind: 'moved' } }))).toBe(false);
    expect(fitsDraft(draft(), row(o, { state: 'accepted' as MatchRow['state'] }))).toBe(false);
    expect(fitsDraft(draft(), row(o, { preview: null }))).toBe(false);
    expect(fitsDraft(draft('borrower', { tariff: { maxCStar: 1n } as unknown as PostDraft['parsed']['tariff'] }), row(o))).toBe(false);
    expect(fitsDraft(draft('borrower', { guardBps: 300 }), row(o))).toBe(false);
    expect(fitsDraft({ ...draft(), pair: { lending, collateral, leg: { kind: 'erc721', tokenId: 1n } } }, row(o))).toBe(false);
  });
  it('picks at most a few, in the list’s order, and none without a read', () => {
    const rows = [1n, 2n, 3n, 4n, 5n].map((id) => row(offer({ id })));
    const m = { rows, unread: [], skipped: {}, total: 5n, scanned: 5, matcher: { bps: 100n, floorBps: 10n } } as unknown as Matches;
    expect(takeNowPicks(draft(), m).map((r) => r.offer.id)).toEqual([1n, 2n, 3n].slice(0, TAKE_NOW_SHOWN));
    expect(takeNowPicks(draft(), null)).toEqual([]);
  });
});
