import { describe, expect, it } from 'vitest';
import { OFFER_BORROWER } from '../offers/acceptTerms';
import { BORROWER, offer } from '../offers/testOffer';
import { changedBetween, promptCount, reviewBlockers, type AcceptReview } from './acceptReview';
import { acceptReceipt } from './receipt';

type Hex = `0x${string}`;

/** A copy stand-in that returns the key, so a test reads which line was chosen. */
const copy = {
  text: (k: string) => k,
  format: (k: string) => k,
} as unknown as Parameters<typeof reviewBlockers>[2];

function review(over: Partial<AcceptReview> = {}): AcceptReview {
  return {
    identity: 'w',
    role: 'borrower',
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
    protocolShareBps: null,
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

/** A lender funding a borrow request: the wallet pays the principal. */
function lenderReview(over: Partial<AcceptReview> = {}): AcceptReview {
  return review({ role: 'lender', offer: offer({ offerType: OFFER_BORROWER, creator: BORROWER }), protocolShareBps: 200n, ...over });
}

describe('a lender funding a borrow request', () => {
  const rows = (r: AcceptReview) => acceptReceipt(r, null, copy).rows;
  const labels = (r: AcceptReview) => rows(r).map((x) => x.label);

  it('measures the shortfall against the amount lent, not the collateral', () => {
    const p = lenderReview().preview;
    expect(reviewBlockers(lenderReview({ funds: { balance: p.effectivePrincipal, allowance: 0n } }), null, copy)).toEqual([]);
    expect(reviewBlockers(lenderReview({ funds: { balance: p.effectivePrincipal - 1n, allowance: 0n } }), null, copy)).toEqual(['lendAccept.blockShortfall']);
  });

  it('names the other side as the borrower in refusals and blocks', () => {
    expect(reviewBlockers(lenderReview({ gate: 2, creatorGate: 2 }), null, copy)).toEqual(['lendAccept.blockCreatorGate']);
    const vault = { ...lenderReview().preview, error: 'VaultUpgradeRequired' as const };
    expect(reviewBlockers(lenderReview({ preview: vault, vaultUpgradeYours: false }), null, copy)).toEqual(['lendAccept.vaultUpgradeBorrower']);
    const cancelled = { ...lenderReview().preview, error: 'OfferIsCancelled' as const };
    expect(reviewBlockers(lenderReview({ preview: cancelled }), null, copy)).toEqual(['lendAccept.err.OfferIsCancelled']);
    const paused = { ...lenderReview().preview, error: 'AssetPaused' as const };
    expect(reviewBlockers(lenderReview({ preview: paused }), null, copy)).toEqual(['accept.err.AssetPaused']);
  });

  it('never takes a sale of a running loan as a new loan', () => {
    expect(reviewBlockers(lenderReview({ linkedLoanId: 9n }), null, copy)).toEqual(['lendAccept.blockPositionSale']);
  });

  it("states what leaves the wallet, what the borrower gets, and the protocol share as today's figure", () => {
    const r = rows(lenderReview());
    const pay = r.find((x) => x.label === 'lendAccept.rowPay')!;
    expect(pay.movesOut).toBe(true);
    expect(pay.value).toMatchObject({ kind: 'amount', amount: 2n * 10n ** 18n });
    expect(r.find((x) => x.label === 'lendAccept.rowBorrowerGets')!.value).toMatchObject({ amount: 2n * 10n ** 18n - 4n * 10n ** 15n });
    expect(r.find((x) => x.label === 'lendAccept.rowShare')!.binding).toBe(false);
    expect(r.find((x) => x.label === 'lendAccept.rowBack')!.binding).toBe(false);
    expect(labels(lenderReview())).not.toContain('accept.rowLock');
    expect(labels(lenderReview())).not.toContain('lendAccept.rowFeeTariff');
    expect(labels(lenderReview({ offer: offer({ offerType: OFFER_BORROWER, creatorFull: true }) }))).toContain('lendAccept.rowFeeTariff');
  });

  it("says a refinance request pays the old loan's lender, never that the borrower receives it", () => {
    const r = rows(lenderReview({ offer: offer({ offerType: OFFER_BORROWER, creator: BORROWER, refinanceTargetLoanId: 5n }) }));
    expect(r.map((x) => x.label)).not.toContain('lendAccept.rowBorrowerGets');
    expect(r.find((x) => x.label === 'lendAccept.rowPaysOff')!.value).toMatchObject({ amount: 2n * 10n ** 18n - 4n * 10n ** 15n });
    expect(r.find((x) => x.label === 'lendAccept.rowRefinance')!.value).toMatchObject({ text: 'lendAccept.refinanceLoan' });
  });

  it("states the lender's consequences, including the position token", () => {
    const lose = acceptReceipt(lenderReview(), null, copy).consequences;
    expect(lose).toEqual(expect.arrayContaining(['lendAccept.loseDefault', 'lendAccept.loseLiquidation', 'lendAccept.loseShare', 'lendAccept.losePosition', 'accept.loseBinding']));
    expect(lose).not.toContain('accept.loseDefault');
  });

  it('reads a change in the protocol share as a changed review', () => {
    expect(changedBetween(lenderReview(), lenderReview({ protocolShareBps: 300n }), copy)).toBe('accept.changedClass');
  });
});
