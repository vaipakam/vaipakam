import { describe, it, expect } from 'vitest';
import {
  offerHeadline,
  type OfferHeadlineInput,
} from '../../src/lib/offerHeadline';

/**
 * F-20260630-001 — the accept-review modal and offer-detail view showed a
 * lender ERC-20 offer's principal as `amount` (the minPartialFillAmount, ~10%
 * of max) instead of `amountMax` (what direct-accept locks). These pure tests
 * pin the role-aware endpoint mapping so the signing-safety surface can't
 * silently drift back.
 */

// 6-decimal mUSDC-style figures: max provide 100, min partial fill 10.
const AMOUNT_MIN = 10_000_000n; // 10 mUSDC
const AMOUNT_MAX = 100_000_000n; // 100 mUSDC
const RATE_FLOOR = 400n; // 4.00% — lender's floor / locked rate
const RATE_CEIL = 1200n; // 12.00% — borrower's ceiling / locked rate

function make(overrides: Partial<OfferHeadlineInput>): OfferHeadlineInput {
  return {
    assetType: 0,
    offerType: 0,
    amount: AMOUNT_MIN,
    amountMax: AMOUNT_MAX,
    interestRateBps: RATE_FLOOR,
    interestRateBpsMax: RATE_CEIL,
    ...overrides,
  };
}

describe('offerHeadline', () => {
  it('lender ERC-20 offer → principal is amountMax, rate is the floor', () => {
    // The exact F-001 bug: pre-fix this read `amount` (10) and showed the
    // wrong headline; the fix reads `amountMax` (100) — what accept locks.
    const { principal, rateBps } = offerHeadline(
      make({ assetType: 0, offerType: 0 }),
    );
    expect(principal).toBe(AMOUNT_MAX);
    expect(rateBps).toBe(RATE_FLOOR);
  });

  it('borrower ERC-20 offer → principal is amount (min need), rate is the ceiling', () => {
    const { principal, rateBps } = offerHeadline(
      make({ assetType: 0, offerType: 1 }),
    );
    expect(principal).toBe(AMOUNT_MIN);
    expect(rateBps).toBe(RATE_CEIL);
  });

  it('NFT rental lender offer → amount (daily fee), interestRateBps for both roles', () => {
    const { principal, rateBps } = offerHeadline(
      make({ assetType: 2, offerType: 0 }),
    );
    // NFT rental: `amount` is a daily fee, not a partial-fill floor — never
    // read `amountMax` here even though it's a lender offer.
    expect(principal).toBe(AMOUNT_MIN);
    expect(rateBps).toBe(RATE_FLOOR);
  });

  it('NFT rental borrower offer → amount, and still interestRateBps (not the ceiling)', () => {
    const { principal, rateBps } = offerHeadline(
      make({ assetType: 2, offerType: 1 }),
    );
    expect(principal).toBe(AMOUNT_MIN);
    expect(rateBps).toBe(RATE_FLOOR);
  });
});
