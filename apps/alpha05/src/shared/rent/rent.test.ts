import { describe, expect, it } from 'vitest';
import { OFFER_BORROWER } from '../offers/acceptTerms';
import { offer, WETH } from '../offers/testOffer';
import { isListing, isRental, rentalCost } from './rental';
import { rentReceipt } from './rentReceipt';
import { needsApproval, promptCount, rentBlockers, rentChangedBetween, reviewCost, type RentReview } from './rentReview';

type Hex = `0x${string}`;

const NFT: Hex = '0x5555555555555555555555555555555555555555';
const USDC: Hex = '0x6666666666666666666666666666666666666666';
const ZERO: Hex = '0x0000000000000000000000000000000000000000';

/** A copy stand-in that returns the key, so a test reads which line was chosen. */
const copy = {
  text: (k: string) => k,
  format: (k: string) => k,
} as unknown as Parameters<typeof rentBlockers>[2];

/** An owner's ERC-721 listing: 2 tokens a day for 10 days, paid in USDC. */
function listing(over: Parameters<typeof offer>[0] = {}) {
  return offer({
    assetType: 1,
    lendingAsset: NFT,
    tokenId: 42n,
    quantity: 1n,
    amount: 2_000_000n,
    amountMax: 2_000_000n,
    interestRateBps: 0n,
    interestRateBpsMax: 0n,
    collateralAsset: ZERO,
    collateralAmount: 0n,
    collateralAmountMax: 0n,
    durationDays: 10n,
    prepayAsset: USDC,
    useFullTermInterest: false,
    ...over,
  });
}

function review(over: Partial<RentReview> = {}): RentReview {
  return {
    identity: 'w',
    offerId: 7n,
    offer: listing(),
    state: 'open',
    preview: { effectivePrincipal: 2_000_000n, interestRateBps: 0n, collateralAmount: 0n, lifEstimate: 0n, collateralResidualRefund: 0n, error: 'None' },
    linkedLoanId: 0n,
    riskTermsHash: `0x${'ab'.repeat(32)}` as Hex,
    nftClass: 'illiquid',
    prepayClass: 'liquid',
    graceSeconds: 86_400n,
    listingBufferBps: 500n,
    todayBufferBps: 700n,
    vault: ZERO,
    funds: { balance: 100_000_000n, allowance: 0n },
    approvalSteps: 1,
    gate: 0,
    creatorGate: 0,
    readAt: 1,
    ...over,
  };
}

describe('rentalCost', () => {
  it('is the daily fee times the term plus the buffer share, rounded down like the protocol', () => {
    expect(rentalCost(2_000_000n, 10n, 500n, 700n)).toEqual({
      dailyFee: 2_000_000n,
      days: 10n,
      rent: 20_000_000n,
      bufferBps: 500n,
      bufferFrom: 'listing',
      buffer: 1_000_000n,
      total: 21_000_000n,
    });
    // 7 × 3 = 21 at 5 % is 1.05: the buffer rounds down to 1.
    expect(rentalCost(7n, 3n, 500n, 0n).buffer).toBe(1n);
  });
  it("takes today's setting only for a listing that recorded no buffer of its own", () => {
    const c = rentalCost(2_000_000n, 10n, 0n, 700n);
    expect(c.bufferFrom).toBe('today');
    expect(c.buffer).toBe(1_400_000n);
  });
});

describe('which offers are rentals', () => {
  it("tells an owner's listing from a renter's request and from a loan", () => {
    expect(isRental(listing())).toBe(true);
    expect(isListing(listing())).toBe(true);
    expect(isListing(listing({ offerType: OFFER_BORROWER }))).toBe(false);
    expect(isRental(offer({ lendingAsset: WETH }))).toBe(false);
  });
});

describe('rentBlockers', () => {
  it('opens nothing when the protocol reports nothing and the wallet holds the rent and buffer', () => {
    expect(rentBlockers(review(), null, copy)).toEqual([]);
  });
  it('states a shortfall against the rent plus buffer, not the rent alone', () => {
    // 20.5 USDC covers the rent (20) but not rent plus buffer (21).
    expect(rentBlockers(review({ funds: { balance: 20_500_000n, allowance: 0n } }), null, copy)).toEqual(['rent.blockShortfall']);
  });
  it("names the owner's block as the owner's and a renter-side block as this wallet's", () => {
    expect(rentBlockers(review({ gate: 2, creatorGate: 2 }), null, copy)).toEqual(['rent.blockCreatorGate']);
    expect(rentBlockers(review({ gate: 1 }), null, copy)).toEqual(['risk.blockTier']);
  });
  it('words a refusal for a renter, and an ended listing by how it ended', () => {
    expect(rentBlockers(review({ preview: { ...review().preview, error: 'OfferIsCancelled' } }), null, copy)).toEqual(['rent.err.OfferIsCancelled']);
    expect(rentBlockers(review({ preview: { ...review().preview, error: 'KYCRequired' } }), null, copy)).toEqual(['accept.err.KYCRequired']);
    expect(rentBlockers(review({ state: 'accepted' }), null, copy)).toEqual(['rent.blockState']);
  });
  it('refuses a distrusted payment token and a listing that claims a linked loan', () => {
    expect(rentBlockers(review({ prepayClass: 'distrusted' }), null, copy)).toEqual(['rent.blockDistrusted']);
    expect(rentBlockers(review({ linkedLoanId: 3n }), null, copy)).toEqual(['rent.blockLinked']);
  });
});

describe('rentChangedBetween', () => {
  it('names the buffer when only it moved, and nothing when nothing did', () => {
    expect(rentChangedBetween(review(), review(), copy)).toBeNull();
    expect(rentChangedBetween(review({ listingBufferBps: 0n }), review({ listingBufferBps: 0n, todayBufferBps: 800n }), copy)).toBe('rent.changedBuffer');
    expect(rentChangedBetween(review(), review({ state: 'cancelled' }), copy)).toBe('rent.changedListing');
    expect(rentChangedBetween(review(), review({ funds: { balance: 1n, allowance: 0n } }), copy)).toBe('accept.changedFunds');
  });
});

describe('rentReceipt', () => {
  it('moves the rent plus buffer out, states the buffer source, and asks for three prompts with an approval', () => {
    const r = review();
    const receipt = rentReceipt(r, null, copy);
    expect(receipt.rows[0]).toMatchObject({ label: 'rent.rowPay', value: { kind: 'amount', asset: USDC, amount: 21_000_000n }, movesOut: true });
    expect(receipt.rows.find((x) => x.label === 'rent.rowBuffer')).toMatchObject({ value: { text: 'rent.bufferListing' }, binding: true });
    expect(receipt.rows.find((x) => x.label === 'rent.rowCollateral')?.value).toMatchObject({ text: 'rent.noCollateral' });
    expect(receipt.prompts).toBe(3);
    expect(promptCount(review({ approvalSteps: 0 }))).toBe(2);
    expect(needsApproval(r)).toBe(true);
    expect(reviewCost(r).total).toBe(21_000_000n);
  });
  it("says when the buffer is today's setting, and states the full-term rule", () => {
    const receipt = rentReceipt(review({ listingBufferBps: 0n, offer: listing({ useFullTermInterest: true }) }), null, copy);
    expect(receipt.rows.find((x) => x.label === 'rent.rowBuffer')).toMatchObject({ value: { text: 'rent.bufferToday' }, binding: false });
    expect(receipt.rows.find((x) => x.label === 'rent.rowRule')?.value).toMatchObject({ text: 'rent.ruleFullTerm' });
    expect(receipt.consequences).toContain('rent.loseBufferToday');
  });
});
