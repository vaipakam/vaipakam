import { describe, expect, it } from 'vitest';
import { offer } from '../../shared/offers/testOffer';
import { acceptReceipt, changedBetween, reviewBlockers, type AcceptReview } from './acceptReview';

type Hex = `0x${string}`;

/** A copy stand-in that returns the key, so a test reads which line was chosen. */
const copy = {
  text: (k: string) => k,
  format: (k: string) => k,
} as unknown as Parameters<typeof reviewBlockers>[2];

function review(over: Partial<AcceptReview> = {}): AcceptReview {
  return {
    identity: 'w',
    offerId: 7n,
    offer: offer(),
    state: 'open',
    preview: {
      effectivePrincipal: 2n * 10n ** 18n,
      interestRateBps: 500n,
      collateralAmount: 5000n * 10n ** 18n,
      lifEstimate: 4n * 10n ** 15n,
      collateralResidualRefund: 0n,
      error: 'None',
    },
    linkedLoanId: 0n,
    riskTermsHash: `0x${'ab'.repeat(32)}` as Hex,
    lendingClass: 'liquid',
    collateralClass: 'liquid',
    graceSeconds: 86_400n,
    lifBps: 20n,
    matcherBps: 100n,
    vault: '0x0000000000000000000000000000000000000000',
    funds: { balance: 10_000n * 10n ** 18n, allowance: 0n },
    gate: 0,
    creatorGate: 0,
    consent: true,
    readAt: 1,
    ...over,
  } as AcceptReview;
}

describe('reviewBlockers', () => {
  it("names a lender-side risk block as the lender's, never as this wallet's setting", () => {
    expect(reviewBlockers(review({ gate: 2, creatorGate: 2 }), null, copy)).toEqual(['accept.blockCreatorGate']);
    expect(reviewBlockers(review({ gate: 1, creatorGate: 0 }), null, copy)).toEqual(['accept.blockGate1']);
    expect(reviewBlockers(review(), null, copy)).toEqual([]);
  });
});

describe('acceptReceipt', () => {
  const labels = (r: AcceptReview) => acceptReceipt(r, null, copy).rows.map((x) => x.label);
  it('states every lifecycle term the signature binds, defaults included', () => {
    for (const key of ['accept.rowPartial', 'accept.rowPrepayListing', 'accept.rowParallelSale', 'accept.rowRefinance', 'accept.rowLinked'])
      expect(labels(review())).toContain(key);
  });
  it('labels the owed figure as the term total when interest is paid on a schedule', () => {
    expect(labels(review())).toContain('accept.rowOwe');
    const scheduled = labels(review({ offer: offer({ periodicInterestCadence: 1 }) }));
    expect(scheduled).toContain('accept.rowOweTotal');
    expect(scheduled).not.toContain('accept.rowOwe');
  });
  it('names each illiquid leg for what it is and drops the price-liquidation line', () => {
    const lose = (r: AcceptReview) => acceptReceipt(r, null, copy).consequences;
    expect(lose(review())).toContain('accept.loseLiquidation');
    const lending = lose(review({ lendingClass: 'illiquid' }));
    expect(lending).toContain('accept.loseIlliquidLending');
    expect(lending).not.toContain('accept.loseIlliquidCollateral');
    expect(lending).not.toContain('accept.loseLiquidation');
    const both = lose(review({ lendingClass: 'illiquid', collateralClass: 'illiquid' }));
    expect(both).toEqual(expect.arrayContaining(['accept.loseIlliquidLending', 'accept.loseIlliquidCollateral']));
    expect(lose(review())).toContain('accept.losePause');
  });
});

describe('changedBetween', () => {
  it("treats a change in the lender's own block as a change", () => {
    expect(changedBetween(review(), review({ creatorGate: 1 }), copy)).toBe('accept.changedClass');
    expect(changedBetween(review(), review(), copy)).toBeNull();
  });
});
