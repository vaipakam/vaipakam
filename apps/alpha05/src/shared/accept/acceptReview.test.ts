import { describe, expect, it } from 'vitest';
import { offer } from '../offers/testOffer';
import { acceptReceipt, changedBetween, promptCount, reviewBlockers, type AcceptReview } from './acceptReview';

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
    approvalSteps: 1,
    vaultUpgradeYours: null,
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
    expect(reviewBlockers(review({ gate: 1, creatorGate: 0 }), null, copy)).toEqual(['risk.blockTier']);
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

describe('approval steps', () => {
  it('counts the extra step to zero as a wallet prompt and names it on the receipt', () => {
    expect(promptCount(review())).toBe(3);
    expect(promptCount(review({ approvalSteps: 2 }))).toBe(4);
    expect(promptCount(review({ approvalSteps: 0 }))).toBe(2);
  });
  it('reads a change in the number of approval steps as a changed review', () => {
    expect(changedBetween(review(), review({ approvalSteps: 2 }), copy)).not.toBeNull();
  });
});

describe('vault upgrade refusal', () => {
  const preview = { ...review().preview, error: 'VaultUpgradeRequired' as const };
  it('sends the remedy to this wallet only when its own vault is the one below the required version', () => {
    expect(reviewBlockers(review({ preview, vaultUpgradeYours: true }), null, copy)).toEqual(['accept.err.VaultUpgradeRequired']);
    expect(reviewBlockers(review({ preview, vaultUpgradeYours: false }), null, copy)).toEqual(['accept.vaultUpgradeLender']);
    expect(reviewBlockers(review({ preview, vaultUpgradeYours: null }), null, copy)).toEqual(['accept.vaultUpgradeEither']);
  });
});

describe('sale routes on token collateral', () => {
  const value = (r: AcceptReview, key: string) => acceptReceipt(r, null, copy).rows.find((x) => x.label === key)?.value as { text?: string } | undefined;
  it('states a granted listing permission as one a token-collateral loan cannot use', () => {
    expect(value(review({ offer: { ...offer(), allowsPrepayListing: true } }), 'accept.rowPrepayListing')?.text).toBe('accept.prepayListingNotNft');
    expect(value(review({ offer: { ...offer(), allowsPrepayListing: true, collateralAssetType: 1 } }), 'accept.rowPrepayListing')?.text).toBe('accept.prepayListingYes');
  });
});
